// ── Config ─────────────────────────────────────────────────────────────────
const ENDPOINT    = 'http://127.0.0.1:7701/collect';
const DEDUP_MS    = 30_000; // 30 seconds

// ── In-memory dedup table: url → last sent timestamp ───────────────────────
// Service workers can be suspended, but dedup restarts cleanly on wake.
const lastSent = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

async function isEnabled() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  return enabled === true;
}

function isCollectable(url) {
  if (!url) return false;
  // Skip internal browser pages
  return !url.startsWith('chrome://') &&
         !url.startsWith('chrome-extension://') &&
         !url.startsWith('about:') &&
         !url.startsWith('edge://');
}

async function send(url, title) {
  if (!await isEnabled()) return;
  if (!isCollectable(url)) return;

  const now = Date.now();
  if (now - (lastSent.get(url) ?? 0) < DEDUP_MS) return;

  lastSent.set(url, now);

  // Persist last activity for popup display
  chrome.storage.local.set({ lastUrl: url, lastTitle: title, lastSentAt: now });

  try {
    await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, title: title ?? '' }),
    });
  } catch {
    // Server offline — dedup entry is kept to avoid a burst on reconnect.
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

// Page fully loaded (navigation or SPA pushState via status='complete')
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    send(tab.url, tab.title);
  }
});

// User switches to a different tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      send(tab.url, tab.title);
    }
  } catch {
    // Tab may have been closed before we read it.
  }
});
