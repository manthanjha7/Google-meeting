const { getDb } = require('./schema');

function createMeeting(id, audioPath, durationSeconds = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO meetings (id, audio_path, duration_seconds)
    VALUES (?, ?, ?)
  `).run(id, audioPath, durationSeconds);
  return getMeeting(id);
}

function updateTranscript(id, transcript) {
  const db = getDb();
  db.prepare(`
    UPDATE meetings
    SET transcript = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(transcript, id);
  return getMeeting(id);
}

function updateSummary(id, summaryObj) {
  const db = getDb();
  const summaryJson = JSON.stringify(summaryObj);
  const title = summaryObj.title || null;
  const participants = summaryObj.participants
    ? JSON.stringify(summaryObj.participants)
    : null;

  db.prepare(`
    UPDATE meetings
    SET summary = ?, title = ?, participants = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(summaryJson, title, participants, id);
  return getMeeting(id);
}

function updateCallType(id, callType) {
  const db = getDb();
  db.prepare(`
    UPDATE meetings
    SET call_type = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(callType, id);
  return getMeeting(id);
}

function markSlackPosted(id) {
  const db = getDb();
  db.prepare(`
    UPDATE meetings
    SET slack_posted = 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return getMeeting(id);
}

function getMeeting(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!row) return null;
  return parseMeetingRow(row);
}

function listMeetings(callType = null) {
  const db = getDb();
  let query = 'SELECT * FROM meetings';
  const params = [];

  if (callType) {
    query += ' WHERE call_type = ?';
    params.push(callType);
  }

  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params);
  return rows.map(parseMeetingRow);
}

function parseMeetingRow(row) {
  return {
    ...row,
    summary: row.summary ? JSON.parse(row.summary) : null,
    participants: row.participants ? JSON.parse(row.participants) : null,
    slackPosted: Boolean(row.slack_posted),
  };
}

module.exports = {
  createMeeting,
  updateTranscript,
  updateSummary,
  updateCallType,
  markSlackPosted,
  getMeeting,
  listMeetings,
};
