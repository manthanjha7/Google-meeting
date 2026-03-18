module.exports = {
  id: '011_template_prompt_field',
  up(db) {
    // Add a single `prompt` text column replacing the structured sections approach
    try { db.run('ALTER TABLE summary_templates ADD COLUMN prompt TEXT DEFAULT ""'); } catch(e) {}

    // Migrate existing structured templates → combine into one markdown prompt
    const stmt = db.prepare('SELECT id, name, meeting_context FROM summary_templates WHERE prompt IS NULL OR prompt = ""');
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    for (const t of rows) {
      const sections = [];
      const s = db.prepare('SELECT title, prompt as sprompt FROM template_sections WHERE template_id = ? ORDER BY position ASC');
      s.bind([t.id]);
      while (s.step()) sections.push(s.getAsObject());
      s.free();

      let prompt = t.meeting_context ? `${t.meeting_context}\n\n` : '';
      if (sections.length) {
        prompt += sections.map(sec => `## ${sec.title}\n${sec.sprompt}`).join('\n\n');
      }
      db.run('UPDATE summary_templates SET prompt = ? WHERE id = ?', [prompt.trim(), t.id]);
    }
  },
};
