import { getConfig } from "./config.js";
import { MINUTE_MS } from "./minute.js";
import { deleteState, getState, setState } from "./state.js";
import { dayStartOf } from "./tracker.js";

// The user's "pause interventions" switch, stored in guardian_state so every
// entry point (extension popup, CLI, Discord) shares it. While paused, no rule
// fires and running interventions are cancelled. Every pause is also kept in a
// short history for the daily summary.

export type PauseState = {
  since: number;
  /** null = until the user resumes. */
  until: number | null;
  source: string;
};

export type PausePreset = "30m" | "1h" | "today" | "manual";

type PauseRecord = PauseState & { endedAt: number | null };
const HISTORY_MAX = 200;

export function getPause(): PauseState | null {
  return getState<PauseState>("pause");
}

export function isPaused(now: number): boolean {
  const p = getPause();
  if (!p) return false;
  return p.until === null || now < p.until;
}

/** End time for a preset, or for an explicit number of minutes (1 … pause.maxMinutes). */
export function pauseUntil(preset: PausePreset | number, now: number): number | null {
  const cfg = getConfig();
  if (typeof preset === "number") {
    const minutes = Math.round(preset);
    if (!(minutes >= 1 && minutes <= cfg.pause.maxMinutes)) throw new Error(`minutes must be 1-${cfg.pause.maxMinutes}`);
    return now + minutes * MINUTE_MS;
  }
  switch (preset) {
    case "30m": return now + 30 * MINUTE_MS;
    case "1h": return now + 60 * MINUTE_MS;
    case "today": {
      const next = new Date(dayStartOf(cfg, now));
      next.setDate(next.getDate() + 1);
      return next.getTime(); // the next day start (05:00)
    }
    case "manual": return null;
    default: throw new Error(`unknown preset: ${String(preset)}`);
  }
}

function history(): PauseRecord[] {
  return getState<PauseRecord[]>("pauseHistory") ?? [];
}

function closeOpenRecord(list: PauseRecord[], at: number): void {
  const last = list[list.length - 1];
  if (last && last.endedAt === null) last.endedAt = last.until !== null ? Math.min(at, last.until) : at;
}

export function setPause(preset: PausePreset | number, source: string, now = Date.now()): PauseState {
  const state: PauseState = { since: now, until: pauseUntil(preset, now), source };
  setState("pause", state, now);
  const list = history();
  closeOpenRecord(list, now);
  list.push({ ...state, endedAt: null });
  setState("pauseHistory", list.slice(-HISTORY_MAX), now);
  console.log(`[pause] paused by ${source} until ${state.until ? new Date(state.until).toLocaleString("ko-KR") : "resumed"}`);
  return state;
}

export function resume(source: string, now = Date.now()): void {
  if (!getPause()) return;
  deleteState("pause");
  const list = history();
  closeOpenRecord(list, now);
  setState("pauseHistory", list, now);
  console.log(`[pause] resumed by ${source}`);
}

/**
 * Clears a pause whose time is up. Returns true when it just expired, so the
 * caller can tell the user that interventions are back on.
 */
export function expireIfDue(now: number): boolean {
  const p = getPause();
  if (!p || p.until === null || now < p.until) return false;
  resume("expired", now);
  return true;
}

/** Number of pauses that started in [from, to) and the paused minutes inside that range. */
export function pauseStats(from: number, to: number): { count: number; minutes: number } {
  let count = 0;
  let ms = 0;
  for (const r of history()) {
    if (r.since >= from && r.since < to) count++;
    const end = r.endedAt ?? r.until ?? to;
    const overlap = Math.min(end, to) - Math.max(r.since, from);
    if (overlap > 0) ms += overlap;
  }
  return { count, minutes: Math.round(ms / MINUTE_MS) };
}

export function pauseStatus(now: number): { paused: boolean; until: number | null; source: string | null } {
  const p = getPause();
  const paused = isPaused(now);
  return { paused, until: paused ? p?.until ?? null : null, source: paused ? p?.source ?? null : null };
}
