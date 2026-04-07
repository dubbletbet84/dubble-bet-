// ===================================================
// DUBBLE BET — Configuration Supabase
// ===================================================
// 1. Créez un projet sur https://supabase.com
// 2. Allez dans Settings > API
// 3. Copiez l'URL et la clé anon ci-dessous
// ===================================================

// TODO: Remplacez ces valeurs par vos vraies clés Supabase
const SUPABASE_URL  = 'https://wamdtnyrtiegiplhwpmh.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhbWR0bnlydGllZ2lwbGh3cG1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MDA5ODEsImV4cCI6MjA5MTA3Njk4MX0.ow_CRNKZeeq-wHsiPH6vL3JEk7EmADXcvuVnv1W1MHg';

// Initialisation du client Supabase (CDN)
// Le script Supabase doit être inclus avant ce fichier dans vos pages HTML :
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>

let supabase = null;

function initSupabase() {
  if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return supabase;
  }
  console.warn('Supabase SDK non chargé. Assurez-vous d\'inclure le CDN Supabase.');
  return null;
}

// ===================================================
// AUTH HELPERS
// ===================================================

async function signUp(email, password, metadata = {}) {
  const client = initSupabase();
  if (!client) throw new Error('Supabase non initialisé');
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: metadata }
  });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const client = initSupabase();
  if (!client) throw new Error('Supabase non initialisé');
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signInWithGoogle() {
  const client = initSupabase();
  if (!client) throw new Error('Supabase non initialisé');
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/pages/dashboard.html` }
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  const client = initSupabase();
  if (!client) return;
  await client.auth.signOut();
  // Chemin relatif compatible Netlify
  const depth = window.location.pathname.split('/').length - 2;
  window.location.href = depth > 0 ? '../'.repeat(depth) + 'index.html' : 'index.html';
}

async function getSession() {
  const client = initSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session;
}

async function getUser() {
  const client = initSupabase();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data.user;
}

// Listener de changement d'état d'authentification
function onAuthChange(callback) {
  const client = initSupabase();
  if (!client) return;
  client.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}

// Redirige vers login si non authentifié
async function requireAuth(redirectTo = '/pages/login.html') {
  const session = await getSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

// ===================================================
// DATABASE HELPERS
// ===================================================

async function getUserProfile(userId) {
  const client = initSupabase();
  if (!client) return null;
  const { data, error } = await client
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

async function createProfile({ id, email, plan = 'pro', full_name = null }) {
  const client = initSupabase();
  if (!client) return null;
  const { data, error } = await client
    .from('profiles')
    .upsert(
      { id, email, plan, full_name, created_at: new Date().toISOString() },
      { onConflict: 'id', ignoreDuplicates: true }
    )
    .select()
    .single();
  if (error) console.warn('[createProfile]', error.message);
  return data;
}

async function savePronostic(pronoData) {
  const client = initSupabase();
  if (!client) throw new Error('Supabase non initialisé');
  const { data, error } = await client
    .from('pronostics')
    .insert([pronoData])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getUserPronostics(userId, filters = {}) {
  const client = initSupabase();
  if (!client) return [];
  let query = client
    .from('pronostics')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.sport)  query = query.eq('sport', filters.sport);
  if (filters.result) query = query.eq('result', filters.result);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function updatePronosticResult(pronoId, result) {
  const client = initSupabase();
  if (!client) throw new Error('Supabase non initialisé');
  const { data, error } = await client
    .from('pronostics')
    .update({ result, updated_at: new Date().toISOString() })
    .eq('id', pronoId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Export global
window.DB = {
  signUp, signIn, signInWithGoogle, signOut,
  getSession, getUser, onAuthChange, requireAuth,
  getUserProfile, createProfile, savePronostic, getUserPronostics, updatePronosticResult
};
