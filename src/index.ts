import { startWindowMonitor } from "./collector/window-monitor.js";
import { startBrowserMonitor } from "./collector/browser-monitor.js";
import { startFileMonitor } from "./collector/file-monitor.js";
import { startKeyboardMonitor } from "./collector/keyboard-monitor.js";
import { startBrowserHistory } from "./collector/browser-history.js";
import { calcAppTime, formatDuration } from "./collector/app-time.js";
import { startScheduler } from "./scheduler/index.js";

startWindowMonitor();
startBrowserMonitor();
startFileMonitor();
startKeyboardMonitor();
startBrowserHistory();
startScheduler();

// 시작 시 어제부터 지금까지 앱 사용시간 요약 출력
const stats = calcAppTime();
if (stats.length > 0) {
  console.log("[app-time] last 24h summary:");
  for (const { app, durationMs, sessions } of stats.slice(0, 10)) {
    console.log(`  ${app.padEnd(30)} ${formatDuration(durationMs)}  (${sessions} sessions)`);
  }
}
