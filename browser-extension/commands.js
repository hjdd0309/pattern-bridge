// Command channel from the guardian (WebSocket on 127.0.0.1:7702).
//
// The guardian decides; this file only carries out a fixed set of commands:
//   get_tabs, close_tabs, open_urls, show_banner, hide_banner, notify
// and forwards a few user actions back (banner "close now", popup pause).
// Page content is never read or sent anywhere.

const COMMAND_URL = 'ws://127.0.0.1:7702';

// Which Chromium browser this copy of the extension runs in. Tab and window ids
// are only unique within one browser, so every report and the hello carry it.
function detectBrowser() {
  const ua = (self.navigator && navigator.userAgent) || '';
  if (self.navigator && navigator.brave) return 'brave';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Whale\//.test(ua)) return 'whale';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  return 'chrome';
}
const BROWSER_NAME = detectBrowser();
const KEEPALIVE_MS = 20_000;   // WebSocket traffic keeps the MV3 service worker alive
const MAX_BACKOFF_MS = 60_000;

let ws = null;
let backoff = 2_000;
let keepaliveTimer = null;
let reconnectTimer = null;
let nextRequestId = 1;
const pendingReplies = new Map(); // requests the extension sent to the guardian

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function sendCmd(sock, msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

async function connectCommands() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  const { token } = await chrome.storage.local.get({ token: '' });
  let sock;
  try {
    sock = new WebSocket(COMMAND_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    backoff = 2_000;
    sendCmd(sock, { type: 'hello', token, browser: BROWSER_NAME });
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendCmd(sock, { type: 'ping' }), KEEPALIVE_MS);
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleCommand(sock, msg);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(keepaliveTimer);
    for (const p of pendingReplies.values()) p.reject(new Error('disconnected'));
    pendingReplies.clear();
    scheduleReconnect();
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectCommands, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

/** Sends a message to the guardian and waits for its reply (popup actions). */
function guardianRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('guardian_not_connected'));
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => { pendingReplies.delete(id); reject(new Error('timeout')); }, 5_000);
    pendingReplies.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    sendCmd(ws, { ...payload, type, id });
  });
}

async function listTabs() {
  const [tabs, focused] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused().catch(() => null),
  ]);
  return tabs
    .filter((t) => !t.incognito && isHttpUrl(t.url))
    .map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url,
      title: t.title ?? '',
      active: t.active === true,
      audible: t.audible === true,
      pinned: t.pinned === true,
      focusedWindow: !!focused && focused.focused === true && focused.id === t.windowId,
    }));
}

// ── Countdown banner (runs inside the page, isolated world) ────────────────
// These two functions are injected with chrome.scripting and must be
// self-contained. The banner lives in a closed shadow root so page styles
// cannot touch it, and it only ever talks back via chrome.runtime.

function pbShowBanner(interventionId, seconds, text) {
  const ID = 'pattern-bridge-banner';
  if (window.__pbBannerTimer) clearInterval(window.__pbBannerTimer);
  document.getElementById(ID)?.remove();

  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .b { font-family: -apple-system, 'Segoe UI', 'Malgun Gothic', sans-serif; width: 280px;
           background: #1e1b4b; color: #fff; border-radius: 12px; padding: 14px 16px;
           box-shadow: 0 8px 24px rgba(0,0,0,.35); }
      .h { font-size: 12px; opacity: .75; margin-bottom: 6px; }
      .t { font-size: 14px; line-height: 1.45; }
      .c { font-size: 26px; font-weight: 700; margin: 8px 0 10px; font-variant-numeric: tabular-nums; }
      button { all: unset; cursor: pointer; background: #4f46e5; color: #fff; border-radius: 8px;
               padding: 7px 12px; font-size: 13px; }
      button:hover { background: #6366f1; }
    </style>
    <div class="b">
      <div class="h">바른생활지킴이</div>
      <div class="t"></div>
      <div class="c"></div>
      <button type="button">지금 닫기</button>
    </div>`;
  root.querySelector('.t').textContent = text;
  const counter = root.querySelector('.c');
  const deadline = Date.now() + seconds * 1000;
  const render = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    counter.textContent = left > 0
      ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      : '정리 중…';
  };
  render();
  window.__pbBannerTimer = setInterval(render, 1000);
  root.querySelector('button').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'close_now', interventionId });
  });
  document.documentElement.appendChild(host);
}

function pbHideBanner() {
  if (window.__pbBannerTimer) clearInterval(window.__pbBannerTimer);
  document.getElementById('pattern-bridge-banner')?.remove();
}

const bannerTabs = new Map(); // interventionId → tabIds showing its banner

async function chromeIsFocused() {
  try {
    const w = await chrome.windows.getLastFocused();
    return w.focused === true;
  } catch {
    return false;
  }
}

function desktopNotify(title, message) {
  chrome.notifications.create(`pb-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
  });
}

const commandHandlers = {
  async show_banner({ interventionId, tabIds, seconds, text }) {
    const shown = [];
    for (const tabId of Array.isArray(tabIds) ? tabIds : []) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: pbShowBanner,
          args: [interventionId, Number(seconds) || 0, String(text || '')],
        });
        shown.push(tabId);
      } catch { /* chrome:// pages, closed tabs, ... */ }
    }
    bannerTabs.set(interventionId, shown);
    // The banner is invisible when Chrome is not in front: also notify.
    if (!(await chromeIsFocused())) desktopNotify('바른생활지킴이', String(text || ''));
    return { shown: shown.length };
  },

  async hide_banner({ interventionId }) {
    for (const tabId of bannerTabs.get(interventionId) ?? []) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, func: pbHideBanner });
      } catch { /* tab already closed */ }
    }
    bannerTabs.delete(interventionId);
    return {};
  },

  async notify({ title, message }) {
    desktopNotify(String(title || '바른생활지킴이'), String(message || ''));
    return {};
  },

  async get_tabs() {
    return { tabs: await listTabs() };
  },

  async close_tabs({ tabIds }) {
    let closed = 0;
    for (const id of Array.isArray(tabIds) ? tabIds : []) {
      try {
        await chrome.tabs.remove(id);
        closed++;
      } catch { /* already closed */ }
    }
    return { closed };
  },

  async open_urls({ urls }) {
    let opened = 0;
    let windowId = null;
    for (const url of Array.isArray(urls) ? urls : []) {
      if (!isHttpUrl(url)) continue;
      const tab = await chrome.tabs.create({ url, active: opened === 0 });
      windowId = windowId ?? tab.windowId;
      opened++;
    }
    // Focus mode minimizes everything first: bring the window with the new tabs back.
    if (windowId !== null) {
      try {
        await chrome.windows.update(windowId, { state: 'normal', focused: true });
      } catch { /* window gone */ }
    }
    return { opened };
  },
};

async function handleCommand(sock, msg) {
  if (msg.type === 'reply' && pendingReplies.has(msg.id)) {
    pendingReplies.get(msg.id).resolve(msg);
    pendingReplies.delete(msg.id);
    return;
  }
  const handler = commandHandlers[msg.type];
  if (!handler || typeof msg.id !== 'number') return; // welcome, pong, unknown
  try {
    const result = await handler(msg);
    sendCmd(sock, { type: 'result', id: msg.id, ok: true, ...result });
  } catch (err) {
    sendCmd(sock, { type: 'result', id: msg.id, ok: false, error: String(err && err.message || err) });
  }
}

// Keep the connection alive across service-worker restarts.
chrome.alarms.create('pb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pb-keepalive') connectCommands();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'token_changed') {
    if (ws) ws.close();
    connectCommands();
  }
  if (msg && msg.type === 'close_now' && typeof msg.interventionId === 'number') {
    // Banner button: ask the guardian to run the intervention right away.
    sendCmd(ws, { type: 'close_now', interventionId: msg.interventionId });
  }
  if (msg && msg.type === 'guardian' && ['pause', 'resume', 'status'].includes(msg.action)) {
    // Popup → guardian (pause / resume / status); answer asynchronously.
    const payload = msg.action === 'pause' ? { preset: msg.preset } : {};
    guardianRequest(msg.action, payload).then(
      (reply) => sendResponse(reply),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  return false;
});

connectCommands();
