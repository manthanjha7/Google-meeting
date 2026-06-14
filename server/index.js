require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();

// ---- Security headers ----
app.use(helmet());

// ---- CORS ----
// CORS_ORIGINS env var: comma-separated list of allowed origins.
// If not set, all origins are allowed (suitable for local dev).
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : null;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));

// ---- Rate limiting ----
// General: 200 req/min per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

// Expensive endpoints: 20 req/min per IP
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests on this endpoint.' },
});
app.use('/api/upload', heavyLimiter);
app.use('/api/transcribe', heavyLimiter);
app.use('/api/summarize', heavyLimiter);

// ---- API key auth ----
// Protects all /api/* routes except /api/health.
// Set API_SECRET in .env; extension must send it as X-API-Key header.
// Skip auth entirely if API_SECRET is not configured (local dev).
const API_SECRET = process.env.API_SECRET;
if (API_SECRET) {
  app.use('/api/', (req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['x-api-key'];
    if (!key || key !== API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}

app.use(express.json({ limit: '50mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// React dashboard (served from /dashboard/)
const dashboardDist = path.join(__dirname, 'public', 'dashboard');
app.use('/dashboard', express.static(dashboardDist));
app.get('/dashboard/*', (req, res) => {
  const indexPath = path.join(dashboardDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Dashboard not built. Run the dashboard-app build step.');
  }
});

// Routes
app.use('/api/upload', require('./routes/upload'));
app.use('/api/transcribe/live', require('./routes/live'));
app.use('/api/transcribe', require('./routes/transcribe'));
app.use('/api/summarize', require('./routes/summarize'));
app.use('/api/slack', require('./routes/slack'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/kb', require('./routes/kb'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/templates', require('./routes/templates'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Initialize DB then start server
const { getDb } = require('./db/schema');
const PORT = process.env.PORT || 3001;

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Finrep Meeting Intelligence server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
