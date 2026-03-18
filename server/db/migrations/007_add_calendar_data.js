module.exports = {
  id: '007_add_calendar_data',
  up(db) {
    db.run(`ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT`);
    db.run(`ALTER TABLE meetings ADD COLUMN calendar_attendees TEXT`);
    db.run(`ALTER TABLE meetings ADD COLUMN calendar_description TEXT`);
  },
};
