import type Database from "better-sqlite3";
import type { GuardianConfig } from "./config.js";
import { getBaseline, isBaselineDay, recentDays } from "./baseline.js";
import { shiftDays, type DayStats } from "./history.js";
import { MINUTE_MS } from "./minute.js";
import { pauseStats } from "./pause.js";

// Work done once per guardian day (at 05:00, and once at start-up):
// daily_summary rows, the new R2 baseline, and retention cleanup.

const DAY_MS = 24 * 60 * MINUTE_MS;
const REDACT_BATCH = 5000;
const REDACT_ACTIONS = ["window_focus", "browser_tab", "browser_url", "file_open", "file_save"];

/** Upserts one daily_summary row. Pause columns are left as they are. */
export function writeDailySummary(db: Database.Database, s: DayStats, inBaseline: boolean, now: number): void {
  db.prepare(`
    INSERT INTO daily_summary
      (day, day_type, active_minutes, productive, entertainment, leisure, neutral, unclassified, idle, in_baseline, updated_at)
    VALUES (@day, @dayType, @active, @productive, @entertainment, @leisure, @neutral, @unclassified, @idle, @inBaseline, @now)
    ON CONFLICT(day) DO UPDATE SET
      day_type = excluded.day_type, active_minutes = excluded.active_minutes,
      productive = excluded.productive, entertainment = excluded.entertainment, leisure = excluded.leisure,
      neutral = excluded.neutral, unclassified = excluded.unclassified, idle = excluded.idle,
      in_baseline = excluded.in_baseline, updated_at = excluded.updated_at
  `).run({
    day: s.day,
    dayType: s.dayType,
    active: s.active,
    ...s.minutes,
    inBaseline: inBaseline ? 1 : 0,
    now,
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.includes("/") ? "" : url;
  }
}

/**
 * Retention: raw text older than rawRetentionDays (titles, full URLs, file
 * paths) is reduced to what the baseline and evaluation still need — domain,
 * category, file extension. activity_minutes older than minuteRetentionDays
 * is deleted. Returns how many rows were touched.
 */
export function applyRetention(db: Database.Database, cfg: GuardianConfig, now: number): { redacted: number; minutesDeleted: number } {
  const cutoff = now - cfg.privacy.rawRetentionDays * DAY_MS;
  const select = db.prepare(`
    SELECT id, metadata FROM user_events
    WHERE occurred_at < ? AND action IN (${REDACT_ACTIONS.map(() => "?").join(",")})
      AND (json_extract(metadata, '$.title') IS NOT NULL
        OR json_extract(metadata, '$.path') IS NOT NULL
        OR json_extract(metadata, '$.url') LIKE '%://%')
    LIMIT ${REDACT_BATCH}
  `);
  const update = db.prepare("UPDATE user_events SET metadata = ? WHERE id = ?");
  let redacted = 0;
  for (;;) {
    const rows = select.all(cutoff, ...REDACT_ACTIONS) as Array<{ id: number; metadata: string }>;
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const r of rows) {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(r.metadata) as Record<string, unknown>;
        } catch {
          m = {};
        }
        delete m["title"];
        delete m["path"];
        if (typeof m["url"] === "string") m["url"] = hostOf(m["url"]);
        update.run(JSON.stringify(m), r.id);
      }
    })();
    redacted += rows.length;
  }
  const minutesDeleted = db
    .prepare("DELETE FROM activity_minutes WHERE minute_start < ?")
    .run(now - cfg.privacy.minuteRetentionDays * DAY_MS).changes;
  return { redacted, minutesDeleted };
}

/** Summaries for the recent days, today's baseline, and retention. */
export function onNewDay(db: Database.Database, cfg: GuardianConfig, userId: string, todayStart: number, now: number): void {
  for (const s of recentDays(db, cfg, userId, todayStart)) {
    if (s.source === "none") continue;
    writeDailySummary(db, s, isBaselineDay(cfg, s), now);
    const p = pauseStats(s.dayStart, shiftDays(s.dayStart, 1));
    db.prepare("UPDATE daily_summary SET pause_count = ?, pause_minutes = ? WHERE day = ?").run(p.count, p.minutes, s.day);
  }
  getBaseline(db, cfg, userId, todayStart, now);
  const r = applyRetention(db, cfg, now);
  if (r.redacted || r.minutesDeleted) {
    console.log(`[retention] reduced ${r.redacted} old events to domain/category, deleted ${r.minutesDeleted} old minutes`);
  }
}
