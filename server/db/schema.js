const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'meetings.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      call_type TEXT CHECK(call_type IN ('internal', 'customer', 'gtm', 'product')),
      audio_path TEXT,
      transcript TEXT,
      summary TEXT,
      participants TEXT,
      duration_seconds INTEGER,
      slack_posted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_call_type ON meetings(call_type);
    CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings(created_at);
  `);
}

module.exports = { getDb };
