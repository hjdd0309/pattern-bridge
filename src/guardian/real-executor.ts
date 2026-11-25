import { execFile } from "child_process";
import { classify } from "../collector/classifier.js";
import { getConfig } from "./config.js";
import type { ExecutionResult, Executor } from "./executor.js";
import * as link from "./extension-link.js";
import { groupOf } from "./groups.js";
import type { Intervention } from "./interventions.js";
import { isOpenableFile, type Workspace } from "./workspace.js";

// The real executor. Everything it does is on a whitelist:
//   - close tabs that are entertainment *right now* (re-classified at execution)
//   - open http/https URLs from the intervention plan (our own data or config)
//   - minimize all windows (one fixed PowerShell command)
//   - open documents from the plan that still exist under watched folders
// No string from outside is ever put into a command line: the file path is
// passed to PowerShell through an environment variable.

export type Shell = {
  minimizeAll(): Promise<void>;
  openFile(file: string): Promise<void>;
};

function powershell(command: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 10_000 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export const windowsShell: Shell = {
  minimizeAll: () => powershell("(New-Object -ComObject Shell.Application).MinimizeAll()"),
  openFile: (file) => powershell("Start-Process -LiteralPath $env:PB_OPEN_FILE", { PB_OPEN_FILE: file }),
};

function isEntertainment(tab: link.Tab): boolean {
  return groupOf(getConfig(), classify({ url: tab.url, title: tab.title }).category) === "entertainment";
}

function bannerText(it: Intervention): string {
  if (it.rule === "R2") return "오늘 공부·작업 시간이 평소보다 부족해요. 잠시 후 생산 모드를 켤게요.";
  if (it.plan["reopen"]) return "방금 정리한 오락 콘텐츠를 다시 열었어요. 곧 다시 정리할게요.";
  return "오락 콘텐츠를 오래 보고 있어요. 잠시 후 오락 탭을 정리할게요.";
}

export class RealExecutor implements Executor {
  constructor(private readonly shell: Shell = windowsShell) {}

  async showBanner(it: Intervention, secondsLeft: number): Promise<void> {
    if (!link.isConnected()) {
      console.warn(`[executor] #${it.id} banner skipped: extension not connected`);
      return;
    }
    const tabs = await link.getTabs();
    const targets = it.rule === "R1"
      ? tabs.filter(isEntertainment)
      : tabs.filter((t) => t.active && t.focusedWindow).concat(tabs.filter((t) => t.active && !t.focusedWindow)).slice(0, 1);
    await link.showBanner(it.id, targets, secondsLeft, bannerText(it));
  }

  async hideBanner(it: Intervention): Promise<void> {
    if (!link.isConnected()) return;
    await link.hideBanner(it.id).catch(() => {});
  }

  async execute(it: Intervention): Promise<ExecutionResult> {
    if (!link.isConnected()) return { ok: false, detail: { error: "extension_not_connected" } };
    try {
      const tabs = await link.getTabs();
      const closed = await link.closeTabs(tabs.filter(isEntertainment));
      if (it.rule !== "R2") return { ok: true, detail: { closed } };

      // Focus mode: clear the screen, then bring up the usual workspace.
      const ws = (it.plan["workspace"] ?? { files: [], urls: [] }) as Workspace;
      await this.shell.minimizeAll().catch((err: unknown) => console.warn("[executor] minimize failed:", String(err)));
      let filesOpened = 0;
      for (const file of ws.files ?? []) {
        if (!isOpenableFile(getConfig(), file)) continue;
        try {
          await this.shell.openFile(file);
          filesOpened++;
        } catch (err) {
          console.warn("[executor] open file failed:", err instanceof Error ? err.message : String(err));
        }
      }
      // Open them in the browser the user was in (its window is focused), else any.
      const inFront = tabs.find((t) => t.focusedWindow)?.browser;
      const urlsOpened = await link.openUrls(ws.urls ?? [], inFront);
      return { ok: true, detail: { closed, minimized: true, filesOpened, urlsOpened } };
    } catch (err) {
      return { ok: false, detail: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
}
