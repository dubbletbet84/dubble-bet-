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

// Génère un pronostic (appel backend ou données démo)
async function generatePronostic({ sport, league, date, info = '' }) {
  const result = await callAPI('/pronos/generate', {
    method: 'POST',
    body: JSON.stringify({ sport, league, date, info }),
  });

  // Pas de match → lancer une erreur claire avec les alternatives
  if (result.no_match) {
    const alts = (result.available_leagues || []).join(', ');
    const msg  = `Pas de match ${result.requested_league} à la date sélectionnée.`
               + (alts ? ` Compétitions disponibles : ${alts}.` : ' Aucune autre compétition disponible ce jour.');
    const err  = new Error(msg);
    err.no_match           = true;
    err.available_leagues  = result.available_leagues || [];
    err.requested_league   = result.requested_league;
    err.date               = result.date;
    throw err;
  }
  return result;
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
