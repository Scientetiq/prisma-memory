// Records: creation (remember, upload, transcript intake), stages, views by the contract.
// The LLM classifies — the code decides: the class, space, owner, area and time are set by the gateway.
import { createHash } from "node:crypto";
import { carryOrgReview, despiteSettings, nightWindowOf, ensureProjectEntity, entityNameNeedsOpenCheck, exemptKindOf, inWindow, log, projectEntityReadable, undoCarryOrgReview, type NightWindow,
         type OrgReviewState, type DerivedKind, type ConverterFormat, CHAIN_TREE, safeFileName, SUPERSEDED_STAGE_NOTE, supersedeInTx, WALL_TIME, zonedWallToInstant } from "@memory/shared";
import type pg from "pg";
import { acceptedReasons, archivedDenied, classDenied, entityId, estimateTokens, invalid, MemoryError, neverOpenFindings, newId, openableByWord, openCheckFallback, openCheckView, openCheckViewOf, parseEntityKey,
         parseOpenCheckAccepted, parseOpenCheckFallback, recordPath, tooLarge, tx, type ByWordConfirmation, type DataClass, type EntityKey, type OpenCheckFallback, type OpenCheckText,
         type OpenCheckView } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { canWrite, locate, type RecordRow, type SpaceAccess } from "./access.ts";
import { isExternal } from "./channel.ts";
import { audit } from "./audit.ts";
import { guardOpen, guardOpenKeepClosed, guardOpenSoft, type OpenVia } from "./open-check.ts";
import { extendedOpenGate, markAttrs, markEvent, type ExtendedMark } from "./extended-open.ts";
import { derivationGate, derivationVerdict, derivedPrint, loadSources, widenedMark, type Classes, type WidenedMark } from "./derivation.ts";
import { enterOrg, isHumanSession, isOrgCurator } from "./org-review.ts";
import { gateSnapshot, LLM_STAGES, type GateSnapshot } from "./llm-gate-admin.ts";
import { nightCapped } from "./night-cap.ts";
import { nowPriorityOf } from "./queue.ts";

/**
 * A record's place in the queue: the "now" lane — while the record has `process_now_at` (meeting intake
 * by code, the "process now" button); else the night, and if memory chose the night over the default order — with a reason:
 * `model_busy` (the model was busy past the "now" patience `processing.llm_retry.now_patience_min` — the worker or scheduler
 * moved the meeting to the night; busyness does not spend attempts), `daytime_cap` (the daytime token ceiling — intake).
 * `pending` — how many stages lie ahead of the record itself: the wait estimate comes from it; without it — null.
 *
 * `extended` — the REST status of a record and of "Meetings with me": also `paused` (model calls paused or
 * not allowed, and the record waits for a model stage), `too_slow` (the model cannot answer this record in time) and `retry_at`
 * (when the next try is). Without it — the old answer: `too_slow` is given as `model_busy`, no `retry_at` — so it goes into
 * all MCP answers, the MCP contract does not change.
 *
 * `night_cap` — also only with `extended`: a night-lane record waits for a stage with a
 * model, and the current window (by day — the past night) hit the night ceiling `processing.nighttime_token_cap`.
 */
export type QueueReason = "model_busy" | "daytime_cap" | "paused" | "too_slow" | "night_cap";
export interface QueueView { lane: "now" | "night"; position: number | null; eta_sec: number | null; reason?: QueueReason; retry_at?: string | null }
export interface StageWait { stage: string; status: string; busy_retries?: number; slow_retries?: number; retry_at?: string | null }

/**
 * The record's lane and the clock for the wait reason: "now" — by parameter, the window — the `processing.night_window` setting;
 * `nightCapped` — the window hit the night ceiling (night-cap.ts); no — it did not.
 */
export interface QueueClock { lane: "now" | "night"; now: Date; win: NightWindow; nightCapped?: boolean }

/** Can the record run now: the "now" lane or the night window. A broken window setting — "not night": the status never fails. */
export function runnableNow(clock: QueueClock): boolean {
  if (clock.lane === "now") return true;
  try { return inWindow(clock.win, clock.now); } catch { return false; }
}

/**
 * The wait reason by the rules — pure: (1) pause and a waiting stage with a model → paused; (2) too_slow; (3) the waiting
 * stage had "busy"/"slow" → model_busy with the term max(stage term, backoff end); an open instance backoff by
 * itself — model_busy with the backoff end term, only if the record can run now (the "now" lane or the night
 * window): outside it a night meeting waits for the night, not the model; (4) otherwise — the reason from attrs (as before).
 * The night ceiling — after pause and "too slow", before "busy": for the night lane with a model stage waiting
 * (`pending`), with the window capped — night_cap: this stage will not go until the next night, however free the model gets.
 */
export function queueReason(deferred: unknown, stages: StageWait[], gate: GateSnapshot | null, clock: QueueClock): { reason?: QueueReason; retry_at?: string | null } {
  const waiting = stages.filter((s) => LLM_STAGES.includes(s.stage) && (s.status === "pending" || s.status === "running"));
  if (gate?.paused && waiting.length) return { reason: "paused", retry_at: null };
  if (deferred === "too_slow") return { reason: "too_slow", retry_at: null };
  if (clock.nightCapped && clock.lane === "night" && waiting.some((s) => s.status === "pending")) return { reason: "night_cap", retry_at: null };
  const busy = waiting.filter((s) => (s.busy_retries ?? 0) > 0 || (s.slow_retries ?? 0) > 0);
  if (busy.length || (gate?.breakerOpen && waiting.length && runnableNow(clock))) {
    const times = [...busy.map((s) => s.retry_at), gate?.breakerOpen ? gate.openUntil : null].filter((x): x is string => !!x).map((x) => Date.parse(x));
    return { reason: "model_busy", retry_at: times.length ? new Date(Math.max(...times)).toISOString() : null };
  }
  if (deferred === "model_busy" || deferred === "daytime_cap") return { reason: deferred, retry_at: null };
  return {};
}

export async function queueOf(app: App, attrs: Record<string, any> | null | undefined, pending?: number,
                              opts?: { extended?: boolean; stages?: StageWait[] }): Promise<QueueView> {
  const base: QueueView = attrs?.process_now_at
    ? await app.queue.nowPosition(app.db.control, nowPriorityOf(attrs)).then((position) => ({ lane: "now" as const, position, eta_sec: position === null || pending === undefined ? null : (position + pending) * 45 }))
    : { lane: "night", position: null, eta_sec: null };
  const deferred = attrs?.deferred_reason;
  if (!opts?.extended) {
    // the old answer: a reason only for the night and only model_busy or daytime_cap; "too slow" — as "busy"
    const reason = deferred === "too_slow" ? "model_busy" : deferred === "model_busy" || deferred === "daytime_cap" ? deferred : null;
    return attrs?.process_now_at || !reason ? base : { ...base, reason };
  }
  const stages = opts.stages ?? [];
  const gate = stages.some((s) => LLM_STAGES.includes(s.stage) && (s.status === "pending" || s.status === "running"))
    ? await gateSnapshot(app).catch(() => null) : null;
  // the night ceiling — one read (5 s cache) and only for the night lane with a waiting model stage
  const capped = base.lane === "night" && stages.some((s) => LLM_STAGES.includes(s.stage) && s.status === "pending") ? await nightCapped(app) : false;
  const r = queueReason(attrs?.process_now_at ? null : deferred, stages, gate,
                        { lane: base.lane, now: new Date(), win: nightWindowOf(app.settings), nightCapped: capped });
  return r.reason ? { ...base, reason: r.reason, retry_at: r.retry_at ?? null } : base;
}

export interface StageView {
  stage: string; status: string; version: string | null; attempts: number; terminal: boolean; last_error: string | null; updated_at: string;
  /** Only with extended: when the next try is, how many times the model was busy or slow, since when. */
  retry_at?: string | null; busy_retries?: number; slow_retries?: number; first_busy_at?: string | null;
}

/**
 * The order of stages in the answer is the ROUTE order, not the enum value order: for a document described comes after indexed
 * but before entities, while `ORDER BY stage` showed it last, and the panel drew the pipeline in the wrong order.
 * One list covers both routes: a transcript — indexed → summary → events → entities,
 * a document — converted → indexed → described → entities. `moved` — the class move pseudo-stage, always at the end.
 */
export const STAGE_ORDER: readonly string[] = ["converted", "indexed", "summary", "events", "described", "entities", "moved"];
export const stageRank = (stage: string): number => { const i = STAGE_ORDER.indexOf(stage); return i < 0 ? STAGE_ORDER.length : i; };

export async function stagesOf(db: pg.Pool | pg.PoolClient, recordId: string, opts?: { extended?: boolean }): Promise<StageView[]> {
  const ext = opts?.extended === true;
  const { rows } = await db.query(`SELECT stage, status, version, attempts, terminal, last_error, updated_at${ext ? ", retry_at, busy_retries, slow_retries, first_busy_at" : ""}
                                     FROM record_stages WHERE record_id = $1`, [recordId]);
  const t = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  // terminal — "a retry gives the same refusal": the panel shows this instead of a useless "Retry" button
  return rows.map((r) => ({ stage: r.stage, status: r.status, version: r.version, attempts: r.attempts, terminal: r.terminal === true, last_error: r.last_error, updated_at: new Date(r.updated_at).toISOString(),
                            ...(ext ? { retry_at: t(r.retry_at), busy_retries: r.busy_retries ?? 0, slow_retries: r.slow_retries ?? 0, first_busy_at: t(r.first_busy_at) } : {}) }))
    .sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.stage.localeCompare(b.stage));
}

/**
 * Which stages are created when a record appears. `needsConversion` — the document came not as text but in a converter
 * format: `converted` is added as the first stage, and it will bring the markdown. Text documents have no such row,
 * and the worker scheduler simply does not see it (nextStage skips a stage without a row).
 */
export function stagesFor(type: string, hasExplicitEntities: boolean, needsConversion = false): string[] {
  if (type === "transcript") return ["indexed", "summary", "events", "entities"];
  if (type === "document") return [...(needsConversion ? ["converted"] : []), "indexed", "described", "entities"];
  return hasExplicitEntities ? ["indexed", "entities"] : ["indexed"];
}

/**
 * One's own closed-class record through the eyes of a key that is not given the closed class (a personal T2 key).
 * Before, a read by id answered `not_found`, and the workplace wrote "no record", although opening and `memory_delete`
 * work by this same id. We give exactly the locator — the same fields as a hidden record in `memory_list`, plus the stages:
 * no name, no text, no summary, no entities, no original. Someone else's closed record — still
 * `not_found`; the path is shortened (no year and month) — the record cannot be read by it.
 *
 * The stages are a READ of the closed database: a SELECT of `record_stages` rows of one's own record from memory_closed
 * (stage, status, version, attempts, terminal, last_error — up to 200 chars of the worker error, updated_at). It goes through
 * the recordsForWrite("closed") pool, so the reads counter does not grow, but writes does (by_key_kind.writes.personal) — by
 * one per own closed record: memory_read by id or path, GET /records/:id/status, up to 50 per batch status.
 * A white-box test sees it (the writes delta on reading calls).
 * The old wording "no read of the closed database happens" was wrong. Whether it should be so (stages from the closed database,
 * a locator only from control, or a ban) is an open question; until it is settled the behavior does not change.
 *
 * The external agents' address says nothing about closed: ownHiddenRecord there is null, and reading one's own
 * closed record gives the usual "no record", as for a missing one.
 */
export interface HiddenRecordView {
  id: string; path: string; type: string; class: "closed"; hidden: true; space: string; owner: string;
  created_at: string | null; stages: StageView[];
  /** The record is closed by the open check (personal open): the reason without the match — to the author. */
  open_check?: OpenCheckView;
  /** The record's space is in an archive: read only — as in the full view. */
  space_archived?: true;
}

/**
 * Gate 5 of opening by word: the root is in one's own personal space; all tree rows are there too and with
 * the "space" area; no placements outside personal; in the record's people list — nobody but the owner. The closed
 * database is read by the system context (tree rows, deleted ones too — a move copies them as well), without content.
 */
export async function byWordTreeOk(app: App, recordId: string, spaceId: string, ownerId: string, control: Pick<pg.Pool, "query"> = app.db.control): Promise<boolean> {
  const sp = (await control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [spaceId])).rows[0];
  if (!sp || sp.kind !== "personal" || sp.owner_id !== ownerId) return false;
  const db = app.db.records("closed", { classes: ["open", "closed"] as const, tier: "system" as const });
  // the tree and the version chain of one's own note: the whole chain is opened — older versions must also be only in personal
  const r = (await db.query(`${CHAIN_TREE}
    SELECT (SELECT count(*) FROM records WHERE id IN (SELECT id FROM tree) AND (space_id <> $2 OR audience <> 'space'))::int AS foreign_rows,
           (SELECT count(*) FROM record_placements WHERE record_id IN (SELECT id FROM tree) AND space_id <> $2)::int AS placements,
           (SELECT count(*) FROM record_people WHERE record_id IN (SELECT id FROM tree) AND person_id <> $3)::int AS others,
           (SELECT count(*) FROM records WHERE id = $1)::int AS root`, [recordId, spaceId, ownerId])).rows[0];
  return r?.root === 1 && r.foreign_rows === 0 && r.placements === 0 && r.others === 0;
}

/**
 * The locator mark as the author sees it (contract OpenCheckOutcome), `by_word` by the record itself: a mark that opens
 * by word while the record is no longer only in one's own personal space (moved into a team, placed in another, has other
 * readers) — `by_word: false`, as the contract says: memory_open refuses (gate 5), the person decides. The tree in the closed
 * database is read (by the system context, without content) only for marks that open by word.
 */
export async function ownMarkView(app: App, id: string, spaceId: string, ownerId: string, raw: unknown): Promise<OpenCheckView | null> {
  const mark = parseOpenCheckFallback(raw);
  if (!mark) return null;
  return openCheckView(mark, { reachable: !openableByWord(mark) || await byWordTreeOk(app, id, spaceId, ownerId) });
}

/**
 * The mark of one's own closed record through the caller's eyes: whoever reads closed (a workplace
 * session, an extended own key, T0) — the full view, as before: they read the content itself. The rest (a personal key, a script)
 * — the full view only for a record in one's personal space; elsewhere (team, project, foreign) — the `foreign` view: "hidden",
 * the date and `by_word: false`, no kinds, rules, positions or reasons — an agent outside its personal space learns no findings.
 */
export async function markViewFor(app: App, caller: Caller, r: { id: string; spaceId: string; ownerId: string; raw: unknown }): Promise<OpenCheckView | null> {
  if (!parseOpenCheckFallback(r.raw)) return null;
  if (caller.scope.classes.includes("closed")) return ownMarkView(app, r.id, r.spaceId, r.ownerId, r.raw);
  const sp = (await app.db.control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [r.spaceId])).rows[0];
  if (sp?.kind === "personal" && caller.person && sp.owner_id === caller.person.id) return ownMarkView(app, r.id, r.spaceId, r.ownerId, r.raw);
  return openCheckViewOf(r.raw, { foreign: true });
}

/**
 * The personal open fallback mark for the full record view (`memory_read.metadata`, status): only to the author
 * and only for a closed one. One source for all paths — the locator (`locate` gives it only with class = closed,
 * a move into open resets it, and the worker writes it when the fallback move is finished): `attrs.open_check_fallback`
 * is history, after "open → close" it would bring back a stale reason.
 */
export async function ownOpenCheck(app: App, caller: Caller, rec: { id: string; class: DataClass; owner_id: string }): Promise<OpenCheckView | null> {
  if (rec.class !== "closed" || !caller.person || caller.person.id !== rec.owner_id) return null;
  const loc = await locate(app, rec.id);
  return loc ? ownMarkView(app, rec.id, loc.space_id, loc.owner_id, loc.open_check) : null;
}

/** The trace of an earlier opening by word on one's own closed record — `open_check_accepted` of the full view and the status. */
export interface OpenAcceptedView { at: string; confirmation: ByWordConfirmation; rules: string[]; reasons: string[] }

/**
 * The record was already opened by the person's word or shown by the button (the move worker writes `attrs.open_check_accepted`)
 * and closed: it has no check mark any more, an agent will not open it by word again
 * (one-time), and the plain "Show to agents" will refuse on the same finding. The author can show it again — "Make
 * available to agents" with a new consent in any area: so the trace is given without the "only one's own
 * personal" condition. Only to the author, only for a closed record with no mark. `attrs` — from the row the caller already read
 * (the full view — only to keys with the closed class).
 */
export async function ownOpenAccepted(_app: App, caller: Caller, rec: { id: string; class: DataClass; owner_id: string; space_id: string; attrs?: Record<string, any> | null },
                                      openCheck: OpenCheckView | null): Promise<OpenAcceptedView | null> {
  if (openCheck || rec.class !== "closed" || !caller.person || caller.person.id !== rec.owner_id) return null;
  const trace = parseOpenCheckAccepted(rec.attrs?.open_check_accepted);
  if (!trace) return null;
  return { at: trace.at, confirmation: trace.confirmation, rules: trace.rules, reasons: acceptedReasons(trace.rules) };
}

export async function ownHiddenRecord(app: App, caller: Caller, id: string): Promise<HiddenRecordView | null> {
  if (!caller.person || caller.scope.classes.includes("closed") || isExternal(caller)) return null;
  const loc = await locate(app, id);
  if (!loc || loc.deleted || loc.class !== "closed" || loc.owner_id !== caller.person.id) return null;
  const sp = (await app.db.control.query("SELECT slug, kind, archived_at FROM spaces WHERE id = $1", [loc.space_id])).rows[0];
  const slug = sp?.slug ?? "unknown";
  const archived = !!sp?.archived_at && (sp.kind === "team" || sp.kind === "project");    // as spaceArchived
  const stages = await stagesOf(app.db.recordsForWrite("closed", caller.scope), id);
  // the mark comes from the locator (control), only for a closed record, only to the author; by-word ones — also the tree
  // in the closed database by the system context (placements and readers, no content): `by_word` by the record itself.
  // Outside one's own personal — a view without findings (markViewFor)
  const openCheck = await markViewFor(app, caller, { id, spaceId: loc.space_id, ownerId: loc.owner_id, raw: loc.open_check });
  return { id, path: `/spaces/${slug}/${loc.type}/${id}`, type: loc.type, class: "closed", hidden: true, space: slug,
           owner: caller.person.login, created_at: loc.created_at ? new Date(loc.created_at).toISOString() : null, stages,
           ...(openCheck ? { open_check: openCheck } : {}), ...(archived ? { space_archived: true as const } : {}) };
}

export interface ResolvedEntities { known: Array<EntityKey & { id: string }>; unresolved: string[] }

/**
 * A person's id by login — only via the people table: after a login change people.id
 * is not the new login's uuid5, so the id is computed from a login only when creating a person (admin.ts), not in a search.
 */
export async function personIdByLogin(app: App, login: string): Promise<string | null> {
  const { rows } = await app.db.control.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [login.trim().toLowerCase(), app.instanceId]);
  return rows[0]?.id ?? null;
}

/** An entity id by key: a person — by the people table (see personIdByLogin), the rest — a deterministic uuid5. */
export async function entityUuid(app: App, key: EntityKey): Promise<string | null> {
  return key.kind === "person" ? personIdByLogin(app, key.externalId) : entityId(key);
}

/** Linked persons of a note or upload — at most this (contract limit; a meeting passes its 20 persons and participants apart). */
export const ENTITIES_MAX = 20;

/**
 * The list of linked persons on note and upload input: not a list or more than 20 — refusal, repeats collapse — before database
 * calls. Before, hundreds of thousands of keys turned into hundreds of thousands of queries. resolveEntities has no limit:
 * a meeting passes up to 200 participants there as well.
 */
export function checkEntityList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw invalid("entities must be a list of entity keys");
  if (raw.length > ENTITIES_MAX) throw invalid(`entities accepts at most ${ENTITIES_MAX}`);
  return [...new Set(raw.map(String))];
}

/**
 * Explicit entities from the call: known ones are linked (stated_by_human, 1.0), unknown — returned as unresolved, the record
 * is saved. An external-system entity (any — ext: keys) — only if the caller sees at least one record
 * with it (as the entity folder): otherwise the answer is as for a missing number, and the name
 * of someone else's deal from colleagues' closed meetings does not get into memory_read of their note. A person — by the shared
 * org directory, a project — by membership (entityReadable). For a service the visibility is that of the "on behalf of" person.
 */
export async function resolveEntities(app: App, raw: string[] | undefined, caller: Caller): Promise<ResolvedEntities> {
  const known: ResolvedEntities["known"] = [], unresolved: string[] = [];
  for (const item of raw ?? []) {
    const key = parseEntityKey(item);
    if (!key) throw invalid(`Unrecognized entity key: ${item}`, { expected: ["person:<login>", "project:<slug>", "ext:<system>:<kind>:<id>"] });
    const found = key.kind === "person"
      ? await app.db.control.query("SELECT id, display_name FROM people WHERE login = $1 AND instance_id = $2", [key.externalId, app.instanceId])
      : await app.db.control.query("SELECT id, kind, attrs FROM entities WHERE id = $1", [entityId(key)]);
    if (!found.rowCount) { unresolved.push(item); continue; }
    if (!(await entityReadable(app, caller, found.rows[0]))) { unresolved.push(item); continue; }
    // list.ts imports records.ts — a dynamic import without a cycle at module load
    if (key.kind !== "person" && key.externalSystem !== "memory" && !(await (await import("./list.ts")).entityHasVisibleRecord(app, caller, found.rows[0].id))) { unresolved.push(item); continue; }
    const id: string = found.rows[0].id;
    if (key.kind === "person")   // for a person entities.id = people.id: the registry row is made lazily
      await app.db.control.query(
        `INSERT INTO entities (id, kind, external_system, external_id, display_name, instance_id) VALUES ($1,'person','people',$2,$3,$4) ON CONFLICT DO NOTHING`,
        [id, key.externalId, found.rows[0].display_name, app.instanceId]);
    known.push({ ...key, id });
  }
  return { known, unresolved };
}

/** A project's name and links are seen only by its members, also after a record moved into org. */
export async function entityReadable(app: App, caller: Caller, entity: { kind?: string; attrs?: Record<string, unknown> }, o: { archived?: "read" } = {}): Promise<boolean> {
  const spaceId = entity.attrs?.space_id;
  return entity.kind !== "project" || typeof spaceId !== "string" || await projectEntityReadable(app.db.control, caller.person?.id, spaceId, o);
}

/**
 * The same ban for a UUID filter: guessing a key does not reveal someone else's project links. A showing (search filter, entity
 * folder) — also of an archived project to a member: its records come from the archive mode, not from this ban.
 */
export async function entityReadableById(app: App, caller: Caller, id: string): Promise<boolean> {
  const e = (await app.db.control.query("SELECT kind, attrs FROM entities WHERE id = $1", [id])).rows[0];
  return !e || entityReadable(app, caller, e, { archived: "read" });
}

/** Turning a space into a project: a limited synchronous tagging; project_tags will pick up the rest. */
export async function tagSpaceRecords(app: App, spaceId: string, entity: string): Promise<{ tagged: number; deferred: boolean }> {
  let tagged = 0;
  // The switch is committed in control. Wake the reconcile first: a partial failure must not lose the rest or the audit.
  await app.queue.wake("project_tags");
  for (const cls of ["open", "closed"] as const) {
    if (tagged >= 5000) return { tagged, deferred: true };
    const q = app.db.records(cls, { tier: "system", classes: ["open", "closed"] });
    try {
      const out = await q.query(`INSERT INTO record_entities (record_id, entity_id, role, method, confidence)
        SELECT r.id, $2, 'space', 'stated_by_human', 1.0 FROM records r
        WHERE r.space_id = $1 AND r.deleted_at IS NULL AND r.hidden_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM record_entities re WHERE re.record_id = r.id AND re.entity_id = $2 AND re.role = 'space')
        ORDER BY r.id LIMIT $3 ON CONFLICT DO NOTHING`, [spaceId, entity, 5000 - tagged]);
      tagged += out.rowCount ?? 0;
    } catch {
      log.warn("project_tags_deferred", { space_id: spaceId, class: cls, tagged });
      return { tagged, deferred: true };
    }
  }
  return { tagged, deferred: tagged >= 5000 };
}

export interface NewRecord {
  /** The record id picked in advance: part of the original's key, which goes into storage before the record (originalKey). */
  id?: string;
  type: "note" | "event" | "document" | "transcript" | "profile";
  space: SpaceAccess;
  classOverride?: DataClass;
  title: string | null;
  text: string;
  eventKind?: string | null;
  method: "source_document" | "stated_by_human" | "inferred_by_agent";
  origin: "human" | "agent";
  sourceKind: "agent" | "upload" | "transcriber" | "pipeline";
  sourceRef?: string | null;
  sourceHash?: Buffer | null;
  occurredAt: Date;
  domains?: string[];
  entities: ResolvedEntities;
  audiencePeople?: string[];                  // participants' person_id: the "people" area
  /**
   * A new meeting version whose reader circle was set by the meetings service (PUT /ingest/access): the mark
   * `attrs.access.narrowed_by_source` passes to it ("Can be added" does not offer it). Only meeting intake sets it
   * (meetings.ts) by the current version; the mark is not taken from the request attrs — `access` is built here.
   */
  narrowedBySource?: boolean;
  attrs?: Record<string, unknown>;
  original?: { key: string | null; mime: string; bytes: number; pages?: number | null; durationSec?: number | null; language?: string | null };
  version?: number;
  supersedesId?: string | null;
  eventKey?: string | null;                    // an event version inherits the old key; a new one — the id (a database trigger)
  ownerId: string;
  confirmed?: boolean;
  needsConversion?: boolean;                  // the document comes as markdown from the converter: the first stage is converted
  convertFormat?: ConverterFormat;            // its format as intake saw it: the refusal hint names it in words (Word, Excel…)
  auditDetails?: Record<string, unknown>;     // extra for the write event (a meeting: consent version, channel)
  openCheckExtra?: OpenCheckText[];           // more texts for the open check: a second reading of a file with broken bytes
  personalOpen?: boolean;                     // personal open: a finding is not a refusal but a closed record with a mark
  /**
   * A person's file from the workplace into an open team or project (keepClosedHere) — a finding that can be
   * shown "despite" is not a refusal but a closed document in the same space. Only upload (write.ts) sets it; the gate
   * admitRecord checks the condition again and does not accept the mark without it.
   */
  keepClosed?: boolean;
  /**
   * The note is a retelling of memory records (derived_from); the admitRecord gate, the caller sets the links after the write.
   * `via` — the open check path (handover); allow = human — a person in the workplace widens the circle themselves: the outcome
   * "wider" is not a refusal but the widened_by_human mark. Only handover.ts sets it (guard-tested), and the gate accepts it
   * only from a workplace session not over MCP.
   */
  derivation?: { ids: string[]; kind: DerivedKind; via?: "handover"; allow?: "human" };
  /** The class of the write event instead of the record class (the strictest of the record and the source). */
  auditClass?: DataClass;
  /** More ids in record_ids of the write event after the record id (the meeting decision the record was made from). */
  auditExtraIds?: string[];
  /**
   * The record is meeting material without a parent and links: a custodian's copy from a meeting ("Copy to me",
   * custody.ts). In attrs — `meeting_origin: true`; "Make available to agents" does not show such a record (MEETING_MARK_SQL).
   * Only by this field: the mark is not taken from the draft's attrs.
   */
  meetingOrigin?: boolean;
  /**
   * The entry path into "Company common knowledge" set by the code, not by the caller (the MCP and REST input has no such
   * field): `public_profile` — the work profile copy for colleagues (gateway/src/profile.ts), `space_guide` —
   * the "How we work" map (only space-guide.ts sets it); both — the exempt kind without auto return (`exemptKindOf`).
   * Without the field — write or version.
   */
  orgVia?: "public_profile" | "space_guide";
}

/**
 * What the check decided before the record: the class and (personal open) the answer outcome — passed, pending (PDF: the text
 * will be checked by the worker) or the fallback mark (`fallback`: the record is closed in the same personal space).
 */
/** Descendants of a record (CTE `d`) — moved to shared/version-supersede.ts; re-exported for meetings.ts. */
export { DESCENDANTS_SQL } from "@memory/shared";
/** Reason written on the skipped stages of a replaced version (`last_error`, bound as a parameter). */
const SUPERSEDED_NOTE = SUPERSEDED_STAGE_NOTE;

/**
 * `extended` — the mark of a record by an agent with extended access by the administrator's permission: set
 * only when writing into open; null — the gate did not touch the write (other keys, the closed class).
 */
export interface Admitted { cls: DataClass; openCheck: OpenCheckView | null; fallback: OpenCheckFallback | null; extended: ExtendedMark | null;
  /** The retelling passed the gate — kind, declared sources and their classes (attrs and write event, no ids); `widened` —
   * a person in the workplace widened the circle themselves, the mark in attrs.widened_by_human. */
  derived?: { kind: DerivedKind; declared: number; classes: Classes; widened?: WidenedMark | null } | null }

/** The "widened by a person" mark — the type and builder live in derivation.ts next to markWidened. */
export type { WidenedMark };

export interface Created { id: string; path: string; class: DataClass; space: string; stages: StageView[]; type: string; openCheck: OpenCheckView | null; fallback: OpenCheckFallback | null;
  /** An extended-access agent's mark: the record landed in open with the administrator's permission; null — an ordinary record. */
  extended: ExtendedMark | null }

/** The refusal to a service with a write space outside it — one text for spaceForWrite (write.ts) and admitRecord. */
export const SERVICE_SPACE_ONLY = "This service writes only to its designated write space, as configured in the admin panel";

/**
 * A file a person uploaded in the workplace into an open team or project: a finding
 * that the author may show to agents "despite" — the file survives it closed in the same
 * space: people see it as usual, agents do not, the author has the "Make available to agents" button. The server sets the mark,
 * no MCP input field: a workplace session (the workplace uploads over MCP with the session key — the transport conditions,
 * as for handing over a meeting decision, do not apply here), a team or project of the open class (not personal, not "Company
 * common knowledge"), the "Make available to agents" and "in teams and projects" switches on. An agent with any key — the old
 * refusal; notes and edits too (only files).
 */
export function keepClosedHere(app: App, caller: Caller, space: Pick<SpaceAccess, "kind" | "default_class">): boolean {
  if (!isHumanSession(caller) || (space.kind !== "team" && space.kind !== "project") || space.default_class !== "open") return false;
  const ds = despiteSettings(app.settings);
  return ds.enabled && ds.projects;
}

/**
 * Entity kinds of a new record for the "never open" rules — the links the record will get: explicit ones and the project
 * label (createRecord gives a project's records the project entity, role space — ensureProjectEntity). Without it the rule
 * `entity_kind = project` was unseen by the upload gate, while the worker (convert.ts) and the "Make available to agents" button
 * (despite-open.ts neverOpenOf) take it into account (automatic links count).
 */
const admitEntityKinds = (n: Pick<NewRecord, "entities" | "space">): string[] =>
  [...n.entities.known.map((e) => e.kind), ...(n.space.kind === "project" ? ["project"] : [])];

/** A new record's class is a space property; a T1 service does not write into closed (class_denied). */
function classFor(caller: Caller, n: NewRecord): DataClass {
  const cls = n.classOverride ?? n.space.default_class;
  if (cls === "closed" && caller.tier === "T1") throw classDenied("A T1 service cannot write to a closed-class space");
  return cls;
}

/**
 * Can a record be created: the right to write into the space, the service's write space, the class (T1 does not write into
 * closed) and — for the open class — the content check. The order matters: the open_check refusal (and its log
 * event) goes only to one who may write there. Checked: the name, the text, the file name, the source,
 * the names of explicitly given entities and the meeting participants not found — everything the agent will see in the record.
 *
 * Personal open (`personalOpen`): a finding is not a refusal but the closed class and the `fallback` mark; first —
 * the "never open" rules that need no content (a domain tag, a name pattern, an entity kind, a space).
 * A refusal here — only "not checked" (busy, out of time, failure): nothing is saved.
 */
export async function admitRecord(app: App, caller: Caller, n: NewRecord): Promise<Admitted> {
  // archive — the first check, the second line after spaceForWrite: before the write right, the service space and the open check
  if (n.space.archived_at) throw archivedDenied(n.space.slug, n.space.archived_at);
  if (!canWrite(n.space) && n.type !== "profile") throw classDenied("This space is read-only");
  // a service with a write space writes only there — not into personal and other spaces
  if (caller.service?.write_space_id && n.space.id !== caller.service.write_space_id)
    throw new MemoryError("forbidden", SERVICE_SPACE_ONLY);
  const cls = classFor(caller, n);
  // after the class, before the extended gate and open check — a refusal writes no extended_open_denied or open_check_refused;
  // the "circle" axis is needed by a closed note too
  let derived: Admitted["derived"] = null;
  if (n.derivation) {
    const sources = await loadSources(app, caller, n.derivation.ids);
    // a person in the workplace (a session, not MCP, not a preview) widens themselves — axes are counted, "wider" — a mark
    const human = n.derivation.allow === "human" && isHumanSession(caller) && caller.transport !== "mcp";
    if (human) {
      const v = await derivationVerdict(app, caller, { space: n.space, cls, sources });
      derived = { kind: n.derivation.kind, declared: n.derivation.ids.length, classes: v.classes,
                  widened: v.reason ? widenedMark(caller.person!.id, n.derivation.via ?? "handover") : null };
    } else {
      const g = await derivationGate(app, caller, { space: n.space, cls, sources, declared: n.derivation.ids.length });
      derived = { kind: n.derivation.kind, declared: n.derivation.ids.length, classes: g.classes };
    }
  }
  if (cls !== "open") return { cls, openCheck: null, fallback: null, extended: null, derived };
  // an agent reading a person's closed data does not write into open without the administrator's permission: after the right and
  // the class, before the open check — the refusal does not spend the check and does not write its event
  const extended = await extendedOpenGate(app, caller, { attempt: n.type === "document" ? "upload" : "remember", space: { id: n.space.id, slug: n.space.slug } });
  const names = n.entities.known.length
    ? (await app.db.control.query("SELECT display_name, attrs FROM entities WHERE id = ANY($1::uuid[])", [n.entities.known.map((e) => e.id)])).rows
      .filter((e) => entityNameNeedsOpenCheck("mentioned", e.attrs?.space_id, n.space.id)).map((r) => r.display_name) : [];
  const unresolved = Array.isArray(n.attrs?.participants_unresolved) ? (n.attrs.participants_unresolved as unknown[]).map(String) : [];
  // the check path: handing over a meeting decision — handover, otherwise by record type
  const via: OpenVia = n.derivation?.via ?? (n.type === "document" ? "upload" : "remember");
  const texts: OpenCheckText[] = [
    { field: "title", value: n.title }, { field: "text", value: n.text }, { field: "filename", value: typeof n.attrs?.filename === "string" ? n.attrs.filename : null },
    { field: "source", value: n.sourceRef }, { field: "entities", value: [...names, ...n.entities.unresolved].filter(Boolean).join("\n") },
    { field: "participants", value: unresolved.join("\n") }, ...(n.openCheckExtra ?? []),
  ];
  // a person's file into an open team or project — a finding that can be shown "despite" it survives
  // closed in the same space (the original — straight into closed storage); the rest — the old refusal, nothing saved.
  // No findings — open, as before. PDF and office: here — name and file name, the worker checks text (keep_closed_on_findings);
  // a finding in the name or file name — the old refusal (the text is unchecked yet — it does not land closed in a shared space)
  if (n.keepClosed && n.type === "document" && !n.personalOpen && !n.derivation && keepClosedHere(app, caller, n.space)) {
    const kept = await guardOpenKeepClosed(app, caller, { via: "upload", spaceId: n.space.id, texts }, {
      never: async () => neverOpenFindings(
        (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows,
        { type: n.type, title: n.title, domains: n.domains ?? [], entityKinds: admitEntityKinds(n), spaceSlug: n.space.slug, sourceKind: n.sourceKind, sourceRef: n.sourceRef ?? null }),
      textLater: n.needsConversion === true, format: n.convertFormat });
    if (!kept.findings.length) return { cls, openCheck: null, fallback: null, extended, derived };
    const fallback = openCheckFallback("upload", kept.findings, { strict: kept.more });
    // outside one's personal an agent's word cannot open it: by_word — false; the author shows it by a button in the workplace
    return { cls: "closed", openCheck: openCheckView(fallback, { reachable: false }), fallback, extended: null, derived };
  }
  if (!n.personalOpen) {
    await guardOpen(app, caller, { via, spaceId: n.space.id, texts });
    return { cls, openCheck: null, fallback: null, extended, derived };
  }
  // personal open — only remember and upload: handing over a meeting decision writes into a project
  const soft = n.type === "document" ? "upload" as const : "remember" as const;
  const rules = (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows;
  const never = neverOpenFindings(rules, { type: n.type, title: n.title, domains: n.domains ?? [], entityKinds: admitEntityKinds(n), spaceSlug: n.space.slug,
                                           sourceKind: n.sourceKind, sourceRef: n.sourceRef ?? null });
  if (never.length) {
    const fallback = openCheckFallback(soft, never, { textChecked: false });
    return { cls: "closed", openCheck: openCheckView(fallback), fallback, extended: null, derived };
  }
  const { findings, strict } = await guardOpenSoft(app, caller, { via: soft, spaceId: n.space.id, texts });
  if (findings.length) {
    // PDF: closed by the name or file name before conversion — its text was not checked
    const fallback = openCheckFallback(soft, findings, { strict, textChecked: n.needsConversion !== true });
    return { cls: "closed", openCheck: openCheckView(fallback), fallback, extended: null, derived };
  }
  return { cls, openCheck: { result: n.needsConversion ? "pending" : "passed", via: soft }, fallback: null, extended, derived };
}

/**
 * Create a record. `admitted` — the class admitRecord returned for this same draft (upload checks before saving
 * the original): then the check does not run a second time. Before, the skip relied on a WeakSet by object reference.
 *
 * `o.control` — the caller's record:<id> lock transaction client (a new meeting version's intake under version locks; rule:
 * a control connection holder takes no second one — else a batch of simultaneous intakes, each holding one and asking for
 * another, drained the pool). All control queries use it: the locator and review row commit with the lock transaction, a failure
 * rolls them back. The caller wakes the worker only after its COMMIT (withCommittedOwnerEffects): before, the worker would miss
 * the locator and drop the job. Without `o.control` — the control pool, as before. Only a closed meeting runs under a lock: the
 * admitRecord gate does not go to the databases for it.
 *
 * `o.records` — the caller's already open transaction of the record class database (the personal work profile version and
 * the colleagues' copy in org — both in the open database — go in one transaction): it inserts the record rows, COMMIT and
 * rollback — the caller's. Then the worker wake-up and the event come only after COMMIT: they are not run but put into
 * `o.effects` — the caller runs them after COMMIT; on rollback it removes the created records' locators (the curator review
 * row goes with the locator by cascade). Without `o.records` — its own transaction, as before.
 */
export async function createRecord(app: App, caller: Caller, n: NewRecord, admitted?: Admitted,
                                   o: { control?: pg.PoolClient; records?: pg.PoolClient; effects?: Array<() => Promise<unknown>> } = {}): Promise<Created> {
  if (o.records && !o.effects) throw new Error("createRecord: o.effects is required in an external record database transaction");
  const adm = admitted ?? await admitRecord(app, caller, n);
  const cls = adm.cls;
  const id = n.id ?? newId(), tokens = estimateTokens(n.text);
  const db = app.db.recordsForWrite(cls, caller.scope);
  const inRecords = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => (o.records ? fn(o.records) : tx(db, fn));
  const ctl: Pick<pg.Pool, "query"> = o.control ?? app.db.control;
  // its own control transaction — or the caller's already open lock transaction (its rollback removes everything together)
  const inControl = <T>(fn: (q: pg.PoolClient) => Promise<T>): Promise<T> => (o.control ? fn(o.control) : tx(app.db.control, fn));
  const project = n.space.kind === "project"
    ? await ensureProjectEntity(ctl, { ...n.space, instance_id: app.instanceId }, { update: false }) : null;
  const stageNames = stagesFor(n.type, n.entities.known.length > 0 || n.entities.unresolved.length > 0, n.needsConversion === true);
  // the extended mark and retelling origin come only from the gate, not the draft attrs (any write path could forge those);
  // the reason of a loss label (class_change removes "meeting" from the label) — also only the server
  const { extended_write: _forged, derivation: _kind, derived_declared: _declared, widened_by_human: _widened, derived_pending: _pending, derived_lost: _lost,
          derived_lost_cause: _lostCause, meeting_origin: _meeting, ...draftAttrs } = (n.attrs ?? {}) as Record<string, unknown>;
  const attrs: Record<string, unknown> = {
    ...draftAttrs,
    ...(n.entities.unresolved.length ? { mentions: n.entities.unresolved.map((k) => ({ text: k, reason: "not_in_registry" })) } : {}),
    // access data travels with the material (the role model): who approved the reader list and when
    access: { asserted_by: caller.service?.name ?? caller.person?.login ?? "system", acl_version: 1, acl_checked_at: new Date().toISOString(), readers_mode: n.audiencePeople ? "people" : "space",
              ...(n.narrowedBySource ? { narrowed_by_source: true } : {}) },
    // personal open: a mark for the worker (the PDF text is checked after conversion) and the fallback mark
    ...(n.personalOpen ? { personal_open: true } : {}),
    ...(adm.fallback ? { open_check_fallback: adm.fallback } : {}),
    // an agent with extended access wrote into open with the administrator's permission: {op, at}, the key — in the log
    ...markAttrs(adm.extended),
    // the kind and how many sources were declared at write — for the move (checked against the set's live links); fingerprints
    // of all sources — unfinished until the links are inserted: the record is visible by fingerprint before its links,
    // and the record itself closes the "window before the lock" — the caller under the lock only subtracts
    ...(adm.derived ? { derivation: adm.derived.kind, derived_declared: adm.derived.declared,
                        ...(n.derivation?.ids.length ? { derived_pending: [...new Set(n.derivation.ids.map(derivedPrint))].sort() } : {}) } : {}),
    // a person in the workplace widened the circle themselves — a mark, without source ids
    ...(adm.derived?.widened ? { widened_by_human: adm.derived.widened } : {}),
    // meeting material without a parent and links (a custodian's copy)
    ...(n.meetingOrigin === true ? { meeting_origin: true } : {}),
  };
  // the locator first: if the records database insert fails, it is removed (no cross-database transaction). Under the caller's
  // locks (o.control) it is visible from their transaction's COMMIT — like a correction locator (corrections.ts buildResult).
  // The source hash in the locator — so a personal key recognizes "the same file" among its records without reading the closed database
  // the fallback mark — in the locator too: a personal key sees its hidden record's reason without reading the closed database
  await ctl.query("INSERT INTO record_locations (record_id, class, space_id, type, owner_id, source_hash, open_check) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, cls, n.space.id, n.type, n.ownerId, n.sourceHash ?? null, adm.fallback ? JSON.stringify(adm.fallback) : null]);
  // the previous version's review row before the move to the new one: a version write failure below returns it as it was
  const prevReview: OrgReviewState | null = n.supersedesId
    ? (await ctl.query("SELECT state FROM org_reviews WHERE record_id = $1", [n.supersedesId])).rows[0]?.state ?? null : null;
  try {
    // a direct write and a new version in "Company common knowledge" go to the curator review — right after
    // the locator: a failure below removes the locator, and with it the review row by cascade. A new version outside org
    // (a meeting in a project) takes the old row as is — the hold and "returned" travel with the chain;
    // the old one still in org under review (a new meeting version in personal) stays; the new one — "left" without "confirmed"
    if (n.space.kind === "org")
      await inControl((q) => enterOrg(q, app, { recordId: id, via: n.orgVia ?? (n.supersedesId ? "version" : "write"), caller, curator: isOrgCurator(caller, new Map([[n.space.id, n.space]])),
                                                human: isHumanSession(caller), extended: !!adm.extended, fromSpaceId: null,
                                                fromAudience: n.audiencePeople ? "people" : "space", supersedesId: n.supersedesId ?? null,
                                                exempt: exemptKindOf({ via: n.orgVia ?? "write", type: n.type, sourceKind: n.sourceKind, sourceRef: n.sourceRef ?? null }) }));
    else if (n.supersedesId && prevReview) await inControl((q) => carryOrgReview(q, n.supersedesId!, id, { nextOutsideOrg: true }));
    await inRecords(async (c) => {
      let eventKey = n.type === "event" ? n.eventKey ?? null : null;
      if (n.type === "event" && !eventKey && n.supersedesId)
        eventKey = (await c.query("SELECT event_key FROM records WHERE id = $1 AND type = 'event'", [n.supersedesId])).rows[0]?.event_key ?? null;
      await c.query(
        `INSERT INTO records (id, type, class, space_id, audience, owner_id, source_kind, source_ref, method, origin, confirmed_at, confirmed_by, occurred_at,
                              title, summary_line, event_kind, domain_tags, token_count, source_hash, version, supersedes_id, attrs, event_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [id, n.type, cls, n.space.id, n.audiencePeople ? "people" : "space", n.ownerId, n.sourceKind, n.sourceRef ?? null, n.method, n.origin,
         n.confirmed ? new Date() : null, n.confirmed ? n.ownerId : null, n.occurredAt, n.title, summaryLine(n), n.eventKind ?? null,
         n.domains ?? [], tokens, n.sourceHash ?? null, n.version ?? 1, n.supersedesId ?? null, JSON.stringify(attrs), eventKey]);
      await c.query(
        "INSERT INTO record_content (record_id, text, original_key, original_mime, original_bytes, pages, duration_sec, language) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, n.text, n.original?.key ?? null, n.original?.mime ?? null, n.original?.bytes ?? null, n.original?.pages ?? null, n.original?.durationSec ?? null, n.original?.language ?? null]);
      for (const p of new Set(n.audiencePeople ?? [])) await c.query("INSERT INTO record_people (record_id, person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, p]);
      for (const e of n.entities.known)
        await c.query("INSERT INTO record_entities (record_id, entity_id, role, method, confidence) VALUES ($1,$2,$3,'stated_by_human',1.0) ON CONFLICT DO NOTHING",
          [id, e.id, e.kind === "person" && n.audiencePeople?.includes(e.id) ? "participant" : "mentioned"]);
      if (project) await c.query("INSERT INTO record_entities (record_id, entity_id, role, method, confidence) VALUES ($1,$2,'space','stated_by_human',1.0) ON CONFLICT DO NOTHING", [id, project]);
      for (const s of stageNames) await c.query("INSERT INTO record_stages (record_id, stage) VALUES ($1,$2)", [id, s]);
      // a new version: the previous one and its whole subtree stop being current but stay readable by id
      if (n.supersedesId) await supersedeInTx(c, { id, prevId: n.supersedesId, staleNote: SUPERSEDED_NOTE });
      // stale chunks of the previous version are removed by the worker at the indexed stage of the new one: the gateway role has no DELETE on chunks (least privilege)
      // a preliminary chunk: a short record is found by full text at once; embeddings and rechunking — the indexed stage
      const maxTokens = app.settings.get<{ maximum: number }>("processing.chunk", { maximum: 480 }).maximum;
      if (tokens <= maxTokens && n.text.trim())
        await c.query(
          `INSERT INTO chunks (id, record_id, ordinal, text, token_count, space_id, audience, type, occurred_at) VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8)`,
          [newId(), id, [n.title, n.text].filter(Boolean).join("\n"), tokens, n.space.id, n.audiencePeople ? "people" : "space", n.type, n.occurredAt]);
    });
  } catch (e) {
    // in the caller's lock transaction (o.control) only early: its rollback after the throw drops the locator and review row
    if (n.supersedesId && prevReview && prevReview !== "superseded")
      await inControl((q) => undoCarryOrgReview(q, n.supersedesId!, id, prevReview)).catch(() => undefined);
    await ctl.query("DELETE FROM record_locations WHERE record_id = $1", [id]).catch(() => undefined);
    throw e;
  }
  const effects = async (): Promise<void> => {
    await app.queue.kick({ instance: app.instanceId, class: cls, record_id: id, lane: "index" });
    await audit(app, caller, { event_type: "write", class: n.auditClass ?? cls, record_ids: [id, ...(n.auditExtraIds ?? [])], space_id: n.space.id,
                               details: writeEventDetails(caller, n, adm.fallback, adm.extended, adm.derived) });
  };
  if (o.records) o.effects!.push(effects);
  else await effects();
  return { id, path: recordPath(n.space.slug, n.type, n.occurredAt, id), class: cls, space: n.space.slug, stages: await stagesOf(o.records ?? db, id), type: n.type,
           openCheck: adm.openCheck, fallback: adm.fallback, extended: adm.extended ?? null };
}

/**
 * details of the record's write event. via — the transport (mcp | rest): with it one finds
 * keys without a program that upload over REST (scripts). It comes last: extra fields of the record (a meeting — channel,
 * consent, upload ticket) do not replace it. Without a transport (an internal call) there is no field.
 * The personal open fallback — `op: open_check_fallback`, the check place — `check_via` (remember | upload:
 * `via` is taken by the transport), finding kinds and rules — without content.
 * A write by an agent with extended access by the administrator's permission — `extended_open: true` and `extended_op`.
 */
/**
 * Rollback of locators of records createRecord made in another's records database transaction (`o.records`) when it rolled back
 * — no record rows, no links to them — the same rollback as in createRecord itself (and with the same text: deleting
 * locators outside the list is forbidden by a guard test of the workers). The curator review row cascades.
 */
export async function dropUncommittedLocators(ctl: Pick<pg.Pool, "query">, ids: readonly string[]): Promise<void> {
  for (const id of ids) await ctl.query("DELETE FROM record_locations WHERE record_id = $1", [id]).catch(() => undefined);
}

export function writeEventDetails(caller: Pick<Caller, "transport">, n: Pick<NewRecord, "type" | "sourceKind" | "auditDetails">, fallback?: OpenCheckFallback | null,
                                  extended?: ExtendedMark | null, derived?: Admitted["derived"]): Record<string, unknown> {
  return { type: n.type, source_kind: n.sourceKind, ...(n.auditDetails ?? {}),
           // kind, declared count and source classes — without their ids
           ...(derived ? { derived: { kind: derived.kind, declared: derived.declared, classes: derived.classes } } : {}),
           ...(fallback ? { op: "open_check_fallback", check_via: fallback.via, kinds: fallback.kinds, rules: fallback.rules, openable: fallback.openable } : {}),
           ...markEvent(extended),
           ...(caller.transport ? { via: caller.transport } : {}) };
}

function summaryLine(n: NewRecord): string | null {
  if (n.type === "document" || n.type === "transcript") return null;          // a document's description comes from stage described
  const line = n.text.replace(/\s+/g, " ").trim();
  return line.length > 160 ? line.slice(0, 157) + "…" : line || null;
}

// ---------------------------------------------------------------- input checks
export function checkText(app: App, text: string): void {
  if (!text.trim()) throw invalid("The text is empty");
  const max = app.settings.get("limits.remember_max_tokens", 8000);
  if (estimateTokens(text) > max) throw tooLarge(`The text exceeds ${max} tokens. Upload it as a document with memory_upload`);
}

/**
 * The event time from the request. A date-time with no zone (a REST upload form field; MCP rejects it — format date-time)
 * is read by the memory time zone tz, not by the server's UTC clock; with a zone and a bare day — as before.
 */
export function parseWhen(raw: string | undefined, tz: string, fallback = new Date()): Date {
  if (!raw) return fallback;
  const wall = WALL_TIME.test(raw) ? zonedWallToInstant(raw, tz) : undefined;
  if (wall === null) throw invalid(`Invalid date: ${raw}`);
  const d = new Date(wall ?? raw);
  if (Number.isNaN(d.getTime())) throw invalid(`Invalid date: ${raw}`);
  return d;
}

export function checkDomains(app: App, domains: string[] | undefined): string[] {
  const dict = new Set(app.settings.get<string[]>("search.domains", []));
  return (domains ?? []).filter((d) => dict.has(d));   // foreign tags are dropped: the dictionary is controlled
}

/** SHA-256 of the original + normalized source metadata; what the model generated is not part of the hash. */
export const sourceHash = (bytes: Buffer, meta: Record<string, string | number>): Buffer =>
  createHash("sha256").update(bytes).update("\0").update(JSON.stringify(Object.entries(meta).sort())).digest();

/**
 * Fingerprints of an uploaded file: the name is part of the fingerprint, and Finder gives it in NFD. A new
 * record writes the NFC-name fingerprint first; "the same file" is also looked up by the name as sent and by the NFD name:
 * so a file uploaded from a Mac before the fix (NFD-name fingerprint) is recognized, and so is the same one sent from Windows.
 * Matching names are not repeated; the bytes are hashed once. Each fingerprint is exactly sourceHash(bytes, {filename, size}).
 */
export function uploadHashes(bytes: Buffer, filename: string): Buffer[] {
  const head = createHash("sha256").update(bytes).update("\0");
  return [...new Set([filename.normalize("NFC"), filename, filename.normalize("NFD")])]
    .map((name) => head.copy().update(JSON.stringify(Object.entries({ filename: name, size: bytes.length }).sort())).digest());
}

/**
 * The original's key in storage: `<instance>/<year>/<month>/<hash — 32 hex>/<record id>-<name>`. Before, the key had no record
 * id, and identical files of different people with one name in one month (for a meeting — with the same cleaned text and
 * meeting_id) shared the key: the file was stored once for two, a class move of one record deleted the other's file, and a second
 * upload of a meeting with "the same" text overwrote another's original. The path hash is still source_hash (for a meeting —
 * the canonical text): by it the storage orphan reconcile and the daily cleanup match a file with a tombstone. The name — without
 * path separators and service characters.
 */
export function originalKey(instanceId: string, at: Date, hash: Buffer, recordId: string, name: string): string {
  // a name in NFC and with marks: Finder's "Résumé.md" (NFD) does not become "Re_sume_.md"
  let safe = safeFileName(name);
  if (Buffer.byteLength(safe, "utf8") > 120) {
    // Keep the supported extension and a digest of the complete NFC name; count bytes without splitting code points.
    const ext = /\.[a-z0-9]{1,10}$/i.exec(safe)?.[0] ?? "";
    const suffix = `-${createHash("sha256").update(name.normalize("NFC")).digest("hex").slice(0, 10)}${ext}`;
    const budget = 120 - Buffer.byteLength(suffix), stem = ext ? safe.slice(0, -ext.length) : safe;
    let prefix = "", used = 0;
    for (const char of stem) {
      const bytes = Buffer.byteLength(char);
      if (used + bytes > budget) break;
      prefix += char; used += bytes;
    }
    safe = prefix + suffix;
  }
  return `${instanceId}/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${hash.toString("hex").slice(0, 32)}/${recordId}-${safe}`;
}

// ---------------------------------------------------------------- views
export async function ownerLogins(app: App, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  for (const r of (await app.db.control.query("SELECT id, login FROM people WHERE id = ANY($1)", [[...new Set(ids)]])).rows) out.set(r.id, r.login);
  return out;
}

export const confidenceOf = (r: RecordRow): number | null => (typeof r.attrs?.confidence === "number" ? r.attrs.confidence : null);

/**
 * The conversion phase outwards: external names without converter statuses. Internal phases
 * of the worker (`attrs.conversion.phase`, conversion-rules.ts) — `uploading`, `submitted`, `rerun_wait`, `fetching`; `fetching`
 * (the run is over, the result is fetched and checked) and the result wait (`converter_wait:doc_error`) show outside as "at
 * the converter": we tell people no more than we know. No phase with `pending` — waiting in the queue (or the converter).
 */
export type ConversionPhaseView = "queued" | "uploading" | "at_converter" | "retry_later";
const PHASE_VIEW: Readonly<Record<string, ConversionPhaseView>> = { uploading: "uploading", submitted: "at_converter", fetching: "at_converter", rerun_wait: "retry_later" };
/** Queue position — from the `converted` stage wait code (`converter_wait:queue: N ahead`, conversion-rules.ts queueWaitCode). */
const QUEUE_AHEAD = /^converter_wait:queue: (\d{1,7}) ahead(?![\p{L}\p{N}])/u;
/** Reason codes of "file for people only" (`agent_file_why`): only short codes, no text. */
const WHY_CODE = /^[a-z][a-z0-9_]{0,39}$/u;

/** A timestamp from a mark as ISO; junk and empty — null. */
const isoOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Document conversion data for answers (`memory_read`, `GET /records/{id}/status`): a document that came not as text
 * carries `attrs.conversion`. Fields are listed explicitly — nothing outside the contract goes into the answer (mcp-tools.json).
 *
 * Since contract 0.17.0: `phase` (while `pending` — a string, after the end — null), `since` (since when: in the queue —
 * from the cycle's wait start, at the converter — from the cycle's first send), `position` (documents ahead — only in
 * the queue, by the stage wait code; else null), `agent_file`, `agent_file_why` (do agents get the file itself once the text
 * is accepted, and why not — panel codes). `stages` — the record's stages (already read by the caller): the position comes from
 * the `converted` row without a new query; without them the position is null.
 */
export function conversionView(attrs: Record<string, any> | null | undefined, stages?: readonly Pick<StageView, "stage" | "status" | "last_error">[] | null,
                               cls?: DataClass | null): Record<string, unknown> | null {
  const c = attrs?.conversion;
  if (!c || typeof c !== "object") return null;
  // failed — the converter refused for good, no text will come; refusal kind (`error_kind`) — a code, no other service's text
  const status = c.status === "done" ? "done" : c.status === "failed" ? "failed" : "pending";
  const out: Record<string, unknown> = { status };
  // verdict and extraction_state — the run result and the text availability at the converter, for analysis
  for (const k of ["error_kind", "profile", "export_profile", "verdict", "extraction_state", "run_id", "document_id", "export_id", "converted_at"] as const)
    if (typeof c[k] === "string") out[k] = c[k];
  if (typeof c.certified === "boolean") out.certified = c.certified;
  if (status === "pending") {
    const phase: ConversionPhaseView = PHASE_VIEW[typeof c.phase === "string" ? c.phase : ""] ?? "queued";
    out.phase = phase;
    out.since = phase === "queued" ? isoOf(c.waiting_since) ?? isoOf(c.cycle_started_at)
      : phase === "uploading" ? isoOf(c.admitted_at) ?? isoOf(c.submitted_at)
      : isoOf(c.submitted_at) ?? isoOf(c.run_started_at) ?? isoOf(c.admitted_at);
    const st = phase === "queued" ? stages?.find((s) => s.stage === "converted" && s.status === "pending") : undefined;
    const ahead = st?.last_error ? QUEUE_AHEAD.exec(st.last_error) : null;
    out.position = ahead ? Number(ahead[1]) : null;
  } else {
    out.phase = null;
  }
  if (typeof c.agent_file === "boolean") {
    // whether the file is given to agents — by the same rules as the giving itself (originals.ts, AGENT_FILE): in a plain
    // closed one an extended-key agent gets the file even with a false mark, and "I cannot open the file itself" would be false.
    // No class passed (tests, older calls) — as in the mark
    const withheld = cls ? agentFileWithheld(cls, attrs) : !c.agent_file;
    out.agent_file = !withheld;
    const why = Array.isArray(c.agent_file_why) ? [...new Set((c.agent_file_why as unknown[]).filter((w): w is string => typeof w === "string" && WHY_CODE.test(w)))].slice(0, 10) : [];
    if (!c.agent_file && withheld && why.length) out.agent_file_why = why;
  }
  return out;
}

const truthy = (v: unknown): boolean => v === true || v === "true";

/**
 * Is the record's file withheld from agents — TS twin of CHECKED and AGENT_FILE in originals.ts (keep together): in open —
 * conversion not finished, not all recognized (`partial`, `unavailable`), the record shown "as text only" (`original_closed`)
 * or the mark `conversion.agent_file = false`; in closed with `keep_closed_on_findings` — conversion not `done`, not all
 * recognized or the same mark. In plain closed the file is given to an agent with an extended key under any mark. Comparing
 * the mark as a string — as `->> 'agent_file' = 'false'` in SQL.
 */
export function agentFileWithheld(cls: DataClass, attrs: Record<string, any> | null | undefined): boolean {
  const c = attrs?.conversion && typeof attrs.conversion === "object" ? attrs.conversion as Record<string, unknown> : null;
  const extraction = String(c?.extraction_state ?? "");
  const scans = extraction === "partial" || extraction === "unavailable";
  const marked = c !== null && String(c.agent_file) === "false";
  if (cls === "open") return (c !== null && c.status !== "done") || scans || truthy(attrs?.original_closed) || marked;
  if (cls === "closed" && truthy(attrs?.keep_closed_on_findings)) return String(c?.status ?? "") !== "done" || scans || marked;
  return false;
}

export function pathOf(r: Pick<RecordRow, "id" | "type" | "occurred_at" | "space_id">, spaces: Map<string, SpaceAccess>, fallbackSlug?: string): string {
  return recordPath(spaces.get(r.space_id)?.slug ?? fallbackSlug ?? "unknown", r.type, r.occurred_at, r.id);
}
