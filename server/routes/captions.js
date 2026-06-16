const express = require('express');
const { getMeeting, saveCaptionSpans } = require('../db/queries');

const router = express.Router();

// POST /api/captions — store speaker-attributed caption spans scraped from Google Meet.
// Body: { meetingId, spans: [{ speaker, textSnippet, tStartMs, tEndMs, partNumber? }] }
// The extension sends the full set once (after upload, before transcription).
router.post('/', async (req, res) => {
  const { meetingId, spans } = req.body;

  if (!meetingId) return res.status(400).json({ error: 'meetingId is required' });
  if (!Array.isArray(spans)) return res.status(400).json({ error: 'spans must be an array' });

  const meeting = await getMeeting(meetingId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  try {
    await saveCaptionSpans(meetingId, spans);
    res.json({ meetingId, saved: spans.length });
  } catch (err) {
    console.error('Caption save error:', err);
    res.status(500).json({ error: `Failed to save captions: ${err.message}` });
  }
});

module.exports = router;
