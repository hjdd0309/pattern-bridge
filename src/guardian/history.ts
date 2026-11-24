import type Database from "better-sqlite3";
import type { GuardianConfig } from "./config.js";
import { groupOf, isLockApp, type MinuteGroup } from "./groups.js";
import { MINUTE_MS } from "./minute.js";

// Per-day activity totals for the baseline and daily_summary.
//
// Minutes the guardian judged come from activity_minutes. Every other minute
// (days before the guardian ran, e.g. the time-shifted demo dataset, or the
// part of a day before it was started) is rebuilt from window_focus: each
// window lasts until the next one, capped at IDLE_GAP_MS like the original
// app-time calculation, so a long gap counts as away rather than as the last
// window. Both paths use the same group mapping.

const IDLE_GAP_MS = 5 * MINUTE_MS;

export type DayType = "weekday" | "weekend";

export type DayStats = {
  /** Local date of the day's start, YYYY-MM-DD. */
  day: string;
  dayStart: number;
  dayType: DayType;
  source: "minutes" | "events" | "mixed" | "none";
  minutes: Record<MinuteGroup, number>;
  /** Minutes at the PC (everything except idle). */
  active: number;
  /** Productive minutes in each clock hour (index 0-23). */
  productiveByHour: number[];
};

function emptyMinutes(): Record<MinuteGroup, number> {
  return { entertainment: 0, productive: 0, leisure: 0, neutral: 0, unclassified: 0, idle: 0 };
}

export function dayKey(dayStart: number): string {
  const d = new Date(dayStart);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayTypeOf(dayStart: number): DayType {
  const wd = new Date(dayStart).getDay();
  return wd === 0 || wd === 6 ? "weekend" : "weekday";
}

/** Start of the guardian day `n` days before `dayStart` (calendar-safe). */
export function shiftDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Credits activity_minutes rows and returns the set of minutes they cover. */
function fromMinutes(db: Database.Database, dayStart: number, dayEnd: number, stats: DayStats): Set<number> {
  const rows = db
    .prepare("SELECT minute_start, grp FROM activity_minutes WHERE minute_start >= ? AND minute_start < ?")
    .all(dayStart, dayEnd) as Array<{ minute_start: number; grp: MinuteGroup }>;
  for (const r of rows) {
    stats.minutes[r.grp]++;
    if (r.grp === "productive") {
      const h = new Date(r.minute_start).getHours();
      stats.productiveByHour[h] = (stats.productiveByHour[h] ?? 0) + 1;
    }
  }
  return new Set(rows.map((r) => r.minute_start));
}

/**
 * Credits window_focus time for every minute NOT already covered by
 * activity_minutes (e.g. the morning before the guardian was started).
 * Returns whether any event time was credited.
 */
function fromEvents(
  db: Database.Database,
  cfg: GuardianConfig,
  userId: string,
  dayStart: number,
  dayEnd: number,
  stats: DayStats,
  covered: Set<number>,
): boolean {
  const rows = db
    .prepare(`
      SELECT metadata, occurred_at FROM user_events
      WHERE user_id = ? AND action = 'window_focus' AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at
    `)
    .all(userId, dayStart - IDLE_GAP_MS, dayEnd) as Array<{ metadata: string; occurred_at: number }>;
  if (rows.length === 0) return false;

  const ms = emptyMinutes();
  const productiveMsByHour = new Array<number>(24).fill(0);
  let credited = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const next = rows[i + 1]?.occurred_at ?? dayEnd;
    const from = Math.max(row.occurred_at, dayStart);
    const to = Math.min(next, row.occurred_at + IDLE_GAP_MS, dayEnd);
    if (to <= from) continue;
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch { /* unreadable row counts as unclassified */ }
    const category = typeof m["category"] === "string" ? m["category"] : null;
    const app = typeof m["app"] === "string" ? m["app"] : null;
    const grp: MinuteGroup = isLockApp(cfg, app) ? "idle" : groupOf(cfg, category);
    // Walk the segment minute by minute (it is at most IDLE_GAP_MS long),
    // skipping minutes the live tracker already judged.
    for (let t = from; t < to; ) {
      const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
      const end = Math.min(to, minute + MINUTE_MS);
      if (!covered.has(minute)) {
        ms[grp] += end - t;
        if (grp === "productive") {
          const h = new Date(t).getHours();
          productiveMsByHour[h] = (productiveMsByHour[h] ?? 0) + (end - t);
        }
        credited = true;
      }
      t = end;
    }
  }
  for (const g of Object.keys(ms) as MinuteGroup[]) stats.minutes[g] += Math.round(ms[g] / MINUTE_MS);
  productiveMsByHour.forEach((v, h) => {
    stats.productiveByHour[h] = (stats.productiveByHour[h] ?? 0) + Math.round(v / MINUTE_MS);
  });
  return credited;
}

export function statsForDay(db: Database.Database, cfg: GuardianConfig, userId: string, dayStart: number): DayStats {
  const dayEnd = shiftDays(dayStart, 1);
  const stats: DayStats = {
    day: dayKey(dayStart),
    dayStart,
    dayType: dayTypeOf(dayStart),
    source: "none",
    minutes: emptyMinutes(),
    active: 0,
    productiveByHour: new Array<number>(24).fill(0),
  };
  const covered = fromMinutes(db, dayStart, dayEnd, stats);
  const usedEvents = fromEvents(db, cfg, userId, dayStart, dayEnd, stats, covered);
  stats.source = covered.size > 0 ? (usedEvents ? "mixed" : "minutes") : usedEvents ? "events" : "none";
  stats.active = (Object.keys(stats.minutes) as MinuteGroup[])
    .filter((g) => g !== "idle")
    .reduce((sum, g) => sum + stats.minutes[g], 0);
  return stats;
}
