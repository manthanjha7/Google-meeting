// Offscreen document for audio capture and recording
// Required in Manifest V3 because service workers cannot use MediaRecorder
//
// Communication from background/popup → offscreen uses chrome.storage commands.
// This avoids a race condition where chrome.runtime.sendMessage is lost because
// the offscreen document's script hasn't loaded its listener yet.

// ---- Global error handler ----
// Catches unhandled async errors and reports them to background so the user
// sees a failure instead of the extension silently hanging.
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

// ---- Storage-based command listener ----
// Background/popup writes { recordingCommand: { action, ... , ts } } to storage.
// We watch for changes and execute the command.

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.recordingCommand) return;

  const cmd = changes.recordingCommand.newValue;
  if (!cmd || !cmd.action) return;

  console.log('[Finrep] Received command via storage:', cmd.action);

  switch (cmd.action) {
    case 'start':
      if (!isStarting && (!mediaRecorder || mediaRecorder.state === 'inactive')) {
        processStartCommand(cmd);
      } else {
        console.log('[Finrep] Ignoring duplicate start command (already starting or recording)');
        chrome.storage.local.remove('recordingCommand');
      }
      break;
    case 'stop':
      chrome.storage.local.remove('recordingCommand');
      stopRecording();
      break;
    case 'cancel':
      chrome.storage.local.remove('recordingCommand');
      cancelRecording();
      break;
  }
});

// Also check on load — in case the command was written before this script loaded.
// The onChanged listener might not have been registered in time.
chrome.storage.local.get('recordingCommand', (result) => {
  const cmd = result.recordingCommand;
  if (cmd && cmd.action === 'start' && cmd.streamId) {
    // Only process if the command is recent (within last 5 seconds)
    if (cmd.ts && Date.now() - cmd.ts < 5000) {
      if (!isStarting && (!mediaRecorder || mediaRecorder.state === 'inactive')) {
        console.log('[Finrep] Processing pending start command from storage');
        processStartCommand(cmd);
      }
    } else {
      // Stale command — clear it
      chrome.storage.local.remove('recordingCommand');
    }
  }
});

console.log('[Finrep] Offscreen document loaded and listening for commands');

// ---- Command Processing ----

async function processStartCommand(cmd) {
  isStarting = true;
  // Clear the command from storage immediately so the other path cannot re-process it
  await chrome.storage.local.remove('recordingCommand');
  try {
    await startRecording(cmd.streamId, cmd.includeMic);
  } finally {
    isStarting = false;
  }
}

// ---- Recording ----

async function startRecording(streamId, includeMic = false) {
  try {
    // Capture tab audio stream (other participants' voices + any meeting audio)
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
    // so the context starts suspended and produces silence unless explicitly resumed.
    audioContext = new AudioContext();
    await audioContext.resume();
    console.log('[Finrep] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);

    const tabSource = audioContext.createMediaStreamSource(tabStream);

    // NOTE: In an offscreen document, audioContext.destination is headless (no speakers).
    // This connect() call keeps the audio graph alive for the analyser but produces no
    // audible output. Tab audio remains audible to the user because tab capture via
    // getMediaStreamId does NOT mute the tab — Chrome plays it through its normal path.
    tabSource.connect(audioContext.destination);

    let recordingStream;
    let analyserSource; // The node to connect the analyser to

    if (includeMic) {
      try {
        // Request microphone access — captures user's own voice
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        console.log('[Finrep] Microphone stream acquired');

        const micSource = audioContext.createMediaStreamSource(micStream);

        // Mix tab audio + mic audio into a single stream for recording
        const mixedDestination = audioContext.createMediaStreamDestination();
        tabSource.connect(mixedDestination);
        micSource.connect(mixedDestination);

        recordingStream = mixedDestination.stream;

        // Analyser on the mixed stream
        analyserSource = audioContext.createMediaStreamSource(mixedDestination.stream);
        console.log('[Finrep] Recording with tab audio + microphone');
      } catch (micErr) {
        console.warn('[Finrep] Microphone access denied, falling back to tab audio only:', micErr.message);
        recordingStream = tabStream;
        analyserSource = tabSource;
      }
    } else {
      // Tab audio only — record directly from the original tab stream.
      recordingStream = tabStream;
      analyserSource = tabSource;
      console.log('[Finrep] Recording tab audio only');
    }

    // Set up audio analyser for visualizer
    startAudioAnalyser(analyserSource);

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

    mediaRecorder.onstop = async () => {
      stopAudioAnalyser();

      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const totalSize = blob.size;
      recordedChunks = [];

      console.log(`[Finrep] Recording stopped. Audio size: ${totalSize} bytes`);

      if (totalSize < 1000) {
        console.warn('[Finrep] Audio blob is very small, recording may be silent');
      }

      // Convert blob to base64 and send to background via message
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETE',
          audioBase64: base64,
        });
      };
      reader.readAsDataURL(blob);

      // Stop all tracks
      cleanupStreams();
    };

    // Collect data every 5 seconds (more frequent = less data loss on early stop)
    mediaRecorder.start(5000);
    console.log(`[Finrep] MediaRecorder started. State: ${mediaRecorder.state}`);

    // Signal to background that recording actually started
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

// ---- Audio Analyser ----
//
// Uses frequency data directly — no hard VAD gate. When nobody speaks,
// frequency energy is naturally near zero and bars stay flat.
// When someone speaks, data spikes and bars respond.

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

  // Connect analyser to a silent output so Chrome processes audio through it.
  // Without this, getByteFrequencyData can return all zeros.
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  analyserNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  const frequencyBinCount = analyserNode.frequencyBinCount;
  const frequencyData = new Uint8Array(frequencyBinCount);

  // Calculate bin indices for human voice range (85Hz - 3500Hz)
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

    // Debug logging every 5 seconds
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
    chrome.storage.local.set({ audioLevels: hasActivity ? levels : null });
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
  chrome.storage.local.remove('audioLevels');
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
}

// ---- Recording Control ----

function stopRecording() {
  console.log('[Finrep] stopRecording called, mediaRecorder state:', mediaRecorder?.state);
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // onstop handler will clean up and send RECORDING_COMPLETE
  } else {
    // MediaRecorder is missing or already stopped — notify background so it doesn't hang
    console.warn('[Finrep] stopRecording: no active MediaRecorder, sending empty completion');
    stopAudioAnalyser();
    cleanupStreams();
    mediaRecorder = null;
    chrome.runtime.sendMessage({
      type: 'RECORDING_COMPLETE',
      audioBase64: null,
      error: 'Recording was not active when stop was requested',
    });
  }
}

function cancelRecording() {
  console.log('[Finrep] cancelRecording called');
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
  cleanupStreams();
}
