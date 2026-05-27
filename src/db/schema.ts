import Database from "better-sqlite3";
import { config } from "../../config/config.js";

export type UserEvent = {
  id: number;
  userId: string;
  action: string;
  metadata: string; // JSON string
  occurredAt: number; // Unix timestamp (ms)
};

export type DetectedPattern = {
  id: number;
  userId: string;
  patternType: string;
  score: number; // 0.0 – 1.0
  payload: string; // JSON string with supporting evidence
  detectedAt: number; // Unix timestamp (ms)
  notified: 0 | 1;
};

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(config.db.path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      metadata    TEXT    NOT NULL DEFAULT '{}',
      occurred_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_events_user_time
      ON user_events (user_id, occurred_at);

    CREATE TABLE IF NOT EXISTS detected_patterns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      pattern_type TEXT    NOT NULL,
      score        REAL    NOT NULL,
      payload      TEXT    NOT NULL DEFAULT '{}',
      detected_at  INTEGER NOT NULL,
      notified     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_notified
      ON detected_patterns (notified, detected_at);
  `);
}
