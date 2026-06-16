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
      const meetTitle = getMeetingTitle();
      chrome.runtime.sendMessage({ type: 'MEET_DETECTED', url: window.location.href, meetTitle });
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
      stopCaptionCapture();
      if (meetingActive) {
        chrome.runtime.sendMessage({ type: 'MEET_ENDED' });
      }
    });
  }

  /**
   * Extract the meeting title from the Google Meet DOM.
   * Tries multiple selectors as Meet's DOM changes across versions.
   */
  function getMeetingTitle() {
    // Method 1: The meeting topic shown in the top bar
    const topicEl = document.querySelector('[data-meeting-title]');
    if (topicEl) return topicEl.getAttribute('data-meeting-title');

    // Method 2: The title element in the meeting info area
    const infoTitle = document.querySelector('[data-call-title]');
    if (infoTitle) return infoTitle.textContent.trim();

    // Method 3: From document.title (format: "Meeting Name - Google Meet")
    const docTitle = document.title;
    if (docTitle && docTitle !== 'Google Meet' && docTitle.includes(' - Google Meet')) {
      return docTitle.replace(' - Google Meet', '').trim();
    }
    if (docTitle && docTitle !== 'Google Meet' && !docTitle.startsWith('Meet -')) {
      return docTitle.replace('Meet - ', '').trim();
    }

    // Method 4: Look for the meeting code/name in the URL
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/);
    if (match) return `Meeting ${match[1]}`;

    return null;
  }

  // ---- Caption capture (speaker names) ----
  // Google Meet's native live captions carry real speaker names. We scrape them while
  // recording, timestamp each utterance relative to the audio start (captionT0), and send
  // spans to the backend, which aligns them to Sarvam's diarized segments by time-overlap.

  let captionT0 = null;            // epoch ms of audio recording start
  let captionObserver = null;
  let captionRoot = null;
  let captionFlushTimer = null;
  let captionIdleTimer = null;
  let primaryMissWarned = false;
  const trackedLines = new Map();  // lineNode -> { speaker, text, tStartMs, tEndMs }
  let spanBuffer = [];

  function nowRel() { return Math.max(0, Date.now() - (captionT0 || Date.now())); }

  // Layered resolver — primary documented classes, with structural/attribute fallbacks,
  // because Meet's obfuscated class names change without notice.
  function findCaptionRoot() {
    const primary = document.querySelector('.nMcdL.bj4p3b');
    if (primary) return primary;
    // Structural fallback: walk up from a caption-text node to a stable container.
    const textEl = document.querySelector('.ygicle.VbkSUe');
    if (textEl) {
      if (!primaryMissWarned) { console.warn('[Finrep] caption primary selector missed; using structural fallback'); primaryMissWarned = true; }
      return textEl.closest('[role="region"]') || textEl.parentElement?.parentElement?.parentElement || textEl.parentElement;
    }
    // Attribute fallback: a polite live region near the bottom of the call.
    const live = document.querySelector('[aria-live="polite"]');
    if (live) {
      if (!primaryMissWarned) { console.warn('[Finrep] caption selectors missed; using aria-live fallback'); primaryMissWarned = true; }
      return live;
    }
    return null;
  }

  function getCaptionLines(root) {
    // Primary: each caption text node maps to a line; speaker is its sibling name node.
    const textEls = root.querySelectorAll('.ygicle.VbkSUe');
    if (textEls.length > 0) {
      return Array.from(textEls).map((textEl) => {
        const lineNode = textEl.closest('.nMcdL') || textEl.parentElement?.parentElement || textEl.parentElement;
        const speakerEl = lineNode ? lineNode.querySelector('.NWpY1d') : null;
        return {
          node: lineNode || textEl,
          speaker: (speakerEl?.textContent || '').trim(),
          text: (textEl.textContent || '').trim(),
        };
      });
    }
    return [];
  }

  function finalizeLine(entry) {
    const text = (entry.text || '').trim();
    const speaker = (entry.speaker || '').trim();
    if (!speaker || !text || text.length < 2) return;
    spanBuffer.push({
      speaker,
      textSnippet: text.slice(0, 120),
      tStartMs: entry.tStartMs,
      tEndMs: Math.max(entry.tEndMs, entry.tStartMs + 200),
    });
  }

  function scanCaptions() {
    if (!captionRoot || !document.contains(captionRoot)) {
      captionRoot = findCaptionRoot();
      if (!captionRoot) return;
    }
    const lines = getCaptionLines(captionRoot);
    const seen = new Set();
    for (const line of lines) {
      seen.add(line.node);
      const existing = trackedLines.get(line.node);
      if (!existing) {
        trackedLines.set(line.node, { speaker: line.speaker, text: line.text, tStartMs: nowRel(), tEndMs: nowRel() });
      } else if (line.speaker && existing.speaker && line.speaker !== existing.speaker) {
        // Speaker reassigned on the same node — finalize the old utterance, start a new one.
        finalizeLine(existing);
        trackedLines.set(line.node, { speaker: line.speaker, text: line.text, tStartMs: nowRel(), tEndMs: nowRel() });
      } else {
        existing.text = line.text || existing.text;
        if (line.speaker) existing.speaker = line.speaker;
        existing.tEndMs = nowRel();
      }
    }
    // Finalize lines that scrolled out of the container.
    for (const [node, entry] of trackedLines) {
      if (!seen.has(node)) { finalizeLine(entry); trackedLines.delete(node); }
    }
  }

  function finalizeIdleLines() {
    const cutoff = nowRel() - 1500; // 1.5s without updates → utterance ended
    for (const [node, entry] of trackedLines) {
      if (entry.tEndMs < cutoff) { finalizeLine(entry); trackedLines.delete(node); }
    }
  }

  function flushSpans() {
    if (spanBuffer.length === 0) return;
    const drained = spanBuffer;
    spanBuffer = [];
    chrome.runtime.sendMessage({ type: 'CAPTION_SPANS', spans: drained });
  }

  function enableCaptions() {
    if (findCaptionRoot()) return true; // already on
    const selectors = [
      '[aria-label="Turn on captions"]',
      '[aria-label="Captions"]',
      '[data-tooltip*="aptions" i]',
      'button[jsname][aria-label*="aption" i]',
    ];
    let btn = null;
    for (const sel of selectors) { btn = document.querySelector(sel); if (btn) break; }
    if (!btn) { chrome.runtime.sendMessage({ type: 'CAPTION_STATUS', available: false, reason: 'toggle-not-found' }); return false; }
    btn.click();
    // Verify by container appearance (poll up to ~3s).
    let tries = 0;
    const verify = setInterval(() => {
      tries++;
      if (findCaptionRoot()) { clearInterval(verify); }
      else if (tries >= 12) { clearInterval(verify); chrome.runtime.sendMessage({ type: 'CAPTION_STATUS', available: false, reason: 'toggle-failed' }); }
    }, 250);
    return true;
  }

  function startCaptionCapture(audioT0) {
    if (captionObserver) return;
    captionT0 = audioT0 || Date.now();
    trackedLines.clear();
    spanBuffer = [];
    enableCaptions();
    // Give Meet a moment to render the caption container, then observe.
    setTimeout(() => {
      captionRoot = findCaptionRoot();
      captionObserver = new MutationObserver(() => scanCaptions());
      captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      captionFlushTimer = setInterval(flushSpans, 20000);
      captionIdleTimer = setInterval(finalizeIdleLines, 1000);
    }, 1200);
  }

  function stopCaptionCapture() {
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
    if (captionFlushTimer) { clearInterval(captionFlushTimer); captionFlushTimer = null; }
    if (captionIdleTimer) { clearInterval(captionIdleTimer); captionIdleTimer = null; }
    // Finalize everything still tracked, then flush.
    for (const [node, entry] of trackedLines) { finalizeLine(entry); }
    trackedLines.clear();
    flushSpans();
  }

  // Respond to CHECK_MEETING from background (used after reset); handle caption capture control.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CHECK_MEETING') {
      const endCallButton = document.querySelector('[data-tooltip="Leave call"]') ||
        document.querySelector('[aria-label="Leave call"]');
      sendResponse({ active: !!endCallButton, meetTitle: getMeetingTitle() });
    } else if (message.type === 'CAPTION_CAPTURE_START') {
      startCaptionCapture(message.audioT0);
    } else if (message.type === 'CAPTION_CAPTURE_STOP') {
      stopCaptionCapture();
    }
  });

  // Wait for page to be ready, then start observing
  if (document.readyState === 'complete') {
    startObserver();
  } else {
    window.addEventListener('load', startObserver);
  }
})();
