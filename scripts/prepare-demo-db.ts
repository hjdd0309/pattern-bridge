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
 * Usage: npm run demo-db [-- --src <dataset.sqlite>] [-- --force]
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

try {
  const source = new Database(tmp, { readonly: true });
  const { newest } = source.prepare("SELECT MAX(occurred_at) AS newest FROM user_events").get() as { newest: number | null };
  if (newest === null) throw new Error("source has no user_events");

  const shift = Math.floor((Date.now() - newest) / WEEK_MS) * WEEK_MS;
  const userId = os.hostname();
  const rows = source
    .prepare("SELECT action, metadata, occurred_at FROM user_events ORDER BY occurred_at")
    .all() as Array<{ action: string; metadata: string; occurred_at: number }>;
  source.close();

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
