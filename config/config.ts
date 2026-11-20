import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the project root if present. Variables already set in the
// environment (e.g. by PM2's ecosystem.config.cjs) take precedence.
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"));
} catch { /* no .env — fall back to process.env / defaults */ }

export const config = {
  db: {
    path: path.resolve(__dirname, "../data/pattern-bridge.sqlite"),
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
