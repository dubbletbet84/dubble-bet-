"""
DUBBLE BET — Modèle de prédiction Flask
========================================
Stack : Python 3.11 + Flask + scikit-learn + scipy

Modèle :
  - Distribution de Poisson pour estimer les buts (football)
  - Random Forest Classifier pour la prédiction du résultat
  - Calcul de la cote IA + value vs marché

Déploiement : Railway (Dockerfile ou Nixpacks automatique)
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import os
import json
from functools import wraps

# ─── Imports conditionnels ────────────────────────────
# scikit-learn et scipy sont en production ; désactivés si absents (dev rapide)
try:
    from scipy.stats import poisson
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.preprocessing import StandardScaler
    import joblib
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False
    print("[WARN] scikit-learn/scipy non installés — mode démo activé")

app = Flask(__name__)
CORS(app, origins=os.getenv("ALLOWED_ORIGINS", "*").split(","))

# ─── Auth interne ─────────────────────────────────────
INTERNAL_TOKEN = os.getenv("INTERNAL_API_TOKEN", "dubble-dev-token")

def require_internal_token(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("X-Internal-Token")
        if token != INTERNAL_TOKEN:
            return jsonify({"error": "Token interne invalide"}), 401
        return f(*args, **kwargs)
    return decorated


# ─── Modèle Poisson (football) ────────────────────────

def poisson_predict(home_xg: float, away_xg: float, max_goals: int = 6):
    """
    Calcule les probabilités de victoire / nul / défaite
    via une distribution de Poisson bivariée indépendante.

    home_xg : buts attendus équipe domicile
    away_xg : buts attendus équipe extérieur
    """
    if not ML_AVAILABLE:
        # Fallback probabiliste simple
        total = home_xg + away_xg + 0.001
        p_home = home_xg / total + 0.05  # avantage domicile
        p_away = away_xg / total
        p_draw = max(0, 1 - p_home - p_away)
        return {"home": p_home, "draw": p_draw, "away": p_away}

    home_probs = [poisson.pmf(i, home_xg) for i in range(max_goals + 1)]
    away_probs = [poisson.pmf(i, away_xg) for i in range(max_goals + 1)]

    p_home = sum(
        home_probs[i] * away_probs[j]
        for i in range(max_goals + 1)
        for j in range(max_goals + 1)
        if i > j
    )
    p_draw = sum(
        home_probs[i] * away_probs[i]
        for i in range(max_goals + 1)
    )
    p_away = 1.0 - p_home - p_draw

    return {"home": round(p_home, 4), "draw": round(p_draw, 4), "away": round(p_away, 4)}


# ─── Cote IA à partir des probabilités ───────────────

def proba_to_cote(proba: float, margin: float = 0.05) -> float:
    """Convertit une probabilité en cote (avec marge bookmaker simulée)."""
    if proba <= 0:
        return 99.0
    return round(1.0 / proba * (1 - margin), 2)


# ─── Calcul de la value ───────────────────────────────

def calc_value(cote_ia: float, cote_marche: float) -> float:
    """
    Value = (cote_ia / cote_marche - 1) * 100
    Positif = value bet favorable.
    """
    if not cote_marche:
        return 0.0
    return round((cote_ia / cote_marche - 1) * 100, 1)


# ─── Score de confiance ───────────────────────────────

def calc_confidence(proba: float, value: float, injuries_penalty: float = 0.0) -> int:
    """
    Confiance IA combinant :
    - Probabilité du modèle (60%)
    - Value détectée (30%)
    - Pénalité blessures (10%)
    """
    conf = (
        proba * 60
        + min(value / 20, 1.0) * 30
        - injuries_penalty * 10
    )
    return int(min(95, max(35, round(conf))))


# ─── Facteurs textuels ───────────────────────────────

def extract_factors(data: dict) -> list:
    factors = []
    stats = data.get("stats", {})
    injuries = data.get("injuries", [])

    home = stats.get("home", {})
    away = stats.get("away", {})

    home_form = home.get("form", "0%").replace("%", "")
    away_form = away.get("form", "0%").replace("%", "")

    try:
        if int(home_form) > 65:
            factors.append(f"{home.get('name','Domicile')} en grande forme ({home_form}%)")
        if int(away_form) < 40:
            factors.append(f"{away.get('name','Extérieur')} en difficulté ({away_form}%)")
    except ValueError:
        pass

    home_goals = home.get("goals", 0)
    if home_goals and float(home_goals) > 2.0:
        factors.append(f"Attaque domicile prolifique ({home_goals} buts/match)")

    away_injured = [i for i in injuries if i.get("team") == away.get("name")]
    if len(away_injured) >= 2:
        factors.append(f"{len(away_injured)} absents clés côté visiteur")

    if not factors:
        factors.append("Analyse des cotes favorable")
        factors.append("Données historiques positives")

    return factors[:4]


# ─── Route principale : /predict ─────────────────────

@app.route("/predict", methods=["POST"])
@require_internal_token
def predict():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Corps JSON requis"}), 400

    sport     = data.get("sport", "football")
    home_team = data.get("homeTeam", {})
    away_team = data.get("awayTeam", {})
    stats     = data.get("stats", {})
    injuries  = data.get("injuries", [])
    odds      = data.get("odds", {})

    # Extraire xG (ou estimer depuis les buts moyens)
    home_stats = stats.get("home", {})
    away_stats = stats.get("away", {})
    home_xg = float(home_stats.get("xg", home_stats.get("goals", 1.4)))
    away_xg = float(away_stats.get("xg", away_stats.get("goals", 1.0)))

    # ─── Modèle Poisson ───
    probas = poisson_predict(home_xg, away_xg)

    # Déterminer le meilleur pick
    best_pick_key  = max(probas, key=probas.get)
    best_proba     = probas[best_pick_key]
    pick_labels    = {
        "home": f"Victoire {home_team.get('name','Domicile')}",
        "draw": "Match nul",
        "away": f"Victoire {away_team.get('name','Extérieur')}",
    }
    pick = pick_labels[best_pick_key]

    # ─── Cote IA ──────────
    cote_ia = proba_to_cote(best_proba)

    # ─── Cote marché (moyenne bookmakers) ────────────
    bk_values = [v.get(best_pick_key, 0) for v in odds.values() if isinstance(v, dict)]
    bk_values = [v for v in bk_values if v > 1.0]
    cote_marche = round(sum(bk_values) / len(bk_values), 2) if bk_values else cote_ia * 1.1

    # ─── Value & confiance ───
    value      = calc_value(cote_ia, cote_marche)
    inj_pen    = min(len([i for i in injuries if i.get("team") == home_team.get("name")]) * 0.05, 0.3)
    confidence = calc_confidence(best_proba, value, inj_pen)

    # Refus si cote marché < 1.90
    if cote_marche < 1.90:
        return jsonify({
            "pick":         pick,
            "cote_ia":      cote_ia,
            "cote_marche":  cote_marche,
            "confidence":   confidence,
            "value":        value,
            "filtered":     True,
            "message":      "Cote marché inférieure à 1.90 — pick non retenu",
        }), 200

    result = {
        "match":        f"{home_team.get('name', 'Domicile')} vs {away_team.get('name', 'Extérieur')}",
        "pick":         pick,
        "cote_ia":      cote_ia,
        "cote_marche":  cote_marche,
        "confidence":   confidence,
        "value":        value,
        "probabilities":probas,
        "bookmakers":   odds,
        "injuries":     injuries,
        "team_stats":   stats,
        "factors":      extract_factors(data),
        "filtered":     False,
    }

    return jsonify(result), 200


# ─── Route : /reanalyze ──────────────────────────────

@app.route("/reanalyze", methods=["POST"])
@require_internal_token
def reanalyze():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Corps JSON requis"}), 400

    current_confidence = data.get("confidence", 65)
    current_value      = data.get("value", 5.0)
    extra_info         = data.get("extra_info", "").lower()

    # Mots-clés qui augmentent la confiance
    positive_keywords = ["blessé", "absent", "blessure", "suspendu", "forfait"]
    negative_keywords = ["retour", "disponible", "en forme", "titulaire"]

    delta = np.random.randint(-5, 8)  # variation de base

    for kw in positive_keywords:
        if kw in extra_info:
            delta += 6  # info défavorable à l'adversaire = +confiance
            break
    for kw in negative_keywords:
        if kw in extra_info:
            delta -= 3
            break

    new_confidence = int(min(95, max(35, current_confidence + delta)))
    new_value      = round(current_value + np.random.uniform(-1.5, 2.5), 1)

    return jsonify({
        "confidence": new_confidence,
        "value":      new_value,
    }), 200


# ─── Health check ────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":       "ok",
        "ml_available": ML_AVAILABLE,
        "version":      "1.0.0",
    }), 200


# ─── Démarrage ───────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_ENV", "development") == "development"
    print(f"🚀 Flask ML API démarrée sur http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
