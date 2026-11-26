import { getDb } from "../db/schema.js";

// Storage for interventions (the interventions table).
//
// Lifecycle:
//   pending  — grace countdown running; executes when grace_until is reached
//   paused   — the user left the trigger during grace; paused_remaining holds
//              the time left. Resumes if the user comes back before the
//              original deadline (plan.cancelAt), otherwise it is cancelled.
//   executed — the action ran (executed_by: agent | fallback | message)
//   cancelled — cancel_reason says why

export type Rule = "R1" | "R2" | "R3";
export type Status = "pending" | "paused" | "executed" | "cancelled";
export type ExecutedBy = "agent" | "fallback" | "message";

export type Plan = Record<string, unknown> & {
  /** Original deadline: a paused intervention is cancelled after this. */
  cancelAt?: number;
  /** Set when the agent asked for execution (tool call); see step 5. */
  agentRequestedAt?: number;
  /** When the user pressed "close now" on the banner. */
  closedNowAt?: number;
};

export type Intervention = {
  id: number;
  rule: Rule;
  status: Status;
  decidedAt: number;
  graceUntil: number | null;
  pausedRemaining: number | null;
  executedAt: number | null;
  executedBy: ExecutedBy | null;
  cancelReason: string | null;
  plan: Plan;
  result: Record<string, unknown>;
  outcomeGrp: string | null;
  outcomeAt: number | null;
};

type Row = {
  id: number; rule: Rule; status: Status; decided_at: number; grace_until: number | null;
  paused_remaining: number | null; executed_at: number | null; executed_by: ExecutedBy | null;
  cancel_reason: string | null; plan: string; result: string; outcome_grp: string | null; outcome_at: number | null;
};

function parse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toIntervention(r: Row): Intervention {
  return {
    id: r.id, rule: r.rule, status: r.status, decidedAt: r.decided_at, graceUntil: r.grace_until,
    pausedRemaining: r.paused_remaining, executedAt: r.executed_at, executedBy: r.executed_by,
    cancelReason: r.cancel_reason, plan: parse(r.plan) as Plan, result: parse(r.result),
    outcomeGrp: r.outcome_grp, outcomeAt: r.outcome_at,
  };
}

export function createIntervention(rule: Rule, plan: Plan, graceMs: number, now: number): Intervention {
  const graceUntil = now + graceMs;
  const fullPlan: Plan = { ...plan, cancelAt: graceUntil };
  const id = Number(
    getDb()
      .prepare(`INSERT INTO interventions (rule, status, decided_at, grace_until, plan) VALUES (?, 'pending', ?, ?, ?)`)
      .run(rule, now, graceUntil, JSON.stringify(fullPlan)).lastInsertRowid,
  );
  return getIntervention(id)!;
}

/** An intervention that is already done when it is decided (R3 messages). */
export function recordExecuted(rule: Rule, plan: Plan, by: ExecutedBy, result: Record<string, unknown>, now: number): Intervention {
  const id = Number(
    getDb()
      .prepare(`
        INSERT INTO interventions (rule, status, decided_at, executed_at, executed_by, plan, result)
        VALUES (?, 'executed', ?, ?, ?, ?, ?)
      `)
      .run(rule, now, now, by, JSON.stringify(plan), JSON.stringify(result)).lastInsertRowid,
  );
  return getIntervention(id)!;
}

export function getIntervention(id: number): Intervention | null {
  const r = getDb().prepare("SELECT * FROM interventions WHERE id = ?").get(id) as Row | undefined;
  return r ? toIntervention(r) : null;
}

/** pending and paused interventions, oldest first. */
export function activeInterventions(): Intervention[] {
  return (getDb()
    .prepare("SELECT * FROM interventions WHERE status IN ('pending', 'paused') ORDER BY decided_at")
    .all() as Row[]).map(toIntervention);
}

/**
 * The latest R2 that starts a cooldown: focus mode ran (or failed to), or the
 * user started working during grace. Cancels for other reasons (pause, sleep,
 * collector down) do not count.
 */
export function latestEndedR2(): { it: Intervention; endedAt: number } | null {
  const r = getDb()
    .prepare(`
      SELECT * FROM interventions
      WHERE rule = 'R2'
        AND (status = 'executed'
             OR (status = 'cancelled' AND cancel_reason IN ('user_started_productive', 'execution_failed')))
      ORDER BY decided_at DESC LIMIT 1
    `)
    .get() as Row | undefined;
  if (!r) return null;
  const it = toIntervention(r);
  return { it, endedAt: it.executedAt ?? it.graceUntil ?? it.decidedAt };
}

/**
 * The latest regular R1 that has ended (tabs closed, or cancelled because the
 * user stayed away until the deadline), with the time it ended. Re-warnings
 * (plan.rewarn) are skipped: they never start a rest period of their own.
 */
export function latestEndedR1(): { it: Intervention; endedAt: number } | null {
  const r = getDb()
    .prepare(`
      SELECT * FROM interventions
      WHERE rule = 'R1' AND json_extract(plan, '$.rewarn') IS NULL
        AND (status = 'executed' OR (status = 'cancelled' AND cancel_reason = 'user_left'))
      ORDER BY decided_at DESC LIMIT 1
    `)
    .get() as Row | undefined;
  if (!r) return null;
  const it = toIntervention(r);
  // A user_left cancel happens at the original deadline (plan.cancelAt).
  const endedAt = it.executedAt ?? it.plan.cancelAt ?? it.graceUntil ?? it.decidedAt;
  return { it, endedAt };
}

/** True when a re-warning was already given for this R1. */
export function hasRewarning(previousId: number): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM interventions WHERE rule = 'R1' AND json_extract(plan, '$.previous') = ? LIMIT 1")
    .get(previousId);
}

export function pauseIntervention(id: number, now: number): void {
  getDb()
    .prepare(`
      UPDATE interventions SET status = 'paused', paused_remaining = MAX(grace_until - ?, 0)
      WHERE id = ? AND status = 'pending'
    `)
    .run(now, id);
}

export function resumeIntervention(id: number, now: number): void {
  getDb()
    .prepare(`
      UPDATE interventions SET status = 'pending', grace_until = ? + paused_remaining, paused_remaining = NULL
      WHERE id = ? AND status = 'paused'
    `)
    .run(now, id);
}

export function updatePlan(id: number, patch: Partial<Plan>): void {
  const it = getIntervention(id);
  if (!it) return;
  getDb().prepare("UPDATE interventions SET plan = ? WHERE id = ?").run(JSON.stringify({ ...it.plan, ...patch }), id);
}

export function markExecuted(id: number, by: ExecutedBy, result: Record<string, unknown>, now: number): void {
  getDb()
    .prepare(`
      UPDATE interventions SET status = 'executed', executed_at = ?, executed_by = ?, result = ?
      WHERE id = ? AND status IN ('pending', 'paused')
    `)
    .run(now, by, JSON.stringify(result), id);
}

export function cancelIntervention(id: number, reason: string, result?: Record<string, unknown>): void {
  getDb()
    .prepare(`
      UPDATE interventions SET status = 'cancelled', cancel_reason = ?, result = COALESCE(?, result)
      WHERE id = ? AND status IN ('pending', 'paused')
    `)
    .run(reason, result ? JSON.stringify(result) : null, id);
}

/** Executed interventions whose 10-minute outcome is due but not yet recorded. */
export function outcomesDue(now: number, afterMs: number): Intervention[] {
  return (getDb()
    .prepare("SELECT * FROM interventions WHERE status = 'executed' AND outcome_at IS NULL AND executed_at <= ? AND rule != 'R3'")
    .all(now - afterMs) as Row[]).map(toIntervention);
}

export function setOutcome(id: number, grp: string, at: number): void {
  getDb().prepare("UPDATE interventions SET outcome_grp = ?, outcome_at = ? WHERE id = ?").run(grp, at, id);
}
