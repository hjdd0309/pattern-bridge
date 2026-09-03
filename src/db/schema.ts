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

export type NotificationLog = {
  id: number;
  patternId: number;
  triggeredAt: number; // Unix timestamp (ms) — when the notification fired
  predictedTime: number; // Unix timestamp (ms) — expected time the pattern predicted
  actualDelayMinutes: number; // minutes past the predicted time when triggered
  confidenceScore: number; // ensemble score at trigger time, 0.0 – 1.0
  algorithmScores: string; // JSON string: { bayesian, prefixspan, fft }
  userFeedback: "correct" | "incorrect" | null;
  feedbackAt: number | null; // Unix timestamp (ms)
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

    CREATE TABLE IF NOT EXISTS notification_log (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_id           INTEGER NOT NULL REFERENCES detected_patterns(id),
      triggered_at         INTEGER NOT NULL,
      predicted_time       INTEGER NOT NULL,
      actual_delay_minutes INTEGER NOT NULL,
      confidence_score     REAL    NOT NULL,
      algorithm_scores     TEXT    NOT NULL DEFAULT '{}',
      user_feedback        TEXT,
      feedback_at          INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_notification_log_pattern
      ON notification_log (pattern_id);

    CREATE INDEX IF NOT EXISTS idx_notification_log_feedback
      ON notification_log (user_feedback);
  `);
}
