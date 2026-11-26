import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../../config/config.js";
import { tokensMatch } from "../security/extension-auth.js";
import { getDb } from "../db/schema.js";
import { getConfig } from "./config.js";
import { activeInterventions, getIntervention, type Intervention } from "./interventions.js";
import { requestByAgent, step, type AgentRequest } from "./manager.js";
import { pauseStatus, resume, setPause, type PausePreset } from "./pause.js";

// 바른생활지킴이 MCP server: the tools OpenClaw may call.
//
// Two callers come through it: the guardian itself, running a rule's action
// through the Gateway (/tools/invoke, no LLM), and the agent answering the
// user in chat. The two action tools only run an intervention that the rules
// already started (through the same runIntervention as everything else); the
// rest are pause/resume and status. Arguments are numbers and fixed words; answers
// carry rules, states and times only — never URLs, titles or file paths.
//
// Streamable HTTP on 127.0.0.1, stateless (a fresh server per request),
// Bearer token required, browsers (Origin header) and foreign Host names
// rejected so a web page cannot reach it.

const INSTRUCTIONS = [
  "바른생활지킴이 개입 도구입니다. 개입을 할지, 언제 할지는 판단 레이어(규칙)가 정하고, 예정된 실행도 판단 레이어가 알아서 합니다.",
  "",
  "개입 알림(웹훅)을 받았을 때는 도구를 쓰지 말고 메시지만 보내세요.",
  "",
  "도구는 사용자가 디스코드로 직접 요청했을 때만 씁니다:",
  "- \"지금 닫아 줘\", \"바로 공부 모드 켜 줘\": 진행 중인 개입을 지금 실행합니다. 오락 탭 정리는 close_entertainment_tabs, 생산 모드는 start_focus_mode. 진행 중인 개입이 없으면 그렇다고 알려 주세요.",
  "- \"30분만 멈춰 줘\", \"오늘은 그만\": pause_interventions (preset 30m, 1h, today, manual 또는 minutes 1~600).",
  "- \"다시 켜 줘\": resume_interventions.",
  "- \"지금 뭐 걸려 있어?\", \"멈춰 있어?\": get_intervention, get_pause_status.",
  "",
  "도구 결과에 없는 사이트 이름이나 내용을 지어내지 마세요. 한국어로 짧게 답하세요.",
].join("\n");

const PRESETS = ["30m", "1h", "today", "manual"] as const;

function clock(ms: number | null): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** What the agent may see of an intervention: no plan contents (workspace URLs, files). */
function view(it: Intervention, now: number): Record<string, unknown> {
  const secondsLeft = it.status === "pending" ? Math.max(0, Math.round(((it.graceUntil ?? now) - now) / 1000))
    : it.status === "paused" ? Math.round((it.pausedRemaining ?? 0) / 1000)
    : null;
  return {
    id: it.id,
    rule: it.rule,
    status: it.status,
    secondsLeft,
    decidedAt: clock(it.decidedAt),
    rewarning: !!it.plan["rewarn"],
    executedAt: clock(it.executedAt),
    executedBy: it.executedBy,
    cancelReason: it.cancelReason,
  };
}

function latestFinished(): Intervention | null {
  const r = getDb().prepare(`
    SELECT id FROM interventions WHERE status IN ('executed', 'cancelled') AND rule IN ('R1', 'R2')
    ORDER BY decided_at DESC LIMIT 1
  `).get() as { id: number } | undefined;
  return r ? getIntervention(r.id) : null;
}

function pauseView(now: number): Record<string, unknown> {
  const p = pauseStatus(now);
  return { paused: p.paused, until: p.paused ? (p.until ? clock(p.until) : "manual") : null, by: p.source };
}

function result(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], isError };
}

function actionResult(r: AgentRequest) {
  if (!r.ok) {
    const why = {
      no_active_intervention: "진행 중인 개입이 없습니다.",
      not_active: "그 개입은 이미 끝났거나 없습니다.",
      wrong_rule: "그 개입은 이 도구의 대상이 아닙니다.",
    }[r.reason];
    return result({ ok: false, reason: r.reason, message: why }, true);
  }
  return result({ ok: true, id: r.id, rule: r.rule, executedNow: r.executedNow });
}

const actionArgs = {
  interventionId: z.number().int().positive().optional().describe("개입 ID. 없으면 진행 중인 개입"),
};

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "guardian", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool("close_entertainment_tabs", {
    description: "진행 중인 R1(오락 연속) 개입을 지금 바로 실행합니다: 오락 탭 정리.",
    inputSchema: actionArgs,
  }, async ({ interventionId }) => actionResult(await requestByAgent("R1", interventionId, Date.now())));

  server.registerTool("start_focus_mode", {
    description: "진행 중인 R2(생산 부족) 개입을 지금 바로 실행합니다: 생산 모드(오락 탭 정리, 창 최소화, 작업 창 열기).",
    inputSchema: actionArgs,
  }, async ({ interventionId }) => actionResult(await requestByAgent("R2", interventionId, Date.now())));

  server.registerTool("get_intervention", {
    description: "진행 중인 개입과 가장 최근에 끝난 개입의 상태(규칙, 남은 초, 실행 주체 등)를 봅니다.",
  }, async () => {
    const now = Date.now();
    const last = latestFinished();
    return result({ active: activeInterventions().map((it) => view(it, now)), latest: last ? view(last, now) : null });
  });

  server.registerTool("pause_interventions", {
    description: "개입을 일시 정지합니다. 진행 중인 개입은 취소됩니다. preset 또는 minutes 중 하나만 넣으세요.",
    inputSchema: {
      preset: z.enum(PRESETS).optional().describe("30m, 1h, today(다음 새벽 5시까지), manual(다시 켤 때까지)"),
      minutes: z.number().int().optional().describe(`1~${getConfig().pause.maxMinutes}분`),
    },
  }, async ({ preset, minutes }) => {
    if ((preset === undefined) === (minutes === undefined)) return result({ ok: false, message: "preset과 minutes 중 하나만 넣으세요." }, true);
    const now = Date.now();
    try {
      setPause((preset ?? minutes) as PausePreset | number, "agent", now);
    } catch (err) {
      return result({ ok: false, message: err instanceof Error ? err.message : String(err) }, true);
    }
    await step(now); // cancel running interventions right away
    return result({ ok: true, ...pauseView(now) });
  });

  server.registerTool("resume_interventions", {
    description: "일시 정지를 풀고 개입을 다시 켭니다.",
  }, async () => {
    resume("agent");
    return result({ ok: true, ...pauseView(Date.now()) });
  });

  server.registerTool("get_pause_status", {
    description: "지금 개입이 일시 정지 중인지, 언제까지인지 봅니다.",
  }, async () => result(pauseView(Date.now())));

  return server;
}

const MAX_BODY = 1_000_000;

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function deny(res: http.ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
}

export async function handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse, port: number, token: string): Promise<void> {
  if ((req.url ?? "").split("?")[0] !== "/mcp") return deny(res, 404, "not found");
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) return deny(res, 403, "host not allowed");
  if (req.headers.origin) return deny(res, 403, "browser requests not allowed");
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || !tokensMatch(auth.slice(7), token)) return deny(res, 401, "bad token");
  if (req.method !== "POST") return deny(res, 405, "only POST (stateless server)");

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    return deny(res, 400, err instanceof Error ? err.message : "bad request");
  }
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no sessionIdGenerator = stateless
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

let httpServer: http.Server | null = null;

export function startMcpServer(port = config.mcp.port, token = config.mcp.token): http.Server | null {
  if (httpServer) return httpServer;
  if (!token) {
    console.warn("[mcp] GUARDIAN_MCP_TOKEN is not set: the agent tools server is off (interventions still run as fallback)");
    return null;
  }
  httpServer = http.createServer((req, res) => {
    handleMcpRequest(req, res, port, token).catch((err: unknown) => {
      console.error("[mcp] request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) deny(res, 500, "internal error");
    });
  });
  httpServer.listen(port, "127.0.0.1", () => console.log(`[mcp] agent tools on http://127.0.0.1:${port}/mcp`));
  httpServer.on("error", (err) => console.error("[mcp] server error:", err.message));
  return httpServer;
}

export function stopMcpServer(): void {
  httpServer?.close();
  httpServer = null;
}
