// ===================================================
// ROUTE : /api/auth
// Vérification JWT Supabase + profil utilisateur
// ===================================================

const express    = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// TODO: Insérez vos clés Supabase dans le fichier .env
// SUPABASE_URL=https://VOTRE_PROJECT_ID.supabase.co
// SUPABASE_SERVICE_KEY=VOTRE_SERVICE_ROLE_KEY  (jamais exposée côté client)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Middleware d'authentification ───────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  const token = authHeader.split(' ')[1];
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
  req.user = data.user;
  next();
}

// ─── GET /api/auth/me ─────────────────────────────────
// Retourne le profil utilisateur + quotas
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    // Calculer les pronos utilisés cette semaine
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const { count } = await supabase
      .from('pronostics')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .gte('created_at', weekStart.toISOString());

    const quotas = { starter: 5, pro: 10, illimite: Infinity, unit: 1 };
    const max    = quotas[profile?.plan || 'pro'] || 10;

    res.json({
      user: {
        id:    req.user.id,
        email: req.user.email,
        name:  req.user.user_metadata?.full_name || req.user.email.split('@')[0],
      },
      profile,
      quota: {
        plan:      profile?.plan || 'pro',
        used:      count || 0,
        max:       max === Infinity ? -1 : max,
        remaining: max === Infinity ? -1 : Math.max(0, max - (count || 0)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/verify ───────────────────────────
// Vérifie un token et retourne l'utilisateur
router.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requis' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error) return res.status(401).json({ error: 'Token invalide' });

  res.json({ user: data.user });
});

module.exports = router;
module.exports.requireAuth = requireAuth;
