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

// ---- Audio Analyser with Voice Activity Detection ----
//
// How it works:
// 1. We use an AnalyserNode connected to the actual audio stream being recorded.
// 2. Every 100ms we compute RMS (root mean square) from the time-domain waveform.
//    RMS is a measure of the overall loudness of the signal.
// 3. We compare RMS to a threshold (0.015) — below this is silence/background noise.
// 4. Only when voice is detected (RMS > threshold) do we send frequency band data.
// 5. When silent, we send all zeros — the bars stay flat.
// 6. We add smooth decay so bars fall gradually instead of snapping to zero.

const VAD_THRESHOLD = 0.015; // RMS threshold for voice activity
const DECAY_RATE = 0.85;     // How fast bars decay (0-1, higher = slower decay)
const NUM_BARS = 20;          // Number of visualizer bars
let previousLevels = new Array(NUM_BARS).fill(0);

function startAudioAnalyser(sourceNode) {
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;    // 128 frequency bins — good resolution
  analyserNode.smoothingTimeConstant = 0.4; // Moderate smoothing
  sourceNode.connect(analyserNode);

  const frequencyBinCount = analyserNode.frequencyBinCount; // 128
  const frequencyData = new Uint8Array(frequencyBinCount);
  const timeDomainData = new Float32Array(analyserNode.fftSize);

  analyserInterval = setInterval(() => {
    // Step 1: Compute RMS from time-domain data for voice activity detection
    analyserNode.getFloatTimeDomainData(timeDomainData);
    let sumSquares = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      sumSquares += timeDomainData[i] * timeDomainData[i];
    }
    const rms = Math.sqrt(sumSquares / timeDomainData.length);

    const isSpeaking = rms > VAD_THRESHOLD;

    let levels;

    if (isSpeaking) {
      // Step 2: Get frequency data and map to bars
      analyserNode.getByteFrequencyData(frequencyData);

      // Group frequency bins into NUM_BARS bands
      // Focus on human voice range (roughly bins 2-80 out of 128 for 48kHz sample rate)
      // This covers ~75Hz to ~3000Hz where most speech energy is
      const startBin = 2;
      const endBin = 80;
      const usableBins = endBin - startBin;
      const binsPerBar = Math.floor(usableBins / NUM_BARS);

      levels = [];
      for (let i = 0; i < NUM_BARS; i++) {
        let sum = 0;
        const barStart = startBin + i * binsPerBar;
        for (let j = 0; j < binsPerBar; j++) {
          sum += frequencyData[barStart + j];
        }
        const avg = sum / binsPerBar / 255; // Normalize to 0-1

        // Scale up for visual impact — voice frequencies are often quiet
        const scaled = Math.min(1, avg * 2.5);

        // Smooth with previous value (prevents jitter)
        const smoothed = Math.max(scaled, previousLevels[i] * DECAY_RATE);
        levels.push(Math.round(smoothed * 100));
      }
    } else {
      // Silent — decay previous levels toward zero
      levels = previousLevels.map((prev) => {
        const decayed = prev * DECAY_RATE;
        return decayed < 1 ? 0 : Math.round(decayed);
      });
    }

    previousLevels = levels.map((l) => l / 100);

    // Only write to storage if there's actual data to show (optimization)
    const hasActivity = levels.some((l) => l > 0);
    chrome.storage.local.set({ audioLevels: hasActivity ? levels : null });
  }, 100);
}

function stopAudioAnalyser() {
  if (analyserInterval) {
    clearInterval(analyserInterval);
    analyserInterval = null;
  }
  analyserNode = null;
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
