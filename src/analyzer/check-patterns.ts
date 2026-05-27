/**
 * src/analyzer/check-patterns.ts
 *
 * Standalone CLI tool: runs the three-algorithm ensemble analysis on the
 * current SQLite database and prints a detailed report to stdout.
 *
 * Usage:
 *   npx tsx src/analyzer/check-patterns.ts
 *   npm run analyze
 */

import { getDb } from "../db/schema.js";
import { analyzePatterns, getAllPatterns } from "./pattern-engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const LINE  = '═'.repeat(62);
const LINE2 = '─'.repeat(62);

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function bar(score: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, score));
  const filled  = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-algorithm pre-analysis (reads raw events, no DB write)
// ═══════════════════════════════════════════════════════════════════════════

interface RawEvent { app: string | null; occurredAt: number; }

function previewBayesian(userId: string): void {
  const db      = getDb();
  const sinceMs = Date.now() - 30 * 86_400_000;
  const rows    = db.prepare(`
    SELECT json_extract(metadata, '$.app') AS app, occurred_at AS occurredAt
    FROM   user_events
    WHERE  user_id = ? AND action = 'window_focus' AND occurred_at >= ?
    ORDER  BY occurred_at ASC
  `).all(userId, sinceMs) as RawEvent[];

  const events = rows.filter(r => r.app).map(r => ({ app: r.app!, occurredAt: r.occurredAt }));
  if (!events.length) { console.log('  (데이터 없음)'); return; }

  // Recency-weighted conditional probabilities
  const LAMBDA  = Math.LN2 / 7;
  const nowMs   = Date.now();
  const hourW   = new Map<number, number>();
  const hourAppW = new Map<string, number>();
  const rawCnt  = new Map<string, number>();

  for (const { app, occurredAt } of events) {
    const w  = Math.exp(-LAMBDA * (nowMs - occurredAt) / 86_400_000);
    const h  = new Date(occurredAt).getHours();
    const hk = `${h}§${app}`;
    hourW.set(h, (hourW.get(h) ?? 0) + w);
    hourAppW.set(hk, (hourAppW.get(hk) ?? 0) + w);
    rawCnt.set(hk, (rawCnt.get(hk) ?? 0) + 1);
  }

  // Top 5 (app, hour) by P(app|hour) × data-confidence
  const scored: Array<{ app: string; hour: number; score: number; raw: number }> = [];
  for (const [hk, wt] of hourAppW) {
    const bar2 = hk.indexOf('§');
    const h   = parseInt(hk.slice(0, bar2), 10);
    const app = hk.slice(bar2 + 1);
    const p   = wt / (hourW.get(h) ?? 1);
    const rc  = rawCnt.get(hk) ?? 0;
    scored.push({ app, hour: h, score: p * Math.min(1, rc / 7), raw: rc });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const { app, hour, score, raw } of scored.slice(0, 5)) {
    const hh = String(hour).padStart(2, '0');
    console.log(`  ${hh}:00  ${app.padEnd(20)} ${bar(score)} ${pct(score)}  (${raw}회 관측)`);
  }
}

function previewSessions(userId: string): void {
  const db      = getDb();
  const sinceMs = Date.now() - 30 * 86_400_000;
  const rows    = db.prepare(`
    SELECT json_extract(metadata, '$.app') AS app, occurred_at AS occurredAt
    FROM   user_events
    WHERE  user_id = ? AND action = 'window_focus' AND occurred_at >= ?
    ORDER  BY occurred_at ASC
  `).all(userId, sinceMs) as RawEvent[];

  const events = rows.filter(r => r.app).map(r => ({ app: r.app!, occurredAt: r.occurredAt }));

  // Session segmentation
  const SESSION_GAP = 5 * 60_000;
  const sessions: string[][] = [];
  let session: string[] = [];
  let lastTs = events[0]?.occurredAt ?? Date.now();
  let lastApp = '';

  for (const { app, occurredAt } of events) {
    if (occurredAt - lastTs > SESSION_GAP) {
      if (session.length) sessions.push(session);
      session = []; lastApp = '';
    }
    if (app !== lastApp) { session.push(app); lastApp = app; }
    lastTs = occurredAt;
  }
  if (session.length) sessions.push(session);

  const totalSessions = sessions.length;
  console.log(`  총 ${totalSessions}개 세션 분리 (5분 공백 기준)`);

  if (!totalSessions) return;

  // Count 2-grams: number of distinct sessions containing each pair
  const pairSessions = new Map<string, Set<number>>();
  for (let si = 0; si < sessions.length; si++) {
    const s = sessions[si]!;
    const seen = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      const k = `${s[i]!} → ${s[i + 1]!}`;
      if (!seen.has(k)) {
        const set = pairSessions.get(k) ?? new Set<number>();
        set.add(si);
        pairSessions.set(k, set);
        seen.add(k);
      }
    }
  }

  const top = [...pairSessions.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5);

  for (const [pair, sessionSet] of top) {
    const support = sessionSet.size / totalSessions;
    console.log(`  ${pair.padEnd(40)} ${bar(support)} ${pct(support)}`);
  }
}

function previewFFT(userId: string): void {
  const db      = getDb();
  const sinceMs = Date.now() - 30 * 86_400_000;
  const rows    = db.prepare(`
    SELECT json_extract(metadata, '$.app') AS app, occurred_at AS occurredAt
    FROM   user_events
    WHERE  user_id = ? AND action = 'window_focus' AND occurred_at >= ?
    ORDER  BY occurred_at ASC
  `).all(userId, sinceMs) as RawEvent[];

  const events  = rows.filter(r => r.app).map(r => ({ app: r.app!, occurredAt: r.occurredAt }));
  const nowMs   = Date.now();
  const start   = nowMs - 720 * 3_600_000;
  const series  = new Map<string, number[]>();

  for (const { app, occurredAt } of events) {
    const hi = Math.floor((occurredAt - start) / 3_600_000);
    if (hi < 0 || hi >= 720) continue;
    if (!series.has(app)) series.set(app, new Array<number>(720).fill(0));
    const s = series.get(app)!;
    s[hi] = (s[hi] ?? 0) + 1;
  }

  // Show top 5 apps by total event count
  const tops = [...series.entries()]
    .sort((a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0))
    .slice(0, 5);

  for (const [app, sig] of tops) {
    const total  = sig.reduce((s, v) => s + v, 0);
    const active = sig.filter(v => v > 0).length;
    const dailyAvg = (total / 30).toFixed(1);
    const activePct = pct(active / 720);
    console.log(`  ${app.padEnd(22)} 총 ${String(total).padStart(4)}회  활성 ${activePct}  일평균 ${dailyAvg}회`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// App-sequence lookup for legacy pattern types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * detected_at 기준 windowMs 이내의 window_focus 이벤트를 역조회해
 * 앱 전환 시퀀스를 반환. 연속 동일 앱은 합쳐서 최대 maxApps 개.
 */
function lookupAppSequence(
  userId: string,
  detectedAt: number,
  windowMs = 60 * 60_000,
  maxApps = 6,
): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT json_extract(metadata, '$.app') AS app
    FROM   user_events
    WHERE  user_id = ? AND action = 'window_focus'
      AND  occurred_at BETWEEN ? AND ?
    ORDER  BY occurred_at ASC
  `).all(userId, detectedAt - windowMs, detectedAt) as { app: string | null }[];

  const apps: string[] = [];
  let last = '';
  for (const { app } of rows) {
    if (app && app !== last) { apps.push(app); last = app; }
  }
  return apps.length > maxApps ? [...apps.slice(0, maxApps), '…'] : apps;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pattern result formatting
// ═══════════════════════════════════════════════════════════════════════════

function formatPattern(
  type:       string,
  score:      number,
  payload:    string,
  userId:     string,
  detectedAt: number,
): string {
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(payload) as Record<string, unknown>; } catch { return `[${type}] ${pct(score)}`; }

  const b = ev['bayesianScore']   != null ? `베이:${pct(Number(ev['bayesianScore']))}` : '';
  const p = ev['prefixSpanScore'] != null ? `시퀀:${pct(Number(ev['prefixSpanScore']))}` : '';
  const f = ev['fftScore']        != null ? `FFT:${pct(Number(ev['fftScore']))}` : '';
  const detail = [b, p, f].filter(Boolean).join(' ');
  const suffix = detail ? `  [${detail}]` : '';

  switch (type) {
    case 'time_of_day': {
      const app  = String(ev['app']  ?? '?');
      const hour = String(ev['hour'] ?? 0).padStart(2, '0');
      return `매일 ${hour}:00  ${app} 사용  → 앙상블 ${pct(score)}${suffix}`;
    }
    case 'app_sequence': {
      const seq = Array.isArray(ev['sequence'])
        ? (ev['sequence'] as string[]).join(' → ')
        : `${ev['from'] ?? '?'} → ${ev['to'] ?? '?'}`;
      return `앱 전환: ${seq}  → 앙상블 ${pct(score)}${suffix}`;
    }
    case 'periodic': {
      const app    = String(ev['app'] ?? '?');
      const period = ev['periodHours'] === 168 ? '주간(168h)' : '일간(24h)';
      return `${app} ${period} 주기  → 앙상블 ${pct(score)}${suffix}`;
    }
    case 'repetitive_sequence':
    case 'repetitive_action': {
      const apps = lookupAppSequence(userId, detectedAt);
      const seq  = apps.length > 0 ? apps.join(' → ') : '(앱 정보 없음)';
      return `${seq}  (신뢰도 ${pct(score)})`;
    }
    default:
      return `[${type}]  앙상블 ${pct(score)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function main(): void {
  console.log(LINE);
  console.log(' Pattern Bridge — 앙상블 패턴 분석');
  console.log(' 알고리즘: 베이지안(40%) + PrefixSpan(35%) + FFT(25%)');
  console.log(LINE);

  // ── Pre-analysis preview per user ────────────────────────────────────────
  const db      = getDb();
  const sinceMs = Date.now() - 30 * 86_400_000;
  const users   = (db.prepare(
    `SELECT DISTINCT user_id FROM user_events WHERE occurred_at >= ?`
  ).all(sinceMs) as { user_id: string }[]).map(r => r.user_id);

  if (!users.length) {
    console.log('\n데이터가 없습니다. 수집기를 먼저 실행하세요 (npm run dev)\n');
    return;
  }

  for (const userId of users) {
    console.log(`\n┌─ 사용자: ${userId}`);
    console.log('│');

    console.log('│  [베이지안] 시간대별 앱 사용 확률 (상위 5개)');
    previewBayesian(userId);
    console.log('│');

    console.log('│  [PrefixSpan] 세션 분리 및 빈번 전환 패턴');
    previewSessions(userId);
    console.log('│');

    console.log('│  [FFT] 앱별 시계열 통계 (상위 5개)');
    previewFFT(userId);
    console.log('│');
    console.log('└' + '─'.repeat(61));
  }

  // ── Run ensemble analysis (writes to DB) ─────────────────────────────────
  console.log(`\n${LINE2}`);
  console.log(' 앙상블 분석 실행 중 (신뢰도 ≥ 75% 만 저장)...');
  console.log(LINE2);

  const fresh = analyzePatterns();
  console.log(`\n  이번 분석: ${fresh.length}개 신규 패턴 감지\n`);

  // ── Stored pattern report (last 7 days) ───────────────────────────────────
  const all = getAllPatterns(7);

  if (!all.length) {
    console.log('최근 7일 내 저장된 패턴이 없습니다.');
    console.log('(window_focus 이벤트가 7일치 이상 쌓이면 패턴이 감지됩니다)\n');
    return;
  }

  const LABELS: Record<string, string> = {
    time_of_day:         '시간대 패턴      (베이지안 주도)',
    app_sequence:        '시퀀스 패턴      (PrefixSpan 주도)',
    periodic:            '주기 패턴        (FFT 주도)',
    repetitive_sequence: '반복 앱 전환',
    repetitive_action:   '반복 행동',
  };
  const ORDER = ['time_of_day', 'app_sequence', 'periodic', 'repetitive_sequence', 'repetitive_action'];

  const grouped = new Map<string, typeof all>();
  for (const p of all) {
    const b = grouped.get(p.patternType) ?? [];
    b.push(p);
    grouped.set(p.patternType, b);
  }

  const types = [
    ...ORDER.filter(t => grouped.has(t)),
    ...[...grouped.keys()].filter(t => !ORDER.includes(t)),
  ];

  console.log(LINE2);
  for (const type of types) {
    const patterns = grouped.get(type)!;
    console.log(`\n▶ ${LABELS[type] ?? type}  (${patterns.length}건)`);
    for (const p of patterns) {
      const notifiedMark = p.notified ? '  ✓' : '';
      const line = formatPattern(p.patternType, p.score, p.payload, p.userId, p.detectedAt);
      console.log(`   ${bar(p.score, 12)} ${line}${notifiedMark}`);
      console.log(`              감지: ${fmtTime(p.detectedAt)}`);
    }
  }

  console.log(`\n${LINE}`);
  console.log(` 총 ${all.length}건  (최근 7일, ✓ = 알림 발송 완료)`);
  console.log(` 베이: 베이지안 기여도   시퀀: PrefixSpan 기여도   FFT: FFT 기여도`);
  console.log(LINE);
}

main();
