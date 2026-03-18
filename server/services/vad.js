const path = require('path');

// Silero VAD v5 using onnxruntime-node
// Model input: float32 audio [1, FRAME_SAMPLES] at 16kHz
// State input: float32 [2, 1, 128] (GRU state, zeros to start)
// Sr input: int64 [1] = 16000
// Output: float probability [1, 1], new state [2, 1, 128]

const MODEL_PATH = path.join(__dirname, '..', 'models', 'silero_vad.onnx');
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;           // 32ms at 16kHz (Silero v5 uses 512)
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;

// VAD thresholds — tuned for Hindi/Hinglish meeting audio
const SPEECH_THRESHOLD = 0.5;        // Probability above this = speech
const SILENCE_THRESHOLD = 0.35;      // Probability below this = silence (hysteresis)
const MIN_SPEECH_FRAMES = 8;         // ~256ms minimum speech segment
const REDEMPTION_FRAMES = 60;        // ~1920ms — bridge silences this short
const PADDING_FRAMES = 10;           // ~320ms padding before/after speech

let session = null;

async function getSession() {
  if (!session) {
    const ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(MODEL_PATH);
  }
  return session;
}

/**
 * Run Silero VAD on a Float32Array of 16kHz mono PCM samples.
 * Returns array of { startSample, endSample } speech segments.
 */
async function detectSpeechSegments(samples) {
  const ort = require('onnxruntime-node');
  const sess = await getSession();

  const numFrames = Math.floor(samples.length / FRAME_SAMPLES);
  if (numFrames === 0) return [{ startSample: 0, endSample: samples.length }];

  // Initial GRU state: zeros [2, 1, 128]
  let state = new Float32Array(2 * 1 * 128);
  const sr = new BigInt64Array([BigInt(SAMPLE_RATE)]);

  const probabilities = [];

  for (let i = 0; i < numFrames; i++) {
    const frame = samples.slice(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES);

    const inputTensor = new ort.Tensor('float32', frame, [1, FRAME_SAMPLES]);
    const stateTensor = new ort.Tensor('float32', state, [2, 1, 128]);
    const srTensor = new ort.Tensor('int64', sr, [1]);

    const results = await sess.run({ input: inputTensor, state: stateTensor, sr: srTensor });
    const prob = results.output.data[0];
    state = results.stateN.data;
    probabilities.push(prob);
  }

  // Hysteresis-based speech detection
  const isSpeech = new Array(numFrames).fill(false);
  let speaking = false;
  for (let i = 0; i < numFrames; i++) {
    if (!speaking && probabilities[i] >= SPEECH_THRESHOLD) {
      speaking = true;
    } else if (speaking && probabilities[i] < SILENCE_THRESHOLD) {
      speaking = false;
    }
    isSpeech[i] = speaking;
  }

  // Apply redemption: bridge short silences between speech
  let silenceCount = 0;
  for (let i = 0; i < numFrames; i++) {
    if (isSpeech[i]) {
      silenceCount = 0;
    } else {
      silenceCount++;
      if (silenceCount <= REDEMPTION_FRAMES) {
        // Check if speech resumes within redemption window
        let speechReturns = false;
        for (let j = i + 1; j < Math.min(i + REDEMPTION_FRAMES, numFrames); j++) {
          if (isSpeech[j]) { speechReturns = true; break; }
        }
        if (speechReturns) isSpeech[i] = true;
      }
    }
  }

  // Extract segments, apply padding, filter short segments
  const segments = [];
  let segStart = null;

  for (let i = 0; i <= numFrames; i++) {
    if (i < numFrames && isSpeech[i]) {
      if (segStart === null) segStart = i;
    } else {
      if (segStart !== null) {
        const durationFrames = i - segStart;
        if (durationFrames >= MIN_SPEECH_FRAMES) {
          const paddedStart = Math.max(0, segStart - PADDING_FRAMES);
          const paddedEnd = Math.min(numFrames, i + PADDING_FRAMES);
          segments.push({
            startSample: paddedStart * FRAME_SAMPLES,
            endSample: paddedEnd * FRAME_SAMPLES,
          });
        }
        segStart = null;
      }
    }
  }

  if (segments.length === 0) return [{ startSample: 0, endSample: samples.length }];

  // Merge overlapping segments
  const merged = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    if (segments[i].startSample <= prev.endSample) {
      prev.endSample = Math.max(prev.endSample, segments[i].endSample);
    } else {
      merged.push(segments[i]);
    }
  }

  return merged;
}

/**
 * Resample PCM samples from srcRate to 16000 Hz (linear interpolation).
 */
function resampleTo16k(samples, srcRate) {
  if (srcRate === SAMPLE_RATE) return samples;
  const ratio = srcRate / SAMPLE_RATE;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

/**
 * Downmix multi-channel PCM to mono by averaging channels.
 */
function toMono(samples, channels) {
  if (channels === 1) return samples;
  const mono = new Float32Array(samples.length / channels);
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += samples[i * channels + c];
    }
    mono[i] = sum / channels;
  }
  return mono;
}

// ---- WAV Parser ----

function parseWavHeader(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmtInfo = null;
  let dataInfo = null;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      fmtInfo = {
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    } else if (chunkId === 'data') {
      dataInfo = { dataOffset: offset + 8, dataSize: chunkSize };
    }

    offset += 8 + chunkSize;
    if (fmtInfo && dataInfo) break;
  }

  if (!fmtInfo || !dataInfo) return null;
  return { ...fmtInfo, ...dataInfo };
}

function buildWav(pcmBuffer, channels, sampleRate, bitsPerSample) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44 + pcmBuffer.length);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcmBuffer.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(buf, 44);
  return buf;
}

/**
 * Convert WAV PCM buffer (int16/int32/uint8) to Float32Array.
 */
function pcmBufferToFloat32(pcmBuffer, bitsPerSample, channels, sampleRate) {
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(pcmBuffer.length / bytesPerSample);
  const float32 = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const offset = i * bytesPerSample;
    if (bitsPerSample === 16) {
      float32[i] = pcmBuffer.readInt16LE(offset) / 32768;
    } else if (bitsPerSample === 32) {
      float32[i] = pcmBuffer.readFloatLE(offset);
    } else {
      float32[i] = (pcmBuffer.readUInt8(offset) - 128) / 128;
    }
  }

  return float32;
}

/**
 * Strip silence from a WAV file using Silero VAD.
 * Returns { buffer, stripped, stats }.
 */
async function stripSilenceFromWav(fileBuffer) {
  const header = parseWavHeader(fileBuffer);
  if (!header) {
    return { buffer: fileBuffer, stripped: false, stats: null };
  }

  const { channels, sampleRate, bitsPerSample, dataOffset, dataSize } = header;
  const pcmData = fileBuffer.slice(dataOffset, dataOffset + dataSize);

  const originalDurationMs = (pcmData.length / (sampleRate * (bitsPerSample / 8) * channels)) * 1000;

  try {
    // Convert PCM to float32 mono at 16kHz for Silero
    let samples = pcmBufferToFloat32(pcmData, bitsPerSample, channels, sampleRate);
    samples = toMono(samples, channels);
    samples = resampleTo16k(samples, sampleRate);

    const segments = await detectSpeechSegments(samples);

    // Convert sample-level segments back to byte offsets in original PCM
    const samplesPerOriginalByte = 1 / ((bitsPerSample / 8) * channels);
    const resampleRatio = sampleRate / SAMPLE_RATE;

    const speechBuffers = segments.map((seg) => {
      // Map 16kHz sample indices back to original PCM bytes
      const origStartSample = Math.floor(seg.startSample * resampleRatio);
      const origEndSample = Math.ceil(seg.endSample * resampleRatio);
      const startByte = origStartSample * (bitsPerSample / 8) * channels;
      const endByte = Math.min(origEndSample * (bitsPerSample / 8) * channels, pcmData.length);
      return pcmData.slice(startByte, endByte);
    });

    const speechPcm = Buffer.concat(speechBuffers);
    const strippedDurationMs = (speechPcm.length / (sampleRate * (bitsPerSample / 8) * channels)) * 1000;
    const reductionPct = ((1 - speechPcm.length / pcmData.length) * 100).toFixed(1);

    console.log(`[VAD/Silero] Original: ${(originalDurationMs / 1000).toFixed(1)}s, Speech: ${(strippedDurationMs / 1000).toFixed(1)}s, Reduction: ${reductionPct}%, Segments: ${segments.length}`);

    if (speechPcm.length >= pcmData.length * 0.9) {
      return { buffer: fileBuffer, stripped: false, stats: { originalMs: originalDurationMs, speechMs: strippedDurationMs, segments: segments.length, reductionPct: parseFloat(reductionPct) } };
    }

    const newWav = buildWav(speechPcm, channels, sampleRate, bitsPerSample);
    return {
      buffer: newWav,
      stripped: true,
      stats: { originalMs: originalDurationMs, speechMs: strippedDurationMs, segments: segments.length, reductionPct: parseFloat(reductionPct) },
    };
  } catch (err) {
    console.warn('[VAD/Silero] VAD failed, using original audio:', err.message);
    return { buffer: fileBuffer, stripped: false, stats: null };
  }
}

module.exports = { stripSilenceFromWav };
