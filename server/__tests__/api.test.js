/**
 * Integration tests for Finrep Meeting Intelligence API.
 *
 * External services (Sarvam STT, Azure OpenAI, Slack, VAD) are mocked.
 * Uses an in-memory SQLite DB — no credentials or disk state required.
 */

// ---- Mock external services BEFORE any module loads ----

jest.mock('../db/schema', () => {
  // Build in-memory DB inside the factory (no out-of-scope refs allowed by Jest)
  const SQL = require('sql.js');
  let _db = null;
  async function getDb() {
    if (_db) return _db;
    const SQLLib = await SQL();
    _db = new SQLLib.Database();
    _db.run(`CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, audio_path TEXT, title TEXT, meet_title TEXT,
      meet_url TEXT, call_type TEXT, duration_seconds INTEGER, transcript TEXT,
      summary TEXT, participants TEXT, speaker_names TEXT,
      slack_posted INTEGER DEFAULT 0, slack_thread_ts TEXT,
      calendar_event_id TEXT, calendar_attendees TEXT, calendar_description TEXT,
      user_id TEXT, user_name TEXT, visibility TEXT DEFAULT 'team', speaker_names_meta TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    _db.run(`CREATE TABLE IF NOT EXISTS caption_spans (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, speaker TEXT, text_snippet TEXT, t_start_ms REAL, t_end_ms REAL, part_number INTEGER DEFAULT 1)`);
    _db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    _db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    _db.run(`CREATE TABLE IF NOT EXISTS kb_documents (id TEXT PRIMARY KEY, filename TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
    _db.run(`CREATE TABLE IF NOT EXISTS kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chunk_text TEXT NOT NULL, embedding TEXT, chunk_index INTEGER)`);
    _db.run(`CREATE TABLE IF NOT EXISTS transcript_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, speaker TEXT, text TEXT, start_time REAL, end_time REAL, confidence REAL)`);
    return _db;
  }
  return { getDb, saveDb: () => {} };
});

jest.mock('../services/sarvam', () => ({
  transcribe: jest.fn().mockResolvedValue({
    transcript: '[00:00] SPEAKER_0: Hello this is a test meeting',
    segments: [{ speaker: 'SPEAKER_0', text: 'Hello this is a test meeting', startTime: 0, endTime: 5, confidence: 0.9 }],
  }),
  transcribeLive: jest.fn().mockResolvedValue({ transcript: 'live text', languageCode: 'en' }),
}));

jest.mock('../services/summarizer', () => ({
  summarize: jest.fn().mockResolvedValue({
    title: 'Test Meeting',
    summary: 'This was a test meeting',
    decisions: ['Decision 1'],
    actionItems: ['Action 1'],
    followUps: [],
    deadlines: [],
    nextSteps: [],
    participants: ['Alice', 'Bob'],
  }),
  summarizeStream: jest.fn().mockImplementation(async (transcript, extra, onChunk) => {
    onChunk(JSON.stringify({ title: 'Test', summary: 'Test summary', decisions: [], actionItems: [], followUps: [], deadlines: [], nextSteps: [], participants: [] }));
  }),
  detectSpeakerNames: jest.fn().mockResolvedValue({ SPEAKER_0: 'Alice', SPEAKER_1: 'Bob' }),
  buildClient: jest.fn().mockReturnValue({ client: {}, model: 'test-model' }),
}));

jest.mock('../services/slack', () => ({
  postToSlack: jest.fn().mockResolvedValue(true),
  postToSlackThread: jest.fn().mockResolvedValue({ threadTs: '12345.6789', channel: 'C123' }),
}));

jest.mock('../services/kb', () => ({
  ingestDocument: jest.fn().mockResolvedValue({ documentId: 'doc-1', chunkCount: 3 }),
  queryKb: jest.fn().mockResolvedValue({ answer: 'Test answer', chunks: [] }),
  listDocuments: jest.fn().mockResolvedValue([]),
  deleteDocument: jest.fn().mockResolvedValue(),
}));

jest.mock('../services/vad', () => ({
  detectSpeechSegments: jest.fn().mockResolvedValue([]),
  stripSilenceFromWav: jest.fn().mockReturnValue({ stripped: false, buffer: Buffer.from([]), stats: {} }),
}));

// ---- Build Express app ----

const request = require('supertest');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const uploadDir = '/tmp/finrep-test-uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
process.env.UPLOAD_DIR = uploadDir;

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/upload', require('../routes/upload'));
  app.use('/api/transcribe/live', require('../routes/live'));
  app.use('/api/transcribe', require('../routes/transcribe'));
  app.use('/api/summarize', require('../routes/summarize'));
  app.use('/api/slack', require('../routes/slack'));
  app.use('/api/meetings', require('../routes/meetings'));
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/analytics', require('../routes/analytics'));
  app.use('/api/kb', require('../routes/kb'));
  app.use('/api/calendar', require('../routes/calendar'));
  app.use('/api/captions', require('../routes/captions'));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  return app;
}

const app = buildApp();

// ---- Tests ----

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Settings API', () => {
  it('GET /api/settings returns settings object', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
  });

  it('POST /api/settings saves and retrieves settings', async () => {
    await request(app).post('/api/settings').send({ settings: { llm_provider: 'groq', defaultTemplate: 'standup' } });
    const res = await request(app).get('/api/settings');
    expect(res.body.settings.llm_provider).toBe('groq');
    expect(res.body.settings.defaultTemplate).toBe('standup');
  });
});

describe('Meetings API', () => {
  let meetingId;

  it('GET /api/meetings returns list', async () => {
    const res = await request(app).get('/api/meetings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.meetings)).toBe(true);
  });

  it('POST /api/upload creates a meeting record', async () => {
    const audioBuffer = Buffer.alloc(2000, 0x1a);
    const res = await request(app)
      .post('/api/upload')
      .field('durationSeconds', '60')
      .field('meetTitle', 'Test Meeting')
      .attach('audio', audioBuffer, { filename: 'test.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('meetingId');
    meetingId = res.body.meetingId;
  });

  it('GET /api/meetings/:id returns meeting', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}`);
    expect(res.status).toBe(200);
    expect(res.body.meeting.id).toBe(meetingId);
  });

  it('GET /api/meetings/:id/transcript returns 404 before transcription', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/transcript`);
    expect(res.status).toBe(404);
  });

  it('POST /api/transcribe saves transcript', async () => {
    const res = await request(app).post('/api/transcribe').send({ meetingId });
    expect(res.status).toBe(200);
    expect(res.body.transcript).toContain('SPEAKER_0');
  });

  it('GET /api/meetings/:id/transcript returns transcript', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/transcript`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toContain('SPEAKER_0');
  });

  it('GET /api/meetings/:id/segments returns confidence segments', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/segments`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.segments)).toBe(true);
  });

  it('POST /api/summarize generates summary', async () => {
    const res = await request(app).post('/api/summarize').send({ meetingId });
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('title');
  });

  it('PATCH /api/meetings/:id/title updates title', async () => {
    const res = await request(app).patch(`/api/meetings/${meetingId}/title`).send({ title: 'Updated Title' });
    expect(res.status).toBe(200);
    expect(res.body.meeting.meet_title).toBe('Updated Title');
  });

  it('GET /api/meetings/search finds meetings', async () => {
    const res = await request(app).get('/api/meetings/search?q=test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.meetings)).toBe(true);
  });

  it('GET /api/meetings/:id/export?format=txt returns text', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/export?format=txt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('GET /api/meetings/:id/export?format=md returns markdown', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.text).toMatch(/^#/);
  });

  it('GET /api/meetings/:id/export?format=pdf returns PDF', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/export?format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('GET /api/meetings/:id/export?format=json returns JSON', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/export?format=json`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
  });

  it('GET /api/meetings/:id/speaker-suggestions returns suggestions', async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/speaker-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('suggestions');
  });

  it('POST /api/meetings/:id/speakers saves speaker names', async () => {
    const res = await request(app).post(`/api/meetings/${meetingId}/speakers`).send({ speakerNames: { SPEAKER_0: 'Alice' } });
    expect(res.status).toBe(200);
  });

  it('DELETE /api/meetings/:id removes the meeting', async () => {
    const res = await request(app).delete(`/api/meetings/${meetingId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const check = await request(app).get(`/api/meetings/${meetingId}`);
    expect(check.status).toBe(404);
  });
});

describe('Analytics API', () => {
  it('GET /api/analytics returns stats', async () => {
    const res = await request(app).get('/api/analytics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalMeetings');
    expect(res.body).toHaveProperty('byCallType');
    expect(res.body).toHaveProperty('perDay');
    expect(res.body).toHaveProperty('topParticipants');
  });
});

describe('Knowledge Base API', () => {
  it('GET /api/kb/documents returns list', async () => {
    const res = await request(app).get('/api/kb/documents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.documents)).toBe(true);
  });

  it('POST /api/kb/ingest accepts text', async () => {
    const res = await request(app).post('/api/kb/ingest').send({ text: 'This is a test document.', filename: 'test.txt' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('documentId');
  });

  it('POST /api/kb/query returns answer', async () => {
    const res = await request(app).post('/api/kb/query').send({ question: 'What is this about?' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('answer');
  });
});

describe('Summarize templates API', () => {
  it('GET /api/summarize/templates returns template list', async () => {
    const res = await request(app).get('/api/summarize/templates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.some((t) => t.key === 'default')).toBe(true);
  });
});

describe('Live transcribe API', () => {
  it('POST /api/transcribe/live returns transcript', async () => {
    const audioBase64 = Buffer.alloc(2000).toString('base64');
    const res = await request(app).post('/api/transcribe/live').send({ audioBase64, filename: 'chunk.webm' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('transcript');
  });
});

describe('Calendar API', () => {
  it('POST /api/calendar/enrich returns 404 for unknown meeting', async () => {
    const res = await request(app).post('/api/calendar/enrich').send({ meetingId: 'nonexistent', title: 'Test', attendees: [] });
    expect(res.status).toBe(404);
  });
});

describe('Captions API + speaker auto-mapping', () => {
  const sarvam = require('../services/sarvam');
  let meetingId;

  it('POST /api/upload creates a meeting to caption', async () => {
    const res = await request(app)
      .post('/api/upload')
      .field('durationSeconds', '40')
      .attach('audio', Buffer.alloc(2000), { filename: 'cap.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    meetingId = res.body.meetingId;
  });

  it('POST /api/captions stores caption spans', async () => {
    const spans = [
      { speaker: 'Rahul', textSnippet: 'hi', tStartMs: 300, tEndMs: 9500 },
      { speaker: 'Priya', textSnippet: 'hello', tStartMs: 10500, tEndMs: 19000 },
    ];
    const res = await request(app).post('/api/captions').send({ meetingId, spans });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(2);
  });

  it('transcription auto-maps SPEAKER_x to caption names', async () => {
    // Two diarized speakers whose times overlap the caption spans above.
    sarvam.transcribe.mockResolvedValueOnce({
      transcript: '[00:00] SPEAKER_0: hi\n[00:10] SPEAKER_1: hello',
      segments: [
        { speaker: 'SPEAKER_0', text: 'hi', startTime: 0, endTime: 10, confidence: 0.9 },
        { speaker: 'SPEAKER_1', text: 'hello', startTime: 10, endTime: 19, confidence: 0.9 },
      ],
    });
    const tr = await request(app).post('/api/transcribe').send({ meetingId });
    expect(tr.status).toBe(200);

    const res = await request(app).get(`/api/meetings/${meetingId}`);
    expect(res.body.meeting.speakerNames).toEqual({ SPEAKER_0: 'Rahul', SPEAKER_1: 'Priya' });
    expect(res.body.meeting.speakerNamesMeta?.source).toBe('captions');
  });
});
