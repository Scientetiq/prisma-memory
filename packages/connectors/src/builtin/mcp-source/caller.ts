// The wire call of the `mcp_source` kind: one stateless MCP `tools/call` request (JSON-RPC over HTTP POST, the
// "stateless" mode of the MCP HTTP transport), sent only through the egress client of the connector context and only to
// the configured URL exactly. Of the answer only `result.structuredContent` is read: never `tools/list`, never the text
// `content[]`, a tool `description` or `_meta` — a hostile server's words never reach a log, an attribute or a prompt.
// Failures are ConnectorError codes; HTTP bodies and vendor messages are never read into them.
import { ConnectorError, vendorError } from "../../sdk/errors.ts";
import { markCore } from "../../failure.ts";
import type { ConnectorCtx } from "../../sdk/types.ts";

/** MCP protocol revision the call announces. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
/** Longest answer of one call. */
export const MCP_CALL_MAX_BYTES = 1_048_576;
/** Time of one call: DNS, connection and body. */
export const MCP_CALL_TIMEOUT_MS = 20_000;

/** How the request authenticates: nothing, `Authorization: Bearer <token>`, or the token in a named header. */
export interface McpAuth {
  type: "none" | "bearer" | "header";
  header?: string;
}

/** Calls one tool of an MCP server; answers the tool's structured content. */
export interface McpToolCaller {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/** The part of a connector context the caller uses. */
export type McpCallerCtx = Pick<ConnectorCtx<{ url: string; auth?: McpAuth }>, "config" | "http" | "secret" | "signal">;

/** The value of the `mcp-name` header: RFC 2047 base64 form, so any tool name fits a header. */
const encodedName = (tool: string): string => `=?base64?${Buffer.from(tool, "utf8").toString("base64")}?=`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A failure of this connector's own branch — a missing token, an invalid auth mode, a stopped run, a redirect it never
 * follows: marked inside the package, so the runner keeps the code (a missing secret stops the connector at once).
 */
const ownFailure = (code: "secret_missing" | "config_invalid" | "aborted" | "egress_blocked:redirect"): ConnectorError =>
  markCore(new ConnectorError(code), code);

const VENDOR_ANSWER = new WeakSet<object>();
/** A failure read from the vendor's answer (its shape, a tool error): its code stays for lookups; the runner stores vendor_refused. */
export function vendorAnswerError(code: "bad_response" | "tool_error"): ConnectorError {
  const e = new ConnectorError(code);
  VENDOR_ANSWER.add(e);
  return e;
}
/** True for an error vendorAnswerError() built (by identity, nothing of the object is read). */
export const isVendorAnswerError = (e: unknown): boolean => typeof e === "object" && e !== null && VENDOR_ANSWER.has(e);

/** Authentication headers of the configured mode; a mode that needs the token while it is not set is secret_missing. */
function authHeaders(ctx: McpCallerCtx): Record<string, string> {
  const auth = ctx.config.auth ?? { type: "none" };
  if (auth.type === "none") return {};
  const token = ctx.secret("token");
  if (token === null || token === "") throw ownFailure("secret_missing");
  if (auth.type === "bearer") return { authorization: `Bearer ${token}` };
  if (typeof auth.header !== "string" || auth.header === "") throw ownFailure("config_invalid");
  return { [auth.header]: token };
}

export function httpToolCaller(ctx: McpCallerCtx): McpToolCaller {
  return {
    async call(tool, args) {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": encodedName(tool),
        ...authHeaders(ctx),
      };
      const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: tool, arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "memory-workers", version: "0.1.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
      if (ctx.signal.aborted) throw ownFailure("aborted");
      const res = await ctx.http.request({ method: "POST", url: ctx.config.url, headers, body, maxBytes: MCP_CALL_MAX_BYTES, timeoutMs: MCP_CALL_TIMEOUT_MS });
      // a redirect is never followed: the answer of another address is not the configured server's
      if (res.status >= 300 && res.status < 400) throw ownFailure("egress_blocked:redirect");
      const refused = vendorError(res, new Date());
      if (refused) throw refused;
      if (res.status < 200 || res.status >= 300) throw new ConnectorError("vendor_refused");
      let json: unknown;
      try { json = res.json(); } catch { throw vendorAnswerError("bad_response"); }
      if (!isObject(json)) throw vendorAnswerError("bad_response");
      if (json.error !== undefined && json.error !== null) throw vendorAnswerError("tool_error");
      const result = json.result;
      if (!isObject(result)) throw vendorAnswerError("bad_response");
      if (result.isError === true) throw vendorAnswerError("tool_error");
      return result.structuredContent;
    },
  };
}
