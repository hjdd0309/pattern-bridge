import os from "os";
import { getDb } from "../db/schema.js";

export type AppTimeStat = {
  app: string;
  durationMs: number;
  sessions: number;
};

// window_focus 이벤트 간격으로 앱별 사용시간을 계산한다.
// 연속 이벤트 간격이 MAX_SESSION_MS 이상이면 자리를 비운 것으로 보고 제외.
const MAX_SESSION_MS = 5 * 60 * 1_000;

export function calcAppTime(
  userId = os.hostname(),
  sinceMs = Date.now() - 24 * 60 * 60 * 1_000
): AppTimeStat[] {
  const db = getDb();

  const rows = db
    .prepare<[string, number], { app: string | null; occurred_at: number }>(
      `SELECT json_extract(metadata, '$.app') AS app,
              occurred_at
         FROM user_events
        WHERE user_id = ? AND action = 'window_focus' AND occurred_at >= ?
        ORDER BY occurred_at ASC`
    )
    .all(userId, sinceMs);

  const stats = new Map<string, { durationMs: number; sessions: number }>();

  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    const next = rows[i + 1];
    const app = current?.app ?? "Unknown";

    const gap = next
      ? next.occurred_at - (current?.occurred_at ?? 0)
      : 0;

    const durationMs = Math.min(gap, MAX_SESSION_MS);

    const existing = stats.get(app) ?? { durationMs: 0, sessions: 0 };
    stats.set(app, {
      durationMs: existing.durationMs + durationMs,
      sessions: existing.sessions + 1,
    });
  }

  return [...stats.entries()]
    .map(([app, stat]) => ({ app, ...stat }))
    .sort((a, b) => b.durationMs - a.durationMs);
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}
