/**
 * scripts/run-ablation.ts
 *
 * Standalone CLI tool: runs the pattern-detection pipeline four times over
 * the raw collected data (window-monitor / browser-history events already in
 * user_events) — once per algorithm in isolation, and once with the full
 * weighted ensemble — and reports how many patterns each configuration
 * detects at confidence ≥ 0.75.
 *
 * This is a *read-only* dry run: it calls computePatternCandidates() directly
 * instead of analyzePatterns(), so nothing is written to detected_patterns.
 *
 * Precision per configuration is approximated by matching each candidate's
 * patternKey against notification_log entries that already carry real user
 * feedback (👍/👎 collected in production via the full ensemble). Configs
 * whose candidates have no feedback overlap are reported as N/A rather than
 * a fabricated number — with a single-user dataset, overlap is often small.
 *
 * Usage:
 *   npx tsx scripts/run-ablation.ts
 */

import { getDb } from "../src/db/schema.js";
import { config } from "../config/config.js";
import {
  fetchFocusEvents,
  computePatternCandidates,
  type AlgorithmWeights,
  type AppEvent,
  type PatternResult,
} from "../src/analyzer/pattern-engine.js";
import { getFeedbackByPatternKey } from "../src/analyzer/notification-log.js";

const LOOKBACK_MS = 30 * 24 * 60 * 60_000; // same 30-day window as analyzePatterns()

type AblationConfig = {
  name:    string;
  weights: AlgorithmWeights;
};

const CONFIGS: AblationConfig[] = [
  { name: "베이지안만",         weights: { bayesian: 1,    prefixSpan: 0,    fft: 0 } },
  { name: "PrefixSpan만",       weights: { bayesian: 0,    prefixSpan: 1,    fft: 0 } },
  { name: "FFT만",              weights: { bayesian: 0,    prefixSpan: 0,    fft: 1 } },
  { name: "전체 앙상블 (기본)", weights: { bayesian: 0.40, prefixSpan: 0.35, fft: 0.25 } },
];

type ConfigResult = {
  name:              string;
  weights:           AlgorithmWeights;
  detectedCount:     number;
  feedbackOverlap:   number;
  precision:         number | null;
};

/**
 * buildEnsemble() logs a "[pattern] ..." line per detection, which is useful
 * for the interactive `npm run analyze` CLI but far too noisy when run four
 * times back-to-back here. Swallow just those lines while computing.
 */
function withoutPatternLogs<T>(fn: () => T): T {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[pattern]")) return;
    original(...args);
  };
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

function weightLabel(w: AlgorithmWeights): string {
  return `베이${w.bayesian.toFixed(2)} / 시퀀${w.prefixSpan.toFixed(2)} / FFT${w.fft.toFixed(2)}`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function evaluateConfig(
  cfg:            AblationConfig,
  eventsByUser:   Map<string, AppEvent[]>,
  nowMs:          number,
  threshold:      number,
  feedbackByKey:  Map<string, { correct: number; incorrect: number }>,
): ConfigResult {
  const allCandidates: PatternResult[] = [];

  for (const [userId, events] of eventsByUser) {
    if (events.length < config.pattern.minEventCount) continue;
    allCandidates.push(
      ...computePatternCandidates(userId, events, nowMs, threshold, cfg.weights),
    );
  }

  let correct = 0;
  let incorrect = 0;
  for (const candidate of allCandidates) {
    const key = candidate.evidence["patternKey"];
    if (typeof key !== "string") continue;
    const fb = feedbackByKey.get(key);
    if (!fb) continue;
    correct += fb.correct;
    incorrect += fb.incorrect;
  }
  const feedbackOverlap = correct + incorrect;

  return {
    name:            cfg.name,
    weights:         cfg.weights,
    detectedCount:   allCandidates.length,
    feedbackOverlap,
    precision:       feedbackOverlap > 0 ? correct / feedbackOverlap : null,
  };
}

function printMarkdownTable(results: ConfigResult[]): void {
  console.log("| 설정 | 가중치 (베이/시퀀/FFT) | 검출 패턴 수 (≥75%) | 피드백 대조 건수 | 추정 Precision |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    const precisionCell = r.precision !== null ? pct(r.precision) : "N/A (표본 부족)";
    console.log(
      `| ${r.name} | ${weightLabel(r.weights)} | ${r.detectedCount} | ${r.feedbackOverlap} | ${precisionCell} |`,
    );
  }
}

function main(): void {
  const db      = getDb();
  const nowMs   = Date.now();
  const sinceMs = nowMs - LOOKBACK_MS;
  const { alertThreshold } = config.pattern;

  const users = (
    db.prepare(`SELECT DISTINCT user_id FROM user_events WHERE occurred_at >= ?`).all(sinceMs) as {
      user_id: string;
    }[]
  ).map(r => r.user_id);

  if (!users.length) {
    console.log("데이터가 없습니다. 수집기를 먼저 실행하세요 (npm run dev)");
    return;
  }

  const eventsByUser = new Map<string, AppEvent[]>();
  for (const userId of users) {
    eventsByUser.set(userId, fetchFocusEvents(db, userId, sinceMs));
  }

  const feedbackByKey = getFeedbackByPatternKey();

  const results = withoutPatternLogs(() =>
    CONFIGS.map(cfg => evaluateConfig(cfg, eventsByUser, nowMs, alertThreshold, feedbackByKey)),
  );

  console.log(`\nAblation Study — ${users.length}명 사용자, 최근 30일 원시 이벤트 기준, 신뢰도 임계값 ${pct(alertThreshold)}\n`);
  printMarkdownTable(results);
  console.log(
    "\n> Precision은 notification_log에 실제로 쌓인 사용자 피드백(👍/👎)을 patternKey로 대조한 근사치입니다.\n" +
    "> 피드백 표본이 없는 설정(N/A)은 실제 알림으로 노출된 적이 없어 비교가 불가능함을 의미하며, 0%로 해석해서는 안 됩니다.",
  );
}

main();
