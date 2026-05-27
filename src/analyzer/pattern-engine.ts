import type Database from "better-sqlite3";
import { getDb, type DetectedPattern } from "../db/schema.js";
import { config } from "../../config/config.js";

// ═══════════════════════════════════════════════════════════════════════════
// Public types  (backward-compatible with scheduler + check-patterns)
// ═══════════════════════════════════════════════════════════════════════════

export type PatternResult = {
  userId:      string;
  patternType: string;
  score:       number;
  evidence:    Record<string, unknown>;
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const LOOKBACK_MS  = 30 * 24 * 60 * 60_000;   // 30-day event window
const DEDUP_MS     = 24 * 60 * 60_000;         // 24 h dedup window

// Bayesian: recency decay with 7-day half-life
const DECAY_LAMBDA    = Math.LN2 / 7;          // λ = ln(2) / 7
const DATA_CONF_N     = 7;                     // raw occurrences for full confidence

// PrefixSpan: session segmentation + support threshold
const SESSION_GAP_MS  = 5 * 60_000;            // > 5 min gap → new session
const MIN_SUPPORT     = 0.30;                  // ≥ 30 % of sessions
const MAX_SEQ_DEPTH   = 4;                     // max subsequence length

// FFT: periodicity detection
const SERIES_HOURS    = 720;                   // 30 days × 24 h
const FFT_N           = 1024;                  // next power-of-2 ≥ 720 for zero-padding
const FFT_AMP_RATIO   = 2.0;                   // amplitude must be ≥ 2 × noise mean

// Ensemble weights (must sum to 1.0)
const W_BAY = 0.40;
const W_PS  = 0.35;
const W_FFT = 0.25;

// ═══════════════════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════════════════

interface AppEvent {
  app:        string;
  occurredAt: number; // Unix ms
}

// One (app, hour) Bayesian estimate
interface BayesEntry {
  app:           string;
  hour:          number; // 0–23
  pAppGivenHour: number; // P(app|hour) weighted by recency decay
  rawCount:      number; // unweighted occurrence count
  score:         number; // pAppGivenHour × data-confidence ∈ [0, 1]
}

// One frequent subsequence
interface SeqEntry {
  sequence: string[];
  support:  number; // fraction of sessions ∈ [0, 1]
}

// One app with detected periodic usage
interface FftEntry {
  app:         string;
  periodHours: 24 | 168;
  score:       number; // ∈ [0.5, 1] when amplitude ≥ 2 × mean
}

// ═══════════════════════════════════════════════════════════════════════════
// Algorithm 1 — Bayesian Time-of-Day
// P(app | hour-bucket) with exponential recency decay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For each (app, hour) pair observed in the last 30 days, compute:
 *   pAppGivenHour = Σ w_i · 1[app_i = app, hour_i = hour]
 *                 / Σ w_i · 1[hour_i = hour]
 *
 * where w_i = exp(−λ · days_ago_i)  (half-life = 7 days).
 *
 * Score = pAppGivenHour × min(1, rawCount / DATA_CONF_N)
 * The data-confidence factor penalises estimates from fewer than 7 observations.
 */
function bayesianTimeOfDay(
  events: AppEvent[],
  nowMs:  number,
): Map<string, BayesEntry> {

  const hourW    = new Map<number, number>();  // hour  → Σ weight
  const hourAppW = new Map<string, number>(); // "h§app" → Σ weight
  const rawCnt   = new Map<string, number>(); // "h§app" → raw count

  for (const { app, occurredAt } of events) {
    const daysAgo = (nowMs - occurredAt) / 86_400_000;
    const w  = Math.exp(-DECAY_LAMBDA * daysAgo);
    const h  = new Date(occurredAt).getHours();
    const hk = `${h}§${app}`;

    hourW.set(h, (hourW.get(h) ?? 0) + w);
    hourAppW.set(hk, (hourAppW.get(hk) ?? 0) + w);
    rawCnt.set(hk, (rawCnt.get(hk) ?? 0) + 1);
  }

  const out = new Map<string, BayesEntry>();

  for (const [hk, wt] of hourAppW) {
    const bar = hk.indexOf('§');
    const h   = parseInt(hk.slice(0, bar), 10);
    const app = hk.slice(bar + 1);

    const pAppGivenHour = wt / (hourW.get(h) ?? 1);
    const raw           = rawCnt.get(hk) ?? 0;
    const dataConf      = Math.min(1, raw / DATA_CONF_N);

    out.set(`${app}§${h}`, {
      app, hour: h,
      pAppGivenHour,
      rawCount: raw,
      score:    pAppGivenHour * dataConf,
    });
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Algorithm 2 — PrefixSpan Sequential Pattern Mining
// ═══════════════════════════════════════════════════════════════════════════

/** Split ordered events into sessions separated by > SESSION_GAP_MS. */
function buildSessions(events: AppEvent[]): string[][] {
  if (!events.length) return [];

  const sessions: string[][] = [];
  let session: string[] = [];
  let lastTs  = events[0]!.occurredAt;
  let lastApp = '';

  for (const { app, occurredAt } of events) {
    if (occurredAt - lastTs > SESSION_GAP_MS) {
      if (session.length) sessions.push(session);
      session = [];
      lastApp = '';
    }
    // Collapse consecutive duplicate apps (only track transitions)
    if (app !== lastApp) { session.push(app); lastApp = app; }
    lastTs = occurredAt;
  }
  if (session.length) sessions.push(session);
  return sessions;
}

/**
 * PrefixSpan: recursively mine all frequent subsequences.
 *
 * A subsequence α is frequent if it appears (as a sub-sequence, not
 * necessarily contiguous) in ≥ minSupport fraction of sessions.
 *
 * Implementation:
 *  1. Count items present in current projected database.
 *  2. For each frequent item β, extend prefix to α·β.
 *  3. Project database: keep suffixes after first β in each sequence.
 *  4. Recurse (depth-limited to MAX_SEQ_DEPTH).
 */
function prefixSpan(sessions: string[][], minSupport: number): SeqEntry[] {
  const n = sessions.length;
  if (n === 0) return [];
  const minCount = Math.ceil(minSupport * n);
  const results: SeqEntry[] = [];

  function countItems(db: string[][]): Map<string, number> {
    const m = new Map<string, number>();
    for (const seq of db) {
      const seen = new Set<string>();
      for (const item of seq) {
        if (!seen.has(item)) { m.set(item, (m.get(item) ?? 0) + 1); seen.add(item); }
      }
    }
    return m;
  }

  function projectDB(db: string[][], item: string): string[][] {
    const out: string[][] = [];
    for (const seq of db) {
      const i = seq.indexOf(item);
      if (i !== -1 && i + 1 < seq.length) out.push(seq.slice(i + 1));
    }
    return out;
  }

  function mine(prefix: string[], db: string[][]): void {
    if (prefix.length >= MAX_SEQ_DEPTH) return;
    for (const [item, cnt] of countItems(db)) {
      if (cnt < minCount) continue;
      const newPfx = [...prefix, item];
      // Only yield sequences of length ≥ 2
      if (newPfx.length >= 2) results.push({ sequence: newPfx, support: cnt / n });
      const projected = projectDB(db, item);
      if (projected.length >= minCount) mine(newPfx, projected);
    }
  }

  mine([], sessions);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Algorithm 3 — FFT Periodic Pattern
// ═══════════════════════════════════════════════════════════════════════════

/**
 * In-place radix-2 decimation-in-time FFT (Cooley-Tukey).
 * Input arrays must have length = power of 2.
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tmp1 = re[i]!; re[i] = re[j]!; re[j] = tmp1;
      const tmp2 = im[i]!; im[i] = im[j]!; im[j] = tmp2;
    }
  }

  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = (-2 * Math.PI) / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const vIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k]        = uRe + vRe;
        im[i + k]        = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const tmp = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmp;
      }
    }
  }
}

/**
 * Compute the normalised one-sided amplitude spectrum of a real signal.
 * The input is zero-padded to FFT_N (1024) samples before transform.
 * Returns Float64Array of length FFT_N/2 where amps[k] is the amplitude
 * of the frequency bin with period T = FFT_N / k  hours.
 */
function amplitudeSpectrum(signal: number[]): Float64Array {
  const re = new Float64Array(FFT_N); // zero-initialised → zero-padding
  const im = new Float64Array(FFT_N);
  const len = Math.min(signal.length, FFT_N);
  for (let i = 0; i < len; i++) re[i] = signal[i] ?? 0;

  fftInPlace(re, im);

  const half = FFT_N >> 1;
  const amps = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const r = re[k]!;
    const c = im[k]!;
    amps[k] = Math.sqrt(r * r + c * c) / FFT_N;
  }
  return amps;
}

/**
 * Build a 720-bin hourly time series per app, run FFT, and identify
 * significant periodicities at 24 h (daily) and 168 h (weekly).
 *
 * Frequency indices in the 1024-point FFT:
 *   k_24  = round(1024 / 24)  ≈ 43  →  period ≈ 23.8 h
 *   k_168 = round(1024 / 168) ≈  6  →  period ≈ 170.7 h
 *
 * An amplitude is considered significant when
 *   amps[k] ≥ FFT_AMP_RATIO × μ_noise
 * where μ_noise is the mean of all non-DC positive-frequency bins.
 *
 * Score = clamp( amps[k] / (μ_noise × 4), 0.5, 1.0 )
 *   → 2 × mean  → score 0.50  (detection threshold)
 *   → 4 × mean  → score 1.00
 */
function fftPeriodic(events: AppEvent[], nowMs: number): Map<string, FftEntry> {
  const startMs = nowMs - SERIES_HOURS * 3_600_000;

  const series = new Map<string, number[]>();
  for (const { app, occurredAt } of events) {
    const hi = Math.floor((occurredAt - startMs) / 3_600_000);
    if (hi < 0 || hi >= SERIES_HOURS) continue;
    if (!series.has(app)) series.set(app, new Array<number>(SERIES_HOURS).fill(0));
    const s = series.get(app)!;
    s[hi] = (s[hi] ?? 0) + 1;
  }

  const k24  = Math.round(FFT_N / 24);  // ≈ 43
  const k168 = Math.round(FFT_N / 168); // ≈ 6

  const out = new Map<string, FftEntry>();

  for (const [app, sig] of series) {
    const amps = amplitudeSpectrum(sig);

    // Noise floor: mean amplitude of non-DC positive-frequency bins
    let sum = 0;
    for (let k = 1; k < amps.length; k++) sum += amps[k]!;
    const meanAmp = sum / (amps.length - 1);
    if (meanAmp === 0) continue;

    for (const [k, periodHours] of [
      [k24,  24  as const],
      [k168, 168 as const],
    ] as const) {
      const amp = amps[k]!;
      if (amp < FFT_AMP_RATIO * meanAmp) continue;

      // score ∈ [0.5, 1.0]: 0.5 at threshold, 1.0 at 4× noise floor
      const score = Math.min(1, amp / (meanAmp * 4));
      out.set(`${app}§${periodHours}`, { app, periodHours, score });
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cross-algorithm lookup helpers
// ═══════════════════════════════════════════════════════════════════════════

function maxBayesScore(app: string, bayes: Map<string, BayesEntry>): number {
  let max = 0;
  for (const [k, e] of bayes) {
    if (k.startsWith(`${app}§`)) max = Math.max(max, e.score);
  }
  return max;
}

function maxSeqSupport(app: string, seqs: SeqEntry[]): number {
  return seqs.reduce(
    (mx, s) => (s.sequence.includes(app) ? Math.max(mx, s.support) : mx),
    0,
  );
}

function appFftScore(app: string, fft: Map<string, FftEntry>): number {
  return fft.get(`${app}§24`)?.score ?? fft.get(`${app}§168`)?.score ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ensemble — weighted combination of three algorithm scores
//
// Final confidence = 0.40 × Bayesian + 0.35 × PrefixSpan + 0.25 × FFT
// Only patterns with ensemble ≥ alertThreshold (default 0.75) are emitted.
// ═══════════════════════════════════════════════════════════════════════════

function buildEnsemble(
  userId:    string,
  bayes:     Map<string, BayesEntry>,
  seqs:      SeqEntry[],
  fft:       Map<string, FftEntry>,
  threshold: number,
): PatternResult[] {

  const results: PatternResult[] = [];
  const emitted = new Set<string>(); // deduplicate within this call

  // ── (A) Time-of-Day: Bayesian is the primary signal ──────────────────────
  for (const [, entry] of bayes) {
    const { app, hour } = entry;
    const key = `tod§${app}§${hour}`;
    if (emitted.has(key)) continue;

    const psScore  = maxSeqSupport(app, seqs);
    const fftScore = appFftScore(app, fft);
    const ensemble = W_BAY * entry.score + W_PS * psScore + W_FFT * fftScore;
    if (ensemble < threshold) continue;

    emitted.add(key);
    const hh = String(hour).padStart(2, '0');
    console.log(`[pattern] 매일 ${hh}:00 ${app} 사용 (신뢰도 ${Math.round(ensemble * 100)}%)`);

    results.push({
      userId,
      patternType: 'time_of_day',
      score:       ensemble,
      evidence: {
        patternKey:      `${app}::tod::${hour}`,
        app, hour,
        bayesianScore:   +entry.score.toFixed(4),
        prefixSpanScore: +psScore.toFixed(4),
        fftScore:        +fftScore.toFixed(4),
        ensembleScore:   +ensemble.toFixed(4),
        pAppGivenHour:   +entry.pAppGivenHour.toFixed(4),
        rawCount:        entry.rawCount,
      },
    });
  }

  // ── (B) Sequence: PrefixSpan is the primary signal ───────────────────────
  for (const seq of seqs) {
    const [firstApp] = seq.sequence;
    if (!firstApp) continue;
    const seqKey = seq.sequence.join('>');
    const key    = `seq§${seqKey}`;
    if (emitted.has(key)) continue;

    const bayScore = maxBayesScore(firstApp, bayes);
    const fftScore = appFftScore(firstApp, fft);
    const ensemble = W_BAY * bayScore + W_PS * seq.support + W_FFT * fftScore;
    if (ensemble < threshold) continue;

    emitted.add(key);
    const label = seq.sequence.join(' → ');
    console.log(`[pattern] 앱 전환 패턴: ${label} (신뢰도 ${Math.round(ensemble * 100)}%)`);

    results.push({
      userId,
      patternType: 'app_sequence',
      score:       ensemble,
      evidence: {
        patternKey:      `seq::${seq.sequence.join('::')}`,
        sequence:        seq.sequence,
        support:         +seq.support.toFixed(4),
        bayesianScore:   +bayScore.toFixed(4),
        prefixSpanScore: +seq.support.toFixed(4),
        fftScore:        +fftScore.toFixed(4),
        ensembleScore:   +ensemble.toFixed(4),
      },
    });
  }

  // ── (C) Periodic: FFT is the primary signal ───────────────────────────────
  for (const [, entry] of fft) {
    const key = `fft§${entry.app}§${entry.periodHours}`;
    if (emitted.has(key)) continue;

    const bayScore = maxBayesScore(entry.app, bayes);
    const psScore  = maxSeqSupport(entry.app, seqs);
    const ensemble = W_BAY * bayScore + W_PS * psScore + W_FFT * entry.score;
    if (ensemble < threshold) continue;

    emitted.add(key);
    const period = entry.periodHours === 168 ? '주간' : '일간';
    console.log(`[pattern] ${entry.app} ${period} 주기적 사용 (신뢰도 ${Math.round(ensemble * 100)}%)`);

    results.push({
      userId,
      patternType: 'periodic',
      score:       ensemble,
      evidence: {
        patternKey:      `${entry.app}::fft::${entry.periodHours}h`,
        app:             entry.app,
        periodHours:     entry.periodHours,
        bayesianScore:   +bayScore.toFixed(4),
        prefixSpanScore: +psScore.toFixed(4),
        fftScore:        +entry.score.toFixed(4),
        ensembleScore:   +ensemble.toFixed(4),
      },
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// DB helpers
// ═══════════════════════════════════════════════════════════════════════════

function fetchFocusEvents(
  db:      Database.Database,
  userId:  string,
  sinceMs: number,
): AppEvent[] {
  return (
    db.prepare(`
      SELECT json_extract(metadata, '$.app') AS app,
             occurred_at AS occurredAt
      FROM   user_events
      WHERE  user_id = ? AND action = 'window_focus' AND occurred_at >= ?
      ORDER  BY occurred_at ASC
    `).all(userId, sinceMs) as Array<{ app: string | null; occurredAt: number }>
  )
    .filter(r => r.app)
    .map(r => ({ app: r.app!, occurredAt: r.occurredAt }));
}

function isDuplicate(db: Database.Database, result: PatternResult): boolean {
  const key = result.evidence['patternKey'];
  if (key === undefined) return false;
  return !!db.prepare(`
    SELECT 1 FROM detected_patterns
    WHERE  user_id = ? AND pattern_type = ?
      AND  json_extract(payload, '$.patternKey') = ?
      AND  detected_at >= ?
    LIMIT 1
  `).get(result.userId, result.patternType, String(key), Date.now() - DEDUP_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export function analyzePatterns(): PatternResult[] {
  const db      = getDb();
  const nowMs   = Date.now();
  const sinceMs = nowMs - LOOKBACK_MS;
  const { minEventCount, alertThreshold } = config.pattern;

  const users = db
    .prepare(`SELECT DISTINCT user_id FROM user_events WHERE occurred_at >= ?`)
    .all(sinceMs) as { user_id: string }[];

  const allResults: PatternResult[] = [];

  for (const { user_id } of users) {
    const events = fetchFocusEvents(db, user_id, sinceMs);
    if (events.length < minEventCount) continue;

    // ── Three algorithms ─────────────────────────────────────────────────
    const bayesMap = bayesianTimeOfDay(events, nowMs);
    const sessions = buildSessions(events);
    const seqList  = prefixSpan(sessions, MIN_SUPPORT);
    const fftMap   = fftPeriodic(events, nowMs);

    // ── Ensemble ─────────────────────────────────────────────────────────
    const candidates = buildEnsemble(
      user_id, bayesMap, seqList, fftMap, alertThreshold,
    );

    for (const result of candidates) {
      if (isDuplicate(db, result)) continue;

      db.prepare(`
        INSERT INTO detected_patterns
          (user_id, pattern_type, score, payload, detected_at, notified)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(
        result.userId, result.patternType, result.score,
        JSON.stringify(result.evidence), nowMs,
      );

      allResults.push(result);
    }
  }

  return allResults;
}

export function getPendingPatterns(): DetectedPattern[] {
  return getDb()
    .prepare(`
      SELECT id, user_id AS userId, pattern_type AS patternType,
             score, payload, detected_at AS detectedAt, notified
      FROM   detected_patterns
      WHERE  notified = 0
      ORDER  BY detected_at ASC
    `)
    .all() as DetectedPattern[];
}

export function getAllPatterns(limitDays = 7): DetectedPattern[] {
  const since = Date.now() - limitDays * 86_400_000;
  return getDb()
    .prepare(`
      SELECT id, user_id AS userId, pattern_type AS patternType,
             score, payload, detected_at AS detectedAt, notified
      FROM   detected_patterns
      WHERE  detected_at >= ?
      ORDER  BY score DESC, detected_at DESC
    `)
    .all(since) as DetectedPattern[];
}

export function markPatternNotified(id: number): void {
  getDb().prepare(`UPDATE detected_patterns SET notified = 1 WHERE id = ?`).run(id);
}
