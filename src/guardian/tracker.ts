import os from "os";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema.js";
import type { GuardianConfig } from "./config.js";
import { isExercise, type MinuteGroup } from "./groups.js";
import { judgeMinute, MINUTE_MS, type MinuteJudgment } from "./minute.js";
import { setState } from "./state.js";

// Writes one activity_minutes row per minute and derives what the rules need:
// the entertainment streak and today's totals. Everything is recomputed from
// activity_minutes, so a guardian restart loses nothing.

export const USER_ID = os.hostname();

// After a restart, judge at most this many missed minutes from raw events.
const BACKFILL_MAX_MINUTES = 120;
// The streak can span midnight and the day boundary; look back this far.
const STREAK_LOOKBACK_MS = 12 * 60 * MINUTE_MS;

export type DayTotals = {
  productive: number;
  entertainment: number;
  leisure: number;
  neutral: number;
  unclassified: number;
  idle: number;
  /** Minutes the user was at the PC (everything but idle). */
  active: number;
  /** Entertainment + leisure, without exercise: what R3 counts. */
  consumption: number;
};

export type Context = {
  at: number;
  dayStart: number;
  collectorAlive: boolean;
  /** Entertainment minutes in the current streak (R1). */
  streakMinutes: number;
  today: DayTotals;
  current: { minuteStart: number; grp: MinuteGroup; category: string | null; subcategory: string | null } | null;
};

/** Start (ms) of the guardian day containing t: today at startHour, or yesterday's if t is earlier. */
export function dayStartOf(cfg: GuardianConfig, t: number): number {
  const d = new Date(t);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cfg.day.startHour);
  if (d.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
  return start.getTime();
}

/** Whether the collector was running (heartbeat fresh) for a minute judged at `now`. */
export function collectorAliveFor(db: Database.Database, cfg: GuardianConfig, minuteStart: number, now: number): boolean {
  const row = db.prepare("SELECT started_at, updated_at FROM collector_status WHERE id = 1").get() as
    | { started_at: number; updated_at: number }
    | undefined;
  if (!row) return false;
  if (now - row.updated_at > cfg.idle.heartbeatStaleSeconds * 1000) return false;
  // Minutes from before this collector process started are unknown.
  return minuteStart + MINUTE_MS > row.started_at;
}

export function recordMinute(db: Database.Database, j: MinuteJudgment): void {
  db.prepare(`
    INSERT INTO activity_minutes (minute_start, grp, category, subcategory, app, domain, audible, idle_reason)
    VALUES (@minuteStart, @grp, @category, @subcategory, @app, @domain, @audible, @idleReason)
    ON CONFLICT(minute_start) DO UPDATE SET
      grp = excluded.grp, category = excluded.category, subcategory = excluded.subcategory,
      app = excluded.app, domain = excluded.domain, audible = excluded.audible, idle_reason = excluded.idle_reason
  `).run({ ...j, audible: j.audible ? 1 : 0 });
}

type MinuteRow = { minute_start: number; grp: MinuteGroup; category: string | null; subcategory: string | null };

function minutesBetween(db: Database.Database, from: number, to: number): MinuteRow[] {
  return db
    .prepare(`
      SELECT minute_start, grp, category, subcategory FROM activity_minutes
      WHERE minute_start >= ? AND minute_start < ? ORDER BY minute_start
    `)
    .all(from, to) as MinuteRow[];
}

/**
 * Entertainment streak at `end`: entertainment minutes add up; neutral and
 * unclassified minutes neither add nor break it; it resets after
 * resetProductiveMinutes in a row of productive/exercise, or after
 * resetNonEntertainmentMinutes in a row of anything that is not entertainment.
 * Minutes with no row (guardian or PC off) count as idle.
 */
export function computeStreak(cfg: GuardianConfig, rows: MinuteRow[], from: number, end: number): number {
  const byMinute = new Map(rows.map((r) => [r.minute_start, r]));
  let streak = 0;
  let productiveRun = 0;
  let nonEntertainmentRun = 0;
  for (let t = from; t < end; t += MINUTE_MS) {
    const r = byMinute.get(t);
    const grp: MinuteGroup = r?.grp ?? "idle";
    if (grp === "entertainment") {
      streak++;
      productiveRun = 0;
      nonEntertainmentRun = 0;
      continue;
    }
    nonEntertainmentRun++;
    productiveRun = grp === "productive" || isExercise(cfg, r?.category) ? productiveRun + 1 : 0;
    if (productiveRun >= cfg.streak.resetProductiveMinutes || nonEntertainmentRun >= cfg.streak.resetNonEntertainmentMinutes) {
      streak = 0;
    }
  }
  return streak;
}

export function computeTotals(cfg: GuardianConfig, rows: MinuteRow[]): DayTotals {
  const t: DayTotals = { productive: 0, entertainment: 0, leisure: 0, neutral: 0, unclassified: 0, idle: 0, active: 0, consumption: 0 };
  for (const r of rows) {
    t[r.grp]++;
    if (r.grp !== "idle") t.active++;
    if (r.grp === "entertainment" || (r.grp === "leisure" && !isExercise(cfg, r.category))) t.consumption++;
  }
  return t;
}

/** Context as of `end` (exclusive): all minutes before it are judged. */
export function computeContext(db: Database.Database, cfg: GuardianConfig, end: number, collectorAlive: boolean): Context {
  const dayStart = dayStartOf(cfg, end - 1);
  const from = Math.min(dayStart, end - STREAK_LOOKBACK_MS);
  const rows = minutesBetween(db, from, end);
  const last = rows[rows.length - 1];
  return {
    at: end,
    dayStart,
    collectorAlive,
    streakMinutes: computeStreak(cfg, rows, Math.max(from, end - STREAK_LOOKBACK_MS), end),
    today: computeTotals(cfg, rows.filter((r) => r.minute_start >= dayStart)),
    current: last && last.minute_start === end - MINUTE_MS
      ? { minuteStart: last.minute_start, grp: last.grp, category: last.category, subcategory: last.subcategory }
      : null,
  };
}

/**
 * Judges every minute up to and including `minuteStart` that has no row yet
 * (bounded by BACKFILL_MAX_MINUTES), then returns the fresh context.
 */
export function trackUpTo(cfg: GuardianConfig, minuteStart: number, now = Date.now()): Context {
  const db = getDb();
  const lastRow = db.prepare("SELECT MAX(minute_start) AS m FROM activity_minutes").get() as { m: number | null };
  const first = Math.max(
    (lastRow.m ?? -Infinity) + MINUTE_MS,
    minuteStart - (BACKFILL_MAX_MINUTES - 1) * MINUTE_MS,
  );
  for (let t = first; t <= minuteStart; t += MINUTE_MS) {
    const j = judgeMinute(db, cfg, USER_ID, t, { collectorAlive: collectorAliveFor(db, cfg, t, now) });
    recordMinute(db, j);
  }
  const context = computeContext(db, cfg, minuteStart + MINUTE_MS, collectorAliveFor(db, cfg, minuteStart, now));
  setState("context", context, now);
  return context;
}
