const fs = require('fs');
const path = require('path');

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_BATCH_URL = 'https://api.sarvam.ai/speech-to-text/batch';

/**
 * Transcribe an audio file using Sarvam STT REST API.
 * Enables timestamps and diarization for better accuracy.
 * REST API supports files up to ~30 seconds.
 */
async function transcribe(audioFilePath, { numSpeakers } = {}) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY not configured');

  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }

  const audioBuffer = fs.readFileSync(audioFilePath);
  const fileName = path.basename(audioFilePath);

  if (audioBuffer.length < 1000) {
    throw new Error(`Audio file too small (${audioBuffer.length} bytes) — recording may have failed`);
  }

  // Sarvam API accepts audio via multipart form data
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), fileName);
  formData.append('model', 'saaras:v3');
  formData.append('language_code', 'unknown');
  formData.append('with_timestamps', 'true');
  formData.append('with_diarization', 'true');
  if (numSpeakers) {
    formData.append('num_speakers', String(numSpeakers));
  }

  const response = await fetch(SARVAM_STT_URL, {
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

  // If diarized transcript is available, format it with speaker labels
  if (result.diarized_transcript && result.diarized_transcript.length > 0) {
    return formatDiarizedTranscript(result.diarized_transcript);
  }

  // If timestamps are available, format with time markers
  if (result.timestamps && result.timestamps.length > 0) {
    return formatTimestampedTranscript(result.timestamps, result.transcript || result.text || '');
  }

  return result.transcript || result.text || '';
}

/**
 * Format diarized transcript with speaker labels and timestamps.
 * Input: array of { speaker, text, start_time, end_time } segments
 */
function formatDiarizedTranscript(segments) {
  const lines = [];
  let lastSpeaker = null;

  for (const seg of segments) {
    const speaker = seg.speaker || 'Unknown';
    const text = (seg.text || seg.transcript || '').trim();
    if (!text) continue;

    const timestamp = seg.start_time != null
      ? `[${formatTime(seg.start_time)}]`
      : '';

    // Group consecutive segments from the same speaker
    if (speaker === lastSpeaker && lines.length > 0) {
      lines[lines.length - 1] += ' ' + text;
    } else {
      lines.push(`${timestamp} ${speaker}: ${text}`);
      lastSpeaker = speaker;
    }
  }

  return lines.join('\n');
}

/**
 * Format transcript with timestamp markers.
 */
function formatTimestampedTranscript(timestamps, fullTranscript) {
  if (!timestamps || timestamps.length === 0) return fullTranscript;

  const lines = [];
  let currentLine = '';
  let lineStart = null;

  for (const ts of timestamps) {
    const word = ts.word || ts.text || '';
    if (lineStart === null) lineStart = ts.start_time || 0;
    currentLine += (currentLine ? ' ' : '') + word;

    // Break into ~15-word segments for readability
    if (currentLine.split(' ').length >= 15) {
      lines.push(`[${formatTime(lineStart)}] ${currentLine.trim()}`);
      currentLine = '';
      lineStart = null;
    }
  }

  if (currentLine.trim()) {
    lines.push(`[${formatTime(lineStart || 0)}] ${currentLine.trim()}`);
  }

  return lines.join('\n');
}

/**
 * Format seconds into MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

module.exports = { transcribe };
