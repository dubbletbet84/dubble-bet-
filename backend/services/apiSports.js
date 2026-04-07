// ===================================================
// SERVICE : football-data.org (gratuit, matchs en cours)
// Doc : https://www.football-data.org/documentation/quickstart
// Variable Railway : FOOTBALL_DATA_KEY=votre_cle
// ===================================================

const axios = require('axios');

// IDs des compétitions sur football-data.org
const LEAGUE_IDS = {
  'Premier League':   'PL',
  'La Liga':          'PD',
  'Bundesliga':       'BL1',
  'Serie A':          'SA',
  'Ligue 1':          'FL1',
  'Champions League': 'CL',
  'Eredivisie':       'DED',
  'Primeira Liga':    'PPL',
  // Sports non-football → pas couverts par football-data.org, démo uniquement
  'ATP Tour':         null,
  'NBA':              null,
  'Euroleague':       null,
  'Top 14':           null,
  'UFC':              null,
};

function getClient() {
  return axios.create({
    baseURL: 'https://api.football-data.org/v4',
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_KEY || '' },
    timeout: 8000,
  });
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
  'NBA':              [{ home: { id: 12,  name: 'Los Angeles Lakers' },  away: { id: 11,  name: 'Golden State Warriors' },venue: 'Crypto.com Arena' }],
  'Euroleague':       [{ home: { id: 120, name: 'Real Madrid' },         away: { id: 121, name: 'CSKA Moscou' },          venue: 'WiZink Center' }],
  'Top 14':           [{ home: { id: 1,   name: 'Toulouse' },            away: { id: 2,   name: 'La Rochelle' },          venue: 'Stade Ernest-Wallon' }],
  'UFC':              [{ home: { id: 1,   name: 'Israel Adesanya' },     away: { id: 2,   name: 'Alex Pereira' },         venue: 'T-Mobile Arena' }],
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

function getDemoInjuries() {
  return [];
}

// ─── getFixtures ─────────────────────────────────────
async function getFixtures({ sport = 'football', league, date }) {
  const competitionId = LEAGUE_IDS[league];

  // Sports non-football ou pas de clé → démo directement
  if (!competitionId || !process.env.FOOTBALL_DATA_KEY) {
    console.warn(`[apiSports] Pas de clé ou sport non supporté (${league}) — données démo`);
    return getDemoFixtures(sport, league);
  }

  try {
    const client = getClient();
    const { data } = await client.get(`/competitions/${competitionId}/matches`, {
      params: { dateFrom: date, dateTo: date, status: 'SCHEDULED,TIMED,IN_PLAY,PAUSED' },
    });

    const matches = data.matches || [];
    if (!matches.length) {
      console.warn(`[apiSports] Aucun match ${league} le ${date} — données démo`);
      return getDemoFixtures(sport, league);
    }

    return matches.map(m => ({
      id:       m.id,
      isDemo:   false,
      sport,
      league,
      homeTeam: { id: m.homeTeam.id, name: m.homeTeam.name, logo: m.homeTeam.crest || '' },
      awayTeam: { id: m.awayTeam.id, name: m.awayTeam.name, logo: m.awayTeam.crest || '' },
      date:     m.utcDate,
      venue:    m.venue || '',
      status:   m.status,
    }));
  } catch (err) {
    console.error('[apiSports/getFixtures]', err.message);
    return getDemoFixtures(sport, league);
  }
}

// ─── getTeamStats ────────────────────────────────────
async function getTeamStats(fixture) {
  if (fixture.isDemo || !process.env.FOOTBALL_DATA_KEY) return getDemoStats(fixture);

  try {
    const client = getClient();
    const competitionId = LEAGUE_IDS[fixture.league];

    const [homeRes, awayRes] = await Promise.all([
      client.get(`/teams/${fixture.homeTeam.id}/matches`, {
        params: { competitions: competitionId, limit: 10, status: 'FINISHED' },
      }),
      client.get(`/teams/${fixture.awayTeam.id}/matches`, {
        params: { competitions: competitionId, limit: 10, status: 'FINISHED' },
      }),
    ]);

    const parseStats = (res, teamId, teamName) => {
      const matches = res.data.matches || [];
      if (!matches.length) return { name: teamName, form: '50%', goals: 1.5, xg: 1.3, possession: 50 };
      const wins = matches.filter(m =>
        (m.homeTeam.id === teamId && m.score.winner === 'HOME_TEAM') ||
        (m.awayTeam.id === teamId && m.score.winner === 'AWAY_TEAM')
      ).length;
      const totalGoals = matches.reduce((acc, m) => {
        const isHome = m.homeTeam.id === teamId;
        return acc + (isHome ? (m.score.fullTime.home || 0) : (m.score.fullTime.away || 0));
      }, 0);
      return {
        name:       teamName,
        form:       Math.round(wins / matches.length * 100) + '%',
        goals:      parseFloat((totalGoals / matches.length).toFixed(1)),
        xg:         parseFloat((totalGoals / matches.length * 0.9).toFixed(1)),
        possession: 50,
      };
    };

    return {
      home: parseStats(homeRes, fixture.homeTeam.id, fixture.homeTeam.name),
      away: parseStats(awayRes, fixture.awayTeam.id, fixture.awayTeam.name),
    };
  } catch (err) {
    console.error('[apiSports/getTeamStats]', err.message);
    return getDemoStats(fixture);
  }
}

// ─── getInjuries ─────────────────────────────────────
// football-data.org ne fournit pas les blessures → démo vide
async function getInjuries(fixture) {
  return getDemoInjuries();
}

// ─── getOdds ─────────────────────────────────────────
// football-data.org ne fournit pas les cotes → démo
async function getOdds(fixture) {
  return getDemoOdds(fixture);
}

module.exports = { getFixtures, getTeamStats, getInjuries, getOdds, getDemoFixtures };
