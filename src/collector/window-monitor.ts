import os from "os";
import activeWindow from "active-win";
import { logEvent } from "./log-event.js";

type WindowState = {
  title: string;
  app: string;
};

const USER_ID = os.hostname();

let lastWindow: WindowState | null = null;
let timerId: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  const result = await activeWindow();
  if (!result) return;

  const current: WindowState = {
    title: result.title,
    app: result.owner.name,
  };

  if (lastWindow?.title === current.title && lastWindow?.app === current.app) {
    return;
  }

  lastWindow = current;

  logEvent({
    userId: USER_ID,
    action: "window_focus",
    metadata: {
      title: current.title,
      app: current.app,
      platform: result.platform,
      processId: result.owner.processId,
    },
  });

  console.log(`[window-monitor] ${current.app} — ${current.title}`);
}

export function startWindowMonitor(intervalMs = 1_000): void {
  if (timerId !== null) return;

  timerId = setInterval(() => {
    poll().catch((err: unknown) => {
      console.error("[window-monitor] poll error:", err);
    });
  }, intervalMs);

  console.log(`[window-monitor] started (interval=${intervalMs}ms)`);
}

export function stopWindowMonitor(): void {
  if (timerId === null) return;
  clearInterval(timerId);
  timerId = null;
  console.log("[window-monitor] stopped");
}
