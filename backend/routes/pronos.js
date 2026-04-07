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

// ─── Helper : analyser un lot de matchs et retourner le meilleur pick ─
async function findBestPick(sport, league, date) {
  let fixtures = await apiSports.getFixtures({ sport, league, date });
  if (!fixtures.length) fixtures = apiSports.getDemoFixtures(sport, league);

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
    let bestPick     = await findBestPick(sport, league, date);
    let usedDate     = date;
    let usedLeague   = league;
    let suggestion   = null;

    // 2. Si aucun pick valide → essayer les autres ligues du même sport (même jour)
    if (!bestPick) {
      const alternatives = (ALT_LEAGUES[sport] || []).filter(l => l !== league);
      for (const altLeague of alternatives) {
        bestPick = await findBestPick(sport, altLeague, date);
        if (bestPick) {
          usedLeague = altLeague;
          suggestion = `Aucun pari à valeur en ${league} ce jour — meilleur pick trouvé en ${altLeague}.`;
          break;
        }
      }
    }

    // 4. Si vraiment rien partout → refus propre
    if (!bestPick) {
      return res.status(422).json({
        error: 'Aucun pick à valeur trouvé pour cette date, les 2 prochains jours ni les ligues alternatives. Réessayez demain.',
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
      team_stats:  bestPick.teamStats,
      factors:     bestPick.factors,
      result:      'pending',
      reanalyze_count: 0,
      extra_info:  info || null,
      suggestion,
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
// Teste la connexion API-Sports et retourne la réponse brute
router.get('/debug-api', async (req, res) => {
  const axios = require('axios');
  const key   = process.env.API_SPORTS_KEY;

  if (!key) return res.json({ error: 'API_SPORTS_KEY manquante dans Railway' });

  try {
    const { data } = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: {
        'x-apisports-key':  key,
        'x-apisports-host': 'v3.football.api-sports.io',
      },
      params: { date: new Date().toISOString().slice(0, 10), league: 61, season: 2024 },
      timeout: 8000,
    });
    res.json({
      key_present:    true,
      key_prefix:     key.slice(0, 8) + '...',
      api_errors:     data.errors,
      results_count:  data.results,
      first_fixture:  data.response?.[0] || null,
    });
  } catch (err) {
    res.json({ error: err.message, key_prefix: key.slice(0, 8) + '...' });
  }
});

module.exports = router;
