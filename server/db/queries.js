const { getDb, saveDb } = require('./schema');

async function createMeeting(id, audioPath, durationSeconds = null, meetTitle = null, meetUrl = null) {
  const db = await getDb();
  db.run(
    `INSERT INTO meetings (id, audio_path, duration_seconds, meet_title, meet_url, title) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, audioPath, durationSeconds, meetTitle, meetUrl, meetTitle]
  );
  saveDb();
  return getMeeting(id);
}

async function updateTranscript(id, transcript) {
  const db = await getDb();
  db.run(
    `UPDATE meetings SET transcript = ?, updated_at = datetime('now') WHERE id = ?`,
    [transcript, id]
  );
  // Update FTS index
  rebuildFts();
  saveDb();
  return getMeeting(id);
}

async function updateSummary(id, summaryObj) {
  const db = await getDb();
  const summaryJson = JSON.stringify(summaryObj);
  const title = summaryObj.title || null;
  const participants = summaryObj.participants
    ? JSON.stringify(summaryObj.participants)
    : null;

  db.run(
    `UPDATE meetings SET summary = ?, title = ?, participants = ?, updated_at = datetime('now') WHERE id = ?`,
    [summaryJson, title, participants, id]
  );
  saveDb();
  return getMeeting(id);
}

async function updateCallType(id, callType) {
  const db = await getDb();
  db.run(
    `UPDATE meetings SET call_type = ?, updated_at = datetime('now') WHERE id = ?`,
    [callType, id]
  );
  saveDb();
  return getMeeting(id);
}

async function markSlackPosted(id) {
  const db = await getDb();
  db.run(
    `UPDATE meetings SET slack_posted = 1, updated_at = datetime('now') WHERE id = ?`,
    [id]
  );
  saveDb();
  return getMeeting(id);
}

async function getMeeting(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM meetings WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return parseMeetingRow(row);
  }
  stmt.free();
  return null;
}

async function listMeetings(callType = null) {
  const db = await getDb();
  let results = [];

  if (callType) {
    const stmt = db.prepare('SELECT * FROM meetings WHERE call_type = ? ORDER BY created_at DESC');
    stmt.bind([callType]);
    while (stmt.step()) {
      results.push(parseMeetingRow(stmt.getAsObject()));
    }
    stmt.free();
  } else {
    const stmt = db.prepare('SELECT * FROM meetings ORDER BY created_at DESC');
    while (stmt.step()) {
      results.push(parseMeetingRow(stmt.getAsObject()));
    }
    stmt.free();
  }

  return results;
}

async function searchMeetings(query) {
  const db = await getDb();
  const results = [];
  const stmt = db.prepare(`
    SELECT m.* FROM meetings m
    JOIN meetings_fts fts ON m.id = fts.id
    WHERE meetings_fts MATCH ?
    ORDER BY m.created_at DESC
  `);
  stmt.bind([query]);
  while (stmt.step()) {
    results.push(parseMeetingRow(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

async function updateMeetTitle(id, meetTitle) {
  const db = await getDb();
  db.run(
    `UPDATE meetings SET meet_title = ?, title = COALESCE(title, ?), updated_at = datetime('now') WHERE id = ?`,
    [meetTitle, meetTitle, id]
  );
  saveDb();
  return getMeeting(id);
}

function rebuildFts() {
  try {
    const db2 = db;
    db2.run(`DELETE FROM meetings_fts`);
    db2.run(`INSERT INTO meetings_fts(id, title, transcript) SELECT id, COALESCE(title,''), COALESCE(transcript,'') FROM meetings`);
  } catch (e) {
    console.warn('FTS rebuild warning:', e.message);
  }
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
  searchMeetings,
  updateMeetTitle,
  rebuildFts,
};
