import axios from "axios";
import { config } from "../../config/config.js";
import type { PatternResult } from "../analyzer/pattern-engine.js";

export type WebhookPayload = {
  event: "pattern.detected";
  timestamp: string;
  data: PatternResult;
};

export type WebhookResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

function buildMessage(pattern: PatternResult): string {
  return `패턴 놓침 감지: ${pattern.description ?? JSON.stringify(pattern)}. 사용자에게 자연스럽게 한국어로 알려주세요.`;
}

export async function sendWebhook(
  pattern: PatternResult
): Promise<WebhookResponse> {
  const { webhookUrl, token, timeoutMs } = config.openclaw;

  if (!webhookUrl) {
    console.log("[openclaw] webhook 미설정, 스킵");
    return { ok: false, status: 0, body: null };
  }

  const payload = {
    message: buildMessage(pattern),
    name: "PatternBridge",
    deliver: true,
    channel: "telegram",
    to: "7055746358",
  };

  const response = await axios.post<unknown>(webhookUrl, payload, {
    timeout: timeoutMs,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `OpenClaw webhook returned ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  return { ok: true, status: response.status, body: response.data };
}

export async function sendWebhooks(patterns: PatternResult[]): Promise<{
  sent: number;
  failed: number;
  errors: string[];
}> {
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const pattern of patterns) {
    try {
      await sendWebhook(pattern);
      sent++;
    } catch (err) {
      failed++;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { sent, failed, errors };
}
