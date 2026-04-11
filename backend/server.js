// ===================================================
// DUBBLE BET — Serveur Express principal
// Stack : Node.js + Express
// Hébergement cible : Railway
// ===================================================

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const pronosRoutes   = require('./routes/pronos');
const paymentsRoutes = require('./routes/payments');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Sécurité ────────────────────────────────────────
app.use(helmet());

app.use(cors({ origin: true, credentials: true }));

// Rate limiting global (100 req/15min par IP)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
}));

// Rate limiting strict pour la génération de pronos (10 req/heure)
const pronoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Limite de génération de pronostics atteinte (10/heure).' },
});

// ─── Body parser ─────────────────────────────────────
// Note : Stripe webhooks nécessitent le raw body — géré dans payments.js
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// ─── Routes ──────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/pronos',   pronoLimiter, pronosRoutes);
app.use('/api/payments', paymentsRoutes);

// ─── Health check ────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// ─── 404 ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// ─── Gestion des erreurs globale ─────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Erreur interne du serveur',
  });
});

// ─── Démarrage ───────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Dubble Bet API démarrée sur le port ${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
  console.log(`   NODE_ENV : ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
