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

function getDemoOdds() {
  return {
    'Bet365': { home: 1.95, draw: 3.60, away: 4.20 },
    'Unibet':  { home: 1.92, draw: 3.55, away: 4.30 },
    'Betclic': { home: 1.96, draw: 3.65, away: 4.10 },
    'Winamax': { home: 1.93, draw: 3.70, away: 4.25 },
  };
}

function getDemoStats(fixture) {
  return {
    home: { name: fixture.homeTeam?.name, form: '75%', goals: 2.1, xg: 1.9, possession: 56 },
    away: { name: fixture.awayTeam?.name, form: '45%', goals: 1.3, xg: 1.1, possession: 44 },
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
// football-data.org plan gratuit sans stats détaillées → démo pour tous les sports
async function getTeamStats(fixture) {
  return getDemoStats(fixture);
}

// ─── getInjuries ──────────────────────────────────────
async function getInjuries() {
  return [];
}

// ─── getOdds ──────────────────────────────────────────
async function getOdds() {
  return getDemoOdds();
}

module.exports = { getFixtures, getTeamStats, getInjuries, getOdds, getDemoFixtures };
