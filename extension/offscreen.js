// Offscreen document for audio capture and recording
// Required in Manifest V3 because service workers cannot use MediaRecorder
//
// NOTE: Offscreen documents only have access to chrome.runtime (not chrome.storage).
// All communication uses chrome.runtime.onMessage / sendMessage.
// A handshake (OFFSCREEN_READY) ensures messages aren't lost on first load.

// ---- Global error handler ----
self.addEventListener('unhandledrejection', (event) => {
  console.error('[Finrep] Unhandled rejection in offscreen:', event.reason);
  chrome.runtime.sendMessage({
    type: 'RECORDING_COMPLETE',
    audioBase64: null,
    error: 'Offscreen error: ' + (event.reason?.message || String(event.reason)),
  });
});

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let micStream = null;
let tabStream = null;
let analyserInterval = null;
let analyserNode = null;
let silentGain = null;
let isStarting = false; // Guard against double execution

// ---- Chunk-based recording for long meetings (>55 min) ----
const CHUNK_DURATION_MS = 55 * 60 * 1000; // 55 minutes per chunk
let chunkInterval = null;
let completedChunks = []; // Array of base64 audio strings
let recordingStream = null; // Persist across chunk boundaries

// ---- Message-based command listener ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  console.log('[Finrep] Received message:', message.type);

  switch (message.type) {
    case 'START_RECORDING':
      if (!isStarting && (!mediaRecorder || mediaRecorder.state === 'inactive')) {
        isStarting = true;
        startRecording(message.streamId, message.includeMic).finally(() => {
          isStarting = false;
        });
      } else {
        console.log('[Finrep] Ignoring duplicate start (already starting or recording)');
      }
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'CANCEL_RECORDING':
      cancelRecording();
      break;
  }
});

// Signal that the offscreen document is loaded and ready to receive commands.
// Background waits for this before sending START_RECORDING.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
console.log('[Finrep] Offscreen document loaded, sent OFFSCREEN_READY');

// ---- Recording ----

async function startRecording(streamId, includeMic = false) {
  try {
    // Capture tab audio stream
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    console.log('[Finrep] Tab audio stream acquired, tracks:', tabStream.getAudioTracks().length);

    // Create AudioContext and RESUME it — offscreen documents have no user gesture,
    // so the context starts suspended unless explicitly resumed.
    audioContext = new AudioContext();
    await audioContext.resume();
    console.log('[Finrep] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);

    const tabSource = audioContext.createMediaStreamSource(tabStream);

    // NOTE: In an offscreen document, audioContext.destination is headless (no speakers).
    // This connect() keeps the audio graph alive for the analyser. Tab audio remains
    // audible to the user because tab capture does NOT mute the tab.
    tabSource.connect(audioContext.destination);

    let analyserSource;

    if (includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        console.log('[Finrep] Microphone stream acquired');

        const micSource = audioContext.createMediaStreamSource(micStream);
        const mixedDestination = audioContext.createMediaStreamDestination();
        tabSource.connect(mixedDestination);
        micSource.connect(mixedDestination);

        recordingStream = mixedDestination.stream;
        analyserSource = audioContext.createMediaStreamSource(mixedDestination.stream);
        console.log('[Finrep] Recording with tab audio + microphone');
      } catch (micErr) {
        console.warn('[Finrep] Microphone access denied, falling back to tab audio only:', micErr.message);
        recordingStream = tabStream;
        analyserSource = tabSource;
      }
    } else {
      recordingStream = tabStream;
      analyserSource = tabSource;
      console.log('[Finrep] Recording tab audio only');
    }

    // Set up audio analyser for visualizer
    startAudioAnalyser(analyserSource);

    // Reset chunk state
    completedChunks = [];

    // Start the first recorder chunk
    startNewRecorderChunk();

    // Set up auto-chunking: every 55 minutes, finalize current chunk and start a new one
    chunkInterval = setInterval(() => {
      console.log(`[Finrep] Auto-chunking: finalizing chunk ${completedChunks.length + 1}, starting new chunk`);
      rotateChunk();
    }, CHUNK_DURATION_MS);

    console.log(`[Finrep] Recording started with auto-chunking every ${CHUNK_DURATION_MS / 60000} minutes`);
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
  } catch (err) {
    console.error('[Finrep] Recording error:', err);
    cleanupStreams();
    chrome.runtime.sendMessage({
      type: 'RECORDING_COMPLETE',
      audioBase64: null,
      error: err.message,
    });
  }
}

/**
 * Start a new MediaRecorder instance on the same stream.
 */
function startNewRecorderChunk() {
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(recordingStream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 64000,
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  // onstop is set dynamically by rotateChunk() or stopRecording()
  mediaRecorder.start(5000);
  console.log(`[Finrep] MediaRecorder chunk started. State: ${mediaRecorder.state}`);
}

/**
 * Finalize the current chunk and start recording a new one.
 * Used for auto-chunking long meetings.
 */
function rotateChunk() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

  // Capture current chunks before stopping
  const currentChunks = [...recordedChunks];

  mediaRecorder.onstop = async () => {
    const blob = new Blob(currentChunks, { type: 'audio/webm' });
    console.log(`[Finrep] Chunk ${completedChunks.length + 1} finalized: ${blob.size} bytes`);

    const base64 = await blobToBase64(blob);
    completedChunks.push(base64);

    // Start a new recorder on the same stream
    startNewRecorderChunk();
  };

  mediaRecorder.stop();
}

// ---- Audio Analyser ----

const DECAY_RATE = 0.82;
const NUM_BARS = 20;
const NOISE_FLOOR = 10;
let previousLevels = new Array(NUM_BARS).fill(0);

function startAudioAnalyser(sourceNode) {
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 512;
  analyserNode.smoothingTimeConstant = 0.5;
  analyserNode.minDecibels = -90;
  analyserNode.maxDecibels = -10;

  sourceNode.connect(analyserNode);

  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  analyserNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  const frequencyBinCount = analyserNode.frequencyBinCount;
  const frequencyData = new Uint8Array(frequencyBinCount);

  const sampleRate = audioContext.sampleRate;
  const binWidth = sampleRate / analyserNode.fftSize;
  const startBin = Math.max(1, Math.floor(85 / binWidth));
  const endBin = Math.min(frequencyBinCount - 1, Math.ceil(3500 / binWidth));
  const usableBins = endBin - startBin;
  const binsPerBar = Math.max(1, Math.floor(usableBins / NUM_BARS));

  console.log(`[Finrep] Analyser started: sampleRate=${sampleRate}, binWidth=${binWidth.toFixed(1)}Hz, voiceBins=${startBin}-${endBin}, binsPerBar=${binsPerBar}`);

  let tickCount = 0;

  analyserInterval = setInterval(() => {
    if (!analyserNode) return;

    analyserNode.getByteFrequencyData(frequencyData);

    tickCount++;
    if (tickCount % 50 === 1) {
      const slice = frequencyData.slice(startBin, endBin);
      const maxVal = Math.max(...slice);
      const avgVal = slice.reduce((a, b) => a + b, 0) / usableBins;
      console.log(`[Finrep] Audio levels — max: ${maxVal}, avg: ${avgVal.toFixed(1)}, context: ${audioContext?.state}`);
    }

    const levels = [];
    for (let i = 0; i < NUM_BARS; i++) {
      let sum = 0;
      const barStart = startBin + i * binsPerBar;
      for (let j = 0; j < binsPerBar; j++) {
        const val = frequencyData[barStart + j] || 0;
        sum += Math.max(0, val - NOISE_FLOOR);
      }

      const avg = sum / binsPerBar / (255 - NOISE_FLOOR);
      const scaled = Math.min(1, avg * 3.5);
      const smoothed = Math.max(scaled, previousLevels[i] * DECAY_RATE);
      levels.push(Math.round(smoothed * 100));
    }

    previousLevels = levels.map((l) => l / 100);

    const hasActivity = levels.some((l) => l > 2);
    // Send levels to background which writes them to storage for the popup
    chrome.runtime.sendMessage({
      type: 'AUDIO_LEVELS',
      levels: hasActivity ? levels : null,
    });
  }, 100);
}

function stopAudioAnalyser() {
  if (analyserInterval) {
    clearInterval(analyserInterval);
    analyserInterval = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }
  previousLevels = new Array(NUM_BARS).fill(0);
  // Notify background to clear levels
  chrome.runtime.sendMessage({ type: 'AUDIO_LEVELS', levels: null });
}

// ---- Shared Cleanup ----

function cleanupStreams() {
  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
    tabStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  recordingStream = null;
}

// ---- Recording Control ----

function stopRecording() {
  console.log('[Finrep] stopRecording called, mediaRecorder state:', mediaRecorder?.state);

  // Clear the auto-chunking timer
  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.onstop = async () => {
      stopAudioAnalyser();

      // Finalize the last chunk
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      recordedChunks = [];
      const lastChunkBase64 = await blobToBase64(blob);

      // Combine all chunks (completed + final)
      const allChunks = [...completedChunks, lastChunkBase64];
      completedChunks = [];

      const totalSize = allChunks.reduce((sum, b64) => sum + b64.length, 0);
      console.log(`[Finrep] Recording stopped. ${allChunks.length} chunk(s), total base64 size: ${totalSize}`);

      if (allChunks.length === 1) {
        // Single chunk — send as before for backward compatibility
        if (blob.size < 1000) {
          console.warn('[Finrep] Audio blob is very small, recording may be silent');
        }
        chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETE',
          audioBase64: allChunks[0],
        });
      } else {
        // Multiple chunks — send as array
        chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETE',
          audioChunks: allChunks,
          chunkCount: allChunks.length,
        });
      }

      cleanupStreams();
    };

    mediaRecorder.stop();
  } else {
    console.warn('[Finrep] stopRecording: no active MediaRecorder, sending empty completion');
    stopAudioAnalyser();
    cleanupStreams();
    mediaRecorder = null;
    completedChunks = [];
    chrome.runtime.sendMessage({
      type: 'RECORDING_COMPLETE',
      audioBase64: null,
      error: 'Recording was not active when stop was requested',
    });
  }
}

function cancelRecording() {
  console.log('[Finrep] cancelRecording called');

  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  stopAudioAnalyser();

  if (mediaRecorder) {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    mediaRecorder = null;
  }

  recordedChunks = [];
  completedChunks = [];
  cleanupStreams();
}

/**
 * Convert a Blob to base64 string (without data URL prefix).
 */
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}
