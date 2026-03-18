module.exports = {
  id: '008_add_summary_templates',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS summary_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        meeting_context TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS template_sections (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        FOREIGN KEY (template_id) REFERENCES summary_templates(id) ON DELETE CASCADE
      )
    `);
  }
};
