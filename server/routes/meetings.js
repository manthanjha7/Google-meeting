const express = require('express');
const fs = require('fs');
const path = require('path');
const { listMeetings, getMeeting, searchMeetings, updateMeetTitle } = require('../db/queries');

const router = express.Router();

// GET /api/meetings
router.get('/', async (req, res) => {
  const { callType } = req.query;
  const meetings = await listMeetings(callType || null);
  res.json({ meetings });
});

// GET /api/meetings/search?q=keyword
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query (q) is required' });
  }
  try {
    const meetings = await searchMeetings(q.trim());
    res.json({ meetings, query: q.trim() });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// GET /api/meetings/:id
router.get('/:id', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  res.json({ meeting });
});

// GET /api/meetings/:id/transcript — returns just the transcript text
router.get('/:id/transcript', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  if (!meeting.transcript) {
    return res.status(404).json({ error: 'No transcript available for this meeting' });
  }

  // Support ?format=text for plain text response
  if (req.query.format === 'text') {
    res.type('text/plain').send(meeting.transcript);
    return;
  }

  res.json({
    meetingId: req.params.id,
    title: meeting.title,
    transcript: meeting.transcript,
    duration_seconds: meeting.duration_seconds,
    created_at: meeting.created_at,
  });
});

// GET /api/meetings/:id/export?format=txt|json
router.get('/:id/export', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  const format = req.query.format || 'txt';
  const title = meeting.title || meeting.meet_title || 'meeting';
  const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.json"`);
    res.json({
      id: meeting.id,
      title: meeting.title,
      meet_title: meeting.meet_title,
      meet_url: meeting.meet_url,
      call_type: meeting.call_type,
      duration_seconds: meeting.duration_seconds,
      created_at: meeting.created_at,
      transcript: meeting.transcript,
      summary: meeting.summary,
      participants: meeting.participants,
    });
    return;
  }

  // Default: TXT export
  let content = `Meeting: ${meeting.title || meeting.meet_title || 'Untitled'}\n`;
  content += `Date: ${meeting.created_at || 'Unknown'}\n`;
  if (meeting.meet_url) content += `URL: ${meeting.meet_url}\n`;
  if (meeting.duration_seconds) {
    const mins = Math.floor(meeting.duration_seconds / 60);
    const secs = meeting.duration_seconds % 60;
    content += `Duration: ${mins}m ${secs}s\n`;
  }
  if (meeting.call_type) content += `Call Type: ${meeting.call_type}\n`;
  content += `\n${'='.repeat(60)}\nTRANSCRIPT\n${'='.repeat(60)}\n\n`;
  content += meeting.transcript || '(No transcript available)';

  if (meeting.summary) {
    content += `\n\n${'='.repeat(60)}\nSUMMARY\n${'='.repeat(60)}\n\n`;
    content += meeting.summary.summary || '';
    if (meeting.summary.decisions?.length) {
      content += '\n\nKey Decisions:\n';
      meeting.summary.decisions.forEach((d) => { content += `  - ${d}\n`; });
    }
    if (meeting.summary.actionItems?.length) {
      content += '\nAction Items:\n';
      meeting.summary.actionItems.forEach((a) => { content += `  - ${a}\n`; });
    }
    if (meeting.summary.followUps?.length) {
      content += '\nFollow-ups:\n';
      meeting.summary.followUps.forEach((f) => { content += `  - ${f}\n`; });
    }
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.txt"`);
  res.send(content);
});

// GET /api/meetings/:id/audio — stream the audio file
router.get('/:id/audio', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  if (!meeting.audio_path || !fs.existsSync(meeting.audio_path)) {
    return res.status(404).json({ error: 'Audio file not found' });
  }

  const stat = fs.statSync(meeting.audio_path);
  const ext = path.extname(meeting.audio_path).toLowerCase();
  const mimeTypes = {
    '.webm': 'audio/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
  };

  res.setHeader('Content-Type', mimeTypes[ext] || 'audio/webm');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');

  // Support range requests for seeking
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(meeting.audio_path, { start, end }).pipe(res);
  } else {
    fs.createReadStream(meeting.audio_path).pipe(res);
  }
});

// PATCH /api/meetings/:id/title — update meeting title
router.patch('/:id/title', async (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  const meeting = await updateMeetTitle(req.params.id, title);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  res.json({ meeting });
});

module.exports = router;
