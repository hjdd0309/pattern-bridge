import cron from "node-cron";
import { config } from "../../config/config.js";
import {
  analyzePatterns,
  getPendingPatterns,
  markPatternNotified,
} from "../analyzer/pattern-engine.js";
import { checkMissedPatterns } from "../analyzer/missed-detector.js";
import { logNotification } from "../analyzer/notification-log.js";
import { isConnectionError, sendWebhook } from "../trigger/openclaw-client.js";

async function runPipeline(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[${ts}] pipeline start`);
  const fresh = analyzePatterns();
  console.log(`[${ts}] detected ${fresh.length} pattern(s) this cycle`);
  const pending = getPendingPatterns();
  console.log(`[${ts}] ${pending.length} pending notification(s)`);
  for (const row of pending) {
    try {
      const res = await sendWebhook({
        userId: row.userId,
        patternType: row.patternType,
        score: row.score,
        evidence: JSON.parse(row.payload) as Record<string, unknown>,
      });
      // Webhook not configured — nothing was delivered, so leave the rest pending.
      if (!res.ok) break;
      markPatternNotified(row.id);
      console.log(`[${ts}] notified pattern #${row.id} (${row.patternType})`);
    } catch (err) {
      console.error(`[${ts}] failed to notify pattern #${row.id}:`, err instanceof Error ? err.message : err);
      // OpenClaw unreachable: every remaining row would fail the same way,
      // so stop here and retry the whole backlog next cycle.
      if (isConnectionError(err)) {
        console.error(`[${ts}] OpenClaw unreachable — ${pending.length} pending notification(s) deferred to next cycle`);
        break;
      }
    }
  }
  console.log(`[${ts}] pipeline end`);
}

async function runMissedDetector(): Promise<void> {
  const ts = new Date().toISOString();
  try {
    const missed = checkMissedPatterns();
    console.log(`[${ts}] missed patterns: ${missed.length}`);
    for (const event of missed) {
      // Log every missed-pattern detection for evaluation, independent of
      // whether the webhook delivery below succeeds.
      const triggeredAt = Date.now();
      logNotification({
        patternId:          event.patternId,
        triggeredAt,
        predictedTime:      triggeredAt - event.missedSince * 60_000,
        actualDelayMinutes: event.missedSince,
        confidenceScore:    event.confidence,
      });

      try {
        await sendWebhook({
          userId: "local",
          patternType: "missed",
          score: event.confidence,
          evidence: {
            label: event.label,
            expectedTime: event.expectedTime,
            missedSince: event.missedSince,
            action: event.action,
            description: `${event.label} (${event.missedSince}분 경과, 신뢰도 ${Math.round(event.confidence * 100)}%)`,
          },
        });
        console.log(`[${ts}] webhook sent for missed: ${event.label}`);
      } catch (err) {
        console.error(`[${ts}] webhook failed for missed:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("Missed-detector error:", err);
  }
}

export function startScheduler(): void {
  const { cron: expression, timezone } = config.scheduler;
  if (!cron.validate(expression)) {
    throw new Error(`Invalid cron expression: "${expression}"`);
  }
  console.log(`Scheduler starting — cron="${expression}" tz="${timezone}"`);
  cron.schedule(expression, () => {
    runPipeline().catch((err: unknown) => {
      console.error("Pipeline error:", err);
    });
  }, { timezone });
  cron.schedule("*/10 * * * *", () => {
    runMissedDetector().catch((err: unknown) => {
      console.error("Missed-detector error:", err);
    });
  }, { timezone });
  runPipeline().catch((err: unknown) => {
    console.error("Initial pipeline error:", err);
  });
}
