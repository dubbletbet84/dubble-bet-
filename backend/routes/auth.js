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
    // Crée le profil s'il n'existe pas encore (upsert silencieux)
    await supabase
      .from('profiles')
      .upsert(
        { id: req.user.id, email: req.user.email, full_name: req.user.user_metadata?.full_name || null },
        { onConflict: 'id', ignoreDuplicates: true }
      );

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

    const quotas = { starter: 5, pro: 10, expert: 30, illimite: Infinity, unit: 1 };
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

// ─── POST /api/auth/create-profile ──────────────────
// Crée le profil utilisateur depuis le backend (bypass RLS via service role)
router.post('/create-profile', async (req, res) => {
  const { userId, email, plan, full_name } = req.body;
  if (!userId || !email) return res.status(400).json({ error: 'userId et email requis' });

  try {
    const { data, error } = await supabase
      .from('profiles')
      .upsert(
        { id: userId, email, plan: plan || 'pro', full_name: full_name || email.split('@')[0] },
        { onConflict: 'id', ignoreDuplicates: true }
      )
      .select()
      .single();

    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    console.error('[create-profile]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/auth/account ────────────────────────
// Supprime le compte complètement (auth.users + profiles + pronos)
router.delete('/account', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    // 1. Supprimer toutes les données liées (FK vers profiles ou user_id)
    const dels = await Promise.allSettled([
      supabase.from('pronostics').delete().eq('user_id', userId),
      supabase.from('profiles').delete().eq('id', userId),
    ]);
    dels.forEach(({ status, reason }) => {
      if (status === 'rejected') console.warn('[delete-account] data del warn:', reason);
    });

    // 2. Attendre un court instant pour laisser les FK se résoudre
    await new Promise(r => setTimeout(r, 300));

    // 3. Supprimer l'utilisateur Supabase Auth
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      console.error('[delete-account] admin.deleteUser:', error.message);
      throw error;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[delete-account]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/cleanup-orphan ───────────────────
// Si l'utilisateur existe dans auth.users mais pas dans profiles
// (compte à moitié supprimé), supprime l'auth user pour permettre la re-inscription
router.post('/cleanup-orphan', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email requis' });

  try {
    // Chercher l'utilisateur par email via admin API
    const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) throw listErr;

    const authUser = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!authUser) return res.json({ status: 'not_found' });

    // Vérifier si un profil existe
    const { data: profile } = await supabase
      .from('profiles').select('id').eq('id', authUser.id).single();

    if (profile) {
      // Profil existe → compte actif, ne pas toucher
      return res.json({ status: 'active' });
    }

    // Pas de profil → orphelin → supprimer l'auth user
    await supabase.auth.admin.deleteUser(authUser.id);
    res.json({ status: 'cleaned' });
  } catch (err) {
    console.error('[cleanup-orphan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;
