import { isConnectionError, sendAgentMessage } from "../trigger/openclaw-client.js";
import { getConfig } from "./config.js";
import { dayKey } from "./history.js";
import { updatePlan, type Intervention } from "./interventions.js";
import { getState, setState } from "./state.js";

// Tells the user about an intervention through the OpenClaw agent (Discord).
//
// The webhook text only carries the rule, minutes, time of day and the planned
// action — never site names, URLs or titles — so no outside text reaches the
// LLM. Sending is fire-and-forget: a failure is logged and recorded on the
// intervention, never retried (a retry storm burned the free quota once).
// Hard caps (per minute / per day) stop a bug from flooding the agent.

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
    if (p["reopen"]) {
      lines.push("상황: 방금 유흥 탭을 정리했는데 10분이 지나기 전에 다시 유흥 콘텐츠를 열었습니다.");
    } else {
      lines.push(`상황: 유흥 콘텐츠를 ${minutesText(Number(p["streakMinutes"] ?? 0))}째 연속으로 보고 있습니다${p["night"] ? " (지금은 심야 시간대)" : ""}.`);
    }
    lines.push(`예정 동작: ${grace}초 뒤 유흥 탭을 정리합니다. 화면에도 카운트다운이 표시됩니다.`);
    lines.push("사용자에게 정리 예정임을 알리고 잠깐 쉬어 가자고 권해 주세요.");
  } else if (it.rule === "R2") {
    lines.push(`상황: 오늘 공부·작업 시간이 ${minutesText(Number(p["productive"] ?? 0))}으로, 평소 이 시각(${String(p["hour"])}시)까지의 ${minutesText(Number(p["target"] ?? 0))}보다 많이 부족합니다.`);
    lines.push(`예정 동작: ${grace}초 뒤 생산 모드를 켭니다 (유흥 탭 정리, 창 최소화, 평소 쓰던 작업 창 열기).`);
    lines.push("사용자를 다그치지 말고 지금 시작해 보자고 독려해 주세요.");
  } else {
    const count = Number(p["count"] ?? 1);
    lines.push(`상황: 오늘 유흥·여가 콘텐츠를 ${minutesText(Number(p["consumptionMinutes"] ?? 0))} 이용했습니다${count > 1 ? ` (${count}번째 안내)` : ""}.`);
    lines.push("동작: 창은 건드리지 않습니다. 제안만 합니다.");
    lines.push("잠깐 쉬거나 다른 활동(스트레칭, 산책, 할 일 정리 등)을 가볍게 제안해 주세요.");
  }
  lines.push(FOOTER);
  return lines.join("\n");
}

/** Reserves a send under the per-minute and per-day caps; false when over a cap. */
function reserve(now: number): { ok: true } | { ok: false; reason: string } {
  const { maxPerMinute, maxPerDay } = getConfig().webhook;
  const day = dayKey(now);
  const log = getState<WebhookLog>("webhookLog");
  const today = log && log.day === day ? log : { day, count: 0, lastAt: 0 };
  if (today.count >= maxPerDay) return { ok: false, reason: "daily_cap" };
  if (maxPerMinute <= 1 && now - today.lastAt < 60_000) return { ok: false, reason: "minute_cap" };
  setState("webhookLog", { day, count: today.count + 1, lastAt: now } satisfies WebhookLog, now);
  return { ok: true };
}

async function send(it: Intervention, now: number): Promise<string> {
  const r = reserve(now);
  if (!r.ok) return r.reason;
  try {
    const res = await sendAgentMessage(buildMessage(it));
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
