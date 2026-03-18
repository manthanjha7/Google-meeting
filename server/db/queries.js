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

async function markSlackPosted(id, threadTs = null) {
  const db = await getDb();
  db.run(
    `UPDATE meetings SET slack_posted = 1, slack_thread_ts = ?, updated_at = datetime('now') WHERE id = ?`,
    [threadTs, id]
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
  const likePattern = `%${query}%`;
  const stmt = db.prepare(`
    SELECT * FROM meetings
    WHERE transcript LIKE ? OR title LIKE ? OR meet_title LIKE ?
    ORDER BY created_at DESC
  `);
  stmt.bind([likePattern, likePattern, likePattern]);
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

function parseMeetingRow(row) {
  return {
    ...row,
    summary: row.summary ? JSON.parse(row.summary) : null,
    participants: row.participants ? JSON.parse(row.participants) : null,
    speakerNames: row.speaker_names ? JSON.parse(row.speaker_names) : null,
    slackPosted: Boolean(row.slack_posted),
  };
}

async function deleteMeeting(id) {
  const db = await getDb();
  const meeting = await getMeeting(id);
  db.run(`DELETE FROM meetings WHERE id = ?`, [id]);
  saveDb();
  return meeting;
}

async function getSettings() {
  const db = await getDb();
  const results = {};
  try {
    const stmt = db.prepare('SELECT key, value FROM settings');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results[row.key] = row.value;
    }
    stmt.free();
  } catch (e) { /* table may not exist yet */ }
  return results;
}

async function setSetting(key, value) {
  const db = await getDb();
  db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
  saveDb();
}

async function updateSpeakerNames(id, speakerNames) {
  const db = await getDb();
  const json = JSON.stringify(speakerNames);
  db.run(
    `UPDATE meetings SET speaker_names = ?, updated_at = datetime('now') WHERE id = ?`,
    [json, id]
  );
  saveDb();
  return getMeeting(id);
}

async function updateCalendarData(id, { eventId, attendees, description } = {}) {
  const db = await getDb();
  db.run(
    `UPDATE meetings SET calendar_event_id = ?, calendar_attendees = ?, calendar_description = ?, updated_at = datetime('now') WHERE id = ?`,
    [eventId || null, attendees ? JSON.stringify(attendees) : null, description || null, id]
  );
  saveDb();
  return getMeeting(id);
}

async function saveSegments(meetingId, segments) {
  const db = await getDb();
  // Clear existing segments for this meeting first
  db.run(`DELETE FROM transcript_segments WHERE meeting_id = ?`, [meetingId]);
  for (const seg of segments) {
    db.run(
      `INSERT INTO transcript_segments (meeting_id, speaker, text, start_time, end_time, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [meetingId, seg.speaker || null, seg.text, seg.startTime ?? null, seg.endTime ?? null, seg.confidence ?? null]
    );
  }
  saveDb();
}

async function getSegments(meetingId) {
  const db = await getDb();
  const stmt = db.prepare(
    `SELECT id, speaker, text, start_time, end_time, confidence FROM transcript_segments
     WHERE meeting_id = ? ORDER BY COALESCE(start_time, id)`
  );
  stmt.bind([meetingId]);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

async function listTemplates() {
  const db = await getDb();
  const templates = [];
  const stmt = db.prepare('SELECT * FROM summary_templates ORDER BY created_at ASC');
  while (stmt.step()) templates.push(stmt.getAsObject());
  stmt.free();

  for (const t of templates) {
    t.sections = [];
    const s = db.prepare('SELECT * FROM template_sections WHERE template_id = ? ORDER BY position ASC');
    s.bind([t.id]);
    while (s.step()) t.sections.push(s.getAsObject());
    s.free();
  }
  return templates;
}

async function getTemplate(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM summary_templates WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const t = stmt.getAsObject();
  stmt.free();
  t.sections = [];
  const s = db.prepare('SELECT * FROM template_sections WHERE template_id = ? ORDER BY position ASC');
  s.bind([id]);
  while (s.step()) t.sections.push(s.getAsObject());
  s.free();
  return t;
}

async function createTemplate(name, meetingContext = '') {
  const db = await getDb();
  const id = require('crypto').randomUUID();
  db.run('INSERT INTO summary_templates (id, name, meeting_context) VALUES (?, ?, ?)', [id, name, meetingContext]);
  saveDb();
  return getTemplate(id);
}

async function updateTemplate(id, name, meetingContext, sections = []) {
  const db = await getDb();
  db.run("UPDATE summary_templates SET name = ?, meeting_context = ?, updated_at = datetime('now') WHERE id = ?", [name, meetingContext, id]);
  db.run('DELETE FROM template_sections WHERE template_id = ?', [id]);
  sections.forEach((sec, i) => {
    db.run('INSERT INTO template_sections (id, template_id, title, prompt, position) VALUES (?, ?, ?, ?, ?)',
      [require('crypto').randomUUID(), id, sec.title, sec.prompt || '', i]);
  });
  saveDb();
  return getTemplate(id);
}

async function deleteTemplate(id) {
  const db = await getDb();
  db.run('DELETE FROM template_sections WHERE template_id = ?', [id]);
  db.run('DELETE FROM summary_templates WHERE id = ?', [id]);
  saveDb();
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
  deleteMeeting,
  getSettings,
  setSetting,
  updateSpeakerNames,
  saveSegments,
  getSegments,
  updateCalendarData,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
