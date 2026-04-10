// ===================================================
// DUBBLE BET — Logique principale (app.js)
// ===================================================

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3001/api'
  : 'https://dubble-bet-production.up.railway.app/api'; // TODO: remplacer par votre URL Railway

// ===================================================
// DONNÉES DE DÉMONSTRATION
// Remplacez par de vrais appels API-Sports quand la clé est disponible
// ===================================================

const DEMO_LEAGUES = {
  football: [
    { id: 61,   name: 'Ligue 1', country: '🇫🇷' },
    { id: 39,   name: 'Premier League', country: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { id: 140,  name: 'La Liga', country: '🇪🇸' },
    { id: 78,   name: 'Bundesliga', country: '🇩🇪' },
    { id: 135,  name: 'Serie A', country: '🇮🇹' },
    { id: 2,    name: 'Champions League', country: '🏆' },
  ],
  tennis: [
    { id: 1,    name: 'ATP Tour', country: '🌍' },
    { id: 2,    name: 'WTA Tour', country: '🌍' },
    { id: 3,    name: 'Grand Chelems', country: '🏆' },
  ],
  basketball: [
    { id: 12,   name: 'NBA', country: '🇺🇸' },
    { id: 120,  name: 'Euroleague', country: '🇪🇺' },
    { id: 200,  name: 'Pro A', country: '🇫🇷' },
  ],
  mma: [
    { id: 1,    name: 'UFC', country: '🌍' },
    { id: 2,    name: 'Bellator', country: '🌍' },
  ],
  rugby: [
    { id: 1,    name: 'Top 14', country: '🇫🇷' },
    { id: 2,    name: 'Champions Cup', country: '🏆' },
  ],
  boxe: [
    { id: 1,    name: 'World Championship', country: '🌍' },
  ],
};

const DEMO_PRONOSTICS = [
  {
    id: 'prono_001',
    sport: 'football',
    league: 'Ligue 1',
    match: 'Paris SG vs Lyon',
    pick: 'Victoire PSG',
    cote_ia: 1.72,
    cote_marche: 1.94,
    confidence: 74,
    value: 12.8,
    result: 'win',
    date: '2026-04-05',
    bookmakers: {
      'Bet365': { home: 1.95, draw: 3.60, away: 4.20 },
      'Unibet':  { home: 1.92, draw: 3.55, away: 4.30 },
      'Betclic': { home: 1.96, draw: 3.65, away: 4.10 },
      'Winamax': { home: 1.93, draw: 3.70, away: 4.25 },
    },
    injuries: [
      { player: 'Alexandre Lacazette', team: 'Lyon', type: 'Blessure musculaire' },
      { player: 'Corentin Tolisso', team: 'Lyon', type: 'Suspension' },
    ],
    teamStats: {
      home: { name: 'PSG', form: '80%', goals: 2.3, xg: 2.1, possession: 58 },
      away: { name: 'Lyon', form: '40%', goals: 1.2, xg: 1.0, possession: 42 },
    },
    factors: ['Mbappé titulaire', 'Lyon sur 4 défaites consécutives', 'PSG invaincu à domicile'],
  },
  {
    id: 'prono_002',
    sport: 'tennis',
    league: 'ATP Tour',
    match: 'Djokovic vs Alcaraz',
    pick: 'Victoire Alcaraz',
    cote_ia: 1.85,
    cote_marche: 2.10,
    confidence: 67,
    value: 13.5,
    result: 'win',
    date: '2026-04-04',
    bookmakers: {
      'Bet365': { home: 2.12, away: 1.75 },
      'Unibet':  { home: 2.08, away: 1.78 },
      'Betclic': { home: 2.15, away: 1.72 },
      'Winamax': { home: 2.05, away: 1.80 },
    },
    injuries: [],
    teamStats: {
      home: { name: 'Djokovic', form: '60%', wins: 3, losses: 2 },
      away: { name: 'Alcaraz', form: '85%', wins: 5, losses: 1 },
    },
    factors: ['Alcaraz sur surface préférée', 'Djokovic sorti de blessure', 'Surface terre battue avantageuse'],
  },
  {
    id: 'prono_003',
    sport: 'basketball',
    league: 'NBA',
    match: 'Lakers vs Warriors',
    pick: 'Warriors +5.5',
    cote_ia: 1.88,
    cote_marche: 1.96,
    confidence: 61,
    value: 4.3,
    result: 'loss',
    date: '2026-04-03',
    bookmakers: {
      'Bet365': { home: 1.95, away: 1.98 },
      'Unibet':  { home: 1.92, away: 2.00 },
      'Betclic': { home: 1.97, away: 1.94 },
      'Winamax': { home: 1.93, away: 1.96 },
    },
    injuries: [
      { player: 'LeBron James', team: 'Lakers', type: 'Douleur cheville' },
    ],
    teamStats: {
      home: { name: 'Lakers', form: '55%', points: 112, xg: 110 },
      away: { name: 'Warriors', form: '65%', points: 115, xg: 113 },
    },
    factors: ['Lakers back-to-back', 'Curry en grande forme', 'Warriors 6 victoires consécutives'],
  },
  {
    id: 'prono_004',
    sport: 'football',
    league: 'Champions League',
    match: 'Real Madrid vs Manchester City',
    pick: 'Les deux équipes marquent',
    cote_ia: 1.62,
    cote_marche: 1.92,
    confidence: 79,
    value: 18.5,
    result: 'win',
    date: '2026-04-02',
    bookmakers: {
      'Bet365': { btts_yes: 1.90, btts_no: 1.95 },
      'Unibet':  { btts_yes: 1.95, btts_no: 1.90 },
      'Betclic': { btts_yes: 1.92, btts_no: 1.92 },
      'Winamax': { btts_yes: 1.91, btts_no: 1.93 },
    },
    injuries: [],
    teamStats: {
      home: { name: 'Real Madrid', form: '80%', goals: 2.8, xg: 2.5 },
      away: { name: 'Man City', form: '75%', goals: 2.6, xg: 2.4 },
    },
    factors: ['Les deux équipes scorent dans 80% de leurs matchs', 'Défenses poreuses en C1', 'Haaland vs Vinicius attendu'],
  },
  {
    id: 'prono_005',
    sport: 'rugby',
    league: 'Top 14',
    match: 'Toulouse vs Racing 92',
    pick: 'Victoire Toulouse',
    cote_ia: 1.55,
    cote_marche: 1.95,
    confidence: 82,
    value: 25.8,
    result: 'pending',
    date: '2026-04-07',
    bookmakers: {
      'Bet365': { home: 1.95, away: 1.95 },
      'Unibet':  { home: 1.95, away: 1.95 },
      'Betclic': { home: 1.97, away: 1.93 },
      'Winamax': { home: 1.93, away: 1.97 },
    },
    injuries: [
      { player: 'Nolann Le Garrec', team: 'Racing 92', type: 'Blessure genou' },
    ],
    teamStats: {
      home: { name: 'Toulouse', form: '90%', points: 28, tries: 3.2 },
      away: { name: 'Racing 92', form: '50%', points: 22, tries: 1.8 },
    },
    factors: ['Toulouse invaincu à Ernest-Wallon', 'Racing privé de demi de mêlée titulaire', 'Toulouse en tête du classement'],
  },
];

// ===================================================
// UTILITAIRES
// ===================================================

function showToast(message, type = 'success', duration = 3500) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'toast';
    toast.innerHTML = `<span class="toast-icon"></span><span class="toast-text"></span>`;
    document.body.appendChild(toast);
  }
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
  toast.className = `toast ${type}`;
  toast.querySelector('.toast-icon').textContent = icons[type] || '✅';
  toast.querySelector('.toast-text').textContent  = message;
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.classList.remove('show'), duration);
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    weekday: 'short', day: 'numeric', month: 'long'
  });
}

function calcAvgCote(bookmakers, pick = 'home') {
  const vals = Object.values(bookmakers).map(b => b[pick]).filter(v => v);
  if (!vals.length) return 0;
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
}

// ===================================================
// API CALLS (avec fallback démo)
// ===================================================

async function callAPI(endpoint, options = {}) {
  const session = await window.DB?.getSession();
  const headers = {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
  };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}

// ─── Algorithme bookmakers (port direct script utilisateur) ──────
const LEAGUE_MAP_ALGO = {
  'PL':'Premier League','ELC':'Championship','PD':'La Liga',
  'SD':'La Liga 2','BL1':'Bundesliga','BL2':'2. Bundesliga',
  'SA':'Serie A','SB':'Serie B','FL1':'Ligue 1','FL2':'Ligue 2',
};

function _cleanName(n) {
  return n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/fc|cf|as|real|stade|united|city|town|sporting|bayer|atletico|de /g,'').trim();
}

async function _runAlgoBrowser() {
  const now = new Date(), future = new Date();
  future.setDate(now.getDate() + 3);
  const dateFrom = now.toISOString().split('T')[0];
  const dateTo   = future.toISOString().split('T')[0];

  const resF = await fetch(`https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
    headers: { 'X-Auth-Token': '0bebba720a484535a0105713e0fc7d66' }
  }).catch(() => { throw new Error('football-data.org inaccessible depuis ce navigateur'); });

  const resO = await fetch('https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=402dfe4ed1b2e82526e91725d6f02438&regions=eu&markets=h2h,totals')
    .catch(() => { throw new Error('The Odds API inaccessible depuis ce navigateur'); });

  const dataF = await resF.json();
  const dataO = await resO.json();

  const picks = [];
  (dataF.matches || []).forEach(m => {
    if (!LEAGUE_MAP_ALGO[m.competition.code]) return;
    const matchOdds = dataO.find(o =>
      _cleanName(m.homeTeam.name).includes(_cleanName(o.home_team)) ||
      _cleanName(o.home_team).includes(_cleanName(m.homeTeam.name))
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
    const league   = LEAGUE_MAP_ALGO[m.competition.code];
    if (home.price >= 1.80 && probHome > 50)
      picks.push({ match: matchStr, league, date, pick: `Victoire ${m.homeTeam.name}`, pick_key: 'home', cote_marche: home.price, prob: probHome });
    if (away.price >= 1.80 && probAway > 50)
      picks.push({ match: matchStr, league, date, pick: `Victoire ${m.awayTeam.name}`, pick_key: 'away', cote_marche: away.price, prob: probAway });
    const over25 = totals?.find(x => x.name.toLowerCase() === 'over');
    if (over25 && over25.price >= 1.80) {
      const under25    = totals?.find(x => x.name.toLowerCase() === 'under');
      const overMargin = (1/over25.price) + (1/(under25?.price || 1.90));
      const probOver   = ((1/over25.price) / overMargin) * 100;
      if (probOver > 50)
        picks.push({ match: matchStr, league, date, pick: 'Plus de 2.5 buts', pick_key: 'over25', cote_marche: over25.price, prob: probOver });
    }
  });
  if (!picks.length) return null;
  const best = picks.sort((a, b) => (b.cote_marche * b.prob) - (a.cote_marche * a.prob))[0];
  return {
    ...best,
    cote_ia:    parseFloat((100 / best.prob).toFixed(2)),
    confidence: Math.min(92, Math.max(40, Math.round(best.prob * 0.85 + 8))),
    value:      parseFloat(((best.cote_marche * best.prob / 100 - 1) * 100).toFixed(1)),
  };
}

// Génère un pronostic — algo tourne dans le navigateur, backend sauvegarde
async function generatePronostic() {
  const pick = await _runAlgoBrowser();
  if (!pick) throw new Error('Aucun pick éligible trouvé sur les 3 prochains jours.');
  return callAPI('/pronos/save', { method: 'POST', body: JSON.stringify(pick) });
}

// Re-analyse avec info terrain
async function reanalyze(pronoId, info) {
  const result = await callAPI('/pronos/reanalyze', {
    method: 'POST',
    body: JSON.stringify({ pronoId, info }),
  });

  return result;
}

// Export global
window.App = {
  DEMO_LEAGUES, DEMO_PRONOSTICS,
  showToast, formatDate, calcAvgCote,
  generatePronostic, reanalyze, callAPI,
};
