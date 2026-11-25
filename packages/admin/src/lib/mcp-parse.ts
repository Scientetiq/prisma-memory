import { text as M } from "../messages/mcp-parse";
import { derived } from "../i18n/runtime";
import { SESSION_PLAIN } from "./login-return";
import { DERIVED_PLAIN, formatDay } from "./plain";

export const MCP_REVISION = "2026-07-28";
export const MCP_CLIENT = { name: "memory-workspace", version: "0.1.0" };

export type McpResult<T> = { ok: true; data: T; text: string } | McpFail;
export interface McpFail { ok: false; code: string; message: string; status: number; hint?: string; retryAfter?: number; details?: unknown }

export const sentinel = (name: string): string => `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;

export function toolCallRequest(name: string, args: Record<string, unknown>, id = 1): { body: Record<string, unknown>; headers: Record<string, string> } {
  return {
    body: {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_REVISION, "io.modelcontextprotocol/clientInfo": MCP_CLIENT, "io.modelcontextprotocol/clientCapabilities": {} } },
    },
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MCP_REVISION, "Mcp-Method": "tools/call", "Mcp-Name": sentinel(name) },
  };
}

export function parseBody(text: string, contentType: string | null | undefined): unknown {
  if (!text) return null;
  if ((contentType ?? "").startsWith("text/event-stream")) {
    let last: unknown = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { last = JSON.parse(line.slice(5).trim()); } catch { }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

const RPC_CODES: Record<number, string> = { [-32602]: "invalid_argument", [-32603]: "internal", [-32601]: "unknown_tool", [-32600]: "bad_request", [-32002]: "not_found" };

export function parseToolResponse<T>(status: number, body: unknown, retryAfterHeader?: string | null): McpResult<T> {
  const b = (body ?? {}) as Record<string, any>;
  if (status === 401) return { ok: false, status, code: "unauthorized", message: typeof b.message === "string" ? b.message : M.keyNotAccepted };
  if (status === 503) return { ok: false, status, code: "fail_closed", message: typeof b.message === "string" ? b.message : M.theInstanceIsNotServingRequests };
  if (status === 429) return { ok: false, status, code: "rate_limited", message: typeof b.message === "string" ? b.message : M.requestLimitExceeded, retryAfter: retryAfterOf(retryAfterHeader, b.retry_after) };
  if (status >= 400) {
    const retryAfter = retryAfterOf(retryAfterHeader, b.retry_after);
    return { ok: false, status, code: typeof b.code === "string" ? b.code : `http_${status}`, message: typeof b.message === "string" ? b.message : M.gatewayReturnedHttpError(status),
      ...(retryAfter !== undefined ? { retryAfter } : {}), ...(b.details && typeof b.details === "object" ? { details: b.details } : {}) };
  }
  if (b.error && typeof b.error === "object") {
    const e = b.error as { code?: number; message?: string };
    return { ok: false, status, code: RPC_CODES[e.code ?? 0] ?? `rpc_${e.code ?? "unknown"}`, message: e.message ?? M.mcpProtocolError };
  }
  const result = b.result as Record<string, any> | undefined;
  if (!result || typeof result !== "object") return { ok: false, status, code: "bad_response", message: M.gatewayResponseIsMissingResult };
  const text = Array.isArray(result.content) ? result.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n") : "";
  if (result.isError) {
    const s = (result.structuredContent ?? {}) as Record<string, any>;
    const [codeFromText, ...rest] = text.split(": ");
    const code = typeof s.code === "string" ? s.code : (codeFromText && /^[a-z_]+$/.test(codeFromText) ? codeFromText : "tool_error");
    const message = typeof s.message === "string" ? s.message : rest.join(": ") || text || M.toolReturnedAnError;
    return { ok: false, status, code, message, hint: typeof s.hint === "string" ? s.hint : undefined, retryAfter: typeof s.retry_after === "number" ? s.retry_after : undefined, details: s.details };
  }
  return { ok: true, data: (result.structuredContent ?? {}) as T, text };
}

function retryAfterOf(header: string | null | undefined, fromBody: unknown): number | undefined {
  const h = header ? Number(header) : Number.NaN;
  if (Number.isFinite(h) && h >= 0) return h;
  return typeof fromBody === "number" ? fromBody : undefined;
}

export function archivedOf(details: unknown): { space: string; since: string | null } | null {
  const a = (details as { archived?: { space?: unknown; since?: unknown } } | null | undefined)?.archived;
  if (!a || typeof a !== "object" || typeof a.space !== "string") return null;
  return { space: a.space, since: typeof a.since === "string" && /^\d{4}-\d{2}-\d{2}/.test(a.since) ? a.since.slice(0, 10) : null };
}

export function derivedDenial(details: unknown): { reason: string; confirm: boolean } | null {
  const d = details as { gate?: unknown; reason?: unknown; confirm?: unknown } | null | undefined;
  return d?.gate === "derivation" && typeof d.reason === "string" ? { reason: d.reason, confirm: d.confirm === "wider" } : null;
}

export function archivedMessage(a: { since: string | null }): string {
  const day = a.since ? M.since(formatDay(a.since)) : "";
  return M.thisSpaceIsArchivedItIs(day);
}

export const isOverloaded = (details: unknown): boolean => (details as { reason?: unknown } | null | undefined)?.reason === "overloaded";
export const overloadedMessage = (retryAfter?: number): string =>
  M.memoryIsBusyWithTooMany(retryAfter !== undefined ? M.s(Math.max(1, Math.ceil(retryAfter))) : M.aFewSeconds);

export const ERROR_PLAIN = derived(() => ({
  sessionEnded: `${SESSION_PLAIN.ended}.`,
  failClosed: M.memoryIsUnavailableTryAgainIn,
  rateLimited: (retryAfter?: number): string =>
    M.tooFrequent(retryAfter !== undefined ? M.waitSAndTryAgain(Math.max(1, Math.ceil(retryAfter))) : M.waitAMomentAndTryAgain),
  closed: M.thisIsAClosedRecordOnly,
  notFound: M.theRecordSectionOrSpaceWas,
  unreachable: M.memoryIsNotRespondingTryAgain,
  responseLost: M.theConnectionToMemoryWasInterrupted,
  responseLostRemember: M.theConnectionToMemoryWasInterrupted2,
  forbidden: M.thisActionIsUnavailableToYou,
  invalid: M.checkTheInformationYouEntered,
  failed: M.memoryReturnedAnErrorTryAgain,
} as const));

const TECHNICAL = /^(?:http_\d{3}|rpc_[\w-]+|bad_response|bad_request|internal|unknown_tool)$/;
export const technicalCode = (code: string): boolean => TECHNICAL.test(code);

export function toolErrorMessage(fail: Pick<McpFail, "code" | "message" | "retryAfter" | "hint" | "details">): string {
  switch (fail.code) {
    case "unauthorized": return ERROR_PLAIN.sessionEnded;
    case "fail_closed": return ERROR_PLAIN.failClosed;
    case "rate_limited": return ERROR_PLAIN.rateLimited(fail.retryAfter);
    case "class_denied": {
      const a = archivedOf(fail.details);
      if (a) return archivedMessage(a);
      if (derivedDenial(fail.details)) return DERIVED_PLAIN.refused;
      return ERROR_PLAIN.closed;
    }
    case "not_found": return ERROR_PLAIN.notFound;
    case "never_open": return M.cannotShowToAgents(fail.message);
    case "open_check": return fail.message || M.theRecordWasNotAcceptedAs;
    case "too_large": return M.tooMuchData(fail.message);
    case "in_progress": return isOverloaded(fail.details) ? overloadedMessage(fail.retryAfter) : M.theOperationIsStillRunning(fail.message);
    case "gateway_unreachable": return ERROR_PLAIN.unreachable;
    case "response_lost": return ERROR_PLAIN.responseLost;
    case "forbidden": return fail.message || ERROR_PLAIN.forbidden;
    case "invalid_argument": return fail.message || ERROR_PLAIN.invalid;
    default: return TECHNICAL.test(fail.code) || !fail.message ? ERROR_PLAIN.failed : fail.message;
  }
}

export function acceptedFormats(fail: McpFail): string[] {
  const d = fail.details as { accepted?: unknown } | undefined;
  return Array.isArray(d?.accepted) ? d!.accepted.map(String) : [];
}
