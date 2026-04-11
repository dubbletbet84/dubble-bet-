// ===================================================
// DUBBLE BET — MOTEUR IA
// ===================================================

// ⚠️ Remplace par ton URL Railway (ex: https://dubblebet-production.up.railway.app)
const BACKEND_URL = 'https://dubble-bet-production.up.railway.app';

// --- GÉNÉRATION PRONOSTIC (via backend Railway, pas de CORS) ---
async function generatePronostic() {
    // Récupérer le JWT Supabase pour authentifier la requête
    const session = await window.DB.getSession();
    if (!session) throw new Error('Tu dois être connecté pour générer un pronostic.');

    const res = await fetch(`${BACKEND_URL}/api/pronos/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
        }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la génération');
    return data;
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('globalToast') || document.createElement('div');
    toast.id = 'globalToast';
    toast.className = `toast ${type} show`;
    toast.innerHTML = `<span class="toast-text">${message}</span>`;
    if (!document.getElementById('globalToast')) document.body.appendChild(toast);
    setTimeout(() => toast.classList.remove('show'), 3500);
}

// callAPI : utilise Supabase directement pour auth/pronos
async function callAPI(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();

    if (path === '/auth/me' && method === 'GET') {
        const user = await window.DB.getUser();
        if (!user) return null;
        const profile = await window.DB.getUserProfile(user.id).catch(() => null);
        const plan = profile?.plan || 'pro';
        const PLAN_QUOTAS = { starter: 5, pro: 10, expert: 30, illimite: -1, unit: 1 };
        const max = PLAN_QUOTAS[plan] ?? 10;
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const allPronos = await window.DB.getUserPronostics(user.id).catch(() => []);
        const used = allPronos.filter(p => new Date(p.created_at) >= weekStart).length;
        return {
            user: { id: user.id, email: user.email, name: user.user_metadata?.full_name || user.email.split('@')[0] },
            profile: { plan },
            quota: { used, max, remaining: max === -1 ? Infinity : Math.max(0, max - used) }
        };
    }

    if (path === '/pronos' && method === 'GET') {
        const user = await window.DB.getUser();
        if (!user) return [];
        return await window.DB.getUserPronostics(user.id).catch(() => []);
    }

    if (path === '/auth/account' && method === 'DELETE') {
        await window.DB.signOut();
        return { ok: true };
    }

    return {};
}

window.App = {
    generatePronostic,
    formatDate: (d) => new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' }),
    showToast,
    callAPI,
};
