const express = require('express');
const { listMeetings, getMeeting } = require('../db/queries');

const router = express.Router();

// GET /api/meetings
router.get('/', async (req, res) => {
  const { callType } = req.query;
  const meetings = await listMeetings(callType || null);
  res.json({ meetings });
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

module.exports = router;
