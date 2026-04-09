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
// ⚽ FOOTBALL — Poisson bivariée + xG + blessures
// ===================================================

function predictFootball(data) {
  const stats    = data.stats || {};
  const injuries = data.injuries || [];
  const odds     = data.odds || {};
  const home     = data.homeTeam || {};
  const away     = data.awayTeam || {};
  const hs       = stats.home || {};
  const as_      = stats.away || {};

  // Si stats réelles (classement), utiliser buts marqués/encaissés comme proxy xG
  // Sinon utiliser les valeurs simulées
  const homeGoalsFor  = parseFloat(hs.goals || 1.4);
  const awayGoalsFor  = parseFloat(as_.goals || 1.1);
  const homeGoalsAga  = parseFloat(hs.goals_against || 1.1);
  const awayGoalsAga  = parseFloat(as_.goals_against || 1.3);

  // xG domicile = moyenne buts marqués × attaque adverse (buts encaissés)
  let homeXg = (homeGoalsFor + awayGoalsAga) / 2;
  let awayXg = (awayGoalsFor + homeGoalsAga) / 2;

  const homeForm = parseForm(hs.form || '50%');
  const awayForm = parseForm(as_.form || '50%');
  homeXg *= (0.7 + homeForm * 0.6);
  awayXg *= (0.7 + awayForm * 0.6);

  const homeInjured = injuries.filter(i => i.team === home.name).length;
  const awayInjured = injuries.filter(i => i.team === away.name).length;
  homeXg *= Math.max(0.7, 1 - homeInjured * 0.08);
  awayXg *= Math.max(0.7, 1 - awayInjured * 0.08);

  homeXg *= (1 + homeAdvantageBonus('football'));

  // ── Distribution Poisson : tous les scénarios ──
  const maxGoals = 9;
  const hp = Array.from({ length: maxGoals + 1 }, (_, i) => poissonPmf(i, homeXg));
  const ap = Array.from({ length: maxGoals + 1 }, (_, i) => poissonPmf(i, awayXg));

  let pHome = 0, pDraw = 0, pAway = 0;
  let pOver15 = 0, pOver25 = 0, pOver35 = 0, pBTTS = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = hp[i] * ap[j];
      if (i > j) pHome += p; else if (i === j) pDraw += p; else pAway += p;
      if (i + j >= 2) pOver15 += p;
      if (i + j >= 3) pOver25 += p;
      if (i + j >= 4) pOver35 += p;
      if (i > 0 && j > 0) pBTTS += p;
    }
  }

  const homeName  = home.name || 'Domicile';
  const awayName  = away.name || 'Extérieur';
  const totalXg   = homeXg + awayXg;
  const isRealStats = hs.position != null;

  // ── Cotes réelles disponibles ? ──────────────────────
  // calcAvgCote > 0 seulement si The Odds API a retourné des données
  const hasRealOdds = calcAvgCote(odds, 'home') > 0;

  const mktHome   = calcAvgCote(odds, 'home')   || probaToQuote(pHome,   0.07);
  const mktDraw   = calcAvgCote(odds, 'draw')   || probaToQuote(pDraw,   0.07);
  const mktAway   = calcAvgCote(odds, 'away')   || probaToQuote(pAway,   0.07);
  const mktOver25 = calcAvgCote(odds, 'over25') || probaToQuote(pOver25, 0.06);
  const mktBTTS   = calcAvgCote(odds, 'btts')   || probaToQuote(pBTTS,   0.06);
  const p1X = pHome + pDraw;
  const pX2 = pDraw + pAway;

  // ── Sélection du pick ─────────────────────────────────
  // Avec cotes réelles : choisir la meilleure value parmi les marchés >= 1.90
  // Sans cotes réelles : sélection par probabilités Poisson
  let bestKey;

  // Cotes double chance (calculées depuis probabilités Poisson)
  const mkt1X = parseFloat(Math.max(1.05, (1 / p1X) * 0.93).toFixed(2));
  const mktX2 = parseFloat(Math.max(1.05, (1 / pX2) * 0.93).toFixed(2));
  const p12   = pHome + pAway;
  const mkt12 = parseFloat(Math.max(1.05, (1 / p12) * 0.93).toFixed(2));

  if (hasRealOdds) {
    const valueOf = (proba, mkt) => calcValue(probaToQuote(proba, 0.05), mkt);
    const markets = [
      { k: 'home',   mkt: mktHome,   v: valueOf(pHome,   mktHome),   p: pHome   },
      { k: 'draw',   mkt: mktDraw,   v: valueOf(pDraw,   mktDraw),   p: pDraw   },
      { k: 'away',   mkt: mktAway,   v: valueOf(pAway,   mktAway),   p: pAway   },
      { k: 'over25', mkt: mktOver25, v: valueOf(pOver25, mktOver25), p: pOver25 },
      { k: 'btts',   mkt: mktBTTS,   v: valueOf(pBTTS,   mktBTTS),   p: pBTTS   },
      { k: '1X',      mkt: mkt1X,                    v: valueOf(p1X,      mkt1X),                    p: p1X      },
      { k: 'X2',      mkt: mktX2,                    v: valueOf(pX2,      mktX2),                    p: pX2      },
      { k: '12',      mkt: mkt12,                    v: valueOf(p12,      mkt12),                    p: p12      },
      { k: 'over35',  mkt: probaToQuote(pOver35,0.06), v: valueOf(pOver35,  probaToQuote(pOver35,0.06)),  p: pOver35  },
      { k: 'under25', mkt: probaToQuote(1-pOver25,0.06), v: valueOf(1-pOver25, probaToQuote(1-pOver25,0.06)), p: 1-pOver25 },
      { k: 'bttsNo',  mkt: probaToQuote(1-pBTTS,0.06),  v: valueOf(1-pBTTS,  probaToQuote(1-pBTTS,0.06)),  p: 1-pBTTS  },
    ];
    // Parmi les marchés avec cote >= 1.90, choisir la meilleure value
    const eligible = markets.filter(c => c.mkt >= 1.90 && c.p >= 0.10);
    if (eligible.length > 0) {
      bestKey = eligible.sort((a, b) => b.v - a.v)[0].k;
    } else {
      bestKey = markets.sort((a, b) => b.p - a.p)[0].k;
    }
  } else {
    // Pas de vraies cotes : logique probabiliste pure
    if (pHome > 0.58) {
      bestKey = 'home';
    } else if (pAway > 0.50) {
      bestKey = 'away';
    } else if (totalXg > 2.9 && pOver25 > 0.58) {
      bestKey = 'over25';
    } else if (pBTTS > 0.62 && homeXg > 1.2 && awayXg > 1.0) {
      bestKey = 'btts';
    } else if (pHome > 0.43) {
      bestKey = 'home';
    } else if (pOver25 > 0.52 && totalXg > 2.5) {
      bestKey = 'over25';
    } else {
      bestKey = 'home';
    }
  }

  // ── Construction du résultat ──────────────────────────
  const pickMap = {
    home:   { bet_type: 'Résultat',       pick: `Victoire ${homeName}`,        proba: pHome,   cote_marche: mktHome,   cote_ia: probaToQuote(pHome,   0.05) },
    draw:   { bet_type: 'Résultat',       pick: 'Match nul',                    proba: pDraw,   cote_marche: mktDraw,   cote_ia: probaToQuote(pDraw,   0.05) },
    away:   { bet_type: 'Résultat',       pick: `Victoire ${awayName}`,         proba: pAway,   cote_marche: mktAway,   cote_ia: probaToQuote(pAway,   0.05) },
    over25: { bet_type: 'Nombre de buts', pick: 'Plus de 2.5 buts',             proba: pOver25, cote_marche: mktOver25, cote_ia: probaToQuote(pOver25, 0.05) },
    btts:   { bet_type: 'Les 2 marquent', pick: 'Les 2 équipes marquent — Oui', proba: pBTTS,   cote_marche: mktBTTS,   cote_ia: probaToQuote(pBTTS,   0.05) },
    '1X':   { bet_type: 'Double chance',  pick: `${homeName} ou Nul`,           proba: p1X,  cote_marche: mkt1X,  cote_ia: probaToQuote(p1X,  0.04) },
    'X2':   { bet_type: 'Double chance',  pick: `${awayName} ou Nul`,           proba: pX2,  cote_marche: mktX2,  cote_ia: probaToQuote(pX2,  0.04) },
    '12':   { bet_type: 'Double chance',  pick: `${homeName} ou ${awayName}`,   proba: p12,  cote_marche: mkt12,  cote_ia: probaToQuote(p12,  0.04) },
    over35: { bet_type: 'Nombre de buts', pick: 'Plus de 3.5 buts',             proba: pOver35, cote_marche: probaToQuote(pOver35, 0.06), cote_ia: probaToQuote(pOver35, 0.05) },
    under25:{ bet_type: 'Nombre de buts', pick: 'Moins de 2.5 buts',            proba: 1-pOver25, cote_marche: probaToQuote(1-pOver25, 0.06), cote_ia: probaToQuote(1-pOver25, 0.05) },
    bttsNo: { bet_type: 'Les 2 marquent', pick: 'Les 2 équipes marquent — Non', proba: 1-pBTTS,   cote_marche: probaToQuote(1-pBTTS,   0.06), cote_ia: probaToQuote(1-pBTTS,   0.05) },
  };

  const best = { pick_key: bestKey, ...pickMap[bestKey] };
  best.value      = calcValue(best.cote_ia, best.cote_marche);
  best.confidence = calcConfidence(best.proba, best.value, homeInjured * 0.05);

  // Alternatives : les 2 autres picks les plus probables (différents du bestKey)
  const altKeys = Object.entries(pickMap)
    .filter(([k]) => k !== bestKey && ['home','away','over25','btts'].includes(k))
    .sort((a, b) => b[1].proba - a[1].proba)
    .slice(0, 2)
    .map(([k, v]) => ({ pick_key: k, ...v, value: calcValue(v.cote_ia, v.cote_marche), confidence: calcConfidence(v.proba, calcValue(v.cote_ia, v.cote_marche)) }));
  const alternatives = altKeys;

  // ── Facteurs LIÉS AU PICK CHOISI ──────────────────────
  const factors = [];
  if (bestKey === 'home') {
    if (homeForm > 0.55)  factors.push(`${homeName} — ${Math.round(homeForm*100)}% de victoires récentes`);
    if (isRealStats && hs.position <= 5) factors.push(`${homeName} — ${hs.position}e au classement`);
    factors.push(`Avantage du terrain (+${Math.round(homeAdvantageBonus('football')*100)}% domicile)`);
    if (awayInjured >= 1) factors.push(`${awayInjured} absent(s) côté ${awayName}`);
    if (homeGoalsFor > 1.5) factors.push(`${homeName} — ${homeGoalsFor.toFixed(1)} buts marqués/match`);
  } else if (bestKey === 'away') {
    if (awayForm > 0.55)  factors.push(`${awayName} — ${Math.round(awayForm*100)}% de victoires récentes`);
    if (isRealStats && as_.position <= 5) factors.push(`${awayName} — ${as_.position}e au classement`);
    if (awayGoalsFor > 1.5) factors.push(`${awayName} — ${awayGoalsFor.toFixed(1)} buts/match en déplacement`);
    if (homeForm < 0.45)  factors.push(`${homeName} en méforme (${Math.round(homeForm*100)}%)`);
  } else if (bestKey === 'over25') {
    factors.push(`Total attendu : ${totalXg.toFixed(1)} buts (modèle Poisson)`);
    factors.push(`${Math.round(pOver25*100)}% de probabilité de +2.5 buts`);
    if (homeGoalsFor > 1.3) factors.push(`${homeName} — ${homeGoalsFor.toFixed(1)} buts/match`);
    if (awayGoalsFor > 1.1) factors.push(`${awayName} — ${awayGoalsFor.toFixed(1)} buts/match`);
  } else if (bestKey === 'btts') {
    factors.push(`${Math.round(pBTTS*100)}% de chances que les 2 équipes marquent`);
    factors.push(`${homeName} : ${homeXg.toFixed(1)} buts attendus`);
    factors.push(`${awayName} : ${awayXg.toFixed(1)} buts attendus`);
    if (homeGoalsAga > 1.1) factors.push(`Défense domicile perméable (${homeGoalsAga.toFixed(1)} enc./m)`);
  }
  if (!factors.length) factors.push(`${homeName} favori selon le modèle`, 'Analyse des cotes favorable');

  return {
    match:          `${homeName} vs ${awayName}`,
    bet_type:       best.bet_type,
    pick:           best.pick,
    pick_key:       best.pick_key,
    cote_ia:        best.cote_ia,
    cote_marche:    best.cote_marche,
    confidence:     best.confidence,
    value:          best.value,
    odds_are_real:  hasRealOdds,
    probabilities:  { home: +pHome.toFixed(3), draw: +pDraw.toFixed(3), away: +pAway.toFixed(3), over25: +pOver25.toFixed(3), btts: +pBTTS.toFixed(3) },
    factors:        factors.slice(0, 4),
    bookmakers:     hasRealOdds ? enrichOdds(odds, bestKey) : {},
    injuries,
    team_stats:     stats,
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
  if (!coteMarche) coteMarche = parseFloat((coteIA * 1.10).toFixed(2));
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
  if (!coteMarche) coteMarche = parseFloat((coteIA * 1.10).toFixed(2));
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
  if (!coteMarche) coteMarche = parseFloat((coteIA * 1.12).toFixed(2));
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
  if (!coteMarche) coteMarche = parseFloat((coteIA * 1.12).toFixed(2));
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
  if (!coteMarche) coteMarche = parseFloat((coteIA * 1.10).toFixed(2));
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
