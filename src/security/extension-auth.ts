import crypto from "crypto";
import { config } from "../../config/config.js";

// Checks that a request comes from our Chrome extension: the Origin must be
// chrome-extension://<our pinned ID>, and, when EXTENSION_TOKEN is set, the
// request must carry the same token. Used by the collector's /collect
// endpoint and the guardian's command WebSocket.

export const TOKEN_HEADER = "X-Pattern-Bridge-Token";

export function extensionOrigin(): string {
  return config.extension.id ? `chrome-extension://${config.extension.id}` : "";
}

export function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

export function isExtensionRequest(origin: string | undefined, token: string | string[] | undefined): AuthResult {
  const expectedOrigin = extensionOrigin();
  if (!expectedOrigin || origin !== expectedOrigin) return { ok: false, status: 403, error: "origin not allowed" };
  const expected = config.extension.token;
  if (expected) {
    const given = Array.isArray(token) ? token[0] ?? "" : token ?? "";
    if (!tokensMatch(given, expected)) return { ok: false, status: 401, error: "bad token" };
  }
  return { ok: true };
}

let warned = false;
export function warnIfNoToken(component: string): void {
  if (!config.extension.token && !warned) {
    warned = true;
    console.warn(`[${component}] EXTENSION_TOKEN is not set — only the extension origin is checked`);
  }
}
