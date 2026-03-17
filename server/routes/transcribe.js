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

// POST /api/transcribe/update — merge/overwrite transcript for a meeting
// Used by chunked pipeline to combine transcripts from multiple audio chunks
router.post('/update', async (req, res) => {
  const { meetingId, transcript } = req.body;

  if (!meetingId || !transcript) {
    return res.status(400).json({ error: 'meetingId and transcript are required' });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  try {
    await updateTranscript(meetingId, transcript);
    res.json({ meetingId, updated: true });
  } catch (err) {
    console.error('Transcript update error:', err);
    res.status(500).json({ error: `Transcript update failed: ${err.message}` });
  }
});

// POST /api/transcribe/retranscribe — re-run transcription on existing audio
router.post('/retranscribe', async (req, res) => {
  const { meetingId, numSpeakers } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'meetingId is required' });
  }

  const meeting = await getMeeting(meetingId);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }

  if (!meeting.audio_path) {
    return res.status(400).json({ error: 'No audio file stored for this meeting' });
  }

  const fs = require('fs');
  if (!fs.existsSync(meeting.audio_path)) {
    return res.status(400).json({ error: 'Audio file no longer exists on disk' });
  }

  try {
    const transcript = await transcribe(meeting.audio_path, { numSpeakers });

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({
        error: 'Re-transcription returned empty result.',
      });
    }

    await updateTranscript(meetingId, transcript);

    res.json({ meetingId, transcript, retranscribed: true });
  } catch (err) {
    console.error('Re-transcription error:', err);
    res.status(500).json({ error: `Re-transcription failed: ${err.message}` });
  }
});

module.exports = router;
