module.exports = {
  id: '004_add_transcript_segments',
  up(db) {
    // Store structured transcript segments with confidence scores
    db.run(`
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        speaker TEXT,
        text TEXT,
        start_time REAL,
        end_time REAL,
        confidence REAL,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_segments_meeting_id ON transcript_segments(meeting_id)`);
  },
};
