const express = require('express');
const { getMeeting, updateSummary } = require('../db/queries');
const { summarize } = require('../services/summarizer');

const router = express.Router();

// POST /api/summarize
router.post('/', async (req, res) => {
  const { meetingId } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (!meeting.transcript) {
    return res.status(400).json({ error: 'No transcript available. Run transcription first.' });
  }

  try {
    const summary = await summarize(meeting.transcript);
    await updateSummary(meetingId, summary);

    res.json({ meetingId, summary });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ error: `Summarization failed: ${err.message}` });
  }
});

module.exports = router;
