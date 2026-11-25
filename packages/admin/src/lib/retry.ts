import { productName } from "../i18n/brand";
import { retry, unavailable } from "../messages/retry";

export const AUTO_RETRIES = 3;
export const DEFAULT_WAIT_S = 5;

export function pauseFor(seconds: number | null | undefined, attempt: number): number {
  const base = seconds !== null && seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_WAIT_S;
  return base + 5 * Math.max(0, attempt);
}

export interface RetryState { phase: "counting" | "refreshing" | "manual"; left: number; attempt: number; auto: boolean }
export type RetryEvent = { type: "tick" } | { type: "refreshed"; seconds: number | null } | { type: "click" };

export const retryStart = (seconds: number | null, auto: boolean, attempt = 0): RetryState =>
  auto && attempt < AUTO_RETRIES ? { phase: "counting", left: pauseFor(seconds, attempt), attempt, auto } : { phase: "manual", left: 0, attempt, auto };

export function retryStep(s: RetryState, e: RetryEvent): RetryState {
  switch (e.type) {
    case "tick":
      if (s.phase !== "counting") return s;
      return s.left > 1 ? { ...s, left: s.left - 1 } : { ...s, phase: "refreshing", left: 0, attempt: s.attempt + 1 };
    case "refreshed":
      if (s.phase !== "refreshing") return s;
      return s.auto && s.attempt < AUTO_RETRIES ? { ...s, phase: "counting", left: pauseFor(e.seconds, s.attempt) } : { ...s, phase: "manual", left: 0 };
    case "click":
      return s.phase === "refreshing" ? s : { ...s, phase: "refreshing", left: 0 };
  }
}

export const REFRESH_DEDUPE_MS = 2_000;

export function claimRefresh(slot: { at: number }, now = Date.now()): boolean {
  if (now - slot.at < REFRESH_DEDUPE_MS) return false;
  slot.at = now;
  return true;
}

export type CarryMap = Map<string, { attempt: number; at: number }>;
export const CARRY_MS = 30_000;
export const CARRY_RELEASE_MS = 1_000;

export function carriedAttempt(map: CarryMap, key: string | undefined, now = Date.now()): number {
  const c = key ? map.get(key) : undefined;
  return c && now - c.at < CARRY_MS ? c.attempt : 0;
}

export function releaseCarry(map: CarryMap, key: string, schedule: (run: () => void, ms: number) => unknown = setTimeout): void {
  const carry = map.get(key);
  if (!carry) return;
  schedule(() => { if (map.get(key) === carry) map.delete(key); }, CARRY_RELEASE_MS);
}

export function retryText(s: RetryState, limited: boolean): string {
  if (s.phase === "counting") {
    if (limited && s.attempt === 0) return retry.requested(productName(), s.left);
    return limited ? retry.again(s.left) : retry.repeat(s.left);
  }
  if (s.phase === "refreshing") return retry.refreshing;
  // Only retries already attempted justify saying the service is still busy.
  return limited ? retry.busy(productName(), s.attempt > 0) : retry.manual;
}

const DIGEST = "memory-unavailable";

export const unavailableDigest = (code: string, retryAfter?: number): string =>
  `${DIGEST}:${/^[a-z_]{1,40}$/.test(code) ? code : "unknown"}:${retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter) : ""}`;

export function parseUnavailable(digest: string | undefined | null): { code: string; retryAfter: number | null } | null {
  const m = /^memory-unavailable:([a-z_]{1,40}):(\d*)$/.exec(digest ?? "");
  return m ? { code: m[1]!, retryAfter: m[2] ? Number(m[2]) : null } : null;
}

export function unavailableText(code: string): string {
  switch (code) {
    case "rate_limited": return unavailable.limited(productName());
    case "gateway_unreachable": return unavailable.unreachable(productName());
    case "fail_closed": return unavailable.setup(productName());
    default: return unavailable.other(productName());
  }
}

export const retryable = (code: string, status?: number): boolean =>
  code === "rate_limited" || code === "gateway_unreachable" || (code !== "fail_closed" && status !== undefined && status >= 500);
