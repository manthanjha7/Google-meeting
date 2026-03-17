const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'meetings.db');

let db;

async function getDb() {
  if (!db) {
    const SQL = await initSqlJs();

    // Load existing database file if it exists
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    initSchema();
  }
  return db;
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      call_type TEXT,
      audio_path TEXT,
      transcript TEXT,
      summary TEXT,
      participants TEXT,
      duration_seconds INTEGER,
      slack_posted INTEGER DEFAULT 0,
      meet_title TEXT,
      meet_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_meetings_call_type ON meetings(call_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings(created_at)`);

  // Add columns for existing databases (safe to run multiple times)
  try { db.run(`ALTER TABLE meetings ADD COLUMN meet_title TEXT`); } catch (e) { /* already exists */ }
  try { db.run(`ALTER TABLE meetings ADD COLUMN meet_url TEXT`); } catch (e) { /* already exists */ }

  // Settings key-value store
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  saveDb();
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

module.exports = { getDb, saveDb };
