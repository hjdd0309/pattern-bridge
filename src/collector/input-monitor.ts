import os from "os";
import { uIOhook } from "uiohook-napi";
import { logEvent } from "./log-event.js";

// Counts keyboard and mouse input and stores the counts once a minute as an
// input_activity event. Only counts are kept: no key codes, no text, no
// cursor positions. Used to tell "nobody is at the PC" from "watching".
// Minutes with no input at all write no row.

const USER_ID = os.hostname();
const FLUSH_INTERVAL_MS = 60_000;

let keys = 0;
let clicks = 0;
let wheels = 0;
let mouseMoved = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

function flush(): void {
  if (keys === 0 && clicks === 0 && wheels === 0 && !mouseMoved) return;
  logEvent({
    userId: USER_ID,
    action: "input_activity",
    metadata: { keys, clicks, wheels, mouseMoved, windowMs: FLUSH_INTERVAL_MS },
  });
  console.log(`[input-monitor] keys=${keys} clicks=${clicks} wheels=${wheels} moved=${mouseMoved}`);
  keys = 0;
  clicks = 0;
  wheels = 0;
  mouseMoved = false;
}

export function startInputMonitor(): void {
  if (running) return;

  uIOhook.on("keydown", () => { keys++; });
  uIOhook.on("mousedown", () => { clicks++; });
  uIOhook.on("wheel", () => { wheels++; });
  uIOhook.on("mousemove", () => { mouseMoved = true; });
  uIOhook.start();
  running = true;

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  console.log("[input-monitor] started");
}

export function stopInputMonitor(): void {
  if (!running) return;

  flush();
  uIOhook.stop();
  running = false;

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  console.log("[input-monitor] stopped");
}
