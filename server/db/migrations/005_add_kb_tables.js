module.exports = {
  id: '005_add_kb_tables',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding TEXT,
        chunk_index INTEGER,
        FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
      )
    `);
  },
};
