import http from "http";
import os from "os";
import { config } from "../../config/config.js";
import { logEvents, type EventInput } from "./log-event.js";
import { classify } from "./classifier.js";
import { extensionOrigin, isExtensionRequest, TOKEN_HEADER, warnIfNoToken } from "../security/extension-auth.js";

const DEFAULT_PORT = config.extension.collectPort;
const USER_ID = os.hostname();

let server: http.Server | null = null;

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Only our own extension may report tabs. Any web page in the browser could
  // otherwise POST fake "entertainment" tabs here and trigger interventions.
  const origin = extensionOrigin();
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/collect") {
    res.writeHead(404);
    res.end();
    return;
  }

  const auth = isExtensionRequest(req.headers.origin, req.headers[TOKEN_HEADER.toLowerCase()]);
  if (!auth.ok) {
    reply(res, auth.status, { ok: false, error: auth.error });
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      reply(res, 400, { ok: false, error: "invalid JSON" });
      return;
    }

    const event = str(parsed["event"]) || "updated";
    const events: EventInput[] = [];

    if (event === "snapshot") {
      const tabs = Array.isArray(parsed["tabs"]) ? parsed["tabs"] : [];
      for (const t of tabs) {
        const e = toTabEvent("snapshot", t as Record<string, unknown>);
        if (e) events.push(e);
      }
    } else if (event === "removed") {
      const tabId = num(parsed["tabId"]);
      if (tabId === null) {
        reply(res, 400, { ok: false, error: "tabId required" });
        return;
      }
      events.push({
        userId: USER_ID,
        action: "browser_tab",
        metadata: { event, tabId, windowId: num(parsed["windowId"]) },
      });
    } else {
      const e = toTabEvent(event, parsed);
      if (!e) {
        reply(res, 400, { ok: false, error: "url required" });
        return;
      }
      events.push(e);
    }

    if (events.length > 0) logEvents(events);
    if (event !== "snapshot") {
      const m = events[0]?.metadata ?? {};
      console.log(`[browser-monitor] ${event} tab=${String(m["tabId"])} ${String(m["category"] ?? "")} ${String(m["url"] ?? "")}`);
    } else {
      console.log(`[browser-monitor] snapshot: ${events.length} tab(s)`);
    }
    reply(res, 200, { ok: true });
  });
}

function reply(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One tab report → browser_tab event with its category. Tabs are classified by
 * URL and title only: passing the app name ("Google Chrome") would make
 * unknown sites fall into the browser rule (search) instead of `other`.
 */
function toTabEvent(event: string, t: Record<string, unknown>): EventInput | null {
  const url = str(t["url"]);
  if (!url) return null;
  const title = str(t["title"]);
  return {
    userId: USER_ID,
    action: "browser_tab",
    metadata: {
      event,
      tabId: num(t["tabId"]),
      windowId: num(t["windowId"]),
      url,
      title,
      active: t["active"] === true,
      audible: t["audible"] === true,
      ...classify({ url, title }),
    },
  };
}

export function startBrowserMonitor(port = DEFAULT_PORT): void {
  if (server) return;

  warnIfNoToken("browser-monitor");
  server = http.createServer(handleRequest);
  server.listen(port, "127.0.0.1", () => {
    console.log(`[browser-monitor] listening on http://127.0.0.1:${port}/collect`);
  });
}

export function stopBrowserMonitor(): void {
  if (!server) return;
  server.close(() => console.log("[browser-monitor] stopped"));
  server = null;
}
