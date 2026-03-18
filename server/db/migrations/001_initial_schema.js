module.exports = {
  id: '001_initial_schema',
  up(db) {
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
  },
};
