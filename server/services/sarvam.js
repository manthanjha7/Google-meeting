const fs = require('fs');
const path = require('path');

const SARVAM_API_URL = 'https://api.sarvam.ai/speech-to-text';

/**
 * Transcribe an audio file using Sarvam STT API.
 * Optimized for Hindi-English code-switching.
 */
async function transcribe(audioFilePath) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY not configured');

  const audioBuffer = fs.readFileSync(audioFilePath);
  const fileName = path.basename(audioFilePath);

  // Sarvam API accepts audio via multipart form data
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), fileName);
  formData.append('model', 'saaras:v3');
  formData.append('language_code', 'unknown');
  formData.append('with_timestamps', 'false');

  const response = await fetch(SARVAM_API_URL, {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Sarvam STT failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return result.transcript || result.text || '';
}

/**
 * Transcribe a long audio file by splitting into chunks.
 * Sarvam API has limits on audio duration per request.
 */
async function transcribeLong(audioFilePath) {
  // For MVP, send the entire file. If it fails due to length,
  // the error will indicate the need for chunking.
  // Chunking implementation can be added in a follow-up iteration
  // using ffmpeg to split the audio file.
  return transcribe(audioFilePath);
}

module.exports = { transcribe, transcribeLong };
