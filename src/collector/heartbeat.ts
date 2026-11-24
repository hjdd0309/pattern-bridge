import { getDb } from "../db/schema.js";

// The collector writes a liveness timestamp to collector_status (single row).
// The window log only records changes, so without this the guardian could not
// tell "same window for a long time" from "collector is down" and would keep
// judging on stale data. The guardian stops judging when updated_at is stale.

const INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

function beat(startedAt: number): void {
  getDb()
    .prepare(`
      INSERT INTO collector_status (id, pid, started_at, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `)
    .run(process.pid, startedAt, Date.now());
}

export function startHeartbeat(): void {
  if (timer) return;
  const startedAt = Date.now();
  const tick = (): void => {
    try {
      beat(startedAt);
    } catch (err) {
      console.error("[heartbeat] write failed:", err);
    }
  };
  tick();
  timer = setInterval(tick, INTERVAL_MS);
  console.log(`[heartbeat] started (every ${INTERVAL_MS / 1000}s)`);
}

export function stopHeartbeat(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
