// Offscreen document for audio capture and recording
// Required in Manifest V3 because service workers cannot use MediaRecorder

let mediaRecorder = null;
let recordedChunks = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.streamId);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'CANCEL_RECORDING':
      cancelRecording();
      break;
  }
});

async function startRecording(streamId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
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
      stream.getTracks().forEach((track) => track.stop());
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
}
