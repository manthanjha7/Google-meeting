const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'meetings.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db;

async function getDb() {
  if (!db) {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    // Enable WAL mode for better concurrent read/write performance
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA foreign_keys=ON');

    runMigrations();
  }
  return db;
}

function runMigrations() {
  // Create migrations tracking table if it doesn't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Get already-applied migrations
  const applied = new Set();
  const stmt = db.prepare('SELECT id FROM schema_migrations');
  while (stmt.step()) {
    applied.add(stmt.getAsObject().id);
  }
  stmt.free();

  // Load and run pending migrations in order
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    if (!applied.has(migration.id)) {
      console.log(`[DB] Running migration: ${migration.id}`);
      migration.up(db);
      db.run('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
      console.log(`[DB] Migration applied: ${migration.id}`);
    }
  }

  saveDb();
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error('[DB] Failed to save database to disk:', err);
  }
}

module.exports = { getDb, saveDb };
