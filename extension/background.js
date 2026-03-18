// Background service worker — orchestrates recording, pipeline, and state management

let API_BASE = 'http://localhost:3001/api';
// Allow runtime override via chrome.storage (e.g. for staging/prod deployments)
chrome.storage.local.get('apiBase', (result) => {
  if (result.apiBase) API_BASE = result.apiBase;
});

// ---- IndexedDB Recovery (same DB as offscreen.js) ----

const IDB_NAME = 'finrep-recording';
const IDB_STORE = 'chunks';

function openRecoveryIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getRecoveryChunks() {
  try {
    const db = await openRecoveryIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result.map((r) => r.base64)); };
      req.onerror = () => { db.close(); resolve([]); };
    });
  } catch (e) {
    return [];
  }
}

async function clearRecoveryIdb() {
  try {
    const db = await openRecoveryIdb();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = () => db.close();
  } catch (e) { /* ignore */ }
}

/**
 * Combine multiple base64-encoded WebM segments into one base64 string.
 * Each segment from ondataavailable can be concatenated — WebM is streamable.
 */
function combineBase64Chunks(base64Chunks) {
  const arrays = base64Chunks.map((b64) => {
    const binary = atob(b64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return arr;
  });
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) { combined.set(arr, offset); offset += arr.length; }
  // Encode back to base64 in safe chunks to avoid call stack overflow
  let binary = '';
  const step = 8192;
  for (let i = 0; i < combined.length; i += step) {
    binary += String.fromCharCode(...combined.slice(i, i + step));
  }
  return btoa(binary);
}

// Extension state: 'idle' | 'meet-detected' | 'recording' | 'processing' | 'summary-ready' | 'error'
let currentState = 'idle';
let recordingTabId = null;
let recordingStartTime = null;
let meetTabId = null;
let meetTitle = null;
let meetUrl = null;

// Pending start command — stored here until offscreen sends OFFSCREEN_READY
let pendingStartCommand = null;

// Guard against double-start race: two START_RECORDING_REQUEST messages arriving
// before chrome.storage.local state is persisted and re-read.
let isStartingRecording = false;

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

// ---- Fetch with Timeout ----

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    throw err;
  }
}

// ---- Recording Control ----

async function startRecording(tabId, includeMic = false) {
  try {
    recordingTabId = tabId;
    recordingStartTime = Date.now();
    isStartingRecording = false; // reset guard once we're actually in startRecording

    // Get media stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    // Read configurable chunk duration (defaults to 55 minutes)
    const settings = await chrome.storage.local.get('chunkDurationMin');
    const chunkDurationMin = settings.chunkDurationMin || 55;

    // Store the command — will be sent when offscreen signals READY
    pendingStartCommand = {
      type: 'START_RECORDING',
      target: 'offscreen',
      streamId,
      includeMic,
      chunkDurationMin,
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
    if (meetTitle) formData.append('meetTitle', meetTitle);
    if (meetUrl) formData.append('meetUrl', meetUrl);

    const uploadRes = await fetchWithTimeout(`${API_BASE}/upload`, {
      method: 'POST',
      body: formData,
    }, 120000); // 2 min for upload
    const uploadData = await uploadRes.json();

    if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');

    const { meetingId } = uploadData;
    if (!meetingId) throw new Error('Server did not return a meeting ID');

    // Optional: Enrich with Google Calendar data (best-effort, non-blocking)
    if (meetUrl) {
      (async () => {
        try {
          const calEvent = await fetchCalendarEventForMeet(meetUrl);
          if (calEvent) {
            await fetch(`${API_BASE}/calendar/enrich`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ meetingId, ...calEvent }),
            });
            console.log('[Finrep] Calendar enrichment applied:', calEvent.title);
          }
        } catch (e) {
          console.warn('[Finrep] Calendar enrichment failed (non-blocking):', e.message);
        }
      })();
    }

    // Step 2: Transcribe
    await setState('processing', { step: 'transcribing', meetingId });
    const transcribeRes = await fetchWithTimeout(`${API_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
    }, 600000); // 10 min for Sarvam batch STT
    const transcribeData = await transcribeRes.json();

    if (!transcribeRes.ok) throw new Error(transcribeData.error || 'Transcription failed');

    // Step 3: Summarize via Azure OpenAI
    await setState('processing', { step: 'summarizing', meetingId });
    const summarizeRes = await fetchWithTimeout(`${API_BASE}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
    }, 120000); // 2 min for summarization
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
    if (meetTitle) firstForm.append('meetTitle', meetTitle);
    if (meetUrl) firstForm.append('meetUrl', meetUrl);

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

    // Step 5: Summarize the merged transcript via Azure OpenAI
    await setState('processing', { step: 'summarizing', meetingId });
    const summarizeRes = await fetch(`${API_BASE}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
    });
    const summarizeData = await summarizeRes.json();
    if (!summarizeRes.ok) throw new Error(summarizeData.error || 'Summarization failed');

    clearBadge();
    await setState('summary-ready', {
      meetingId,
      summary: summarizeData.summary,
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

// ---- Google Calendar Integration ----

/**
 * Fetch the Google Calendar event matching a Meet URL.
 * Returns { eventId, title, attendees, description } or null if no match / not connected.
 */
async function fetchCalendarEventForMeet(meetUrl) {
  try {
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t || null));
    });
    if (!token) return null; // Not signed in / permission not granted yet

    // Search events in the next 24h and past 1h that contain the Meet URL
    const now = new Date();
    const timeMin = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/events?calendarId=primary&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&maxResults=20`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const items = data.items || [];

    // Find event whose conference/hangout link matches the Meet URL
    const meetId = meetUrl.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').pop();
    const match = items.find((event) => {
      const confUrl = event.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri || '';
      const hangout = event.hangoutLink || '';
      return confUrl.includes(meetId) || hangout.includes(meetId);
    });

    if (!match) return null;

    return {
      eventId: match.id,
      title: match.summary || null,
      attendees: (match.attendees || []).map((a) => a.displayName || a.email).filter(Boolean),
      description: match.description || null,
    };
  } catch (e) {
    console.warn('[Finrep] Calendar fetch failed:', e.message);
    return null;
  }
}

/**
 * Connect Google Calendar — requests interactive OAuth consent.
 * Returns true if successfully authorized.
 */
async function connectGoogleCalendar() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.warn('[Finrep] Calendar connect failed:', chrome.runtime.lastError.message);
        resolve(false);
      } else {
        console.log('[Finrep] Google Calendar connected');
        chrome.storage.local.set({ calendarConnected: true });
        resolve(!!token);
      }
    });
  });
}

/**
 * Disconnect Google Calendar — revokes cached token.
 */
async function disconnectGoogleCalendar() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          chrome.storage.local.remove('calendarConnected');
          resolve(true);
        });
      } else {
        chrome.storage.local.remove('calendarConnected');
        resolve(true);
      }
    });
  });
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
        meetTitle = message.meetTitle || null;
        meetUrl = message.url || null;
        chrome.storage.local.set({ meetTabId: sender.tab.id, meetTitle, meetUrl });
        getState().then(({ state }) => {
          if (state === 'idle') {
            setBadge('MEET', '#4a4aff');
            // Show note-taking prompt before going to meet-detected
            setState('note-prompt', { tabId: sender.tab.id, meetUrl: message.url, meetTitle: message.meetTitle });
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
      if (isStartingRecording) break; // guard against race
      isStartingRecording = true;
      getState().then(({ state }) => {
        if ((state === 'idle' || state === 'meet-detected') && message.tabId) {
          startRecording(message.tabId, message.includeMic || false);
        } else {
          isStartingRecording = false;
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
      chrome.storage.local.set({
        audioLevels: message.levels,
        micRms: message.micRms || 0,
        tabRms: message.tabRms || 0,
      });
      break;

    case 'LIVE_CHUNK_READY':
      // Send 15s audio chunk to server for live transcript preview
      (async () => {
        try {
          const res = await fetch(`${API_BASE}/transcribe/live`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64: message.audioBase64,
              filename: message.filename || 'live_chunk.webm',
            }),
          });
          const data = await res.json();
          if (data.transcript && data.transcript.trim()) {
            // Append to rolling live transcript (keep last 8 utterances)
            const stored = await chrome.storage.local.get('liveTranscript');
            const prev = stored.liveTranscript || [];
            const updated = [...prev, data.transcript.trim()].slice(-8);
            await chrome.storage.local.set({ liveTranscript: updated });
          }
        } catch (err) {
          console.warn('[Finrep] Live transcript chunk failed:', err.message);
        }
      })();
      break;

    case 'RECORDING_COMPLETE':
      // Clear audio levels and live transcript
      chrome.storage.local.remove(['audioLevels', 'liveTranscript']);
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

    case 'RECOVER_RECORDING':
      (async () => {
        try {
          const chunks = await getRecoveryChunks();
          if (chunks.length === 0) {
            sendResponse({ success: false, error: 'No recoverable audio found in storage' });
            return;
          }
          await clearRecoveryIdb();
          await chrome.storage.local.remove('recoveryNotice');
          const combined = combineBase64Chunks(chunks);
          runPipeline(combined);
          sendResponse({ success: true, chunkCount: chunks.length });
        } catch (err) {
          console.error('[Finrep] Recovery failed:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async sendResponse

    case 'DISMISS_RECOVERY':
      clearRecoveryIdb();
      chrome.storage.local.remove('recoveryNotice');
      break;

    case 'TOGGLE_MIC_MUTE':
    case 'TOGGLE_TAB_MUTE':
      chrome.runtime.sendMessage({ type: message.type, target: 'offscreen' }, (resp) => {
        sendResponse(resp);
      });
      return true;

    case 'CONNECT_CALENDAR':
      connectGoogleCalendar().then((ok) => sendResponse({ success: ok }));
      return true;

    case 'DISCONNECT_CALENDAR':
      disconnectGoogleCalendar().then(() => sendResponse({ success: true }));
      return true;

    case 'GET_CALENDAR_STATUS':
      chrome.storage.local.get('calendarConnected', (result) => {
        sendResponse({ connected: !!result.calendarConnected });
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

// ---- Initialization & Recovery ----

async function restoreState() {
  const result = await chrome.storage.local.get(['extensionState', 'stateData', 'meetTabId', 'meetTitle', 'meetUrl']);
  currentState = result.extensionState || 'idle';
  meetTabId = result.meetTabId || null;
  meetTitle = result.meetTitle || null;
  meetUrl = result.meetUrl || null;

  if (currentState === 'recording' && result.stateData) {
    recordingTabId = result.stateData.tabId || null;
    recordingStartTime = result.stateData.startTime || null;
  }

  if (currentState === 'recording') {
    // Recording was interrupted — check IDB for recoverable audio chunks
    console.warn('[Finrep] Extension restarted while recording was in progress.');
    const idbChunks = await getRecoveryChunks();
    const hasRecoverableAudio = idbChunks.length > 0;
    const message = hasRecoverableAudio
      ? `Recording was interrupted. ${idbChunks.length} audio chunk(s) were saved — you can recover the partial recording.`
      : 'The extension restarted while recording was in progress. The recording was lost.';
    console.log(`[Finrep] IDB recovery check: ${idbChunks.length} chunks found`);
    await chrome.storage.local.set({
      recoveryNotice: {
        message,
        timestamp: Date.now(),
        meetTitle: meetTitle,
        meetUrl: meetUrl,
        hasRecoverableAudio,
        chunkCount: idbChunks.length,
      },
    });
    clearBadge();
    await redetectMeeting();
  } else if (currentState === 'processing') {
    // Processing was interrupted — pipeline failed
    console.warn('[Finrep] Extension restarted during processing. Pipeline was interrupted.');
    await chrome.storage.local.set({
      recoveryNotice: {
        message: 'The extension was restarted during processing. The pipeline was interrupted. If audio was uploaded, you can re-transcribe from the dashboard.',
        timestamp: Date.now(),
      },
    });
    clearBadge();
    await redetectMeeting();
  } else if (currentState === 'meet-detected' || currentState === 'note-prompt') {
    setBadge('MEET', '#4a4aff');
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
