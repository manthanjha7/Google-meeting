module.exports = {
  id: '013_add_caption_spans',
  up(db) {
    // Speaker-attributed spans scraped from Google Meet's live captions.
    // Timestamps are milliseconds relative to the audio-recording start (audioT0).
    // Used to auto-map Sarvam's anonymous SPEAKER_x labels to real names via time-overlap voting.
    db.run(`
      CREATE TABLE IF NOT EXISTS caption_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        speaker TEXT,
        text_snippet TEXT,
        t_start_ms REAL,
        t_end_ms REAL,
        part_number INTEGER DEFAULT 1,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_caption_spans_meeting_id ON caption_spans(meeting_id)`);

    // Provenance + per-speaker confidence for the speaker_names map (JSON: { source, confidence }).
    try { db.run(`ALTER TABLE meetings ADD COLUMN speaker_names_meta TEXT`); } catch (e) { /* already exists */ }
  },
};
