// Popup script — manages UI state and communicates with background service worker

const states = ['idle', 'meet-detected', 'recording', 'processing', 'summary', 'error'];
let timerInterval = null;

// ---- DOM Elements ----

const elements = {
  stateIdle: document.getElementById('state-idle'),
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

      case 'meet-detected':
        showState('meet-detected');
        stopTimer();
        break;

      case 'recording':
        showState('recording');
        if (data.startTime) startTimer(data.startTime);
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

elements.btnStart.addEventListener('click', async () => {
  const btn = elements.btnStart;
  btn.disabled = true;
  btn.textContent = 'Starting...';

  // Get the active tab to record
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab) {
    btn.textContent = 'No active tab found';
    btn.disabled = false;
    return;
  }

  // Check if we're on a Google Meet page
  const isGoogleMeet = activeTab.url && activeTab.url.includes('meet.google.com');
  if (!isGoogleMeet) {
    btn.textContent = 'Not on Google Meet';
    setTimeout(() => {
      btn.textContent = 'Start Recording';
      btn.disabled = false;
    }, 2000);
    return;
  }

  const includeMic = elements.toggleMic.checked;

  // Persist mic preference for next time
  chrome.storage.local.set({ includeMic });

  // Send request to background to start recording
  // The extension is "invoked" because user clicked the popup, so tabCapture will work
  chrome.runtime.sendMessage({
    type: 'START_RECORDING_REQUEST',
    tabId: activeTab.id,
    includeMic,
  });

  // Close popup — recording state will be shown when popup is reopened
  // Small delay so the message is sent first
  setTimeout(() => window.close(), 300);
});

elements.btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_REQUESTED' });
});

elements.btnCancel.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CANCEL_REQUESTED' });
  showState('idle');
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
          showState('idle');
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
  showState('idle');
  stopTimer();
});

// Listen for storage changes to update UI in real-time
chrome.storage.onChanged.addListener((changes) => {
  if (changes.extensionState || changes.stateData) {
    syncState();
  }
});

// Restore mic toggle preference
chrome.storage.local.get('includeMic', (result) => {
  elements.toggleMic.checked = result.includeMic || false;
});

// Initial sync
syncState();
