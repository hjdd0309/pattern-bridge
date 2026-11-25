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

export function latestExecuted(rule: Rule): Intervention | null {
  const r = getDb()
    .prepare("SELECT * FROM interventions WHERE rule = ? AND status = 'executed' ORDER BY executed_at DESC LIMIT 1")
    .get(rule) as Row | undefined;
  return r ? toIntervention(r) : null;
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

/** Moves the deadline to `now` (banner "close now"); a paused one becomes pending again. */
export function expediteIntervention(id: number, now: number): boolean {
  return getDb()
    .prepare(`
      UPDATE interventions SET status = 'pending', grace_until = ?, paused_remaining = NULL
      WHERE id = ? AND status IN ('pending', 'paused')
    `)
    .run(now, id).changes > 0;
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
