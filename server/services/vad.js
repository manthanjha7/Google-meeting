const fs = require('fs');
const path = require('path');

/**
 * Simple energy-based Voice Activity Detection.
 * Strips silence from audio before sending to Sarvam, reducing API cost
 * and improving transcript quality.
 *
 * Works on raw PCM data extracted from WAV files.
 * For WebM/Opus files, we skip VAD (Sarvam handles those directly).
 */

const FRAME_SIZE_MS = 30;        // 30ms frames (matches Silero VAD standard)
const ENERGY_THRESHOLD = 0.005;  // RMS energy threshold for speech
const MIN_SPEECH_MS = 250;       // Minimum speech segment to keep
const PADDING_MS = 300;          // Padding before/after speech
const REDEMPTION_MS = 1500;      // Bridge gaps shorter than this

/**
 * Analyze audio buffer and return speech segment boundaries.
 * Returns array of { startByte, endByte } for speech regions.
 */
function detectSpeechSegments(pcmBuffer, sampleRate, bytesPerSample, channels) {
  const frameSamples = Math.floor((sampleRate * FRAME_SIZE_MS) / 1000);
  const frameBytes = frameSamples * bytesPerSample * channels;
  const totalFrames = Math.floor(pcmBuffer.length / frameBytes);

  if (totalFrames === 0) return [{ startByte: 0, endByte: pcmBuffer.length }];

  // Calculate RMS energy per frame
  const energies = [];
  for (let i = 0; i < totalFrames; i++) {
    const offset = i * frameBytes;
    let sumSq = 0;
    const samples = frameSamples * channels;

    for (let j = 0; j < samples; j++) {
      const byteOffset = offset + j * bytesPerSample;
      let sample;
      if (bytesPerSample === 2) {
        sample = pcmBuffer.readInt16LE(byteOffset) / 32768;
      } else if (bytesPerSample === 4) {
        sample = pcmBuffer.readFloatLE(byteOffset);
      } else {
        sample = (pcmBuffer.readUInt8(byteOffset) - 128) / 128;
      }
      sumSq += sample * sample;
    }
    energies.push(Math.sqrt(sumSq / samples));
  }

  // Mark frames as speech/silence
  const isSpeech = energies.map((e) => e > ENERGY_THRESHOLD);

  // Apply redemption: bridge short gaps between speech segments
  const redemptionFrames = Math.ceil(REDEMPTION_MS / FRAME_SIZE_MS);
  for (let i = 0; i < isSpeech.length; i++) {
    if (!isSpeech[i]) {
      // Look ahead for speech within redemption window
      let foundSpeech = false;
      for (let j = 1; j <= redemptionFrames && i + j < isSpeech.length; j++) {
        if (isSpeech[i + j]) { foundSpeech = true; break; }
      }
      // Look behind for speech
      let hadSpeech = false;
      for (let j = 1; j <= redemptionFrames && i - j >= 0; j++) {
        if (isSpeech[i - j]) { hadSpeech = true; break; }
      }
      if (foundSpeech && hadSpeech) {
        isSpeech[i] = true; // Bridge the gap
      }
    }
  }

  // Extract contiguous speech segments
  const segments = [];
  let segStart = null;

  for (let i = 0; i <= isSpeech.length; i++) {
    if (i < isSpeech.length && isSpeech[i]) {
      if (segStart === null) segStart = i;
    } else {
      if (segStart !== null) {
        const durationMs = (i - segStart) * FRAME_SIZE_MS;
        if (durationMs >= MIN_SPEECH_MS) {
          // Add padding
          const padFrames = Math.ceil(PADDING_MS / FRAME_SIZE_MS);
          const startFrame = Math.max(0, segStart - padFrames);
          const endFrame = Math.min(totalFrames, i + padFrames);
          segments.push({
            startByte: startFrame * frameBytes,
            endByte: endFrame * frameBytes,
          });
        }
        segStart = null;
      }
    }
  }

  // If no speech detected, return entire buffer (don't strip everything)
  if (segments.length === 0) {
    return [{ startByte: 0, endByte: pcmBuffer.length }];
  }

  // Merge overlapping segments
  const merged = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    if (segments[i].startByte <= prev.endByte) {
      prev.endByte = Math.max(prev.endByte, segments[i].endByte);
    } else {
      merged.push(segments[i]);
    }
  }

  return merged;
}

/**
 * Parse a WAV file header and return metadata.
 */
function parseWavHeader(buffer) {
  if (buffer.length < 44) return null;
  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') return null;

  const format = buffer.toString('ascii', 8, 12);
  if (format !== 'WAVE') return null;

  // Find 'fmt ' chunk
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      const audioFormat = buffer.readUInt16LE(offset + 8);
      const channels = buffer.readUInt16LE(offset + 10);
      const sampleRate = buffer.readUInt32LE(offset + 12);
      const bitsPerSample = buffer.readUInt16LE(offset + 22);

      return {
        audioFormat,
        channels,
        sampleRate,
        bytesPerSample: bitsPerSample / 8,
        headerEnd: findDataChunk(buffer),
      };
    }
    offset += 8 + chunkSize;
  }
  return null;
}

function findDataChunk(buffer) {
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return { dataOffset: offset + 8, dataSize: chunkSize };
    }
    offset += 8 + chunkSize;
  }
  return null;
}

/**
 * Strip silence from a WAV file.
 * Returns a new Buffer with only speech segments, preserving WAV format.
 * Returns original buffer if not a WAV file or if VAD can't be applied.
 */
function stripSilenceFromWav(fileBuffer) {
  const header = parseWavHeader(fileBuffer);
  if (!header || !header.headerEnd) {
    console.log('[VAD] Not a WAV file or invalid header, skipping VAD');
    return { buffer: fileBuffer, stripped: false, stats: null };
  }

  const { channels, sampleRate, bytesPerSample } = header;
  const { dataOffset, dataSize } = header.headerEnd;
  const pcmData = fileBuffer.slice(dataOffset, dataOffset + dataSize);

  const originalDurationMs = (pcmData.length / (sampleRate * bytesPerSample * channels)) * 1000;

  const segments = detectSpeechSegments(pcmData, sampleRate, bytesPerSample, channels);

  // Concatenate speech segments
  const speechBuffers = segments.map((seg) =>
    pcmData.slice(seg.startByte, Math.min(seg.endByte, pcmData.length))
  );
  const speechPcm = Buffer.concat(speechBuffers);
  const strippedDurationMs = (speechPcm.length / (sampleRate * bytesPerSample * channels)) * 1000;

  const reductionPct = ((1 - speechPcm.length / pcmData.length) * 100).toFixed(1);

  console.log(`[VAD] Original: ${(originalDurationMs / 1000).toFixed(1)}s, Speech: ${(strippedDurationMs / 1000).toFixed(1)}s, Reduction: ${reductionPct}%, Segments: ${segments.length}`);

  // Only apply if we actually reduced something meaningful (>10%)
  if (speechPcm.length >= pcmData.length * 0.9) {
    return { buffer: fileBuffer, stripped: false, stats: { originalMs: originalDurationMs, speechMs: strippedDurationMs, segments: segments.length } };
  }

  // Rebuild WAV file with new PCM data
  const newWav = buildWav(speechPcm, channels, sampleRate, bytesPerSample * 8);

  return {
    buffer: newWav,
    stripped: true,
    stats: {
      originalMs: originalDurationMs,
      speechMs: strippedDurationMs,
      segments: segments.length,
      reductionPct: parseFloat(reductionPct),
    },
  };
}

/**
 * Build a WAV file buffer from raw PCM data.
 */
function buildWav(pcmBuffer, channels, sampleRate, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + pcmBuffer.length);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);           // chunk size
  buffer.writeUInt16LE(1, 20);            // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

module.exports = { stripSilenceFromWav };
