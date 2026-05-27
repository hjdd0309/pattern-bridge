import { getDb } from "../db/schema.js";

export type EventInput = {
  userId: string;
  action: string;
  metadata?: Record<string, unknown>;
  occurredAt?: number;
};

/**
 * Persists a single user behaviour event to the local SQLite store.
 * Returns the rowid of the inserted row.
 */
export function logEvent(input: EventInput): number {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO user_events (user_id, action, metadata, occurred_at)
    VALUES (@userId, @action, @metadata, @occurredAt)
  `);

  const info = stmt.run({
    userId: input.userId,
    action: input.action,
    metadata: JSON.stringify(input.metadata ?? {}),
    occurredAt: input.occurredAt ?? Date.now(),
  });

  return Number(info.lastInsertRowid);
}

/**
 * Bulk-inserts multiple events in a single transaction.
 * Returns the number of rows written.
 */
export function logEvents(inputs: EventInput[]): number {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO user_events (user_id, action, metadata, occurred_at)
    VALUES (@userId, @action, @metadata, @occurredAt)
  `);

  const insertMany = db.transaction((rows: EventInput[]) => {
    for (const row of rows) {
      stmt.run({
        userId: row.userId,
        action: row.action,
        metadata: JSON.stringify(row.metadata ?? {}),
        occurredAt: row.occurredAt ?? Date.now(),
      });
    }
    return rows.length;
  });

  return insertMany(inputs) as number;
}
