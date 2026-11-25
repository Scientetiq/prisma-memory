// Document versions. A new version of an uploaded document is requested
// explicitly — `replaces = <record id>` on POST /api/v1/ingest/documents (multipart field or JSON property) and, after the
// contract change, on memory_upload. The version reuses the chain machinery of agent notes (version-chain.ts,
// see there): it is written next to the current head, in the head's space and class database, and the head stops being
// current in the same transaction (supersedeInTx). Delete, restore, close, open, space move and purge then act on the whole
// chain without any further code.
//
// Rules of this module:
// - The chain has ONE owner: the new version belongs to the owner of the head, the uploader is kept in `attrs.uploaded_by`
//   and in the audit event (like a correction of a note, corrections.ts). An owner of the space who replaces a member's
//   document in the workspace therefore does not take the document over: the author keeps closing, opening and deleting
//   the whole chain, and nobody can open another person's older text to agents by uploading a version on top of it.
// - Who may add a version: the author of the head with any credential that may write to the space; an owner of the space
//   who is not the author only in a human workspace session (never in "Company knowledge", where curators work in review).
// - The class of the new version is the class of the head (`classOverride`, no personal-open or keep-closed path): a closed
//   head gets a closed version, an open head needs a version that passes the open check — a finding refuses the upload and
//   the previous version stays current. A caller who cannot read the head's class gets not_found, never a hint that the
//   head exists.
// - Locks: the record lock of the head first (the same lock the worker's class move holds), then the "same file" key lock
//   of upload(): two versions uploaded at once queue; the second one becomes version N+2 on top of the first.
// - Text formats are one phase: the head is superseded at upload. PDF and office files are two-phase: the
//   text exists only after the worker's conversion and open check, so the new version is written as a record of its own
//   with `attrs.version_pending = {of, places}` and an empty supersedes_id — the old version stays current and searchable —
//   and the worker replaces the head in the transaction that completes `converted` (workers/src/jobs/doc-version-finish.ts).
//   A failed conversion or a refused open check leaves the old version current. Not in "Company knowledge": a pending
//   record there would enter the curators' review as a separate write.
import { archivedDenied, binder, CHAIN_HEAD, CHAIN_MEMBERS, CONVERTER_FAST_PROFILE, decodeVariants, legacyScanCharsetsOf, DOC_CHAIN_KINDS, legacyCharsetOf, inProgress, instanceTz, invalid, isChainType, jsonTextVariants, log,
         MARK_VERSION_RETRIED_SQL, MemoryError, newId,
         notFound, recordPath, recordText, textCharset, tx, versionPendingOf, visibleSql, type ConverterFormat, type DataClass, type VersionPending } from "@memory/shared";
import type pg from "pg";
import type { Hono } from "hono";
import type { App, Caller } from "./context.ts";
import { canWrite, loadReadable, readableSpaces, resolveSpace, type RecordRow, type SpaceAccess } from "./access.ts";
import { byIdSpec, byIdVisible, recordVisible } from "./visibility.ts";
import { auditShownClosed } from "./audit.ts";
import { isHumanSession } from "./workplace.ts";
import { admitRecord, checkDomains, createRecord, dropUncommittedLocators, originalKey, parseWhen, resolveEntities, stagesOf, type NewRecord, type ResolvedEntities } from "./records.ts";
import { sameFileKey, withKeyLock } from "./control-lock.ts";
import { withRecordLocksWait } from "./owner-lock.ts";
import { withUploadDaily } from "./limits.ts";
import { docVersionText } from "./doc-versions.messages.ts";
import { isUuidParam } from "./paging.ts";

/** What upload() already worked out before it hands a `replaces` request over (format, names, hashes, entity keys). */
export interface VersionPrep {
  mime: string;
  converting: boolean;
  format?: ConverterFormat;
  /** "Same file" hashes of upload() (uploadHashes): the first one is over the NFC name and is stored with the new version. */
  hashes: Buffer[];
  entityKeys?: string[];
}

export interface VersionArgs {
  filename: string; bytes: Buffer; replaces?: unknown; space?: string; title?: string; occurred_at?: string; entities?: string[]; domains?: string[]; sourceRef?: string;
}

/**
 * Version facts that REST returns next to upload()'s result (the MCP output schema of memory_upload has no such fields yet).
 * `pending` — a converted version waiting for the worker: REST answers `version_pending: true`.
 */
export interface ChainFacts { version: number; supersedes_id: string | null; pending?: true }

/**
 * Version facts of a row that upload() answers with ("the same file"): REST returns them, memory_upload does not yet. A row
 * that is a converted version still being processed is marked pending — the same file uploaded again is that record.
 */
export const chainFacts = (r: { version?: number | null; supersedes_id?: string | null; attrs?: unknown }): ChainFacts =>
  ({ version: Number(r.version ?? 1), supersedes_id: r.supersedes_id ?? null, ...(versionPendingOf(r.attrs)?.state === "processing" ? { pending: true as const } : {}) });

/**
 * The `note` of an answer that resolved the bytes of an older version to the current one; null when it did not. `readable` —
 * the caller reads the class of the document: only then can it follow "upload with replaces" (a key that does not read
 * the closed class is sent to the workspace instead).
 */
export const olderVersionNote = (r: { id: string; version?: number | null; older?: number }, readable = true): string | null =>
  r.older === undefined ? null
    : readable ? docVersionText("older_version", { n: r.older, m: Number(r.version ?? 1), id: r.id })
    : docVersionText("older_version_workspace", { n: r.older, m: Number(r.version ?? 1) });

/** Do the bytes of the request (the "same file" hashes of upload()) equal the stored hash of a row? */
export const sameBytes = (hashes: readonly Buffer[], stored: Buffer | null | undefined): boolean =>
  !!stored && hashes.some((h) => Buffer.compare(h, stored) === 0);

/**
 * "The same file" through a class database the caller reads (a workspace session, an extended key): no current document has
 * these bytes, but an older version of a document the caller reads does. The answer is the chain head (the caller must read
 * it too) with the version the bytes belong to — never a non-current id and never a new unrelated record. Visibility is
 * part of the query, before its LIMIT: older versions of other people's documents with the same bytes (a blank template
 * many people uploaded and replaced) never push the caller's own one out of the page.
 */
export async function olderVersionHit(db: pg.Pool, caller: Caller, cls: DataClass, hashes: Buffer[], spaces: Map<string, SpaceAccess>)
  : Promise<{ head: RecordRow; version: number } | null> {
  const args: unknown[] = [], bind = binder(args);
  const visible = visibleSql(byIdSpec(caller, spaces), cls, bind);
  if (visible === null) return null;
  const rows = (await db.query(
    `SELECT r.* FROM records r WHERE r.source_hash = ANY(${bind(hashes)}::bytea[]) AND r.type = 'document' AND r.parent_id IS NULL AND NOT r.is_current
        AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND r.source_kind::text = ANY(${bind([...DOC_CHAIN_KINDS])}::text[]) AND ${visible}
      ORDER BY r.version DESC LIMIT 20`, args)).rows as RecordRow[];
  for (const old of rows) {
    if (!(await recordVisible(db, caller, old, spaces))) continue;
    const headId = (await db.query(CHAIN_HEAD, [old.id])).rows[0]?.id as string | undefined;
    if (!headId || headId === old.id) continue;
    const head = (await db.query("SELECT * FROM records_live WHERE id = $1", [headId])).rows[0] as RecordRow | undefined;
    if (head && await recordVisible(db, caller, head, spaces)) return { head, version: old.version };
  }
  return null;
}

type Target = { rec: RecordRow; space: SpaceAccess; spaces: Map<string, SpaceAccess> };

const versionDenied = (key: boolean): MemoryError =>
  new MemoryError("forbidden", docVersionText(key ? "version_denied_key" : "version_denied"), { reason: "version_denied" });

/**
 * The document that `id` names, checked for "may this caller add a version of it". Order of the refusals: not readable →
 * not_found (nothing about the record is revealed); not a root uploaded document → invalid `not_versionable`; not the
 * author and not allowed as a space owner → forbidden `version_denied`; read-only or archived space; `space` names another
 * space → invalid `version_space`; not the current version → invalid `not_current` with the current id when the caller
 * reads it (otherwise not_found).
 */
async function versionTarget(app: App, caller: Caller, id: string, spaceRef: string | undefined): Promise<Target> {
  const me = caller.person;
  if (!me) throw notFound();
  const spaces = await readableSpaces(app, caller, { archived: true });
  const { rec, db } = await loadReadable(app, caller, id, spaces);
  if (rec.type !== "document" || rec.parent_id !== null || !(DOC_CHAIN_KINDS as readonly string[]).includes(rec.source_kind))
    throw invalid(docVersionText("not_versionable"), { reason: "not_versionable", field: "replaces" });
  const space = spaces.get(rec.space_id);
  if (!space) throw notFound();
  if (rec.owner_id !== me.id) {
    if (space.role !== "owner" || space.kind === "org" || space.kind === "personal") throw versionDenied(false);
    if (!isHumanSession(caller)) throw versionDenied(true);
  }
  if (space.archived_at) throw archivedDenied(space.slug, space.archived_at);
  if (!canWrite(space)) throw new MemoryError("class_denied", docVersionText("read_only"));
  if (caller.service?.write_space_id && caller.service.write_space_id !== space.id) throw versionDenied(true);
  if (spaceRef !== undefined && spaceRef !== "") {
    const asked = await resolveSpace(app, caller, spaceRef, spaces);
    if (!asked || asked.id !== space.id) throw invalid(docVersionText("version_space"), { reason: "version_space", field: "space" });
  }
  if (!rec.is_current) {
    const headId = (await db.query(CHAIN_HEAD, [rec.id])).rows[0]?.id as string | undefined;
    const head = headId && headId !== rec.id ? await loadReadable(app, caller, headId, spaces).then((h) => h.rec, () => null) : null;
    if (!head) throw notFound();
    throw new MemoryError("invalid_argument", docVersionText("not_current"), { reason: "not_current", details: { reason: "not_current", current_id: head.id } });
  }
  // a head that is still being converted gets no version: superseding it would stop its conversion for good (its stages
  // become skipped), and a chain with an unconverted older version can never be shown to agents. A head whose
  // conversion failed has no checked text either — the new file goes in as a document of its own
  const conversion = (rec.attrs as { conversion?: { status?: unknown } } | null)?.conversion?.status;
  if (conversion === "pending") throw new MemoryError("in_progress", docVersionText("head_converting"), { retry_after: 60, reason: "head_converting" });
  if (conversion === "failed") throw invalid(docVersionText("head_not_converted"), { reason: "head_not_converted", field: "replaces" });
  return { rec, space, spaces };
}

/** Explicit entities of the head (named by the uploader, not found by a model): they move to the new version. */
async function headEntities(app: App, db: Pick<pg.Pool, "query">, headId: string): Promise<ResolvedEntities> {
  // a person named by the uploader who is also on the audience list is stored as `participant` (createRecord): both roles
  const ids = (await db.query("SELECT entity_id FROM record_entities WHERE record_id = $1 AND role IN ('mentioned','participant') AND method = 'stated_by_human'", [headId])).rows
    .map((r) => String(r.entity_id));
  if (!ids.length) return { known: [], unresolved: [] };
  const rows = (await app.db.control.query("SELECT id, kind, external_system, external_id FROM entities WHERE id = ANY($1::uuid[])", [ids])).rows;
  return { known: rows.map((r) => ({ id: String(r.id), kind: r.kind, externalSystem: String(r.external_system ?? ""), externalId: String(r.external_id ?? ""),
                                     key: `${r.kind}:${r.external_id ?? r.id}` })), unresolved: [] };
}

const RETRY = Symbol("version_retry");

/**
 * POST /api/v1/ingest/documents with `replaces` (and memory_upload once the contract has the argument): a new version of a
 * text document. upload() calls this right after the size, disk and format checks, before its own space and "same file"
 * logic — an upload without `replaces` never reaches this module.
 */
export async function uploadVersion(app: App, caller: Caller, a: VersionArgs, p: VersionPrep, headCaller: Caller = caller) {
  if (typeof a.replaces !== "string" || !isUuidParam(a.replaces)) throw invalid(docVersionText("bad_id"), { field: "replaces" });
  let target = await versionTarget(app, headCaller, a.replaces, a.space);
  // two versions at once: the second one waits for the head's lock and finds the head superseded — it goes on top of the new
  // head (the same checks again), so the chain gets N+1 and N+2 and keeps one head
  for (let attempt = 0; attempt < 5; attempt++) {
    const t = target;
    // the locks of the WHOLE chain, not only of the head: an owner operation (space move, close, delete) takes the lock of
    // the id it is given, which may be an older version — while a version is written none of them interleaves
    const ids = [...new Set([t.rec.id, ...(await app.db.records(t.rec.class, headCaller.scope).query(CHAIN_MEMBERS, [[t.rec.id]])).rows.map((r) => String(r.id))])];
    const out = await withRecordLocksWait(app, ids, async () => {
      // under the locks everything about the head is read again (space, owner, audience, class, state, rights): a space move,
      // a narrowed audience or a newer version may have committed while this call waited for them
      const fresh: Target | typeof RETRY = await versionTarget(app, headCaller, t.rec.id, a.space).catch((e: unknown): typeof RETRY => {
        if (e instanceof MemoryError && e.extra.reason === "not_current") return RETRY;
        throw e;
      });
      if (fresh === RETRY) return RETRY;
      return withKeyLock(sameFileKey(p.hashes[0]!), () => writeVersion(app, caller, a, p, fresh, headCaller));
    });
    if (out !== RETRY) return out;
    target = await versionTarget(app, headCaller, t.rec.id, a.space).catch(async (e: unknown) => {
      const current = e instanceof MemoryError && e.extra.reason === "not_current" ? (e.extra.details as { current_id?: string } | undefined)?.current_id : undefined;
      if (!current) throw e;
      return versionTarget(app, headCaller, current, a.space);
    });
  }
  throw inProgress(5);
}

async function writeVersion(app: App, caller: Caller, a: VersionArgs, p: VersionPrep, t: Target, headCaller: Caller): Promise<typeof RETRY | Awaited<ReturnType<typeof answer>>> {
  const cls: DataClass = t.rec.class;
  const headDb = app.db.records(cls, headCaller.scope);
  // under the head's lock: the head is still the current, live head of this class, or the caller starts again
  const loc = (await app.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [t.rec.id])).rows[0] as { class: DataClass; deleted: boolean } | undefined;
  if (!loc || loc.deleted) throw notFound();
  const now = (await headDb.query("SELECT id, version, is_current, deleted_at, hidden_at, source_hash FROM records WHERE id = $1", [t.rec.id])).rows[0];
  if (loc.class !== cls || !now || now.deleted_at || now.hidden_at) throw inProgress(10);
  if (!now.is_current) return RETRY;
  // the same bytes as the current version: nothing new to keep
  if (sameBytes(p.hashes, now.source_hash as Buffer | null))
    return answer(app, caller, t, { id: t.rec.id, version: t.rec.version, supersedes_id: t.rec.supersedes_id, already: true, cls, occurred: t.rec.occurred_at, dropped: 0, bytes: a.bytes.length });
  const converting = p.converting;
  if (converting && t.space.kind === "org") throw invalid(docVersionText("version_format_org"), { reason: "version_format_org", field: "replaces" });
  // the same file is already being processed as a new version of this document (a second click, a retried
  // request) — uploaded on top of this head or of an older version of the chain (a text version landed meanwhile)
  if (converting) {
    const chain = [t.rec.id, ...(await headDb.query(CHAIN_MEMBERS, [[t.rec.id]])).rows.map((r) => String(r.id))];
    const twin = (await headDb.query(
      `SELECT id, version, occurred_at, attrs FROM records_live WHERE space_id = $1 AND type = 'document' AND parent_id IS NULL AND attrs -> 'version_pending' ->> 'of' = ANY($2::text[])
          AND source_hash = ANY($3::bytea[]) ORDER BY ingested_at DESC LIMIT 5`, [t.space.id, chain, p.hashes])).rows
      .find((r) => versionPendingOf(r.attrs)?.state === "processing");
    if (twin) return answer(app, caller, t, { id: String(twin.id), version: Number(twin.version), supersedes_id: null, already: true, pending: true, cls, occurred: twin.occurred_at,
                                              dropped: 0, bytes: a.bytes.length });
  }

  const me = caller.person!;
  const legacy = legacyCharsetOf(app.settings);
  const readings = converting ? [""] : decodeVariants(a.bytes, legacy, legacyScanCharsetsOf(app.settings)).map(recordText);
  const [text = "", ...otherReadings] = readings;
  const jsonReadings = [...new Set(readings.flatMap((r) => jsonTextVariants(r, p.mime)))];
  const entities = a.entities !== undefined ? await resolveEntities(app, p.entityKeys ?? a.entities, caller) : await headEntities(app, headDb, t.rec.id);
  const audience = t.rec.audience === "people"
    ? (await headDb.query("SELECT person_id FROM record_people WHERE record_id = $1", [t.rec.id])).rows.map((r) => String(r.person_id)) : undefined;
  const headTitleIsName = t.rec.title !== null && t.rec.title === t.rec.attrs?.filename;
  const version = t.rec.version + 1;
  const recordId = newId();
  // placements of the head move to the new version only into spaces the uploader may still write to
  const placements = (await headDb.query("SELECT space_id, placed_by FROM record_placements WHERE record_id = $1", [t.rec.id])).rows as Array<{ space_id: string; placed_by: string | null }>;
  const kept = placements.filter((pl) => { const s = t.spaces.get(pl.space_id); return !!s && canWrite(s); });
  // a converted format: no text yet — a record of its own until the worker supersedes the head (`version_pending`); the
  // placements move then, into the spaces checked now
  const pendingMark: Pick<VersionPending, "of" | "places"> | null = converting ? { of: t.rec.id, places: kept.map((pl) => pl.space_id) } : null;
  const draft: NewRecord = {
    id: recordId, type: "document", space: t.space, classOverride: cls, title: a.title?.trim() || (headTitleIsName ? a.filename : t.rec.title) || a.filename, text,
    method: "source_document", origin: "human", sourceKind: t.rec.source_kind as NewRecord["sourceKind"], sourceRef: a.sourceRef ?? t.rec.source_ref ?? a.filename,
    sourceHash: p.hashes[0]!, occurredAt: a.occurred_at ? parseWhen(a.occurred_at, instanceTz(app.settings)) : new Date(t.rec.occurred_at),
    domains: a.domains !== undefined ? checkDomains(app, a.domains) : [...(t.rec.domain_tags ?? [])], entities, ownerId: t.rec.owner_id,
    ...(audience ? { audiencePeople: audience } : {}),
    attrs: pendingMark
      ? { filename: a.filename, conversion: { status: "pending", profile: CONVERTER_FAST_PROFILE }, uploaded_by: me.id, version_pending: pendingMark }
      : { filename: a.filename, original_charset: textCharset(a.bytes, legacy), uploaded_by: me.id },
    openCheckExtra: [...otherReadings, ...jsonReadings].map((value) => ({ field: "text" as const, value })),
    ...(converting ? { needsConversion: true, ...(p.format ? { convertFormat: p.format } : {}) } : {}),
    version, supersedesId: pendingMark ? null : t.rec.id,
    auditDetails: { op: "version", ...(pendingMark ? { of: t.rec.id, pending: true } : { supersedes: t.rec.id }), version,
                    ...(t.rec.owner_id !== me.id ? { by: "space_owner", author: t.rec.owner_id } : {}) },
  };
  const created = await withUploadDaily(app, caller, a.bytes.length, async () => {
    // an open head: admitRecord runs the hard open check over the title, text, file name and every other reading. Its
    // findings do not depend on the space (openCheckOutcome reads the texts, the owner and the settings only), so the
    // spaces the head is placed in need no check of their own: the same texts would give the same answer
    const admitted = await admitRecord(app, caller, draft).catch((e: unknown) => { throw withOpenHint(e); });
    const key = originalKey(app.instanceId, draft.occurredAt, p.hashes[0]!, recordId, a.filename);
    // storage down: the text version is accepted without its original, as a plain upload is (the loss is logged, not swallowed)
    const stored = await app.storage.put(admitted.cls, key, a.bytes, p.mime).catch((e: Error) => { log.warn("original_not_stored", { class: admitted.cls, error: e.message.slice(0, 160) }); return false; });
    // …except a file for the converter: it reads the original from storage, there is nothing to convert without it
    if (converting && !stored) throw invalid(docVersionText("original_not_stored"));
    draft.original = { key: stored ? key : null, mime: p.mime, bytes: a.bytes.length, pages: null, language: null };
    const effects: Array<() => Promise<unknown>> = [];
    let made: Awaited<ReturnType<typeof createRecord>> | null = null;
    try {
      made = await tx(app.db.recordsForWrite(cls, caller.scope), async (c) => {
        const cr = await createRecord(app, caller, draft, admitted, { records: c, effects });
        for (const pl of pendingMark ? [] : kept)
          await c.query("INSERT INTO record_placements (record_id, space_id, placed_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [cr.id, pl.space_id, pl.placed_by]);
        return cr;
      });
    } catch (e) {
      await dropUncommittedLocators(app.db.control, [recordId]);
      throw e;
    }
    for (const run of effects) await run();
    return made;
  });
  return answer(app, caller, t, { id: created.id, version, supersedes_id: pendingMark ? null : t.rec.id, already: false, ...(pendingMark ? { pending: true as const } : {}),
                                  cls: created.class, occurred: draft.occurredAt, dropped: placements.length - kept.length, bytes: a.bytes.length });
}

/** A refusal of the open check on a version: the hint says how to get the new text in (close first, or remove the details). */
function withOpenHint(e: unknown): unknown {
  if (!(e instanceof MemoryError) || e.code !== "open_check") return e;
  return new MemoryError("open_check", e.message, { ...e.extra, hint: docVersionText("open_check_hint") });
}

async function answer(app: App, caller: Caller, t: Target, o: { id: string; version: number; supersedes_id: string | null; already: boolean; pending?: true; cls: DataClass;
                                                               occurred: Date | string; dropped: number; bytes: number }) {
  const path = recordPath(t.space.slug, "document", new Date(o.occurred), o.id);
  const stages = await stagesOf(app.db.recordsForWrite(o.cls, caller.scope), o.id);
  const same = o.pending ? docVersionText("pending_same_bytes", { v: o.version }) : docVersionText("same_bytes");
  const note = o.already ? same : o.dropped ? docVersionText(o.pending ? "placements_dropped_pending" : "placements_dropped", { count: o.dropped }) : null;
  const result = { id: o.id, path, type: "document", space: t.space.slug, class: o.cls, already_known: o.already, bytes: o.bytes, placed: true, note,
                   stages, queue: { lane: "night" as const, position: null, eta_sec: null } };
  const text = o.already ? `${same}: ${path}`
    : `${docVersionText(o.pending ? "accepted_pending" : "accepted", { v: o.version, path, cls: o.cls })}${note ? ` · ${note}` : ""}`;
  const chain: ChainFacts = { version: o.version, supersedes_id: o.supersedes_id, ...(o.pending ? { pending: true as const } : {}) };
  return { result, text, chain };
}

/**
 * The current version of a document that a connector keeps under a stable source id (folder and drive
 * connectors): the live head among root documents of `sourceKind` with this `sourceRef` in the space, in the classes the
 * caller reads. Reads `records_live`, so it returns heads only; null when there is none — and when the caller does not read
 * the space or the head (an outsider, a member outside a narrowed audience): the answer never names a record the caller
 * cannot read. The connector then calls the version path with `replaces` = the returned id (or a plain upload when null).
 */
export async function findCurrentBySource(app: App, caller: Caller, space: Pick<SpaceAccess, "id">, sourceKind: (typeof DOC_CHAIN_KINDS)[number], sourceRef: string)
  : Promise<{ id: string; class: DataClass; version: number } | null> {
  if (!(DOC_CHAIN_KINDS as readonly string[]).includes(sourceKind) || !sourceRef || !caller.person) return null;
  // an archived space takes no new version and no new file: it is not looked into
  const spaces = await readableSpaces(app, caller);
  if (!spaces.has(space.id)) return null;
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [space.id, sourceKind, sourceRef], bind = binder(args);
    const visible = visibleSql(byIdSpec(caller, spaces), cls, bind);
    if (visible === null) continue;
    const db = app.db.records(cls, caller.scope);
    const rows = (await db.query(
      `SELECT r.* FROM records_live r WHERE r.space_id = $1 AND r.source_kind = $2 AND r.source_ref = $3 AND r.type = 'document' AND r.parent_id IS NULL AND ${visible}
        ORDER BY r.version DESC, r.ingested_at DESC LIMIT 20`, args)).rows as RecordRow[];
    for (const row of rows)
      if (await recordVisible(db, caller, row, spaces)) return { id: String(row.id), class: cls, version: Number(row.version) };
  }
  return null;
}

/** A version waiting for the worker: `processing`, or `failed` with the reason and a text for the author. */
export interface VersionPendingView { state: VersionPending["state"]; reason: VersionPending["reason"]; note: string | null }

export interface VersionItem { id: string; version: number; is_current: boolean; ingested_at: string; by: string | null; title: string | null; bytes: number | null; filename: string | null;
                               pending?: VersionPendingView }

/**
 * GET /api/v1/records/:id/versions — the version chain of any record the caller reads, newest first. Each version is
 * listed only if the caller may read it by id (byIdVisible); titles of closed versions shown to the caller are journaled
 * (auditShownClosed, op `versions`), like every other list of closed titles. A record without a chain lists itself.
 * Converted versions waiting for the worker (`attrs.version_pending`) are listed with `pending` and
 * `is_current: false` — they are not in the chain until the worker supersedes the head; asking by the id of such a record
 * lists the chain it was uploaded on top of. A version the worker refused (`final`) is a failed upload of its own: it is
 * listed only when asked by its own id (its row's real `is_current`, the reason in `pending`), never in the history of
 * the document it was meant for — that history has one current version, the head.
 */
export async function recordVersions(app: App, caller: Caller, id: string): Promise<{ items: VersionItem[] }> {
  const { rec, db, spaces } = await loadReadable(app, caller, id);
  let ids = [rec.id];
  if (isChainType(rec.type)) {
    const own = versionPendingOf(rec.attrs);
    const from = own && !own.final && (await db.query("SELECT 1 FROM records WHERE id = $1", [own.of])).rowCount ? own.of : rec.id;
    const head = ((await db.query(CHAIN_HEAD, [from])).rows[0]?.id as string | undefined) ?? from;
    ids = [...new Set([rec.id, head, ...(await db.query(CHAIN_MEMBERS, [[head]])).rows.map((r) => String(r.id))])];
    if (rec.type === "document" && rec.parent_id === null)
      ids.push(...(await db.query(
        `SELECT id FROM records_live WHERE space_id = $1 AND type = 'document' AND parent_id IS NULL AND attrs ? 'version_pending' AND attrs -> 'version_pending' ->> 'of' = ANY($2::text[])
            AND attrs -> 'version_pending' -> 'final' IS DISTINCT FROM 'true'::jsonb`,
        [rec.space_id, ids])).rows.map((r) => String(r.id)).filter((x) => !ids.includes(x)));
  }
  const visible = (await byIdVisible(db, caller, rec.class, ids, spaces)).map((r) => r.id);
  if (!visible.length) return { items: [] };
  const rows = (await db.query(
    `SELECT r.id, r.version, r.is_current, r.ingested_at, r.owner_id, r.title, r.attrs ->> 'filename' AS filename, r.attrs ->> 'uploaded_by' AS uploaded_by, c.original_bytes,
            jsonb_build_object('version_pending', r.attrs -> 'version_pending', 'conversion', r.attrs -> 'conversion') AS marks
       FROM records r LEFT JOIN record_content c ON c.record_id = r.id WHERE r.id = ANY($1::uuid[]) ORDER BY r.version DESC, r.ingested_at DESC`, [visible])).rows;
  const who = [...new Set(rows.map((r) => String(r.uploaded_by ?? r.owner_id)))];
  const logins = new Map((await app.db.control.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [who])).rows.map((p) => [String(p.id), String(p.login)]));
  // closed titles shown in the history are journaled on every call, a history of the asked record alone included: the
  // route is callable without any read of the record, and it shows the title, file name, uploader and size (the
  // record page's second event per view is the accepted cost)
  if (rec.class === "closed") await auditShownClosed(app, caller, rows.filter((r) => r.title !== null).map((r) => String(r.id)), "versions");
  return { items: rows.map((r) => {
    const pending = versionPendingOf(r.marks);
    return { id: String(r.id), version: Number(r.version), is_current: r.is_current === true && !(pending && !pending.final), ingested_at: new Date(r.ingested_at).toISOString(),
             by: logins.get(String(r.uploaded_by ?? r.owner_id)) ?? null, title: r.title ?? null,
             bytes: r.original_bytes === null || r.original_bytes === undefined ? null : Number(r.original_bytes), filename: r.filename ?? null,
             ...(pending ? { pending: { state: pending.state, reason: pending.reason, note: pending.reason ? docVersionText(`pending_${pending.reason}`) : null } } : {}) };
  }) };
}
/**
 * "Process now" (write.ts processNow), before the stages are reset: a pending version whose `converted` stage failed is
 * marked retried, whatever failed it (the converter, the sweep of a stuck pass, a lost failure mark) — the worker's
 * finisher then keeps a version added meanwhile current (`head_newer`). No-op for any other record.
 */
export async function markVersionRetried(db: Pick<pg.Pool, "query">, id: string): Promise<void> {
  await db.query(MARK_VERSION_RETRIED_SQL, [id]);
}

/**
 * The version facts of a record in the status batch (the badge of "My records"), given only when the workspace asks
 * for them (`with=version`): `version` of an uploaded root document with earlier versions, and `version_pending` —
 * `processing` while the worker has not finished a converted new version, `failed` when it did not replace the current
 * one. Nothing for any other record: a corrected note, a re-sent meeting or a part of a document answer as before
 * (RecordStatus of the contract has no such fields yet).
 */
export const versionStatusFields = (rec: { type: string; parent_id: string | null; source_kind: string; version: number; attrs: unknown }): { version?: number; version_pending?: VersionPending["state"] } => {
  if (rec.type !== "document" || rec.parent_id !== null || !(DOC_CHAIN_KINDS as readonly string[]).includes(rec.source_kind)) return {};
  const p = versionPendingOf(rec.attrs);
  return { ...(Number(rec.version) > 1 ? { version: Number(rec.version) } : {}), ...(p ? { version_pending: p.state } : {}) };
};

/**
 * GET /api/v1/records/:id/versions (rate bucket memory_read, the `read` operation of the key's allow-list): a non-uuid id
 * answers not_found like an unknown one, never a database error. The external channel does not reach it (channel.ts
 * serves only its own short list of paths there).
 */
export function registerVersions(r: Hono<any>, app: App, requireRead: (caller: Caller) => void): void {
  // the route is in the intake contract: a literal path, checked like every other route
  r.get("/api/v1/records/:id/versions", async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "memory_read");
    requireRead(caller);
    const id = c.req.param("id") ?? "";
    if (!isUuidParam(id)) throw notFound();
    return c.json(await recordVersions(app, caller, id));
  });
}
