import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the project root if present. Variables already set in the
// environment (e.g. by PM2's ecosystem.config.cjs) take precedence.
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"));
} catch { /* no .env — fall back to process.env / defaults */ }

/**
 * The Chrome extension's ID, derived from the public key pinned in its
 * manifest ("key"), so it is the same on every machine. Chrome computes it as
 * the first 32 hex digits of SHA-256(public key DER), mapped 0-f → a-p.
 */
function extensionId(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../browser-extension/manifest.json"), "utf8"),
    ) as { key?: string };
    if (!manifest.key) return "";
    const hex = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
    return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
  } catch {
    return "";
  }
}

export const config = {
  extension: {
    id: extensionId(),
    /** Shared secret the extension sends with every request (entered once in its popup). */
    token: process.env["EXTENSION_TOKEN"] ?? "",
    collectPort: 7701,
    /** guardian's WebSocket server for commands to the extension. */
    commandPort: 7702,
  },

  db: {
    // DB_PATH lets a fresh clone run on dataset/pattern-bridge-anon.sqlite
    path: process.env["DB_PATH"]
      ? path.resolve(__dirname, "..", process.env["DB_PATH"])
      : path.resolve(__dirname, "../data/pattern-bridge.sqlite"),
  },

  openclaw: {
    webhookUrl: process.env["OPENCLAW_WEBHOOK_URL"] ?? "",
    token: process.env["OPENCLAW_TOKEN"] ?? "",
    // Where OpenClaw delivers the message: "telegram" | "discord" | ...
    notifyChannel: process.env["NOTIFY_CHANNEL"] || "telegram",
    // Recipient for that channel: Telegram chat id, Discord channel id, ...
    notifyTo: process.env["NOTIFY_TO"] ?? "",
    // OpenClaw can take well over 5s to admit a hook request. Timing out early
    // makes the caller treat a delivered message as failed and resend it.
    timeoutMs: Number(process.env["OPENCLAW_TIMEOUT_MS"]) || 30_000,
  },

  scheduler: {
    // Cron expression: every 5 minutes
    cron: process.env["SCHEDULER_CRON"] ?? "*/5 * * * *",
    timezone: "Asia/Seoul",
  },

  pattern: {
    // Minimum events required before pattern analysis runs
    minEventCount: 10,
    // Lookback window in minutes
    windowMinutes: 60,
    // Score threshold above which a webhook is fired
    alertThreshold: 0.75,
  },
} as const;

export type Config = typeof config;
