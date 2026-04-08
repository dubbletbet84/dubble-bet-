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

  return {
    'Bet365': { home: v(s + 10, homeOdds), draw: v(s + 11, drawOdds), away: v(s + 12, awayOdds) },
    'Unibet':  { home: v(s + 20, homeOdds), draw: v(s + 21, drawOdds), away: v(s + 22, awayOdds) },
    'Betclic': { home: v(s + 30, homeOdds), draw: v(s + 31, drawOdds), away: v(s + 32, awayOdds) },
    'Winamax': { home: v(s + 40, homeOdds), draw: v(s + 41, drawOdds), away: v(s + 42, awayOdds) },
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

// ─── getFootballFixtures ──────────────────────────────
async function getFootballFixtures(league, date) {
  const competitionId = FOOTBALL_LEAGUE_IDS[league];
  if (!competitionId || !process.env.FOOTBALL_DATA_KEY) {
    console.warn(`[apiSports] Football: pas de clé ou ligue inconnue (${league}) — démo`);
    return getDemoFixtures('football', league);
  }
  try {
    const client = getFootballClient();
    const { data } = await client.get(`/competitions/${competitionId}/matches`, {
      params: { dateFrom: date, dateTo: date, status: 'SCHEDULED,TIMED,IN_PLAY,PAUSED' },
    });
    const matches = data.matches || [];
    if (!matches.length) {
      console.warn(`[apiSports] Football: aucun match ${league} le ${date} — démo`);
      return getDemoFixtures('football', league);
    }
    return matches.map(m => ({
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
  } catch (err) {
    console.error('[apiSports/getFootballFixtures]', err.message);
    return getDemoFixtures('football', league);
  }
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

// ─── getTeamStats ─────────────────────────────────────
async function getTeamStats(fixture) {
  return getDemoStats(fixture);
}

// ─── getInjuries ──────────────────────────────────────
async function getInjuries() {
  return [];
}

// ─── getOdds ──────────────────────────────────────────
async function getOdds(fixture) {
  return getDemoOdds(fixture);
}

module.exports = { getFixtures, getTeamStats, getInjuries, getOdds, getDemoFixtures };
