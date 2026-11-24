import { getDb } from "../db/schema.js";
import { getBaseline } from "./baseline.js";
import { getConfig } from "./config.js";
import { dayTypeOf } from "./history.js";
import { isExercise } from "./groups.js";
import { activeInterventions, latestExecuted, recordExecuted, type Intervention } from "./interventions.js";
import { cancel, startIntervention } from "./manager.js";
import { notify } from "./messenger.js";
import { MINUTE_MS } from "./minute.js";
import { isPaused } from "./pause.js";
import { getState, setState } from "./state.js";
import { computeWorkspace } from "./workspace.js";
import { USER_ID, type Context } from "./tracker.js";

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
    notify(await startIntervention("R1", { reopen: true, streakMinutes: ctx.streakMinutes, previous: last.id }, r1.reopenGraceSeconds * 1000, now), now);
    return;
  }

  const night = inHourRange(new Date(now).getHours(), r1.nightStartHour, r1.nightEndHour);
  const threshold = night ? r1.nightMinutes : r1.dayMinutes;
  if (ctx.streakMinutes < threshold) return;
  notify(await startIntervention("R1", { streakMinutes: ctx.streakMinutes, threshold, night }, r1.graceSeconds * 1000, now), now);
}

/**
 * R2: checked on the hour. If today's productive time is below deficitRatio of
 * the usual cumulative amount by this hour (same day type), and the user is
 * not working right now, start focus mode after a grace period. Once today's
 * total reaches enoughRatio of the usual daily total, R2 is done for the day.
 */
export async function evaluateR2(ctx: Context, now: number): Promise<void> {
  const cfg = getConfig();
  const r2 = cfg.rules.R2;
  if (new Date(ctx.at).getMinutes() !== 0) return; // on the hour only
  if (getState<number>("r2DoneDay") === ctx.dayStart) return;

  const set = getBaseline(getDb(), cfg, USER_ID, ctx.dayStart, now)[dayTypeOf(ctx.dayStart)];
  if (ctx.today.productive >= r2.enoughRatio * set.dailyMedian) {
    setState("r2DoneDay", ctx.dayStart, now);
    console.log(`[R2] enough for today (${ctx.today.productive}m ≥ ${r2.enoughRatio} × ${set.dailyMedian}m)`);
    return;
  }

  const hour = new Date(ctx.at).getHours();
  const target = set.cumulativeAt[String(hour)] ?? 0;
  const threshold = r2.deficitRatio * target;
  if (ctx.today.productive >= threshold) return;
  const grp = ctx.current?.grp;
  if (!grp || grp === "productive" || grp === "idle") return;
  if (isExercise(cfg, ctx.current?.category)) return; // never interrupt a workout

  const active = activeInterventions();
  if (active.some((it) => it.rule === "R2")) return;
  for (const it of active) if (it.rule === "R1") await cancel(it, "superseded_by_R2");
  const it = await startIntervention(
    "R2",
    {
      hour, target, threshold, productive: ctx.today.productive, dayType: dayTypeOf(ctx.dayStart), baselineDays: set.days,
      // Decided now and kept in the plan: the agent only ever sees the intervention ID.
      workspace: computeWorkspace(getDb(), cfg, USER_ID, now),
    },
    r2.graceSeconds * 1000,
    now,
  );
  notify(it, now);
}

type R3State = { dayStart: number; lastSentAt: number; count: number };

/**
 * R3: suggestion only. When today's entertainment + leisure (without
 * exercise) reaches thresholdMinutes, send a suggestion right away; after
 * that, every repeatMinutes, send again only if the user is consuming at that
 * moment. Never touches windows.
 */
export async function evaluateR3(ctx: Context, now: number): Promise<Intervention | null> {
  const cfg = getConfig();
  const r3 = cfg.rules.R3;
  if (ctx.today.consumption < r3.thresholdMinutes) return null;

  const state = getState<R3State>("r3");
  const first = !state || state.dayStart !== ctx.dayStart;
  if (!first) {
    if (now - state.lastSentAt < r3.repeatMinutes * MINUTE_MS) return null;
    const cur = ctx.current;
    const consuming = cur?.grp === "entertainment" || (cur?.grp === "leisure" && !isExercise(cfg, cur.category));
    if (!consuming) return null;
  }
  const count = first ? 1 : state.count + 1;
  setState("r3", { dayStart: ctx.dayStart, lastSentAt: now, count } satisfies R3State, now);
  const it = recordExecuted("R3", { consumptionMinutes: ctx.today.consumption, count, current: ctx.current?.grp ?? null }, "message", {}, now);
  console.log(`[R3] #${it.id} suggestion ${count} (consumption ${ctx.today.consumption}m)`);
  notify(it, now);
  return it;
}

export async function evaluateRules(ctx: Context, now: number): Promise<void> {
  if (isPaused(now)) return;
  await evaluateR2(ctx, now); // R2 first: it outranks R1
  await evaluateR1(ctx, now);
  await evaluateR3(ctx, now);
}
