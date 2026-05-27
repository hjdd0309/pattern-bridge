import { analyzePatterns, getAllPatterns } from "./analyzer/pattern-engine.js";
import { getDb } from "./db/schema.js";

const DOW_KR = ["일", "월", "화", "수", "목", "금", "토"] as const;

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * window_focus 이벤트를 역조회해 앱 전환 시퀀스를 반환.
 * detected_at 기준 windowMs(기본 60분) 이내의 이벤트만 대상.
 * 연속 동일 앱은 하나로 합치고, 최대 maxApps 개까지만 반환.
 */
function lookupAppSequence(
  userId: string,
  detectedAt: number,
  windowMs = 60 * 60_000,
  maxApps = 6,
): string[] {
  const db = getDb();
  const since = detectedAt - windowMs;

  const rows = db
    .prepare(
      `SELECT json_extract(metadata, '$.app') AS app
         FROM user_events
        WHERE user_id = ? AND action = 'window_focus'
          AND occurred_at BETWEEN ? AND ?
        ORDER BY occurred_at ASC`,
    )
    .all(userId, since, detectedAt) as { app: string | null }[];

  const apps: string[] = [];
  let last = "";
  for (const { app } of rows) {
    if (app && app !== last) {
      apps.push(app);
      last = app;
    }
  }
  // 너무 길면 뒤를 자르고 "…" 표시
  return apps.length > maxApps ? [...apps.slice(0, maxApps), "…"] : apps;
}

function formatPattern(
  patternType: string,
  score: number,
  payload: string,
  userId: string,
  detectedAt: number,
): string {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return `[${patternType}] 신뢰도 ${pct(score)}`;
  }

  switch (patternType) {
    case "time_of_day": {
      const app = String(ev["app"] ?? "?");
      const hour = String(ev["hour"] ?? 0).padStart(2, "0");
      return `매일 ${hour}:00 - ${app} 사용 (신뢰도 ${pct(score)})`;
    }

    case "app_sequence": {
      // New ensemble format: sequence array
      if (Array.isArray(ev["sequence"])) {
        const seq = (ev["sequence"] as string[]).join(" → ");
        return `앱 전환 패턴: ${seq} (신뢰도 ${pct(score)})`;
      }
      // Legacy format: from / to pair
      const from = String(ev["from"] ?? "?");
      const to = String(ev["to"] ?? "?");
      return `${from} 후 항상 ${to} 열림 (신뢰도 ${pct(score)})`;
    }

    case "periodic": {
      const app = String(ev["app"] ?? "?");
      // New ensemble format: periodHours field
      if (ev["periodHours"] !== undefined) {
        const period = ev["periodHours"] === 168 ? "주간" : "일간";
        return `${app} ${period} 주기적 사용 감지 (신뢰도 ${pct(score)})`;
      }
      // Legacy format: pattern + dowDistribution
      if (ev["pattern"] === "weekly" && Array.isArray(ev["dowDistribution"])) {
        const dist = ev["dowDistribution"] as number[];
        const max = Math.max(...dist);
        const activeDays = dist
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c >= max * 0.5)
          .map(({ i }) => DOW_KR[i] ?? "?")
          .join("/");
        return `매주 ${activeDays}요일 ${app} 사용 패턴 감지 (신뢰도 ${pct(score)})`;
      }
      return `매일 ${app} 사용 패턴 감지 (신뢰도 ${pct(score)})`;
    }

    case "high_frequency": {
      const rate = Number(ev["ratePerMinute"] ?? 0).toFixed(1);
      return `고빈도 활동 감지: 분당 ${rate}회 (신뢰도 ${pct(score)})`;
    }

    case "repetitive_action": {
      const action = String(ev["topAction"] ?? "?");
      if (action === "window_focus") {
        const apps = lookupAppSequence(userId, detectedAt);
        if (apps.length > 0) {
          return `반복 전환: ${apps.join(" → ")} (신뢰도 ${pct(score)})`;
        }
      }
      return `반복 행동 감지: ${action} (신뢰도 ${pct(score)})`;
    }

    case "repetitive_sequence": {
      // topAction이 window_focus면 실제 앱 시퀀스를 역조회해 표시
      const topAction = String(ev["topAction"] ?? "");
      if (topAction === "window_focus" || topAction === "") {
        const apps = lookupAppSequence(userId, detectedAt);
        if (apps.length > 0) {
          return `${apps.join(" → ")} (신뢰도 ${pct(score)})`;
        }
      }
      return `반복 행동 감지: ${topAction || "window_focus"} (신뢰도 ${pct(score)})`;
    }

    case "inactivity_burst": {
      const gapMin = Math.round(Number(ev["maxGapMs"] ?? 0) / 60_000);
      return `${gapMin}분 비활성 후 폭발적 활동 감지 (신뢰도 ${pct(score)})`;
    }

    default:
      return `[${patternType}] 신뢰도 ${pct(score)}`;
  }
}

const SECTION_LABEL: Record<string, string> = {
  time_of_day:         "시간대별 패턴",
  app_sequence:        "순서 패턴",
  periodic:            "주기 패턴",
  high_frequency:      "고빈도 패턴",
  repetitive_action:   "반복 행동",
  repetitive_sequence: "반복 앱 전환",
  inactivity_burst:    "비활성 폭발",
};

function main(): void {
  console.log("━".repeat(50));
  console.log("  패턴 분석 실행 중...");
  console.log("━".repeat(50));

  const fresh = analyzePatterns();
  console.log(`\n이번 분석: ${fresh.length}개 신규 패턴 감지\n`);

  const all = getAllPatterns(7);

  if (all.length === 0) {
    console.log("최근 7일 내 감지된 패턴이 없습니다.");
    console.log("(window_focus 이벤트가 3일치 이상 쌓이면 딥 분석이 활성화됩니다)\n");
    return;
  }

  // 패턴 타입별로 묶어서 출력
  const grouped = new Map<string, typeof all>();
  for (const p of all) {
    const bucket = grouped.get(p.patternType) ?? [];
    bucket.push(p);
    grouped.set(p.patternType, bucket);
  }

  const order = [
    "time_of_day",
    "app_sequence",
    "periodic",
    "high_frequency",
    "repetitive_action",
    "repetitive_sequence",
    "inactivity_burst",
  ];

  // 정해진 순서대로, 나머지는 뒤에 붙임
  const sortedTypes = [
    ...order.filter((t) => grouped.has(t)),
    ...[...grouped.keys()].filter((t) => !order.includes(t)),
  ];

  for (const type of sortedTypes) {
    const patterns = grouped.get(type)!;
    console.log(`▶ ${SECTION_LABEL[type] ?? type} (${patterns.length}건)`);
    for (const p of patterns) {
      const line = formatPattern(p.patternType, p.score, p.payload, p.userId, p.detectedAt);
      const notifiedMark = p.notified ? " ✓" : "";
      console.log(`  • ${line}${notifiedMark}`);
    }
    console.log();
  }

  console.log("━".repeat(50));
  console.log(`  총 ${all.length}건 (최근 7일 기준, ✓ = 알림 발송 완료)`);
  console.log("━".repeat(50));
}

main();
