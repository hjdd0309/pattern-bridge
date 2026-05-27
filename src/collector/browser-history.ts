import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { logEvents } from "./log-event.js";
import { config } from "../../config/config.js";

// ── Constants ──────────────────────────────────────────────────────────────

// Chrome timestamps = µs since Windows FILETIME epoch (1601-01-01 UTC)
const CHROME_EPOCH_US = 11_644_473_600_000_000n;

const USER_ID       = os.hostname();
const POLL_MS       = 5 * 60_000;            // 5 minutes
const BACKFILL_DAYS = 30;                     // on first run, import last 30 days

// Chrome History SQLite file location
const HISTORY_SRC = path.join(
  os.homedir(),
  "AppData", "Local", "Google", "Chrome", "User Data", "Default", "History"
);

// State file lives next to the project DB (data/browser-history-state.json)
const STATE_PATH = path.join(path.dirname(config.db.path), "browser-history-state.json");

// ── Timestamp helpers ──────────────────────────────────────────────────────

/** Chrome µs since 1601 → Unix ms since 1970 */
function toUnixMs(chromeUs: bigint): number {
  return Number((chromeUs - CHROME_EPOCH_US) / 1000n);
}

/** Unix ms → Chrome µs */
function toChromeUs(unixMs: number): bigint {
  return BigInt(Math.floor(unixMs)) * 1000n + CHROME_EPOCH_US;
}

// ── State: persist the last imported visit_time across restarts ────────────

function loadLastSeen(): bigint {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const { lastVisitTime } = JSON.parse(raw) as { lastVisitTime: string };
    return BigInt(lastVisitTime);
  } catch {
    // First run: backfill the past N days
    return toChromeUs(Date.now() - BACKFILL_DAYS * 86_400_000);
  }
}

function saveLastSeen(chromeUs: bigint): void {
  try {
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastVisitTime: chromeUs.toString() }),
      "utf8",
    );
  } catch { /* non-fatal — will retry next poll */ }
}

// ── Chrome History reader ──────────────────────────────────────────────────

interface ChromeVisit {
  url:        string;
  title:      string | null;
  visit_time: bigint;
}

/**
 * Copy Chrome's History file to a temp path before opening.
 *
 * Chrome holds the file open but with FILE_SHARE_READ on Windows, so a
 * filesystem copy succeeds even while Chrome is running.  We copy the WAL
 * and SHM files too so SQLite can reconstruct a consistent read view.
 */
function fetchNewVisits(sinceUs: bigint): ChromeVisit[] {
  if (!fs.existsSync(HISTORY_SRC)) {
    throw new Error(`Chrome History not found: ${HISTORY_SRC}`);
  }

  const tmp    = path.join(os.tmpdir(), `pb-chrome-hist-${Date.now()}`);
  const tmpWal = `${tmp}-wal`;
  const tmpShm = `${tmp}-shm`;

  // Copy main DB + WAL/SHM if present
  fs.copyFileSync(HISTORY_SRC, tmp);
  for (const ext of ["-wal", "-shm"]) {
    const src = HISTORY_SRC + ext;
    if (fs.existsSync(src)) fs.copyFileSync(src, tmp + ext);
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(tmp, { readonly: true, fileMustExist: true });

    // visit_time is stored as a 64-bit integer that exceeds JS MAX_SAFE_INTEGER;
    // .safeIntegers(true) returns it as a native BigInt instead.
    const rows = db
      .prepare(`
        SELECT u.url,
               u.title,
               v.visit_time
        FROM   visits v
        JOIN   urls   u ON u.id = v.url
        WHERE  v.visit_time > ?
          AND  u.hidden  = 0
          AND  u.url NOT LIKE 'data:%'
          AND  u.url NOT LIKE 'blob:%'
          AND  u.url NOT LIKE 'chrome-extension://%'
        ORDER  BY v.visit_time ASC
      `)
      .safeIntegers(true)
      .all(sinceUs) as ChromeVisit[];

    return rows;
  } finally {
    db?.close();
    for (const f of [tmp, tmpWal, tmpShm]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// ── Poll cycle ─────────────────────────────────────────────────────────────

let lastSeen: bigint = loadLastSeen();

function poll(): void {
  let visits: ChromeVisit[];
  try {
    visits = fetchNewVisits(lastSeen);
  } catch (err) {
    console.error(
      "[browser-history] read error:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (!visits.length) return;

  // Bulk-insert as browser_url events with the original visit timestamp
  logEvents(
    visits.map(v => ({
      userId:     USER_ID,
      action:     "browser_url",
      metadata:   { url: v.url, title: v.title ?? "", source: "history" },
      occurredAt: toUnixMs(v.visit_time),
    })),
  );

  // Advance the cursor to the latest visit_time seen this batch
  const maxUs = visits.reduce(
    (max, v) => (v.visit_time > max ? v.visit_time : max),
    visits[0]!.visit_time,
  );
  lastSeen = maxUs;
  saveLastSeen(lastSeen);

  const latestStr = new Date(toUnixMs(maxUs)).toLocaleString("ko-KR");
  console.log(`[browser-history] +${visits.length} visit(s)  latest: ${latestStr}`);
}

// ── Public API ─────────────────────────────────────────────────────────────

let timerId: ReturnType<typeof setInterval> | null = null;

export function startBrowserHistory(): void {
  if (timerId !== null) return;

  poll(); // immediate first run on startup

  timerId = setInterval(poll, POLL_MS);
  console.log(`[browser-history] started (every ${POLL_MS / 60_000} min)`);
}

export function stopBrowserHistory(): void {
  if (timerId === null) return;
  clearInterval(timerId);
  timerId = null;
  console.log("[browser-history] stopped");
}
