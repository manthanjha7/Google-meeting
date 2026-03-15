// Offscreen document for audio capture and recording
// Required in Manifest V3 because service workers cannot use MediaRecorder

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let micStream = null;

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
    // Capture tab audio stream
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    audioContext = new AudioContext();
    const tabSource = audioContext.createMediaStreamSource(tabStream);

    // Route tab audio back to speakers so the user can still hear the meeting.
    // Without this, tab audio capture intercepts the audio and the user hears silence.
    tabSource.connect(audioContext.destination);

    let recordingStream;

    if (includeMic) {
      try {
        // Request microphone access — browser will prompt user if needed
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
      } catch (micErr) {
        console.warn('Microphone access denied or failed, recording tab audio only:', micErr.message);
        // Fall back to tab-only recording
        const tabDestination = audioContext.createMediaStreamDestination();
        tabSource.connect(tabDestination);
        recordingStream = tabDestination.stream;
      }
    } else {
      // Tab audio only — route through a destination node for MediaRecorder
      const tabDestination = audioContext.createMediaStreamDestination();
      tabSource.connect(tabDestination);
      recordingStream = tabDestination.stream;
    }

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
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      recordedChunks = [];

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
      tabStream.getTracks().forEach((track) => track.stop());
      if (micStream) {
        micStream.getTracks().forEach((track) => track.stop());
        micStream = null;
      }
    };

    // Collect data every 10 seconds
    mediaRecorder.start(10000);
  } catch (err) {
    console.error('Offscreen recording error:', err);
    chrome.runtime.sendMessage({
      type: 'RECORDING_COMPLETE',
      audioBase64: null,
      error: err.message,
    });
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  recordedChunks = [];
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}
