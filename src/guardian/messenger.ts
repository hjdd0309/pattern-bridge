import axios from "axios";
import { isConnectionError, sendAgentMessage, WebhookStatusError } from "../trigger/openclaw-client.js";
import { getConfig } from "./config.js";
import { dayKey } from "./history.js";
import { updatePlan, type Intervention } from "./interventions.js";
import { getState, setState } from "./state.js";

// Tells the user about an intervention through the OpenClaw agent (Discord).
//
// The webhook text only carries the rule, minutes, time of day and the planned
// action — never site names, URLs or titles — so no outside text reaches the
// LLM. Sending is fire-and-forget: a failure is logged and recorded on the
// intervention. Only failures where OpenClaw certainly did not run the agent
// are retried, once (see isSafeToRetry); a retry storm burned the free quota once.
// Hard caps (per minute / per day) stop a bug from flooding the agent. R1/R2
// announce an action that is about to happen, so they skip the per-minute cap
// (their rules already cannot fire twice a minute); other messages that hit it
// wait for the minute to pass instead of being dropped.

type WebhookLog = { day: string; count: number; lastAt: number };

function minutesText(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? (r ? `${h}시간 ${r}분` : `${h}시간`) : `${r}분`;
}

const FOOTER = "사이트 이름이나 페이지 제목은 언급하지 말고, 한국어로 한두 문장만 짧고 부드럽게 말해 주세요.";

export function buildMessage(it: Intervention): string {
  const p = it.plan as Record<string, unknown>;
  const grace = it.graceUntil ? Math.round((it.graceUntil - it.decidedAt) / 1000) : 0;
  const lines = ["[바른생활지킴이]"];
  if (it.rule === "R1") {
    // Re-warnings (plan.rewarn) are banner-only and never reach here.
    lines.push(`상황: 오락 콘텐츠를 ${minutesText(Number(p["streakMinutes"] ?? 0))}째 연속으로 보고 있습니다${p["night"] ? " (지금은 심야 시간대)" : ""}.`);
    lines.push(`예정 동작: ${grace}초 뒤 오락 탭을 정리합니다. 화면에도 카운트다운이 표시됩니다.`);
    lines.push("사용자에게 정리 예정임을 알리고 잠깐 쉬어 가자고 권해 주세요.");
  } else if (it.rule === "R2") {
    lines.push(`상황: 오늘 공부·작업 시간이 ${minutesText(Number(p["productive"] ?? 0))}으로, 평소 이 시각(${String(p["hour"])}시${p["minute"] ? ` ${String(p["minute"])}분` : ""})까지의 ${minutesText(Number(p["target"] ?? 0))}보다 많이 부족합니다.`);
    lines.push(`예정 동작: ${grace}초 뒤 생산 모드를 켭니다 (오락 탭 정리, 창 최소화, 평소 쓰던 작업 창 열기).`);
    lines.push("사용자를 다그치지 말고 지금 시작해 보자고 독려해 주세요.");
  } else {
    const count = Number(p["count"] ?? 1);
    lines.push(`상황: 오늘 오락·여가 콘텐츠를 ${minutesText(Number(p["consumptionMinutes"] ?? 0))} 이용했습니다${count > 1 ? ` (${count}번째 안내)` : ""}.`);
    lines.push("동작: 창은 건드리지 않습니다. 제안만 합니다.");
    lines.push("잠깐 쉬거나 다른 활동(스트레칭, 산책, 할 일 정리 등)을 가볍게 제안해 주세요.");
  }
  lines.push(FOOTER);
  return lines.join("\n");
}

type Reservation = { ok: true } | { ok: false; reason: string; waitMs?: number };

/** Reserves a send under the per-minute and per-day caps; false when over a cap. */
function reserve(now: number, priority: boolean): Reservation {
  const { maxPerMinute, maxPerDay } = getConfig().webhook;
  const day = dayKey(now);
  const log = getState<WebhookLog>("webhookLog");
  const today = log && log.day === day ? log : { day, count: 0, lastAt: 0 };
  if (today.count >= maxPerDay) return { ok: false, reason: "daily_cap" };
  if (!priority && maxPerMinute <= 1 && now - today.lastAt < 60_000) {
    return { ok: false, reason: "minute_cap", waitMs: today.lastAt + 60_000 - now };
  }
  setState("webhookLog", { day, count: today.count + 1, lastAt: Math.max(now, today.lastAt) } satisfies WebhookLog, now);
  return { ok: true };
}

export const CAP_WAIT_MS = { value: null as number | null }; // tests shorten the real wait

/** Like reserve, but waits out the per-minute cap (a few times) instead of giving up. */
async function reserveWaiting(now: number, priority: boolean, label: string): Promise<Reservation> {
  let at = now;
  for (let attempt = 0; ; attempt++) {
    const r = reserve(at, priority);
    if (r.ok || r.reason !== "minute_cap" || attempt >= 3) return r;
    console.log(`[messenger] ${label}: minute cap, sending in ${Math.ceil(r.waitMs! / 1000)}s`);
    await new Promise((res) => setTimeout(res, CAP_WAIT_MS.value ?? r.waitMs!));
    at += r.waitMs!;
  }
}

export const RETRY_DELAY_MS = { value: 3_000 }; // object so tests can shorten it

/**
 * True when OpenClaw certainly did not run the agent, so sending again cannot
 * produce a duplicate message: 503 (agent run not admitted, e.g. right after
 * the PC woke up) or the connection was refused (gateway not running).
 * A timeout is NOT safe: the agent may still be writing to Discord.
 */
export function isSafeToRetry(err: unknown): boolean {
  if (err instanceof WebhookStatusError) return err.status === 503;
  return axios.isAxiosError(err) && !err.response && err.code === "ECONNREFUSED";
}

async function sendOnceRetrying(text: string): Promise<{ ok: boolean }> {
  try {
    return await sendAgentMessage(text);
  } catch (err) {
    if (!isSafeToRetry(err)) throw err;
    console.warn(`[messenger] OpenClaw did not take the message (${err instanceof Error ? err.message : String(err)}), retrying once`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS.value));
    return await sendAgentMessage(text);
  }
}

async function send(it: Intervention, now: number): Promise<string> {
  const r = await reserveWaiting(now, it.rule === "R1" || it.rule === "R2", `#${it.id} ${it.rule}`);
  if (!r.ok) return r.reason;
  try {
    const res = await sendOnceRetrying(buildMessage(it));
    return res.ok ? "sent" : "skipped_not_configured";
  } catch (err) {
    const why = isConnectionError(err) ? "unreachable" : "error";
    console.error(`[messenger] #${it.id} ${it.rule} message failed (${why}): ${err instanceof Error ? err.message : String(err)}`);
    return why;
  }
}

/** Sends the message in the background and records the outcome on the intervention. */
export function notify(it: Intervention, now = Date.now()): void {
  void send(it, now).then((status) => {
    updatePlan(it.id, { message: status });
    console.log(`[messenger] #${it.id} ${it.rule}: ${status}`);
  });
}

/** Tells the user that a pause ran out and interventions are back on. */
export function notifyResumed(now = Date.now()): void {
  void reserveWaiting(now, false, "resume notice").then((r) => {
    if (!r.ok) {
      console.log(`[messenger] resume notice: ${r.reason}`);
      return;
    }
    sendResumed();
  });
}

function sendResumed(): void {
  const text = [
    "[바른생활지킴이]",
    "상황: 사용자가 걸어 둔 개입 일시 정지 시간이 끝나 개입을 다시 시작했습니다.",
    "사용자에게 한국어로 한 문장만 짧게 알려 주세요.",
  ].join("\n");
  void sendOnceRetrying(text)
    .then((res) => console.log(`[messenger] resume notice: ${res.ok ? "sent" : "skipped_not_configured"}`))
    .catch((err: unknown) => console.error(`[messenger] resume notice failed: ${err instanceof Error ? err.message : String(err)}`));
}
