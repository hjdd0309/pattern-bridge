// Guardian process: the intervention (judgment) layer. It never collects
// anything itself; it reads what the collector wrote to SQLite, judges the
// user's context once a minute, and acts on it.
import { getConfig } from "./config.js";
import { trackUpTo, type Context } from "./tracker.js";

const TICK_MS = 60_000;
// Judge each minute a few seconds after it ends, so the collector has flushed it.
const TICK_OFFSET_MS = 3_000;

type TickHandler = (minuteStart: number, context: Context) => void | Promise<void>;

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

function describe(c: Context): string {
  const cur = c.current ? `${c.current.grp}${c.current.subcategory ? "/" + c.current.subcategory : ""}` : "-";
  return `now=${cur} streak=${c.streakMinutes}m today: productive=${c.today.productive}m consumption=${c.today.consumption}m idle=${c.today.idle}m`;
}

async function tick(minuteStart: number): Promise<void> {
  let context: Context;
  try {
    context = trackUpTo(getConfig(), minuteStart);
  } catch (err) {
    console.error("[guardian] tracking failed:", err instanceof Error ? err.message : err);
    scheduleNext();
    return;
  }
  if (!context.collectorAlive) {
    // Stale data would be judged as "still doing the last thing": skip rules.
    console.warn("[guardian] collector heartbeat is stale — judging paused");
    scheduleNext();
    return;
  }
  console.log(`[guardian] ${describe(context)}`);
  for (const h of handlers) {
    try {
      await h(minuteStart, context);
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
