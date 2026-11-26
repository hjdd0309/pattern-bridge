import { getDb } from "../db/schema.js";
import { getConfig } from "./config.js";
import { getExecutor } from "./executor.js";
import { onExtensionMessage } from "./extension-link.js";
import { groupOf, isLockApp, type MinuteGroup } from "./groups.js";
import {
  activeInterventions,
  cancelIntervention,
  createIntervention,
  getIntervention,
  markExecuted,
  outcomesDue,
  pauseIntervention,
  resumeIntervention,
  setOutcome,
  updatePlan,
  type ExecutedBy,
  type Intervention,
  type Plan,
  type Rule,
} from "./interventions.js";
import { dominantForeground, MINUTE_MS } from "./minute.js";
import { isPaused, pauseStatus, resume, setPause, type PausePreset } from "./pause.js";
import { collectorAliveFor, USER_ID } from "./tracker.js";

// Runs decided interventions through their grace period, every few seconds:
//   R1 pauses while the user is away from entertainment and resumes if they
//      come back before the original deadline, otherwise it is cancelled.
//   R2 is cancelled as soon as the user starts productive work.
//   At the deadline the action runs. Every run goes through runIntervention,
//   so a deadline, the banner's "close now" and a tool call can never run the
//   same intervention twice.
// Also handles restarts, sleep, the pause switch and the 10-minute outcome.

export const STEP_MS = 5_000;
/** A gap this long between steps means the PC slept (or the process hung). */
const SLEEP_GAP_MS = 30_000;
export const OUTCOME_AFTER_MS = 10 * MINUTE_MS;
// How much "now" to look at for the current foreground.
const NOW_WINDOW_MS = 3_000;

let lastStepAt: number | null = null;

/** Intervention group of whatever is in front right now. */
export function currentGroup(now: number): MinuteGroup | null {
  const cfg = getConfig();
  const fg = dominantForeground(getDb(), USER_ID, now - NOW_WINDOW_MS, now);
  if (!fg) return null;
  if (isLockApp(cfg, fg.app)) return "idle";
  return groupOf(cfg, fg.category);
}

export async function startIntervention(rule: Rule, plan: Plan, graceMs: number, now: number): Promise<Intervention> {
  const it = createIntervention(rule, plan, graceMs, now);
  console.log(`[intervention] #${it.id} ${rule} decided, grace ${Math.round(graceMs / 1000)}s`);
  await getExecutor().showBanner(it, Math.round(graceMs / 1000));
  return it;
}

export async function cancel(it: Intervention, reason: string, result?: Record<string, unknown>): Promise<void> {
  cancelIntervention(it.id, reason, result);
  console.log(`[intervention] #${it.id} ${it.rule} cancelled: ${reason}`);
  if (it.status === "pending") await getExecutor().hideBanner(it);
}

// Interventions being run right now. Everything that runs one (deadline,
// "close now", MCP tool) lives in this process, so this is enough to make a
// second, late or concurrent request a no-op.
const running = new Set<number>();

/**
 * Runs a pending or paused intervention's action once. Returns false when it
 * is not active any more or is already being run.
 */
export async function runIntervention(id: number, by: ExecutedBy, now: number): Promise<boolean> {
  if (running.has(id)) return false;
  const it = getIntervention(id);
  if (!it || (it.status !== "pending" && it.status !== "paused")) return false;
  running.add(id);
  try {
    const res = await getExecutor().execute(it);
    if (!res.ok) {
      // e.g. the extension is not connected: record it; the rule fires again
      // on a later tick if the situation persists.
      await cancel(it, "execution_failed", res.detail);
      return false;
    }
    markExecuted(it.id, by, res.detail, now);
    console.log(`[intervention] #${it.id} ${it.rule} executed by ${by}`);
    return true;
  } finally {
    running.delete(id);
  }
}

/** Restart recovery: drop what expired while the guardian was down, re-show banners for the rest. */
export async function recover(now: number): Promise<void> {
  for (const it of activeInterventions()) {
    if (it.status === "pending" && (it.graceUntil ?? 0) <= now) await cancel(it, "expired_while_down");
    else if (it.status === "paused" && (it.plan.cancelAt ?? 0) <= now) await cancel(it, "user_left");
    else if (it.status === "pending") await getExecutor().showBanner(it, Math.round(((it.graceUntil ?? now) - now) / 1000));
  }
}

// Steps are serialized: the timer loop and a banner "close now" must never run
// the same deadline twice.
let stepChain: Promise<void> = Promise.resolve();

/** One pass over active interventions (queued behind any pass in progress). */
export function step(now: number): Promise<void> {
  const run = stepChain.then(() => doStep(now));
  stepChain = run.catch(() => {});
  return run;
}

async function doStep(now: number): Promise<void> {
  const cfg = getConfig();
  const db = getDb();
  const slept = lastStepAt !== null && now - lastStepAt > SLEEP_GAP_MS;
  lastStepAt = now;
  const active = activeInterventions();
  if (active.length === 0) return;

  if (isPaused(now)) {
    for (const it of active) await cancel(it, "guardian_paused");
    return;
  }
  const alive = collectorAliveFor(db, cfg, now - MINUTE_MS, now);
  const grp = alive ? currentGroup(now) : null;

  for (const it of active) {
    const deadlinePassed = it.status === "pending" && (it.graceUntil ?? 0) <= now;
    if (slept && deadlinePassed) {
      await cancel(it, "expired_while_asleep"); // never act on a user who was not there
      continue;
    }
    if (!alive) {
      if (deadlinePassed) await cancel(it, "collector_down");
      continue;
    }

    if (running.has(it.id)) continue;
    if (it.rule === "R1") {
      if (it.status === "pending" && grp !== "entertainment") {
        pauseIntervention(it.id, now);
        await getExecutor().hideBanner(it);
        console.log(`[intervention] #${it.id} R1 paused (user left entertainment)`);
        continue;
      }
      if (it.status === "paused") {
        if ((it.plan.cancelAt ?? 0) <= now) await cancel(it, "user_left");
        else if (grp === "entertainment") {
          resumeIntervention(it.id, now);
          await getExecutor().showBanner(it, Math.round((it.pausedRemaining ?? 0) / 1000));
          console.log(`[intervention] #${it.id} R1 resumed`);
        }
        continue;
      }
    }
    if (it.rule === "R2" && grp === "productive") {
      await cancel(it, "user_started_productive");
      continue;
    }
    if (deadlinePassed) await runIntervention(it.id, "fallback", now);
  }
}

/**
 * The user pressed "close now" on a banner: run the intervention right away
 * instead of waiting out the grace period.
 */
export async function closeNow(id: number, now: number): Promise<boolean> {
  const it = getIntervention(id);
  if (!it || (it.status !== "pending" && it.status !== "paused")) return false;
  updatePlan(id, { closedNowAt: now });
  console.log(`[intervention] #${id} close-now requested from banner`);
  return runIntervention(id, "fallback", now);
}

export type AgentRequest =
  | { ok: true; id: number; rule: Rule; executedNow: boolean }
  | { ok: false; reason: "no_active_intervention" | "not_active" | "wrong_rule" };

/**
 * An MCP tool asked to run a running R1/R2 now: the user asked the agent in
 * chat. Only a pending or paused intervention of the same rule is accepted;
 * without an id the running one of that rule is used.
 */
export async function requestByAgent(rule: "R1" | "R2", id: number | undefined, now: number): Promise<AgentRequest> {
  const it = id === undefined ? activeInterventions().find((x) => x.rule === rule) : getIntervention(id);
  if (!it) return { ok: false, reason: id === undefined ? "no_active_intervention" : "not_active" };
  if (it.rule !== rule) return { ok: false, reason: "wrong_rule" };
  if (it.status !== "pending" && it.status !== "paused") return { ok: false, reason: "not_active" };
  console.log(`[intervention] #${it.id} ${rule} run requested by agent`);
  const executedNow = await runIntervention(it.id, "agent", now);
  return { ok: true, id: it.id, rule, executedNow };
}

const PRESETS: readonly PausePreset[] = ["30m", "1h", "today", "manual"];

export function registerExtensionHandlers(): void {
  onExtensionMessage("close_now", async (msg) => {
    if (typeof msg["interventionId"] === "number") await closeNow(msg["interventionId"], Date.now());
  });
  // Popup "pause interventions": fixed presets only.
  onExtensionMessage("pause", async (msg) => {
    const preset = msg["preset"];
    if (typeof preset !== "string" || !PRESETS.includes(preset as PausePreset)) throw new Error("unknown preset");
    const now = Date.now();
    setPause(preset as PausePreset, "extension", now);
    await step(now); // cancel running interventions right away
    return pauseStatus(now);
  });
  onExtensionMessage("resume", () => {
    resume("extension");
    return pauseStatus(Date.now());
  });
  onExtensionMessage("status", () => pauseStatus(Date.now()));
}

/** Records the activity group 10 minutes after each executed intervention. */
export function recordOutcomes(now: number): void {
  const db = getDb();
  for (const it of outcomesDue(now, OUTCOME_AFTER_MS)) {
    const at = Math.floor(((it.executedAt ?? now) + OUTCOME_AFTER_MS) / MINUTE_MS) * MINUTE_MS;
    const row = db.prepare("SELECT grp FROM activity_minutes WHERE minute_start = ?").get(at) as { grp: string } | undefined;
    if (row) setOutcome(it.id, row.grp, at);
    else if (now > at + 5 * MINUTE_MS) setOutcome(it.id, "unknown", at);
  }
}

/** Test hook. */
export function resetStepClock(): void {
  lastStepAt = null;
}
