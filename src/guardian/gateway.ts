import { config } from "../../config/config.js";

// OpenClaw Gateway HTTP API: POST /tools/invoke runs one tool without an LLM
// turn, under the Gateway's tool policy. The guardian uses it to run a rule's
// action through OpenClaw (→ our own MCP tool), so every action takes the same
// route whether a rule or the user in chat asked for it.
//
// The Gateway token is owner-level (see OpenClaw docs/gateway/tools-invoke-http-api):
// it is read from .env only and never logged.

export class GatewayError extends Error {}

export async function invokeTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const { gatewayUrl, gatewayToken, invokeTimeoutMs } = config.openclaw;
  if (!gatewayUrl || !gatewayToken) throw new GatewayError("gateway not configured");
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken}` },
      body: JSON.stringify({ tool: `${config.mcp.serverName}__${tool}`, args }),
      signal: AbortSignal.timeout(invokeTimeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new GatewayError(name === "TimeoutError" ? `timeout after ${invokeTimeoutMs}ms` : "gateway unreachable");
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
  if (!res.ok || !body?.ok) throw new GatewayError(`HTTP ${res.status}`);
  return body.result;
}
