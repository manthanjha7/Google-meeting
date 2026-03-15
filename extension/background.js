// Background service worker — orchestrates recording, pipeline, and state management

const API_BASE = 'http://localhost:3001/api';

// Extension state: 'idle' | 'meet-detected' | 'recording' | 'processing' | 'summary-ready' | 'error'
let currentState = 'idle';
let recordingTabId = null;
let recordingStartTime = null;
let meetTabId = null;

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

// ---- Badge Management ----

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
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

async function startRecording(tabId, includeMic = false) {
  try {
    recordingTabId = tabId;
    recordingStartTime = Date.now();

    // Get media stream ID for the tab
    // This works because it's called in response to a user gesture (popup button click)
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
      includeMic: includeMic,
    });

    setBadge('REC', '#ff4444');
    await setState('recording', { tabId, startTime: recordingStartTime, includeMic });
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
    setBadge('...', '#4a4aff');
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
    if (!meetingId) throw new Error('Server did not return a meeting ID');

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
    clearBadge();
    await setState('summary-ready', {
      meetingId,
      summary: summarizeData.summary,
    });
  } catch (err) {
    console.error('Pipeline error:', err);
    clearBadge();
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
      // Content script detected a Meet — store the tab ID, set badge, but DON'T auto-record
      // User must click the extension icon and press "Start Recording" (provides user gesture)
      if (sender.tab) {
        meetTabId = sender.tab.id;
        chrome.storage.local.set({ meetTabId: sender.tab.id });
        getState().then(({ state }) => {
          if (state === 'idle') {
            setBadge('MEET', '#4a4aff');
            setState('meet-detected', { tabId: sender.tab.id, meetUrl: message.url });
          }
        });
      }
      break;

    case 'START_RECORDING_REQUEST':
      // Popup clicked "Start Recording" — user gesture context is active
      getState().then(({ state }) => {
        if ((state === 'idle' || state === 'meet-detected') && message.tabId) {
          startRecording(message.tabId, message.includeMic || false);
        }
      });
      break;

    case 'MEET_ENDED':
      getState().then(({ state }) => {
        if (state === 'recording') {
          stopRecording();
        } else if (state === 'meet-detected') {
          meetTabId = null;
          clearBadge();
          setState('idle');
        }
      });
      break;

    case 'RECORDING_COMPLETE':
      // Received from offscreen document with the recorded audio
      if (message.audioBase64) {
        runPipeline(message.audioBase64);
      } else {
        clearBadge();
        setState('error', { message: message.error || 'Recording failed — no audio data' });
      }
      break;

    case 'STOP_REQUESTED':
      // User manually stopped recording from popup
      // Read from storage because service worker may have restarted and lost in-memory state
      getState().then(({ state }) => {
        if (state === 'recording') {
          stopRecording();
        }
      });
      break;

    case 'CANCEL_REQUESTED':
      // User cancelled — discard recording
      getState().then(async ({ state }) => {
        if (state === 'recording') {
          // Send cancel to offscreen (popup also sends directly as a fallback)
          chrome.runtime.sendMessage({
            type: 'CANCEL_RECORDING',
            target: 'offscreen',
          });
          // Wait briefly for offscreen to clean up before closing it
          await new Promise((resolve) => setTimeout(resolve, 500));
          await closeOffscreenDocument();
          recordingTabId = null;
          recordingStartTime = null;
          clearBadge();
          await setState('idle');
        }
      });
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
          clearBadge();
          await setState('idle');
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // Keep message channel open for async response

    case 'GET_STATE':
      getState().then((stateObj) => {
        // Also include meetTabId so popup knows which tab to capture
        stateObj.data.meetTabId = meetTabId;
        sendResponse(stateObj);
      });
      return true;

    case 'RESET':
      closeOffscreenDocument();
      recordingTabId = null;
      recordingStartTime = null;
      meetTabId = null;
      clearBadge();
      setState('idle');
      break;
  }
});

// ---- Initialization ----

// Restore in-memory state from storage (service worker may have been terminated and restarted)
async function restoreState() {
  const result = await chrome.storage.local.get(['extensionState', 'stateData', 'meetTabId']);
  currentState = result.extensionState || 'idle';
  meetTabId = result.meetTabId || null;

  if (currentState === 'recording' && result.stateData) {
    recordingTabId = result.stateData.tabId || null;
    recordingStartTime = result.stateData.startTime || null;
  }

  // Restore badge based on state
  if (currentState === 'recording') {
    setBadge('REC', '#ff4444');
  } else if (currentState === 'meet-detected') {
    setBadge('MEET', '#4a4aff');
  } else if (currentState === 'processing') {
    setBadge('...', '#4a4aff');
  }
}

// On install, reset to clean state
chrome.runtime.onInstalled.addListener(() => {
  clearBadge();
  setState('idle');
});

// On startup (browser opened), restore from storage
chrome.runtime.onStartup.addListener(() => {
  restoreState();
});

// Also restore immediately when script loads (handles service worker restart mid-session)
restoreState();
