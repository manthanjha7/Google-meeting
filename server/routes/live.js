const express = require('express');
const { transcribeLive } = require('../services/sarvam');

const router = express.Router();

/**
 * POST /api/transcribe/live
 * Accepts a base64-encoded audio chunk (WebM, 5-30s) and returns a quick transcript.
 * Used for live preview during recording — no diarization, returns immediately.
 *
 * Body: { audioBase64: string, filename?: string }
 * Response: { transcript: string, languageCode: string }
 */
router.post('/', async (req, res) => {
  const { audioBase64, filename = 'chunk.webm' } = req.body;

  if (!audioBase64) {
    return res.status(400).json({ error: 'audioBase64 is required' });
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    if (audioBuffer.length < 1000) {
      return res.json({ transcript: '', languageCode: 'unknown' });
    }

    const result = await transcribeLive(audioBuffer, filename);
    res.json(result);
  } catch (err) {
    console.error('[Live transcribe] Error:', err.message);
    // Return empty transcript instead of error — live preview is best-effort
    res.json({ transcript: '', languageCode: 'unknown', error: err.message });
  }
});

module.exports = router;
