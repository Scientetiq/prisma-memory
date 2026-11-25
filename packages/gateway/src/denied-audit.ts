// Audit trace of refused control actions: an agent that manages a foreign or nonexistent space, plan or record,
// or applies its own expired, cancelled or workplace-only plan, gets the same answer as before — and the log gets one
// `admin` event `{op: "control_denied", tool, denied}`. The event never names what the caller may not see: no slug, name
// or id of a foreign space, no foreign plan id, not the reference the agent typed. A plan id goes into the event only when
// the plan belongs to the caller. A not_found on the external agent address leaves no trace (there it is the
// plain answer of a missing object, and the log must not become a probe counter for the outside); the external caller's
// refusals over its own plans (expired, cancelled, workplace-only) are written as for any other caller.
// Throttle: one event per key and action per minute, kept in this process in a map bounded to DENIED_MAX_KEYS keys (the
// oldest are dropped first) — a flood of distinct keys cannot grow memory. With two gateway processes the limit holds per
// process.
import { MemoryError } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { isExternal } from "./channel.ts";

/** human_confirmation_required: an agent asked for what only a person in the workplace does. */
export type DeniedReason = "not_found" | "plan_expired" | "plan_cancelled" | "workplace_only" | "human_confirmation_required";
export const DENIED_WINDOW_MS = 60_000;
export const DENIED_MAX_KEYS = 10_000;

/** One pass per key within the window; the map never holds more than `maxKeys` keys (insertion order = age). */
export class DeniedThrottle {
  private readonly last = new Map<string, number>();
  constructor(readonly windowMs = DENIED_WINDOW_MS, readonly maxKeys = DENIED_MAX_KEYS) {}
  allow(key: string, now = Date.now()): boolean {
    const at = this.last.get(key);
    // a backward clock step (now < at) opens a new window instead of silencing the key until the clock catches up
    if (at !== undefined && now >= at && now - at < this.windowMs) return false;
    this.last.delete(key);
    this.last.set(key, now);
    while (this.last.size > this.maxKeys) this.last.delete(this.last.keys().next().value as string);
    return true;
  }
  get size(): number { return this.last.size; }
  clear(): void { this.last.clear(); }
}

/** The process-wide throttle of refusal events. */
export const deniedThrottle = new DeniedThrottle();

/** Which refusal the error is, or null when it is not one this trace records (rights of a person, arguments, limits). */
export function deniedReasonOf(e: unknown): DeniedReason | null {
  if (!(e instanceof MemoryError)) return null;
  if (e.code === "not_found") return "not_found";
  const reason = (e.extra.details as { reason?: unknown } | undefined)?.reason;
  return reason === "plan_expired" || reason === "plan_cancelled" || reason === "workplace_only" || reason === "human_confirmation_required" ? reason : null;
}

/** The caller as the throttle sees it: its key (or workplace session), otherwise its principal. */
const keyOf = (caller: Caller): string => caller.keyId ?? caller.service?.id ?? caller.person?.id ?? "anonymous";

/**
 * Claims the throttle slot of this key and action. False — nothing is written: a not_found on the external address
 * by design), or a refusal of the same key and action within the last minute. The external caller's other refusals — its
 * own expired, cancelled or workplace-only plan — name nothing foreign and are written like everyone's.
 */
export function deniedSlot(app: Pick<App, "instanceId">, caller: Caller, tool: string, now = Date.now(), denied: DeniedReason = "not_found"): boolean {
  if (denied === "not_found" && isExternal(caller)) return false;
  return deniedThrottle.allow(`${app.instanceId}\u0000${keyOf(caller)}\u0000${tool}`, now);
}

/** A plan id is named only when the plan is the caller's own (a foreign or missing plan stays unnamed). */
async function ownPlan(app: App, caller: Caller, planId: unknown): Promise<string | null> {
  if (typeof planId !== "string" || !caller.person || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId)) return null;
  const r = await app.db.control.query("SELECT 1 FROM action_plans WHERE id = $1 AND person_id = $2 AND instance_id = $3", [planId, caller.person.id, app.instanceId]);
  return r.rowCount ? planId : null;
}

/** Writes the refusal event (non-strict: a failed write is logged by audit() and never changes the answer). */
export async function noteDenied(app: App, caller: Caller, a: { tool: string; denied: DeniedReason; planId?: unknown }, now = Date.now()): Promise<void> {
  if (!deniedSlot(app, caller, a.tool, now, a.denied)) return;
  const plan = a.planId === undefined ? null : await ownPlan(app, caller, a.planId).catch(() => null);
  await audit(app, caller, { event_type: "admin", details: { op: "control_denied", tool: a.tool, denied: a.denied, ...(plan ? { plan_id: plan } : {}) } });
}

/**
 * Runs a control action; a refusal it throws (deniedReasonOf) leaves one event and is rethrown unchanged — the answer to
 * the caller is byte-for-byte the former one. `planId` — the plan the action was asked about (memory_apply).
 */
export async function traceDenied<T>(app: App, caller: Caller, tool: string, fn: () => Promise<T>, o: { planId?: unknown } = {}): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const denied = deniedReasonOf(e);
    if (denied) await noteDenied(app, caller, { tool, denied, ...(o.planId !== undefined ? { planId: o.planId } : {}) }).catch(() => undefined);
    throw e;
  }
}
