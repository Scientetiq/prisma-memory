import { connectedKinds, isLiveKey, type Connected } from "./connect-agents";
import type { MeResult } from "./me-api";
import type { OAuthConnectionsPage } from "./oauth-connect";
import type { MyKey, MyKeysPage } from "./types";

export type AgentState = "connected" | "not_connected" | "unknown";

export interface AgentFailure { code: string; message: string; status: number; retryAfter?: number }

export interface AgentStatus {
  state: AgentState;
  connected: Connected[];
  liveKeys: MyKey[];
  failure: AgentFailure | null;
}

type Source<T> = MeResult<T> | null | undefined;

export function failureOf(r: Source<unknown>): AgentFailure | null {
  return r && !r.ok ? { code: r.code, message: r.message, status: r.status, ...(r.retryAfter !== undefined ? { retryAfter: r.retryAfter } : {}) } : null;
}

export function agentStatus(keys: Source<MyKeysPage>, conns: Source<OAuthConnectionsPage>, now = Date.now()): AgentStatus {
  const liveKeys = keys?.ok ? keys.data.items.filter((k) => isLiveKey(k, now)) : [];
  const liveConnections = conns?.ok ? conns.data.items.filter((c) => !(Date.parse(c.expires_at) <= now)) : [];
  const connected = connectedKinds(liveKeys, liveConnections, now);
  const failed = failureOf(keys) ?? failureOf(conns);
  const state: AgentState = connected.length ? "connected" : failed ? "unknown" : "not_connected";
  return { state, connected, liveKeys, failure: state === "unknown" ? failed : null };
}

export { AGENT_UNKNOWN } from "../messages/agent-status";
