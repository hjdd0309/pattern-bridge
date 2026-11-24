/**
 * Builds the demo DB from the anonymized dataset.
 *
 * The dataset ends on 2026-10-07, but the guardian looks at "the last month
 * from now". This copies its user_events into the live DB path (config.db.path,
 * data/pattern-bridge.sqlite by default) shifted forward by whole weeks, so the
 * newest event lands just before now while hour-of-day and weekday stay the
 * same. detected_patterns / notification_log are left empty (legacy output).
 *
 * user_id is rewritten to this machine's hostname so the history and the
 * events the collector records from now on belong to the same user.
 *
 * The source file is never modified: it is copied to a temp file first, since
 * even a read-only open of a WAL database leaves -shm/-wal files next to it.
 *
 * A sparse tail (a few days after a long gap) is dropped first so the most
 * recent month is dense; --keep-tail disables that.
 *
 * Usage: npm run demo-db [-- --src <dataset.sqlite>] [-- --force] [-- --keep-tail]
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../config/config.js";
import { getDb } from "../src/db/schema.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const src = path.resolve(arg("--src") ?? "dataset/pattern-bridge-anon.sqlite");
const dst = config.db.path;
const force = process.argv.includes("--force");

if (!fs.existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(1);
}
if (fs.existsSync(dst) && !force) {
  console.error(`${dst} already exists. It may hold live collected data; pass --force to replace it.`);
  process.exit(1);
}
if (force) {
  for (const f of [dst, `${dst}-wal`, `${dst}-shm`]) fs.rmSync(f, { force: true });
}

const tmp = path.join(os.tmpdir(), `pb-demo-src-${Date.now()}.sqlite`);
fs.copyFileSync(src, tmp);

type SourceRow = { action: string; metadata: string; occurred_at: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const TAIL_GAP_DAYS = 7;
const TAIL_MAX_DAYS = 3;

/**
 * Drops a sparse tail: when the data ends with a few active days that come
 * after a gap of more than TAIL_GAP_DAYS, those days would land in "the last
 * month" with an empty stretch in front of them and starve the R2 baseline.
 * (The anonymized dataset has a 15-day gap before its last day, 2026-10-07.)
 */
function trimSparseTail(rows: SourceRow[]): { rows: SourceRow[]; dropped: number; cutoff: number | null } {
  const dayOf = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = [...new Set(rows.map((r) => dayOf(r.occurred_at)))].sort((a, b) => a - b);
  for (let i = days.length - 1; i > 0; i--) {
    if (days[i]! - days[i - 1]! > TAIL_GAP_DAYS * DAY_MS) {
      const tailDays = days.length - i;
      if (tailDays > TAIL_MAX_DAYS) break;
      const cutoff = days[i]!;
      const kept = rows.filter((r) => r.occurred_at < cutoff);
      return { rows: kept, dropped: rows.length - kept.length, cutoff };
    }
  }
  return { rows, dropped: 0, cutoff: null };
}

try {
  const source = new Database(tmp, { readonly: true });
  const all = source
    .prepare("SELECT action, metadata, occurred_at FROM user_events ORDER BY occurred_at")
    .all() as SourceRow[];
  source.close();
  if (all.length === 0) throw new Error("source has no user_events");

  const trimmed = process.argv.includes("--keep-tail") ? { rows: all, dropped: 0, cutoff: null } : trimSparseTail(all);
  const rows = trimmed.rows;
  const newest = rows[rows.length - 1]!.occurred_at;
  const shift = Math.floor((Date.now() - newest) / WEEK_MS) * WEEK_MS;
  const userId = os.hostname();
  if (trimmed.cutoff !== null) {
    const d = new Date(trimmed.cutoff);
    console.log(`dropped ${trimmed.dropped} events from ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} on (sparse tail after a ${TAIL_GAP_DAYS}+ day gap; --keep-tail to keep)`);
  }

  const db = getDb(); // creates dst with the current schema
  const insert = db.prepare("INSERT INTO user_events (user_id, action, metadata, occurred_at) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const r of rows) insert.run(userId, r.action, r.metadata, r.occurred_at + shift);
  })();

  const fmt = (ms: number): string => new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const first = rows[0]?.occurred_at ?? newest;
  console.log(`${rows.length} events -> ${dst}`);
  console.log(`shifted ${shift / WEEK_MS} weeks: ${fmt(first + shift)} ~ ${fmt(newest + shift)}`);
} finally {
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
}
