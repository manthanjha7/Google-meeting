const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const SARVAM_BASE = 'https://api.sarvam.ai';
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

  const audioBuffer = fs.readFileSync(audioFilePath);
  const fileName = path.basename(audioFilePath);

  if (audioBuffer.length < 1000) {
    throw new Error(`Audio file too small (${audioBuffer.length} bytes) — recording may have failed`);
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
  try {
    const result = JSON.parse(resultText);

    // Log the full response structure for debugging
    console.log('[Sarvam] Response keys:', Object.keys(result));
    console.log('[Sarvam] Full response (first 2000 chars):', JSON.stringify(result).substring(0, 2000));

    // Sarvam batch API may return results in different structures
    // Check for array of segments (common batch format)
    const segments = result.diarized_transcript
      || result.diarized_segments
      || result.segments
      || result.utterances
      || result.results;

    if (Array.isArray(segments) && segments.length > 0) {
      console.log('[Sarvam] Found diarized segments:', segments.length, 'Sample:', JSON.stringify(segments[0]));
      return formatDiarizedTranscript(segments);
    }

    // Check if result itself is an array of segments
    if (Array.isArray(result) && result.length > 0 && (result[0].speaker || result[0].text || result[0].transcript)) {
      console.log('[Sarvam] Result is array of segments:', result.length);
      return formatDiarizedTranscript(result);
    }

    // If timestamps are available, format with time markers
    const timestamps = result.timestamps || result.words;
    if (Array.isArray(timestamps) && timestamps.length > 0) {
      return formatTimestampedTranscript(timestamps, result.transcript || result.text || '');
    }

    const plainTranscript = result.transcript || result.text || '';
    console.log('[Sarvam] Falling back to plain transcript, length:', plainTranscript.length);
    return plainTranscript;
  } catch (parseErr) {
    // If result is plain text, return as-is
    console.log('[Sarvam] Could not parse as JSON, returning raw text. Error:', parseErr.message);
    return resultText;
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
 * Format diarized transcript with speaker labels and timestamps.
 */
function formatDiarizedTranscript(segments) {
  const lines = [];
  let lastSpeaker = null;

  for (const seg of segments) {
    // Handle various field names from Sarvam API
    const speaker = seg.speaker || seg.speaker_id || seg.speaker_label || 'Unknown';
    const text = (seg.text || seg.transcript || seg.content || '').trim();
    if (!text) continue;

    // Handle various timestamp field names
    const startTime = seg.start_time ?? seg.start ?? seg.startTime ?? seg.begin ?? null;
    const timestamp = startTime != null
      ? `[${formatTime(startTime)}]`
      : '';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { transcribe };
