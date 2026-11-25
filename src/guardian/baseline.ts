import type Database from "better-sqlite3";
import type { GuardianConfig } from "./config.js";
import { shiftDays, statsForDay, type DayStats, type DayType } from "./history.js";
import { getState, setState } from "./state.js";

// R2 baseline: how much productive time the user usually has by each hour.
//
// Over the last `baselineDays` finished days, keep only days with at least
// `minActiveMinutesPerDay` at the PC, split weekday/weekend, and take the
// median of the cumulative productive minutes from the day start up to each
// clock hour, plus the median daily total. Recomputed once per guardian day.

export type BaselineSet = {
  days: number;
  /** Clock hour (0-23) → median productive minutes from the day start up to that hour. */
  cumulativeAt: Record<string, number>;
  /** Median productive minutes over a whole day. */
  dailyMedian: number;
};

export type Baseline = {
  dayStart: number;
  computedAt: number;
  weekday: BaselineSet;
  weekend: BaselineSet;
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Clock hours in guardian-day order: startHour, startHour+1, …, 23, 0, …, startHour-1. */
export function dayHours(startHour: number): number[] {
  return Array.from({ length: 24 }, (_, i) => (startHour + i) % 24);
}

/** Productive minutes from the day start up to (not including) clock hour h, for every h. */
export function cumulativeByHour(stats: DayStats, startHour: number): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const h of dayHours(startHour)) {
    out[String(h)] = sum;
    sum += stats.productiveByHour[h] ?? 0;
  }
  return out;
}

/**
 * Usual productive minutes from the day start up to `at`, interpolated within
 * the clock hour (15:30 is halfway between the values for 15 and 16).
 */
export function usualBy(set: BaselineSet, startHour: number, at: number): number {
  const d = new Date(at);
  const hours = dayHours(startHour);
  const i = hours.indexOf(d.getHours());
  const from = set.cumulativeAt[String(hours[i])] ?? 0;
  const to = i + 1 < hours.length ? (set.cumulativeAt[String(hours[i + 1])] ?? from) : set.dailyMedian;
  return from + (to - from) * (d.getMinutes() / 60);
}

function buildSet(days: DayStats[], startHour: number): BaselineSet {
  const cumulatives = days.map((d) => cumulativeByHour(d, startHour));
  const cumulativeAt: Record<string, number> = {};
  for (const h of dayHours(startHour)) cumulativeAt[String(h)] = median(cumulatives.map((c) => c[String(h)] ?? 0));
  return { days: days.length, cumulativeAt, dailyMedian: median(days.map((d) => d.minutes.productive)) };
}

/** Stats for each of the `baselineDays` finished days before `todayStart`, newest first. */
export function recentDays(db: Database.Database, cfg: GuardianConfig, userId: string, todayStart: number): DayStats[] {
  const out: DayStats[] = [];
  for (let k = 1; k <= cfg.rules.R2.baselineDays; k++) out.push(statsForDay(db, cfg, userId, shiftDays(todayStart, -k)));
  return out;
}

export function isBaselineDay(cfg: GuardianConfig, stats: DayStats): boolean {
  return stats.active >= cfg.rules.R2.minActiveMinutesPerDay;
}

export function computeBaseline(cfg: GuardianConfig, days: DayStats[], todayStart: number, now: number): Baseline {
  const used = days.filter((d) => isBaselineDay(cfg, d));
  const of = (t: DayType) => buildSet(used.filter((d) => d.dayType === t), cfg.day.startHour);
  return { dayStart: todayStart, computedAt: now, weekday: of("weekday"), weekend: of("weekend") };
}

/** Cached baseline for today, recomputed when the guardian day changes. */
export function getBaseline(db: Database.Database, cfg: GuardianConfig, userId: string, todayStart: number, now = Date.now()): Baseline {
  const cached = getState<Baseline>("baseline");
  if (cached && cached.dayStart === todayStart) return cached;
  const baseline = computeBaseline(cfg, recentDays(db, cfg, userId, todayStart), todayStart, now);
  setState("baseline", baseline, now);
  const fmt = (s: BaselineSet) => `${s.days} days, daily median ${s.dailyMedian}m`;
  console.log(`[baseline] recomputed: weekday ${fmt(baseline.weekday)} / weekend ${fmt(baseline.weekend)}`);
  return baseline;
}
