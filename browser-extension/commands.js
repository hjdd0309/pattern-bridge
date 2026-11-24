// Command channel from the guardian (WebSocket on 127.0.0.1:7702).
//
// The guardian decides; this file only carries out a fixed set of commands:
//   get_tabs, close_tabs, open_urls, show_banner, hide_banner, notify
// and forwards a few user actions back (banner "close now", popup pause).
// Page content is never read or sent anywhere.

const COMMAND_URL = 'ws://127.0.0.1:7702';
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
    sendCmd(sock, { type: 'hello', token });
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

const commandHandlers = {
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
    for (const url of Array.isArray(urls) ? urls : []) {
      if (!isHttpUrl(url)) continue;
      await chrome.tabs.create({ url, active: opened === 0 });
      opened++;
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
  return false;
});

connectCommands();
