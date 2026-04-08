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

// ─── Helper : vérifie si une ligue a de vrais matchs ce jour ─
async function hasRealMatches(sport, league, date) {
  const fixtures = await apiSports.getFixtures({ sport, league, date });
  if (!fixtures.length) return false;
  if (sport === 'football') return !fixtures[0].isDemo;
  return true;
}

// ─── Helper : analyser un lot de matchs et retourner le meilleur pick ─
async function findBestPick(sport, league, date) {
  let fixtures = await apiSports.getFixtures({ sport, league, date });
  if (!fixtures.length) return null;
  // Football : uniquement des vrais matchs (pas de démo)
  if (sport === 'football' && fixtures[0].isDemo) return null;

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
  const validPicks  = predictions.filter(p => p.cote_marche >= 1.10);
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

  // Tester sur 7 jours pour trouver les prochains matchs
  const d = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const checks = [
    { label: 'Ligue 1 — 7 prochains jours',         comp: 'FL1', from: today,   to: d(7)  },
    { label: 'Premier League — 7 prochains jours',   comp: 'PL',  from: today,   to: d(7)  },
    { label: 'Champions League — 7 prochains jours', comp: 'CL',  from: today,   to: d(7)  },
    { label: 'La Liga — 7 prochains jours',          comp: 'PD',  from: today,   to: d(7)  },
    { label: 'Bundesliga — 7 prochains jours',       comp: 'BL1', from: today,   to: d(7)  },
  ];

  const results = [];
  for (const c of checks) {
    try {
      const { data } = await axios.get(`https://api.football-data.org/v4/competitions/${c.comp}/matches`, {
        headers: { 'X-Auth-Token': key },
        params:  { dateFrom: c.from, dateTo: c.to, status: 'SCHEDULED,TIMED' },
        timeout: 8000,
      });
      const matches = data.matches || [];
      results.push({
        label:        c.label,
        count:        matches.length,
        next_matches: matches.slice(0, 5).map(m => `${m.utcDate.slice(0,10)} — ${m.homeTeam.name} vs ${m.awayTeam.name}`),
        error_api:    data.message || null,
      });
    } catch (err) {
      results.push({ label: c.label, error: err.response?.data?.message || err.message, status: err.response?.status });
    }
  }

  res.json({ key_present: true, key_prefix: key.slice(0, 8) + '...', today, tomorrow, results });
});

// ─── GET /api/pronos/debug-sports ────────────────────
// Teste API-Sports sur basket/tennis/MMA/rugby avec la clé existante
router.get('/debug-sports', async (req, res) => {
  const axios = require('axios');
  const key   = process.env.API_SPORTS_KEY;
  if (!key) return res.json({ error: 'API_SPORTS_KEY manquante' });

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const checks = [
    { label: 'NBA s2024',    url: 'https://v1.basketball.api-sports.io/games',  params: { date: today, league: 12, season: 2024 } },
    { label: 'NBA s2025',    url: 'https://v1.basketball.api-sports.io/games',  params: { date: today, league: 12, season: 2025 } },
    { label: 'NBA demain s2025', url: 'https://v1.basketball.api-sports.io/games', params: { date: tomorrow, league: 12, season: 2025 } },
    { label: 'UFC today',    url: 'https://v1.mma.api-sports.io/fights',        params: { date: today } },
    { label: 'UFC demain',   url: 'https://v1.mma.api-sports.io/fights',        params: { date: tomorrow } },
  ];

  const results = [];
  for (const c of checks) {
    try {
      const { data } = await axios.get(c.url, {
        headers: { 'x-apisports-key': key },
        params: c.params,
        timeout: 8000,
      });
      results.push({
        label:  c.label,
        errors: data.errors,
        count:  data.results,
        sample: data.response?.slice(0, 2),
      });
    } catch (err) {
      results.push({ label: c.label, error: err.message });
    }
  }
  res.json({ key_prefix: key.slice(0, 8) + '...', today, results });
});

// ─── GET /api/pronos/debug-odds ──────────────────────
router.get('/debug-odds', async (req, res) => {
  const axios = require('axios');
  const key   = process.env.ODDS_API_KEY;
  if (!key) return res.json({ error: 'ODDS_API_KEY manquante sur Railway' });

  try {
    // Lister tous les sports disponibles avec cette clé
    const { data: sports } = await axios.get('https://api.the-odds-api.com/v4/sports/', {
      params: { apiKey: key },
      timeout: 8000,
    });
    const active = sports.filter(s => s.active).map(s => ({ key: s.key, title: s.title, group: s.group }));
    res.json({ key_prefix: key.slice(0, 8) + '...', total_active: active.length, sports: active });
  } catch (err) {
    res.json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
