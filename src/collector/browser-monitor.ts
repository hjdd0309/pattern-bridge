import http from "http";
import os from "os";
import { logEvent } from "./log-event.js";

const DEFAULT_PORT = 7701;
const USER_ID = os.hostname();

let server: http.Server | null = null;

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const url = typeof parsed["url"] === "string" ? parsed["url"] : "";
      const title = typeof parsed["title"] === "string" ? parsed["title"] : "";
      const userId = typeof parsed["userId"] === "string" ? parsed["userId"] : USER_ID;

      if (!url) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "url required" }));
        return;
      }

      logEvent({ userId, action: "browser_url", metadata: { url, title } });
      console.log(`[browser-monitor] ${title} — ${url}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
    }
  });
}

export function startBrowserMonitor(port = DEFAULT_PORT): void {
  if (server) return;

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
