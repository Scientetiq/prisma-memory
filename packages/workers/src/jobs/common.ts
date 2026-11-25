// Common to jobs: loading a record, derived records with class and scope inherited by code.
import { estimateTokens, log, newId, openCheckSettings, PlatformError, runOpenCheck, tx } from "@memory/shared";
import type { BeforeModelDispatch, DataClass, OpenCheckText } from "@memory/shared";
import { auditWorker, recordsDb, type Ctx } from "../ctx.ts";
import { heldBack } from "./embed-source.ts";
import { DEFAULT_VERIFY_PARAMS } from "../pipeline/verify.ts";
import { EVENT_KEY_WINDOW_SEC, inheritEventKeys, type KeyCandidate } from "./event-keys.ts";

export interface Rec { id: string; type: string; class: DataClass; space_id: string; audience: "space" | "people"; owner_id: string; title: string | null; occurred_at: Date; attrs: Record<string, any>; token_count: number | null; source_ref: string | null; supersedes_id: string | null }

/** Record for a stage; null → stage skipped. A superseded version is not processed: its fragments left the index, new ones are not needed. */
export async function loadRecord(ctx: Ctx, cls: DataClass, id: string): Promise<{ rec: Rec; text: string; original: { key: string | null; mime: string | null; pages: number | null } } | null> {
  const db = recordsDb(ctx, cls);
  const rec = (await db.query("SELECT id, type, class, space_id, audience, owner_id, title, occurred_at, attrs, token_count, source_ref, supersedes_id FROM records WHERE id = $1 AND deleted_at IS NULL AND is_current", [id])).rows[0];
  if (!rec) return null;
  const c = (await db.query("SELECT text, original_key, original_mime, pages FROM record_content WHERE record_id = $1", [id])).rows[0];
  return { rec, text: c?.text ?? "", original: { key: c?.original_key ?? null, mime: c?.original_mime ?? null, pages: c?.pages ?? null } };
}

/**
 * How long a stage with a model waits for a running class move, in seconds: a move may stand for minutes (the open-data
 * check server busy — retry after 60 s × attempt, the record lock), and with no limit the stage would pass to the
 * move and back to the «now» lane each second, each time taking a model slot.
 */
export const MOVE_WAIT_SEC = 60;

/**
 * Record for a stage with a model: before the model call, a check that the record may be handed out. The row is a copy
 * of a class move before its last step (hidden_at), the record already lives in another class, or a move runs — the
 * model is not called: the stage of the class where the record lives now (or its own — the move takes it) is again
 * pending, outcome handoff (the worker wakes the move and plans the stage there). Only the inner model runs now; this
 * opens nothing, but with outer models a closed record must not pass as open. null — like loadRecord.
 */
export async function loadRecordForModel(ctx: Ctx, job: { class: DataClass; record_id: string; stage: string }): Promise<Awaited<ReturnType<typeof loadRecord>> | "handoff"> {
  if (await handedOff(ctx, job)) return "handoff";
  return loadRecord(ctx, job.class, job.record_id);
}

/**
 * The record of a stage with a model was handed off (the same rule as loadRecordForModel): checked before every
 * model call of a stage, not only before the first — a close requested between two calls of one stage (a long meeting in
 * parts) stops the next call. `untilHandoff` turns it into the stage outcome `handoff`; the stage rows are already written.
 */
export class ModelHandoff extends Error {
  constructor() { super("model_handoff"); this.name = "ModelHandoff"; }
}
/** The re-check before a model call of `job`'s stage — throws ModelHandoff when the record may not go to a model now. */
export const modelRecheck = (ctx: Ctx, job: { class: DataClass; record_id: string; stage: string }) => async (): Promise<void> => {
  if (await handedOff(ctx, job)) throw new ModelHandoff();
};
/**
 * The re-check at the hand-over of a request — the transport asks it right before every POST of a
 * chat call (`chatJson` `beforeDispatch`), the schema repair's resend too, so a close that settled during a long model
 * call never reaches the next request. A PlatformError of kind `policy_denied`: the transport passes it unchanged (not a
 * network failure), the slot counts no call — outcome `blocked`, no «dirty tail» (`needsTail`), the breaker untouched —
 * and `untilHandoff` makes it the stage's `handoff`.
 */
export class DispatchHandoff extends PlatformError {
  constructor() { super("policy_denied", "handoff: the record may not go to a model now (checked at the send)"); this.name = "DispatchHandoff"; }
}
/**
 * F-D: the fence could not read its rows (a lost connection, a statement or lock time-out of either database).
 * Nothing was sent and the model did nothing, so it must not be counted as «model unreachable»: a PlatformError of kind
 * `aborted` — the transport passes it unchanged (not `http` without a status), the gate does not count it for the breaker,
 * no usage is reported, and `fake` (no real request was made) means no «dirty tail» for the next holder of the slot. The
 * stage plans `aborted`: pending, the attempt given back. `code` — the database's error code when there is one.
 */
export class DispatchFenceFault extends PlatformError {
  /** The stage's plan names this cause, not «a restart or a change of queue» (retry-policy.ts abortedBy). */
  readonly recordCheck = true;
  constructor(readonly code: string | undefined, cause: unknown) {
    super("aborted", `the record could not be checked before the send${code ? ` (${code})` : ""}`);
    this.name = "DispatchFenceFault";
    this.fake = true;
    (this as { cause?: unknown }).cause = cause;
  }
}
export const modelDispatchFence = (ctx: Ctx, job: { class: DataClass; record_id: string; stage: string }): BeforeModelDispatch => {
  const recheck = modelRecheck(ctx, job);
  return async () => {
    try { await recheck(); }
    catch (e) {
      if (e instanceof ModelHandoff) throw new DispatchHandoff();
      if (e instanceof PlatformError) throw e;
      const code = (e as { code?: unknown } | null)?.code;
      throw new DispatchFenceFault(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined, e);
    }
    return async () => {};
  };
};
/** Runs a stage with a model; a ModelHandoff of one of its re-checks (or a DispatchHandoff at a send) is the outcome `handoff`. */
export async function untilHandoff<T>(run: () => Promise<T>): Promise<T | "handoff"> {
  try { return await run(); }
  catch (e) { if (e instanceof ModelHandoff || e instanceof DispatchHandoff) return "handoff"; throw e; }
}

/** The check of loadRecordForModel: true — the record may not go to a model now, the stage rows are written (handoff). */
async function handedOff(ctx: Ctx, job: { class: DataClass; record_id: string; stage: string }): Promise<boolean> {
  const loc = (await ctx.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [job.record_id])).rows[0];
  const db = recordsDb(ctx, job.class);
  const elsewhere = Boolean(loc && !loc.deleted && loc.class !== job.class);
  const held = !elsewhere && !loc?.deleted
    && (await heldBack(ctx, db, job.class, [job.record_id], { holdDirectMoves: true })).has(job.record_id);
  // Read the source after the moves: a close that has already failed can leave the old locator with no source row.
  const source = (await db.query("SELECT hidden_at IS NOT NULL AS h FROM records WHERE id = $1", [job.record_id])).rows[0];
  if (!source && !elsewhere) return true;   // the source's stage row went with the record
  if (!loc?.deleted) {
    const hidden = source?.h === true;
    const moving = !elsewhere && (hidden || held);
    if (elsewhere || moving) {
      const why = elsewhere ? "handoff: the record moved to the other data class before the model call" : "handoff: a class move is in progress — processing goes on after it";
      // own row — under this stage's claim: the claim attempt is returned, the token removed; a row of another class may
      // come with the move as running — the count restarts, as in handoffMoved. A move still runs — the stage waits
      // MOVE_WAIT_SEC (retry_at: the scheduler sets the job no sooner, the claim skips it), not spinning on a model slot;
      // record in another class — its stage runs at once
      await recordsDb(ctx, job.class).query(
        `UPDATE record_stages SET status = 'pending', attempts = GREATEST(attempts - 1, 0), terminal = false, last_error = $3, claim_token = NULL, claimed_by = NULL,
                retry_at = CASE WHEN $4::int > 0 THEN now() + make_interval(secs => $4::int) ELSE retry_at END, updated_at = now()
          WHERE record_id = $1 AND stage = $2 AND status IN ('pending','running','failed')`, [job.record_id, job.stage, why, elsewhere ? 0 : MOVE_WAIT_SEC]);
      if (elsewhere)
        await recordsDb(ctx, loc.class as DataClass).query(
          `UPDATE record_stages SET status = 'pending', attempts = 0, terminal = false, last_error = $3, claim_token = NULL, claimed_by = NULL, updated_at = now()
            WHERE record_id = $1 AND stage = $2 AND status IN ('pending','running','failed')`, [job.record_id, job.stage, why]);
      log.info("llm_stage_handoff_before_model", { record_id: job.record_id, stage: job.stage, class: job.class, to: elsewhere ? loc.class : null, hidden, moving });
      return true;
    }
  }
  return false;
}

export interface Derived { type: "summary" | "event"; title: string; text: string; eventKind?: string | null; locator?: Record<string, unknown> | null; attrs?: Record<string, unknown>; processor: Record<string, unknown>; summaryLine?: string | null }

/**
 * Derived records: class, space, scope (with the list of people) and owner are inherited from the parent by code —
 * the model sets none of them. Older derived records of that kind stop being current and leave the index (their
 * fragments are deleted, embeddings by cascade) but stay readable by id. This happens on any repeated run of the
 * stage (memory_process_now, a retry after a failure); there is no separate recount for a new prompt version —
 * backfill_per_night is not used yet.
 */
const numberFromDb = (v: unknown): number | null => v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);

/**
 * What the model generated for a record of the open class passes the same check as a record from the gateway:
 * the model could rewrite «one and a half million dollars» as «$1.5M» or name an NDA-listed customer in full.
 * Returns texts that failed the check (by number); a refusal is a journal event (via derive: rules and kinds, no
 * content). The check did not fit in open_check.timeout_sec — a stage error: retry later, nothing is written to open.
 */
export async function openDerivedRefused(ctx: Ctx, parent: Pick<Rec, "id" | "class" | "space_id">, stage: string, texts: OpenCheckText[]): Promise<Set<number>> {
  const refused = new Set<number>();
  if (parent.class !== "open") return refused;
  const settings = openCheckSettings(ctx.settings);
  if (!settings.enabled) return refused;
  const kinds = new Set<string>(), rules = new Set<string>();
  for (let i = 0; i < texts.length; i++) {
    const found = await runOpenCheck(settings, [texts[i]!]);
    if (!found.length) continue;
    refused.add(i);
    for (const f of found) { kinds.add(f.kind); rules.add(f.rule); }
  }
  if (refused.size) {
    await auditWorker(ctx, { event_type: "processing", class: "open", record_ids: [parent.id], space_id: parent.space_id,
                             details: { op: "open_check_refused", via: "derive", stage, dropped: refused.size, kinds: [...kinds], rules: [...rules] } });
    log.info("derived_open_check_refused", { record_id: parent.id, stage, dropped: refused.size, rules: [...rules] });
  }
  return refused;
}

/**
 * Result of derived records. `suppressed` and `suppressedKeys`: how many new events landed non-current at once, and
 * their keys — links of these keys are not moved to the new events, they stay at their former ends.
 */
export interface DerivedResult { ids: string[]; keys: { inherited: number; fresh: number }; suppressed: number; suppressedKeys: string[] }

/**
 * Keys of meeting events that have a current correction by a person (`memory_correct extraction_error`),
 * with that version's id. Only its own meeting: a new meeting version does not inherit the earlier one's
 * corrections. A version deleted by a person does not suppress.
 */
export const CORRECTED_KEYS_SQL = `SELECT DISTINCT ON (event_key) event_key, id FROM records
  WHERE parent_id = $1 AND type = 'event' AND source_kind = 'correction' AND is_current AND deleted_at IS NULL AND event_key IS NOT NULL
  ORDER BY event_key, created_at DESC, id`;

/**
 * Is suppression on: `processing.events.suppress_corrected`, yes by default — a deliberate exception to the rule
 * «everything new is off». Raised databases where the setting has no field yet — also yes.
 */
export const suppressCorrected = (settings: Pick<Ctx["settings"], "get">): boolean =>
  settings.get<{ suppress_corrected?: unknown }>("processing.events", {}).suppress_corrected !== false;

/** Keys of the last generation of meeting model events (new version: the earlier one's). */
const LAST_GENERATION_SQL = `SELECT event_key FROM records WHERE parent_id = $1 AND type = 'event' AND source_kind = 'pipeline' AND deleted_at IS NULL
          AND created_at = (SELECT max(created_at) FROM records WHERE parent_id = $1 AND type = 'event' AND source_kind = 'pipeline' AND deleted_at IS NULL)`;
/** Key candidates — meeting events with keys of the generation and groups of current non-model corrections. */
const KEY_CANDIDATES_SQL = `WITH keys AS (SELECT unnest($2::uuid[]) AS key UNION
           SELECT event_key FROM records WHERE parent_id = ANY($1::uuid[]) AND type = 'event' AND source_kind <> 'pipeline' AND is_current AND deleted_at IS NULL)
         SELECT id, event_key, event_kind AS kind, title, attrs->>'quote' AS quote, locator->>'time_from' AS time_from,
                locator->>'time_to' AS time_to, created_at FROM records
         WHERE parent_id = ANY($1::uuid[]) AND type = 'event' AND deleted_at IS NULL AND event_key IN (SELECT key FROM keys)`;
const keyCandidate = (r: Record<string, any>): KeyCandidate => ({ ...r, time_from: numberFromDb(r.time_from), time_to: numberFromDb(r.time_to) }) as KeyCandidate;

/**
 * keepWhenRefused — rebuilding ready derived records (summary section from cards, summary-actions.ts): if the open
 * check refused even one new record, the earlier ones stay current and nothing is written — else the open meeting
 * would lose its summary until the stage retries. The summary/events stages call without it — as before.
 */
export async function replaceDerived(ctx: Ctx, parent: Rec, kind: "summary" | "event", all: Derived[], o: { keepWhenRefused?: boolean } = {}): Promise<DerivedResult> {
  // derived records of an open record — only those that passed the open-class check; others are not written
  const refused = await openDerivedRefused(ctx, parent, kind, all.map((d) => ({ field: "derived", value: [d.title, d.summaryLine, d.text].filter(Boolean).join("\n") })));
  if (o.keepWhenRefused && refused.size) return { ids: [], keys: { inherited: 0, fresh: 0 }, suppressed: 0, suppressedKeys: [] };
  const items = all.filter((_, i) => !refused.has(i));
  const db = recordsDb(ctx, parent.class), ids: string[] = [], keys = { inherited: 0, fresh: 0 };
  const suppressedIds: string[] = [], suppressedKeys: string[] = [];
  const maxChunkTokens = ctx.settings.get<{ maximum: number }>("processing.chunk", { maximum: 480 }).maximum;
  const old = await tx(db, async (c) => {
    // Applying the plan holds the parent FOR UPDATE until the check and action. The model works before
    // this short lock; after the wait, no derived records of a deleted/hidden/spent meeting come back.
    // Home, scope and owner are read again too: the model could finish after the space was moved.
    const current = (await c.query(
      "SELECT class,space_id,audience,owner_id FROM records WHERE id=$1 AND deleted_at IS NULL AND hidden_at IS NULL AND is_current FOR UPDATE",
      [parent.id])).rows[0];
    if (!current || current.class !== parent.class) return [] as string[];
    parent = { ...parent, space_id: current.space_id, audience: current.audience, owner_id: current.owner_id };
    const prev = (await c.query("UPDATE records SET is_current = false WHERE parent_id = $1 AND type = $2::record_type AND source_kind = 'pipeline' AND is_current AND deleted_at IS NULL RETURNING id, event_key", [parent.id, kind])).rows;
    let inherited: Array<string | null> = [];
    if (kind === "event") {
      // Last generation: spent by this run; for a new meeting version — the earlier one's last generation.
      // Old backfill keys of older generations do not compete with keys of the current generation.
      let seeds = prev.map((r) => r.event_key as string).filter(Boolean);
      if (!prev.length && parent.supersedes_id) seeds = (await c.query(LAST_GENERATION_SQL, [parent.supersedes_id])).rows.map((r) => r.event_key as string);
      const parents = [parent.id, parent.supersedes_id].filter((id): id is string => Boolean(id));
      // The group has the original and correction; one a person deleted is no candidate. No future source_kind literal.
      const candidates = (await c.query(KEY_CANDIDATES_SQL, [parents, seeds])).rows.map(keyCandidate);
      // A new meeting version whose earlier one lies in the open database (a corrected text of a meeting open to agents):
      // supersedes_id does not hold across databases — the generation and correction groups of the earlier one are read
      // from the open database via attrs.supersedes_id_other_class, else all events of the new version get new keys.
      // Only open → closed: closed titles and quotes never reach open processing
      const otherPrev = !prev.length && !parent.supersedes_id && parent.class === "closed" && typeof parent.attrs?.supersedes_id_other_class === "string"
        ? parent.attrs.supersedes_id_other_class as string : null;
      if (otherPrev) {
        const open = recordsDb(ctx, "open");
        const openSeeds = (await open.query(LAST_GENERATION_SQL, [otherPrev])).rows.map((r) => r.event_key as string);
        candidates.push(...(await open.query(KEY_CANDIDATES_SQL, [[otherPrev], openSeeds])).rows.map(keyCandidate));
      }
      inherited = inheritEventKeys(candidates, items.map((d) => ({ kind: d.eventKind ?? "", title: d.title,
        quote: typeof d.attrs?.quote === "string" ? d.attrs.quote : null, time_from: numOrNull(d.locator?.time_from), time_to: numOrNull(d.locator?.time_to) })),
        { quoteThreshold: ctx.settings.get("processing.events", { fuzzy_threshold: 0.9 }).fuzzy_threshold,
          titleThreshold: DEFAULT_VERIFY_PARAMS.dedupeTitleThreshold, windowSec: EVENT_KEY_WINDOW_SEC });
    }
    // The model does not return an event a person corrected — a new event with the key of the current correction
    // version lands non-current at once (no fragment, not indexed); the person's version stays the only current.
    // Keys — those already assigned (candidates as is), under the same FOR UPDATE of the meeting as the spending.
    const corrected = new Map<string, string>();
    if (kind === "event" && items.length && suppressCorrected(ctx.settings))
      for (const r of (await c.query(CORRECTED_KEYS_SQL, [parent.id])).rows) corrected.set(r.event_key as string, r.id as string);
    for (const [ordinal, d] of items.entries()) {
      const id = newId(); ids.push(id);
      const eventKey = kind === "event" ? inherited[ordinal] ?? id : null;
      if (kind === "event") { if (inherited[ordinal]) keys.inherited++; else keys.fresh++; }
      const by = eventKey ? corrected.get(eventKey) ?? null : null;
      if (by) { suppressedIds.push(id); suppressedKeys.push(eventKey!); }
      await c.query(
        `INSERT INTO records (id, type, class, space_id, audience, owner_id, source_kind, source_ref, parent_id, locator, method, origin, occurred_at, title, summary_line, event_kind, token_count, processor, attrs, event_key, is_current)
         VALUES ($1,$2,$3,$4,$5,$6,'pipeline',$7,$8,$9,'extracted_by_model','agent',$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, d.type, parent.class, parent.space_id, parent.audience, parent.owner_id, parent.id, parent.id, d.locator ? JSON.stringify(d.locator) : null, parent.occurred_at,
         d.title, d.summaryLine ?? null, d.eventKind ?? null, estimateTokens(d.text), JSON.stringify(d.processor),
         JSON.stringify(by ? { ...(d.attrs ?? {}), suppressed_by_correction: by } : d.attrs ?? {}), eventKey, !by]);
      await c.query("INSERT INTO record_content (record_id, text) VALUES ($1,$2)", [id, d.text]);
      await c.query("INSERT INTO record_people (record_id, person_id) SELECT $1, person_id FROM record_people WHERE record_id = $2 ON CONFLICT DO NOTHING", [id, parent.id]);
      // Code inherits project labels with the record's home; explicit mentions come from their own stage.
      await c.query("INSERT INTO record_entities (record_id, entity_id, role, method, confidence) SELECT $1, entity_id, role, method, confidence FROM record_entities WHERE record_id = $2 AND role = 'space' ON CONFLICT DO NOTHING", [id, parent.id]);
      if (by) {
        // suppressed: read by id (the locator below is set for all) but not searched: no fragment, nothing to index
        await c.query("INSERT INTO record_stages (record_id, stage, status, last_error) VALUES ($1,'indexed','skipped','suppressed_by_correction')", [id]);
        continue;
      }
      await c.query("INSERT INTO record_stages (record_id, stage) VALUES ($1,'indexed')", [id]);
      // a preliminary fragment in the same transaction: the event is found by full text right away, as it shows in derived
      // (else a race: stage events is done, the events not yet indexed). Stage indexed adds the embeddings.
      const tokens = estimateTokens(d.text);
      if (tokens <= maxChunkTokens && d.text.trim())
        await c.query("INSERT INTO chunks (id, record_id, ordinal, text, token_count, time_from_sec, time_to_sec, space_id, audience, type, occurred_at) VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10)",
          [newId(), id, [d.title, d.text].filter(Boolean).join("\n"), tokens, numOrNull(d.locator?.time_from), numOrNull(d.locator?.time_to), parent.space_id, parent.audience, d.type, parent.occurred_at]);
    }
    return prev.map((r) => r.id as string);
  });
  if (ids.length) await ctx.db.control.query(
    "INSERT INTO record_locations (record_id, class, space_id, type, owner_id) SELECT unnest($1::uuid[]), $2, $3, $4, $5 ON CONFLICT DO NOTHING", [ids, parent.class, parent.space_id, kind, parent.owner_id]);
  if (old.length) await db.query("DELETE FROM chunks WHERE record_id = ANY($1::uuid[])", [old]);   // old derived records are not searched
  if (suppressedIds.length) {
    // stage journal: only ids and a count — no titles or event text
    await auditWorker(ctx, { event_type: "processing", class: parent.class, record_ids: [parent.id, ...suppressedIds], space_id: parent.space_id,
                             details: { op: "suppressed_by_correction", stage: "events", suppressed: suppressedIds.length } });
    log.info("events_suppressed_by_correction", { record_id: parent.id, n: suppressedIds.length });
  }
  return { ids, keys, suppressed: suppressedIds.length, suppressedKeys };
}

export const dateLabel = (d: Date): string => new Date(d).toISOString().slice(0, 10);
export const TYPE_LABEL: Record<string, string> = { transcript: "meeting transcript", document: "document", summary: "meeting summary", event: "event", profile: "profile", note: "note" };

export async function peopleOf(ctx: Ctx, cls: DataClass, recordId: string): Promise<Array<{ id: string; login: string; display_name: string }>> {
  const ids = (await recordsDb(ctx, cls).query("SELECT person_id FROM record_people WHERE record_id = $1", [recordId])).rows.map((r) => r.person_id);
  return ids.length ? (await ctx.db.control.query("SELECT id, login, display_name FROM people WHERE id = ANY($1)", [ids])).rows : [];
}
