// Collector process: records what the user is doing and nothing else.
// Judging and acting on it is the guardian process's job, and the legacy
// pattern scheduler (src/scheduler) is intentionally not started here.
import { startWindowMonitor } from "./window-monitor.js";
import { startBrowserMonitor } from "./browser-monitor.js";
import { startFileMonitor } from "./file-monitor.js";
import { startKeyboardMonitor } from "./keyboard-monitor.js";
import { calcAppTime, formatDuration } from "./app-time.js";

startWindowMonitor();
startBrowserMonitor();
startFileMonitor();
startKeyboardMonitor();

// 시작 시 어제부터 지금까지 앱 사용시간 요약 출력
const stats = calcAppTime();
if (stats.length > 0) {
  console.log("[app-time] last 24h summary:");
  for (const { app, durationMs, sessions } of stats.slice(0, 10)) {
    console.log(`  ${app.padEnd(30)} ${formatDuration(durationMs)}  (${sessions} sessions)`);
  }
}
