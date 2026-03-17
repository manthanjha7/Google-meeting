// Background service worker — orchestrates recording, pipeline, and state management

const API_BASE = 'http://localhost:3001/api';

// Extension state: 'idle' | 'meet-detected' | 'recording' | 'processing' | 'summary-ready' | 'error'
let currentState = 'idle';
let recordingTabId = null;
let recordingStartTime = null;
let meetTabId = null;

// Pending start command — stored here until offscreen sends OFFSCREEN_READY
let pendingStartCommand = null;

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
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    // Store the command — will be sent when offscreen signals READY
    pendingStartCommand = {
      type: 'START_RECORDING',
      target: 'offscreen',
      streamId,
      includeMic,
    };

    // Create offscreen document (its script will send OFFSCREEN_READY when loaded)
    await ensureOffscreenDocument();

    // Check if offscreen was already running (existing document) — send immediately
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0 && pendingStartCommand) {
      // Document already existed, so OFFSCREEN_READY was sent before we started listening.
      // Send the command directly — the listener is already registered.
      const cmd = pendingStartCommand;
      pendingStartCommand = null;
      chrome.runtime.sendMessage(cmd);
    }

    setBadge('REC', '#ff4444');
    await setState('recording', { tabId, startTime: recordingStartTime, includeMic });
  } catch (err) {
    console.error('Failed to start recording:', err);
    pendingStartCommand = null;
    await setState('error', { message: 'Failed to start recording: ' + err.message });
  }
}

function stopRecording() {
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

    // Step 3: Summarize (skipped — no Claude API key configured yet)
    // TODO: Uncomment when ANTHROPIC_API_KEY is available
    // await setState('processing', { step: 'summarizing', meetingId });
    // const summarizeRes = await fetch(`${API_BASE}/summarize`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ meetingId }),
    // });
    // const summarizeData = await summarizeRes.json();
    // if (!summarizeRes.ok) throw new Error(summarizeData.error || 'Summarization failed');

    // Pipeline complete
    clearBadge();
    await setState('summary-ready', {
      meetingId,
      summary: null,
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

/**
 * Pipeline for multi-chunk recordings (meetings >55 min).
 * Uploads each chunk, transcribes each separately, then merges transcripts
 * into one meeting and summarizes.
 */
async function runChunkedPipeline(audioChunks) {
  try {
    setBadge('...', '#4a4aff');
    const durationSeconds = recordingStartTime
      ? Math.round((Date.now() - recordingStartTime) / 1000)
      : 0;

    console.log(`[Finrep] Chunked pipeline: ${audioChunks.length} chunks, total duration: ${durationSeconds}s`);

    // Step 1: Upload first chunk to create the meeting record
    await setState('processing', { step: 'uploading' });
    const firstBlob = base64ToBlob(audioChunks[0], 'audio/webm');
    const firstForm = new FormData();
    firstForm.append('audio', firstBlob, 'meeting_chunk_1.webm');
    firstForm.append('durationSeconds', String(durationSeconds));

    const uploadRes = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      body: firstForm,
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');

    const { meetingId } = uploadData;
    if (!meetingId) throw new Error('Server did not return a meeting ID');

    // Step 2: Transcribe first chunk
    await setState('processing', { step: `transcribing chunk 1/${audioChunks.length}`, meetingId });
    const transcribe1Res = await fetch(`${API_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
    });
    const transcribe1Data = await transcribe1Res.json();
    if (!transcribe1Res.ok) throw new Error(transcribe1Data.error || 'Transcription failed for chunk 1');

    let mergedTranscript = transcribe1Data.transcript || '';

    // Step 3: Upload and transcribe remaining chunks
    for (let i = 1; i < audioChunks.length; i++) {
      await setState('processing', { step: `uploading chunk ${i + 1}/${audioChunks.length}`, meetingId });

      const chunkBlob = base64ToBlob(audioChunks[i], 'audio/webm');
      const chunkForm = new FormData();
      chunkForm.append('audio', chunkBlob, `meeting_chunk_${i + 1}.webm`);
      chunkForm.append('durationSeconds', '0'); // duration already tracked on main meeting

      const chunkUploadRes = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: chunkForm,
      });
      const chunkUploadData = await chunkUploadRes.json();
      if (!chunkUploadRes.ok) throw new Error(chunkUploadData.error || `Upload failed for chunk ${i + 1}`);

      const chunkMeetingId = chunkUploadData.meetingId;

      await setState('processing', { step: `transcribing chunk ${i + 1}/${audioChunks.length}`, meetingId });
      const chunkTransRes = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: chunkMeetingId }),
      });
      const chunkTransData = await chunkTransRes.json();
      if (!chunkTransRes.ok) throw new Error(chunkTransData.error || `Transcription failed for chunk ${i + 1}`);

      if (chunkTransData.transcript) {
        mergedTranscript += '\n' + chunkTransData.transcript;
      }
    }

    // Step 4: Update the main meeting with the merged transcript
    await fetch(`${API_BASE}/transcribe/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, transcript: mergedTranscript }),
    });

    // Step 5: Summarize the merged transcript (skipped — no Claude API key configured yet)
    // TODO: Uncomment when ANTHROPIC_API_KEY is available
    // await setState('processing', { step: 'summarizing', meetingId });
    // const summarizeRes = await fetch(`${API_BASE}/summarize`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ meetingId }),
    // });
    // const summarizeData = await summarizeRes.json();
    // if (!summarizeRes.ok) throw new Error(summarizeData.error || 'Summarization failed');

    clearBadge();
    await setState('summary-ready', {
      meetingId,
      summary: null,
    });
  } catch (err) {
    console.error('Chunked pipeline error:', err);
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

// ---- Re-detect Meeting ----

async function redetectMeeting() {
  try {
    // Query for any active Google Meet tab
    const tabs = await chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://meet.new/*'] });
    let found = false;

    for (const tab of tabs) {
      try {
        // Ask the content script if a meeting is active
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_MEETING' });
        if (response?.active) {
          meetTabId = tab.id;
          chrome.storage.local.set({ meetTabId: tab.id });
          setBadge('MEET', '#4a4aff');
          await setState('note-prompt', { tabId: tab.id, meetUrl: tab.url });
          found = true;
          break;
        }
      } catch {
        // Content script may not be injected or tab may not respond — skip
      }
    }

    if (!found) {
      meetTabId = null;
      await setState('idle');
    }
  } catch {
    meetTabId = null;
    await setState('idle');
  }
}

// ---- Message Handling ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'OFFSCREEN_READY':
      // Offscreen document loaded — send any pending start command
      console.log('[Finrep] Offscreen document is ready');
      if (pendingStartCommand) {
        const cmd = pendingStartCommand;
        pendingStartCommand = null;
        chrome.runtime.sendMessage(cmd);
      }
      break;

    case 'MEET_DETECTED':
      if (sender.tab) {
        meetTabId = sender.tab.id;
        chrome.storage.local.set({ meetTabId: sender.tab.id });
        getState().then(({ state }) => {
          if (state === 'idle') {
            setBadge('MEET', '#4a4aff');
            // Show note-taking prompt before going to meet-detected
            setState('note-prompt', { tabId: sender.tab.id, meetUrl: message.url });
          }
        });
      }
      break;

    case 'ENABLE_NOTES':
      // User accepted note-taking — transition to meet-detected
      getState().then(({ state, data }) => {
        if (state === 'note-prompt') {
          setState('meet-detected', data);
        }
      });
      break;

    case 'SKIP_NOTES':
      // User declined note-taking — go back to idle
      meetTabId = null;
      clearBadge();
      setState('idle');
      break;

    case 'START_RECORDING_REQUEST':
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
        } else if (state === 'meet-detected' || state === 'note-prompt') {
          meetTabId = null;
          clearBadge();
          setState('idle');
        }
      });
      break;

    case 'RECORDING_STARTED':
      console.log('[Finrep] Offscreen confirmed recording started');
      break;

    case 'AUDIO_LEVELS':
      // Forward audio levels from offscreen to storage (popup reads from storage)
      chrome.storage.local.set({ audioLevels: message.levels });
      break;

    case 'RECORDING_COMPLETE':
      // Clear audio levels
      chrome.storage.local.remove('audioLevels');
      if (message.audioChunks && message.audioChunks.length > 0) {
        // Multi-chunk recording (>55 min) — upload and transcribe each chunk
        runChunkedPipeline(message.audioChunks);
      } else if (message.audioBase64) {
        runPipeline(message.audioBase64);
      } else {
        clearBadge();
        setState('error', { message: message.error || 'Recording failed — no audio data' });
      }
      break;

    case 'STOP_REQUESTED':
      getState().then(({ state }) => {
        if (state === 'recording') {
          stopRecording();
        }
      });
      break;

    case 'CANCEL_REQUESTED':
      getState().then(async ({ state }) => {
        if (state === 'recording') {
          chrome.runtime.sendMessage({
            type: 'CANCEL_RECORDING',
            target: 'offscreen',
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          await closeOffscreenDocument();
          recordingTabId = null;
          recordingStartTime = null;
          clearBadge();
          // Re-detect meeting instead of going to idle
          await redetectMeeting();
        }
      });
      break;

    case 'SEND_TO_SLACK':
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
          // Re-detect meeting instead of going to idle
          await redetectMeeting();
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'GET_STATE':
      getState().then((stateObj) => {
        stateObj.data.meetTabId = meetTabId;
        sendResponse(stateObj);
      });
      return true;

    case 'RESET':
      closeOffscreenDocument();
      recordingTabId = null;
      recordingStartTime = null;
      pendingStartCommand = null;
      clearBadge();
      // After resetting, check if user is still in a meeting and re-detect
      redetectMeeting();
      break;
  }
});

// ---- Initialization ----

async function restoreState() {
  const result = await chrome.storage.local.get(['extensionState', 'stateData', 'meetTabId']);
  currentState = result.extensionState || 'idle';
  meetTabId = result.meetTabId || null;

  if (currentState === 'recording' && result.stateData) {
    recordingTabId = result.stateData.tabId || null;
    recordingStartTime = result.stateData.startTime || null;
  }

  if (currentState === 'recording') {
    setBadge('REC', '#ff4444');
  } else if (currentState === 'meet-detected') {
    setBadge('MEET', '#4a4aff');
  } else if (currentState === 'processing') {
    setBadge('...', '#4a4aff');
  }
}

chrome.runtime.onInstalled.addListener(() => {
  clearBadge();
  setState('idle');
});

chrome.runtime.onStartup.addListener(() => {
  restoreState();
});

restoreState();
