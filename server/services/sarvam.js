const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const { stripSilenceFromWav } = require('./vad');

const SARVAM_BASE = 'https://api.sarvam.ai';
const SARVAM_SYNC_STT = `${SARVAM_BASE}/speech-to-text`;
const SARVAM_JOB_INIT = `${SARVAM_BASE}/speech-to-text/job/init`;
const SARVAM_JOB_START = `${SARVAM_BASE}/speech-to-text/job`;
const SARVAM_JOB_STATUS = (jobId) => `${SARVAM_BASE}/speech-to-text/job/${jobId}/status`;

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_POLL_TIME_MS = 10 * 60_000; // 10 minutes

/**
 * Transcribe an audio file using Sarvam Batch STT API.
 * Supports diarization and files up to 1 hour.
 */
async function transcribe(audioFilePath, { numSpeakers } = {}) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY not configured');

  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }

  let audioBuffer = fs.readFileSync(audioFilePath);
  const fileName = path.basename(audioFilePath);

  if (audioBuffer.length < 1000) {
    throw new Error(`Audio file too small (${audioBuffer.length} bytes) — recording may have failed`);
  }

  // Apply VAD: strip silence from WAV files to reduce API cost and improve quality
  const ext = path.extname(audioFilePath).toLowerCase();
  if (ext === '.wav') {
    try {
      const vadResult = stripSilenceFromWav(audioBuffer);
      if (vadResult.stripped) {
        console.log(`[Sarvam] VAD stripped silence: ${vadResult.stats.reductionPct}% reduction (${vadResult.stats.segments} speech segments)`);
        audioBuffer = vadResult.buffer;
      } else if (vadResult.stats) {
        console.log(`[Sarvam] VAD: minimal silence detected, using original audio`);
      }
    } catch (vadErr) {
      console.warn(`[Sarvam] VAD failed, using original audio:`, vadErr.message);
    }
  }

  const headers = {
    'API-Subscription-Key': apiKey,
    'Content-Type': 'application/json',
  };

  // Step 1: Initialize batch job
  const initRes = await fetch(SARVAM_JOB_INIT, {
    method: 'POST',
    headers,
  });

  if (!initRes.ok) {
    const errorText = await initRes.text();
    throw new Error(`Sarvam job init failed (${initRes.status}): ${errorText}`);
  }

  const initData = await initRes.json();
  const jobId = initData.job_id;
  const inputPath = initData.input_storage_path;
  const outputPath = initData.output_storage_path;

  if (!jobId || !inputPath) {
    throw new Error(`Sarvam job init returned unexpected data: ${JSON.stringify(initData)}`);
  }

  // Step 2: Upload audio file to Azure Blob Storage input path
  await uploadToAzureBlob(inputPath, audioBuffer, fileName);

  // Step 3: Start the job with diarization enabled
  const jobParameters = {
    language_code: 'unknown',
    model: 'saaras:v3',
    with_timestamps: true,
    with_diarization: true,
  };
  if (numSpeakers) {
    jobParameters.num_speakers = numSpeakers;
  }

  const startRes = await fetch(SARVAM_JOB_START, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      job_id: jobId,
      job_parameters: jobParameters,
    }),
  });

  if (!startRes.ok) {
    const errorText = await startRes.text();
    throw new Error(`Sarvam job start failed (${startRes.status}): ${errorText}`);
  }

  // Step 4: Poll for job completion
  const startTime = Date.now();
  let status = 'Pending';

  while (status !== 'Completed' && status !== 'Failed') {
    if (Date.now() - startTime > MAX_POLL_TIME_MS) {
      throw new Error(`Sarvam batch job timed out after ${MAX_POLL_TIME_MS / 60000} minutes (job: ${jobId})`);
    }

    await sleep(POLL_INTERVAL_MS);

    const statusRes = await fetch(SARVAM_JOB_STATUS(jobId), {
      method: 'GET',
      headers: { 'API-Subscription-Key': apiKey },
    });

    if (!statusRes.ok) {
      const errorText = await statusRes.text();
      throw new Error(`Sarvam job status failed (${statusRes.status}): ${errorText}`);
    }

    const statusData = await statusRes.json();
    status = statusData.job_state || statusData.status;
    console.log(`[Sarvam] Job ${jobId} status: ${status}`);
  }

  if (status === 'Failed') {
    throw new Error(`Sarvam batch job failed (job: ${jobId})`);
  }

  // Step 5: Download results from Azure Blob Storage output path
  const resultText = await downloadFromAzureBlob(outputPath);
  if (!resultText) {
    throw new Error('Sarvam batch job completed but no output found');
  }

  // Parse result — batch API returns JSON with transcript data
  //
  // Sarvam Batch STT response format (with diarization):
  // {
  //   "transcript": "full plain text...",
  //   "diarized_transcript": {
  //     "entries": [
  //       {
  //         "speaker_id": "SPEAKER_0",
  //         "transcript": "text segment",
  //         "start_time_seconds": 0.5,
  //         "end_time_seconds": 3.2,
  //         "confidence": 0.92       // optional
  //       },
  //       ...
  //     ]
  //   }
  // }
  try {
    const result = JSON.parse(resultText);

    console.log('[Sarvam] Response keys:', Object.keys(result));
    console.log('[Sarvam] Full response (first 2000 chars):', JSON.stringify(result).substring(0, 2000));

    // Primary: diarized_transcript.entries (Sarvam batch API format)
    if (result.diarized_transcript?.entries && Array.isArray(result.diarized_transcript.entries)) {
      const entries = result.diarized_transcript.entries;
      console.log('[Sarvam] Found diarized entries:', entries.length, 'Sample:', JSON.stringify(entries[0]));
      return formatDiarizedTranscript(entries);
    }

    // Fallback: diarized_transcript as direct array
    if (Array.isArray(result.diarized_transcript) && result.diarized_transcript.length > 0) {
      console.log('[Sarvam] Found diarized_transcript as array:', result.diarized_transcript.length);
      return formatDiarizedTranscript(result.diarized_transcript);
    }

    // Fallback: other possible segment array keys
    const segments = result.segments || result.utterances || result.results;
    if (Array.isArray(segments) && segments.length > 0) {
      console.log('[Sarvam] Found segments via fallback key:', segments.length);
      return formatDiarizedTranscript(segments);
    }

    // Fallback: result itself is an array of segments
    if (Array.isArray(result) && result.length > 0 && (result[0].speaker_id || result[0].speaker || result[0].transcript)) {
      console.log('[Sarvam] Result is array of segments:', result.length);
      return formatDiarizedTranscript(result);
    }

    // Fallback: timestamps without diarization
    const timestamps = result.timestamps || result.words;
    if (Array.isArray(timestamps) && timestamps.length > 0) {
      return formatTimestampedTranscript(timestamps, result.transcript || result.text || '');
    }

    const plainTranscript = result.transcript || result.text || '';
    console.log('[Sarvam] Falling back to plain transcript, length:', plainTranscript.length);
    return { transcript: plainTranscript, segments: [] };
  } catch (parseErr) {
    console.log('[Sarvam] Could not parse as JSON, returning raw text. Error:', parseErr.message);
    return { transcript: resultText, segments: [] };
  }
}

/**
 * Upload a file to Azure Blob Storage using a SAS URL.
 */
async function uploadToAzureBlob(sasUrl, fileBuffer, fileName) {
  const { accountUrl, containerName, directoryPath, sasToken } = parseAzureBlobUrl(sasUrl);

  const blobServiceClient = new BlobServiceClient(`${accountUrl}?${sasToken}`);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobPath = directoryPath ? `${directoryPath}/${fileName}` : fileName;
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
  };

  await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
    blobHTTPHeaders: { blobContentType: mimeTypes[ext] || 'audio/wav' },
  });
}

/**
 * Download all result files from Azure Blob Storage output path.
 */
async function downloadFromAzureBlob(sasUrl) {
  const { accountUrl, containerName, directoryPath, sasToken } = parseAzureBlobUrl(sasUrl);

  const blobServiceClient = new BlobServiceClient(`${accountUrl}?${sasToken}`);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  const jsonResults = [];
  const txtResults = [];
  const prefix = directoryPath ? `${directoryPath}/` : '';

  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    const blobClient = containerClient.getBlobClient(blob.name);
    const downloadRes = await blobClient.download(0);
    const chunks = [];
    for await (const chunk of downloadRes.readableStreamBody) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString('utf-8');
    console.log(`[Sarvam] Downloaded blob: ${blob.name} (${content.length} chars)`);

    if (blob.name.endsWith('.json')) {
      jsonResults.push(content);
    } else if (blob.name.endsWith('.txt')) {
      txtResults.push(content);
    }
  }

  // Prefer JSON results over text
  if (jsonResults.length > 0) return jsonResults[0];
  if (txtResults.length > 0) return txtResults[0];
  return null;
}

/**
 * Parse an Azure Blob Storage SAS URL into components.
 */
function parseAzureBlobUrl(url) {
  const urlObj = new URL(url);
  const accountUrl = `${urlObj.protocol}//${urlObj.host}`;
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const containerName = pathParts[0] || '';
  const directoryPath = pathParts.slice(1).join('/');
  const sasToken = urlObj.search.substring(1); // remove leading '?'

  return { accountUrl, containerName, directoryPath, sasToken };
}

/**
 * Compute a heuristic confidence score for a transcript segment.
 * Used when Sarvam doesn't provide an explicit confidence value.
 * Score range: 0.0 – 1.0
 */
function heuristicConfidence(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return 0.50; // very short = uncertain
  if (words.length < 4) return 0.65; // short = somewhat uncertain

  // High ratio of numbers / symbols → less confident
  const symbolRatio = (text.match(/[^a-zA-Z\u0900-\u097F\s]/g) || []).length / text.length;
  if (symbolRatio > 0.25) return 0.60;

  return 0.85; // default high confidence (Sarvam Saaras V3 is accurate)
}

/**
 * Format diarized transcript with speaker labels and timestamps.
 * Returns { transcript: string, segments: Array<{speaker, text, startTime, endTime, confidence}> }
 */
function formatDiarizedTranscript(entries) {
  const lines = [];
  const segments = [];
  let lastSpeaker = null;
  let lastSegmentIndex = -1;

  for (const entry of entries) {
    const speaker = entry.speaker_id || entry.speaker || entry.speaker_label || 'Unknown';
    const text = (entry.transcript || entry.text || entry.content || '').trim();
    if (!text) continue;

    const startTime = entry.start_time_seconds ?? entry.start_time ?? entry.start ?? null;
    const endTime = entry.end_time_seconds ?? entry.end_time ?? entry.end ?? null;
    const confidence = entry.confidence != null
      ? parseFloat(entry.confidence)
      : heuristicConfidence(text);

    const timestamp = startTime != null ? `[${formatTime(startTime)}]` : '';

    // Merge consecutive lines from same speaker into display string
    if (speaker === lastSpeaker && lines.length > 0) {
      lines[lines.length - 1] += ' ' + text;
      // Extend last segment
      if (lastSegmentIndex >= 0) {
        segments[lastSegmentIndex].text += ' ' + text;
        if (endTime != null) segments[lastSegmentIndex].endTime = endTime;
        // Average confidence
        segments[lastSegmentIndex].confidence =
          (segments[lastSegmentIndex].confidence + confidence) / 2;
      }
    } else {
      lines.push(`${timestamp} ${speaker}: ${text}`);
      segments.push({ speaker, text, startTime, endTime, confidence });
      lastSegmentIndex = segments.length - 1;
      lastSpeaker = speaker;
    }
  }

  return { transcript: lines.join('\n'), segments };
}

/**
 * Format transcript with timestamp markers.
 * Returns { transcript: string, segments: [] }
 */
function formatTimestampedTranscript(timestamps, fullTranscript) {
  if (!timestamps || timestamps.length === 0) return { transcript: fullTranscript, segments: [] };

  const lines = [];
  let currentLine = '';
  let lineStart = null;

  for (const ts of timestamps) {
    const word = ts.word || ts.text || '';
    if (lineStart === null) lineStart = ts.start_time || 0;
    currentLine += (currentLine ? ' ' : '') + word;

    if (currentLine.split(' ').length >= 15) {
      lines.push(`[${formatTime(lineStart)}] ${currentLine.trim()}`);
      currentLine = '';
      lineStart = null;
    }
  }

  if (currentLine.trim()) {
    lines.push(`[${formatTime(lineStart || 0)}] ${currentLine.trim()}`);
  }

  return { transcript: lines.join('\n'), segments: [] };
}

/**
 * Format seconds into MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transcribe a short audio clip using Sarvam's synchronous STT API.
 * Designed for live preview chunks (5-30 seconds).
 * No diarization — returns plain transcript text with detected language.
 * Uses codemix mode for Hindi-English switching support.
 *
 * @param {Buffer} audioBuffer - Raw audio bytes (WebM/Opus, WAV, etc.)
 * @param {string} filename - Original filename (used for MIME type detection)
 * @returns {{ transcript: string, languageCode: string }}
 */
async function transcribeLive(audioBuffer, filename = 'chunk.webm') {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY not configured');

  if (!audioBuffer || audioBuffer.length < 1000) {
    return { transcript: '', languageCode: 'unknown' };
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.webm': 'audio/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
  };
  const mimeType = mimeTypes[ext] || 'audio/webm';

  const { FormData, Blob } = require('node-fetch') || {};
  // Use native fetch (Node 18+) with FormData
  const formData = new (require('node:buffer') ? FormData : global.FormData)();
  // Build multipart form using native FormData (Node 18+)
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.append('model', 'saaras:v3');
  form.append('language_code', 'unknown');  // auto-detect Hindi/English/Hinglish
  form.append('mode', 'codemix');           // best for Hinglish code-switching

  const res = await fetch(SARVAM_SYNC_STT, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sarvam sync STT failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    transcript: data.transcript || '',
    languageCode: data.language_code || 'unknown',
  };
}

module.exports = { transcribe, transcribeLive };
