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

// ─── Algorithme bookmakers — source primaire : The Odds API ───
const axios = require('axios');

// sport_key The Odds API → { league, comp_code pour football-data standings }
const SPORT_KEY_TO_LEAGUE = {
  'soccer_epl':                    { league: 'Premier League', comp_code: 'PL'  },
  'soccer_efl_champ':              { league: 'Championship',   comp_code: 'ELC' },
  'soccer_spain_la_liga':          { league: 'La Liga',        comp_code: 'PD'  },
  'soccer_spain_segunda_division': { league: 'La Liga 2',      comp_code: 'SD'  },
  'soccer_germany_bundesliga':     { league: 'Bundesliga',     comp_code: 'BL1' },
  'soccer_germany_bundesliga2':    { league: '2. Bundesliga',  comp_code: 'BL2' },
  'soccer_italy_serie_a':          { league: 'Serie A',        comp_code: 'SA'  },
  'soccer_italy_serie_b':          { league: 'Serie B',        comp_code: 'SB'  },
  'soccer_france_ligue_one':       { league: 'Ligue 1',        comp_code: 'FL1' },
  'soccer_france_ligue_two':       { league: 'Ligue 2',        comp_code: 'FL2' },
};

function cleanName(n) {
  return n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|as|real|stade|united|city|town|sporting|bayer|atletico|de)\b/g, '').trim();
}

async function runAlgo() {
  const now    = new Date();
  const future = new Date();
  future.setDate(now.getDate() + 3);

  const KEY_F = process.env.FOOTBALL_DATA_KEY || '0bebba720a484535a0105713e0fc7d66';
  const KEY_O = process.env.ODDS_API_KEY || '402dfe4ed1b2e82526e91725d6f02438';

  // Récupère les cotes pour chaque ligue en parallèle (The Odds API = source primaire)
  const sportKeys = Object.keys(SPORT_KEY_TO_LEAGUE);
  const oddsResults = await Promise.all(
    sportKeys.map(key =>
      axios.get(
        `https://api.the-odds-api.com/v4/sports/${key}/odds/`,
        { params: { apiKey: KEY_O, regions: 'eu,fr', markets: 'h2h,totals' }, timeout: 10000 }
      )
        .then(r => (Array.isArray(r.data) ? r.data : []).map(e => ({ ...e, _sport_key: key })))
        .catch(() => [])
    )
  );

  // Filtrer sur les 3 prochains jours uniquement
  const allEvents = oddsResults.flat().filter(o => {
    const d = new Date(o.commence_time);
    return d >= now && d <= future;
  });

  const picks = [];

  allEvents.forEach(matchOdds => {
    if (!matchOdds.bookmakers || !matchOdds.bookmakers.length) return;

    const leagueInfo = SPORT_KEY_TO_LEAGUE[matchOdds._sport_key];
    if (!leagueInfo) return;

    // Bookmakers français prioritaires (clés The Odds API)
    const FR_KEYS = ['winamax_fr', 'betclic', 'unibet_fr', 'pmu', 'france_pari', 'parions_sport', 'vbet_fr', 'bwin_fr', 'pokerstars_fr'];
    const frBks = matchOdds.bookmakers.filter(bk => FR_KEYS.includes(bk.key));
    // Fallback : si moins de 2 sites FR disponibles, on prend les EU
    const pool = frBks.length >= 2 ? frBks : matchOdds.bookmakers;
    // Limiter à 5 — la moyenne affichée = exactement ces 5 cotes
    const bk5 = pool.slice(0, 5);

    // Moyenne des cotes sur les 5 bookmakers retenus
    function avgOdds(outcomeName, marketKey, point) {
      const prices = [];
      for (const bk of bk5) {
        const mkt = bk.markets.find(mk => mk.key === marketKey);
        if (!mkt) continue;
        const o = point != null
          ? mkt.outcomes.find(x => x.name.toLowerCase() === outcomeName && x.point === point)
          : mkt.outcomes.find(x => x.name.toLowerCase() === outcomeName || x.name === outcomeName);
        if (o?.price) prices.push(o.price);
      }
      if (!prices.length) return null;
      return parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2));
    }

    const avgHome = avgOdds(matchOdds.home_team, 'h2h');
    const avgAway = avgOdds(matchOdds.away_team, 'h2h');
    const avgDraw = avgOdds('draw', 'h2h');
    if (!avgHome || !avgAway || !avgDraw) return;

    // Devigging : probabilités réelles sans marge bookmaker
    const margin   = (1/avgHome) + (1/avgAway) + (1/avgDraw);
    const probHome = ((1/avgHome) / margin) * 100;
    const probAway = ((1/avgAway) / margin) * 100;
    const probDraw = ((1/avgDraw) / margin) * 100;

    const matchStr = `${matchOdds.home_team} vs ${matchOdds.away_team}`;
    const date     = matchOdds.commence_time.split('T')[0];
    const { league, comp_code } = leagueInfo;
    const extra = { comp_code, homeTeam: matchOdds.home_team, awayTeam: matchOdds.away_team };

    // Objet bookmakers : exactement les 5 retenus (1X2 + double chances + buts)
    const bookmakersObj = {};
    for (const bk of bk5) {
      const h = bk.markets.find(mk => mk.key === 'h2h');
      if (!h) continue;
      const homeO = h.outcomes.find(x => x.name === matchOdds.home_team);
      const awayO = h.outcomes.find(x => x.name === matchOdds.away_team);
      const drawO = h.outcomes.find(x => x.name.toLowerCase().includes('draw'));
      const entry = {
        home: homeO?.price ?? null,
        draw: drawO?.price ?? null,
        away: awayO?.price ?? null,
      };
      // Double chance calculée par bookmaker (cote juste = 1 / somme des probs)
      const pH = homeO?.price ? 1/homeO.price : 0;
      const pD = drawO?.price ? 1/drawO.price : 0;
      const pA = awayO?.price ? 1/awayO.price : 0;
      if (pH && pD) entry.dc_1X  = parseFloat((1/(pH+pD)).toFixed(2));
      if (pD && pA) entry.dc_X2  = parseFloat((1/(pD+pA)).toFixed(2));
      if (pH && pA) entry.dc_12  = parseFloat((1/(pH+pA)).toFixed(2));
      // Buts (Over/Under)
      const tot = bk.markets.find(mk => mk.key === 'totals');
      if (tot) {
        for (const o of tot.outcomes) {
          const k = o.name.toLowerCase() === 'over'
            ? `over${String(o.point || 25).replace('.', '')}`
            : `under${String(o.point || 25).replace('.', '')}`;
          entry[k] = o.price;
        }
      }
      bookmakersObj[bk.title] = entry;
    }

    // ── 1X2 ──────────────────────────────────────────────────────────
    if (avgHome >= 1.80 && probHome > 50)
      picks.push({ match: matchStr, league, date, pick: `Victoire ${matchOdds.home_team}`, pick_key: 'home', cote_marche: avgHome, prob: probHome, bookmakers: bookmakersObj, ...extra });
    if (avgAway >= 1.80 && probAway > 50)
      picks.push({ match: matchStr, league, date, pick: `Victoire ${matchOdds.away_team}`, pick_key: 'away', cote_marche: avgAway, prob: probAway, bookmakers: bookmakersObj, ...extra });

    // ── Double chances (cote = 1/prob_devigged_combinée) ─────────────
    const cote1X  = parseFloat((100 / (probHome + probDraw)).toFixed(2));
    const coteX2  = parseFloat((100 / (probDraw + probAway)).toFixed(2));
    const cote12  = parseFloat((100 / (probHome + probAway)).toFixed(2));

    if (cote1X >= 1.80 && (probHome + probDraw) > 50)
      picks.push({ match: matchStr, league, date, pick: `Double chance 1X — ${matchOdds.home_team} ou Nul`, pick_key: 'dc_1X', cote_marche: cote1X, prob: probHome + probDraw, bookmakers: bookmakersObj, ...extra });
    if (coteX2 >= 1.80 && (probDraw + probAway) > 50)
      picks.push({ match: matchStr, league, date, pick: `Double chance X2 — Nul ou ${matchOdds.away_team}`, pick_key: 'dc_X2', cote_marche: coteX2, prob: probDraw + probAway, bookmakers: bookmakersObj, ...extra });
    if (cote12 >= 1.80 && (probHome + probAway) > 50)
      picks.push({ match: matchStr, league, date, pick: `Double chance 12 — ${matchOdds.home_team} ou ${matchOdds.away_team}`, pick_key: 'dc_12', cote_marche: cote12, prob: probHome + probAway, bookmakers: bookmakersObj, ...extra });

    // ── Buts : toutes les lignes disponibles (1.5, 2.5, 3.5…) ────────
    const allTotals = matchOdds.bookmakers[0]?.markets.find(mk => mk.key === 'totals')?.outcomes || [];
    const lines = allTotals.some(x => x.point != null)
      ? [...new Set(allTotals.filter(x => x.point != null).map(x => x.point))]
      : [null];

    lines.forEach(pt => {
      const avgOv = avgOdds('over', 'totals', pt);
      const avgUn = avgOdds('under', 'totals', pt);
      if (!avgOv || !avgUn) return;
      const mg  = (1/avgOv) + (1/avgUn);
      const pOv = ((1/avgOv) / mg) * 100;
      const pUn = ((1/avgUn) / mg) * 100;
      const lbl = pt != null ? `${pt}` : '2.5';
      const kOv = `over${String(pt || 25).replace('.', '')}`;
      const kUn = `under${String(pt || 25).replace('.', '')}`;
      if (avgOv >= 1.80 && pOv > 50)
        picks.push({ match: matchStr, league, date, pick: `Plus de ${lbl} buts`, pick_key: kOv, cote_marche: avgOv, prob: pOv, bookmakers: bookmakersObj, ...extra });
      if (avgUn >= 1.80 && pUn > 50)
        picks.push({ match: matchStr, league, date, pick: `Moins de ${lbl} buts`, pick_key: kUn, cote_marche: avgUn, prob: pUn, bookmakers: bookmakersObj, ...extra });
    });
  });

  // Filtre : value positive uniquement (cote × prob > 1)
  const positivePicks = picks.filter(p => p.cote_marche * (p.prob / 100) > 1);
  if (!positivePicks.length) return null;

  // Meilleur pick : valeur attendue maximale
  const best = positivePicks.sort((a, b) => (b.cote_marche * b.prob) - (a.cote_marche * a.prob))[0];
  best.confidence    = Math.min(92, Math.max(40, Math.round(best.prob * 0.85 + 8)));
  best.value         = parseFloat(((best.cote_marche * best.prob / 100 - 1) * 100).toFixed(1));
  best.cote_ia       = parseFloat((100 / best.prob).toFixed(2));
  best.odds_are_real = true;

  best.factors = [
    `Probabilité implicite bookmakers : ${Math.round(best.prob)}%`,
    `Cote moyenne sur ${Object.keys(best.bookmakers || {}).length || 1} site(s) : ${best.cote_marche.toFixed(2)}`,
    `Value edge : +${best.value.toFixed(1)}%`,
  ];

  // Enrichissement stats via football-data.org (standings)
  try {
    const standRes = await axios.get(
      `https://api.football-data.org/v4/competitions/${best.comp_code}/standings`,
      { headers: { 'X-Auth-Token': KEY_F }, timeout: 6000 }
    );
    const table = standRes.data.standings?.find(s => s.type === 'TOTAL')?.table || [];

    const findRow = name => table.find(r =>
      cleanName(r.team.name).includes(cleanName(name)) ||
      cleanName(name).includes(cleanName(r.team.name))
    );

    const hRow = findRow(best.homeTeam);
    const aRow = findRow(best.awayTeam);

    if (hRow && aRow) {
      const avg = (v, g) => g ? (v / g).toFixed(1) : '—';
      best.team_stats = {
        home: {
          name:          best.homeTeam,
          position:      hRow.position,
          form:          hRow.form || '—',
          goals:         avg(hRow.goalsFor, hRow.playedGames),
          goals_against: avg(hRow.goalsAgainst, hRow.playedGames),
          won:  hRow.won,
          draw: hRow.draw,
          lost: hRow.lost,
        },
        away: {
          name:          best.awayTeam,
          position:      aRow.position,
          form:          aRow.form || '—',
          goals:         avg(aRow.goalsFor, aRow.playedGames),
          goals_against: avg(aRow.goalsAgainst, aRow.playedGames),
          won:  aRow.won,
          draw: aRow.draw,
          lost: aRow.lost,
        },
      };

      best.factors = [
        `Probabilité implicite bookmakers : ${Math.round(best.prob)}%`,
        `Cote moyenne (${Object.keys(best.bookmakers || {}).length} sites) : ${best.cote_marche.toFixed(2)}`,
        `Value edge : +${best.value.toFixed(1)}%`,
        `${best.homeTeam} — ${hRow.position}e au classement, forme : ${hRow.form || '—'}`,
        `${best.awayTeam} — ${aRow.position}e au classement, forme : ${aRow.form || '—'}`,
        `${best.homeTeam} : ${avg(hRow.goalsFor, hRow.playedGames)} buts/match marqués, ${avg(hRow.goalsAgainst, hRow.playedGames)} encaissés`,
        `${best.awayTeam} : ${avg(aRow.goalsFor, aRow.playedGames)} buts/match marqués, ${avg(aRow.goalsAgainst, aRow.playedGames)} encaissés`,
      ];
      if (hRow.position < aRow.position)
        best.factors.push(`${best.homeTeam} mieux classé de ${aRow.position - hRow.position} place(s)`);
    }
  } catch (_) {
    // standings non dispo → facteurs de base conservés
  }

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
// Génère un prono côté serveur (pas de CORS) + sauvegarde Supabase
router.post('/generate', requireAuth, checkQuota, async (req, res) => {
  try {
    const pick = await runAlgo();
    if (!pick) {
      return res.status(422).json({ error: 'Aucun prono sécurisé trouvé pour les 3 prochains jours.' });
    }

    const pronoData = {
      user_id:         req.user.id,
      sport:           'football',
      league:          pick.league,
      date:            pick.date,
      match:           pick.match,
      pick:            pick.pick,
      cote_ia:         pick.cote_ia,
      cote_marche:     pick.cote_marche,
      confidence:      pick.confidence,
      value:           pick.value,
      result:          'pending',
      reanalyze_count: 0,
      created_at:      new Date().toISOString(),
    };

    const { data: saved, error } = await supabase
      .from('pronostics')
      .insert([pronoData])
      .select()
      .single();

    if (error) throw error;
    // Renvoyer les données Supabase + bookmakers réels (non stockés en base)
    res.json({
      ...saved,
      bookmakers:    pick.bookmakers || {},
      pick_key:      pick.pick_key,
      odds_are_real: true,
    });
  } catch (err) {
    console.error('[pronos/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pronos/save ────────────────────────────
// L'algo tourne côté navigateur, le backend sauvegarde uniquement
router.post('/save', requireAuth, checkQuota, async (req, res) => {
  const pick = req.body;
  if (!pick || !pick.match || !pick.pick) {
    return res.status(400).json({ error: 'Données pick manquantes' });
  }

  try {
    const pronoData = {
      user_id:     req.user.id,
      sport:       'football',
      league:      pick.league,
      date:        pick.date,
      match:       pick.match,
      pick:        pick.pick,
      cote_ia:     pick.cote_ia,
      cote_marche: pick.cote_marche,
      confidence:  pick.confidence,
      value:       pick.value,
      result:      'pending',
      reanalyze_count: 0,
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
    console.error('[pronos/save]', err);
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
