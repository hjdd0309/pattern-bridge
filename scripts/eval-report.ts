/**
 * scripts/eval-report.ts
 *
 * Standalone CLI tool: reports precision / feedback-response stats from the
 * notification_log table (populated by the missed-detector pipeline + UI
 * 👍/👎 feedback buttons). Prints a plain-text summary to stdout.
 *
 * Usage:
 *   npx tsx scripts/eval-report.ts
 */

import { getEvalStats, getRecentNotifications } from "../src/analyzer/notification-log.js";

const LINE = "═".repeat(62);

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function main(): void {
  console.log(LINE);
  console.log(" Pattern Bridge — 정량 평가 리포트 (notification_log)");
  console.log(LINE);

  const stats = getEvalStats();

  if (stats.total === 0) {
    console.log("\n기록된 알림이 없습니다. (missed-detector가 놓침을 감지하면 기록됩니다)\n");
    return;
  }

  console.log(`\n총 알림 수          : ${stats.total}건`);
  console.log(`피드백 응답 수      : ${stats.withFeedback}건`);
  console.log(`피드백 응답률       : ${pct(stats.feedbackRate)}`);
  console.log(`  └ 맞음(👍)        : ${stats.correct}건`);
  console.log(`  └ 틀림(👎)        : ${stats.incorrect}건`);
  console.log(
    `Precision           : ${stats.precision !== null ? pct(stats.precision) : "N/A (피드백 없음)"}`,
  );

  const recent = getRecentNotifications(10);
  if (recent.length) {
    console.log(`\n${"─".repeat(62)}`);
    console.log(" 최근 알림 (최대 10건)");
    console.log("─".repeat(62));
    for (const n of recent) {
      const time = new Date(n.triggeredAt).toLocaleString("ko-KR", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      const fb = n.userFeedback === "correct" ? "👍"
        : n.userFeedback === "incorrect" ? "👎"
        : "(미응답)";
      console.log(
        `  ${time}  [${n.patternType}]  신뢰도 ${pct(n.confidenceScore)}  ` +
        `${n.actualDelayMinutes}분 경과  ${fb}`,
      );
    }
  }

  console.log(`\n${LINE}\n`);
}

main();
