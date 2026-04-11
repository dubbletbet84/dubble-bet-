// ===================================================
// DUBBLE BET — MOTEUR IA FINAL (GitHub Pages compatible)
// ===================================================

const API_KEY_FOOTBALL = '0bebba720a484535a0105713e0fc7d66';
const API_KEY_ODDS = '402dfe4ed1b2e82526e91725d6f02438';

const LEAGUE_MAP_ALGO = {
    'PL':'Premier League','ELC':'Championship','PD':'La Liga',
    'SD':'La Liga 2', 'BL1':'Bundesliga','BL2':'2. Bundesliga',
    'SA':'Serie A', 'SB':'Serie B', 'FL1':'Ligue 1', 'FL2':'Ligue 2'
};

// --- ALGORITHME DE DÉTECTION ---
async function _runAlgoBrowser() {
    const now = new Date();
    const future = new Date();
    future.setDate(now.getDate() + 3);
    const dateFrom = now.toISOString().split('T')[0];
    const dateTo = future.toISOString().split('T')[0];

    try {
        const [resF, resO] = await Promise.all([
            fetch(`https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
                headers: { 'X-Auth-Token': API_KEY_FOOTBALL }
            }),
            fetch(`https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${API_KEY_ODDS}&regions=eu&markets=h2h,totals`)
        ]);

        const dataF = await resF.json();
        const dataO = await resO.json();
        const allValidPicks = [];

        (dataF.matches || []).forEach(m => {
            const leagueName = LEAGUE_MAP_ALGO[m.competition.code];
            if (!leagueName) return;

            const matchOdds = dataO.find(o => {
                const clean = (n) => n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/fc|cf|as|real|stade|united|city|town|sporting|bayer|atletico|de /g, '').trim();
                return clean(m.homeTeam.name).includes(clean(o.home_team)) || clean(o.home_team).includes(clean(m.homeTeam.name));
            });

            if (matchOdds && matchOdds.bookmakers.length > 0) {
                const markets = matchOdds.bookmakers[0].markets;
                const h2h = markets.find(mk => mk.key === 'h2h')?.outcomes;
                const totals = markets.find(mk => mk.key === 'totals')?.outcomes;
                if (!h2h) return;

                const home = h2h.find(x => x.name === matchOdds.home_team);
                const away = h2h.find(x => x.name === matchOdds.away_team);
                const draw = h2h.find(x => x.name.toLowerCase().includes('draw'));

                if (!home || !away || !draw) return;

                const margin = (1/home.price) + (1/away.price) + (1/draw.price);
                const probHome = ((1/home.price) / margin) * 100;
                const probAway = ((1/away.price) / margin) * 100;

                // Filtre : Cote >= 1.80 et Probabilité > 50%
                if (home.price >= 1.80 && probHome > 50) {
                    allValidPicks.push({ match: `${m.homeTeam.name} vs ${m.awayTeam.name}`, league: leagueName, date: m.utcDate, pick: `Victoire ${m.homeTeam.name}`, cote: home.price, prob: probHome, type: "VICTOIRE" });
                }
                if (away.price >= 1.80 && probAway > 50) {
                    allValidPicks.push({ match: `${m.homeTeam.name} vs ${m.awayTeam.name}`, league: leagueName, date: m.utcDate, pick: `Victoire ${m.awayTeam.name}`, cote: away.price, prob: probAway, type: "VICTOIRE" });
                }

                if (totals) {
                    const lines = [...new Set(totals.filter(x => x.point).map(x => x.point))];
                    lines.forEach(pt => {
                        const ov = totals.find(x => x.name.toLowerCase() === 'over'  && x.point === pt);
                        const un = totals.find(x => x.name.toLowerCase() === 'under' && x.point === pt);
                        if (ov && un) {
                            const mg = (1/ov.price) + (1/un.price);
                            const pOv = ((1/ov.price) / mg) * 100;
                            const pUn = ((1/un.price) / mg) * 100;
                            if (ov.price >= 1.80 && pOv > 50)
                                allValidPicks.push({ match: `${m.homeTeam.name} vs ${m.awayTeam.name}`, league: leagueName, date: m.utcDate, pick: `+${pt} Buts`, cote: ov.price, prob: pOv, type: `+${pt} BUTS` });
                            if (un.price >= 1.80 && pUn > 50)
                                allValidPicks.push({ match: `${m.homeTeam.name} vs ${m.awayTeam.name}`, league: leagueName, date: m.utcDate, pick: `-${pt} Buts`, cote: un.price, prob: pUn, type: `-${pt} BUTS` });
                        }
                    });
                }
            }
        });

        if (allValidPicks.length === 0) return null;
        // On prend le prono avec la meilleure value
        return allValidPicks.sort((a, b) => (b.cote * b.prob) - (a.cote * a.prob))[0];

    } catch (e) {
        console.error("Erreur Algo:", e);
        return null;
    }
}

// --- FONCTIONS INTERFACE ---
async function generatePronostic() {
    const pick = await _runAlgoBrowser();
    if (!pick) throw new Error('Aucun prono sécurisé trouvé pour les 3 prochains jours.');
    
    const pronoData = {
        sport: 'football',
        league: pick.league,
        match: pick.match,
        pick: pick.pick,
        cote_marche: pick.cote,
        confidence: Math.round(pick.prob),
        value: parseFloat(((pick.cote * pick.prob / 100 - 1) * 100).toFixed(1)),
        date: pick.date,
        bet_type: pick.type,
        result: 'pending',
        created_at: new Date().toISOString()
    };

    // Sauvegarde directe dans Supabase (pas besoin de backend Railway ici)
    const user = await window.DB.getUser();
    if (user) {
        pronoData.user_id = user.id;
        await window.DB.savePronostic(pronoData);
    }
    
    return pronoData;
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('globalToast') || document.createElement('div');
    toast.id = 'globalToast';
    toast.className = `toast ${type} show`;
    toast.innerHTML = `<span class="toast-text">${message}</span>`;
    if (!document.getElementById('globalToast')) document.body.appendChild(toast);
    setTimeout(() => toast.classList.remove('show'), 3500);
}

window.App = {
    generatePronostic,
    formatDate: (d) => new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' }),
    showToast,
    callAPI: async (url) => { console.log("Simulated API call to", url); return {}; } // Pour éviter les erreurs sur GitHub
};