import type Database from "better-sqlite3";
import os from "os";
import { getDb } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export type MissedEvent = {
  patternId:    number;
  label:        string;
  expectedTime: string;  // "09:00"
  missedSince:  number;  // minutes elapsed since expected time
  action:       string;  // "Chrome 열기"
  confidence:   number;  // 0.0 – 1.0
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// Only report missed after this many minutes past the expected hour
const MIN_MISSED_MINUTES = 10;

// Discard patterns whose window passed more than this many hours ago (stale)
const MAX_MISSED_HOURS = 12;

// Scan time_of_day patterns detected within the last N days
const PATTERN_LOOKBACK_DAYS = 7;

// ═══════════════════════════════════════════════════════════════════════════
// In-memory per-day dedup
// Prevents re-reporting the same missed event every 10-minute cycle
// ═══════════════════════════════════════════════════════════════════════════

const _reported = new Set<string>();
let _reportedDate = '';

function todayDateString(): string {
  // "2026-05-24" — locale-independent ISO date
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resetIfNewDay(): void {
  const today = todayDateString();
  if (today !== _reportedDate) {
    _reported.clear();
    _reportedDate = today;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DB helpers
// ═══════════════════════════════════════════════════════════════════════════

interface TimeOfDayPattern {
  id:     number;
  app:    string;
  hour:   number;
  score:  number;
}

/** Fetch distinct (app, hour) time_of_day patterns, keeping the best score each. */
function fetchTimeOfDayPatterns(
  db:     Database.Database,
  userId: string,
): TimeOfDayPattern[] {
  const since = Date.now() - PATTERN_LOOKBACK_DAYS * 86_400_000;

  const rows = db.prepare(`
    SELECT id,
           json_extract(payload, '$.app')  AS app,
           json_extract(payload, '$.hour') AS hour,
           score
    FROM   detected_patterns
    WHERE  user_id     = ?
      AND  pattern_type = 'time_of_day'
      AND  detected_at  >= ?
    ORDER  BY score DESC
  `).all(userId, since) as Array<{
    id: number; app: string | null; hour: number | null; score: number;
  }>;

  // Keep the single best entry per (app, hour)
  const best = new Map<string, TimeOfDayPattern>();
  for (const row of rows) {
    if (!row.app || row.hour === null) continue;
    const key = `${row.app}§${row.hour}`;
    if (!best.has(key)) {
      best.set(key, { id: row.id, app: row.app, hour: row.hour, score: row.score });
    }
  }
  return [...best.values()];
}

/** Returns true if the app appears in window_focus events today, at or after afterMs. */
function wasAppUsedToday(
  db:      Database.Database,
  userId:  string,
  app:     string,
  afterMs: number,
): boolean {
  const result = db.prepare(`
    SELECT 1
    FROM   user_events
    WHERE  user_id     = ?
      AND  action      = 'window_focus'
      AND  occurred_at >= ?
      AND  json_extract(metadata, '$.app') = ?
    LIMIT  1
  `).get(userId, afterMs, app);

  return result !== undefined && result !== null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function midnightMs(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatAction(app: string): string {
  const l = app.toLowerCase();
  if (/chrome|firefox|edge|safari|whale|arc|brave/.test(l)) return `${app} 열기`;
  if (/slack|teams|discord|zoom|kakaotalk/.test(l))          return `${app} 확인`;
  if (/terminal|iterm|wt|powershell|cmd|bash|zsh/.test(l))   return `${app} 실행`;
  if (/notion|obsidian|notes|bear|logseq/.test(l))           return `${app} 작성`;
  if (/spotify|music|itunes|melon/.test(l))                  return `${app} 재생`;
  if (/vscode|cursor|intellij|xcode|vim|emacs/.test(l))      return `${app} 열기`;
  return `${app} 열기`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan time_of_day patterns and emit a MissedEvent for each pattern whose
 * expected hour has passed today but the app has not been used.
 *
 * Logs:  "⚠️  놓침 감지: 매일 09:00 Chrome 확인 (32분 지남, 신뢰도 87%)"
 */
export function checkMissedPatterns(): MissedEvent[] {
  resetIfNewDay();

  const db        = getDb();
  const userId    = os.hostname();
  const now       = new Date();
  const nowMs     = now.getTime();
  const curHour   = now.getHours();
  const curMin    = now.getMinutes();
  const midnight  = midnightMs();

  const patterns  = fetchTimeOfDayPatterns(db, userId);
  const missed: MissedEvent[] = [];

  for (const p of patterns) {
    const minutesPast = (curHour - p.hour) * 60 + curMin;

    // Skip: expected hour hasn't come yet, or too recent, or too stale
    if (minutesPast < MIN_MISSED_MINUTES) continue;
    if (minutesPast > MAX_MISSED_HOURS * 60) continue;

    const dedupKey = `${p.app}§${p.hour}§${todayDateString()}`;
    if (_reported.has(dedupKey)) continue;

    // Expected time as ms today
    const expectedMs = midnight + p.hour * 3_600_000;

    if (wasAppUsedToday(db, userId, p.app, expectedMs)) continue;

    // ── Missed ──────────────────────────────────────────────────────────
    const hh:  string = String(p.hour).padStart(2, '0');
    const expectedTime = `${hh}:00`;

    const event: MissedEvent = {
      patternId:    p.id,
      label:        `매일 ${expectedTime} ${p.app}`,
      expectedTime,
      missedSince:  minutesPast,
      action:       formatAction(p.app),
      confidence:   p.score,
    };

    missed.push(event);
    _reported.add(dedupKey);

    console.log(
      `⚠️  놓침 감지: ${event.label} 확인 (${minutesPast}분 지남, 신뢰도 ${Math.round(p.score * 100)}%)`,
    );
  }

  return missed;
}

/** Expose today's reported dedup set size (for tests / diagnostics). */
export function reportedTodayCount(): number {
  resetIfNewDay();
  return _reported.size;
}
