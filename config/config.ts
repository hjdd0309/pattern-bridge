import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  db: {
    path: path.resolve(__dirname, "../data/pattern-bridge.sqlite"),
  },

  openclaw: {
    webhookUrl: process.env["OPENCLAW_WEBHOOK_URL"] ?? "",
    token: process.env["OPENCLAW_TOKEN"] ?? "",
    timeoutMs: 5_000,
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
