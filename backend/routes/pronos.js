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

// Ligues supportées (scan automatique)
const FOOTBALL_LEAGUES = [
  'Premier League', 'Championship',
  'La Liga', 'La Liga 2',
  'Bundesliga', '2. Bundesliga',
  'Serie A', 'Serie B',
  'Ligue 1', 'Ligue 2',
  'Champions League',
];

// ─── Algorithme bookmakers (port direct du script utilisateur) ───
const axios = require('axios');

const LEAGUE_MAP = {
  'PL': 'Premier League', 'ELC': 'Championship', 'PD': 'La Liga',
  'SD': 'La Liga 2', 'BL1': 'Bundesliga', 'BL2': '2. Bundesliga',
  'SA': 'Serie A', 'SB': 'Serie B', 'FL1': 'Ligue 1', 'FL2': 'Ligue 2',
};

function cleanName(n) {
  return n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/fc|cf|as|real|stade|united|city|town|sporting|bayer|atletico|de /g, '').trim();
}

async function runAlgo() {
  const now    = new Date();
  const future = new Date();
  future.setDate(now.getDate() + 3);
  const dateFrom = now.toISOString().split('T')[0];
  const dateTo   = future.toISOString().split('T')[0];

  const [resF, resO] = await Promise.all([
    axios.get(`https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
      headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_KEY },
    }),
    axios.get(`https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=402dfe4ed1b2e82526e91725d6f02438&regions=eu&markets=h2h,totals`),
  ]);

  const matches  = resF.data.matches || [];
  const oddsData = resO.data;
  const picks    = [];

  matches.forEach(m => {
    const leagueCode = m.competition.code;
    if (!LEAGUE_MAP[leagueCode]) return;

    const matchOdds = oddsData.find(o =>
      cleanName(m.homeTeam.name).includes(cleanName(o.home_team)) ||
      cleanName(o.home_team).includes(cleanName(m.homeTeam.name))
    );
    if (!matchOdds || !matchOdds.bookmakers.length) return;

    const markets = matchOdds.bookmakers[0].markets;
    const h2h    = markets.find(mk => mk.key === 'h2h')?.outcomes;
    const totals = markets.find(mk => mk.key === 'totals')?.outcomes;
    if (!h2h) return;

    const home = h2h.find(x => x.name === matchOdds.home_team);
    const away = h2h.find(x => x.name === matchOdds.away_team);
    const draw = h2h.find(x => x.name.toLowerCase().includes('draw'));
    if (!home || !away || !draw) return;

    const margin   = (1/home.price) + (1/away.price) + (1/draw.price);
    const probHome = ((1/home.price) / margin) * 100;
    const probAway = ((1/away.price) / margin) * 100;

    const matchStr = `${m.homeTeam.name} vs ${m.awayTeam.name}`;
    const date     = m.utcDate.split('T')[0];
    const league   = LEAGUE_MAP[leagueCode];

    if (home.price >= 1.80 && probHome > 50) {
      picks.push({ match: matchStr, league, date, pick: `Victoire ${m.homeTeam.name}`, pick_key: 'home', bet_type: 'Résultat', cote_marche: home.price, prob: probHome });
    }
    if (away.price >= 1.80 && probAway > 50) {
      picks.push({ match: matchStr, league, date, pick: `Victoire ${m.awayTeam.name}`, pick_key: 'away', bet_type: 'Résultat', cote_marche: away.price, prob: probAway });
    }

    const over25 = totals?.find(x => x.name.toLowerCase() === 'over');
    if (over25 && over25.price >= 1.80) {
      const under25   = totals?.find(x => x.name.toLowerCase() === 'under');
      const overMargin = (1/over25.price) + (1/(under25?.price || 1.90));
      const probOver  = ((1/over25.price) / overMargin) * 100;
      if (probOver > 50) {
        picks.push({ match: matchStr, league, date, pick: 'Plus de 2.5 buts', pick_key: 'over25', bet_type: 'Nombre de buts', cote_marche: over25.price, prob: probOver });
      }
    }
  });

  if (!picks.length) return null;

  // Meilleur pick : valeur attendue max (cote × prob)
  const best = picks.sort((a, b) => (b.cote_marche * b.prob) - (a.cote_marche * a.prob))[0];
  best.confidence = Math.min(92, Math.max(40, Math.round(best.prob * 0.85 + 8)));
  best.value      = parseFloat(((best.cote_marche * best.prob / 100 - 1) * 100).toFixed(1));
  best.cote_ia    = parseFloat((100 / best.prob).toFixed(2));
  best.factors    = [`Probabilité implicite : ${Math.round(best.prob)}%`, `Cote marché : ${best.cote_marche.toFixed(2)}`];
  best.odds_are_real = true;
  best.bookmakers    = {};
  best.injuries      = [];
  best.team_stats    = {};
  return best;
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
// Corps : {} — scan automatique de toutes les ligues sur 3 jours
router.post('/generate', requireAuth, checkQuota, async (req, res) => {
  const { info = '' } = req.body || {};

  try {
    const bestPick = await runAlgo();

    if (!bestPick) {
      return res.status(404).json({ error: 'Aucun pick éligible trouvé sur les 3 prochains jours.' });
    }

    const pronoData = {
      user_id:      req.user.id,
      sport:        'football',
      league:       bestPick.league,
      date:         bestPick.date,
      match:        bestPick.match,
      pick:         bestPick.pick,
      pick_key:     bestPick.pick_key     || null,
      bet_type:     bestPick.bet_type     || 'Résultat',
      odds_are_real:bestPick.odds_are_real || false,
      cote_ia:      bestPick.cote_ia,
      cote_marche:  bestPick.cote_marche,
      confidence:   bestPick.confidence,
      value:        bestPick.value,
      bookmakers:   bestPick.bookmakers,
      injuries:     bestPick.injuries,
      team_stats:   bestPick.team_stats || null,
      factors:      bestPick.factors,
      result:       'pending',
      reanalyze_count: 0,
      extra_info:   info || null,
      created_at:   new Date().toISOString(),
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

// ─── GET /api/pronos/debug-full?league=Ligue+1&date=2026-04-10 ──
router.get('/debug-full', async (req, res) => {
  const { league = 'Ligue 1', date = new Date().toISOString().slice(0, 10) } = req.query;
  const trace = [];

  try {
    // 1. Fixtures
    const fixtures = await apiSports.getFixtures({ sport: 'football', league, date });
    trace.push({
      step: 'getFixtures',
      count: fixtures.length,
      isDemo: fixtures[0]?.isDemo,
      matches: fixtures.map(f => `${f.homeTeam?.name} vs ${f.awayTeam?.name}`),
    });

    if (!fixtures.length || fixtures[0]?.isDemo) {
      return res.json({ ok: false, trace, reason: fixtures[0]?.isDemo ? 'fixtures isDemo=true' : 'aucun fixture' });
    }

    // 2. Odds pour le 1er match
    const fixture = fixtures[0];
    const odds = await apiSports.getOdds(fixture);
    const bookmakerCount = odds ? Object.keys(odds).length : 0;
    const sample = odds ? Object.entries(odds).slice(0, 2).map(([bk, o]) => ({ bk, home: o.home, draw: o.draw, away: o.away })) : [];
    trace.push({ step: 'getOdds', hasOdds: !!odds, bookmakers: bookmakerCount, sample });

    if (!odds) {
      return res.json({ ok: false, trace, reason: 'pas de cotes réelles (The Odds API)' });
    }

    // 3. Prediction
    const stats    = await apiSports.getTeamStats(fixture);
    const injuries = await apiSports.getInjuries(fixture);
    const prediction = require('../services/prediction');
    const pred = await prediction.predict({ ...fixture, stats, injuries, odds });
    trace.push({
      step: 'prediction',
      pick: pred.pick,
      cote_marche: pred.cote_marche,
      cote_ia: pred.cote_ia,
      confidence: pred.confidence,
      value: pred.value,
      eligibleForProno: pred.cote_marche >= 1.90,
    });

    res.json({ ok: pred.cote_marche >= 1.90, trace });
  } catch (err) {
    res.json({ ok: false, trace, error: err.message });
  }
});

module.exports = router;
