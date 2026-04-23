require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const pronosRoutes   = require('./routes/pronos');
const paymentsRoutes = require('./routes/payments');

const app  = express();
const PORT = process.env.PORT || 3001;

// Railway passe par un proxy
app.set('trust proxy', 1);

// ─── CORS : origines autorisées uniquement ────────────
const ALLOWED_ORIGINS = [
  'https://dubblebet.netlify.app',
  'https://dubbletbet84.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
const corsOptions = {
  origin: (origin, cb) => {
    // Autoriser les appels sans origin (ex: mobile, Postman en dev)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS refusé'));
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ─── Headers de sécurité (Helmet) ────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // géré côté Netlify
  crossOriginEmbedderPolicy: false,
}));
// Masquer la technologie utilisée
app.disable('x-powered-by');

// ─── Rate limiting ────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez plus tard.' },
}));

const pronoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Limite de génération atteinte, réessayez dans 1 heure.' },
});

// ─── Body parser ──────────────────────────────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' })); // limite réduite

// ─── Routes ───────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/pronos',   pronoLimiter, pronosRoutes);
app.use('/api/payments', paymentsRoutes);

// ─── Health check minimal ─────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── 404 ──────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Erreurs globales (sans fuite d'infos internes) ───
app.use((err, req, res, next) => {
  const status = err.status || 500;
  // En prod : message générique. En dev : message réel.
  const message = process.env.NODE_ENV === 'production'
    ? 'Une erreur est survenue.'
    : err.message;
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  process.stdout.write(`API started on port ${PORT}\n`);
});

module.exports = app;
