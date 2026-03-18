module.exports = {
  id: '010_add_user_identity',
  up(db) {
    // Add user identity + visibility to meetings
    try { db.run('ALTER TABLE meetings ADD COLUMN user_id TEXT'); } catch(e) {}
    try { db.run('ALTER TABLE meetings ADD COLUMN user_name TEXT'); } catch(e) {}
    try { db.run("ALTER TABLE meetings ADD COLUMN visibility TEXT DEFAULT 'private'"); } catch(e) {}

    // Add creator info to templates
    try { db.run('ALTER TABLE summary_templates ADD COLUMN created_by_id TEXT'); } catch(e) {}
    try { db.run('ALTER TABLE summary_templates ADD COLUMN created_by_name TEXT'); } catch(e) {}

    // Existing meetings (no user_id) get visibility='team' so everyone can still see them
    db.run("UPDATE meetings SET visibility = 'team' WHERE user_id IS NULL");
    // Default templates from seed migration: mark as system templates
    db.run("UPDATE summary_templates SET created_by_name = 'System' WHERE created_by_id IS NULL");
  }
};
