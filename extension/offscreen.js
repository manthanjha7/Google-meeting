// Offscreen document for audio capture and recording
// Required in Manifest V3 because service workers cannot use MediaRecorder
//
// IMPORTANT: Communication from background/popup → offscreen uses chrome.storage
// instead of chrome.runtime.sendMessage. This is because when the offscreen document
// is first created, its script hasn't loaded yet, so messages sent immediately after
// creation are lost. Storage-based commands are queued and always delivered reliably.

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let micStream = null;
let tabStream = null;
let analyserInterval = null;
let analyserNode = null;
let silentGain = null;

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
      startRecording(cmd.streamId, cmd.includeMic);
      break;
    case 'stop':
      stopRecording();
      break;
    case 'cancel':
      cancelRecording();
      break;
  }
});

// Also check on load — in case the command was written before this script loaded
chrome.storage.local.get('recordingCommand', (result) => {
  const cmd = result.recordingCommand;
  if (cmd && cmd.action === 'start' && cmd.streamId) {
    // Only process if the command is recent (within last 5 seconds)
    if (cmd.ts && Date.now() - cmd.ts < 5000) {
      console.log('[Finrep] Processing pending start command from storage');
      startRecording(cmd.streamId, cmd.includeMic);
    }
  }
});

console.log('[Finrep] Offscreen document loaded and listening for commands');

// ---- Recording ----

async function startRecording(streamId, includeMic = false) {
  try {
    // Clean up any previous state
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }
    stopAudioAnalyser();

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

    // Route tab audio back to speakers so the user can still hear the meeting.
    // Without this, tab audio capture intercepts the audio and the user hears silence.
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
      // (background is guaranteed alive since it initiated the recording)
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
      if (tabStream) {
        tabStream.getTracks().forEach((track) => track.stop());
        tabStream = null;
      }
      if (micStream) {
        micStream.getTracks().forEach((track) => track.stop());
        micStream = null;
      }
    };

    // Collect data every 5 seconds (more frequent = less data loss on early stop)
    mediaRecorder.start(5000);
    console.log(`[Finrep] MediaRecorder started. State: ${mediaRecorder.state}`);

    // Signal to background that recording actually started
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
  } catch (err) {
    console.error('[Finrep] Recording error:', err);
    stopAudioAnalyser();
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

// ---- Recording Control ----

function stopRecording() {
  console.log('[Finrep] stopRecording called, mediaRecorder state:', mediaRecorder?.state);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
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
