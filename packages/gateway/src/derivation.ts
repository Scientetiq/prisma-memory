// "A retelling is no wider than its source". An agent's note with
// `derived_from` is accepted only if for every source: (1) the writer reads it by id — else not_found with positions;
// (2) the class is not wider — a closed source is not retold into open; (3) readers are not wider — every reader of the target
// space (except the writer) sees the source. Axis 3 is computed by the visibility core (`spaceSeesRow` → `visibleRow`) by reverse
// visibility (`spacesOfMany`); there is no truth table of its own here. Links go only through the links API (`insertLink`),
// system pools (SCOPE_SYSTEM), after the rights check: a T2 personal key does not open the closed base even for a link.
// Moving a retelling (memory_promote) matches what was declared at write (attrs.derived_declared) with the set's live links:
// only a person in the workplace moves wider than the sources, in two steps (confirm_wider), with the widened_by_human mark.
import { createHash } from "node:crypto";
import type pg from "pg";
import { asData, CHAIN_TREE, CHAIN_TREES, declaredRetelling, defaultDerivation, DERIVATION_PAGE_MAX, DERIVATION_SOURCES_MAX, derivedDeclaredOf, inProgress, insertLinkRetrying, log,
         MemoryError, NIL_UUID, notFound, orgStableForAll, recordPath, SCOPE_SYSTEM, spaceSeesRow,
         type DataClass, type DerivedKind, type LinkActor, type LinkStatus, type LinkWriteDeps, type NewLink, type RowFacts } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import type { McpTexts } from "./mcp-texts.ts";
import { loadReadable, readableSpaces, spaceReaders, spacesOfMany, type SpaceAccess } from "./access.ts";
import { audit, auditShownClosed } from "./audit.ts";
import { heldIds, orgSpace, orgUnitsOf, seesHeld } from "./org-hold.ts";
import { isUuidParam } from "./paging.ts";
import { byIdVisible, type ByIdRow } from "./visibility.ts";
import { isHumanSession, requireHuman, workplaceUrl, workplaceWhere } from "./workplace.ts";

type Reason = "derived_class_wider" | "derived_scope_wider" | "derived_basis_missing" | "derived_sources_unreadable";
type Queryable = Pick<pg.Pool, "query">;
type Target = Pick<SpaceAccess, "id" | "slug" | "kind" | "owner_id">;
export type Classes = { open: number; closed: number };

/** The tail of every refusal hint to the agent: the same text without derived_from is the same retelling. */
export const DERIVED_TAIL = "Do not omit derived_from when saving the same retelling. It is still the same retelling.";

/** A source read by the writer: its position in the input, its class and the row facts for the visibility core. */
export interface Source {
  pos: number; id: string; cls: DataClass; facts: RowFacts;
  /** A meeting event (derived with a parent): the hint "a participant can pass a meeting decision to a project". */
  meetingEvent: boolean;
  /** An org source under curator review (not confirmed, held, disputed): for axis 3 only the author and the list read it. */
  held: boolean;
}

// ---------------------------------------------------------------- texts
/** not_found for derived_from: the text depends only on positions — the inaccessible and the missing are indistinguishable. */
export function derivedNotFound(positions: readonly number[]): MemoryError {
  return new MemoryError("not_found",
    `Some records in derived_from do not exist or are unavailable to you: positions ${positions.join(", ")} (counting from zero). Remove them and try saving again.`,
    { hint: `Include only records you have read in derived_from (memory_read, memory_search). ${DERIVED_TAIL}`,
      details: { field: "derived_from", reason: "derived_from_not_found", positions: [...positions] } });
}

const refs = (positions: readonly number[]): string => positions.map((p) => `derived_from[${p}]`).join(", ");
const HELD = " The source is under review by Company knowledge curators. Access stays limited until they approve it.";

export interface RefusalArgs {
  reason: Reason; positions: readonly number[] | null; space: Target; cls: DataClass; attempt: "remember" | "promote";
  recordId?: string; meetingEventId?: string | null; held?: boolean; already?: { id: string; path: string } | null; confirm?: boolean;
}

/** Derivation gate refusal (class_denied, details.gate derivation): agent or person text, no count of others' sources on a move. */
export function derivationRefusal(app: App, caller: Caller, a: RefusalArgs): MemoryError {
  const slug = a.space.slug, me = caller.person?.id ?? null;
  const ownOpen = a.space.kind === "personal" && a.space.owner_id === me && a.cls === "open";
  let message: string;
  if (a.reason === "derived_sources_unreadable") message = "Only someone with access to every source can move the record to a wider audience";
  else if (a.reason === "derived_basis_missing") {
    const where = a.recordId ? workplaceUrl(app, `/records/${a.recordId}`) : null;
    message = `The record’s provenance is incomplete: some sources were deleted or a link was not saved. Only a person in the workspace can move it to ${slug}${where ? `: ${where}` : ""}.`;
  }
  else if (a.reason === "derived_class_wider")
    message = a.positions
      ? `A retelling of closed records cannot be saved in the open space ${slug} because some sources are closed (${refs(a.positions)}). Cloud agents for all members can read open content.`
      : `This record is a retelling of closed records and cannot be moved to the open space ${slug}.`;
  else message = (a.positions
      ? `The retelling would reach a wider audience than its sources: some readers in ${slug} cannot see ${refs(a.positions)}.`
      : `The retelling would reach a wider audience than its sources: some readers in ${slug} cannot see its sources.`) + (a.held ? HELD : "");
  let hint: string;
  if (a.attempt === "promote") {
    const where = a.recordId ? workplaceUrl(app, `/records/${a.recordId}`) : null;
    hint = a.reason === "derived_sources_unreadable"
      ? "Ask someone with access to all the sources to move the record, or choose a space where everyone can see them."
      : a.confirm
        ? "A person must decide whether to move a record to a wider audience than its sources. Confirm their decision (confirm_wider) or choose a space where everyone can see the sources."
        : `Only a person can move a record to a wider audience than its sources. In the workspace, select “Move” on the record page${where ? ` (${where})` : ""}.`;
  } else if (a.already) {
    hint = ownOpen && a.reason === "derived_class_wider"
      ? `This note already exists as an open record in your personal space (${a.already.path}). A person can close it (memory_close), or you can save a note with different wording. ${DERIVED_TAIL}`
      : `This record already exists in ${slug} and reaches a wider audience than its sources (${a.already.path}). Tell a person so they can move it back to your personal space or delete it. ${DERIVED_TAIL}`;
  } else if (caller.service?.write_space_id) {
    hint = `The service has only one space it can write to and cannot save the retelling there. Tell a person. ${DERIVED_TAIL}`;
  } else if (ownOpen) {
    hint = `Your personal space is open here. Save the record to a closed space where all members can see the sources, or tell a person. ${DERIVED_TAIL}`;
  } else {
    const path = a.meetingEventId ? `/records/${a.meetingEventId}` : null;
    const meeting = path && a.space.kind === "project"
      ? `; a meeting participant can hand over a meeting decision to a project in the workspace: ${workplaceUrl(app, path) ?? `“Record” section (${path})`}` : "";
    hint = `Save it to your personal space (space: me), where only you can see it, or to a space where all readers can see the sources. Do not move it to another space yourself${meeting}. ${DERIVED_TAIL}`;
  }
  const details: Record<string, unknown> = { gate: "derivation", reason: a.reason, ...(a.positions ? { positions: [...a.positions] } : {}), space: slug,
                                             ...(a.confirm ? { confirm: "wider" } : {}), ...(a.already ? { already_known: { id: a.already.id, path: a.already.path } } : {}) };
  return new MemoryError("class_denied", message, { hint, details });
}

export const isDerivationDenial = (e: unknown): boolean =>
  e instanceof MemoryError && e.code === "class_denied" && (e.extra.details as { gate?: unknown } | undefined)?.gate === "derivation";

/**
 * confirm_wider — only a person in the workplace and not from a plan: else invalid_argument with the field; the hint leads
 * to the record page, where the person presses "Move" themselves.
 */
export function checkConfirmWider(app: App, caller: Caller, confirm: boolean | undefined, viaPlan: boolean, recordId: string): void {
  if (!confirm) return;
  if (!isHumanSession(caller) || viaPlan)
    throw new MemoryError("invalid_argument", "Only a person can send confirm_wider in the workspace. They decide whether to move the record to a wider audience than its sources",
      { hint: `A person can move the record to a wider audience than its sources. Select “Move” on the record page — ${workplaceWhere(app, `/records/${recordId}`, "Record")}`,
        details: { field: "confirm_wider", reason: "workplace_only" } });
}

// ---------------------------------------------------------------- sources
type Got = { pos: number; rec: Awaited<ReturnType<typeof loadReadable>>["rec"]; db: pg.Pool };

/** Reading each source by id: the read ones, the "missing/inaccessible" positions and "in a class move". */
async function readSources(app: App, caller: Caller, ids: readonly string[], spaces: Map<string, SpaceAccess>): Promise<{ got: Got[]; missing: number[]; busy: boolean }> {
  const missing: number[] = [], got: Got[] = [];
  let busy = false;
  for (const [pos, id] of ids.entries()) {
    try {
      const { rec, db } = await loadReadable(app, caller, id, spaces);
      got.push({ pos, rec, db });
    } catch (e) {
      if (e instanceof MemoryError && e.code === "not_found") missing.push(pos);
      else if (e instanceof MemoryError && e.code === "in_progress") busy = true;
      else throw e;
    }
  }
  return { got, missing, busy };
}

/**
 * Facts of the read sources for axis 3 — with the WHOLE people list and all placements (axis 3 asks about other
 * readers): one query per record pool (like factsFor in visibility.ts, no filter by person). An org source is "read by all"
 * only when settled: the review units — one orgUnitsOf per pool; not confirmed, held or disputed —
 * the author and the list read it.
 */
async function sourceFacts(app: App, got: readonly Got[]): Promise<Source[]> {
  const byDb = new Map<pg.Pool, Got[]>();
  for (const g of got) byDb.set(g.db, [...(byDb.get(g.db) ?? []), g]);
  const listed = new Map<string, string[]>(), placed = new Map<string, string[]>();
  for (const [db, part] of byDb) {
    const { rows } = await db.query(
      `SELECT 'p'::text AS k, record_id, person_id AS v FROM record_people WHERE record_id = ANY($1::uuid[])
       UNION ALL
       SELECT 'l'::text, record_id, space_id FROM record_placements WHERE record_id = ANY($1::uuid[])`, [part.map((g) => g.rec.id)]);
    for (const r of rows) {
      const into = r.k === "p" ? listed : placed;
      into.set(r.record_id as string, [...(into.get(r.record_id as string) ?? []), r.v as string]);
    }
  }
  const out: Source[] = got.map(({ pos, rec }) => ({
    pos, id: rec.id, cls: rec.class, meetingEvent: rec.type === "event" && rec.parent_id !== null, held: false,
    facts: { id: rec.id, owner_id: rec.owner_id, audience: rec.audience, space_id: rec.space_id, class: rec.class, listed: listed.get(rec.id) ?? [], placed: placed.get(rec.id) ?? [] } }));
  const homes = [...new Set(out.flatMap((s) => [s.facts.space_id, ...s.facts.placed]))];
  if (!homes.length) return out;
  const orgIds = new Set((await app.db.control.query("SELECT id FROM spaces WHERE id = ANY($1::uuid[]) AND kind = 'org'", [homes])).rows.map((r) => r.id as string));
  if (!orgIds.size) return out;
  const inOrg = (s: Source) => orgIds.has(s.facts.space_id) || s.facts.placed.some((p) => orgIds.has(p));
  for (const [db, part] of byDb) {
    const ids = part.map((g) => g.rec.id).filter((id) => inOrg(out.find((s) => s.id === id)!));
    if (!ids.length) continue;
    const units = await orgUnitsOf(app.db.control, db, ids);
    for (const s of out) {
      if (!ids.includes(s.id) || orgStableForAll(units.get(s.id) ?? null)) continue;
      s.held = true; s.facts = { ...s.facts, audience: "people", placed: [] };
    }
  }
  return out;
}

/**
 * Sources by id with the read of memory_read (loadReadable, map with archive), no throw on unreadable: readable ones —
 * with facts, unreadable and missing ones — as positions. A record in a class move that the writer reads — in_progress
 * (another's — in the positions). The move (promoteDerivation) needs both without a second pass.
 */
export async function loadSourcesPartial(app: App, caller: Caller, ids: readonly string[], o: { spaces?: Map<string, SpaceAccess> } = {})
  : Promise<{ sources: Source[]; missingPositions: number[] }> {
  const r = await readSources(app, caller, ids, o.spaces ?? await readableSpaces(app, caller, { archived: true }));
  if (r.busy) throw inProgress();
  return { sources: await sourceFacts(app, r.got), missingPositions: r.missing };
}

/**
 * Sources of a record (axis 1): the inaccessible and the missing — not_found with positions (before the facts: an outsider learns
 * nothing); a record in a class move that the writer reads — in_progress.
 */
export async function loadSources(app: App, caller: Caller, ids: readonly string[], o: { spaces?: Map<string, SpaceAccess> } = {}): Promise<Source[]> {
  const r = await readSources(app, caller, ids, o.spaces ?? await readableSpaces(app, caller, { archived: true }));
  if (r.missing.length) throw derivedNotFound(r.missing);
  if (r.busy) throw inProgress();
  return sourceFacts(app, r.got);
}

// ---------------------------------------------------------------- gate
export interface Verdict { reason: Reason | null; positions: number[]; held: boolean; classes: Classes; meetingEventId: string | null }

/** Axes 2 and 3 without side effects: whoever is not visible — only positions go out. */
export async function derivationVerdict(app: App, caller: Caller, o: { space: Target; cls: DataClass; sources: readonly Source[] }): Promise<Verdict> {
  const classes: Classes = { open: o.sources.filter((s) => s.cls === "open").length, closed: o.sources.filter((s) => s.cls === "closed").length };
  const meetingEventId = o.sources.length === 1 && o.sources[0]!.meetingEvent ? o.sources[0]!.id : null;
  const wider = o.cls === "open" ? o.sources.filter((s) => s.cls === "closed").map((s) => s.pos) : [];
  if (wider.length) return { reason: "derived_class_wider", positions: wider, held: false, classes, meetingEventId };
  const me = caller.person?.id ?? null;
  const readers = await spaceReaders(app, o.space);
  const list = readers.kind === "all_org" ? [NIL_UUID]
    : readers.kind === "self" ? (readers.owner && readers.owner !== me ? [readers.owner] : [])
    : readers.ids.filter((p) => p !== me);
  const candidates = [...new Set(o.sources.flatMap((s) => [s.facts.space_id, ...s.facts.placed]))];
  const map = await spacesOfMany(app, list.filter((p) => p !== NIL_UUID), candidates);
  const spacesOf = (p: string): string[] => p === NIL_UUID ? [o.space.id] : [...(map.get(p) ?? [])];
  const unseen = o.sources.filter((s) => !spaceSeesRow(list, s.facts, spacesOf));
  if (!unseen.length) return { reason: null, positions: [], held: false, classes, meetingEventId };
  return { reason: "derived_scope_wider", positions: unseen.map((s) => s.pos), held: unseen.some((s) => s.held), classes, meetingEventId };
}

/** The log event of a derivation refusal: without text and without source ids. */
async function auditRefusal(app: App, caller: Caller, o: { reason: Reason; cls: DataClass; space: Target; declared: number; classes: Classes; attempt: "remember" | "promote"; recordId?: string }) {
  await audit(app, caller, { event_type: "write", class: o.cls, record_ids: o.recordId ? [o.recordId] : [], space_id: o.space.id,
    details: { op: "derived_refused", reason: o.reason, declared: o.declared, classes: o.classes, attempt: o.attempt, ...(caller.transport ? { via: caller.transport } : {}) } });
}

/**
 * Write gate (memory_remember): after the class, before the open-write and open checks. A refusal — the log event
 * `derived_refused` and class_denied with positions; a repeat of the same record (`already`) — with its id and path.
 */
export async function derivationGate(app: App, caller: Caller, o: { space: Target; cls: DataClass; sources: readonly Source[]; declared: number;
                                                                   already?: { id: string; path: string } | null }): Promise<{ classes: Classes }> {
  const v = await derivationVerdict(app, caller, o);
  if (!v.reason) return { classes: v.classes };
  await auditRefusal(app, caller, { reason: v.reason, cls: o.cls, space: o.space, declared: o.declared, classes: v.classes, attempt: "remember", recordId: o.already?.id });
  throw derivationRefusal(app, caller, { reason: v.reason, positions: v.positions, space: o.space, cls: o.cls, attempt: "remember",
                                         meetingEventId: v.meetingEventId, held: v.held, already: o.already ?? null });
}

// ---------------------------------------------------------------- links
/** Who sets a link: a person in the workplace (not through MCP) — confirmed; an agent — active / inferred_by_agent. */
export const linkActorOf = (caller: Caller): LinkActor =>
  isHumanSession(caller) && caller.transport !== "mcp" ? { kind: "human", personId: caller.person!.id } : { kind: "agent", personId: caller.person!.id };

/**
 * Links note → sources (relation derived_from). There is no cross-base transaction: the note is already saved; a busy end —
 * LINK_RETRY_MS retries, failing that — a position in failed (log.warn derived_link_failed); a repeat of the same call adds it.
 */
export async function putDerivedLinks(app: App, noteId: string, sourceIds: readonly string[], actor: LinkActor,
                                      o: { insert?: (d: LinkWriteDeps, l: NewLink) => Promise<unknown>; sleep?: (ms: number) => Promise<void> } = {})
  : Promise<{ linked: number; created: number; failed: number[] }> {
  const deps: LinkWriteDeps = { control: app.db.control, records: (cls) => app.db.records(cls, SCOPE_SYSTEM), actor, quoteThreshold: 0.9,
                                mayApply: (l) => l.relation === "derived_from", openCheck: async () => "pass" };
  let linked = 0, created = 0;
  const failed: number[] = [];
  for (const [pos, dst] of sourceIds.entries()) {
    try {
      const r = await insertLinkRetrying(deps, { srcId: noteId, dstId: dst, relation: "derived_from", status: actor.kind === "human" ? "confirmed" : "active" },
                                         o as { insert?: (d: LinkWriteDeps, l: NewLink) => Promise<{ id: string; detailClass: DataClass; created: boolean; status: LinkStatus }>; sleep?: (ms: number) => Promise<void> });
      linked++;
      if (r?.created) created++;
    } catch (e) {
      failed.push(pos);
      log.warn("derived_link_failed", { record_id: noteId, position: pos, error: String((e as Error)?.message ?? e).slice(0, 120) });
    }
  }
  return { linked, created, failed };
}

/**
 * The source fingerprint for attrs.derived_pending: sha256 of the lowercase id,
 * the first 16 hex. The source ids themselves are not put into attrs; the fingerprint is defence in depth.
 */
export const derivedPrint = (id: string): string => createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 16);
/** Fingerprints without repeats, in order (the same set — the same array). */
const printsOf = (ids: Iterable<string>): string[] => [...new Set([...ids].map(derivedPrint))].sort();
/** The fingerprint array from attrs; not an array — empty. */
const pendingArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The line in the answer's notes when not all links were written. */
export const LINKS_PARTIAL_NOTE = "Some source links were not saved. Repeat the same call to add the missing links without creating a second record";

/** A live origin link: every status except one rejected by a person (rejected with decided_by). */
const liveLink = (l: Pick<BasisLink, "status" | "decided_by">): boolean => !(l.status === "rejected" && l.decided_by);

/**
 * A repeat with derived_from: what the found record declared
 * rises to |the base's live derived_from sources ∪ those declared now| — upward only, in one UPDATE by the record's system
 * pool (gate metadata, like derivation and widened_by_human), the kind — the default from the new count if there was none.
 * The base is the one the move matches (readBasis): the whole version chain of one's note, not the links of one version
 * (one's own id does not count). The loss mark (derived_lost) is left alone — nobody but
 * a person with a confirmed move may remove it. Ids are compared in lowercase.
 *
 * Also in the same UPDATE: the unwritten sources `derived_pending := (the chain's pending ∪ fingerprints of this call's ids)
 * − fingerprints of the chain's live links` into the head (other chain rows lose the key: it moved to the head). Called under
 * the chain lock TWICE (linkDerived): before the link insert — this call's prints are written (a failed insert is "incomplete",
 * the safe side), and after it — the inserted are subtracted. No row (the record changed class between the class read and
 * the UPDATE) — in_progress, not a silent "done".
 */
export async function raiseDeclared(app: App, cls: DataClass, recordId: string, ids: readonly string[]): Promise<number> {
  const db = app.db.recordsForWrite(cls, "system");
  const basis = await readBasis(db, app.db.control, recordId);
  const self = recordId.toLowerCase();
  const mine = ids.map((i) => i.toLowerCase()).filter((i) => i !== self);
  const n = new Set([...basis.sources.map((i) => i.toLowerCase()), ...mine]).size;
  const live = new Set(printsOf(basis.sources));
  const pending = [...new Set([...basis.pending, ...printsOf(mine)])].filter((p) => !live.has(p)).sort();
  const r = await db.query(
    `UPDATE records SET attrs = (attrs - 'derived_pending')
       || CASE WHEN COALESCE(CASE WHEN (attrs->>'derived_declared') ~ '^[0-9]+$' THEN (attrs->>'derived_declared')::int END, 0) < $2
               THEN jsonb_build_object('derived_declared', $2::int)
                    || CASE WHEN attrs->>'derivation' IN ('retelling', 'synthesis') THEN '{}'::jsonb ELSE jsonb_build_object('derivation', $3::text) END
               ELSE '{}'::jsonb END
       || CASE WHEN cardinality($4::text[]) > 0 THEN jsonb_build_object('derived_pending', to_jsonb($4::text[])) ELSE '{}'::jsonb END
     WHERE id = $1`,
    [recordId, n, defaultDerivation(n), pending]);
  if (!r.rowCount) throw inProgress();
  const others = basis.pendingRows.filter((id) => id !== recordId);
  if (others.length) await db.query("UPDATE records SET attrs = attrs - 'derived_pending' WHERE id = ANY($1::uuid[])", [others]);
  return n;
}

/**
 * Origin links under the chain lock derived:<root> (the body of underControlLock / a nested lockAlso):
 * the record's class is re-read from the locator (the class read before the lock could have changed — the class move
 * finished in between: in_progress), and so is the chain head; then the declared and unwritten ones (raiseDeclared), the links,
 * and raiseDeclared again — the inserted ones are subtracted from derived_pending.
 */
export async function linkDerived(app: App, recordId: string, cls: DataClass, ids: readonly string[], actor: LinkActor)
  : Promise<{ head: string; linked: number; created: number; failed: number[] }> {
  const now = (await app.db.control.query("SELECT class FROM record_locations WHERE record_id = $1", [recordId])).rows[0]?.class as DataClass | undefined;
  if (now !== cls) throw inProgress();
  const { head } = await chainEnds(app.db.recordsForWrite(cls, "system"), recordId);
  await raiseDeclared(app, cls, head, ids);
  const links = await putDerivedLinks(app, head, ids, actor);
  await raiseDeclared(app, cls, head, ids);
  return { head, ...links };
}

/** The "widened by a person" mark: who, when and by which path; it holds no source ids. */
export interface WidenedMark { person: string; at: string; via: "handover" | "promote" }
export const widenedMark = (person: string, via: WidenedMark["via"]): WidenedMark => ({ person, at: new Date().toISOString(), via });

/** Add the mark to the record's attrs (repeated handover, a person's move) by the pool or client that writes the record. */
export async function markWidened(db: Queryable, recordId: string, mark: WidenedMark): Promise<number> {
  return (await db.query("UPDATE records SET attrs = attrs || jsonb_build_object('widened_by_human', $2::jsonb) WHERE id = $1", [recordId, JSON.stringify(mark)])).rowCount ?? 0;
}

// ---------------------------------------------------------------- move (memory_promote)
export interface BasisLink { src_id: string; dst_id: string; status: string; decided_by: string | null }

/**
 * The set's origin: declared — the maximum of derived_declared over the set's rows (a version of one's note inherits the check
 * of the previous one); live sources — dst of the set's derived_from links but person-rejected ones. Declared above live —
 * the base is incomplete (a source purged, a link not written). And the loss mark on any row of the set (attrs.derived_lost —
 * the worker sets it when purging a source): the count alone forgets the purge — a repeat with new sources would catch up,
 * and the move would check only the rest and the new ones, though the text holds the purged one too. And unwritten
 * sources: a fingerprint in attrs.derived_pending of any row that has no live link — the count alone does not
 * know which source is unwritten: a repeat with other sources would catch up with it, while the unwritten one stays unlinked.
 */
export function setBasis(rows: ReadonlyArray<{ id: string; declared: number | null; lost?: boolean | null; pending?: unknown }>, links: readonly BasisLink[])
  : { declared: number; sources: string[]; missing: boolean } {
  const declared = rows.reduce((m, r) => Math.max(m, r.declared ?? 0), 0);
  const sources = [...new Set(links.filter(liveLink).map((l) => l.dst_id))];
  return { declared, sources, missing: declared > sources.length || rows.some((r) => r.lost === true) || pendingOf(rows, sources).length > 0 };
}

/** The set's unwritten sources: the derived_pending fingerprints of all rows minus the fingerprints of live sources. */
export function pendingOf(rows: ReadonlyArray<{ pending?: unknown }>, sources: readonly string[]): string[] {
  const live = new Set(printsOf(sources));
  return [...new Set(rows.flatMap((r) => pendingArr(r.pending)))].filter((p) => !live.has(p)).sort();
}

/** The set's fingerprint for re-reading under the move lock: declared count, loss mark, unwritten ones and links, unordered. */
export function setFingerprint(declared: number, links: readonly BasisLink[], lost = false, pending: readonly string[] = []): string {
  const parts = links.map((l) => `${l.src_id}>${l.dst_id}:${l.status}:${l.decided_by ?? ""}`).sort();
  return createHash("sha256").update(`${declared}|${lost ? "lost|" : ""}${pending.length ? `pending:${[...pending].sort().join(",")}|` : ""}${parts.join(",")}`).digest("hex");
}


/** The set of the moved record (the version chain of one's note and derived ones) and its derived_from links. */
export async function readBasis(db: Queryable, control: Queryable, recordId: string)
  : Promise<{ declared: number; sources: string[]; missing: boolean; fingerprint: string; pending: string[]; pendingRows: string[]; linked: number }> {
  const rows = (await db.query(`${CHAIN_TREE}
    SELECT r.id, CASE WHEN (r.attrs->>'derived_declared') ~ '^[0-9]+$' THEN (r.attrs->>'derived_declared')::int END AS declared,
           (r.attrs->>'derived_lost') = 'true' AS lost, r.attrs->'derived_pending' AS pending
    FROM records r JOIN tree ON tree.id = r.id WHERE r.deleted_at IS NULL`, [recordId])).rows as Array<{ id: string; declared: number | null; lost: boolean | null; pending: unknown }>;
  const links = rows.length
    ? (await control.query("SELECT dst_id, src_id, status, decided_by FROM record_links WHERE src_id = ANY($1::uuid[]) AND relation = 'derived_from'",
                           [rows.map((r) => r.id)])).rows as BasisLink[] : [];
  const b = setBasis(rows, links);
  const pending = pendingOf(rows, b.sources);
  const lost = rows.some((r) => r.lost === true);
  return { ...b, fingerprint: setFingerprint(b.declared, links, lost, pending), pending,
           pendingRows: rows.filter((r) => r.pending !== null && r.pending !== undefined).map((r) => r.id), linked: links.length };
}

/**
 * Root (version with no previous) and head (active version with no newer) of the version chain of one's note; with no
 * chain — the record itself. The root is the chain's stable identity: the key of the repeat lock —
 * repeats that found the old version (before memory_correct) and the new one wait for the same lock. The head is re-read under
 * the lock: links and the declared count are written into the active version.
 */
export async function chainEnds(db: Queryable, recordId: string): Promise<{ root: string; head: string }> {
  const r = (await db.query(`${CHAIN_TREE}
    SELECT (SELECT c.id FROM chain c WHERE c.supersedes_id IS NULL ORDER BY c.id LIMIT 1) AS root,
           (SELECT c.id FROM chain c JOIN records r ON r.id = c.id WHERE c.superseded_by_id IS NULL AND r.deleted_at IS NULL ORDER BY c.id LIMIT 1) AS head`,
    [recordId])).rows[0] as { root: string | null; head: string | null } | undefined;
  return { root: r?.root ?? recordId, head: r?.head ?? recordId };
}

/**
 * Retelling move check: only when the move ends in scope "space" and the target is not one's personal. For an agent or plan
 * wider — refusal without positions (others' source count hidden) and the derived_refused event; a person without confirmation —
 * class_denied with confirm: wider; with confirmation they must read all live sources. null — no check needed; else —
 * the set fingerprint for re-reading under the lock and the "widened by a person" sign. A set without origin gets the fingerprint
 * too: a repeat that added a link before the move lock changes it — the move answers in_progress.
 * Sources load once (loadSourcesPartial): unreadable ones as positions, without a second pass over the readable ones.
 */
export async function promoteDerivation(app: App, caller: Caller, o: { recordId: string; db: Queryable; cls: DataClass; target: Target; audienceAfter: string;
                                                                     confirm?: boolean; viaPlan?: boolean; spaces: Map<string, SpaceAccess>; quiet?: boolean })
  : Promise<{ widened: boolean; fingerprint: string } | null> {
  const me = caller.person?.id ?? null;
  if (o.audienceAfter !== "space" || (o.target.kind === "personal" && o.target.owner_id === me)) return null;
  const basis = await readBasis(o.db, app.db.control, o.recordId);
  if (!basis.declared && !basis.sources.length && !basis.missing) return { widened: false, fingerprint: basis.fingerprint };
  const { sources, missingPositions } = await loadSourcesPartial(app, caller, basis.sources, { spaces: o.spaces });
  const unreadable = missingPositions.length > 0;
  const v = await derivationVerdict(app, caller, { space: o.target, cls: o.cls, sources });
  const reason: Reason | null = basis.missing ? "derived_basis_missing" : v.reason ?? (unreadable ? "derived_scope_wider" : null);
  if (!reason) return { widened: false, fingerprint: basis.fingerprint };
  const human = isHumanSession(caller) && !o.viaPlan;
  const base = { positions: null, space: o.target, cls: o.cls, attempt: "promote" as const, recordId: o.recordId, held: v.held };
  if (!human) {
    if (!o.quiet) await auditRefusal(app, caller, { reason, cls: o.cls, space: o.target, declared: basis.declared, classes: v.classes, attempt: "promote", recordId: o.recordId });
    throw derivationRefusal(app, caller, { ...base, reason });
  }
  if (!o.confirm) throw derivationRefusal(app, caller, { ...base, reason, confirm: true });
  if (unreadable) throw derivationRefusal(app, caller, { ...base, reason: "derived_sources_unreadable" });
  return { widened: true, fingerprint: basis.fingerprint };
}

export interface DerivationView { kind: DerivedKind | null; declared: number; widened_by_human: boolean }

/** Record origin for the workplace: kind (root attrs, else default by the declared count), declared, whether a person widened it. */
export async function derivationView(db: Queryable, control: Queryable, rec: { id: string; attrs: Record<string, any> }): Promise<DerivationView> {
  const basis = await readBasis(db, control, rec.id);
  const stored = rec.attrs?.derivation === "retelling" || rec.attrs?.derivation === "synthesis" ? rec.attrs.derivation as DerivedKind : null;
  const byCount = defaultDerivation(basis.declared);
  return { kind: stored ?? (byCount === "original" ? null : byCount), declared: basis.declared, widened_by_human: !!rec.attrs?.widened_by_human };
}

/**
 * GET /api/v1/records/{id}/derivation — only a person in the workplace (requireHuman first, before any read: a T2 key,
 * an extended key, an on-behalf-of service and a preview — forbidden with a link); the record — by the read right (loadReadable).
 * No ids and no count of others' sources.
 */
export async function recordDerivation(app: App, caller: Caller, id: string): Promise<DerivationView> {
  await requireHuman(app, caller, "Record provenance", { path: `/records/${id}`, section: "Record" });
  if (!isUuidParam(id)) throw notFound();
  const { rec, db } = await loadReadable(app, caller, id);
  return derivationView(db, app.db.control, rec);
}

// ---------------------------------------------------------------- "Based on"
// An agent's retelling is shown as one: in a search finding, in memory_read and on the record page — the kind and the sources
// the reader sees themselves (at most 5 to the agent, 20 to the page), no count of hidden ones. The mark always acts; the order
// and the answer's make-up it does not change — only the switch search.derivation_order_enabled does (ranking.ts, search.ts).

export type DerivationKind = "retelling" | "synthesis" | "echo";
/** A retelling source the reader sees themselves: the path — to read it with memory_read; the title — people's data. */
export interface DerivationSource { id: string; path: string; title: string | null; occurred_at: string }
export interface DerivationMark { kind: DerivationKind; sources: DerivationSource[]; note: string }
export interface DerivationFound {
  mark: DerivationMark;
  /** All visible sources by priority (derived_from first, then echo_of; inside — newest first), before the cut: reordering and mixing in. */
  order: string[];
  /** Closed sources among the shown ones — their titles go into the answer: log event derivation_sources (before the answer). */
  closed: string[];
  /** The class of each source from `order`: mixing in checks a source with the answer prefilter of its class. */
  classes: Map<string, DataClass>;
}
export interface DerivationTarget { id: string; cls: DataClass; attrs: Record<string, unknown> | null | undefined }

/** The mark's `note` (for the agent): fixed lines, without numbers. */
export const DERIVATION_NOTES = {
  sources: "agent retelling. Use the sources below",
  hidden: "agent retelling. You cannot access the sources",
  echo: "appears to be a retelling. Use the source below",
} as const;

/** op of the log event on the shown titles of closed sources (type list; for an extended key — extended_key_use). */
export const DERIVATION_SOURCES_OP = "derivation_sources";

const push = (m: Map<string, Set<string>>, k: string, v: string): void => { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); };
const isoOf = (v: Date | string): string => new Date(v).toISOString();
const newestFirst = (a: ByIdRow, b: ByIdRow): number => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() || a.id.localeCompare(b.id);

/**
 * Sources held "Wrong / not for everyone" in org — as for a read by id (heldFromReader): a person in the workplace
 * and the author see them, others do not. The record's own review unit (orgUnitsOf; head not found — no too) and the set
 * of held ones with derived ones (heldIds, a 5 s cache). Records outside org — no queries.
 */
async function dropHeldSources(app: App, caller: Caller, db: Pick<pg.Pool, "query">, cls: DataClass, rows: ByIdRow[]): Promise<ByIdRow[]> {
  if (!rows.length || seesHeld(caller)) return rows;
  const org = await orgSpace(app);
  const inOrg = org ? rows.filter((r) => r.space_id === org.id && r.owner_id !== caller.person?.id) : [];
  if (!inOrg.length) return rows;
  const [units, held] = await Promise.all([orgUnitsOf(app.db.control, db, inOrg.map((r) => r.id)), heldIds(app, caller, cls).then((x) => new Set(x))]);
  const drop = new Set(inOrg.filter((r) => { const u = units.get(r.id); return held.has(r.id) || !!u?.held_at || !!u?.unresolved; }).map((r) => r.id));
  return drop.size ? rows.filter((r) => !drop.has(r.id)) : rows;
}

/**
 * Sources the reader sees themselves — the memory_read rule: the locator, the class gate (a class base outside the scope is not
 * opened), the visibility byIdSpec (the archive is read by id), the org hold; a source in an unfinished class move — no.
 */
async function visibleSources(app: App, caller: Caller, dsts: readonly string[], spaces: Map<string, SpaceAccess>): Promise<Map<string, ByIdRow & { cls: DataClass }>> {
  const visible = new Map<string, ByIdRow & { cls: DataClass }>();
  if (!dsts.length) return visible;
  const locs = (await app.db.control.query(
    `SELECT l.record_id, l.class, EXISTS (SELECT 1 FROM class_moves m WHERE m.record_id = l.record_id AND m.status IN ('pending','copying','verifying')) AS moving
       FROM record_locations l WHERE l.record_id = ANY($1::uuid[]) AND NOT l.deleted`, [[...dsts]])).rows as Array<{ record_id: string; class: DataClass; moving: boolean }>;
  for (const cls of ["open", "closed"] as const) {
    const ids = locs.filter((l) => l.class === cls && !l.moving).map((l) => l.record_id);
    if (!ids.length || !caller.scope.classes.includes(cls)) continue;
    const db = app.db.records(cls, caller.scope);
    for (const r of await dropHeldSources(app, caller, db, cls, await byIdVisible(db, caller, cls, ids, spaces))) visible.set(r.id, { ...r, cls });
  }
  return visible;
}

/**
 * Echo records with at least one visible source (an echo_of link with status active or confirmed) — before the page cut, for
 * the D factor (D is for findings with derivation). The rule is the same as for the mark in derivationFor: an echo without
 * a visible source gets no mark, hence no D either (otherwise the order would indirectly reveal a hidden record).
 * One query to the links; if there are links — the visibility of their sources (visibleSources). Echo links are not written here.
 */
export async function echoesWithVisibleSource(app: App, caller: Caller, ids: readonly string[], spaces: Map<string, SpaceAccess>): Promise<Set<string>> {
  const out = new Set<string>();
  if (!caller.person || !ids.length) return out;
  const links = (await app.db.control.query(
    "SELECT src_id, dst_id FROM record_links WHERE src_id = ANY($1::uuid[]) AND relation = 'echo_of' AND status IN ('active', 'confirmed') AND dst_id <> src_id",
    [[...ids]])).rows as Array<{ src_id: string; dst_id: string }>;
  if (!links.length) return out;
  const visible = await visibleSources(app, caller, [...new Set(links.map((l) => l.dst_id))], spaces);
  for (const l of links) if (visible.has(l.dst_id)) out.add(l.src_id);
  return out;
}

/** Kind of a declared retelling: the record's attrs, else any chain version's, else by source count (1–2 — retelling, 3+ — synthesis). */
function retellingKind(attrs: Record<string, unknown> | null | undefined, chain: { kind: DerivedKind | null; declared: number; lost: boolean } | undefined, linked: number): DerivedKind {
  const own = attrs?.derivation;
  if (own === "retelling" || own === "synthesis") return own;
  if (chain?.kind) return chain.kind;
  const n = Math.max(1, linked, chain?.declared ?? 0, derivedDeclaredOf(attrs));
  return defaultDerivation(n) === "synthesis" ? "synthesis" : "retelling";
}

/**
 * The "Based on" mark for the records of one answer (a search page, memory_read, a record page), in a batch:
 * 1. the base of declared retellings (attrs: kind, declared, loss — declaredRetelling) — derived_from links of the whole chain
 *    of one's note's versions, like readBasis: one recursive query per class (CHAIN_TREES);
 * 2. one query into control: derived_from and echo_of links with statuses active and confirmed (one confirmed by a person is the
 *    same link); echo_of — on the answer's records themselves (echo links are not set here);
 * 3. source visibility — by the rule of memory_read: the locator, the class gate, byIdSpec (the archive is read by id),
 *    the org hold; a source in a class move is not shown;
 * 4. kind: a declared retelling — retelling | synthesis (even when no source is visible: a property of the record itself);
 *    echo only — echo and only with a visible source (otherwise the mark would reveal that a hidden record exists).
 * No records or no person — no query at all; with no echo or retelling candidates — one query to the links.
 */
export async function derivationFor(app: App, caller: Caller, targets: readonly DerivationTarget[], o: { spaces: Map<string, SpaceAccess>; max?: number })
  : Promise<Map<string, DerivationFound>> {
  const out = new Map<string, DerivationFound>();
  if (!caller.person || !targets.length) return out;
  const max = o.max ?? DERIVATION_SOURCES_MAX;
  const page = new Set(targets.map((t) => t.id));
  const declared = new Set(targets.filter((t) => declaredRetelling(t.attrs)).map((t) => t.id));
  // 1. the tree with the chain for every declared retelling (the record itself is a member of its tree)
  const tree = new Map<string, Set<string>>(), memberOf = new Map<string, Set<string>>();
  const chain = new Map<string, { kind: DerivedKind | null; declared: number; lost: boolean }>();
  for (const t of targets) { push(tree, t.id, t.id); push(memberOf, t.id, t.id); }
  for (const cls of ["open", "closed"] as const) {
    const ids = targets.filter((t) => t.cls === cls && declared.has(t.id)).map((t) => t.id);
    if (!ids.length) continue;
    const rows = (await app.db.records(cls, caller.scope).query(`${CHAIN_TREES}
      SELECT t.start, t.id, r.attrs->>'derivation' AS derivation, (r.attrs->>'derived_lost') = 'true' AS lost,
             CASE WHEN (r.attrs->>'derived_declared') ~ '^[0-9]+$' THEN (r.attrs->>'derived_declared')::int END AS declared
        FROM tree t JOIN records r ON r.id = t.id WHERE r.deleted_at IS NULL`, [ids])).rows as Array<{ start: string; id: string; derivation: string | null; lost: boolean | null; declared: number | null }>;
    for (const r of rows) {
      push(tree, r.start, r.id); push(memberOf, r.id, r.start);
      const c = chain.get(r.start) ?? { kind: null, declared: 0, lost: false };
      if (!c.kind && (r.derivation === "retelling" || r.derivation === "synthesis")) c.kind = r.derivation;
      c.declared = Math.max(c.declared, r.declared ?? 0); c.lost ||= r.lost === true;
      chain.set(r.start, c);
    }
  }
  // 2. links in one query: derived_from from the tree members of a declared retelling, echo_of from the answer's records
  const links = (await app.db.control.query(
    "SELECT src_id, dst_id, relation FROM record_links WHERE src_id = ANY($1::uuid[]) AND relation IN ('derived_from', 'echo_of') AND status IN ('active', 'confirmed')",
    [[...memberOf.keys()]])).rows as Array<{ src_id: string; dst_id: string; relation: string }>;
  const derived = new Map<string, Set<string>>(), echo = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.relation === "echo_of") { if (page.has(l.src_id) && l.dst_id !== l.src_id) push(echo, l.src_id, l.dst_id); continue; }
    for (const t of memberOf.get(l.src_id) ?? []) if (declared.has(t) && !tree.get(t)!.has(l.dst_id)) push(derived, t, l.dst_id);
  }
  // 3. the visibility of sources — the memory_read rule; in a class move — not shown
  const visible = await visibleSources(app, caller, [...new Set([...derived.values(), ...echo.values()].flatMap((s) => [...s]))], o.spaces);
  // source addresses: the space from the reader's map, else (one's own record, the people list) — the slug by id
  const slugs = new Map<string, string>([...o.spaces].map(([id, s]) => [id, s.slug]));
  const unknown = [...new Set([...visible.values()].map((r) => r.space_id).filter((id) => !slugs.has(id)))];
  if (unknown.length) for (const r of (await app.db.control.query("SELECT id, slug FROM spaces WHERE id = ANY($1::uuid[])", [unknown])).rows) slugs.set(r.id, r.slug);
  // 4. marks
  for (const t of targets) {
    const d = [...(derived.get(t.id) ?? [])].flatMap((id) => visible.get(id) ?? []).sort(newestFirst);
    const e = [...(echo.get(t.id) ?? [])].filter((id) => !derived.get(t.id)?.has(id)).flatMap((id) => visible.get(id) ?? []).sort(newestFirst);
    const retelling = declared.has(t.id);
    if (!retelling && !e.length) continue;
    const kind: DerivationKind = retelling ? retellingKind(t.attrs, chain.get(t.id), derived.get(t.id)?.size ?? 0) : "echo";
    const all = [...d, ...e], shown = all.slice(0, max);
    const sources = shown.map((r) => ({ id: r.id, path: recordPath(slugs.get(r.space_id) ?? "unknown", r.type, r.occurred_at, r.id), title: r.title ?? null, occurred_at: isoOf(r.occurred_at) }));
    const note = kind === "echo" ? DERIVATION_NOTES.echo : sources.length ? DERIVATION_NOTES.sources : DERIVATION_NOTES.hidden;
    out.set(t.id, { mark: { kind, sources, note }, order: all.map((r) => r.id), closed: shown.filter((r) => r.cls === "closed").map((r) => r.id),
                    classes: new Map(all.map((r) => [r.id, r.cls])) });
  }
  return out;
}

/** The mark for MCP output (Hit.derivation, memory_read.derivation): the title is a string, empty if there is none. */
export const derivationOut = (m: DerivationMark) => ({ kind: m.kind, sources: m.sources.map((s) => ({ ...s, title: s.title ?? "" })), note: m.note });

/**
 * The "Based on" line in the memory_read text: the intro, paths and dates are server text; the source titles are people's
 * data, so only inside the data block (a title that is an "instruction" must not read as server words).
 */
export function derivationLine(m: DerivationMark, texts: McpTexts): string {
  const refs = m.sources.map((s) => `${s.path} (${s.occurred_at.slice(0, 10)})`).join("; ");
  const names = () => asData(m.sources.map((s) => `${s.path} — ${s.title?.trim() || "untitled"}`).join("\n"), { texts });
  if (m.kind === "echo") return `Appears to be a retelling: ${refs}. ${m.sources.length > 1 ? "Titles" : "Title"}:\n${names()}`;
  if (!m.sources.length) return "This is an agent retelling. You cannot access the sources.";
  return `Based on these sources (this is an agent retelling, so cite the sources): ${refs}. Source titles:\n${names()}`;
}

/**
 * The retelling mark in the finding line of the memory_search text (many clients give the model only the text, not
 * structuredContent): fixed words and source paths, without titles and without hidden counts. The finding line is in
 * the data block together with its other marks (org, "extended access"); source titles do not get there. No
 * mark — empty.
 */
export function derivationHitMark(d: { kind: DerivationKind; sources: ReadonlyArray<{ path: string }> } | undefined): string {
  if (!d) return "";
  const paths = d.sources.map((s) => s.path).join("; ");
  if (d.kind === "echo") return ` · appears to be a retelling: ${paths}`;
  if (!d.sources.length) return " · agent retelling, sources unavailable to you";
  return ` · agent retelling — ${d.sources.length > 1 ? "sources" : "source"}: ${paths}`;
}

export interface RecordDerivationSourcesView { kind: DerivationKind | null; sources: DerivationSource[]; note: string | null }

/**
 * GET /api/v1/records/{id}/derivation/sources — the "Based on" block of the record page for all who read the record (not only
 * the owner, as …/derivation): only a person in the workplace (requireHuman first), the record by the read right
 * (loadReadable), the sources visible to the reader, up to 20. Shown closed titles — the derivation_sources event before the
 * answer: if the log did not take it — no answer. A record that is not a retelling — kind null and an empty list.
 */
export async function recordDerivationSources(app: App, caller: Caller, id: string): Promise<RecordDerivationSourcesView> {
  await requireHuman(app, caller, "Retelling sources", { path: `/records/${id}`, section: "Record" });
  if (!isUuidParam(id)) throw notFound();
  const { rec, spaces } = await loadReadable(app, caller, id);
  const found = (await derivationFor(app, caller, [{ id: rec.id, cls: rec.class, attrs: rec.attrs }], { spaces, max: DERIVATION_PAGE_MAX })).get(rec.id);
  if (!found) return { kind: null, sources: [], note: null };
  await auditShownClosed(app, caller, found.closed, DERIVATION_SOURCES_OP);
  return { kind: found.mark.kind, sources: found.mark.sources, note: found.mark.note };
}
