// Show outside again, and the outside block in the record card.
// Sticky narrowing: a record once removed from the edge because of a close, hide, delete, people-only or
// restore from a copy does not return there by itself, even if the close failed. A finished move into
// open can return it, or the person by this button. Both routes are only a person's workplace session: an agent key and a service
// get 403, and so does the panel's view-as (requireHuman).
//
// POST /api/v1/records/:id/edge-show — clears the reasons a person clears (edge_hold_release: the database function also checks
// the right) and puts the record into publication; it reaches the edge only past the gate. Descendants (attachments,
// meeting fragments) held for the same reasons are released with it — the database function checks the right for each;
// a descendant with a different reason of its own stays held. The log event is edge_event with the code hold_released
// (contracts/edge/audit-codes.json): the record id, the reason codes and the number of released descendants, no content.
// GET /api/v1/records/:id/edge-status — the record's edge state as a code word: the panel turns it into plain words.
// Dark launch: until export has ever been on, the answer is the same, with no query to the record and no limit count.
import type { Context, Hono } from "hono";
import { log, MemoryError, notFound } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { canWrite, loadReadable, locate, readableSpaces, type SpaceAccess } from "./access.ts";
import { audit } from "./audit.ts";
import { isUuidParam } from "./paging.ts";
import { requireHuman } from "./workplace.ts";

/** Reasons a person clears: the others are cleared by a move into open, curators, the administrator. */
export const RELEASABLE = ["audience_people", "close_requested", "deleted", "hidden", "restore_tomb"] as const;
export type Releasable = (typeof RELEASABLE)[number];
const isReleasable = (r: string): r is Releasable => (RELEASABLE as readonly string[]).includes(r);

export type EdgeRecordState = "shown" | "held" | "close_confirmed" | "close_failed" | "not_shown" | "revoked";

/** Slack for the commit delay of the revoke transaction and the gap between the queue count and the exporter's state write. */
export const CONFIRM_MARGIN_MS = 10_000;
/** Export not yet on is rechecked no more often (turning on is once and for all: on is remembered until a restart). */
export const SEEN_RECHECK_MS = 30_000;

export interface EdgeStateInput {
  exportEnabled: boolean;
  /** Hold reason codes of the record (edge_hold). */
  reasons: readonly string[];
  /** The generation the bridge confirmed (edge_state.exported_gen); null — never on the edge. */
  exportedGen: bigint | null;
  /** The tombstone — the generation of the last revoke (edge_state.tomb_gen). */
  tombGen: bigint | null;
  cls: "open" | "closed";
  /** The state of the record's last move into closed (class_moves.status); null — no move. */
  closeMove: string | null;
  /** Everything put into revoke before this minute (ms) is confirmed by the edge; null — unknown. */
  confirmedBeforeMs: number | null;
}

/**
 * The record's edge state. Generations are close to epoch microseconds and not below the mark time (edge_next_gen), so
 * a tombstone set before the confirmation point is surely confirmed by the edge (a careful estimate: not yet confirmed
 * rather than a false confirmed).
 */
export function edgeRecordState(x: EdgeStateInput): EdgeRecordState {
  const tombMs = x.tombGen === null ? null : Number(x.tombGen / 1000n);
  const revokeConfirmed = tombMs !== null && x.confirmedBeforeMs !== null && tombMs < x.confirmedBeforeMs;
  if (x.reasons.includes("close_requested")) {
    // the close failed: the record stayed open inside, but it is absent outside until a person acts
    if (x.cls === "open" && x.closeMove === "failed") return "close_failed";
    return revokeConfirmed ? "close_confirmed" : "held";
  }
  if (x.reasons.length) return "held";
  if (!x.exportEnabled) return "not_shown";
  if (x.exportedGen !== null && x.exportedGen > (x.tombGen ?? 0n)) return "shown";
  if (x.exportedGen !== null && x.tombGen !== null) return "revoked";
  return "not_shown";
}

/** The GET /edge-status answer (contracts/openapi-ingest.yaml, getRecordEdgeStatus). */
export interface EdgeStatusView {
  export_seen: boolean;
  export_enabled: boolean;
  state: EdgeRecordState;
  reasons: string[];
  releasable: Releasable[];
  can_release: boolean;
}

type Row = Record<string, any>;
/**
 * The hold reason code for the answer: a bait marker the reconciler found (edge_canary_hold — reason manual, source canary_trip)
 * is given as its own code canary_trip, not manual (held by the administrator): the panel words it its own way
 * (EDGE_REASON_TEXT.canary_trip). A manual hold by the administrator is still manual.
 */
export const holdReason = (r: { reason: string; source?: string | null }): string =>
  r.reason === "manual" && r.source === "canary_trip" ? "canary_trip" : r.reason;
const big =(v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
/** No export tables (schema 10 not applied): export was never on. */
const missingRelation = (e: unknown): boolean => (e as { code?: string })?.code === "42P01";

/** The right to clear a hold — as in edge_hold_release: the record owner or a member with the write right in its space. */
const mayRelease = (caller: Caller, owner: string, space: SpaceAccess | undefined): boolean =>
  !!caller.person && (owner === caller.person.id || (!!space && canWrite(space)));

/** Whether export was ever on (queues): yes is remembered, no is rechecked once per SEEN_RECHECK_MS. */
const seenCache = new WeakMap<App, { seen: boolean; at: number }>();
export async function exportSeen(app: App, now = Date.now()): Promise<boolean> {
  const c = seenCache.get(app);
  if (c && (c.seen || now - c.at < SEEN_RECHECK_MS)) return c.seen;
  let seen = false;
  try {
    const q = (await app.db.control.query("SELECT enabled, revoke_enabled FROM edge_outbox_control_state WHERE one")).rows[0] as Row | undefined;
    seen = !!(q?.enabled || q?.revoke_enabled);
  } catch (e) {
    if (!missingRelation(e)) throw e;
  }
  seenCache.set(app, { seen, at: now });
  return seen;
}

/**
 * The revoke confirmation point: everything put into revoke earlier (status_at − revoke_age_ms − slack) is confirmed by the edge.
 * status_at — when the exporter itself measured the queue (last_result): the reconciler's mark (updated_at) does not move it.
 */
export function confirmedBefore(st: Row | undefined): number | null {
  const at = typeof st?.last_result?.status_at === "string" ? Date.parse(st.last_result.status_at) : NaN;
  if (!Number.isFinite(at)) return null;
  return at - Math.max(0, Number(st?.revoke_age_ms ?? 0) || 0) - CONFIRM_MARGIN_MS;
}

/** Export is on and the switch is not pulled; the revoke confirmation point. */
async function exportState(app: App): Promise<{ enabled: boolean; confirmedBeforeMs: number | null }> {
  const setting = app.settings.get<boolean>("edge.export_enabled", false) === true;
  try {
    const st = (await app.db.control.query("SELECT killed_at, revoke_age_ms, last_result FROM edge_export_status WHERE one")).rows[0] as Row | undefined;
    return { enabled: setting && !st?.killed_at, confirmedBeforeMs: confirmedBefore(st) };
  } catch (e) {
    if (missingRelation(e)) return { enabled: false, confirmedBeforeMs: null };
    throw e;
  }
}

const UNSEEN: EdgeStatusView = { export_seen: false, export_enabled: false, state: "not_shown", reasons: [], releasable: [], can_release: false };

/** The record state for the outside block: only for one who reads the record (otherwise 404, as for reading). */
export async function edgeStatus(app: App, caller: Caller, id: string): Promise<EdgeStatusView> {
  const { rec, spaces } = await loadReadable(app, caller, id);
  const ex = await exportState(app);
  const ctl = app.db.control;
  const reasons = ((await ctl.query("SELECT reason, source FROM edge_hold WHERE record_id = $1", [id])).rows as Row[])
    .map((r) => holdReason({ reason: r.reason as string, source: r.source as string })).sort();
  const st = (await ctl.query("SELECT exported_gen::text AS exported_gen, tomb_gen::text AS tomb_gen FROM edge_state WHERE kind = 'record' AND id = $1", [id])).rows[0] as Row | undefined;
  const loc = await locate(app, id);
  const cls = (loc?.class ?? rec.class) as "open" | "closed";
  const closeMove = reasons.includes("close_requested")
    ? ((await ctl.query("SELECT status FROM class_moves WHERE record_id = $1 AND to_class = 'closed' ORDER BY requested_at DESC, id DESC LIMIT 1", [id])).rows[0]?.status as string | undefined) ?? null
    : null;
  const state = edgeRecordState({ exportEnabled: ex.enabled, reasons, exportedGen: big(st?.exported_gen), tombGen: big(st?.tomb_gen), cls, closeMove,
                                  confirmedBeforeMs: ex.confirmedBeforeMs });
  const releasable = reasons.filter(isReleasable);
  // for a closed record the button is no use: only open records go to the edge, and on opening the move itself clears the reason
  const can = cls === "open" && releasable.length > 0 && mayRelease(caller, rec.owner_id, spaces.get(rec.space_id));
  return { export_seen: true, export_enabled: ex.enabled, state, reasons, releasable, can_release: can };
}

/** Show outside again: the cleared reasons; the record goes through the publication gate again. */
export async function edgeShow(app: App, caller: Caller, id: string): Promise<{ released: Releasable[] }> {
  await requireHuman(app, caller, "Show the record externally again", { path: `/records/${id}`, section: "Record" });
  const loc = await locate(app, id);
  if (!loc || loc.deleted) throw notFound();
  // the default map (without archived): nobody writes in an archive but the record's author — their right is checked separately
  const space = (await readableSpaces(app, caller)).get(loc.space_id);
  // who does not read the record learns nothing of its existence either (404); a reader without the write right gets 403
  if (loc.owner_id !== caller.person?.id && !space) throw notFound();
  if (!mayRelease(caller, loc.owner_id, space)) throw new MemoryError("forbidden", "Only the record owner or a space member with write access can show the record externally again");
  let released: string[];
  try {
    released = ((await app.db.control.query("SELECT edge_hold_release($1::uuid, $2::uuid) AS released", [id, caller.person!.id])).rows[0]?.released ?? []) as string[];
  } catch (e) {
    // the database function checks the right itself: a gateway mismatch (membership removed meanwhile) is the same refusal
    if ((e as { code?: string }).code === "42501") throw new MemoryError("forbidden", "Only the record owner or a space member with write access can show the record externally again");
    throw e;
  }
  const out = released.filter(isReleasable);
  const descendants = out.length && loc.class === "open" ? await releaseDescendants(app, caller, id, out) : 0;
  // an event only if something was cleared: an empty press changes nothing (the function sets the publication row in any case)
  if (out.length) {
    await audit(app, caller, { event_type: "edge_event", record_ids: [id], space_id: loc.space_id,
                               details: { code: "hold_released", record_id: id, reasons: out, descendants } });
    log.info("edge_hold_released", { count: out.length, descendants });
  }
  return { released: out };
}

/**
 * One close reason: a close hides the tree rows (hidden_at), and for
 * a head with an ordered move it is recorded as close_requested (edge_revoke_mark), for descendants (no move of their own)
 * as hidden. close_requested cleared at the head covers a descendant's hidden: before, the head had both. Only this direction:
 * a hidden alone at the head (hiding without a close — HELD) does not clear a descendant's own close_requested —
 * that is a separate decision of the person.
 */
export const coveredBy = (released: readonly string[], reason: string): boolean =>
  released.includes(reason) || (reason === "hidden" && released.includes("close_requested"));

/**
 * Descendants of the record held only by the same reasons that were cleared at it (close reasons — coveredBy): narrowing the head
 * set them on them (tree revoke), and without this they would stay held forever. A descendant with another reason of its own is a
 * separate decision of the person. edge_hold_release checks the right for each (no right — skipped). Returns the number
 * released.
 */
async function releaseDescendants(app: App, caller: Caller, id: string, reasons: readonly string[]): Promise<number> {
  const ids = ((await app.db.records("open", caller.scope).query(
    `WITH RECURSIVE t(id, depth) AS (SELECT r.id, 0 FROM records r WHERE r.parent_id = $1
                                    UNION SELECT r.id, t.depth + 1 FROM records r JOIN t ON r.parent_id = t.id WHERE t.depth < 64)
     SELECT DISTINCT id::text AS id FROM t`, [id])).rows as Row[]).map((r) => String(r.id));
  if (!ids.length) return 0;
  const held = (await app.db.control.query(
    "SELECT record_id::text AS id, array_agg(reason ORDER BY reason) AS reasons FROM edge_hold WHERE record_id = ANY($1::uuid[]) GROUP BY record_id", [ids])).rows as Row[];
  let n = 0;
  for (const h of held) {
    const own = (h.reasons as string[]).filter(isReleasable);
    if (!own.length || own.some((r) => !coveredBy(reasons, r))) continue;
    try {
      await app.db.control.query("SELECT edge_hold_release($1::uuid, $2::uuid)", [h.id, caller.person!.id]);
      n++;
    } catch (e) {
      if ((e as { code?: string }).code !== "42501") throw e;
    }
  }
  return n;
}

/** Routes of the record card; registered after the key check (rest.ts). */
export function registerEdgeHold(r: Hono<any>, app: App): void {
  const caller = (c: Context) => c.get("caller") as Caller;
  const recordId = (c: Context): string => { const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound(); return id; };
  r.post("/api/v1/records/:id/edge-show", async (c) => {
    app.limiter.check(caller(c), "memory_open");
    return c.json(await edgeShow(app, caller(c), recordId(c)));
  });
  r.get("/api/v1/records/:id/edge-status", async (c) => {
    // only a person in the workplace (ForbiddenHumanOnly): an agent has no use for this state
    await requireHuman(app, caller(c), "Check whether the record is visible externally", { path: "/records", section: "Records" });
    const id = recordId(c);
    // dark launch: export was never on — the card makes neither a query to the record nor a limit count
    if (!(await exportSeen(app))) return c.json(UNSEEN);
    app.limiter.check(caller(c), "memory_read");
    return c.json(await edgeStatus(app, caller(c), id));
  });
}
