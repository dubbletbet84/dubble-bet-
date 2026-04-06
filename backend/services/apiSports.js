// ===================================================
// SERVICE : API-Sports (api-sports.io)
// Doc : https://api-sports.io/documentation
// ===================================================
// TODO: Insérez votre clé API dans le .env :
//   API_SPORTS_KEY=votre_cle_api_sports
// ===================================================

const axios = require('axios');

const BASE_URL = 'https://v3.football.api-sports.io'; // Football
// Autres endpoints selon le sport :
// Tennis    : https://v1.tennis.api-sports.io
// Basketball: https://v1.basketball.api-sports.io
// MMA       : https://v1.mma.api-sports.io
// Rugby     : https://v1.rugby.api-sports.io

const SPORT_BASES = {
  football:   'https://v3.football.api-sports.io',
  tennis:     'https://v1.tennis.api-sports.io',
  basketball: 'https://v1.basketball.api-sports.io',
  mma:        'https://v1.mma.api-sports.io',
  rugby:      'https://v1.rugby.api-sports.io',
  boxe:       'https://v1.boxing.api-sports.io',
};

const LEAGUE_IDS = {
  'Ligue 1':          61,
  'Premier League':   39,
  'La Liga':          140,
  'Bundesliga':       78,
  'Serie A':          135,
  'Champions League': 2,
  'ATP Tour':         1,
  'NBA':              12,
  'Euroleague':       120,
  'Top 14':           1,
  'UFC':              1,
};

function getClient(sport = 'football') {
  return axios.create({
    baseURL: SPORT_BASES[sport] || BASE_URL,
    headers: {
      'x-apisports-key': process.env.API_SPORTS_KEY,
      'x-apisports-host': `v${sport === 'football' ? 3 : 1}.${sport}.api-sports.io`,
    },
    timeout: 8000,
  });
}

// ─── Données de démonstration ────────────────────────
// Utilisées si API_SPORTS_KEY est absent ou en développement
function getDemoFixtures(sport, league) {
  return [
    {
      id: `demo_${Date.now()}`,
      sport,
      league,
      homeTeam: { id: 85,  name: 'Paris Saint-Germain', logo: '' },
      awayTeam: { id: 80,  name: 'Lyon',                 logo: '' },
      date:     new Date().toISOString(),
      venue:    'Parc des Princes',
    },
  ];
}

function getDemoOdds(fixture) {
  return {
    'Bet365': { home: 1.95, draw: 3.60, away: 4.20 },
    'Unibet':  { home: 1.92, draw: 3.55, away: 4.30 },
    'Betclic': { home: 1.96, draw: 3.65, away: 4.10 },
    'Winamax': { home: 1.93, draw: 3.70, away: 4.25 },
  };
}

function getDemoStats(fixture) {
  return {
    home: { name: fixture.homeTeam?.name, form: '80%', goals: 2.3, xg: 2.1, possession: 58 },
    away: { name: fixture.awayTeam?.name, form: '40%', goals: 1.2, xg: 1.0, possession: 42 },
  };
}

function getDemoInjuries() {
  return [
    { player: 'Lacazette', team: 'Lyon',  type: 'Blessure musculaire' },
    { player: 'Tolisso',   team: 'Lyon',  type: 'Suspension' },
  ];
}

// ─── getFixtures ─────────────────────────────────────
async function getFixtures({ sport = 'football', league, date }) {
  if (!process.env.API_SPORTS_KEY) {
    console.warn('[apiSports] Pas de clé API — données démo');
    return getDemoFixtures(sport, league);
  }

  try {
    const client   = getClient(sport);
    const leagueId = LEAGUE_IDS[league];
    const { data } = await client.get('/fixtures', {
      params: { date, league: leagueId, season: new Date().getFullYear() },
    });

    return (data.response || []).map(f => ({
      id:       f.fixture.id,
      sport,
      league,
      homeTeam: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
      awayTeam: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
      date:     f.fixture.date,
      venue:    f.fixture.venue?.name,
      status:   f.fixture.status?.short,
    }));
  } catch (err) {
    console.error('[apiSports/getFixtures]', err.message);
    return getDemoFixtures(sport, league);
  }
}

// ─── getTeamStats ────────────────────────────────────
async function getTeamStats(fixture) {
  if (!process.env.API_SPORTS_KEY) return getDemoStats(fixture);

  try {
    const client = getClient(fixture.sport);
    const season = new Date().getFullYear();

    const [homeRes, awayRes] = await Promise.all([
      client.get('/teams/statistics', {
        params: { team: fixture.homeTeam.id, league: LEAGUE_IDS[fixture.league], season },
      }),
      client.get('/teams/statistics', {
        params: { team: fixture.awayTeam.id, league: LEAGUE_IDS[fixture.league], season },
      }),
    ]);

    const parseStats = (res, teamName) => {
      const s = res.data.response;
      if (!s) return { name: teamName, form: '—', goals: 0, xg: 0, possession: 50 };
      const form  = s.form || '';
      const wins  = (form.match(/W/g) || []).length;
      const played = form.length || 1;
      return {
        name:       teamName,
        form:       Math.round(wins / played * 100) + '%',
        goals:      parseFloat(s.goals?.for?.average?.total || 0),
        xg:         parseFloat(s.goals?.for?.average?.total || 0) * 0.9,
        possession: parseInt(s.fixtures?.played?.total || 50),
      };
    };

    return {
      home: parseStats(homeRes, fixture.homeTeam.name),
      away: parseStats(awayRes, fixture.awayTeam.name),
    };
  } catch (err) {
    console.error('[apiSports/getTeamStats]', err.message);
    return getDemoStats(fixture);
  }
}

// ─── getInjuries ─────────────────────────────────────
async function getInjuries(fixture) {
  if (!process.env.API_SPORTS_KEY) return getDemoInjuries();

  try {
    const client = getClient(fixture.sport);
    const { data } = await client.get('/injuries', {
      params: {
        fixture: fixture.id,
        league:  LEAGUE_IDS[fixture.league],
        season:  new Date().getFullYear(),
      },
    });

    return (data.response || []).map(i => ({
      player: i.player?.name,
      team:   i.team?.name,
      type:   i.player?.reason || 'Blessure',
    }));
  } catch (err) {
    console.error('[apiSports/getInjuries]', err.message);
    return getDemoInjuries();
  }
}

// ─── getOdds ─────────────────────────────────────────
async function getOdds(fixture) {
  if (!process.env.API_SPORTS_KEY) return getDemoOdds(fixture);

  try {
    const client = getClient(fixture.sport);
    const { data } = await client.get('/odds', {
      params: { fixture: fixture.id },
    });

    const bookmakers = {};
    const targetBks  = ['Bet365', 'Unibet', 'Betclic', 'Winamax'];

    (data.response?.[0]?.bookmakers || []).forEach(bk => {
      if (!targetBks.includes(bk.name)) return;
      const market = bk.bets?.find(b => b.name === 'Match Winner');
      if (!market) return;
      const findVal = (name) => parseFloat(market.values?.find(v => v.value === name)?.odd || 0);
      bookmakers[bk.name] = {
        home: findVal('Home'),
        draw: findVal('Draw'),
        away: findVal('Away'),
      };
    });

    // Compléter avec données démo si bookmaker manquant
    const demo = getDemoOdds(fixture);
    targetBks.forEach(bk => { if (!bookmakers[bk]) bookmakers[bk] = demo[bk]; });

    return bookmakers;
  } catch (err) {
    console.error('[apiSports/getOdds]', err.message);
    return getDemoOdds(fixture);
  }
}

module.exports = { getFixtures, getTeamStats, getInjuries, getOdds };
