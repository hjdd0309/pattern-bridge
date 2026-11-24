import { getConfig } from "./config.js";
import { activeInterventions, latestExecuted } from "./interventions.js";
import { startIntervention } from "./manager.js";
import { MINUTE_MS } from "./minute.js";
import { isPaused } from "./pause.js";
import type { Context } from "./tracker.js";

// Rules, evaluated once per minute on the fresh context. A rule only decides;
// the manager runs the grace period and the action.
//
// One forced intervention (R1/R2) at a time. R2 outranks R1: it already
// closes entertainment tabs as part of focus mode.

function inHourRange(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** R1: too long on entertainment in a row → close entertainment tabs after a grace period. */
export async function evaluateR1(ctx: Context, now: number): Promise<void> {
  const r1 = getConfig().rules.R1;
  if (ctx.current?.grp !== "entertainment") return;
  if (activeInterventions().some((it) => it.rule === "R1" || it.rule === "R2")) return;

  // Re-opened entertainment shortly after R1 closed it: short grace.
  const last = latestExecuted("R1");
  if (last?.executedAt && now - last.executedAt < r1.reopenWindowMinutes * MINUTE_MS) {
    await startIntervention("R1", { reopen: true, streakMinutes: ctx.streakMinutes, previous: last.id }, r1.reopenGraceSeconds * 1000, now);
    return;
  }

  const night = inHourRange(new Date(now).getHours(), r1.nightStartHour, r1.nightEndHour);
  const threshold = night ? r1.nightMinutes : r1.dayMinutes;
  if (ctx.streakMinutes < threshold) return;
  await startIntervention("R1", { streakMinutes: ctx.streakMinutes, threshold, night }, r1.graceSeconds * 1000, now);
}

export async function evaluateRules(ctx: Context, now: number): Promise<void> {
  if (isPaused(now)) return;
  await evaluateR1(ctx, now);
}
