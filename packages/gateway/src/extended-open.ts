// Extended access and open: an agent that reads a person's closed records does not write into
// open until the administrator allows it in the key settings; such writes are marked and logged.
// One gate on all paths of writing into open — creating a record (admitRecord), placing the same file, moving an open
// record (promote), correcting an open record and the replaced link over it (admitCorrection), the description of a new
// space (memory_space_create). The order everywhere: the write right → class → gate → the open check.
import { MemoryError, type DataClass } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { gateOf } from "./visibility.ts";
import { workplaceWhere } from "./workplace.ts";

/** Writing into open by this caller: allowed — as usual; denied — not allowed; marked — allowed, with a mark and a log. */
export type OpenWriteMode = "allowed" | "denied" | "marked";
/** What exactly was attempted in open (details.attempt of a refusal, a report item). */
export const EXTENDED_ATTEMPTS = ["remember", "upload", "placement", "promote", "correct", "link", "space_meta"] as const;
export type ExtendedAttempt = typeof EXTENDED_ATTEMPTS[number];
/** Actions after which the mark goes into the record itself: only new content. */
export const MARKED_OPS = ["remember", "upload", "correct"] as const;
export type MarkedOp = typeof MARKED_OPS[number];
/** The mark of an allowed write: what was done and when. No key — it is in the log. */
export interface ExtendedMark { op: ExtendedAttempt; at: string }

/**
 * The gate criterion is capability, not key kind: a person's key (not a workplace session, not a service
 * and not system) for which the builder's class gate opens closed records. Today that is the extended key (personal T2 and
 * an OAuth connection read no closed records); a future connection with extended access falls here by itself. A session
 * is a person in the workplace; a T0 service on behalf is not a person's agent: both write into open as before.
 */
export function readsClosedAgent(c: Pick<Caller, "principalType" | "keyKind" | "scope">): boolean {
  return c.principalType === "person" && c.keyKind !== "session" && gateOf(c).closed !== "none";
}

/** The mode of writing into open (memory_me.key.open_write_mode); the flag is read only for a caller under the gate. */
export function openWriteMode(c: Pick<Caller, "principalType" | "keyKind" | "scope" | "openWrite">): OpenWriteMode {
  if (!readsClosedAgent(c)) return "allowed";
  return c.openWrite === true ? "marked" : "denied";
}

const WHY = "this key has extended access and can read a person’s closed records. Agents with extended access can only write to open spaces if the memory administrator enables it in the key settings";
const HINT_ME = "Write to your personal space (space: me). Only the memory administrator can let this key write to open spaces";
const HINT_HUMAN = "Tell the person. The memory administrator can grant permission";

/** The refusal text for the agent: no record content; what can be done instead — by the attempt kind. */
function refusal(app: App, a: { attempt: ExtendedAttempt; slug: string | null; recordId?: string }): { message: string; hint: string } {
  const where = a.slug ? `the space ${a.slug}` : "the open space";
  const fix = a.recordId ? workplaceWhere(app, `/records/${a.recordId}`, "Record") : workplaceWhere(app, "/", "Home");
  switch (a.attempt) {
    case "remember": case "upload":
      return { message: `This key cannot write open records to ${where}: ${WHY}. Write to your personal space (space: me), which is closed, or tell a person the record was not saved in ${a.slug ?? "this space"}`, hint: HINT_ME };
    case "placement":
      return { message: `The file is already in memory, but this key cannot place it as an open record in ${where}: ${WHY}. Tell a person so they can place the file themselves`, hint: HINT_HUMAN };
    case "promote":
      return { message: `This key cannot move an open record to ${a.slug ?? "another space"}: ${WHY}. A person can move it. The key can still move closed records as usual`, hint: HINT_HUMAN };
    case "correct":
      return { message: `This key cannot correct an open record: ${WHY}. A person can correct it in the workspace: ${fix}`, hint: HINT_HUMAN };
    case "link":
      return { message: `This key cannot add a “replaced” link to an open record: ${WHY}. A person can add it in the workspace: ${fix}`, hint: HINT_HUMAN };
    case "space_meta":
      return { message: `This key cannot set the space description because agents for all members can see it and ${WHY}. Create the space without a description. A person can add it in the workspace`, hint: "A person can set the description in the workspace" };
  }
}

/**
 * The gate of writing into open. allowed — null (nothing changes); denied — a log event `write` of class open with
 * `op: extended_open_denied`, the attempt and transport (no text) and `class_denied` 403 with `details.gate: extended_open`;
 * marked — the mark `{op, at}`: the caller puts it into the record (only remember/upload/correct) and `extended_open: true` into
 * its event. Call it after the write right and class checks and before the open check: the open_check refusal and its event
 * only reach one who may write the record at all.
 */
export async function extendedOpenGate(app: App, caller: Caller, a: { attempt: ExtendedAttempt; space: { id: string | null; slug: string | null }; recordId?: string })
  : Promise<ExtendedMark | null> {
  const mode = openWriteMode(caller);
  if (mode === "allowed") return null;
  if (mode === "marked") return { op: a.attempt, at: new Date().toISOString() };
  await audit(app, caller, { event_type: "write", class: "open", record_ids: a.recordId ? [a.recordId] : [], space_id: a.space.id,
                             details: { op: "extended_open_denied", attempt: a.attempt, via: caller.transport ?? "mcp" } });
  const { message, hint } = refusal(app, { attempt: a.attempt, slug: a.space.slug, recordId: a.recordId });
  throw new MemoryError("class_denied", message, { hint, details: { gate: "extended_open", attempt: a.attempt, space: a.space.slug } });
}

/** A gate refusal among errors (applying turns it into a skip `extended_open`, not failed). */
export const isExtendedOpenDenial = (e: unknown): boolean =>
  e instanceof MemoryError && e.code === "class_denied" && (e.extra.details as Record<string, unknown> | undefined)?.gate === "extended_open";

// ---------------------------------------------------------------- the mark

const isMarkedOp = (op: unknown): op is MarkedOp => (MARKED_OPS as readonly unknown[]).includes(op);

/**
 * The mark in attrs of a new record: only new content (remember, upload, correct) — a placement, a move and a space
 * description do not change the record, they get only the log. Set once at record creation and not inherited: a new
 * version of an event (a correction) drops the previous mark and sets its own only if an agent with permission made it.
 */
export const markAttrs = (m: ExtendedMark | null | undefined): { extended_write?: ExtendedMark } =>
  m && isMarkedOp(m.op) ? { extended_write: { op: m.op, at: m.at } } : {};

/** Log event fields of an allowed write: the administrator's report counts them, My actions shows a badge. */
export const markEvent = (m: ExtendedMark | null | undefined): { extended_open?: true; extended_op?: ExtendedAttempt } =>
  m ? { extended_open: true, extended_op: m.op } : {};

/**
 * An extended-access agent's proposal is confirmed by a person — the result is marked as if
 * the agent had corrected it (it passed the gate with permission when proposing: no permission, no proposal). The sign is the
 * proposal's key kind; a session, a personal key and a connection give no mark. A connection with extended access must
 * keep the same snapshot at the proposal — otherwise its corrections lose the mark after confirmation. `cls` — the class
 * the result goes into: only an open one gets the mark. Shared by confirm (corrections.ts) and applying
 * a proposal to the how-we-work map (space-guide.ts): a module without an import cycle.
 */
export async function proposalExtendedMark(app: App, p: { cls: DataClass; keyId: string | null; link: boolean }): Promise<ExtendedMark | null> {
  if (p.cls !== "open" || !p.keyId) return null;
  const k = (await app.db.control.query("SELECT kind FROM api_keys WHERE id = $1", [p.keyId])).rows[0];
  return k?.kind === "extended" ? { op: p.link ? "link" : "correct", at: new Date().toISOString() } : null;
}

/** The record mark from attrs for the answer (memory_read, Hit): only `{op, at}` with a known action; otherwise null. */
export function extendedWriteView(attrs: Record<string, unknown> | null | undefined): ExtendedMark | null {
  const x = attrs?.extended_write as Record<string, unknown> | undefined;
  if (!x || typeof x !== "object" || Array.isArray(x) || !isMarkedOp(x.op) || typeof x.at !== "string" || !x.at) return null;
  return { op: x.op, at: x.at };
}

/** The tail of the text answer to the agent: the write was made with the administrator's permission, marked and logged. */
export const MARKED_TAIL = " · saved with extended access: the record is marked and the action is in the audit log";
/** The tail of the answer about an action without a mark in the record (placement, move, space description): only the log. */
export const JOURNAL_TAIL = " · used extended access: the action is in the audit log";

/** The key mode in one phrase — the tail of the memory_me text; allowed — nothing (the old answer). */
export function openWriteLine(mode: OpenWriteMode): string {
  if (mode === "denied") return " · cannot write to open spaces without permission from the memory administrator";
  if (mode === "marked") return " · writes to open spaces are marked (the memory administrator allowed them)";
  return "";
}
