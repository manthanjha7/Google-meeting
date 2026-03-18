module.exports = {
  id: '002_add_settings',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  },
};
