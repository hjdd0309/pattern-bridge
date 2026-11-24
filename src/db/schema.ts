import fs from "fs";
import path from "path";
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

  // data/ is gitignored, so it does not exist on a fresh clone
  fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
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

    -- Collector liveness (single row, id = 1). See src/collector/heartbeat.ts.
    CREATE TABLE IF NOT EXISTS collector_status (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      pid        INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ── Intervention layer (guardian) ─────────────────────────────────────

    -- One row per judged minute: what the user was mostly doing in it.
    -- grp is the intervention group (entertainment / productive / leisure /
    -- neutral / unclassified / idle). idle_reason is set when grp = 'idle'.
    -- No titles or URLs: domain only, so this table can outlive raw events.
    CREATE TABLE IF NOT EXISTS activity_minutes (
      minute_start INTEGER PRIMARY KEY,
      grp          TEXT    NOT NULL,
      category     TEXT,
      subcategory  TEXT,
      app          TEXT,
      domain       TEXT,
      audible      INTEGER NOT NULL DEFAULT 0,
      idle_reason  TEXT
    );

    -- Every intervention the rules decided, and what happened to it.
    -- status: pending (grace running) / paused (user left the trigger during
    -- grace) / executed / cancelled. plan/result are JSON. executed_by:
    -- agent | fallback. outcome_grp: activity group 10 minutes later.
    CREATE TABLE IF NOT EXISTS interventions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      rule              TEXT    NOT NULL,
      status            TEXT    NOT NULL,
      decided_at        INTEGER NOT NULL,
      grace_until       INTEGER,
      paused_remaining  INTEGER,
      executed_at       INTEGER,
      executed_by       TEXT,
      cancel_reason     TEXT,
      plan              TEXT    NOT NULL DEFAULT '{}',
      result            TEXT    NOT NULL DEFAULT '{}',
      outcome_grp       TEXT,
      outcome_at        INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_interventions_status
      ON interventions (status, decided_at);

    -- Per-day totals (minutes), kept for baseline tuning and evaluation even
    -- for days left out of the baseline. day is the guardian day (05:00 start).
    CREATE TABLE IF NOT EXISTS daily_summary (
      day            TEXT    PRIMARY KEY,
      day_type       TEXT    NOT NULL,
      active_minutes INTEGER NOT NULL DEFAULT 0,
      productive     INTEGER NOT NULL DEFAULT 0,
      entertainment  INTEGER NOT NULL DEFAULT 0,
      leisure        INTEGER NOT NULL DEFAULT 0,
      neutral        INTEGER NOT NULL DEFAULT 0,
      unclassified   INTEGER NOT NULL DEFAULT 0,
      idle           INTEGER NOT NULL DEFAULT 0,
      pause_count    INTEGER NOT NULL DEFAULT 0,
      pause_minutes  INTEGER NOT NULL DEFAULT 0,
      in_baseline    INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );

    -- Small key/value store for guardian state that must survive restarts
    -- (pause, last R3 send, cached baseline, latest context snapshot).
    CREATE TABLE IF NOT EXISTS guardian_state (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
