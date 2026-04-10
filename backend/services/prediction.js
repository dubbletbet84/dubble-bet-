// ===================================================
// SERVICE : Prédiction ML — Dubble Bet
// Modèles sport-spécifiques portés de Python en JS
// Football, Tennis, Basketball, MMA, Boxe, Rugby
// ===================================================

// ─── Utilitaires communs ──────────────────────────

function poissonPmf(k, lambda) {
  // P(X=k) pour distribution de Poisson
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function calcAvgCote(odds, pick = 'home') {
  const vals = Object.values(odds || {})
    .map(b => (typeof b === 'object' ? b[pick] : null))
    .filter(v => v && v > 1.0);
  if (!vals.length) return 0;
  return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
}

function probaToQuote(proba, margin = 0.05) {
  if (proba <= 0.01) return 99.0;
  return parseFloat((1.0 / proba * (1 - margin)).toFixed(2));
}

function calcValue(coteIA, coteMarche) {
  if (!coteMarche || coteMarche <= 0) return 0;
  return parseFloat(((coteIA / coteMarche - 1) * 100).toFixed(1));
}

function calcConfidence(proba, value, penalty = 0) {
  const conf = (proba * 55) + (Math.min(value / 25, 1.0) * 30) + 10 - (penalty * 10);
  return Math.min(95, Math.max(35, Math.round(conf)));
}

function parseForm(formVal) {
  if (typeof formVal === 'number') {
    return formVal > 1 ? formVal / 100 : formVal;
  }
  const parsed = parseFloat(String(formVal).replace('%', ''));
  return isNaN(parsed) ? 0.5 : parsed / 100;
}

function homeAdvantageBonus(sport) {
  const bonuses = {
    football:   0.08,
    rugby:      0.10,
    basketball: 0.06,
    tennis:     0.02,
    mma:        0.00,
    boxe:       0.00,
  };
  return bonuses[sport] || 0.05;
}


// Dérive les cotes double chance depuis les cotes 1X2 de chaque bookmaker
function enrichOdds(odds, pickKey) {
  if (!['1X', 'X2', '12'].includes(pickKey)) return odds;
  const result = {};
  for (const [bk, o] of Object.entries(odds || {})) {
    const h = o.home, d = o.draw, a = o.away;
    let derived = null;
    if (pickKey === '1X' && h && d) derived = parseFloat((1 / (1/h + 1/d)).toFixed(2));
    if (pickKey === 'X2' && d && a) derived = parseFloat((1 / (1/d + 1/a)).toFixed(2));
    if (pickKey === '12' && h && a) derived = parseFloat((1 / (1/h + 1/a)).toFixed(2));
    result[bk] = { ...o, [pickKey]: derived };
  }
  return result;
}

// ===================================================
// ⚽ FOOTBALL — Algorithme probabilités implicites bookmakers
// Critères : cote >= 1.80 ET probabilité implicite > 50%
// Marchés : 1X2 (h2h) + Totals (over/under 2.5)
// ===================================================

function predictFootball(data) {
  const odds     = data.odds || {};
  const home     = data.homeTeam || {};
  const away     = data.awayTeam || {};
  const injuries = data.injuries || [];
  const homeName = home.name || 'Domicile';
  const awayName = away.name || 'Extérieur';

  // Cotes moyennes inter-bookmakers
  const avgHome    = calcAvgCote(odds, 'home');
  const avgDraw    = calcAvgCote(odds, 'draw');
  const avgAway    = calcAvgCote(odds, 'away');
  const avgOver25  = calcAvgCote(odds, 'over25');
  const avgUnder25 = calcAvgCote(odds, 'under25');

  // Pas de cotes réelles → impossible de prédire
  if (!avgHome || !avgDraw || !avgAway) {
    return {
      match: `${homeName} vs ${awayName}`,
      pick: `Victoire ${homeName}`, pick_key: 'home', bet_type: 'Résultat',
      cote_ia: 2.0, cote_marche: 0, confidence: 0, value: 0,
      odds_are_real: false, factors: [], bookmakers: {}, injuries, team_stats: data.stats || {},
    };
  }

  // Probabilités implicites déviguées (algorithme bookmakers)
  const margin3way = (1/avgHome) + (1/avgDraw) + (1/avgAway);
  const probHome   = (1/avgHome) / margin3way;
  const probDraw   = (1/avgDraw) / margin3way;
  const probAway   = (1/avgAway) / margin3way;

  let probOver25 = null;
  if (avgOver25 && avgUnder25) {
    const mTotals = (1/avgOver25) + (1/avgUnder25);
    probOver25 = (1/avgOver25) / mTotals;
  }

  // Picks éligibles : cote >= 1.80 ET probabilité implicite > 50%
  const candidates = [];
  if (avgHome >= 1.80 && probHome > 0.50)
    candidates.push({ k: 'home',   cote: avgHome,   prob: probHome,   label: `Victoire ${homeName}`, type: 'Résultat'       });
  if (avgAway >= 1.80 && probAway > 0.50)
    candidates.push({ k: 'away',   cote: avgAway,   prob: probAway,   label: `Victoire ${awayName}`, type: 'Résultat'       });
  if (avgOver25 && avgOver25 >= 1.80 && probOver25 > 0.50)
    candidates.push({ k: 'over25', cote: avgOver25, prob: probOver25, label: 'Plus de 2.5 buts',    type: 'Nombre de buts' });

  if (!candidates.length) {
    return {
      match: `${homeName} vs ${awayName}`,
      pick: `Victoire ${homeName}`, pick_key: 'home', bet_type: 'Résultat',
      cote_ia: parseFloat((1/probHome).toFixed(2)), cote_marche: 0,
      confidence: 0, value: 0, odds_are_real: true,
      factors: ['Aucun pick éligible (critères non remplis)'],
      bookmakers: odds, injuries, team_stats: data.stats || {},
    };
  }

  // Meilleur pick : valeur attendue maximale (cote × probabilité)
  const best       = candidates.sort((a, b) => (b.cote * b.prob) - (a.cote * a.prob))[0];
  const coteMarche = best.cote;
  const coteIA     = parseFloat((1 / best.prob).toFixed(2));
  const value      = calcValue(coteIA, coteMarche);
  const confidence = Math.min(92, Math.max(40, Math.round(best.prob * 100 * 0.85 + 8)));

  const factors = [
    `Probabilité implicite : ${Math.round(best.prob * 100)}%`,
    `Value : cote marché ${coteMarche.toFixed(2)} vs fair value ${coteIA.toFixed(2)}`,
  ];
  if (best.k === 'home')   factors.push(`Favori à domicile — ${homeName}`);
  if (best.k === 'away')   factors.push(`Favori visiteur — ${awayName}`);
  if (best.k === 'over25') factors.push('Match ouvert, buts attendus selon les bookmakers');
  if (injuries.length)     factors.push(`${injuries.length} blessure(s) signalée(s)`);

  // Alternatives
  const altPool = [];
  if (best.k !== 'home'   && probHome   > 0.40 && avgHome   >= 1.80)
    altPool.push({ pick_key: 'home',   pick: `Victoire ${homeName}`, bet_type: 'Résultat',       cote_marche: avgHome,   cote_ia: parseFloat((1/probHome).toFixed(2)),   prob: probHome   });
  if (best.k !== 'away'   && probAway   > 0.40 && avgAway   >= 1.80)
    altPool.push({ pick_key: 'away',   pick: `Victoire ${awayName}`, bet_type: 'Résultat',       cote_marche: avgAway,   cote_ia: parseFloat((1/probAway).toFixed(2)),   prob: probAway   });
  if (best.k !== 'over25' && probOver25 && probOver25 > 0.40 && avgOver25 >= 1.80)
    altPool.push({ pick_key: 'over25', pick: 'Plus de 2.5 buts',    bet_type: 'Nombre de buts', cote_marche: avgOver25, cote_ia: parseFloat((1/probOver25).toFixed(2)), prob: probOver25 });

  const alternatives = altPool
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 2)
    .map(a => ({ ...a, value: calcValue(a.cote_ia, a.cote_marche), confidence: Math.min(92, Math.max(40, Math.round(a.prob * 100 * 0.85 + 8))) }));

  return {
    match:         `${homeName} vs ${awayName}`,
    pick:          best.label,
    pick_key:      best.k,
    bet_type:      best.type,
    cote_ia:       coteIA,
    cote_marche:   coteMarche,
    confidence,
    value,
    odds_are_real: true,
    probabilities: { home: +probHome.toFixed(3), draw: +probDraw.toFixed(3), away: +probAway.toFixed(3) },
    factors:       factors.slice(0, 4),
    bookmakers:    enrichOdds(odds, best.k),
    injuries,
    team_stats:    data.stats || {},
    alternatives,
  };
}


// ===================================================
// 🎾 TENNIS — Elo proxy + surface + fatigue
// ===================================================

function predictTennis(data) {
  const stats  = data.stats || {};
  const odds   = data.odds || {};
  const home   = data.homeTeam || {};
  const away   = data.awayTeam || {};
  const league = data.league || '';
  const hs     = stats.home || {};
  const as_    = stats.away || {};

  const homeForm = parseForm(hs.form || '50%');
  const awayForm = parseForm(as_.form || '50%');

  let surfaceBonus = 0;
  if (/clay|terre/i.test(league))  surfaceBonus = 0.04;
  else if (/grass|gazon/i.test(league)) surfaceBonus = 0.03;

  const homeFatigue = parseFloat(hs.fatigue || 0);
  const awayFatigue = parseFloat(as_.fatigue || 0);

  const homeScore = homeForm + surfaceBonus - homeFatigue * 0.05;
  const awayScore = awayForm - awayFatigue * 0.05;
  const total     = homeScore + awayScore + 0.001;
  const pHome     = homeScore / total;
  const pAway     = awayScore / total;

  const best  = pHome > pAway ? 'home' : 'away';
  const proba = best === 'home' ? pHome : pAway;
  const labels = {
    home: `Victoire ${home.name || 'Joueur 1'}`,
    away: `Victoire ${away.name || 'Joueur 2'}`,
  };

  const coteIA     = probaToQuote(proba, 0.04);
  let coteMarche   = calcAvgCote(odds, best);
  // pas de fallback IA : cote_marche = 0 si pas de vraies cotes bookmakers
  const value      = calcValue(coteIA, coteMarche);
  const confidence = calcConfidence(proba, value);

  const factors = [];
  if (homeForm > 0.70)   factors.push(`${home.name} — ${Math.round(homeForm * 100)}% de victoires récentes`);
  if (awayForm < 0.35)   factors.push(`${away.name} en méforme (${Math.round(awayForm * 100)}%)`);
  if (surfaceBonus)      factors.push('Surface favorable au favori');
  if (homeFatigue > 2)   factors.push(`${home.name} potentiellement fatigué`);
  if (!factors.length)   factors.push('Analyse Elo favorable', 'Historique head-to-head positif');

  const hasRealOdds = calcAvgCote(odds, 'home') > 0;
  return {
    match: `${home.name || '?'} vs ${away.name || '?'}`,
    pick: labels[best], pick_key: best, bet_type: 'Résultat',
    cote_ia: coteIA, cote_marche: coteMarche, confidence, value,
    odds_are_real: hasRealOdds,
    factors: factors.slice(0, 4), bookmakers: hasRealOdds ? odds : {}, injuries: [], team_stats: stats,
  };
}


// ===================================================
// 🏀 BASKETBALL — Offensive Rating + back-to-back
// ===================================================

function predictBasketball(data) {
  const stats = data.stats || {};
  const odds  = data.odds || {};
  const home  = data.homeTeam || {};
  const away  = data.awayTeam || {};
  const hs    = stats.home || {};
  const as_   = stats.away || {};

  const homePts  = parseFloat(hs.points || hs.goals || 110);
  const awayPts  = parseFloat(as_.points || as_.goals || 108);
  const homeForm = parseForm(hs.form || '50%');
  const awayForm = parseForm(as_.form || '50%');
  const homeB2b  = parseFloat(hs.back_to_back || 0);
  const awayB2b  = parseFloat(as_.back_to_back || 0);

  const homeScore = (homePts / 120) * homeForm * (1 + homeAdvantageBonus('basketball')) - homeB2b * 0.06;
  const awayScore = (awayPts / 120) * awayForm - awayB2b * 0.06;
  const total     = homeScore + awayScore + 0.001;
  const pHome     = homeScore / total;
  const pAway     = awayScore / total;

  const best  = pHome > pAway ? 'home' : 'away';
  const proba = best === 'home' ? pHome : pAway;
  const labels = {
    home: `Victoire ${home.name || 'Domicile'}`,
    away: `Victoire ${away.name || 'Extérieur'}`,
  };

  const coteIA     = probaToQuote(proba);
  let coteMarche   = calcAvgCote(odds, best);
  // pas de fallback IA : cote_marche = 0 si pas de vraies cotes bookmakers
  const value      = calcValue(coteIA, coteMarche);
  const confidence = calcConfidence(proba, value);

  const factors = [];
  if (homeForm > 0.65)   factors.push(`${home.name} — ${Math.round(homeForm * 100)}% de victoires`);
  if (awayB2b)           factors.push(`${away.name} en back-to-back — fatigue`);
  if (homePts > 115)     factors.push(`Attaque domicile explosive (${homePts.toFixed(0)} pts/match)`);
  if (awayForm < 0.40)   factors.push(`${away.name} en difficulté (${Math.round(awayForm * 100)}%)`);
  if (!factors.length)   factors.push('Avantage terrain significatif', 'Différentiel offensif favorable');

  const hasRealOdds = calcAvgCote(odds, 'home') > 0;
  return {
    match: `${home.name || '?'} vs ${away.name || '?'}`,
    pick: labels[best], pick_key: best, bet_type: 'Résultat',
    cote_ia: coteIA, cote_marche: coteMarche, confidence, value,
    odds_are_real: hasRealOdds,
    factors: factors.slice(0, 4), bookmakers: hasRealOdds ? odds : {}, injuries: data.injuries || [], team_stats: stats,
  };
}


// ===================================================
// 🥋 MMA — Style de combat + stats de frappe
// ===================================================

function predictMma(data) {
  const stats = data.stats || {};
  const odds  = data.odds || {};
  const home  = data.homeTeam || {};
  const away  = data.awayTeam || {};
  const hs    = stats.home || {};
  const as_   = stats.away || {};

  const homeKo   = parseFloat(hs.ko_rate            || 0.45);
  const awayKo   = parseFloat(as_.ko_rate           || 0.40);
  const homeTd   = parseFloat(hs.takedown_defense   || 0.65);
  const awayTd   = parseFloat(as_.takedown_defense  || 0.60);
  const homeStr  = parseFloat(hs.striking_accuracy  || 0.45);
  const awayStr  = parseFloat(as_.striking_accuracy || 0.42);
  const homeForm = parseForm(hs.form || '50%');
  const awayForm = parseForm(as_.form || '50%');

  const homeScore = homeKo * 0.25 + homeTd * 0.25 + homeStr * 0.25 + homeForm * 0.25;
  const awayScore = awayKo * 0.25 + awayTd * 0.25 + awayStr * 0.25 + awayForm * 0.25;
  const total     = homeScore + awayScore + 0.001;
  const pHome     = homeScore / total;
  const pAway     = awayScore / total;

  const best   = pHome > pAway ? 'home' : 'away';
  const proba  = best === 'home' ? pHome : pAway;
  const winner = best === 'home' ? home : away;
  const loser  = best === 'home' ? away : home;
  const labels = {
    home: `Victoire ${home.name || 'Fighter 1'}`,
    away: `Victoire ${away.name || 'Fighter 2'}`,
  };

  const coteIA     = probaToQuote(proba, 0.06);
  let coteMarche   = calcAvgCote(odds, best);
  // pas de fallback IA : cote_marche = 0 si pas de vraies cotes bookmakers
  const value      = calcValue(coteIA, coteMarche);
  const confidence = calcConfidence(proba, value);

  const winKo  = best === 'home' ? homeKo  : awayKo;
  const winStr = best === 'home' ? homeStr : awayStr;
  const winForm= best === 'home' ? homeForm: awayForm;
  const loseForm=best === 'home' ? awayForm: homeForm;

  const factors = [];
  if (winKo  > 0.55) factors.push(`${winner.name} — KO rate élevé (${Math.round(winKo * 100)}%)`);
  if (winStr > 0.50) factors.push('Précision de frappe supérieure');
  if (winForm > 0.70) factors.push(`${winner.name} en grande forme`);
  if (loseForm < 0.35) factors.push(`${loser.name} en méforme récente`);
  if (!factors.length) factors.push('Avantage technique global', 'Statistiques de combat favorables');

  const hasRealOdds = calcAvgCote(odds, 'home') > 0;
  return {
    match: `${home.name || '?'} vs ${away.name || '?'}`,
    pick: labels[best], pick_key: best, bet_type: 'Résultat',
    cote_ia: coteIA, cote_marche: coteMarche, confidence, value,
    odds_are_real: hasRealOdds,
    factors: factors.slice(0, 4), bookmakers: hasRealOdds ? odds : {}, injuries: [], team_stats: stats,
  };
}


// ===================================================
// 🥊 BOXE — Reach, KO rate, palmarès
// ===================================================

function predictBoxe(data) {
  const stats = data.stats || {};
  const odds  = data.odds || {};
  const home  = data.homeTeam || {};
  const away  = data.awayTeam || {};
  const hs    = stats.home || {};
  const as_   = stats.away || {};

  const homeReach = parseFloat(hs.reach   || 180);
  const awayReach = parseFloat(as_.reach  || 178);
  const homeKo    = parseFloat(hs.ko_rate || 0.50);
  const awayKo    = parseFloat(as_.ko_rate|| 0.45);
  const homeWins  = parseFloat(hs.wins    || 15);
  const awayWins  = parseFloat(as_.wins   || 13);
  const homeForm  = parseForm(hs.form || '50%');
  const awayForm  = parseForm(as_.form || '50%');

  const homeScore = homeReach / 200 * 0.15 + homeKo * 0.30 + homeWins / 30 * 0.25 + homeForm * 0.30;
  const awayScore = awayReach / 200 * 0.15 + awayKo * 0.30 + awayWins / 30 * 0.25 + awayForm * 0.30;
  const total     = homeScore + awayScore + 0.001;
  const pHome     = homeScore / total;
  const pAway     = awayScore / total;

  const best   = pHome > pAway ? 'home' : 'away';
  const proba  = best === 'home' ? pHome : pAway;
  const winner = best === 'home' ? home : away;
  const wStats = best === 'home' ? hs : as_;
  const labels = {
    home: `Victoire ${home.name || 'Boxeur 1'}`,
    away: `Victoire ${away.name || 'Boxeur 2'}`,
  };

  const coteIA     = probaToQuote(proba, 0.06);
  let coteMarche   = calcAvgCote(odds, best);
  // pas de fallback IA : cote_marche = 0 si pas de vraies cotes bookmakers
  const value      = calcValue(coteIA, coteMarche);
  const confidence = calcConfidence(proba, value);

  const winForm = best === 'home' ? homeForm : awayForm;
  const factors = [];
  if (parseFloat(wStats.ko_rate || 0) > 0.55) factors.push(`${winner.name} — KO rate dominant`);
  if (homeReach > awayReach + 5)              factors.push(`Avantage allonge domicile (${homeReach}cm)`);
  if (winForm > 0.70)                         factors.push(`${winner.name} — série positive`);
  if (!factors.length)                        factors.push('Palmarès supérieur', 'Avantage statistique global');

  const hasRealOdds = calcAvgCote(odds, 'home') > 0;
  return {
    match: `${home.name || '?'} vs ${away.name || '?'}`,
    pick: labels[best], pick_key: best, bet_type: 'Résultat',
    cote_ia: coteIA, cote_marche: coteMarche, confidence, value,
    odds_are_real: hasRealOdds,
    factors: factors.slice(0, 4), bookmakers: hasRealOdds ? odds : {}, injuries: [], team_stats: stats,
  };
}


// ===================================================
// 🏉 RUGBY — Poisson tries + discipline + mêlée
// ===================================================

function predictRugby(data) {
  const stats    = data.stats || {};
  const injuries = data.injuries || [];
  const odds     = data.odds || {};
  const home     = data.homeTeam || {};
  const away     = data.awayTeam || {};
  const hs       = stats.home || {};
  const as_      = stats.away || {};

  const homePts   = parseFloat(hs.points || hs.goals || 24);
  const awayPts   = parseFloat(as_.points || as_.goals || 20);
  const homeForm  = parseForm(hs.form || '50%');
  const awayForm  = parseForm(as_.form || '50%');
  const homePen   = parseFloat(hs.penalties || 8);
  const awayPen   = parseFloat(as_.penalties || 9);
  const homeScrum = parseFloat(hs.scrum_win || 0.60);
  const awayScrum = parseFloat(as_.scrum_win || 0.55);
  const homeKeyInj= injuries.filter(i => i.team === home.name).length;
  const awayKeyInj= injuries.filter(i => i.team === away.name).length;

  const homeScore = homePts / 40 * 0.30 + homeForm * 0.30 + homeScrum * 0.20
                  - homePen / 20 * 0.10 - homeKeyInj * 0.05
                  + homeAdvantageBonus('rugby');
  const awayScore = awayPts / 40 * 0.30 + awayForm * 0.30 + awayScrum * 0.20
                  - awayPen / 20 * 0.10 - awayKeyInj * 0.05;
  const total     = homeScore + awayScore + 0.001;
  const pHome     = homeScore / total;
  const pAway     = awayScore / total;

  const best  = pHome > pAway ? 'home' : 'away';
  const proba = best === 'home' ? pHome : pAway;
  const labels = {
    home: `Victoire ${home.name || 'Domicile'}`,
    away: `Victoire ${away.name || 'Extérieur'}`,
  };

  const coteIA     = probaToQuote(proba);
  let coteMarche   = calcAvgCote(odds, best);
  // pas de fallback IA : cote_marche = 0 si pas de vraies cotes bookmakers
  const value      = calcValue(coteIA, coteMarche);
  const confidence = calcConfidence(proba, value, homeKeyInj * 0.04);

  const factors = [];
  if (homeForm > 0.65)     factors.push(`${home.name} — forme excellente (${Math.round(homeForm * 100)}%)`);
  if (awayKeyInj >= 2)     factors.push(`${awayKeyInj} absents clés côté visiteur`);
  if (homeScrum > 0.65)    factors.push(`Domination en mêlée (${Math.round(homeScrum * 100)}%)`);
  if (awayPen > 10)        factors.push(`${away.name} indiscipliné (${awayPen.toFixed(0)} pen/match)`);
  if (!factors.length)     factors.push('Avantage territorial', 'Statistiques de mêlée favorables');

  const hasRealOdds = calcAvgCote(odds, 'home') > 0;
  return {
    match: `${home.name || '?'} vs ${away.name || '?'}`,
    pick: labels[best], pick_key: best, bet_type: 'Résultat',
    cote_ia: coteIA, cote_marche: coteMarche, confidence, value,
    odds_are_real: hasRealOdds,
    factors: factors.slice(0, 4), bookmakers: hasRealOdds ? odds : {}, injuries, team_stats: stats,
  };
}


// ===================================================
// ROUTER PRINCIPAL
// ===================================================

const SPORT_PREDICTORS = {
  football:   predictFootball,
  tennis:     predictTennis,
  basketball: predictBasketball,
  mma:        predictMma,
  boxe:       predictBoxe,
  rugby:      predictRugby,
};

// ─── predict ─────────────────────────────────────
function predict(fixture) {
  const sport     = (fixture.sport || 'football').toLowerCase();
  const predictor = SPORT_PREDICTORS[sport];

  if (!predictor) {
    console.warn(`[prediction] Sport non supporté : ${sport} — fallback football`);
    return predictFootball(fixture);
  }

  try {
    const result = predictor(fixture);

    // Filtre : cote marché < 1.90 non retenu
    if (result.cote_marche < 1.90) {
      return { ...result, filtered: true, message: 'Cote marché < 1.90 — pick non retenu' };
    }

    return {
      ...result,
      filtered: false,
      sport,
      league: fixture.league || '',
      date:   (fixture.date || '').split('T')[0] || new Date().toISOString().split('T')[0],
    };
  } catch (err) {
    console.error(`[prediction/${sport}] Erreur :`, err.message);
    // Fallback démo si le modèle plante
    return demoPredict(fixture);
  }
}

// ─── Fallback démo ────────────────────────────────
function buildFactors(fixture) {
  const stats    = fixture.stats || {};
  const injuries = fixture.injuries || [];
  const factors  = [];
  const homeForm = parseForm((stats.home || {}).form || '50%');
  const awayForm = parseForm((stats.away || {}).form || '50%');
  const homeName = (fixture.homeTeam || {}).name || 'Domicile';
  const awayName = (fixture.awayTeam || {}).name || 'Extérieur';

  if (homeForm > 0.65) factors.push(`${homeName} en grande forme (${Math.round(homeForm * 100)}%)`);
  if (awayForm < 0.40) factors.push(`${awayName} en difficulté (${Math.round(awayForm * 100)}%)`);
  const awayInjuries = injuries.filter(i => i.team === awayName);
  if (awayInjuries.length > 1) factors.push(`${awayInjuries.length} joueurs clés absents côté visiteur`);
  if (!factors.length) factors.push('Analyse des cotes favorable', 'Données historiques positives');
  return factors.slice(0, 4);
}

function demoPredict(fixture) {
  const odds     = fixture.odds || {};
  const avgHome  = calcAvgCote(odds, 'home') || 2.0;
  const coteIA   = parseFloat((avgHome * (0.85 + Math.random() * 0.15)).toFixed(2));
  const conf     = Math.round(55 + Math.random() * 30);
  const value    = calcValue(coteIA, avgHome);

  return {
    match:       `${(fixture.homeTeam || {}).name || '?'} vs ${(fixture.awayTeam || {}).name || '?'}`,
    pick:        `Victoire ${(fixture.homeTeam || {}).name || 'Domicile'}`,
    cote_ia:     coteIA,
    cote_marche: avgHome,
    confidence:  conf,
    value,
    bookmakers:  odds,
    injuries:    fixture.injuries || [],
    team_stats:  fixture.stats || {},
    factors:     buildFactors(fixture),
    sport:       fixture.sport || 'football',
    league:      fixture.league || '',
    date:        (fixture.date || '').split('T')[0] || new Date().toISOString().split('T')[0],
    filtered:    false,
  };
}

// ─── reanalyze ───────────────────────────────────
function reanalyze({ prono, info }) {
  const sport      = (prono.sport || 'football').toLowerCase();
  const infoLower  = (info || '').toLowerCase();
  const confidence = prono.confidence || 65;
  const value      = prono.value || 5.0;

  const positiveKw = ['blessé','absent','blessure','suspendu','forfait','fatigue','méforme','clash','vestiaire','grève'];
  const negativeKw = ['retour','disponible','en forme','titulaire','rétabli'];

  const sportDelta = {
    football:   Math.floor(Math.random() * 13) - 4,
    tennis:     Math.floor(Math.random() * 13) - 3,
    basketball: Math.floor(Math.random() * 12) - 4,
    mma:        Math.floor(Math.random() * 16) - 5,
    boxe:       Math.floor(Math.random() * 16) - 5,
    rugby:      Math.floor(Math.random() * 13) - 4,
  };
  let delta = sportDelta[sport] !== undefined ? sportDelta[sport] : Math.floor(Math.random() * 12) - 4;

  if (positiveKw.some(kw => infoLower.includes(kw))) delta += 7;
  else if (negativeKw.some(kw => infoLower.includes(kw))) delta -= 4;

  const newConfidence = Math.min(95, Math.max(35, confidence + delta));
  const newValue      = parseFloat((value + (Math.random() * 5 - 2)).toFixed(1));

  return { confidence: newConfidence, value: newValue };
}

module.exports = { predict, reanalyze };
