import os from "os";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import { logEvent } from "./log-event.js";

const USER_ID = os.hostname();

const DEFAULT_PATHS = [
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Downloads"),
];

let watcher: FSWatcher | null = null;

export function startFileMonitor(watchPaths = DEFAULT_PATHS): void {
  if (watcher) return;

  watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: 3,
    ignored: [
      /(^|[/\\])\./,                          // dotfiles
      /[/\\](AppData|node_modules)[/\\]/,      // 권한 에러 잦은 시스템 폴더
      /[/\\](System Volume Information|pagefile\.sys|hiberfil\.sys)/,
    ],
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on("error", (err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return; // 권한 없는 폴더 조용히 무시
    console.error("[file-monitor] watcher error:", err);
  });

  watcher.on("add", (filePath: string) => {
    logEvent({
      userId: USER_ID,
      action: "file_open",
      metadata: { path: filePath, ext: path.extname(filePath) },
    });
    console.log(`[file-monitor] add: ${filePath}`);
  });

  watcher.on("change", (filePath: string) => {
    logEvent({
      userId: USER_ID,
      action: "file_save",
      metadata: { path: filePath, ext: path.extname(filePath) },
    });
    console.log(`[file-monitor] change: ${filePath}`);
  });

  console.log(`[file-monitor] watching: ${watchPaths.join(", ")}`);
}

export function stopFileMonitor(): Promise<void> {
  if (!watcher) return Promise.resolve();
  return watcher.close().then(() => {
    watcher = null;
    console.log("[file-monitor] stopped");
  });
}
