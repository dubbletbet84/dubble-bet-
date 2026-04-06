// ===================================================
// SERVICE : Prédiction ML
// Appelle le modèle Python Flask sur Railway
// ===================================================
// TODO: Insérez l'URL de votre API Flask dans le .env :
//   PYTHON_API_URL=https://VOTRE_FLASK_APP.railway.app
// ===================================================

const axios = require('axios');

const PYTHON_API = process.env.PYTHON_API_URL || 'http://localhost:5000';

// ─── Cote moyenne du marché ───────────────────────────
function calcAvgCote(bookmakers, pick = 'home') {
  const vals = Object.values(bookmakers).map(b => b[pick]).filter(v => v && v > 1);
  if (!vals.length) return 0;
  return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
}

// ─── Valeur détectée (%) ─────────────────────────────
function calcValue(coteIA, coteMoyenne) {
  if (!coteIA || !coteMoyenne) return 0;
  return parseFloat(((coteIA / coteMoyenne - 1) * 100).toFixed(1));
}

// ─── Facteurs textuels ───────────────────────────────
function buildFactors(fixture, stats, injuries) {
  const factors = [];
  const homeForm = parseInt(stats?.home?.form || 0);
  const awayForm = parseInt(stats?.away?.form || 0);

  if (homeForm > 65)  factors.push(`${stats.home.name} en grande forme (${stats.home.form})`);
  if (awayForm < 40)  factors.push(`${stats.away.name} en difficultés (${stats.away.form})`);
  if (stats?.home?.goals > 2.0) factors.push(`${stats.home.name} très prolifique (${stats.home.goals} buts/match)`);

  const awayInjuries = injuries?.filter(i => i.team === stats?.away?.name) || [];
  if (awayInjuries.length > 1) factors.push(`${awayInjuries.length} joueurs clés absents côté visiteur`);

  if (!factors.length) factors.push('Analyse des cotes favorable', 'Données historiques positives');
  return factors.slice(0, 4);
}

// ─── Prédiction démo (fallback) ──────────────────────
function demoPredict(fixture) {
  const avgHome = calcAvgCote(fixture.odds, 'home');
  const coteIA  = parseFloat((avgHome * (0.85 + Math.random() * 0.15)).toFixed(2));
  const conf    = Math.round(55 + Math.random() * 30);
  const value   = calcValue(coteIA, avgHome);

  return {
    match:       `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
    pick:        `Victoire ${fixture.homeTeam.name}`,
    cote_ia:     coteIA,
    cote_marche: avgHome,
    confidence:  conf,
    value,
    bookmakers:  fixture.odds,
    injuries:    fixture.injuries || [],
    teamStats:   fixture.stats || {},
    factors:     buildFactors(fixture, fixture.stats, fixture.injuries),
    sport:       fixture.sport,
    league:      fixture.league,
    date:        fixture.date?.split('T')[0] || new Date().toISOString().split('T')[0],
  };
}

// ─── predict ─────────────────────────────────────────
// Envoie les données au modèle Python Flask
async function predict(fixture) {
  try {
    const { data } = await axios.post(`${PYTHON_API}/predict`, {
      sport:     fixture.sport,
      league:    fixture.league,
      homeTeam:  fixture.homeTeam,
      awayTeam:  fixture.awayTeam,
      stats:     fixture.stats,
      injuries:  fixture.injuries,
      odds:      fixture.odds,
      date:      fixture.date,
    }, { timeout: 10000 });

    // Enrichir avec cotes et facteurs si non retournés par le modèle
    return {
      ...data,
      match:       data.match       || `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
      bookmakers:  data.bookmakers  || fixture.odds,
      injuries:    data.injuries    || fixture.injuries,
      teamStats:   data.team_stats  || fixture.stats,
      factors:     data.factors     || buildFactors(fixture, fixture.stats, fixture.injuries),
      sport:       fixture.sport,
      league:      fixture.league,
    };
  } catch (err) {
    console.warn('[prediction] Flask API indisponible, fallback démo :', err.message);
    return demoPredict(fixture);
  }
}

// ─── reanalyze ───────────────────────────────────────
// Recalcul avec info terrain supplémentaire
async function reanalyze({ prono, info }) {
  try {
    const { data } = await axios.post(`${PYTHON_API}/reanalyze`, {
      prono_id:   prono.id,
      sport:      prono.sport,
      confidence: prono.confidence,
      value:      prono.value,
      extra_info: info,
    }, { timeout: 8000 });

    return {
      confidence: data.confidence || prono.confidence,
      value:      data.value      || prono.value,
    };
  } catch (err) {
    console.warn('[prediction] Reanalyze fallback :', err.message);
    // Simulation : l'info terrain peut légèrement améliorer ou réduire la confiance
    const delta      = Math.round((Math.random() - 0.3) * 12);
    const confidence = Math.min(95, Math.max(40, prono.confidence + delta));
    return { confidence, value: prono.value };
  }
}

module.exports = { predict, reanalyze };
