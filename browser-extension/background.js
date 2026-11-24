// ── Config ─────────────────────────────────────────────────────────────────
const ENDPOINT = 'http://127.0.0.1:7701/collect';

// Reports every tab change to the local collector as a browser_tab event:
//   activated / focused  — the user switched tab or Chrome window (always sent)
//   updated              — URL, title or audible changed (e.g. next Short)
//   removed              — tab closed
//   snapshot             — every open tab, when Chrome or the extension starts
// The collector needs tabId/windowId/active to know which tab is in front.

// ── Dedup: tabId → last reported state ─────────────────────────────────────
// Only identical consecutive reports for the same tab are skipped. Service
// workers can be suspended; the map then restarts empty, which only means one
// extra report.
const lastSig = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

async function isEnabled() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  return enabled === true;
}

function isCollectable(tab) {
  const url = tab.url;
  if (!url || tab.incognito) return false;
  // Skip internal browser pages
  return !url.startsWith('chrome://') &&
         !url.startsWith('chrome-extension://') &&
         !url.startsWith('about:') &&
         !url.startsWith('edge://');
}

function toReport(tab) {
  return {
    tabId:    tab.id,
    windowId: tab.windowId,
    url:      tab.url,
    title:    tab.title ?? '',
    active:   tab.active === true,
    audible:  tab.audible === true,
  };
}

function signature(r) {
  return `${r.url}|${r.title}|${r.active}|${r.audible}`;
}

async function getToken() {
  const { token } = await chrome.storage.local.get({ token: '' });
  return token;
}

async function post(body) {
  try {
    await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pattern-Bridge-Token': await getToken() },
      body:    JSON.stringify(body),
    });
  } catch {
    // Collector offline — the next change or snapshot catches up.
  }
}

async function report(event, tab, { force = false } = {}) {
  if (!await isEnabled()) return;
  if (!isCollectable(tab)) return;

  const r = toReport(tab);
  const sig = signature(r);
  if (!force && lastSig.get(r.tabId) === sig) return;
  lastSig.set(r.tabId, sig);

  // Persist last activity for popup display
  if (r.active) {
    chrome.storage.local.set({ lastUrl: r.url, lastTitle: r.title, lastSentAt: Date.now() });
  }

  await post({ event, ...r });
}

async function snapshot() {
  if (!await isEnabled()) return;
  const tabs = (await chrome.tabs.query({})).filter(isCollectable).map(toReport);
  for (const r of tabs) lastSig.set(r.tabId, signature(r));
  await post({ event: 'snapshot', tabs });
}

// ── Event listeners ────────────────────────────────────────────────────────

// User switches to a different tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    report('activated', await chrome.tabs.get(tabId), { force: true });
  } catch {
    // Tab may have been closed before we read it.
  }
});

// URL / title / sound changed. Covers SPA navigation such as scrolling Shorts,
// where the page never fully reloads.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || 'audible' in changeInfo || changeInfo.status === 'complete') {
    report('updated', tab);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
  if (!lastSig.has(tabId)) return; // never reported (incognito, internal page)
  lastSig.delete(tabId);
  if (await isEnabled()) post({ event: 'removed', tabId, windowId });
});

// User moved between Chrome windows: report that window's active tab
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) report('focused', tab, { force: true });
  } catch {
    // Window closed in the meantime.
  }
});

chrome.runtime.onStartup.addListener(snapshot);
chrome.runtime.onInstalled.addListener(snapshot);
