const express = require('express');
const { getMeeting, updateTranscript, saveSegments } = require('../db/queries');
const { transcribe, transcribeChunkedSync } = require('../services/sarvam');
const { runSpeakerAutoMapping } = require('../services/speakerMapping');

const router = express.Router();

// GET /api/transcribe/retranscribe/stream?meetingId=...
// Server-Sent Events: streams chunked-sync transcription progress, then the final transcript.
// Fast (per-chunk sync STT) with real progress, but no speaker diarization.
router.get('/retranscribe/stream', async (req, res) => {
  const { meetingId } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!meetingId) { send('failed', { error: 'meetingId is required' }); return res.end(); }

  const meeting = await getMeeting(meetingId);
  if (!meeting) { send('failed', { error: 'Meeting not found' }); return res.end(); }
  if (!meeting.audio_path) { send('failed', { error: 'No audio file for this meeting' }); return res.end(); }

  const fs = require('fs');
  if (!fs.existsSync(meeting.audio_path)) { send('failed', { error: 'Audio file no longer exists on disk' }); return res.end(); }

  try {
    const result = await transcribeChunkedSync(meeting.audio_path, {
      onProgress: (done, total) => send('progress', { done, total }),
    });

    if (!result.transcript || result.transcript.trim().length === 0) {
      send('failed', { error: 'Transcription returned empty. The audio may be silent.' });
      return res.end();
    }

    await updateTranscript(meetingId, result.transcript);
    if (result.segments.length > 0) await saveSegments(meetingId, result.segments);

    send('done', { transcript: result.transcript, segmentCount: result.segments.length });
    res.end();
  } catch (err) {
    console.error('Streaming re-transcription error:', err);
    send('failed', { error: `Re-transcription failed: ${err.message}` });
    res.end();
  }
});

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
    const result = await transcribe(meeting.audio_path, { numSpeakers });
    const transcript = typeof result === 'string' ? result : result.transcript;
    const segments = typeof result === 'string' ? [] : (result.segments || []);

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({
        error: 'Transcription returned empty. The audio may be silent or too short. Ensure your microphone is enabled in the extension and try again.',
      });
    }

    await updateTranscript(meetingId, transcript);
    if (segments.length > 0) {
      await saveSegments(meetingId, segments);
      // Best-effort: auto-name speakers from Meet captions (no-op if none / single speaker).
      await runSpeakerAutoMapping(meetingId);
    }

    res.json({ meetingId, transcript, segmentCount: segments.length });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: `Transcription failed: ${err.message}` });
  }
});

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024; // 10MB

// POST /api/transcribe/update — merge/overwrite transcript for a meeting
// Used by chunked pipeline to combine transcripts from multiple audio chunks
router.post('/update', async (req, res) => {
  const { meetingId, transcript } = req.body;

  if (!meetingId || !transcript) {
    return res.status(400).json({ error: 'meetingId and transcript are required' });
  }

  if (Buffer.byteLength(transcript, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    return res.status(413).json({ error: 'Transcript exceeds maximum allowed size (10MB)' });
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
    const result = await transcribe(meeting.audio_path, { numSpeakers });
    const transcript = typeof result === 'string' ? result : result.transcript;
    const segments = typeof result === 'string' ? [] : (result.segments || []);

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({
        error: 'Re-transcription returned empty result.',
      });
    }

    await updateTranscript(meetingId, transcript);
    if (segments.length > 0) {
      await saveSegments(meetingId, segments);
      await runSpeakerAutoMapping(meetingId);
    }

    res.json({ meetingId, transcript, retranscribed: true, segmentCount: segments.length });
  } catch (err) {
    console.error('Re-transcription error:', err);
    res.status(500).json({ error: `Re-transcription failed: ${err.message}` });
  }
});

module.exports = router;
