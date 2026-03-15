// Requests microphone permission in a full window context (popups can't show the prompt).
// Once granted, notifies the background script and closes this tab.

const statusEl = document.getElementById('status');

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Permission granted — stop the stream and notify background
    stream.getTracks().forEach((track) => track.stop());
    statusEl.textContent = 'Permission granted! Closing...';
    statusEl.className = 'granted';
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_GRANTED' });
    setTimeout(() => window.close(), 500);
  } catch (err) {
    statusEl.textContent = 'Permission denied. You can close this tab.';
    statusEl.className = 'denied';
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_DENIED' });
  }
})();
