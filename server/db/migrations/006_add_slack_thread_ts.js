module.exports = {
  id: '006_add_slack_thread_ts',
  up(db) {
    db.run(`ALTER TABLE meetings ADD COLUMN slack_thread_ts TEXT`);
  },
};
