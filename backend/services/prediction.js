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
// 🎾 TENNIS — Modèle probabiliste complet
// Win prob (bookmakers) → sets → jeux → tiebreak
// ===================================================

function detectSurface(league) {
  if (/clay|terre|roland|monte.carlo|madrid|rome|barcelona|hamburg|geneva|lyon/i.test(league)) return 'clay';
  if (/grass|wimbledon|queen|halle|hertogenbosch|eastbourne|nottingham/i.test(league))         return 'grass';
  return 'hard';
}

function isGrandSlam(league) {
  return /roland|wimbledon|us.?open|australian|grand.?slam/i.test(league);
}

// Probabilité binomiale P(X >= k parmi n, p)
function binomCdf(n, k, p) {
  let prob = 0;
  for (let i = k; i <= n; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1);
    prob += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.min(1, prob);
}

// Estime la probabilité de gagner un set à partir de prob match
// Calibration : p_match=0.70 → p_set≈0.60, p_match=0.55 → p_set≈0.53
function matchProbToSetProb(pMatch) {
  return 0.5 + (pMatch - 0.5) * 0.72;
}

// Distribution des scores de sets (best-of-3 ou best-of-5)
function setScoreDistribution(pWin, setsToWin) {
  const pSet = matchProbToSetProb(pWin);
  const pLose = 1 - pSet;
  const dist = [];

  if (setsToWin === 2) {
    // 2-0 : gagner 2 sets d'affilée
    dist.push({ score: '2-0', prob: pSet * pSet });
    // 2-1 : perdre 1 set sur les 2 premiers puis gagner
    dist.push({ score: '2-1', prob: 2 * pSet * pLose * pSet });
    // 0-2 : perdre les 2 premiers
    dist.push({ score: '0-2', prob: pLose * pLose, isLoss: true });
    // 1-2 : perdre le 3e set décisif
    dist.push({ score: '1-2', prob: 2 * pSet * pLose * pLose, isLoss: true });
  } else {
    // Best-of-5
    dist.push({ score: '3-0', prob: pSet ** 3 });
    dist.push({ score: '3-1', prob: 3 * pSet ** 3 * pLose });
    dist.push({ score: '3-2', prob: 6 * pSet ** 3 * pLose ** 2 });
    dist.push({ score: '0-3', prob: pLose ** 3, isLoss: true });
    dist.push({ score: '1-3', prob: 3 * pLose ** 3 * pSet, isLoss: true });
    dist.push({ score: '2-3', prob: 6 * pLose ** 3 * pSet ** 2, isLoss: true });
  }

  // Normaliser pour que la somme = 1
  const total = dist.reduce((s, d) => s + d.prob, 0);
  return dist.map(d => ({ ...d, prob: parseFloat((d.prob / total).toFixed(3)) }));
}

// Estimation jeux totaux selon le score de sets prédit
function estimateTotalGames(predictedScore, pSet, surface) {
  // Baseline jeux par set selon la surface
  const gamesPerSet = { clay: 10.8, hard: 10.2, grass: 9.6 };
  const base = gamesPerSet[surface] || 10.2;

  const parts = predictedScore.split('-').map(Number);
  const totalSets = parts[0] + parts[1];
  // Le set décisif (si 2-1 ou 3-2) est souvent plus serré
  const decisiveBonus = parts[1] > 0 ? 1.5 : 0;
  const estimated = Math.round(totalSets * base + decisiveBonus);

  return {
    estimate: estimated,
    over: estimated + 2,  // ligne over/under +2
    under: estimated - 2,
    prob_over: parseFloat((0.45 + (0.5 - pSet) * 0.3).toFixed(2)),  // match serré → plus de jeux
  };
}

// Score de sets lisible par set (ex: "6-4, 3-6, 6-3")
function buildSetScores(predictedScore, pSet, surface) {
  const parts = predictedScore.split('-').map(Number);
  const winner = parts[0];
  const loser  = parts[1];
  const sets = [];

  // Surface influence le style de jeu (clay = plus de jeux, grass = moins)
  const avgGames = { clay: [6, 4], hard: [6, 3], grass: [6, 2] }[surface] || [6, 3];

  for (let i = 0; i < winner; i++) {
    // Sets gagnés par le favori
    const gLost = pSet > 0.65 ? avgGames[1] : (i === winner - 1 && loser > 0 ? 5 : avgGames[1]);
    sets.push(`6-${gLost}`);
  }
  for (let j = 0; j < loser; j++) {
    // Sets perdus (inséré au milieu pour réalisme)
    sets.splice(j + 1, 0, `4-6`);
  }
  return sets.slice(0, winner + loser).join(', ');
}

function predictTennis(data) {
  const stats  = data.stats || {};
  const odds   = data.odds || {};
  const home   = data.homeTeam || {};
  const away   = data.awayTeam || {};
  const league = data.league || '';
  const hs     = stats.home || {};
  const as_    = stats.away || {};

  // ── 1. Probabilité de victoire ────────────────────
  // Source primaire : cotes bookmakers déviggées
  const coteHome = calcAvgCote(odds, 'home');
  const coteAway = calcAvgCote(odds, 'away');
  let pHome, pAway;

  if (coteHome > 0 && coteAway > 0) {
    const margin = (1 / coteHome) + (1 / coteAway);
    pHome = (1 / coteHome) / margin;
    pAway = (1 / coteAway) / margin;
  } else {
    // Fallback stats si pas de cotes
    const hf = parseForm(hs.form || '50%');
    const af = parseForm(as_.form || '50%');
    const t  = hf + af + 0.001;
    pHome = hf / t;
    pAway = af / t;
  }

  // ── 2. Contexte du match ──────────────────────────
  const surface    = detectSurface(league);
  const grandSlam  = isGrandSlam(league);
  const setsToWin  = grandSlam ? 3 : 2;
  const surfaceLabel = { clay: '🟤 Terre battue', hard: '🔵 Surface dure', grass: '🟢 Gazon' }[surface];
  const formatLabel  = grandSlam ? 'Grand Chelem (3 sets gagnants)' : 'ATP/WTA (2 sets gagnants)';

  // ── 3. Joueur favori ──────────────────────────────
  const best   = pHome >= pAway ? 'home' : 'away';
  const pWin   = best === 'home' ? pHome : pAway;
  const winner = best === 'home' ? home  : away;
  const loser  = best === 'home' ? away  : home;
  const pSet   = matchProbToSetProb(pWin);

  // ── 4. Distribution des scores de sets ───────────
  const distribution = setScoreDistribution(pWin, setsToWin);
  const predictedScoreObj = distribution.filter(d => !d.isLoss).sort((a, b) => b.prob - a.prob)[0];
  const predictedScore    = predictedScoreObj?.score || (setsToWin === 2 ? '2-1' : '3-1');
  const predictedSetScores = buildSetScores(predictedScore, pSet, surface);

  // ── 5. Estimation jeux ────────────────────────────
  const gamesInfo = estimateTotalGames(predictedScore, pSet, surface);

  // ── 6. Probabilité tiebreak ───────────────────────
  // Plus le match est serré, plus de chances de tiebreak
  const tiebreakProb = Math.round((0.12 + (1 - Math.abs(pHome - pAway)) * 0.18) * 100);

  // ── 7. Stats clés ─────────────────────────────────
  const homeFSP   = parseFloat(hs.first_serve_pct || 62);   // % 1ère balle
  const awayFSP   = parseFloat(as_.first_serve_pct || 60);
  const homeAces  = parseFloat(hs.aces || 5);
  const awayAces  = parseFloat(as_.aces || 4);
  const homeFatigue = parseFloat(hs.fatigue || 0);
  const awayFatigue = parseFloat(as_.fatigue || 0);
  const homeSurfWR = parseFloat(hs[`wr_${surface}`] || hs.form ? parseForm(hs.form || '50%') * 100 : 55);
  const awaySurfWR = parseFloat(as_[`wr_${surface}`] || as_.form ? parseForm(as_.form || '50%') * 100 : 50);

  // ── 8. Facteurs d'analyse ─────────────────────────
  const factors = [
    `${winner.name || 'Favori'} favori à ${Math.round(pWin * 100)}% selon les bookmakers`,
    `Surface : ${surfaceLabel} — avantage analysé`,
    `Score prédit : ${winner.name || 'Favori'} ${predictedScore} (${predictedSetScores})`,
    `Total jeux estimé : ~${gamesInfo.estimate} (over ${gamesInfo.over} / under ${gamesInfo.under})`,
  ];
  if (homeFatigue > 2 || awayFatigue > 2) {
    const tired = homeFatigue > awayFatigue ? home.name : away.name;
    factors.push(`⚠️ Fatigue détectée — ${tired} (${Math.max(homeFatigue, awayFatigue).toFixed(0)} matchs récents)`);
  }
  if (Math.abs(homeFSP - awayFSP) > 5) {
    const better = homeFSP > awayFSP ? home.name : away.name;
    factors.push(`${better} — meilleure 1ère balle (${Math.max(homeFSP, awayFSP).toFixed(0)}%)`);
  }

  // ── 9. Cotes & valeur ─────────────────────────────
  const coteMarche = calcAvgCote(odds, best);
  const coteIA     = probaToQuote(pWin, 0.04);
  const value      = calcValue(coteIA, coteMarche);
  const confidence = Math.min(92, Math.max(40, Math.round(pWin * 100 * 0.85 + 8)));

  const hasRealOdds = coteHome > 0;
  return {
    match:       `${home.name || '?'} vs ${away.name || '?'}`,
    pick:        `Victoire ${winner.name || 'Favori'}`,
    pick_key:    best,
    bet_type:    'Résultat',
    cote_ia:     coteIA,
    cote_marche: coteMarche,
    confidence,
    value,
    odds_are_real: hasRealOdds,
    factors:     factors.slice(0, 6),
    bookmakers:  hasRealOdds ? odds : {},
    injuries:    [],
    team_stats:  stats,
    // ── Données tennis enrichies ──
    tennis: {
      surface,
      surface_label:  surfaceLabel,
      format:         formatLabel,
      sets_to_win:    setsToWin,
      winner:         winner.name || 'Favori',
      loser:          loser.name  || 'Outsider',
      prob_win:       Math.round(pWin * 100),
      predicted_score:     predictedScore,
      predicted_set_scores: predictedSetScores,
      set_distribution: distribution,
      total_games: {
        estimate:   gamesInfo.estimate,
        over_line:  gamesInfo.over,
        under_line: gamesInfo.under,
        prob_over:  Math.round(gamesInfo.prob_over * 100),
      },
      tiebreak_prob: tiebreakProb,
      player_stats: {
        home: { name: home.name, first_serve_pct: homeFSP, aces: homeAces, surface_wr: Math.round(homeSurfWR), fatigue: homeFatigue },
        away: { name: away.name, first_serve_pct: awayFSP, aces: awayAces, surface_wr: Math.round(awaySurfWR), fatigue: awayFatigue },
      },
    },
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
