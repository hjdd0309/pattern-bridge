import { WebSocketServer, type WebSocket } from "ws";
import { config } from "../../config/config.js";
import { extensionOrigin, tokensMatch, warnIfNoToken } from "../security/extension-auth.js";

// Command channel to the browser extension (guardian ⇄ extension, WebSocket on
// 127.0.0.1). Every Chromium browser with the extension (Chrome, Edge, ...)
// connects on its own; each proves itself with its origin and the
// EXTENSION_TOKEN in a hello message that also names the browser. Then:
//   guardian → extension: get_tabs, close_tabs, open_urls, show_banner, hide_banner, notify
//   extension → guardian: result (reply to a command), close_now (banner button),
//                         pause / resume / status (popup), ping
// Tab reports still go to the collector over HTTP; this link is commands only.

export type Tab = {
  /** Which browser the tab lives in; tab and window ids are only unique per browser. */
  browser: string;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  audible: boolean;
  pinned: boolean;
  /** Whether this tab's window is the focused Chrome window. */
  focusedWindow: boolean;
};

type Incoming = { type: string; id?: number; [k: string]: unknown };
type Handler = (msg: Incoming) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

const HELLO_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;

let server: WebSocketServer | null = null;
/** One connection per browser ("chrome", "edge", ...). */
const clients = new Map<string, WebSocket>();
let nextId = 1;
const pending = new Map<number, { resolve: (v: Incoming) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const handlers = new Map<string, Handler>();

/** Registers what to do when the extension sends `type` (close_now, pause, …). */
export function onExtensionMessage(type: string, handler: Handler): void {
  handlers.set(type, handler);
}

export function connectedBrowsers(): string[] {
  return [...clients.entries()].filter(([, ws]) => ws.readyState === ws.OPEN).map(([b]) => b);
}

export function isConnected(): boolean {
  return connectedBrowsers().length > 0;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Sends a command to one browser's extension (the first connected one when
 * `browser` is omitted) and waits for its result. Rejects if not connected or no reply.
 */
export function request(
  type: string,
  payload: Record<string, unknown> = {},
  browser?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Incoming> {
  const target = browser ?? connectedBrowsers()[0];
  const ws = target ? clients.get(target) : undefined;
  if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error("extension_not_connected"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("extension_timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send(ws, { ...payload, type, id });
  });
}

async function onMessage(ws: WebSocket, msg: Incoming): Promise<void> {
  if (msg.type === "result" && typeof msg.id === "number") {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
    return;
  }
  if (msg.type === "ping") {
    send(ws, { type: "pong" });
    return;
  }
  const handler = handlers.get(msg.type);
  if (!handler) return;
  try {
    const reply = await handler(msg);
    if (typeof msg.id === "number") send(ws, { type: "reply", id: msg.id, ok: true, ...(reply ?? {}) });
  } catch (err) {
    if (typeof msg.id === "number") send(ws, { type: "reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function startExtensionLink(port = config.extension.commandPort): void {
  if (server) return;
  warnIfNoToken("extension-link");
  const origin = extensionOrigin();
  server = new WebSocketServer({
    host: "127.0.0.1",
    port,
    // Reject anything that is not our extension before the upgrade.
    verifyClient: (info: { origin: string }) => {
      const ok = origin !== "" && info.origin === origin;
      if (!ok) console.warn(`[extension-link] rejected connection from ${info.origin || "(no origin)"}: origin not allowed — remove and reload the extension`);
      return ok;
    },
  });

  server.on("connection", (ws) => {
    let authed = false;
    let browser = "";
    const helloTimer = setTimeout(() => { if (!authed) ws.close(4001, "hello timeout"); }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: Incoming;
      try {
        msg = JSON.parse(data.toString()) as Incoming;
      } catch {
        return;
      }
      if (!authed) {
        const expected = config.extension.token;
        const given = typeof msg["token"] === "string" ? msg["token"] : "";
        if (msg.type !== "hello" || (expected && !tokensMatch(given, expected))) {
          console.warn("[extension-link] rejected connection: bad token — enter .env EXTENSION_TOKEN in the extension popup");
          ws.close(4003, "unauthorized");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        browser = typeof msg["browser"] === "string" && /^[a-z]{2,12}$/.test(msg["browser"]) ? msg["browser"] : "chrome";
        const previous = clients.get(browser);
        if (previous && previous !== ws) previous.close(4000, "replaced"); // same browser reconnected
        clients.set(browser, ws);
        send(ws, { type: "welcome" });
        console.log(`[extension-link] ${browser} extension connected`);
        return;
      }
      void onMessage(ws, msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (browser && clients.get(browser) === ws) {
        clients.delete(browser);
        console.log(`[extension-link] ${browser} extension disconnected`);
      }
    });
    ws.on("error", () => { /* close follows */ });
  });

  server.on("listening", () => console.log(`[extension-link] listening on ws://127.0.0.1:${port}`));
  server.on("error", (err) => console.error("[extension-link] server error:", err.message));
}

export function stopExtensionLink(): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("extension_link_stopped"));
  }
  pending.clear();
  for (const ws of clients.values()) ws.close();
  clients.clear();
  server?.close();
  server = null;
}

// ── Typed commands ──────────────────────────────────────────────────────────

function byBrowser(tabs: Tab[]): Map<string, Tab[]> {
  const out = new Map<string, Tab[]>();
  for (const t of tabs) out.set(t.browser, [...(out.get(t.browser) ?? []), t]);
  return out;
}

/** Open tabs from every connected browser. A browser that does not answer is skipped. */
export async function getTabs(): Promise<Tab[]> {
  const all: Tab[] = [];
  for (const browser of connectedBrowsers()) {
    try {
      const res = await request("get_tabs", {}, browser);
      const tabs = Array.isArray(res["tabs"]) ? (res["tabs"] as Array<Omit<Tab, "browser">>) : [];
      all.push(...tabs.map((t) => ({ ...t, browser })));
    } catch (err) {
      console.warn(`[extension-link] ${browser} get_tabs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return all;
}

export async function closeTabs(tabs: Tab[]): Promise<number> {
  let closed = 0;
  for (const [browser, group] of byBrowser(tabs)) {
    const res = await request("close_tabs", { tabIds: group.map((t) => t.tabId) }, browser);
    if (typeof res["closed"] === "number") closed += res["closed"];
  }
  return closed;
}

/** Opens URLs in `browser` (or the first connected one). Only http/https. */
export async function openUrls(urls: string[], browser?: string): Promise<number> {
  const safe = urls.filter((u) => /^https?:\/\//i.test(u));
  if (safe.length === 0) return 0;
  const res = await request("open_urls", { urls: safe }, browser);
  return typeof res["opened"] === "number" ? res["opened"] : 0;
}

export async function showBanner(interventionId: number, tabs: Tab[], seconds: number, text: string): Promise<void> {
  const groups = byBrowser(tabs);
  // No target tab: still send to one browser so it can raise a desktop notification.
  const first = connectedBrowsers()[0];
  if (groups.size === 0 && first) groups.set(first, []);
  for (const [browser, group] of groups) {
    await request("show_banner", { interventionId, tabIds: group.map((t) => t.tabId), seconds, text }, browser);
  }
}

export async function hideBanner(interventionId: number): Promise<void> {
  for (const browser of connectedBrowsers()) {
    await request("hide_banner", { interventionId }, browser).catch(() => {});
  }
}

export async function notifyDesktop(title: string, message: string): Promise<void> {
  await request("notify", { title, message });
}
