// Popup script — manages UI state and communicates with background service worker

const states = ['idle', 'note-prompt', 'meet-detected', 'recording', 'processing', 'summary', 'error'];
let timerInterval = null;

// ---- DOM Elements ----

const elements = {
  stateIdle: document.getElementById('state-idle'),
  stateNotePrompt: document.getElementById('state-note-prompt'),
  stateMeetDetected: document.getElementById('state-meet-detected'),
  stateRecording: document.getElementById('state-recording'),
  stateProcessing: document.getElementById('state-processing'),
  stateSummary: document.getElementById('state-summary'),
  stateError: document.getElementById('state-error'),
  recordingTimer: document.getElementById('recording-timer'),
  processingStep: document.getElementById('processing-step'),
  summaryTitle: document.getElementById('summary-title'),
  summaryText: document.getElementById('summary-text'),
  summaryDecisions: document.getElementById('summary-decisions'),
  summaryActions: document.getElementById('summary-actions'),
  callType: document.getElementById('call-type'),
  errorMessage: document.getElementById('error-message'),
  toggleMic: document.getElementById('toggle-mic'),
  btnStart: document.getElementById('btn-start'),
  btnStop: document.getElementById('btn-stop'),
  btnCancel: document.getElementById('btn-cancel'),
  btnSendSlack: document.getElementById('btn-send-slack'),
  btnRetry: document.getElementById('btn-retry'),
  btnReset: document.getElementById('btn-reset'),
  btnEnableNotes: document.getElementById('btn-enable-notes'),
  btnSkipNotes: document.getElementById('btn-skip-notes'),
};

// ---- State Display ----

function showState(stateName) {
  document.querySelectorAll('.state').forEach((el) => el.classList.add('hidden'));
  const stateEl = document.getElementById(`state-${stateName}`);
  if (stateEl) stateEl.classList.remove('hidden');
}

function updateProcessingSteps(currentStep) {
  const stepOrder = ['uploading', 'transcribing', 'summarizing'];
  const stepElements = {
    uploading: document.getElementById('step-uploading'),
    transcribing: document.getElementById('step-transcribing'),
    summarizing: document.getElementById('step-summarizing'),
  };

  const labels = {
    uploading: 'Uploading audio...',
    transcribing: 'Transcribing meeting...',
    summarizing: 'Generating summary...',
  };

  elements.processingStep.textContent = labels[currentStep] || 'Processing...';

  const currentIndex = stepOrder.indexOf(currentStep);
  stepOrder.forEach((step, i) => {
    const el = stepElements[step];
    el.className = 'step';
    if (i < currentIndex) el.classList.add('done');
    else if (i === currentIndex) el.classList.add('active');
  });
}

function renderSummary(summary) {
  elements.summaryTitle.textContent = summary.title || 'Meeting Summary';

  elements.summaryText.innerHTML = `
    <h3>Summary</h3>
    <p>${escapeHtml(summary.summary || '')}</p>
  `;

  if (summary.decisions && summary.decisions.length) {
    elements.summaryDecisions.innerHTML = `
      <h3>Key Decisions</h3>
      <ul>${summary.decisions.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
    `;
  } else {
    elements.summaryDecisions.innerHTML = '';
  }

  if (summary.actionItems && summary.actionItems.length) {
    elements.summaryActions.innerHTML = `
      <h3>Action Items</h3>
      <ul>${summary.actionItems.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
    `;
  } else {
    elements.summaryActions.innerHTML = '';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Timer ----

function startTimer(startTime) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hours = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    elements.recordingTimer.textContent = `${hours}:${minutes}:${seconds}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// ---- Audio Visualizer ----

const NUM_BARS = 20;
const vizContainer = document.getElementById('audio-visualizer');
const vizBars = [];

// Create bars dynamically
for (let i = 0; i < NUM_BARS; i++) {
  const bar = document.createElement('div');
  bar.className = 'viz-bar';
  vizContainer.appendChild(bar);
  vizBars.push(bar);
}

function updateVisualizer(levels) {
  if (!levels || levels.length === 0) {
    // No voice — all bars at minimum, remove active glow
    vizBars.forEach((bar) => {
      bar.style.height = '3px';
      bar.classList.remove('active');
    });
    return;
  }

  vizBars.forEach((bar, i) => {
    const level = levels[i] || 0;
    // Map level (0-100) to height (3px - 48px)
    const height = 3 + (level / 100) * 45;
    bar.style.height = `${height}px`;

    if (level > 5) {
      bar.classList.add('active');
    } else {
      bar.classList.remove('active');
    }
  });
}

// ---- State Sync ----

async function syncState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (!response) return;

    const { state, data } = response;

    switch (state) {
      case 'idle':
        showState('idle');
        stopTimer();
        break;

      case 'note-prompt':
        showState('note-prompt');
        stopTimer();
        break;

      case 'meet-detected':
        showState('meet-detected');
        stopTimer();
        break;

      case 'recording':
        showState('recording');
        if (data.startTime) startTimer(data.startTime);
        chrome.storage.local.get(['audioLevels', 'liveTranscript'], (result) => {
          updateVisualizer(result.audioLevels || null);
          updateLiveTranscript(result.liveTranscript || []);
        });
        break;

      case 'processing':
        showState('processing');
        stopTimer();
        if (data.step) updateProcessingSteps(data.step);
        break;

      case 'summary-ready':
        showState('summary');
        stopTimer();
        if (data.summary) renderSummary(data.summary);
        break;

      case 'error':
        showState('error');
        stopTimer();
        elements.errorMessage.textContent = data.message || 'An error occurred';
        break;

      default:
        showState('idle');
    }
  });
}

// ---- Event Listeners ----

elements.btnEnableNotes.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ENABLE_NOTES' });
});

elements.btnSkipNotes.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SKIP_NOTES' });
  showState('idle');
});

// Shared helper: check mic permission, request if needed, then start recording on a tab
async function startRecordingOnTab(btn, tabId, includeMic, manualTitle) {
  if (includeMic) {
    const permStatus = await navigator.permissions.query({ name: 'microphone' });
    if (permStatus.state === 'prompt') {
      chrome.windows.create({
        url: chrome.runtime.getURL('mic-permission.html'),
        type: 'popup',
        width: 450,
        height: 300,
        focused: true,
      });
      btn.textContent = 'Grant mic permission first';
      setTimeout(() => {
        btn.textContent = 'Start Recording';
        btn.disabled = false;
      }, 3000);
      return;
    } else if (permStatus.state === 'denied') {
      console.warn('[Finrep] Microphone permission previously denied, recording tab audio only');
      includeMic = false;
    }
  }

  chrome.storage.local.set({ includeMic });

  chrome.runtime.sendMessage({
    type: 'START_RECORDING_REQUEST',
    tabId,
    includeMic,
    manualTitle: manualTitle || null,
  });

  setTimeout(() => window.close(), 300);
}

// Meet-detected state start button (auto-detected Google Meet)
elements.btnStart.addEventListener('click', async () => {
  const btn = elements.btnStart;
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    btn.textContent = 'No active tab found';
    btn.disabled = false;
    return;
  }

  await startRecordingOnTab(btn, activeTab.id, elements.toggleMic.checked, null);
});

// Idle state manual start button (any tab)
document.getElementById('btn-manual-start').addEventListener('click', async () => {
  const btn = document.getElementById('btn-manual-start');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    btn.textContent = 'No active tab found';
    btn.disabled = false;
    return;
  }

  const titleInput = document.getElementById('manual-session-title');
  const manualTitle = titleInput ? titleInput.value.trim() : '';
  const includeMic = document.getElementById('toggle-mic-idle').checked;

  await startRecordingOnTab(btn, activeTab.id, includeMic, manualTitle || activeTab.title || 'Recording');
});

// ---- Mic / Tab mute toggles ----

document.getElementById('btn-mute-mic').addEventListener('click', () => {
  const btn = document.getElementById('btn-mute-mic');
  chrome.runtime.sendMessage({ type: 'TOGGLE_MIC_MUTE' }, (resp) => {
    const muted = resp?.muted ?? !btn.classList.contains('muted');
    btn.classList.toggle('muted', muted);
    btn.title = muted ? 'Unmute microphone' : 'Mute microphone';
    btn.textContent = muted ? '🔇' : '🎤';
  });
});

document.getElementById('btn-mute-tab').addEventListener('click', () => {
  const btn = document.getElementById('btn-mute-tab');
  chrome.runtime.sendMessage({ type: 'TOGGLE_TAB_MUTE' }, (resp) => {
    const muted = resp?.muted ?? !btn.classList.contains('muted');
    btn.classList.toggle('muted', muted);
    btn.title = muted ? 'Unmute tab audio' : 'Mute tab audio';
    btn.textContent = muted ? '🔇' : '🔊';
  });
});

elements.btnStop.addEventListener('click', () => {
  elements.btnStop.disabled = true;
  elements.btnStop.textContent = 'Stopping...';

  // Send stop to both offscreen (direct) and background (state cleanup)
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING', target: 'offscreen' });
  chrome.runtime.sendMessage({ type: 'STOP_REQUESTED' });

  // Fallback: if nothing happens within 5s, reset the button so user can try again
  setTimeout(() => {
    if (elements.btnStop.disabled) {
      elements.btnStop.disabled = false;
      elements.btnStop.textContent = 'Stop Recording';
    }
  }, 5000);
});

elements.btnCancel.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING', target: 'offscreen' });
  chrome.runtime.sendMessage({ type: 'CANCEL_REQUESTED' });
  // Don't hardcode idle — let background redetect meeting and drive state via syncState
  stopTimer();
});

elements.btnSendSlack.addEventListener('click', async () => {
  const btn = elements.btnSendSlack;
  btn.disabled = true;
  btn.textContent = 'Sending...';

  const { stateData } = await chrome.storage.local.get('stateData');
  const meetingId = stateData?.meetingId;
  const callType = elements.callType.value;

  if (!meetingId) {
    btn.textContent = 'Error: No meeting ID';
    btn.disabled = false;
    return;
  }

  chrome.runtime.sendMessage(
    { type: 'SEND_TO_SLACK', meetingId, callType },
    (response) => {
      if (response?.success) {
        btn.textContent = 'Sent!';
        setTimeout(() => {
          // Don't hardcode idle — background will redetect meeting and update state
          btn.textContent = 'Send to Slack';
          btn.disabled = false;
        }, 2000);
      } else {
        btn.textContent = 'Failed — Try Again';
        btn.disabled = false;
      }
    }
  );
});

elements.btnRetry.addEventListener('click', () => {
  syncState();
});

elements.btnReset.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET' });
  // Don't hardcode idle — background will redetect meeting and update state
  stopTimer();
});

// ---- Source Level Indicators ----

const micLevelBar = document.getElementById('mic-level-bar');
const tabLevelBar = document.getElementById('tab-level-bar');

function updateLiveTranscript(utterances) {
  const section = document.getElementById('live-transcript-section');
  const textEl = document.getElementById('live-transcript-text');
  if (!section || !textEl) return;

  if (!utterances || utterances.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  // Show last 3 utterances, newest at bottom
  const recent = utterances.slice(-3);
  textEl.innerHTML = recent.map((t, i) => {
    const opacity = 0.5 + (i / recent.length) * 0.5; // fade older utterances
    return `<span style="opacity:${opacity}">${escapeHtml(t)}</span>`;
  }).join('<br>');
  // Scroll to bottom
  textEl.scrollTop = textEl.scrollHeight;
}

function updateSourceLevels(micRms, tabRms) {
  // RMS values are scaled *1000 in offscreen, map to 0-100% width
  // Typical speech RMS*1000 is 5-50, so scale accordingly
  const micPct = Math.min(100, (micRms / 40) * 100);
  const tabPct = Math.min(100, (tabRms / 40) * 100);
  if (micLevelBar) micLevelBar.style.width = `${micPct}%`;
  if (tabLevelBar) tabLevelBar.style.width = `${tabPct}%`;
}

// Listen for storage changes to update UI in real-time
chrome.storage.onChanged.addListener((changes) => {
  if (changes.extensionState || changes.stateData) {
    syncState();
  }
  // Update audio visualizer bars when levels change
  if (changes.audioLevels) {
    updateVisualizer(changes.audioLevels.newValue);
  }
  // Update separate mic/tab levels
  if (changes.micRms || changes.tabRms) {
    const micRms = changes.micRms ? changes.micRms.newValue : 0;
    const tabRms = changes.tabRms ? changes.tabRms.newValue : 0;
    updateSourceLevels(micRms, tabRms);
  }
  // Update live transcript preview
  if (changes.liveTranscript) {
    updateLiveTranscript(changes.liveTranscript.newValue);
  }
  // Show recovery banner if set by background on startup
  if (changes.recoveryNotice && changes.recoveryNotice.newValue) {
    const notice = changes.recoveryNotice.newValue;
    if (Date.now() - notice.timestamp < 10 * 60 * 1000) {
      showRecoveryBanner(notice);
    }
  }
});

// Restore mic toggle preference (defaults to ON so user's voice is captured)
chrome.storage.local.get('includeMic', (result) => {
  const val = result.includeMic !== undefined ? result.includeMic : true;
  elements.toggleMic.checked = val;
  const idleMicToggle = document.getElementById('toggle-mic-idle');
  if (idleMicToggle) idleMicToggle.checked = val;
});

// ---- Recovery Banner ----

function showRecoveryBanner(notice) {
  const banner = document.getElementById('recovery-banner');
  const msg = document.getElementById('recovery-message');
  const recoverBtn = document.getElementById('btn-recover');
  if (!banner || !msg) return;

  let text = notice.message;
  if (notice.meetTitle) text += ` (${notice.meetTitle})`;
  msg.textContent = text;

  // Only show recover button if there's actual audio to recover
  recoverBtn.style.display = notice.hasRecoverableAudio ? '' : 'none';
  banner.classList.remove('hidden');
}

document.getElementById('btn-recover').addEventListener('click', () => {
  const btn = document.getElementById('btn-recover');
  btn.disabled = true;
  btn.textContent = 'Recovering...';
  chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING' }, (response) => {
    if (response?.success) {
      document.getElementById('recovery-banner').classList.add('hidden');
      chrome.storage.local.remove('recoveryNotice');
      syncState();
    } else {
      btn.textContent = 'Recovery Failed';
      btn.disabled = false;
    }
  });
});

document.getElementById('btn-dismiss-recovery').addEventListener('click', () => {
  document.getElementById('recovery-banner').classList.add('hidden');
  chrome.runtime.sendMessage({ type: 'DISMISS_RECOVERY' });
});

// Check for recovery notices on popup open
chrome.storage.local.get('recoveryNotice', (result) => {
  if (result.recoveryNotice) {
    const notice = result.recoveryNotice;
    // Show if less than 10 minutes old
    if (Date.now() - notice.timestamp < 10 * 60 * 1000) {
      showRecoveryBanner(notice);
    } else {
      chrome.storage.local.remove('recoveryNotice');
      chrome.runtime.sendMessage({ type: 'DISMISS_RECOVERY' });
    }
  }
});

// ---- Google Calendar ----

function updateCalendarBar(connected) {
  const bar = document.getElementById('calendar-bar');
  const text = document.getElementById('calendar-status-text');
  const btn = document.getElementById('btn-calendar-toggle');
  if (!bar) return;
  bar.style.display = 'flex';
  if (connected) {
    text.textContent = '📅 Calendar: Connected';
    text.style.color = '#7070ff';
    btn.textContent = 'Disconnect';
  } else {
    text.textContent = '📅 Calendar: Not connected';
    text.style.color = '#888';
    btn.textContent = 'Connect';
  }
}

document.getElementById('btn-calendar-toggle').addEventListener('click', () => {
  const btn = document.getElementById('btn-calendar-toggle');
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'GET_CALENDAR_STATUS' }, (res) => {
    const connected = res?.connected;
    const type = connected ? 'DISCONNECT_CALENDAR' : 'CONNECT_CALENDAR';
    chrome.runtime.sendMessage({ type }, (resp) => {
      btn.disabled = false;
      if (resp?.success) {
        updateCalendarBar(!connected);
      } else if (!connected) {
        const text = document.getElementById('calendar-status-text');
        text.textContent = '📅 Calendar: Auth failed — check OAuth setup';
        text.style.color = '#ff6b6b';
        setTimeout(() => updateCalendarBar(false), 3000);
      }
    });
  });
});

// Load calendar status on popup open
chrome.runtime.sendMessage({ type: 'GET_CALENDAR_STATUS' }, (res) => {
  updateCalendarBar(!!res?.connected);
});

// Initial sync
syncState();
