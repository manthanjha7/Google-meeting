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
let micAnalyserNode = null;   // Separate analyser for mic levels
let tabAnalyserNode = null;   // Separate analyser for tab levels
let silentGain = null;
let tabGainNode = null;       // For ducking control
let duckingInterval = null;   // For RMS-based ducking loop
let isStarting = false; // Guard against double execution

// ---- Chunk-based recording for long meetings ----
// Default 55 minutes; configurable via START_RECORDING message
let CHUNK_DURATION_MS = 55 * 60 * 1000;
let chunkInterval = null;
let completedChunks = []; // Array of base64 audio strings
let recordingStream = null; // Persist across chunk boundaries

// ---- IndexedDB: incremental audio chunk persistence for crash recovery ----

const IDB_NAME = 'finrep-recording';
const IDB_STORE = 'chunks';
let idb = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getIdb() {
  if (!idb) idb = await openIdb();
  return idb;
}

async function appendChunkToIdb(base64) {
  try {
    const db = await getIdb();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).add({ base64, ts: Date.now() });
  } catch (e) {
    console.warn('[Finrep] IDB write failed:', e.message);
  }
}

async function clearIdb() {
  try {
    const db = await getIdb();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
  } catch (e) {
    console.warn('[Finrep] IDB clear failed:', e.message);
  }
}

async function getAllIdbChunks() {
  try {
    const db = await getIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result.map(r => r.base64));
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

// ---- Live transcript: second recorder for 15-second preview chunks ----
const LIVE_CHUNK_MS = 15000; // 15 seconds per live preview chunk
let liveRecorder = null;
let liveChunkInterval = null;
let isLiveRecording = false;

// ---- Message-based command listener ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  console.log('[Finrep] Received message:', message.type);

  switch (message.type) {
    case 'START_RECORDING':
      if (!isStarting && (!mediaRecorder || mediaRecorder.state === 'inactive')) {
        isStarting = true;
        // Allow configurable chunk duration (in minutes)
        if (message.chunkDurationMin) {
          CHUNK_DURATION_MS = message.chunkDurationMin * 60 * 1000;
        }
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

    /**
     * Audio processing chain per source:
     * source -> noiseGate -> highpass (100Hz) -> compressor -> output
     *
     * Noise gate: Expander that attenuates signals below threshold,
     * reducing background noise (fans, typing, hum) during silence.
     */
    function createProcessedSource(source) {
      // Noise gate via expander: very low threshold compressor that acts as gate
      // We use a gain node + analyser to implement a simple noise gate
      const gateGain = audioContext.createGain();
      gateGain.gain.value = 1.0;

      // High-pass filter at 100Hz to remove low-frequency hum/rumble
      const hp = audioContext.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 100;
      hp.Q.value = 0.7;

      // Notch filter at 50Hz to remove mains hum
      const notch = audioContext.createBiquadFilter();
      notch.type = 'notch';
      notch.frequency.value = 50;
      notch.Q.value = 10;

      // Compressor for loudness normalization
      const comp = audioContext.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;

      source.connect(gateGain);
      gateGain.connect(notch);
      notch.connect(hp);
      hp.connect(comp);
      return { output: comp, gateGain };
    }

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

        // Process both sources
        const processedTab = createProcessedSource(tabSource);
        const processedMic = createProcessedSource(micSource);

        // ---- Audio ducking ----
        // When mic is loud, reduce tab volume so user's voice isn't drowned out
        tabGainNode = audioContext.createGain();
        tabGainNode.gain.value = 1.0;
        processedTab.output.connect(tabGainNode);
        tabGainNode.connect(mixedDestination);
        processedMic.output.connect(mixedDestination);

        // Set up per-source analysers for separate level monitoring
        micAnalyserNode = audioContext.createAnalyser();
        micAnalyserNode.fftSize = 256;
        micAnalyserNode.smoothingTimeConstant = 0.3;
        processedMic.output.connect(micAnalyserNode);

        tabAnalyserNode = audioContext.createAnalyser();
        tabAnalyserNode.fftSize = 256;
        tabAnalyserNode.smoothingTimeConstant = 0.3;
        processedTab.output.connect(tabAnalyserNode);

        // Start RMS-based ducking loop
        startDuckingLoop();

        // Start noise gate loop for mic (suppress mic when silent)
        startNoiseGateLoop(micSource, processedMic.gateGain);

        recordingStream = mixedDestination.stream;
        analyserSource = audioContext.createMediaStreamSource(mixedDestination.stream);
        console.log('[Finrep] Recording with tab + mic (ducking + noise gate + quality filters)');
      } catch (micErr) {
        console.warn('[Finrep] Microphone access denied, falling back to tab audio only:', micErr.message);
        const processedTab = createProcessedSource(tabSource);
        const dest = audioContext.createMediaStreamDestination();
        processedTab.output.connect(dest);
        recordingStream = dest.stream;
        analyserSource = audioContext.createMediaStreamSource(dest.stream);
      }
    } else {
      const processedTab = createProcessedSource(tabSource);
      const dest = audioContext.createMediaStreamDestination();
      processedTab.output.connect(dest);
      recordingStream = dest.stream;
      analyserSource = audioContext.createMediaStreamSource(dest.stream);
      console.log('[Finrep] Recording tab audio only (with quality filters)');
    }

    // Set up combined audio analyser for main visualizer
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

    // Start live transcript preview recorder (separate from main recorder)
    startLiveChunkRecorder();
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
      // Persist each chunk to IDB for crash recovery
      blobToBase64(event.data).then((b64) => appendChunkToIdb(b64));
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

// ---- Audio Ducking (RMS-based) ----

const DUCK_THRESHOLD = 0.02;    // Mic RMS above this triggers ducking
const DUCK_RATIO = 0.3;         // Reduce tab to 30% when ducking
const DUCK_ATTACK_MS = 50;      // Time to duck down
const DUCK_RELEASE_MS = 300;    // Time to release duck

function startDuckingLoop() {
  if (!micAnalyserNode || !tabGainNode) return;

  const micData = new Float32Array(micAnalyserNode.fftSize);

  duckingInterval = setInterval(() => {
    if (!micAnalyserNode || !tabGainNode || !audioContext) return;

    micAnalyserNode.getFloatTimeDomainData(micData);

    // Calculate RMS of mic signal
    let sumSq = 0;
    for (let i = 0; i < micData.length; i++) {
      sumSq += micData[i] * micData[i];
    }
    const micRms = Math.sqrt(sumSq / micData.length);

    const now = audioContext.currentTime;
    if (micRms > DUCK_THRESHOLD) {
      // Mic is active — duck tab audio
      tabGainNode.gain.cancelScheduledValues(now);
      tabGainNode.gain.setTargetAtTime(DUCK_RATIO, now, DUCK_ATTACK_MS / 1000);
    } else {
      // Mic is quiet — restore tab audio
      tabGainNode.gain.cancelScheduledValues(now);
      tabGainNode.gain.setTargetAtTime(1.0, now, DUCK_RELEASE_MS / 1000);
    }
  }, 50); // 50ms polling = 20Hz
}

function stopDuckingLoop() {
  if (duckingInterval) {
    clearInterval(duckingInterval);
    duckingInterval = null;
  }
  tabGainNode = null;
}

// ---- Noise Gate (for mic) ----
// Attenuates mic input when below RMS threshold to suppress background noise

const GATE_THRESHOLD = 0.008;   // Below this RMS, gate closes
const GATE_OPEN_GAIN = 1.0;
const GATE_CLOSED_GAIN = 0.05;  // Not fully muted — preserves natural ambience
const GATE_ATTACK_MS = 10;
const GATE_RELEASE_MS = 100;

let noiseGateInterval = null;

function startNoiseGateLoop(micSource, gateGainNode) {
  const gateAnalyser = audioContext.createAnalyser();
  gateAnalyser.fftSize = 256;
  micSource.connect(gateAnalyser);

  const gateData = new Float32Array(gateAnalyser.fftSize);

  noiseGateInterval = setInterval(() => {
    if (!gateAnalyser || !audioContext) return;

    gateAnalyser.getFloatTimeDomainData(gateData);

    let sumSq = 0;
    for (let i = 0; i < gateData.length; i++) {
      sumSq += gateData[i] * gateData[i];
    }
    const rms = Math.sqrt(sumSq / gateData.length);

    const now = audioContext.currentTime;
    if (rms > GATE_THRESHOLD) {
      gateGainNode.gain.cancelScheduledValues(now);
      gateGainNode.gain.setTargetAtTime(GATE_OPEN_GAIN, now, GATE_ATTACK_MS / 1000);
    } else {
      gateGainNode.gain.cancelScheduledValues(now);
      gateGainNode.gain.setTargetAtTime(GATE_CLOSED_GAIN, now, GATE_RELEASE_MS / 1000);
    }
  }, 30); // 30ms = ~33Hz
}

function stopNoiseGateLoop() {
  if (noiseGateInterval) {
    clearInterval(noiseGateInterval);
    noiseGateInterval = null;
  }
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

    // Calculate separate mic/tab RMS for the popup indicator
    let micRms = 0;
    let tabRms = 0;
    if (micAnalyserNode) {
      const micData = new Float32Array(micAnalyserNode.fftSize);
      micAnalyserNode.getFloatTimeDomainData(micData);
      let sum = 0;
      for (let j = 0; j < micData.length; j++) sum += micData[j] * micData[j];
      micRms = Math.round(Math.sqrt(sum / micData.length) * 1000);
    }
    if (tabAnalyserNode) {
      const tabData = new Float32Array(tabAnalyserNode.fftSize);
      tabAnalyserNode.getFloatTimeDomainData(tabData);
      let sum = 0;
      for (let j = 0; j < tabData.length; j++) sum += tabData[j] * tabData[j];
      tabRms = Math.round(Math.sqrt(sum / tabData.length) * 1000);
    }

    // Send levels to background which writes them to storage for the popup
    chrome.runtime.sendMessage({
      type: 'AUDIO_LEVELS',
      levels: hasActivity ? levels : null,
      micRms,
      tabRms,
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
  micAnalyserNode = null;
  tabAnalyserNode = null;
  previousLevels = new Array(NUM_BARS).fill(0);
  stopDuckingLoop();
  stopNoiseGateLoop();
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
      stopLiveChunkRecorder();

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

      // Clear IDB — recording completed successfully
      await clearIdb();
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
  stopLiveChunkRecorder();

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
  // Clear IDB — recording was cancelled
  clearIdb();
  cleanupStreams();
}

// ---- Live Transcript Preview ----

/**
 * Start the live chunk recorder. Every LIVE_CHUNK_MS, stops the current
 * recorder (producing a complete self-contained WebM file), sends it to
 * background for transcription, then starts a new recorder.
 *
 * Uses a separate MediaRecorder on the same stream — main recorder is unaffected.
 */
function startLiveChunkRecorder() {
  if (!recordingStream || isLiveRecording) return;
  isLiveRecording = true;

  function recordOneChunk() {
    if (!recordingStream || !isLiveRecording) return;

    const chunks = [];
    liveRecorder = new MediaRecorder(recordingStream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32000, // Lower bitrate for quick preview
    });

    liveRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    liveRecorder.onstop = async () => {
      if (!isLiveRecording) return;
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size > 1000) {
        const audioBase64 = await blobToBase64(blob);
        chrome.runtime.sendMessage({
          type: 'LIVE_CHUNK_READY',
          audioBase64,
          filename: 'live_chunk.webm',
        });
      }
      // Schedule next chunk immediately
      if (isLiveRecording) {
        liveChunkInterval = setTimeout(recordOneChunk, 100);
      }
    };

    liveRecorder.start();
    // Stop after LIVE_CHUNK_MS to produce a complete WebM file
    setTimeout(() => {
      if (liveRecorder && liveRecorder.state === 'recording') {
        liveRecorder.stop();
      }
    }, LIVE_CHUNK_MS);
  }

  recordOneChunk();
  console.log('[Finrep] Live transcript preview started (15s chunks)');
}

function stopLiveChunkRecorder() {
  isLiveRecording = false;
  if (liveChunkInterval) {
    clearTimeout(liveChunkInterval);
    liveChunkInterval = null;
  }
  if (liveRecorder && liveRecorder.state !== 'inactive') {
    liveRecorder.onstop = null; // Prevent scheduling next chunk
    liveRecorder.stop();
  }
  liveRecorder = null;
  console.log('[Finrep] Live transcript preview stopped');
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
