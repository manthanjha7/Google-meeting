require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve dashboard static files
app.use(express.static(path.join(__dirname, 'public')));

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
const PORT = process.env.PORT || 3000;

getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Finrep Meeting Intelligence server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
