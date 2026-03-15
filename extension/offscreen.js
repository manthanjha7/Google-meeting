// Offscreen document for audio capture and recording
// Required in Manifest V3 because service workers cannot use MediaRecorder

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let micStream = null;
let tabStream = null;
let analyserInterval = null;
let analyserNode = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.streamId, message.includeMic);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'CANCEL_RECORDING':
      cancelRecording();
      break;
  }
});

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

    // Create AudioContext and RESUME it — offscreen documents have no user gesture,
    // so the context starts suspended and produces silence unless explicitly resumed.
    audioContext = new AudioContext();
    await audioContext.resume();

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

      // Convert blob to base64 and send to background
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
// How it works:
// 1. AnalyserNode is connected to the audio stream AND to a silent output
//    (GainNode with gain=0 → destination). This ensures Chrome processes
//    audio through the analyser even when no other output is connected.
// 2. Every 100ms we read frequency data and map it directly to bar levels.
// 3. No hard VAD gate — we use the actual frequency energy. When nobody
//    speaks, frequency data is naturally near zero and bars stay flat.
//    When someone speaks, the data spikes and bars respond.
// 4. We focus on human voice frequencies (85Hz–3.5kHz) and apply
//    aggressive scaling so even quiet audio is visible.
// 5. Smooth decay prevents jittery bar movement.

const DECAY_RATE = 0.82;     // How fast bars decay (0-1, higher = slower decay)
const NUM_BARS = 20;          // Number of visualizer bars
const NOISE_FLOOR = 10;      // Ignore frequency values below this (0-255 range)
let previousLevels = new Array(NUM_BARS).fill(0);
let silentGain = null;

function startAudioAnalyser(sourceNode) {
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 512;     // 256 frequency bins for fine resolution
  analyserNode.smoothingTimeConstant = 0.5;
  analyserNode.minDecibels = -90;
  analyserNode.maxDecibels = -10;

  sourceNode.connect(analyserNode);

  // CRITICAL: Connect analyser to a silent output so Chrome actually
  // processes audio through it. Without this, getByteFrequencyData
  // can return all zeros in some Chrome versions.
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0; // Silent — no audible output
  analyserNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  const frequencyBinCount = analyserNode.frequencyBinCount; // 256
  const frequencyData = new Uint8Array(frequencyBinCount);

  // Calculate bin indices for human voice range
  // For 48kHz sample rate: each bin = sampleRate / fftSize = 48000/512 ≈ 93.75 Hz
  // Voice range: ~85Hz to ~3500Hz → bins 1 to ~37
  const sampleRate = audioContext.sampleRate;
  const binWidth = sampleRate / analyserNode.fftSize;
  const startBin = Math.max(1, Math.floor(85 / binWidth));
  const endBin = Math.min(frequencyBinCount - 1, Math.ceil(3500 / binWidth));
  const usableBins = endBin - startBin;
  const binsPerBar = Math.max(1, Math.floor(usableBins / NUM_BARS));

  console.log(`[Finrep] Analyser: sampleRate=${sampleRate}, binWidth=${binWidth.toFixed(1)}Hz, voiceBins=${startBin}-${endBin}, binsPerBar=${binsPerBar}`);

  let tickCount = 0;

  analyserInterval = setInterval(() => {
    analyserNode.getByteFrequencyData(frequencyData);

    // Log raw data periodically for debugging
    tickCount++;
    if (tickCount % 50 === 1) { // Every 5 seconds
      const maxVal = Math.max(...frequencyData.slice(startBin, endBin));
      const avgVal = frequencyData.slice(startBin, endBin).reduce((a, b) => a + b, 0) / usableBins;
      console.log(`[Finrep] Audio levels — max: ${maxVal}, avg: ${avgVal.toFixed(1)}, bins[${startBin}-${endBin}]`);
    }

    const levels = [];
    for (let i = 0; i < NUM_BARS; i++) {
      let sum = 0;
      const barStart = startBin + i * binsPerBar;
      for (let j = 0; j < binsPerBar; j++) {
        const val = frequencyData[barStart + j] || 0;
        // Subtract noise floor — anything below is silence
        sum += Math.max(0, val - NOISE_FLOOR);
      }

      // Normalize: max possible per bin is (255 - NOISE_FLOOR)
      const avg = sum / binsPerBar / (255 - NOISE_FLOOR);

      // Scale aggressively so even moderate voice shows clearly
      const scaled = Math.min(1, avg * 3.5);

      // Smooth with previous value — bars decay gradually
      const smoothed = Math.max(scaled, previousLevels[i] * DECAY_RATE);
      levels.push(Math.round(smoothed * 100));
    }

    previousLevels = levels.map((l) => l / 100);

    // Send to popup — null means "no activity" (bars stay flat)
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
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log('[Finrep] Stop recording requested');
  }
}

function cancelRecording() {
  stopAudioAnalyser();

  if (mediaRecorder) {
    // Clear handlers BEFORE stopping so no data is processed
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
