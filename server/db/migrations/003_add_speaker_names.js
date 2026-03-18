module.exports = {
  id: '003_add_speaker_names',
  up(db) {
    // Store speaker label → real name mapping per meeting (JSON object)
    try { db.run(`ALTER TABLE meetings ADD COLUMN speaker_names TEXT`); } catch (e) { /* already exists */ }
  },
};
