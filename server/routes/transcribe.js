const express = require('express');
const { getMeeting, updateTranscript } = require('../db/queries');
const { transcribe } = require('../services/sarvam');

const router = express.Router();

// POST /api/transcribe
router.post('/', async (req, res) => {
  const { meetingId, numSpeakers } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (!meeting.audio_path) {
    return res.status(400).json({ error: 'No audio file for this meeting' });
  }

  try {
    const transcript = await transcribe(meeting.audio_path, { numSpeakers });

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({
        error: 'Transcription returned empty. The audio may be silent or too short. Ensure your microphone is enabled in the extension and try again.',
      });
    }

    await updateTranscript(meetingId, transcript);

    res.json({ meetingId, transcript });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: `Transcription failed: ${err.message}` });
  }
});

module.exports = router;
