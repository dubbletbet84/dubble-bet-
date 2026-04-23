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
const PLAN_QUOTAS = { starter: 5, pro: 10, expert: 30, illimite: Infinity };

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

// sport_key The Odds API → { league, sport, af_id (football uniquement) }
const SPORT_KEY_TO_LEAGUE = {
  // ─── Football ────────────────────────────────────────
  'soccer_epl':                    { league: 'Premier League', sport: 'football', af_id: 39  },
  'soccer_efl_champ':              { league: 'Championship',   sport: 'football', af_id: 40  },
  'soccer_spain_la_liga':          { league: 'La Liga',        sport: 'football', af_id: 140 },
  'soccer_spain_segunda_division': { league: 'La Liga 2',      sport: 'football', af_id: 141 },
  'soccer_germany_bundesliga':     { league: 'Bundesliga',     sport: 'football', af_id: 78  },
  'soccer_germany_bundesliga2':    { league: '2. Bundesliga',  sport: 'football', af_id: 79  },
  'soccer_italy_serie_a':          { league: 'Serie A',        sport: 'football', af_id: 135 },
  'soccer_italy_serie_b':          { league: 'Serie B',        sport: 'football', af_id: 136 },
  'soccer_france_ligue_one':       { league: 'Ligue 1',        sport: 'football', af_id: 61  },
  'soccer_france_ligue_two':       { league: 'Ligue 2',        sport: 'football', af_id: 62  },
  'soccer_uefa_champs_league':     { league: 'Champions League', sport: 'football', af_id: 2 },
  // ─── Tennis ──────────────────────────────────────────
  'tennis_atp':                    { league: 'ATP Tour',       sport: 'tennis'   },
  'tennis_wta':                    { league: 'WTA Tour',       sport: 'tennis'   },
  // ─── Basketball ──────────────────────────────────────
  'basketball_nba':                { league: 'NBA',            sport: 'basketball' },
  'basketball_euroleague':         { league: 'EuroLeague',     sport: 'basketball' },
  // ─── MMA ─────────────────────────────────────────────
  'mma_mixed_martial_arts':        { league: 'UFC',            sport: 'mma'      },
  // ─── Boxe ─────────────────────────────────────────────
  'boxing_boxing':                 { league: 'Boxe mondiale',  sport: 'boxe'     },
  // ─── Rugby ───────────────────────────────────────────
  'rugbyleague_nrl':               { league: 'NRL',            sport: 'rugby'    },
  'rugbyleague_super_league':      { league: 'Super League',   sport: 'rugby'    },
};

// ─── Cache classements API-Football (TTL 24h) ─────────
// 1 appel par ligue par jour max → bien dans les 100 req/jour gratuits
const _standingsCache = {};
const STANDINGS_TTL   = 2 * 60 * 60 * 1000;

async function fetchStandings(afLeagueId, KEY_AF) {
  const cached = _standingsCache[afLeagueId];
  if (cached && (Date.now() - cached.time) < STANDINGS_TTL) return cached.table;

  const season = new Date().getMonth() >= 6
    ? new Date().getFullYear()       // juil-déc → saison courante
    : new Date().getFullYear() - 1;  // jan-juin → saison précédente

  const res = await axios.get('https://v3.football.api-sports.io/standings', {
    headers: { 'x-apisports-key': KEY_AF },
    params:  { league: afLeagueId, season },
    timeout: 6000,
  });

  const table = res.data?.response?.[0]?.league?.standings?.[0] || [];
  _standingsCache[afLeagueId] = { table, time: Date.now() };
  return table;
}

function cleanName(n) {
  return n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|as|real|stade|united|city|town|sporting|bayer|atletico|de)\b/g, '').trim();
}

// ─── Cache par sport_key individuel (TTL 30 min) ─────
// 1 appel par sport_key → on ne fetch QUE le sport demandé
// Économise le quota : max 2 appels/heure par sport au lieu de 20
const _oddsCachePerKey = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function fetchOddsForSport(sportFilter, KEY_O) {
  const keysToFetch = Object.entries(SPORT_KEY_TO_LEAGUE)
    .filter(([, info]) => info.sport === sportFilter)
    .map(([key]) => key);

  const now = Date.now();
  const results = await Promise.all(
    keysToFetch.map(async key => {
      const cached = _oddsCachePerKey[key];
      if (cached && now - cached.ts < CACHE_TTL) {
        console.log(`[odds] cache hit: ${key}`);
        return cached.data;
      }
      try {
        const { data } = await axios.get(
          `https://api.the-odds-api.com/v4/sports/${key}/odds/`,
          { params: { apiKey: KEY_O, regions: 'eu', markets: 'h2h,totals' }, timeout: 10000 }
        );
        const events = (Array.isArray(data) ? data : []).map(e => ({ ...e, _sport_key: key }));
        _oddsCachePerKey[key] = { ts: now, data: events };
        console.log(`[odds] fetched ${events.length} events for ${key}`);
        return events;
      } catch (err) {
        console.error(`[odds] ${key}:`, err.response?.status, err.message);
        return _oddsCachePerKey[key]?.data || [];
      }
    })
  );
  return results.flat();
}

// Sports sans match nul (marché h2h à 2 issues uniquement)
const TWO_WAY_SPORTS = new Set(['tennis', 'basketball', 'mma', 'boxe', 'rugby']);

async function runAlgo(sportFilter = 'football') {
  const now    = new Date();
  const future = new Date();
  future.setDate(now.getDate() + 3);

  const KEY_AF = process.env.FOOTBALL_API_KEY || 'f19baef537e16102a9cf2050df18afe8';
  const KEY_O  = process.env.ODDS_API_KEY || '402dfe4ed1b2e82526e91725d6f02438';

  // Récupère uniquement les cotes du sport demandé (cache 30 min par key)
  const oddsData = await fetchOddsForSport(sportFilter, KEY_O);

  // Filtrer sur les 3 prochains jours
  const allEvents = oddsData.filter(o => {
    const d = new Date(o.commence_time);
    return d >= now && d <= future;
  });

  const picks = [];

  allEvents.forEach(matchOdds => {
    if (!matchOdds.bookmakers || !matchOdds.bookmakers.length) return;

    const leagueInfo = SPORT_KEY_TO_LEAGUE[matchOdds._sport_key];
    if (!leagueInfo) return;

    const { league, sport } = leagueInfo;
    const isTwoWay = TWO_WAY_SPORTS.has(sport);

    // Bookmakers français prioritaires
    const FR_KEYS = ['winamax_fr', 'betclic', 'unibet_fr', 'pmu', 'france_pari', 'parions_sport', 'vbet_fr', 'bwin_fr', 'pokerstars_fr'];
    const frBks = matchOdds.bookmakers.filter(bk => FR_KEYS.includes(bk.key));
    const pool = frBks.length >= 2 ? frBks : matchOdds.bookmakers;

    // Moyenne des top 5 meilleures cotes pour un outcome
    function avgOdds(outcomeName, marketKey, point) {
      const entries = [];
      for (const bk of pool) {
        const mkt = bk.markets.find(mk => mk.key === marketKey);
        if (!mkt) continue;
        const o = point != null
          ? mkt.outcomes.find(x => x.name.toLowerCase() === outcomeName && x.point === point)
          : mkt.outcomes.find(x => x.name.toLowerCase() === outcomeName || x.name === outcomeName);
        if (o?.price) entries.push({ key: bk.key, title: bk.title, price: o.price });
      }
      if (!entries.length) return null;
      entries.sort((a, b) => b.price - a.price);
      const top5 = entries.slice(0, 5);
      return parseFloat((top5.reduce((s, e) => s + e.price, 0) / top5.length).toFixed(2));
    }

    function top5ForOutcome(outcomeName, marketKey, point) {
      const entries = [];
      for (const bk of pool) {
        const mkt = bk.markets.find(mk => mk.key === marketKey);
        if (!mkt) continue;
        const o = point != null
          ? mkt.outcomes.find(x => x.name.toLowerCase() === outcomeName && x.point === point)
          : mkt.outcomes.find(x => x.name.toLowerCase() === outcomeName || x.name === outcomeName);
        if (o?.price) entries.push({ key: bk.key, title: bk.title, price: o.price });
      }
      entries.sort((a, b) => b.price - a.price);
      return entries.slice(0, 5);
    }

    const avgHome = avgOdds(matchOdds.home_team, 'h2h');
    const avgAway = avgOdds(matchOdds.away_team, 'h2h');
    if (!avgHome || !avgAway) return;

    const avgDraw = isTwoWay ? null : avgOdds('draw', 'h2h');
    if (!isTwoWay && !avgDraw) return;

    // Devigging — 2 issues (tennis/basket/mma/boxe/rugby) ou 3 issues (football)
    let probHome, probAway, probDraw;
    if (isTwoWay) {
      const margin = (1/avgHome) + (1/avgAway);
      probHome = ((1/avgHome) / margin) * 100;
      probAway = ((1/avgAway) / margin) * 100;
      probDraw = 0;
    } else {
      const margin = (1/avgHome) + (1/avgAway) + (1/avgDraw);
      probHome = ((1/avgHome) / margin) * 100;
      probAway = ((1/avgAway) / margin) * 100;
      probDraw = ((1/avgDraw) / margin) * 100;
    }

    const matchStr = `${matchOdds.home_team} vs ${matchOdds.away_team}`;
    const date     = matchOdds.commence_time.split('T')[0];
    const extra    = { _sport_key: matchOdds._sport_key, sport, homeTeam: matchOdds.home_team, awayTeam: matchOdds.away_team };

    // Construire l'objet bookmakers (top 5 sites)
    const top5Home = top5ForOutcome(matchOdds.home_team, 'h2h');
    const top5Away = top5ForOutcome(matchOdds.away_team, 'h2h');
    const top5Draw = isTwoWay ? [] : top5ForOutcome('draw', 'h2h');
    const bk5Keys  = new Set([...top5Home.map(e => e.key), ...top5Away.map(e => e.key), ...top5Draw.map(e => e.key)]);
    const bk5List  = pool.filter(bk => bk5Keys.has(bk.key)).slice(0, 5);

    const bookmakersObj = {};
    for (const bk of bk5List) {
      const h = bk.markets.find(mk => mk.key === 'h2h');
      if (!h) continue;
      const homeO = h.outcomes.find(x => x.name === matchOdds.home_team);
      const awayO = h.outcomes.find(x => x.name === matchOdds.away_team);
      const drawO = h.outcomes.find(x => x.name.toLowerCase().includes('draw'));
      const entry = { home: homeO?.price ?? null, draw: drawO?.price ?? null, away: awayO?.price ?? null };
      if (!isTwoWay) {
        const pH = homeO?.price ? 1/homeO.price : 0;
        const pD = drawO?.price ? 1/drawO.price : 0;
        const pA = awayO?.price ? 1/awayO.price : 0;
        if (pH && pD) entry.dc_1X = parseFloat((1/(pH+pD)).toFixed(2));
        if (pD && pA) entry.dc_X2 = parseFloat((1/(pD+pA)).toFixed(2));
        if (pH && pA) entry.dc_12 = parseFloat((1/(pH+pA)).toFixed(2));
      }
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

    // ── 1X2 (ou 1X2 sans nul pour 2-way) ────────────────────────────
    if (avgHome >= 1.80 && probHome > 50)
      picks.push({ match: matchStr, league, date, pick: `Victoire ${matchOdds.home_team}`, pick_key: 'home', cote_marche: avgHome, prob: probHome, bookmakers: bookmakersObj, ...extra });
    if (avgAway >= 1.80 && probAway > 50)
      picks.push({ match: matchStr, league, date, pick: `Victoire ${matchOdds.away_team}`, pick_key: 'away', cote_marche: avgAway, prob: probAway, bookmakers: bookmakersObj, ...extra });

    // ── Double chances (football uniquement) ─────────────────────────
    if (!isTwoWay) {
      const cote1X = parseFloat((100 / (probHome + probDraw)).toFixed(2));
      const coteX2 = parseFloat((100 / (probDraw + probAway)).toFixed(2));
      const cote12 = parseFloat((100 / (probHome + probAway)).toFixed(2));
      if (cote1X >= 1.80 && (probHome + probDraw) > 50)
        picks.push({ match: matchStr, league, date, pick: `Double chance 1X — ${matchOdds.home_team} ou Nul`, pick_key: 'dc_1X', cote_marche: cote1X, prob: probHome + probDraw, bookmakers: bookmakersObj, ...extra });
      if (coteX2 >= 1.80 && (probDraw + probAway) > 50)
        picks.push({ match: matchStr, league, date, pick: `Double chance X2 — Nul ou ${matchOdds.away_team}`, pick_key: 'dc_X2', cote_marche: coteX2, prob: probDraw + probAway, bookmakers: bookmakersObj, ...extra });
      if (cote12 >= 1.80 && (probHome + probAway) > 50)
        picks.push({ match: matchStr, league, date, pick: `Double chance 12 — ${matchOdds.home_team} ou ${matchOdds.away_team}`, pick_key: 'dc_12', cote_marche: cote12, prob: probHome + probAway, bookmakers: bookmakersObj, ...extra });
    }

    // ── Buts / totaux ─────────────────────────────────────────────────
    const allTotals = bk5List[0]?.markets.find(mk => mk.key === 'totals')?.outcomes || [];
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

  // Enrichissement stats via API-Football (standings, cache 2h)
  try {
    const afId = SPORT_KEY_TO_LEAGUE[best._sport_key]?.af_id;
    if (afId) {
      const table = await fetchStandings(afId, KEY_AF);

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
            position:      hRow.rank,
            form:          hRow.form || '—',
            goals:         avg(hRow.all?.goals?.for,     hRow.all?.played),
            goals_against: avg(hRow.all?.goals?.against, hRow.all?.played),
            won:           hRow.all?.win,
            draw:          hRow.all?.draw,
            lost:          hRow.all?.lose,
            points:        hRow.points,
          },
          away: {
            name:          best.awayTeam,
            position:      aRow.rank,
            form:          aRow.form || '—',
            goals:         avg(aRow.all?.goals?.for,     aRow.all?.played),
            goals_against: avg(aRow.all?.goals?.against, aRow.all?.played),
            won:           aRow.all?.win,
            draw:          aRow.all?.draw,
            lost:          aRow.all?.lose,
            points:        aRow.points,
          },
        };

        best.factors = [
          `Probabilité implicite bookmakers : ${Math.round(best.prob)}%`,
          `Cote moyenne (${Object.keys(best.bookmakers || {}).length} sites) : ${best.cote_marche.toFixed(2)}`,
          `Value edge : +${best.value.toFixed(1)}%`,
          `${best.homeTeam} — ${hRow.rank}e au classement (${hRow.points} pts), forme : ${hRow.form || '—'}`,
          `${best.awayTeam} — ${aRow.rank}e au classement (${aRow.points} pts), forme : ${aRow.form || '—'}`,
          `${best.homeTeam} : ${avg(hRow.all?.goals?.for, hRow.all?.played)} buts/match marqués, ${avg(hRow.all?.goals?.against, hRow.all?.played)} encaissés`,
          `${best.awayTeam} : ${avg(aRow.all?.goals?.for, aRow.all?.played)} buts/match marqués, ${avg(aRow.all?.goals?.against, aRow.all?.played)} encaissés`,
        ];
        if (hRow.rank < aRow.rank)
          best.factors.push(`${best.homeTeam} mieux classé de ${aRow.rank - hRow.rank} place(s)`);
      }
    }
  } catch (_) {
    // standings non dispo → facteurs de base conservés
  }

  return best;
}

// ─── Fallback démo réaliste (quota API épuisé) ───────
const DEMO_PICKS = {
  football: [
    { match: 'Paris Saint-Germain vs Marseille', league: 'Ligue 1',        pick: 'Victoire Paris Saint-Germain', pick_key: 'home', cote_marche: 1.95, prob: 64, confidence: 72 },
    { match: 'Real Madrid vs Atletico Madrid',   league: 'La Liga',         pick: 'Victoire Real Madrid',         pick_key: 'home', cote_marche: 2.05, prob: 61, confidence: 68 },
    { match: 'Bayern Munich vs Dortmund',        league: 'Bundesliga',      pick: 'Victoire Bayern Munich',       pick_key: 'home', cote_marche: 1.88, prob: 66, confidence: 74 },
    { match: 'Liverpool vs Arsenal',             league: 'Premier League',  pick: 'Victoire Liverpool',           pick_key: 'home', cote_marche: 2.10, prob: 58, confidence: 65 },
    { match: 'Inter Milan vs Juventus',          league: 'Serie A',         pick: 'Plus de 2.5 buts',             pick_key: 'over25', cote_marche: 1.90, prob: 62, confidence: 69 },
  ],
  tennis: [
    { match: 'Novak Djokovic vs Carlos Alcaraz', league: 'ATP Tour', pick: 'Victoire Novak Djokovic', pick_key: 'home', cote_marche: 1.85, prob: 63, confidence: 70 },
    { match: 'Jannik Sinner vs Rafael Nadal',    league: 'ATP Tour', pick: 'Victoire Jannik Sinner',  pick_key: 'home', cote_marche: 1.75, prob: 68, confidence: 74 },
  ],
  basketball: [
    { match: 'Los Angeles Lakers vs Golden State Warriors', league: 'NBA', pick: 'Victoire LA Lakers',          pick_key: 'home', cote_marche: 2.00, prob: 59, confidence: 65 },
    { match: 'Boston Celtics vs Milwaukee Bucks',           league: 'NBA', pick: 'Victoire Boston Celtics',     pick_key: 'home', cote_marche: 1.90, prob: 63, confidence: 68 },
  ],
  mma: [
    { match: 'Jon Jones vs Stipe Miocic', league: 'UFC', pick: 'Victoire Jon Jones', pick_key: 'home', cote_marche: 1.80, prob: 67, confidence: 71 },
  ],
  boxe: [
    { match: 'Tyson Fury vs Anthony Joshua', league: 'Boxe mondiale', pick: 'Victoire Tyson Fury', pick_key: 'home', cote_marche: 1.95, prob: 61, confidence: 66 },
  ],
  rugby: [
    { match: 'Toulouse vs La Rochelle', league: 'Top 14', pick: 'Victoire Toulouse', pick_key: 'home', cote_marche: 1.85, prob: 64, confidence: 70 },
  ],
};

function buildDemoPick(sport) {
  const pool = DEMO_PICKS[sport] || DEMO_PICKS.football;
  const raw  = pool[Math.floor(Math.random() * pool.length)];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().split('T')[0];

  return {
    ...raw,
    sport,
    date,
    cote_ia:       parseFloat((raw.cote_marche * 0.92).toFixed(2)),
    value:         parseFloat(((raw.cote_marche * raw.prob / 100 - 1) * 100).toFixed(1)),
    odds_are_real: false,
    is_demo:       true,
    bookmakers: {
      'Bet365':  { home: raw.cote_marche + 0.05, draw: 3.40, away: 4.20 },
      'Winamax': { home: raw.cote_marche,        draw: 3.50, away: 4.10 },
      'Betclic': { home: raw.cote_marche - 0.05, draw: 3.45, away: 4.15 },
    },
    team_stats: null,
    factors: [
      `Probabilité implicite bookmakers : ${raw.prob}%`,
      `Cote moyenne marché : ${raw.cote_marche.toFixed(2)}`,
      `Value edge estimée : +${parseFloat(((raw.cote_marche * raw.prob / 100 - 1) * 100).toFixed(1))}%`,
      '⚠️ Données démo — cotes temps réel temporairement indisponibles',
    ],
  };
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
    const VALID_SPORTS = ['football', 'tennis', 'basketball', 'mma', 'boxe', 'rugby'];
    const sport = VALID_SPORTS.includes(req.body?.sport) ? req.body.sport : 'football';

    let pick = await runAlgo(sport);
    // Fallback démo si API épuisée ou aucun match trouvé
    if (!pick) {
      console.warn(`[pronos] Aucun pick réel pour ${sport} → fallback démo`);
      pick = buildDemoPick(sport);
    }

    const pronoData = {
      user_id:         req.user.id,
      sport:           pick.sport || sport,
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
    // Renvoyer les données Supabase + données enrichies (non stockées en base)
    res.json({
      ...saved,
      bookmakers:    pick.bookmakers   || {},
      pick_key:      pick.pick_key,
      odds_are_real: true,
      team_stats:    pick.team_stats   || null,
      factors:       pick.factors      || [],
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
  if (error) return res.status(500).json({ error: 'Erreur lors de la récupération.' });

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


module.exports = router;
