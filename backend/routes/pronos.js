// ===================================================
// ROUTE : /api/pronos
// Génération et gestion des pronostics
// ===================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('./auth');
const apiSports  = require('../services/apiSports');
const prediction = require('../services/prediction');

const router   = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Quotas par plan
const PLAN_QUOTAS = { starter: 5, pro: 10, expert: 30, illimite: Infinity, unit: 1 };

// Ligues alternatives par sport (pour suggestion si cote trop risquée)
const ALT_LEAGUES = {
  football:   ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'Champions League'],
  tennis:     ['ATP Tour'],
  basketball: ['NBA', 'Euroleague'],
  rugby:      ['Top 14'],
  mma:        ['UFC'],
  boxe:       ['UFC'],
};

// ─── Helper : vérifie si une ligue a de VRAIS matchs (non-démo) ce jour ─
async function hasRealMatches(sport, league, date) {
  const fixtures = await apiSports.getFixtures({ sport, league, date });
  return fixtures.length > 0 && !fixtures[0].isDemo;
}

// ─── Helper : analyser un lot de matchs et retourner le meilleur pick ─
async function findBestPick(sport, league, date) {
  let fixtures = await apiSports.getFixtures({ sport, league, date });
  // Ne pas utiliser les démos ici — retourner null si aucun vrai match
  if (!fixtures.length || fixtures[0].isDemo) return null;

  const enriched = await Promise.all(
    fixtures.slice(0, 3).map(async (fixture) => {
      const [stats, injuries, odds] = await Promise.all([
        apiSports.getTeamStats(fixture),
        apiSports.getInjuries(fixture),
        apiSports.getOdds(fixture),
      ]);
      return { ...fixture, stats, injuries, odds };
    })
  );

  const predictions = await Promise.all(enriched.map(f => prediction.predict(f)));
  const validPicks  = predictions.filter(p => p.cote_marche >= 1.90);
  if (!validPicks.length) return null;
  return validPicks.sort((a, b) => b.value - a.value)[0];
}

// ─── Middleware : vérifier quota ─────────────────────
async function checkQuota(req, res, next) {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('pronostics')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .gte('created_at', weekStart.toISOString());

  const { data: profile } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', req.user.id)
    .single();

  const plan  = profile?.plan || 'pro';
  const max   = PLAN_QUOTAS[plan] || 10;
  const used  = count || 0;

  if (max !== Infinity && used >= max) {
    return res.status(429).json({
      error: `Quota atteint pour le plan ${plan} (${used}/${max} pronos cette semaine).`,
      upgrade_url: '/pages/register.html',
    });
  }
  req.quota = { plan, used, max };
  next();
}

// ─── POST /api/pronos/generate ───────────────────────
// Corps : { sport, league, date, info? }
router.post('/generate', requireAuth, checkQuota, async (req, res) => {
  const { sport, league, date, info = '' } = req.body;

  if (!sport || !league || !date) {
    return res.status(400).json({ error: 'sport, league et date sont requis' });
  }

  try {
    // 1. Chercher un pick valide pour la date/ligue demandée
    let bestPick   = await findBestPick(sport, league, date);
    let usedLeague = league;
    let usedDate   = date;

    // 2. Si aucun match réel dans la ligue demandée → trouver les ligues disponibles
    if (!bestPick) {
      const allLeagues    = ALT_LEAGUES[sport] || [];
      const otherLeagues  = allLeagues.filter(l => l !== league);

      // Vérifier en parallèle quelles ligues ont des matchs réels ce jour
      const checks = await Promise.all(
        otherLeagues.map(async l => ({
          league: l,
          hasMatch: await hasRealMatches(sport, l, date),
        }))
      );
      const available = checks.filter(c => c.hasMatch).map(c => c.league);

      // Retourner la liste des ligues disponibles pour que l'utilisateur choisisse
      return res.status(200).json({
        no_match:          true,
        requested_league:  league,
        date,
        message:           `Pas de match ${league} le ${date}.`,
        available_leagues: available,
      });
    }

    // 5. Sauvegarder en base
    const pronoData = {
      user_id:     req.user.id,
      sport,
      league:      usedLeague,
      date:        usedDate,
      match:       bestPick.match,
      pick:        bestPick.pick,
      cote_ia:     bestPick.cote_ia,
      cote_marche: bestPick.cote_marche,
      confidence:  bestPick.confidence,
      value:       bestPick.value,
      bookmakers:  bestPick.bookmakers,
      injuries:    bestPick.injuries,
      team_stats:  bestPick.team_stats || null,
      factors:     bestPick.factors,
      result:      'pending',
      reanalyze_count: 0,
      extra_info:  info || null,
      created_at:  new Date().toISOString(),
    };

    const { data: saved, error } = await supabase
      .from('pronostics')
      .insert([pronoData])
      .select()
      .single();

    if (error) throw error;

    res.json(saved);
  } catch (err) {
    console.error('[pronos/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pronos/reanalyze ──────────────────────
// Corps : { pronoId, info }
router.post('/reanalyze', requireAuth, async (req, res) => {
  const { pronoId, info } = req.body;
  if (!pronoId || !info) {
    return res.status(400).json({ error: 'pronoId et info sont requis' });
  }

  // Récupérer le prono
  const { data: prono, error } = await supabase
    .from('pronostics')
    .select('*')
    .eq('id', pronoId)
    .eq('user_id', req.user.id)
    .single();

  if (error || !prono) {
    return res.status(404).json({ error: 'Pronostic non trouvé' });
  }

  // Vérifier limite re-analyses
  if (prono.reanalyze_count >= 3) {
    return res.status(429).json({ error: 'Limite de 3 re-analyses atteinte pour ce pronostic.' });
  }

  try {
    // Recalculer avec l'info terrain
    const result = await prediction.reanalyze({ prono, info });

    // Mettre à jour en base
    const { data: updated } = await supabase
      .from('pronostics')
      .update({
        confidence:      result.confidence,
        value:           result.value,
        reanalyze_count: prono.reanalyze_count + 1,
        extra_info:      info,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', pronoId)
      .select()
      .single();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pronos ─────────────────────────────────
// Liste des pronos de l'utilisateur connecté
router.get('/', requireAuth, async (req, res) => {
  const { sport, result, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from('pronostics')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (sport)  query = query.eq('sport', sport);
  if (result) query = query.eq('result', result);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// ─── PATCH /api/pronos/:id/result ────────────────────
// Mise à jour du résultat (win / loss) — usage admin ou cron
router.patch('/:id/result', requireAuth, async (req, res) => {
  const { result } = req.body;
  if (!['win', 'loss', 'void'].includes(result)) {
    return res.status(400).json({ error: 'result doit être win, loss ou void' });
  }

  const { data, error } = await supabase
    .from('pronostics')
    .update({ result, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── GET /api/pronos/debug-api ───────────────────────
// Teste football-data.org sur plusieurs ligues/dates
router.get('/debug-api', async (req, res) => {
  const axios    = require('axios');
  const key      = process.env.FOOTBALL_DATA_KEY;
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  if (!key) return res.json({ error: 'FOOTBALL_DATA_KEY manquante dans Railway', today, tomorrow });

  const checks = [
    { label: 'Champions League aujourd\'hui', comp: 'CL',  date: today },
    { label: 'Champions League demain',       comp: 'CL',  date: tomorrow },
    { label: 'Premier League aujourd\'hui',   comp: 'PL',  date: today },
    { label: 'Premier League demain',         comp: 'PL',  date: tomorrow },
    { label: 'Ligue 1 aujourd\'hui',          comp: 'FL1', date: today },
  ];

  const results = [];
  for (const c of checks) {
    try {
      const { data } = await axios.get(`https://api.football-data.org/v4/competitions/${c.comp}/matches`, {
        headers: { 'X-Auth-Token': key },
        params:  { dateFrom: c.date, dateTo: c.date, status: 'SCHEDULED,TIMED' },
        timeout: 8000,
      });
      results.push({
        label:   c.label,
        count:   data.matches?.length || 0,
        matches: (data.matches || []).slice(0, 3).map(m => `${m.homeTeam.name} vs ${m.awayTeam.name}`),
      });
    } catch (err) {
      results.push({ label: c.label, error: err.response?.data?.message || err.message });
    }
  }

  res.json({ key_present: true, key_prefix: key.slice(0, 8) + '...', today, tomorrow, results });
});

module.exports = router;
