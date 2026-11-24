// Guardian process: the intervention (judgment) layer. It never collects
// anything itself; it reads what the collector wrote to SQLite, judges the
// user's context once a minute, and acts on it.
import { getConfig } from "./config.js";

const TICK_MS = 60_000;
// Judge each minute a few seconds after it ends, so the collector has flushed it.
const TICK_OFFSET_MS = 3_000;

type TickHandler = (minuteStart: number) => void | Promise<void>;

const handlers: TickHandler[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;

/** Registers work to run once per minute with the start (ms) of the minute just ended. */
export function onMinute(handler: TickHandler): void {
  handlers.push(handler);
}

function scheduleNext(): void {
  if (stopping) return;
  const now = Date.now();
  const next = Math.floor(now / TICK_MS) * TICK_MS + TICK_MS + TICK_OFFSET_MS;
  timer = setTimeout(() => void tick(next - TICK_OFFSET_MS - TICK_MS), next - now);
}

async function tick(minuteStart: number): Promise<void> {
  for (const h of handlers) {
    try {
      await h(minuteStart);
    } catch (err) {
      console.error("[guardian] tick handler failed:", err instanceof Error ? err.message : err);
    }
  }
  scheduleNext();
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  console.log(`[guardian] ${signal} received, stopping`);
  process.exit(0);
}

export function startGuardian(): void {
  const cfg = getConfig();
  console.log(`[guardian] started (demo=${cfg.demo.enabled}, day starts ${cfg.day.startHour}:00)`);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  scheduleNext();
}

startGuardian();
