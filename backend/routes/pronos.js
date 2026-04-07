// ===================================================
// ROUTE : /api/pronos
// Génération et gestion des pronostics
// ===================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('./auth');
const apiSports  = require('../services/apiSports');
const prediction = require('../services/prediction');

const router   = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Quotas par plan
const PLAN_QUOTAS = { starter: 5, pro: 10, expert: 30, illimite: Infinity, unit: 1 };

// ─── Middleware : vérifier quota ─────────────────────
async function checkQuota(req, res, next) {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('pronostics')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .gte('created_at', weekStart.toISOString());

  const { data: profile } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', req.user.id)
    .single();

  const plan  = profile?.plan || 'pro';
  const max   = PLAN_QUOTAS[plan] || 10;
  const used  = count || 0;

  if (max !== Infinity && used >= max) {
    return res.status(429).json({
      error: `Quota atteint pour le plan ${plan} (${used}/${max} pronos cette semaine).`,
      upgrade_url: '/pages/register.html',
    });
  }
  req.quota = { plan, used, max };
  next();
}

// ─── POST /api/pronos/generate ───────────────────────
// Corps : { sport, league, date, info? }
router.post('/generate', requireAuth, checkQuota, async (req, res) => {
  const { sport, league, date, info = '' } = req.body;

  if (!sport || !league || !date) {
    return res.status(400).json({ error: 'sport, league et date sont requis' });
  }

  try {
    // 1. Récupérer les matchs du jour via API-Sports (avec fallback démo si vide)
    let fixtures = await apiSports.getFixtures({ sport, league, date });
    if (!fixtures.length) {
      fixtures = apiSports.getDemoFixtures(sport, league);
    }

    // 2. Récupérer stats, blessés, cotes pour chaque match
    const enrichedFixtures = await Promise.all(
      fixtures.slice(0, 3).map(async (fixture) => {
        const [stats, injuries, odds] = await Promise.all([
          apiSports.getTeamStats(fixture),
          apiSports.getInjuries(fixture),
          apiSports.getOdds(fixture),
        ]);
        return { ...fixture, stats, injuries, odds };
      })
    );

    // 3. Appeler le modèle ML (Flask Python)
    const predictions = await Promise.all(
      enrichedFixtures.map(f => prediction.predict(f))
    );

    // 4. Filtrer : cote >= 1.90 uniquement
    const validPicks = predictions.filter(p => p.cote_marche >= 1.90);
    if (!validPicks.length) {
      return res.status(204).json({
        message: 'Aucun pick à valeur suffisante trouvé (cote < 1.90). Essayez une autre date ou ligue.',
      });
    }

    // Prendre le meilleur pick (plus haute value)
    const bestPick = validPicks.sort((a, b) => b.value - a.value)[0];

    // 5. Sauvegarder en base
    const pronoData = {
      user_id:     req.user.id,
      sport,
      league,
      date,
      match:       bestPick.match,
      pick:        bestPick.pick,
      cote_ia:     bestPick.cote_ia,
      cote_marche: bestPick.cote_marche,
      confidence:  bestPick.confidence,
      value:       bestPick.value,
      bookmakers:  bestPick.bookmakers,
      injuries:    bestPick.injuries,
      team_stats:  bestPick.teamStats,
      factors:     bestPick.factors,
      result:      'pending',
      reanalyze_count: 0,
      extra_info:  info || null,
      created_at:  new Date().toISOString(),
    };

    const { data: saved, error } = await supabase
      .from('pronostics')
      .insert([pronoData])
      .select()
      .single();

    if (error) throw error;

    res.json(saved);
  } catch (err) {
    console.error('[pronos/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pronos/reanalyze ──────────────────────
// Corps : { pronoId, info }
router.post('/reanalyze', requireAuth, async (req, res) => {
  const { pronoId, info } = req.body;
  if (!pronoId || !info) {
    return res.status(400).json({ error: 'pronoId et info sont requis' });
  }

  // Récupérer le prono
  const { data: prono, error } = await supabase
    .from('pronostics')
    .select('*')
    .eq('id', pronoId)
    .eq('user_id', req.user.id)
    .single();

  if (error || !prono) {
    return res.status(404).json({ error: 'Pronostic non trouvé' });
  }

  // Vérifier limite re-analyses
  if (prono.reanalyze_count >= 3) {
    return res.status(429).json({ error: 'Limite de 3 re-analyses atteinte pour ce pronostic.' });
  }

  try {
    // Recalculer avec l'info terrain
    const result = await prediction.reanalyze({ prono, info });

    // Mettre à jour en base
    const { data: updated } = await supabase
      .from('pronostics')
      .update({
        confidence:      result.confidence,
        value:           result.value,
        reanalyze_count: prono.reanalyze_count + 1,
        extra_info:      info,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', pronoId)
      .select()
      .single();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/pronos ─────────────────────────────────
// Liste des pronos de l'utilisateur connecté
router.get('/', requireAuth, async (req, res) => {
  const { sport, result, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from('pronostics')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (sport)  query = query.eq('sport', sport);
  if (result) query = query.eq('result', result);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// ─── PATCH /api/pronos/:id/result ────────────────────
// Mise à jour du résultat (win / loss) — usage admin ou cron
router.patch('/:id/result', requireAuth, async (req, res) => {
  const { result } = req.body;
  if (!['win', 'loss', 'void'].includes(result)) {
    return res.status(400).json({ error: 'result doit être win, loss ou void' });
  }

  const { data, error } = await supabase
    .from('pronostics')
    .update({ result, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
