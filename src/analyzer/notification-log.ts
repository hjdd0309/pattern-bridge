import { getDb } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export type AlgorithmScoreBreakdown = {
  bayesian: number;
  prefixspan: number;
  fft: number;
};

export type LogNotificationInput = {
  patternId: number;
  triggeredAt: number;
  predictedTime: number;
  actualDelayMinutes: number;
  confidenceScore: number;
};

export type RecentNotification = {
  id: number;
  patternId: number;
  triggeredAt: number;
  predictedTime: number;
  actualDelayMinutes: number;
  confidenceScore: number;
  algorithmScores: string; // JSON string, parse for { bayesian, prefixspan, fft }
  userFeedback: "correct" | "incorrect" | null;
  feedbackAt: number | null;
  patternType: string;
  payload: string; // detected_patterns.payload — evidence for display
};

export type EvalStats = {
  total: number;
  withFeedback: number;
  correct: number;
  incorrect: number;
  precision: number | null; // correct / withFeedback, null when no feedback yet
  feedbackRate: number; // withFeedback / total
};

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Pull the three per-algorithm scores out of a detected_patterns.payload blob. */
function fetchAlgorithmScores(patternId: number): AlgorithmScoreBreakdown {
  const row = getDb()
    .prepare(`SELECT payload FROM detected_patterns WHERE id = ?`)
    .get(patternId) as { payload: string } | undefined;

  if (!row) return { bayesian: 0, prefixspan: 0, fft: 0 };

  try {
    const ev = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      bayesian:   Number(ev["bayesianScore"] ?? 0),
      prefixspan: Number(ev["prefixSpanScore"] ?? 0),
      fft:        Number(ev["fftScore"] ?? 0),
    };
  } catch {
    return { bayesian: 0, prefixspan: 0, fft: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Record one missed-pattern notification. Called every time missed-detector
 * fires, regardless of whether the OpenClaw webhook succeeds — this table
 * tracks detection quality, not delivery.
 */
export function logNotification(input: LogNotificationInput): number {
  const scores = fetchAlgorithmScores(input.patternId);

  const result = getDb()
    .prepare(`
      INSERT INTO notification_log
        (pattern_id, triggered_at, predicted_time, actual_delay_minutes,
         confidence_score, algorithm_scores)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.patternId,
      input.triggeredAt,
      input.predictedTime,
      input.actualDelayMinutes,
      input.confidenceScore,
      JSON.stringify(scores),
    );

  return Number(result.lastInsertRowid);
}

/** Record (or overwrite) the user's correct/incorrect feedback for a notification. */
export function setNotificationFeedback(
  id: number,
  feedback: "correct" | "incorrect",
): void {
  getDb()
    .prepare(`
      UPDATE notification_log
      SET    user_feedback = ?, feedback_at = ?
      WHERE  id = ?
    `)
    .run(feedback, Date.now(), id);
}

/** Most recent notifications, joined with their source pattern for display. */
export function getRecentNotifications(limit = 30): RecentNotification[] {
  return getDb()
    .prepare(`
      SELECT n.id                     AS id,
             n.pattern_id             AS patternId,
             n.triggered_at           AS triggeredAt,
             n.predicted_time         AS predictedTime,
             n.actual_delay_minutes   AS actualDelayMinutes,
             n.confidence_score       AS confidenceScore,
             n.algorithm_scores       AS algorithmScores,
             n.user_feedback          AS userFeedback,
             n.feedback_at            AS feedbackAt,
             p.pattern_type           AS patternType,
             p.payload                AS payload
      FROM   notification_log n
      JOIN   detected_patterns p ON p.id = n.pattern_id
      ORDER  BY n.triggered_at DESC
      LIMIT  ?
    `)
    .all(limit) as RecentNotification[];
}

/** Aggregate precision / feedback-rate stats across all logged notifications. */
export function getEvalStats(): EvalStats {
  const db = getDb();

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM notification_log`).get() as { c: number }
  ).c;

  const correct = (
    db.prepare(`SELECT COUNT(*) AS c FROM notification_log WHERE user_feedback = 'correct'`)
      .get() as { c: number }
  ).c;

  const incorrect = (
    db.prepare(`SELECT COUNT(*) AS c FROM notification_log WHERE user_feedback = 'incorrect'`)
      .get() as { c: number }
  ).c;

  const withFeedback = correct + incorrect;

  return {
    total,
    withFeedback,
    correct,
    incorrect,
    precision: withFeedback > 0 ? correct / withFeedback : null,
    feedbackRate: total > 0 ? withFeedback / total : 0,
  };
}

/**
 * Feedback tally grouped by the source pattern's patternKey (e.g.
 * "Google Chrome::tod::9"). Used by the ablation script to approximate
 * per-algorithm precision from the feedback already collected in production.
 */
export function getFeedbackByPatternKey(): Map<string, { correct: number; incorrect: number }> {
  const rows = getDb()
    .prepare(`
      SELECT json_extract(p.payload, '$.patternKey') AS patternKey,
             n.user_feedback                          AS feedback
      FROM   notification_log n
      JOIN   detected_patterns p ON p.id = n.pattern_id
      WHERE  n.user_feedback IS NOT NULL
    `)
    .all() as Array<{ patternKey: string | null; feedback: "correct" | "incorrect" }>;

  const out = new Map<string, { correct: number; incorrect: number }>();
  for (const { patternKey, feedback } of rows) {
    if (!patternKey) continue;
    const entry = out.get(patternKey) ?? { correct: 0, incorrect: 0 };
    if (feedback === "correct") entry.correct++;
    else entry.incorrect++;
    out.set(patternKey, entry);
  }
  return out;
}
