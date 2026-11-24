import { getDb } from "../db/schema.js";

// guardian_state accessors. Values are JSON so callers keep their own types.

export function getState<T>(key: string): T | null {
  const row = getDb()
    .prepare("SELECT value FROM guardian_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setState(key: string, value: unknown, now = Date.now()): void {
  getDb()
    .prepare(`
      INSERT INTO guardian_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    .run(key, JSON.stringify(value), now);
}

export function deleteState(key: string): void {
  getDb().prepare("DELETE FROM guardian_state WHERE key = ?").run(key);
}
