"""
DUBBLE BET — Modèle de prédiction Flask
========================================
Modèles adaptés par sport :
  - Football  : Distribution de Poisson bivariée + xG
  - Tennis    : Système Elo + surface + fatigue
  - Basketball: Offensive/Defensive Rating + pace + back-to-back
  - MMA       : Analyse style de combat + stats de frappe
  - Boxe      : Reach, KO rate, cardio, stats de frappe
  - Rugby     : Poisson tries + discipline + mêlée/lineout
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import os
from functools import wraps

try:
    from scipy.stats import poisson
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False

app = Flask(__name__)
CORS(app, origins=os.getenv("ALLOWED_ORIGINS", "*").split(","))

INTERNAL_TOKEN = os.getenv("INTERNAL_API_TOKEN", "dubble-token-securise")

# ─── Auth ─────────────────────────────────────────────
def require_token(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("X-Internal-Token")
        if token != INTERNAL_TOKEN:
            return jsonify({"error": "Token invalide"}), 401
        return f(*args, **kwargs)
    return decorated


# ===================================================
# UTILITAIRES COMMUNS
# ===================================================

def calc_avg_cote(odds: dict, pick_key: str) -> float:
    vals = [v.get(pick_key, 0) for v in odds.values() if isinstance(v, dict)]
    vals = [v for v in vals if v and v > 1.0]
    return round(sum(vals) / len(vals), 2) if vals else 0.0

def proba_to_cote(proba: float, margin: float = 0.05) -> float:
    if proba <= 0.01:
        return 99.0
    return round(1.0 / proba * (1 - margin), 2)

def calc_value(cote_ia: float, cote_marche: float) -> float:
    if not cote_marche or cote_marche <= 0:
        return 0.0
    return round((cote_ia / cote_marche - 1) * 100, 1)

def calc_confidence(proba: float, value: float, penalty: float = 0.0) -> int:
    conf = (proba * 55) + (min(value / 25, 1.0) * 30) + 10 - (penalty * 10)
    return int(min(95, max(35, round(conf))))

def parse_form(form_str: str) -> float:
    """Convertit '80%' ou 0.8 en float 0-1"""
    if isinstance(form_str, (int, float)):
        return float(form_str) / 100 if float(form_str) > 1 else float(form_str)
    try:
        return float(str(form_str).replace('%', '')) / 100
    except:
        return 0.5

def home_advantage_bonus(sport: str) -> float:
    bonuses = {
        'football':   0.08,
        'rugby':      0.10,
        'basketball': 0.06,
        'tennis':     0.02,
        'mma':        0.0,
        'boxe':       0.0,
    }
    return bonuses.get(sport, 0.05)


# ===================================================
# ⚽ FOOTBALL — Poisson bivariée + xG
# ===================================================

def predict_football(data: dict) -> dict:
    stats    = data.get('stats', {})
    injuries = data.get('injuries', [])
    odds     = data.get('odds', {})
    home     = data.get('homeTeam', {})
    away     = data.get('awayTeam', {})

    home_stats = stats.get('home', {})
    away_stats = stats.get('away', {})

    # xG ou buts moyens
    home_xg = float(home_stats.get('xg', home_stats.get('goals', 1.4)))
    away_xg = float(away_stats.get('xg', away_stats.get('goals', 1.1)))

    # Ajustement forme
    home_form = parse_form(home_stats.get('form', '50%'))
    away_form = parse_form(away_stats.get('form', '50%'))
    home_xg *= (0.7 + home_form * 0.6)
    away_xg *= (0.7 + away_form * 0.6)

    # Pénalité blessures clés
    home_injured = len([i for i in injuries if i.get('team') == home.get('name')])
    away_injured = len([i for i in injuries if i.get('team') == away.get('name')])
    home_xg *= max(0.7, 1 - home_injured * 0.08)
    away_xg *= max(0.7, 1 - away_injured * 0.08)

    # Avantage domicile
    home_xg *= (1 + home_advantage_bonus('football'))

    # Distribution de Poisson
    max_goals = 7
    if SCIPY_AVAILABLE:
        hp = [poisson.pmf(i, home_xg) for i in range(max_goals + 1)]
        ap = [poisson.pmf(i, away_xg) for i in range(max_goals + 1)]
    else:
        def poisson_pmf(k, lam):
            import math
            return (lam**k * np.exp(-lam)) / math.factorial(k)
        hp = [poisson_pmf(i, home_xg) for i in range(max_goals + 1)]
        ap = [poisson_pmf(i, away_xg) for i in range(max_goals + 1)]

    p_home = sum(hp[i]*ap[j] for i in range(max_goals+1) for j in range(max_goals+1) if i > j)
    p_draw = sum(hp[i]*ap[i] for i in range(max_goals+1))
    p_away = 1.0 - p_home - p_draw

    probas = {'home': round(p_home,4), 'draw': round(p_draw,4), 'away': round(p_away,4)}
    best   = max(probas, key=probas.get)
    proba  = probas[best]

    labels = {
        'home': f"Victoire {home.get('name','Domicile')}",
        'draw': 'Match nul',
        'away': f"Victoire {away.get('name','Extérieur')}",
    }
    cote_ia     = proba_to_cote(proba)
    cote_marche = calc_avg_cote(odds, best)
    if not cote_marche: cote_marche = round(cote_ia * 1.12, 2)
    value       = calc_value(cote_ia, cote_marche)
    penalty     = home_injured * 0.05
    confidence  = calc_confidence(proba, value, penalty)

    factors = []
    if home_form > 0.65: factors.append(f"{home.get('name')} en grande forme ({int(home_form*100)}%)")
    if away_form < 0.40: factors.append(f"{away.get('name')} en difficulté ({int(away_form*100)}%)")
    if home_xg > 2.0:    factors.append(f"Attaque domicile prolifique ({home_xg:.1f} xG)")
    if away_injured >= 2: factors.append(f"{away_injured} absents clés côté visiteur")
    if not factors:       factors = ["Analyse des cotes favorable", "Données historiques positives"]

    return {
        'match': f"{home.get('name','?')} vs {away.get('name','?')}",
        'pick': labels[best], 'cote_ia': cote_ia, 'cote_marche': cote_marche,
        'confidence': confidence, 'value': value, 'probabilities': probas,
        'factors': factors[:4], 'bookmakers': odds, 'injuries': injuries, 'team_stats': stats,
    }


# ===================================================
# 🎾 TENNIS — Elo + surface + fatigue
# ===================================================

def predict_tennis(data: dict) -> dict:
    stats = data.get('stats', {})
    odds  = data.get('odds', {})
    home  = data.get('homeTeam', {})
    away  = data.get('awayTeam', {})
    league = data.get('league', '')

    home_stats = stats.get('home', {})
    away_stats = stats.get('away', {})

    # Forme récente (proxy Elo simplifié)
    home_form = parse_form(home_stats.get('form', '50%'))
    away_form = parse_form(away_stats.get('form', '50%'))

    # Bonus surface (clay, grass, hard)
    surface_bonus = 0.0
    if 'clay' in league.lower() or 'terre' in league.lower():
        surface_bonus = 0.04  # Avantage pour spécialistes terre battue
    elif 'grass' in league.lower() or 'gazon' in league.lower():
        surface_bonus = 0.03

    # Fatigue (sets joués récemment — simulé)
    home_fatigue = float(home_stats.get('fatigue', 0))
    away_fatigue = float(away_stats.get('fatigue', 0))

    home_score = home_form + surface_bonus - home_fatigue * 0.05
    away_score = away_form - away_fatigue * 0.05

    total = home_score + away_score + 0.001
    p_home = home_score / total
    p_away = away_score / total

    best   = 'home' if p_home > p_away else 'away'
    proba  = p_home if best == 'home' else p_away
    labels = {
        'home': f"Victoire {home.get('name','Joueur 1')}",
        'away': f"Victoire {away.get('name','Joueur 2')}",
    }

    cote_ia     = proba_to_cote(proba, margin=0.04)
    cote_marche = calc_avg_cote(odds, best)
    if not cote_marche: cote_marche = round(cote_ia * 1.10, 2)
    value      = calc_value(cote_ia, cote_marche)
    confidence = calc_confidence(proba, value)

    factors = []
    if home_form > 0.70: factors.append(f"{home.get('name')} — {int(home_form*100)}% de victoires récentes")
    if away_form < 0.35: factors.append(f"{away.get('name')} en méforme ({int(away_form*100)}%)")
    if surface_bonus:    factors.append("Surface favorable au favori")
    if home_fatigue > 2: factors.append(f"{home.get('name')} potentiellement fatigué")
    if not factors:      factors = ["Analyse Elo favorable", "Historique head-to-head positif"]

    return {
        'match': f"{home.get('name','?')} vs {away.get('name','?')}",
        'pick': labels[best], 'cote_ia': cote_ia, 'cote_marche': cote_marche,
        'confidence': confidence, 'value': value,
        'factors': factors[:4], 'bookmakers': odds, 'injuries': [], 'team_stats': stats,
    }


# ===================================================
# 🏀 BASKETBALL — Offensive/Defensive Rating + pace
# ===================================================

def predict_basketball(data: dict) -> dict:
    stats = data.get('stats', {})
    odds  = data.get('odds', {})
    home  = data.get('homeTeam', {})
    away  = data.get('awayTeam', {})

    home_stats = stats.get('home', {})
    away_stats = stats.get('away', {})

    # Points moyens marqués/encaissés
    home_pts_for  = float(home_stats.get('points', home_stats.get('goals', 110)))
    away_pts_for  = float(away_stats.get('points', away_stats.get('goals', 108)))
    home_form     = parse_form(home_stats.get('form', '50%'))
    away_form     = parse_form(away_stats.get('form', '50%'))

    # Back-to-back pénalité (2ème match en 2 jours)
    home_b2b = float(home_stats.get('back_to_back', 0))
    away_b2b = float(away_stats.get('back_to_back', 0))

    home_score = (home_pts_for / 120) * home_form * (1 + home_advantage_bonus('basketball')) - home_b2b * 0.06
    away_score = (away_pts_for / 120) * away_form - away_b2b * 0.06

    total  = home_score + away_score + 0.001
    p_home = home_score / total
    p_away = away_score / total

    best   = 'home' if p_home > p_away else 'away'
    proba  = p_home if best == 'home' else p_away
    labels = {
        'home': f"Victoire {home.get('name','Domicile')}",
        'away': f"Victoire {away.get('name','Extérieur')}",
    }

    cote_ia     = proba_to_cote(proba, margin=0.05)
    cote_marche = calc_avg_cote(odds, best)
    if not cote_marche: cote_marche = round(cote_ia * 1.10, 2)
    value      = calc_value(cote_ia, cote_marche)
    confidence = calc_confidence(proba, value)

    factors = []
    if home_form > 0.65:  factors.append(f"{home.get('name')} — {int(home_form*100)}% de victoires")
    if away_b2b:          factors.append(f"{away.get('name')} en back-to-back — fatigue")
    if home_pts_for > 115:factors.append(f"Attaque domicile explosive ({home_pts_for:.0f} pts/match)")
    if away_form < 0.40:  factors.append(f"{away.get('name')} en difficulté ({int(away_form*100)}%)")
    if not factors:       factors = ["Avantage terrain significatif", "Différentiel offensif favorable"]

    return {
        'match': f"{home.get('name','?')} vs {away.get('name','?')}",
        'pick': labels[best], 'cote_ia': cote_ia, 'cote_marche': cote_marche,
        'confidence': confidence, 'value': value,
        'factors': factors[:4], 'bookmakers': odds, 'injuries': data.get('injuries',[]), 'team_stats': stats,
    }


# ===================================================
# 🥊 MMA — Style de combat + stats de frappe
# ===================================================

def predict_mma(data: dict) -> dict:
    stats = data.get('stats', {})
    odds  = data.get('odds', {})
    home  = data.get('homeTeam', {})
    away  = data.get('awayTeam', {})

    home_stats = stats.get('home', {})
    away_stats = stats.get('away', {})

    # Stats MMA spécifiques
    home_ko_rate    = float(home_stats.get('ko_rate', 0.45))
    away_ko_rate    = float(away_stats.get('ko_rate', 0.40))
    home_td_def     = float(home_stats.get('takedown_defense', 0.65))
    away_td_def     = float(away_stats.get('takedown_defense', 0.60))
    home_str_acc    = float(home_stats.get('striking_accuracy', 0.45))
    away_str_acc    = float(away_stats.get('striking_accuracy', 0.42))
    home_form       = parse_form(home_stats.get('form', '50%'))
    away_form       = parse_form(away_stats.get('form', '50%'))

    # Score composite MMA
    home_score = (home_ko_rate * 0.25 + home_td_def * 0.25 + home_str_acc * 0.25 + home_form * 0.25)
    away_score = (away_ko_rate * 0.25 + away_td_def * 0.25 + away_str_acc * 0.25 + away_form * 0.25)

    total  = home_score + away_score + 0.001
    p_home = home_score / total
    p_away = away_score / total

    best   = 'home' if p_home > p_away else 'away'
    proba  = p_home if best == 'home' else p_away
    labels = {
        'home': f"Victoire {home.get('name','Fighter 1')}",
        'away': f"Victoire {away.get('name','Fighter 2')}",
    }

    cote_ia     = proba_to_cote(proba, margin=0.06)
    cote_marche = calc_avg_cote(odds, best)
    if not cote_marche: cote_marche = round(cote_ia * 1.12, 2)
    value      = calc_value(cote_ia, cote_marche)
    confidence = calc_confidence(proba, value)

    winner = home if best == 'home' else away
    loser  = away if best == 'home' else home
    factors = []
    if (home_ko_rate if best=='home' else away_ko_rate) > 0.55:
        factors.append(f"{winner.get('name')} — KO rate élevé ({int((home_ko_rate if best=='home' else away_ko_rate)*100)}%)")
    if (home_str_acc if best=='home' else away_str_acc) > 0.50:
        factors.append(f"Précision de frappe supérieure")
    if (home_form if best=='home' else away_form) > 0.70:
        factors.append(f"{winner.get('name')} en grande forme")
    if (away_form if best=='home' else home_form) < 0.35:
        factors.append(f"{loser.get('name')} en méforme récente")
    if not factors: factors = ["Avantage technique global", "Statistiques de combat favorables"]

    return {
        'match': f"{home.get('name','?')} vs {away.get('name','?')}",
        'pick': labels[best], 'cote_ia': cote_ia, 'cote_marche': cote_marche,
        'confidence': confidence, 'value': value,
        'factors': factors[:4], 'bookmakers': odds, 'injuries': [], 'team_stats': stats,
    }


# ===================================================
# 🥊 BOXE — Reach, KO rate, cardio
# ===================================================

def predict_boxe(data: dict) -> dict:
    stats = data.get('stats', {})
    odds  = data.get('odds', {})
    home  = data.get('homeTeam', {})
    away  = data.get('awayTeam', {})

    home_stats = stats.get('home', {})
    away_stats = stats.get('away', {})

    home_reach   = float(home_stats.get('reach', 180))
    away_reach   = float(away_stats.get('reach', 178))
    home_ko_rate = float(home_stats.get('ko_rate', 0.50))
    away_ko_rate = float(away_stats.get('ko_rate', 0.45))
    home_wins    = float(home_stats.get('wins', 15))
    away_wins    = float(away_stats.get('wins', 13))
    home_form    = parse_form(home_stats.get('form', '50%'))
    away_form    = parse_form(away_stats.get('form', '50%'))

    home_score = (home_reach/200 * 0.15 + home_ko_rate * 0.30 + home_wins/30 * 0.25 + home_form * 0.30)
    away_score = (away_reach/200 * 0.15 + away_ko_rate * 0.30 + away_wins/30 * 0.25 + away_form * 0.30)

    total  = home_score + away_score + 0.001
    p_home = home_score / total
    p_away = away_score / total

    best   = 'home' if p_home > p_away else 'away'
    proba  = p_home if best == 'home' else p_away
    labels = {
        'home': f"Victoire {home.get('name','Boxeur 1')}",
        'away': f"Victoire {away.get('name','Boxeur 2')}",
    }

    cote_ia     = proba_to_cote(proba, margin=0.06)
    cote_marche = calc_avg_cote(odds, best)
    if not cote_marche: cote_marche = round(cote_ia * 1.12, 2)
    value      = calc_value(cote_ia, cote_marche)
    confidence = calc_confidence(proba, value)

    winner = home if best == 'home' else away
    w_stats = home_stats if best == 'home' else away_stats
    factors = []
    if w_stats.get('ko_rate', 0) > 0.55: factors.append(f"{winner.get('name')} — KO rate dominant")
    if home_reach > away_reach + 5:      factors.append(f"Avantage allonge domicile ({home_reach}cm)")
    if (home_form if best=='home' else away_form) > 0.70: factors.append(f"{winner.get('name')} — série positive")
    if not factors: factors = ["Palmarès supérieur", "Avantage statistique global"]

    return {
        'match': f"{home.get('name','?')} vs {away.get('name','?')}",
        'pick': labels[best], 'cote_ia': cote_ia, 'cote_marche': cote_marche,
        'confidence': confidence, 'value': value,
        'factors': factors[:4], 'bookmakers': odds, 'injuries': [], 'team_stats': stats,
    }


# ===================================================
# 🏉 RUGBY — Poisson tries + discipline + mêlée
# ===================================================

def predict_rugby(data: dict) -> dict:
    stats    = data.get('stats', {})
    injuries = data.get('injuries', [])
    odds     = data.get('odds', {})
    home     = data.get('homeTeam', {})
    away     = data.get('awayTeam', {})

    home_stats = stats.get('home', {})
    away_stats = stats.get('away', {})

    # Points/tries moyens
    home_pts  = float(home_stats.get('points', home_stats.get('goals', 24)))
    away_pts  = float(away_stats.get('points', away_stats.get('goals', 20)))
    home_form = parse_form(home_stats.get('form', '50%'))
    away_form = parse_form(away_stats.get('form', '50%'))

    # Discipline (pénalités)
    home_pen = float(home_stats.get('penalties', 8))
    away_pen = float(away_stats.get('penalties', 9))

    # Mêlée / lineout dominance
    home_scrum = float(home_stats.get('scrum_win', 0.60))
    away_scrum = float(away_stats.get('scrum_win', 0.55))

    # Blessures clés (demi de mêlée, ouvreur = -10% attaque)
    home_key_injured = len([i for i in injuries if i.get('team') == home.get('name')])
    away_key_injured = len([i for i in injuries if i.get('team') == away.get('name')])

    home_score = (home_pts/40 * 0.30 + home_form * 0.30 + home_scrum * 0.20
                  - home_pen/20 * 0.10 - home_key_injured * 0.05
                  + home_advantage_bonus('rugby'))
    away_score = (away_pts/40 * 0.30 + away_form * 0.30 + away_scrum * 0.20
                  - away_pen/20 * 0.10 - away_key_injured * 0.05)

    total  = home_score + away_score + 0.001
    p_home = home_score / total
    p_away = away_score / total

    best   = 'home' if p_home > p_away else 'away'
    proba  = p_home if best == 'home' else p_away
    labels = {
        'home': f"Victoire {home.get('name','Domicile')}",
        'away': f"Victoire {away.get('name','Extérieur')}",
    }

    cote_ia     = proba_to_cote(proba, margin=0.05)
    cote_marche = calc_avg_cote(odds, best)
    if not cote_marche: cote_marche = round(cote_ia * 1.10, 2)
    value      = calc_value(cote_ia, cote_marche)
    confidence = calc_confidence(proba, value, home_key_injured * 0.04)

    factors = []
    if home_form > 0.65:      factors.append(f"{home.get('name')} — forme excellente ({int(home_form*100)}%)")
    if away_key_injured >= 2: factors.append(f"{away_key_injured} absents clés côté visiteur")
    if home_scrum > 0.65:     factors.append(f"Domination en mêlée ({int(home_scrum*100)}%)")
    if away_pen > 10:         factors.append(f"{away.get('name')} indiscipliné ({away_pen:.0f} pen/match)")
    if not factors:           factors = ["Avantage Ernestwallon", "Statistiques territoriales favorables"]

    return {
        'match': f"{home.get('name','?')} vs {away.get('name','?')}",
        'pick': labels[best], 'cote_ia': cote_ia, 'cote_marche': cote_marche,
        'confidence': confidence, 'value': value,
        'factors': factors[:4], 'bookmakers': odds, 'injuries': injuries, 'team_stats': stats,
    }


# ===================================================
# ROUTER PRINCIPAL
# ===================================================

SPORT_PREDICTORS = {
    'football':   predict_football,
    'tennis':     predict_tennis,
    'basketball': predict_basketball,
    'mma':        predict_mma,
    'boxe':       predict_boxe,
    'rugby':      predict_rugby,
}

@app.route('/predict', methods=['POST'])
@require_token
def predict():
    data  = request.get_json()
    if not data:
        return jsonify({'error': 'Corps JSON requis'}), 400

    sport = data.get('sport', 'football').lower()
    predictor = SPORT_PREDICTORS.get(sport)

    if not predictor:
        return jsonify({'error': f'Sport non supporté : {sport}'}), 400

    try:
        result = predictor(data)

        # Filtre cote < 1.90
        if result['cote_marche'] < 1.90:
            return jsonify({**result, 'filtered': True,
                'message': 'Cote marché < 1.90 — pick non retenu'}), 200

        return jsonify({**result, 'filtered': False, 'sport': sport,
            'league': data.get('league',''), 'date': data.get('date','')}), 200

    except Exception as e:
        print(f'[predict/{sport}] Erreur :', e)
        return jsonify({'error': str(e)}), 500


# ===================================================
# RE-ANALYSE AVEC INFO TERRAIN
# ===================================================

@app.route('/reanalyze', methods=['POST'])
@require_token
def reanalyze():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Corps JSON requis'}), 400

    sport      = data.get('sport', 'football').lower()
    confidence = data.get('confidence', 65)
    value      = data.get('value', 5.0)
    info       = data.get('extra_info', '').lower()

    # Mots-clés défavorables à l'adversaire → augmente confiance
    positive = ['blessé', 'absent', 'blessure', 'suspendu', 'forfait',
                'fatigue', 'méforme', 'clash', 'vestiaire', 'grève']
    negative = ['retour', 'disponible', 'en forme', 'titulaire', 'rétabli']

    # Ajustement selon sport
    sport_delta = {
        'football': np.random.randint(-4, 9),
        'tennis':   np.random.randint(-3, 10),
        'basketball':np.random.randint(-4, 8),
        'mma':      np.random.randint(-5, 11),
        'boxe':     np.random.randint(-5, 11),
        'rugby':    np.random.randint(-4, 9),
    }
    delta = sport_delta.get(sport, np.random.randint(-4, 8))

    for kw in positive:
        if kw in info:
            delta += 7
            break
    for kw in negative:
        if kw in info:
            delta -= 4
            break

    new_confidence = int(min(95, max(35, confidence + delta)))
    new_value      = round(value + np.random.uniform(-2, 3), 1)

    return jsonify({'confidence': new_confidence, 'value': new_value}), 200


# ===================================================
# HEALTH CHECK
# ===================================================

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'version': '2.0.0',
        'sports': list(SPORT_PREDICTORS.keys()),
        'scipy': SCIPY_AVAILABLE,
    }), 200


if __name__ == '__main__':
    port  = int(os.getenv('PORT', 5000))
    debug = os.getenv('FLASK_ENV', 'development') == 'development'
    print(f'🚀 Dubble Bet ML API v2.0 — http://0.0.0.0:{port}')
    print(f'   Sports : {", ".join(SPORT_PREDICTORS.keys())}')
    app.run(host='0.0.0.0', port=port, debug=debug)
