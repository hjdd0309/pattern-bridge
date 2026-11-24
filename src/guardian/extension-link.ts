import { WebSocketServer, type WebSocket } from "ws";
import { config } from "../../config/config.js";
import { extensionOrigin, tokensMatch, warnIfNoToken } from "../security/extension-auth.js";

// Command channel to the Chrome extension (guardian ⇄ extension, WebSocket on
// 127.0.0.1). The extension connects, proves itself with its origin and the
// EXTENSION_TOKEN in a hello message, then:
//   guardian → extension: get_tabs, close_tabs, open_urls, show_banner, hide_banner, notify
//   extension → guardian: result (reply to a command), close_now (banner button),
//                         pause / resume / status (popup), ping
// Tab reports still go to the collector over HTTP; this link is commands only.

export type Tab = {
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
let client: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Incoming) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const handlers = new Map<string, Handler>();

/** Registers what to do when the extension sends `type` (close_now, pause, …). */
export function onExtensionMessage(type: string, handler: Handler): void {
  handlers.set(type, handler);
}

export function isConnected(): boolean {
  return client !== null && client.readyState === client.OPEN;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Sends a command and waits for the extension's result. Rejects if not connected or no reply. */
export function request(type: string, payload: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Incoming> {
  const ws = client;
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
    verifyClient: (info: { origin: string }) => origin !== "" && info.origin === origin,
  });

  server.on("connection", (ws) => {
    let authed = false;
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
          ws.close(4003, "unauthorized");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        if (client && client !== ws) client.close(4000, "replaced");
        client = ws;
        send(ws, { type: "welcome" });
        console.log("[extension-link] extension connected");
        return;
      }
      void onMessage(ws, msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (client === ws) {
        client = null;
        console.log("[extension-link] extension disconnected");
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
  client?.close();
  client = null;
  server?.close();
  server = null;
}

// ── Typed commands ──────────────────────────────────────────────────────────

export async function getTabs(): Promise<Tab[]> {
  const res = await request("get_tabs");
  return Array.isArray(res["tabs"]) ? (res["tabs"] as Tab[]) : [];
}

export async function closeTabs(tabIds: number[]): Promise<number> {
  if (tabIds.length === 0) return 0;
  const res = await request("close_tabs", { tabIds });
  return typeof res["closed"] === "number" ? res["closed"] : 0;
}

export async function openUrls(urls: string[]): Promise<number> {
  const safe = urls.filter((u) => /^https?:\/\//i.test(u));
  if (safe.length === 0) return 0;
  const res = await request("open_urls", { urls: safe });
  return typeof res["opened"] === "number" ? res["opened"] : 0;
}

export async function showBanner(interventionId: number, tabIds: number[], seconds: number, text: string): Promise<void> {
  await request("show_banner", { interventionId, tabIds, seconds, text });
}

export async function hideBanner(interventionId: number): Promise<void> {
  await request("hide_banner", { interventionId });
}

export async function notifyDesktop(title: string, message: string): Promise<void> {
  await request("notify", { title, message });
}
