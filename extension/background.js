// Background service worker — orchestrates recording, pipeline, and state management

const API_BASE = 'http://localhost:3001/api';

// Extension state: 'idle' | 'recording' | 'processing' | 'summary-ready' | 'error'
let currentState = 'idle';
let recordingTabId = null;
let recordingStartTime = null;

// ---- State Management ----

async function setState(state, data = {}) {
  currentState = state;
  await chrome.storage.local.set({
    extensionState: state,
    stateData: data,
    lastUpdated: Date.now(),
  });
}

async function getState() {
  const result = await chrome.storage.local.get(['extensionState', 'stateData']);
  return {
    state: result.extensionState || 'idle',
    data: result.stateData || {},
  };
}

// ---- Offscreen Document Management ----

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab audio from Google Meet',
  });
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// ---- Recording Control ----

async function startRecording(tabId) {
  try {
    recordingTabId = tabId;
    recordingStartTime = Date.now();

    // Get media stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    // Create offscreen document for MediaRecorder
    await ensureOffscreenDocument();

    // Tell offscreen to start recording
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      target: 'offscreen',
      streamId: streamId,
    });

    await setState('recording', { tabId, startTime: recordingStartTime });
  } catch (err) {
    console.error('Failed to start recording:', err);
    await setState('error', { message: 'Failed to start recording: ' + err.message });
  }
}

async function stopRecording() {
  chrome.runtime.sendMessage({
    type: 'STOP_RECORDING',
    target: 'offscreen',
  });
}

// ---- Pipeline ----

async function runPipeline(audioBase64) {
  try {
    await setState('processing', { step: 'uploading' });

    // Step 1: Upload audio
    const audioBlob = base64ToBlob(audioBase64, 'audio/webm');
    const formData = new FormData();
    formData.append('audio', audioBlob, 'meeting.webm');

    const durationSeconds = recordingStartTime
      ? Math.round((Date.now() - recordingStartTime) / 1000)
      : 0;
    formData.append('durationSeconds', String(durationSeconds));

    const uploadRes = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });
    const uploadData = await uploadRes.json();

    if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');

    const { meetingId } = uploadData;

    // Step 2: Transcribe
    await setState('processing', { step: 'transcribing', meetingId });
    const transcribeRes = await fetch(`${API_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
    });
    const transcribeData = await transcribeRes.json();

    if (!transcribeRes.ok) throw new Error(transcribeData.error || 'Transcription failed');

    // Step 3: Summarize
    await setState('processing', { step: 'summarizing', meetingId });
    const summarizeRes = await fetch(`${API_BASE}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
    });
    const summarizeData = await summarizeRes.json();

    if (!summarizeRes.ok) throw new Error(summarizeData.error || 'Summarization failed');

    // Pipeline complete
    await setState('summary-ready', {
      meetingId,
      summary: summarizeData.summary,
    });
  } catch (err) {
    console.error('Pipeline error:', err);
    await setState('error', { message: err.message });
  } finally {
    await closeOffscreenDocument();
    recordingTabId = null;
    recordingStartTime = null;
  }
}

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteArrays = [];
  for (let offset = 0; offset < byteChars.length; offset += 512) {
    const slice = byteChars.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: mimeType });
}

// ---- Message Handling ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return; // Let offscreen handle these

  switch (message.type) {
    case 'MEET_DETECTED':
      // Content script detected a Meet — store the tab ID so popup can initiate recording
      if (currentState === 'idle' && sender.tab) {
        chrome.storage.local.set({ meetTabId: sender.tab.id });
        startRecording(sender.tab.id);
      }
      break;

    case 'START_RECORDING_WITH_STREAM':
      // Popup obtained streamId via user gesture and is passing it to background
      if (currentState === 'idle' && message.streamId) {
        recordingTabId = message.tabId;
        recordingStartTime = Date.now();
        (async () => {
          try {
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
              type: 'START_RECORDING',
              target: 'offscreen',
              streamId: message.streamId,
            });
            await setState('recording', { tabId: message.tabId, startTime: recordingStartTime });
          } catch (err) {
            await setState('error', { message: 'Failed to start recording: ' + err.message });
          }
        })();
      }
      break;

    case 'MEET_ENDED':
      if (currentState === 'recording') {
        stopRecording();
      }
      break;

    case 'RECORDING_COMPLETE':
      // Received from offscreen document with the recorded audio
      if (message.audioBase64) {
        runPipeline(message.audioBase64);
      }
      break;

    case 'STOP_REQUESTED':
      // User manually stopped recording from popup
      if (currentState === 'recording') {
        stopRecording();
      }
      break;

    case 'CANCEL_REQUESTED':
      // User cancelled — discard recording
      if (currentState === 'recording') {
        chrome.runtime.sendMessage({
          type: 'CANCEL_RECORDING',
          target: 'offscreen',
        });
        closeOffscreenDocument();
        recordingTabId = null;
        recordingStartTime = null;
        setState('idle');
      }
      break;

    case 'SEND_TO_SLACK':
      // User clicked Send to Slack from popup
      (async () => {
        try {
          const res = await fetch(`${API_BASE}/slack/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              meetingId: message.meetingId,
              callType: message.callType,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Slack send failed');
          await setState('idle');
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // Keep message channel open for async response

    case 'GET_STATE':
      getState().then(sendResponse);
      return true;

    case 'RESET':
      closeOffscreenDocument();
      recordingTabId = null;
      recordingStartTime = null;
      setState('idle');
      break;
  }
});

// Initialize state on install/startup
chrome.runtime.onInstalled.addListener(() => setState('idle'));
chrome.runtime.onStartup.addListener(() => setState('idle'));
