// ===================================================
// SERVICE : football-data.org (football) + API-Sports (basket/MMA)
// ===================================================

const axios = require('axios');

// ─── Clients ─────────────────────────────────────────
function getFootballClient() {
  return axios.create({
    baseURL: 'https://api.football-data.org/v4',
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_KEY || '' },
    timeout: 8000,
  });
}

function getApiSportsClient(sport) {
  const bases = {
    basketball: 'https://v1.basketball.api-sports.io',
    mma:        'https://v1.mma.api-sports.io',
  };
  return axios.create({
    baseURL: bases[sport],
    headers: { 'x-apisports-key': process.env.API_SPORTS_KEY || '' },
    timeout: 8000,
  });
}

// ─── The Odds API — clés sport ───────────────────────
const ODDS_API_SPORT_KEYS = {
  'Premier League':   'soccer_epl',
  'La Liga':          'soccer_spain_la_liga',
  'Bundesliga':       'soccer_germany_bundesliga',
  'Serie A':          'soccer_italy_serie_a',
  'Ligue 1':          'soccer_france_ligue_one',
  'Champions League': 'soccer_uefa_champs_league',
  'NBA':              'basketball_nba',
  'Euroleague':       'basketball_euroleague',
  'UFC':              'mma_mixed_martial_arts',
  'Bellator':         'mma_mixed_martial_arts',
  'Boxe':             'boxing_boxing',
};

// ─── Noms bookmakers (The Odds API key → libellé) ────
const BK_LABELS = {
  bet365: 'Bet365', unibet_eu: 'Unibet', betclic: 'Betclic',
  winamax: 'Winamax', pinnacle: 'Pinnacle', betfair: 'Betfair',
  williamhill: 'William Hill', bwin: 'Bwin', ladbrokes_eu: 'Ladbrokes',
  draftkings: 'DraftKings', fanduel: 'FanDuel', bovada: 'Bovada',
  '1xbet': '1xBet', '888sport': '888sport', marathonbet: 'Marathonbet',
  betsson: 'Betsson', nordicbet: 'NordicBet', coolbet: 'Coolbet',
  tipico_de: 'Tipico', betway: 'Betway', suprabets: 'Suprabets',
};

// ─── Cache The Odds API (5 min par sport/date) ────────
const _oddsCache = {};

// ─── Normalisation nom d'équipe pour matching ─────────
function normTeam(s) {
  return (s || '').toLowerCase()
    .replace(/\bfc\b|\bsc\b|\bac\b|\brc\b|\bsporting\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ─── Récupérer les vraies cotes via The Odds API ─────
async function fetchTheOddsApi(sportKey, date) {
  const key = process.env.ODDS_API_KEY;
  if (!key || !sportKey) return null;

  const cacheKey = `${sportKey}_${date}`;
  const now = Date.now();
  if (_oddsCache[cacheKey] && now - _oddsCache[cacheKey].ts < 300_000) {
    return _oddsCache[cacheKey].data;
  }

  try {
    const { data } = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
      params: {
        apiKey:            key,
        regions:           'eu',
        markets:           'h2h,totals',
        oddsFormat:        'decimal',
        commenceTimeFrom:  `${date}T00:00:00Z`,
        commenceTimeTo:    `${date}T23:59:59Z`,
      },
      timeout: 8000,
    });
    _oddsCache[cacheKey] = { ts: now, data };
    return data;
  } catch (err) {
    console.warn('[odds] The Odds API error:', err.response?.status, err.message);
    return null;
  }
}

function buildOddsFromEvent(event) {
  const result = {};
  for (const bk of (event.bookmakers || [])) {
    const label = BK_LABELS[bk.key] || bk.title;
    const h2h    = bk.markets?.find(m => m.key === 'h2h');
    const totals = bk.markets?.find(m => m.key === 'totals');
    if (!h2h) continue;

    const homePrice = h2h.outcomes.find(o => o.name === event.home_team)?.price;
    const awayPrice = h2h.outcomes.find(o => o.name === event.away_team)?.price;
    const drawPrice = h2h.outcomes.find(o => o.name === 'Draw')?.price;
    const over25  = totals?.outcomes.find(o => o.name === 'Over'  && Math.abs(o.point - 2.5) < 0.01)?.price;
    const over35  = totals?.outcomes.find(o => o.name === 'Over'  && Math.abs(o.point - 3.5) < 0.01)?.price;
    const under25 = totals?.outcomes.find(o => o.name === 'Under' && Math.abs(o.point - 2.5) < 0.01)?.price;

    if (!homePrice || !awayPrice) continue;

    // Dériver les cotes double chance depuis les cotes 1X2
    // Formule standard : DC_1X = 1 / (1/home + 1/draw)
    const dc1X = drawPrice ? parseFloat((1 / (1/homePrice + 1/drawPrice)).toFixed(2)) : null;
    const dcX2 = drawPrice ? parseFloat((1 / (1/drawPrice + 1/awayPrice)).toFixed(2)) : null;
    const dc12 = parseFloat((1 / (1/homePrice + 1/awayPrice)).toFixed(2));

    result[label] = {
      home:  parseFloat(homePrice.toFixed(2)),
      draw:  drawPrice ? parseFloat(drawPrice.toFixed(2)) : null,
      away:  parseFloat(awayPrice.toFixed(2)),
      ...(dc1X    ? { '1X':    dc1X    } : {}),
      ...(dcX2    ? { 'X2':    dcX2    } : {}),
      '12':  dc12,
      ...(over25  ? { over25:  parseFloat(over25.toFixed(2))  } : {}),
      ...(over35  ? { over35:  parseFloat(over35.toFixed(2))  } : {}),
      ...(under25 ? { under25: parseFloat(under25.toFixed(2)) } : {}),
    };
  }
  return Object.keys(result).length ? result : null;
}

async function getRealOdds(fixture) {
  const sportKey = ODDS_API_SPORT_KEYS[fixture.league];
  const date     = (fixture.date || '').slice(0, 10);
  if (!sportKey || !date || fixture.isDemo) return null;

  const events = await fetchTheOddsApi(sportKey, date);
  if (!events?.length) return null;

  const homeNorm = normTeam(fixture.homeTeam?.name);
  const awayNorm = normTeam(fixture.awayTeam?.name);

  const event = events.find(e => {
    const h = normTeam(e.home_team);
    const a = normTeam(e.away_team);
    return (h.includes(homeNorm) || homeNorm.includes(h) || homeNorm.includes(h.slice(0, 5))) &&
           (a.includes(awayNorm) || awayNorm.includes(a) || awayNorm.includes(a.slice(0, 5)));
  });

  if (!event) {
    console.warn(`[odds] Aucun événement trouvé pour ${fixture.homeTeam?.name} vs ${fixture.awayTeam?.name}`);
    return null;
  }

  return buildOddsFromEvent(event);
}

// ─── IDs compétitions football-data.org ──────────────
const FOOTBALL_LEAGUE_IDS = {
  'Premier League':   'PL',
  'La Liga':          'PD',
  'Bundesliga':       'BL1',
  'Serie A':          'SA',
  'Ligue 1':          'FL1',
  'Champions League': 'CL',
};

// ─── IDs ligues basket API-Sports ────────────────────
const BASKETBALL_LEAGUE_IDS = {
  'NBA':        12,
  'Euroleague': 120,
};

// ─── Générateur pseudo-aléatoire déterministe (seed) ─
// Même seed → mêmes valeurs (reproductible), seeds différents → valeurs différentes
function seededRand(seed, min, max, decimals = 1) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const r = x - Math.floor(x);
  return parseFloat((min + r * (max - min)).toFixed(decimals));
}

// Seed composite : équipes + date (change chaque jour)
function buildSeed(idA, idB, date) {
  const datePart = date ? parseInt(date.replace(/-/g, '').slice(0, 8)) : 20240101;
  return (idA * 1000 + idB * 7 + datePart) % 999983;
}

// ─── Données de démonstration ────────────────────────
const DEMO_FIXTURES = {
  'Ligue 1':          [{ home: { id: 85,  name: 'Paris Saint-Germain' }, away: { id: 80,  name: 'Monaco' },               venue: 'Parc des Princes' }],
  'Premier League':   [{ home: { id: 40,  name: 'Liverpool' },           away: { id: 42,  name: 'Arsenal' },              venue: 'Anfield' }],
  'La Liga':          [{ home: { id: 541, name: 'Real Madrid' },         away: { id: 529, name: 'Barcelona' },            venue: 'Santiago Bernabéu' }],
  'Bundesliga':       [{ home: { id: 157, name: 'Bayern Munich' },       away: { id: 165, name: 'Borussia Dortmund' },    venue: 'Allianz Arena' }],
  'Serie A':          [{ home: { id: 489, name: 'Inter Milan' },         away: { id: 496, name: 'Juventus' },             venue: 'Giuseppe Meazza' }],
  'Champions League': [{ home: { id: 85,  name: 'Paris Saint-Germain' }, away: { id: 541, name: 'Real Madrid' },          venue: 'Parc des Princes' }],
  'ATP Tour':         [{ home: { id: 1,   name: 'Novak Djokovic' },      away: { id: 2,   name: 'Carlos Alcaraz' },       venue: 'Court Central' }],
  'WTA Tour':         [{ home: { id: 3,   name: 'Iga Swiatek' },         away: { id: 4,   name: 'Aryna Sabalenka' },      venue: 'Court Central' }],
  'NBA':              [{ home: { id: 12,  name: 'Los Angeles Lakers' },  away: { id: 11,  name: 'Golden State Warriors' },venue: 'Crypto.com Arena' }],
  'Euroleague':       [{ home: { id: 120, name: 'Real Madrid' },         away: { id: 121, name: 'CSKA Moscou' },          venue: 'WiZink Center' }],
  'Top 14':           [{ home: { id: 1,   name: 'Toulouse' },            away: { id: 2,   name: 'La Rochelle' },          venue: 'Stade Ernest-Wallon' }],
  'Champions Cup':    [{ home: { id: 3,   name: 'Leinster' },            away: { id: 4,   name: 'La Rochelle' },          venue: 'Aviva Stadium' }],
  'UFC':              [{ home: { id: 1,   name: 'Israel Adesanya' },     away: { id: 2,   name: 'Alex Pereira' },         venue: 'T-Mobile Arena' }],
  'Bellator':         [{ home: { id: 5,   name: 'Ryan Bader' },          away: { id: 6,   name: 'Fedor Emelianenko' },   venue: 'Mohegan Sun Arena' }],
};

function getDemoFixtures(sport, league) {
  const entry = (DEMO_FIXTURES[league] || DEMO_FIXTURES['Ligue 1'])[0];
  return [{
    id:       `demo_${league}_${Date.now()}`,
    isDemo:   true,
    sport,
    league,
    homeTeam: { id: entry.home.id, name: entry.home.name, logo: '' },
    awayTeam: { id: entry.away.id, name: entry.away.name, logo: '' },
    date:     new Date().toISOString(),
    venue:    entry.venue,
  }];
}

function getDemoOdds(fixture) {
  const hId = fixture?.homeTeam?.id || 1;
  const aId = fixture?.awayTeam?.id || 2;
  const date = fixture?.date ? fixture.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const s    = buildSeed(hId, aId, date);

  // Cote domicile entre 1.50 et 3.80
  const homeOdds = seededRand(s,       1.50, 3.80, 2);
  const drawOdds = seededRand(s + 1,   2.80, 4.50, 2);
  const awayOdds = seededRand(s + 2,   1.60, 5.00, 2);

  // Légère variance entre bookmakers (±0.05 à ±0.12)
  const v = (seed, base) => parseFloat((base + seededRand(seed, -0.12, 0.12, 2)).toFixed(2));

  // Over/Under 2.5 et BTTS — plages réalistes de marché
  const over25Base = seededRand(s + 3, 1.58, 2.20, 2);
  const bttsBase   = seededRand(s + 4, 1.50, 2.05, 2);

  return {
    'Bet365': { home: v(s+10, homeOdds), draw: v(s+11, drawOdds), away: v(s+12, awayOdds), over25: v(s+13, over25Base), btts: v(s+14, bttsBase) },
    'Unibet':  { home: v(s+20, homeOdds), draw: v(s+21, drawOdds), away: v(s+22, awayOdds), over25: v(s+23, over25Base), btts: v(s+24, bttsBase) },
    'Betclic': { home: v(s+30, homeOdds), draw: v(s+31, drawOdds), away: v(s+32, awayOdds), over25: v(s+33, over25Base), btts: v(s+34, bttsBase) },
    'Winamax': { home: v(s+40, homeOdds), draw: v(s+41, drawOdds), away: v(s+42, awayOdds), over25: v(s+43, over25Base), btts: v(s+44, bttsBase) },
  };
}

function getDemoStats(fixture) {
  const hId  = fixture?.homeTeam?.id || 1;
  const aId  = fixture?.awayTeam?.id || 2;
  const date = fixture?.date ? fixture.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const sport = fixture?.sport || 'football';
  const s    = buildSeed(hId, aId, date);

  const homeFormPct = Math.round(seededRand(s,      30, 88, 0));
  const awayFormPct = Math.round(seededRand(s + 1,  25, 82, 0));

  if (sport === 'basketball') {
    return {
      home: {
        name: fixture.homeTeam?.name,
        form: `${homeFormPct}%`,
        points:   seededRand(s + 5,  95, 122, 1),
        rebounds: seededRand(s + 6,  38, 52, 1),
        assists:  seededRand(s + 7,  20, 32, 1),
        back_to_back: seededRand(s + 8, 0, 1, 0),
      },
      away: {
        name: fixture.awayTeam?.name,
        form: `${awayFormPct}%`,
        points:   seededRand(s + 15, 92, 118, 1),
        rebounds: seededRand(s + 16, 36, 50, 1),
        assists:  seededRand(s + 17, 18, 30, 1),
        back_to_back: seededRand(s + 18, 0, 1, 0),
      },
    };
  }

  if (sport === 'mma') {
    return {
      home: {
        name: fixture.homeTeam?.name,
        form:               `${homeFormPct}%`,
        ko_rate:            seededRand(s + 5,  0.25, 0.75, 2),
        takedown_defense:   seededRand(s + 6,  0.45, 0.88, 2),
        striking_accuracy:  seededRand(s + 7,  0.38, 0.62, 2),
      },
      away: {
        name: fixture.awayTeam?.name,
        form:               `${awayFormPct}%`,
        ko_rate:            seededRand(s + 15, 0.20, 0.70, 2),
        takedown_defense:   seededRand(s + 16, 0.42, 0.85, 2),
        striking_accuracy:  seededRand(s + 17, 0.35, 0.60, 2),
      },
    };
  }

  if (sport === 'tennis') {
    return {
      home: {
        name: fixture.homeTeam?.name,
        form:               `${homeFormPct}%`,
        aces:               seededRand(s + 5, 3, 14, 1),
        first_serve_pct:    seededRand(s + 6, 55, 75, 1),
        fatigue:            seededRand(s + 7, 0, 3, 0),
      },
      away: {
        name: fixture.awayTeam?.name,
        form:               `${awayFormPct}%`,
        aces:               seededRand(s + 15, 2, 12, 1),
        first_serve_pct:    seededRand(s + 16, 52, 72, 1),
        fatigue:            seededRand(s + 17, 0, 3, 0),
      },
    };
  }

  if (sport === 'rugby') {
    return {
      home: {
        name: fixture.homeTeam?.name,
        form:      `${homeFormPct}%`,
        points:    seededRand(s + 5, 14, 38, 1),
        penalties: seededRand(s + 6, 5, 14, 0),
        scrum_win: seededRand(s + 7, 0.45, 0.80, 2),
      },
      away: {
        name: fixture.awayTeam?.name,
        form:      `${awayFormPct}%`,
        points:    seededRand(s + 15, 12, 34, 1),
        penalties: seededRand(s + 16, 6, 15, 0),
        scrum_win: seededRand(s + 17, 0.42, 0.75, 2),
      },
    };
  }

  if (sport === 'boxe') {
    return {
      home: {
        name: fixture.homeTeam?.name,
        form:    `${homeFormPct}%`,
        ko_rate: seededRand(s + 5,  0.30, 0.75, 2),
        reach:   seededRand(s + 6,  168, 200, 0),
        wins:    seededRand(s + 7,  8, 30, 0),
      },
      away: {
        name: fixture.awayTeam?.name,
        form:    `${awayFormPct}%`,
        ko_rate: seededRand(s + 15, 0.25, 0.70, 2),
        reach:   seededRand(s + 16, 165, 198, 0),
        wins:    seededRand(s + 17, 7, 28, 0),
      },
    };
  }

  // Football (défaut)
  return {
    home: {
      name:      fixture.homeTeam?.name,
      form:      `${homeFormPct}%`,
      goals:     seededRand(s + 5,  0.7, 2.9, 2),
      xg:        seededRand(s + 6,  0.6, 2.6, 2),
      possession:Math.round(seededRand(s + 7, 38, 65, 0)),
    },
    away: {
      name:      fixture.awayTeam?.name,
      form:      `${awayFormPct}%`,
      goals:     seededRand(s + 15, 0.6, 2.6, 2),
      xg:        seededRand(s + 16, 0.5, 2.3, 2),
      possession:Math.round(seededRand(s + 17, 35, 62, 0)),
    },
  };
}

// ─── Cache fixtures football (10 min pour éviter 429) ──
const _fixturesCache = {};

// ─── Construire des fixtures depuis les événements The Odds API ──
function fixturesFromOddsEvents(events, league) {
  return events.map(e => ({
    id:       e.id,
    isDemo:   false,
    sport:    'football',
    league,
    homeTeam: { id: 0, name: e.home_team, logo: '' },
    awayTeam: { id: 0, name: e.away_team, logo: '' },
    date:     e.commence_time,
    venue:    '',
    status:   'SCHEDULED',
  }));
}

// ─── getFootballFixtures ──────────────────────────────
async function getFootballFixtures(league, date) {
  const competitionId = FOOTBALL_LEAGUE_IDS[league];
  const sportKey      = ODDS_API_SPORT_KEYS[league];

  // Cache 10 min : évite le 429 (10 req/min sur plan gratuit)
  const cacheKey = `${league}_${date}`;
  const now = Date.now();
  if (_fixturesCache[cacheKey] && now - _fixturesCache[cacheKey].ts < 600_000) {
    return _fixturesCache[cacheKey].data;
  }

  // 1. Essayer football-data.org si clé disponible
  if (competitionId && process.env.FOOTBALL_DATA_KEY) {
    try {
      const client = getFootballClient();
      const { data } = await client.get(`/competitions/${competitionId}/matches`, {
        params: { dateFrom: date, dateTo: date },
      });
      const matches = data.matches || [];
      if (matches.length) {
        const result = matches.map(m => ({
          id:       m.id,
          isDemo:   false,
          sport:    'football',
          league,
          homeTeam: { id: m.homeTeam.id, name: m.homeTeam.name, logo: m.homeTeam.crest || '' },
          awayTeam: { id: m.awayTeam.id, name: m.awayTeam.name, logo: m.awayTeam.crest || '' },
          date:     m.utcDate,
          venue:    m.venue || '',
          status:   m.status,
        }));
        _fixturesCache[cacheKey] = { ts: now, data: result };
        return result;
      }
      console.warn(`[apiSports] football-data.org: aucun match ${league} le ${date} — tentative Odds API`);
    } catch (err) {
      console.error('[apiSports/getFootballFixtures] football-data.org:', err.message);
      if (_fixturesCache[cacheKey]) return _fixturesCache[cacheKey].data;
    }
  }

  // 2. Fallback : utiliser les événements de The Odds API comme fixtures
  if (sportKey) {
    try {
      const events = await fetchTheOddsApi(sportKey, date);
      if (events?.length) {
        console.log(`[apiSports] Odds API: ${events.length} match(s) trouvé(s) pour ${league} le ${date}`);
        const result = fixturesFromOddsEvents(events, league);
        _fixturesCache[cacheKey] = { ts: now, data: result };
        return result;
      }
    } catch (err) {
      console.error('[apiSports/getFootballFixtures] Odds API:', err.message);
    }
  }

  // 3. Aucune source réelle → démo
  console.warn(`[apiSports] Football: aucune source réelle pour ${league} le ${date} — démo`);
  const demo = getDemoFixtures('football', league);
  _fixturesCache[cacheKey] = { ts: now, data: demo };
  return demo;
}

// ─── getBasketballFixtures ────────────────────────────
async function getBasketballFixtures(league, date) {
  const leagueId = BASKETBALL_LEAGUE_IDS[league];
  if (!leagueId || !process.env.API_SPORTS_KEY) {
    return getDemoFixtures('basketball', league);
  }
  try {
    const client    = getApiSportsClient('basketball');
    const yearNow   = new Date().getFullYear();
    const seasons   = [yearNow, yearNow - 1]; // NBA 2025-26 → season=2025

    for (const season of seasons) {
      const { data } = await client.get('/games', {
        params: { date, league: leagueId, season },
      });
      const games = data.response || [];
      if (data.errors?.plan) {
        console.warn(`[apiSports] Basket plan restriction — démo`);
        return getDemoFixtures('basketball', league);
      }
      if (games.length > 0) {
        return games.map(g => ({
          id:       g.id,
          isDemo:   false,
          sport:    'basketball',
          league,
          homeTeam: { id: g.teams.home.id, name: g.teams.home.name, logo: g.teams.home.logo || '' },
          awayTeam: { id: g.teams.away.id, name: g.teams.away.name, logo: g.teams.away.logo || '' },
          date:     g.date,
          venue:    g.arena?.name || '',
          status:   g.status?.long || '',
        }));
      }
    }
    console.warn(`[apiSports] Basket: aucun match ${league} le ${date} — démo`);
    return getDemoFixtures('basketball', league);
  } catch (err) {
    console.error('[apiSports/getBasketballFixtures]', err.message);
    return getDemoFixtures('basketball', league);
  }
}

// ─── getMmaFixtures ───────────────────────────────────
async function getMmaFixtures(league, date) {
  if (!process.env.API_SPORTS_KEY) {
    return getDemoFixtures('mma', league);
  }
  try {
    const client = getApiSportsClient('mma');
    const { data } = await client.get('/fights', { params: { date } });
    const fights = data.response || [];
    if (fights.length > 0) {
      return fights.slice(0, 5).map(f => ({
        id:       f.id,
        isDemo:   false,
        sport:    'mma',
        league:   f.event?.league?.name || league,
        homeTeam: { id: f.fighters?.first?.id  || 1, name: f.fighters?.first?.name  || 'Fighter 1', logo: '' },
        awayTeam: { id: f.fighters?.second?.id || 2, name: f.fighters?.second?.name || 'Fighter 2', logo: '' },
        date:     f.date,
        venue:    f.event?.venue || '',
        status:   f.status || '',
      }));
    }
    console.warn(`[apiSports] MMA: aucun combat le ${date} — démo`);
    return getDemoFixtures('mma', league);
  } catch (err) {
    console.error('[apiSports/getMmaFixtures]', err.message);
    return getDemoFixtures('mma', league);
  }
}

// ─── getFixtures (point d'entrée) ────────────────────
async function getFixtures({ sport = 'football', league, date }) {
  if (sport === 'football')   return getFootballFixtures(league, date);
  if (sport === 'basketball') return getBasketballFixtures(league, date);
  if (sport === 'mma')        return getMmaFixtures(league, date);
  // Tennis, rugby, boxe → pas d'API gratuite disponible → démo
  return getDemoFixtures(sport, league);
}

// ─── Cache classements (TTL 10 min) ──────────────────
const _standingsCache = {};
async function fetchStandings(competitionId) {
  const now = Date.now();
  if (_standingsCache[competitionId] && now - _standingsCache[competitionId].ts < 600_000) {
    return _standingsCache[competitionId].data;
  }
  const client = getFootballClient();
  const { data } = await client.get(`/competitions/${competitionId}/standings`);
  const table = (data.standings || []).find(s => s.type === 'TOTAL')?.table || [];
  _standingsCache[competitionId] = { ts: now, data: table };
  return table;
}

// ─── getTeamStats ─────────────────────────────────────
async function getTeamStats(fixture) {
  // Pour le football : vraies stats depuis les classements
  if (fixture.sport === 'football' && process.env.FOOTBALL_DATA_KEY && !fixture.isDemo) {
    const compId = FOOTBALL_LEAGUE_IDS[fixture.league];
    if (compId) {
      try {
        const table = await fetchStandings(compId);
        const findTeam = id => table.find(row => row.team.id === id);
        const hRow = findTeam(fixture.homeTeam?.id);
        const aRow = findTeam(fixture.awayTeam?.id);

        if (hRow && aRow) {
          const toStats = (row, name) => {
            const played = row.playedGames || 1;
            const formPct = Math.round(((row.won || 0) + (row.draw || 0) * 0.5) / played * 100);
            const goals   = parseFloat(((row.goalsFor || 0) / played).toFixed(2));
            const conceded= parseFloat(((row.goalsAgainst || 0) / played).toFixed(2));
            return {
              name,
              form:         `${formPct}%`,
              goals,
              goals_against: conceded,
              position:     row.position,
              played,
              won:          row.won || 0,
              draw:         row.draw || 0,
              lost:         row.lost || 0,
              points:       row.points || 0,
            };
          };
          return {
            home: toStats(hRow, fixture.homeTeam?.name),
            away: toStats(aRow, fixture.awayTeam?.name),
          };
        }
      } catch (err) {
        console.warn('[apiSports/getTeamStats] standings failed, fallback démo:', err.message);
      }
    }
  }
  // Autres sports ou fallback → démo seedé
  return getDemoStats(fixture);
}

// ─── getInjuries ──────────────────────────────────────
async function getInjuries() {
  return [];
}

// ─── getOdds ──────────────────────────────────────────
// Retourne uniquement les vraies cotes bookmakers (The Odds API)
// null si pas de couverture pour ce match → pas de prono généré
async function getOdds(fixture) {
  const real = await getRealOdds(fixture);
  if (real) {
    console.log(`[odds] Vraies cotes récupérées pour ${fixture.homeTeam?.name} vs ${fixture.awayTeam?.name}`);
    return real;
  }
  console.warn(`[odds] Pas de cotes réelles pour ${fixture.homeTeam?.name} vs ${fixture.awayTeam?.name}`);
  return null;
}

module.exports = { getFixtures, getTeamStats, getInjuries, getOdds, getDemoFixtures };
