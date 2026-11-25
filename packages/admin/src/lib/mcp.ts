import { text as M } from "../messages/mcp";
import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { parseBody, parseToolResponse, toolCallRequest, type McpResult } from "./mcp-parse";
import { invalidateNav, toolChanges } from "./nav-cache";
import { gatewayBase, gatewayFetch } from "./gateway-transport";

let seq = 0;

export type { McpResult, McpFail } from "./mcp-parse";
export { toolErrorMessage, acceptedFormats } from "./mcp-parse";

export async function callTool<T = Record<string, unknown>>(key: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<McpResult<T>> {
  await connection();
  const { body, headers } = toolCallRequest(name, args, ++seq);
  let res: Response;
  try {
    res = await gatewayFetch(gatewayBase("workplace"), "/mcp", { method: "POST", headers: { ...headers, Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, status: 502, code: "gateway_unreachable", message: M.gatewayIsNotResponding };
  } finally {
    if (toolChanges(name)) invalidateNav(key);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, status: 502, code: "response_lost", message: M.theMemoryResponseWasInterruptedDuring };
  }
  return parseToolResponse<T>(res.status, parseBody(text, res.headers.get("content-type")), res.headers.get("retry-after"));
}
