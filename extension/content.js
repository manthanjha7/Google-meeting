// Content script injected into Google Meet pages
// Detects meeting join/leave and notifies the background service worker

(function () {
  let meetingActive = false;
  let observerStarted = false;

  function detectMeetingState() {
    // Google Meet shows a "You left the meeting" or similar screen when meeting ends
    // The meeting is active when the end-call button is visible
    const endCallButton = document.querySelector('[data-tooltip="Leave call"]') ||
      document.querySelector('[aria-label="Leave call"]');
    const joinButton = document.querySelector('[data-tooltip="Join now"]') ||
      document.querySelector('[aria-label="Join now"]') ||
      document.querySelector('[data-tooltip="Ask to join"]');

    if (endCallButton && !meetingActive) {
      meetingActive = true;
      chrome.runtime.sendMessage({ type: 'MEET_DETECTED', url: window.location.href });
    }

    if (!endCallButton && meetingActive && !joinButton) {
      // Meeting likely ended — end call button gone and no join button (meaning we left)
      meetingActive = false;
      chrome.runtime.sendMessage({ type: 'MEET_ENDED' });
    }
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    // Poll for meeting state changes since Meet uses dynamic rendering
    const pollInterval = setInterval(() => {
      detectMeetingState();
    }, 2000);

    // Also observe DOM mutations for faster detection
    const observer = new MutationObserver(() => {
      detectMeetingState();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      clearInterval(pollInterval);
      observer.disconnect();
      if (meetingActive) {
        chrome.runtime.sendMessage({ type: 'MEET_ENDED' });
      }
    });
  }

  // Respond to CHECK_MEETING from background (used after reset)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CHECK_MEETING') {
      const endCallButton = document.querySelector('[data-tooltip="Leave call"]') ||
        document.querySelector('[aria-label="Leave call"]');
      sendResponse({ active: !!endCallButton });
    }
  });

  // Wait for page to be ready, then start observing
  if (document.readyState === 'complete') {
    startObserver();
  } else {
    window.addEventListener('load', startObserver);
  }
})();
