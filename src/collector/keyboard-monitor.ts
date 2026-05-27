import os from "os";
import { uIOhook } from "uiohook-napi";
import { logEvent } from "./log-event.js";

const USER_ID = os.hostname();
const FLUSH_INTERVAL_MS = 60_000; // 1분마다 카운트 DB 저장

let keystrokeCount = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

function flush(): void {
  if (keystrokeCount === 0) return;
  logEvent({
    userId: USER_ID,
    action: "keyboard_activity",
    metadata: { count: keystrokeCount, windowMs: FLUSH_INTERVAL_MS },
  });
  console.log(`[keyboard-monitor] flushed ${keystrokeCount} keystrokes`);
  keystrokeCount = 0;
}

export function startKeyboardMonitor(): void {
  if (running) return;

  uIOhook.on("keydown", () => { keystrokeCount++; });
  uIOhook.start();
  running = true;

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  console.log("[keyboard-monitor] started");
}

export function stopKeyboardMonitor(): void {
  if (!running) return;

  flush();
  uIOhook.stop();
  running = false;

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  console.log("[keyboard-monitor] stopped");
}
