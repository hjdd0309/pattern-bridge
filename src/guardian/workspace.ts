import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { DEFAULT_PATHS as WATCHED_DIRS } from "../collector/file-monitor.js";
import type { GuardianConfig } from "./config.js";
import { groupOf } from "./groups.js";
import { dayTypeOf, type DayType } from "./history.js";
import { MINUTE_MS } from "./minute.js";

// R2 "focus mode" opens what the user usually works with:
//   1) documents saved in the last recentFileDays (newest first, maxFiles)
//   2) the productive domains used most in the last month at this time of day
//      on the same day type (±hourWindow), opened at their front page
//   3) if neither exists, the default list from config
// Computed when R2 is decided and stored in the intervention's plan, so the
// agent only ever references the intervention ID (never paths or URLs).

const DAY_MS = 24 * 60 * MINUTE_MS;

export type Workspace = { files: string[]; urls: string[]; source: "history" | "defaults" };

/** True for an existing document under one of the folders the collector watches. */
export function isOpenableFile(cfg: GuardianConfig, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const ext = path.extname(file).toLowerCase();
  if (!cfg.workspace.docExtensions.includes(ext)) return false;
  const resolved = path.resolve(file).toLowerCase();
  if (!WATCHED_DIRS.some((dir) => resolved.startsWith(path.resolve(dir).toLowerCase() + path.sep))) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function recentFiles(db: Database.Database, cfg: GuardianConfig, userId: string, now: number): string[] {
  const rows = db
    .prepare(`
      SELECT json_extract(metadata, '$.path') AS p FROM user_events
      WHERE user_id = ? AND action = 'file_save' AND occurred_at >= ?
      ORDER BY occurred_at DESC LIMIT 500
    `)
    .all(userId, now - cfg.workspace.recentFileDays * DAY_MS) as Array<{ p: string | null }>;
  const out: string[] = [];
  for (const { p } of rows) {
    if (!p || out.includes(p) || !isOpenableFile(cfg, p)) continue;
    out.push(p);
    if (out.length >= cfg.workspace.maxFiles) break;
  }
  return out;
}

function inHourWindow(t: number, hour: number, window: number): boolean {
  const h = new Date(t).getHours();
  const d = Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour));
  return d <= window;
}

/** Productive domains ranked by use at this time of day on the same day type over the last month. */
export function usualDomains(db: Database.Database, cfg: GuardianConfig, userId: string, now: number, dayType: DayType): string[] {
  const since = now - cfg.rules.R2.baselineDays * DAY_MS;
  const hour = new Date(now).getHours();
  const score = new Map<string, number>();
  const add = (domain: string | null, t: number, weight: number): void => {
    if (!domain || !domain.includes(".")) return;
    if (!inHourWindow(t, hour, cfg.workspace.hourWindow) || dayTypeOf(t) !== dayType) return;
    score.set(domain, (score.get(domain) ?? 0) + weight);
  };

  // Live minutes: one point per productive minute on that domain.
  const minutes = db
    .prepare("SELECT minute_start, domain FROM activity_minutes WHERE grp = 'productive' AND domain IS NOT NULL AND minute_start >= ?")
    .all(since) as Array<{ minute_start: number; domain: string }>;
  for (const m of minutes) add(m.domain, m.minute_start, 1);

  // Older history (e.g. the demo dataset) only has browser events.
  const events = db
    .prepare(`
      SELECT occurred_at, json_extract(metadata, '$.url') AS url, json_extract(metadata, '$.category') AS category
      FROM user_events
      WHERE user_id = ? AND action IN ('browser_url', 'browser_tab', 'browser_visit') AND occurred_at >= ?
    `)
    .all(userId, since) as Array<{ occurred_at: number; url: string | null; category: string | null }>;
  for (const e of events) {
    if (groupOf(cfg, e.category) !== "productive" || !e.url) continue;
    let domain = e.url;
    if (e.url.includes("://")) {
      try {
        domain = new URL(e.url).hostname;
      } catch {
        continue;
      }
    }
    add(domain, e.occurred_at, 1);
  }

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cfg.workspace.maxDomains)
    .map(([d]) => `https://${d}`);
}

export function computeWorkspace(db: Database.Database, cfg: GuardianConfig, userId: string, now: number): Workspace {
  const files = recentFiles(db, cfg, userId, now);
  const urls = usualDomains(db, cfg, userId, now, dayTypeOf(now));
  if (files.length === 0 && urls.length === 0) {
    return { files: [], urls: cfg.workspace.defaults.filter((u) => /^https?:\/\//i.test(u)), source: "defaults" };
  }
  return { files, urls, source: "history" };
}
