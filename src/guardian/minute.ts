import type Database from "better-sqlite3";
import type { GuardianConfig } from "./config.js";
import { groupOf, isChromeApp, isLockApp, isWatching, type MinuteGroup } from "./groups.js";

// Decides what one minute was "mostly" spent on.
//
// The foreground is the active window (window_focus). When that window is
// Chrome, the active tab of the focused Chrome window (browser_tab) is used
// instead, because the tab carries the URL. Within the minute, whichever
// foreground was in front the longest wins. The minute is idle when the
// screen is locked, the collector is down, or there was no keyboard/mouse
// input for idle.noInputMinutes while nothing was being watched.

export const MINUTE_MS = 60_000;
// How far back to replay events to rebuild the foreground and tab state.
const WINDOW_LOOKBACK_MS = 24 * 60 * MINUTE_MS;
const TAB_LOOKBACK_MS = 6 * 60 * MINUTE_MS;

export type IdleReason = "locked" | "collector_down" | "no_input" | "no_data";

export type MinuteJudgment = {
  minuteStart: number;
  grp: MinuteGroup;
  category: string | null;
  subcategory: string | null;
  app: string | null;
  domain: string | null;
  audible: boolean;
  idleReason: IdleReason | null;
};

type Foreground = {
  app: string | null;
  category: string | null;
  subcategory: string | null;
  domain: string | null;
  audible: boolean;
};

type Tab = { windowId: number; url: string; category: string | null; subcategory: string | null; audible: boolean };

type Row = { action: string; metadata: string; occurred_at: number };

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Replays window_focus / browser_tab events and reports the foreground at each change. */
class ForegroundTracker {
  private window: Foreground | null = null;
  private readonly tabs = new Map<number, Tab>();
  private readonly activeTab = new Map<number, number>(); // windowId → tabId
  private focusedWindow: number | null = null;

  apply(row: Row): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return;
    }
    if (row.action === "window_focus") {
      this.window = {
        app: str(m["app"]),
        category: str(m["category"]),
        subcategory: str(m["subcategory"]),
        domain: null,
        audible: false,
      };
      return;
    }
    if (row.action !== "browser_tab") return;

    const event = str(m["event"]) ?? "updated";
    const rawTabId = num(m["tabId"]);
    const tabId = rawTabId ?? -1; // reports from an old extension version carry no tabId
    const windowId = num(m["windowId"]) ?? -1;

    if (event === "removed") {
      this.tabs.delete(tabId);
      if (this.activeTab.get(windowId) === tabId) this.activeTab.delete(windowId);
      return;
    }
    const url = str(m["url"]);
    if (!url) return;
    this.tabs.set(tabId, {
      windowId,
      url,
      category: str(m["category"]),
      subcategory: str(m["subcategory"]),
      audible: m["audible"] === true,
    });
    const active = m["active"] === true || rawTabId === null;
    if (active) this.activeTab.set(windowId, tabId);
    if (event === "activated" || event === "focused" || rawTabId === null) this.focusedWindow = windowId;
    else if (this.focusedWindow === null && active) this.focusedWindow = windowId;
  }

  current(): Foreground | null {
    const w = this.window;
    if (!w) return null;
    if (isChromeApp(w.app) && this.focusedWindow !== null) {
      const tabId = this.activeTab.get(this.focusedWindow);
      const tab = tabId === undefined ? undefined : this.tabs.get(tabId);
      if (tab) {
        return {
          app: w.app,
          category: tab.category,
          subcategory: tab.subcategory,
          domain: domainOf(tab.url),
          audible: tab.audible,
        };
      }
    }
    return w;
  }
}

function key(f: Foreground): string {
  return [f.app, f.category, f.subcategory, f.domain].join("\u0001");
}

/** Foreground with the longest time inside [start, end), or null when nothing was known. */
export function dominantForeground(db: Database.Database, userId: string, start: number, end: number): Foreground | null {
  const latestWindow = db
    .prepare(`
      SELECT action, metadata, occurred_at FROM user_events
      WHERE user_id = ? AND action = 'window_focus' AND occurred_at < ? AND occurred_at >= ?
      ORDER BY occurred_at DESC LIMIT 1
    `)
    .get(userId, start, start - WINDOW_LOOKBACK_MS) as Row | undefined;

  const rows = db
    .prepare(`
      SELECT action, metadata, occurred_at FROM user_events
      WHERE user_id = ?
        AND ((action = 'browser_tab' AND occurred_at >= ?) OR (action = 'window_focus' AND occurred_at >= ?))
        AND occurred_at < ?
      ORDER BY occurred_at, id
    `)
    .all(userId, start - TAB_LOOKBACK_MS, start, end) as Row[];

  const tracker = new ForegroundTracker();
  if (latestWindow) tracker.apply(latestWindow);

  const spent = new Map<string, { fg: Foreground; ms: number }>();
  let cursor = start;
  let fg: Foreground | null = null;
  const credit = (until: number): void => {
    if (fg && until > cursor) {
      const k = key(fg);
      const entry = spent.get(k) ?? { fg, ms: 0 };
      entry.ms += until - cursor;
      entry.fg = { ...entry.fg, audible: entry.fg.audible || fg.audible };
      spent.set(k, entry);
    }
  };

  for (const row of rows) {
    if (row.occurred_at < start) {
      tracker.apply(row); // rebuild tab state before the minute
      continue;
    }
    if (fg === null && cursor === start) fg = tracker.current();
    credit(row.occurred_at);
    cursor = Math.max(cursor, row.occurred_at);
    tracker.apply(row);
    fg = tracker.current();
  }
  if (cursor === start && fg === null) fg = tracker.current();
  credit(end);

  let best: { fg: Foreground; ms: number } | null = null;
  for (const entry of spent.values()) if (!best || entry.ms > best.ms) best = entry;
  return best?.fg ?? null;
}

function hadInput(db: Database.Database, userId: string, from: number, to: number): boolean {
  const row = db
    .prepare(`
      SELECT 1 FROM user_events
      WHERE user_id = ? AND action IN ('input_activity', 'keyboard_activity')
        AND occurred_at > ? AND occurred_at <= ?
      LIMIT 1
    `)
    .get(userId, from, to);
  return row !== undefined;
}

export type JudgeOptions = {
  /** False when the collector was not running during this minute. */
  collectorAlive: boolean;
};

export function judgeMinute(
  db: Database.Database,
  cfg: GuardianConfig,
  userId: string,
  minuteStart: number,
  opts: JudgeOptions,
): MinuteJudgment {
  const end = minuteStart + MINUTE_MS;
  const idle = (idleReason: IdleReason, fg: Foreground | null = null): MinuteJudgment => ({
    minuteStart,
    grp: "idle",
    category: fg?.category ?? null,
    subcategory: fg?.subcategory ?? null,
    app: fg?.app ?? null,
    domain: fg?.domain ?? null,
    audible: fg?.audible ?? false,
    idleReason,
  });

  if (!opts.collectorAlive) return idle("collector_down");

  const fg = dominantForeground(db, userId, minuteStart, end);
  if (!fg) return idle("no_data");
  if (isLockApp(cfg, fg.app)) return idle("locked", fg);

  const watching = isWatching(cfg, fg.subcategory, fg.audible);
  if (!watching && !hadInput(db, userId, end - cfg.idle.noInputMinutes * MINUTE_MS, end)) {
    return idle("no_input", fg);
  }

  return {
    minuteStart,
    grp: groupOf(cfg, fg.category),
    category: fg.category,
    subcategory: fg.subcategory,
    app: fg.app,
    domain: fg.domain,
    audible: fg.audible,
    idleReason: null,
  };
}
