// Stage `converted`: the document original goes to the external converter and comes back as markdown.
// No model here — this is a wrapper around another service, so the stage version is fixed (`converter-v1`).
//
// Order: original from storage → upload to the converter → wait for the run → export of the profile → archive →
// `document.md` → record text. Then it follows the usual chain (`indexed` → `described` → `entities`).
//
// FAST MODE. Memory always sends `fast-extraction`. Its usual outcome at the real converter is
// REJECTED_AUTOMATED («a fast result does not pass full certification», the converter's documentation) with a ready
// text: it is a result, not a refusal — a reject does not mean the text is wrong; the file must be taken all the same.
// Export profile by run outcome (chooseExportProfile, like the converter gateway): draft DRAFT_UNCERTIFIED for
// REJECTED_AUTOMATED and NEEDS_REVIEW, MARKDOWN_PACKAGE for PASS_* (fast mode gives none — a guard for later).
// No early refusal by `extraction_summary.state`: the draft is always ordered; a refusal is only an empty archive or
// `document.md` with no text. Verdict and extraction state go to `attrs.conversion` and the log, for analysis.
// The real converter puts a ⚠ «not certified» header atop `document.md` itself, and for a run with no pages a note
// instead of text: a draft `document.md` is never empty. readConverterBundle strips the header and note; «no text» is
// ConverterNoText (`converter_no_text` in `conversion`). In the open class `unavailable` is «text not checked» (empty_text):
// a scan's `document.md` keeps page markup, images and rejected OCR reads, and nobody read the original's images.
// This is a check after the export, like empty text, not an early refusal: the closed class takes the draft.
// The same for `partial` — some pages are scans (partial_text): a signature page or a passport copy
// was read by nobody, yet the whole original would go to agents; in personal open — the fallback to closed.
//
// FAST LANE. Since the converter's fast lane shipped,
// a `fast-extraction` run gets profile `fast-lane`; exporting it returns 409 `export_assurance_conflict`. The result path
// is chosen by each run's `run.processing_profile`: `fast-lane` — JSON `GET /runs/{id}/fast-lane` (the archive
// `/fast-lane/bundle` if the JSON has no text, the answer is over the cap or past the request limit), else the old
// export, and on its 409 the same JSON. On the JSON path the extraction state is only from fastLaneOutcome: a page read
// by a model is `partial` (the whole scan path), one cut table is `ready`; on the
// export path it is the run's, and a fast-OCR mark in `document.md` raises `ready` to `partial`. Agents' file —
// `conversion.agent_file` (the AGENT_FILE condition in originals.ts). FAIL_RETRYABLE — a rerun
// at the converter (`/retry`, at most converter_max_reruns per «Retry» cycle), not a final error. The converter gets
// the neutral name `<record_id>.<extension>`.
//
// QUEUE. A pass is one short step by `conversion.phase`
// (convertDocument below): admission to window K under lock, the intent `uploading`, upload or a run action with
// a built-in wait of up to 20 s, a guarded poll, an OCR retry, applying the result. Waits are StageWait
// (no attempt spent), not seen in the journal. Below — the older rules the pass keeps.
//
// RESUME. `attrs.conversion = {status:"pending", run_id, document_id}` is written right after a successful
// upload, not only once the stage succeeds. A stage rerun with a saved `run_id` does NOT re-upload the file: it
// polls the same run and goes on from the export. If the converter has no such run any more (404) — start over.
// Idempotency keys are derived from `memconv|<record_id>|g<generation>` and the step, without the attempt
// number: a step retry and the next stage attempt (a break between upload end and writing `run_id`) both get from the
// converter the same session, document and run, not a new copy kept forever. The generation (`conversion.gen`)
// grows only when the previous upload is lost — run 404, upload session 404, 409 `idempotency_conflict`, 409
// `upload_state_conflict` (after one retry of the finish with the same key) — and at most 3 times per «Retry» cycle.
// Stage claim: every converter poll renews it, every mark in `conversion` is merged with the previous one
// (not replacing it) in one transaction with the renewal; «stage done» is fenced by claim_token. Claim lost (the stage
// is another process's) — StageClaimLost: the late one exits writing nothing.
//
// Failures: unavailable, 5xx and timeout throw: the stage fails with reason `converter_<kind>` and a retry term 5 → 25 min
// (a step error: the retry is set by afterStage by retry_at, not by pg-boss);
// an export without text, a rejected result, a cancelled run and a size over the cap — ConverterError with terminal, stage failed with no
// retries (stages.ts), and `attrs.conversion` keeps `{status:"failed", error_kind}` — else the record would look forever
// «still converting».
// Not one line of content reaches the logs: only run ids, sizes and durations.
//
// PERSONAL OPEN. A personal-key PDF in its own personal space is accepted open (`attrs.personal_open`); its text
// is checked here. A finding (or a textless scan) is no refusal: under the record lock a move to closed starts on behalf
// of the owner (`class_moves.via = open_check_fallback`, BEFORE hiding rows), the open DB rows are hidden, stage `converted`
// returns to `pending`, the mark to attrs (the finished move puts it in the locator; till then the record is open);
// outcome `handoff` (runStage keeps the status; the worker wakes the move). No converter text goes to the open DB:
// the closed copy gets it by its own export. Attempts are limited (`processing.retries.limit`, a pause between, set
// by kick), then a terminal refusal `open_check_fallback_failed`: the rows stay hidden, the original leaves
// the open storage (to closed, or deleted if closed refused it), and «Retry» on the move takes the record to
// closed, where the conversion goes on (the move returns the stage to pending). The fallback is only for a record still
// in the owner's personal space (one moved to a project gets the old refusal).
// Races: «Close» during the conversion and a duplicate job during a running move — the stage is handed to the class
// where the record lives now (`handoff`), not written into rows that are gone; the same at any stage exit — a refusal,
// an error, a retry: a refusal during a move keeps the original — the move takes it. The text is written under
// the record lock together with the «stage done» mark: a move will not copy `running`.
//
// TEAM OR PROJECT FROM THE WORKSPACE. A PDF a person uploaded in the workspace
// into an open team or project carries `attrs.keep_closed_on_findings`. A finding in the text that the author may
// show agents «despite» it (phone, mail beside a full name, tax id, contract number, sum), and a part-page scan with
// scan text display on — the same fallback to closed in the same space: people see the file, agents not; the author has
// the «Make available to agents» button. A secret, strict NDA, own rule, passport, insurance number, card (also past
// the list of 20 findings — sweepRules), a «never open» rule (domain tag, title pattern, entity kind,
// space — the gateway asked them only on a finding in the title), a textless scan, scans with the display off —
// the old final refusal.
// The «Make available to agents» and «in teams and projects» switches count at conversion time: off — the old refusal.
// Fallback attempts are used up and the closed storage refused the copy — unlike personal
// open, the original is NOT deleted: the file was accepted by design; it stays in the open bucket under its own key,
// is given to nobody (rows hidden, conversion unfinished), and «Retry» on the move takes it to closed.
import { createHash } from "node:crypto";
import { acceptedSettings, chooseExportProfile, classifyConverterError, converterActionBase, converterDedup, converterDocumentRunBody, CONVERTER_FAST_LANE_PROFILE, CONVERTER_FAST_PROFILE, CONVERTER_FAST_PROFILES, CONVERTER_PRINCIPAL_CHANGED, principalAcked,
         CONVERTER_MAX_GEN_BUMPS, ConverterClient, ConverterError, converterConfig, converterExportGone, converterHealth, converterIdempotencyBase, converterMissing, ConverterNoText, converterSession,
         ConverterStorageError, converterUploadLost, DEFAULT_CONVERTER_MAX_RERUNS, despiteSettings, estimateTokens, exportPathExtraction, extractionState, fastLaneBundleLowerBound, fastLaneBundleReason, fastLaneOutcome,
         formatOfMime,
         joinedTexts, log, neverOpenFindings, newId, normalizeConverterMarkdown, OPEN_CHECK_MAX_FINDINGS, OPEN_CHECK_UNCHECKED, openCheckFallback, openCheckFaultHit, openCheckReasons, openCheckSettings,
         OpenCheckTimeout, openCheckTimeoutUnchecked, openCheckTruncated, parseOpenCheckFallback, pdfSourceFlags, readConverterBundle, readConverterGate, runOpenCheck, s3GetBuffer, s3Put, s3Remove, sampleEveryRule,
         strictOpenCheckSettings, sweepRules, testHooksEnabled, tx, UNCERTIFIED_EXPORT_PROFILES, type AgentFileWhy, type ConversionFaultPoint, type ConverterBundle, type ConverterDocument, type ConverterGenBumpWhy,
         type ConverterRun, type DataClass, type ExtractionState,
         type FallbackFinding, type FastLaneBundleReason, type FastLaneOutcome, type FastLaneResult, type OpenCheckFallback, type OpenCheckFinding, type OpenCheckUnchecked } from "@memory/shared";
import type pg from "pg";
import { failureClass } from "@memory/connectors";
import { conversionFaultAt } from "../conversion-fault.ts";
import { admitConversion, conversionEvent, noteConversionMismatch, noteConversionResult, type AdmitResult } from "../conversion-queue.ts";
import { CONVERSION_INLINE_WAIT, conversionPhase, CYCLE_END_DROP, CYCLE_MARK, CYCLE_RESET, cycleStartDue, legacyNextAction, nextActionFor, pendingAction, pollDelaySec, queueBackoffSec, queueWaitCode,
         RUN_FIELDS, RUN_FINISHED, retireRun, runChange, uploadNeedsFreshGen, type ConversionPhase, type PendingAction, type WatchdogFailCode, type WatchdogLimits, watchdogDecision } from "../conversion-rules.ts";
import { auditWorker, recordsDb, type Ctx } from "../ctx.ts";
import { StageClaimLost, StageRefused, StageWait, type StageClaim, type StageJob } from "../stages.ts";
import { loadRecord, type Rec } from "./common.ts";
import { withDocVersionFinish } from "./doc-version-finish.ts";
import { originalRefs, wakeHeldIndex, withRecordLock } from "./maintenance.ts";
import { recordIdOfKey } from "./storage-orphans.ts";

/** A generation bump after a 404 (run, document, upload session): before a new upload — dedupe by sha. */
const DEDUP_AFTER: ReadonlySet<ConverterGenBumpWhy> = new Set<ConverterGenBumpWhy>(["run_not_found", "document_not_found", "upload_session_not_found"]);
/** The neutral name at the converter: `<record_id>.<extension>`. */
const CONVERTER_NAME_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i;

const TREE = "WITH RECURSIVE tree AS (SELECT id FROM records WHERE id = $1 UNION ALL SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id)";
const IN_FLIGHT = "SELECT id FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying') ORDER BY requested_at DESC LIMIT 1";

/** Conversion outcome: done, skipped or handoff — stage given to a move or another class; its status is already set. */
export type ConvertOutcome = "done" | "skipped" | "handoff";

/**
 * Stage `converted` in the record's current class is `pending` again with a clean count: «Close» during conversion
 * copied it to closed as `running` (else it would hang until stuck_running_hours), the fallback requeued it.
 */
async function stagePending(ctx: Ctx, cls: DataClass, recordId: string, why: string): Promise<void> {
  await recordsDb(ctx, cls).query(
    `UPDATE record_stages SET status = 'pending', attempts = 0, terminal = false, last_error = $2, updated_at = now()
     WHERE record_id = $1 AND stage = 'converted' AND status IN ('pending','running','failed')`, [recordId, why.slice(0, 200)]);
}

/**
 * The record is moving or has moved: a duplicate job with hidden rows and a running move, «Close»
 * in mid-conversion. Under the record lock (the move must finish): deleted — skipped; another class — the stage
 * of that class pending again, handoff; a move still running — own stage pending, handoff (the move takes it). null — work.
 */
async function handoffIfMoving(ctx: Ctx, job: StageJob, recordId: string): Promise<ConvertOutcome | null> {
  // The final control transaction switches the locator and ends the move together.
  const moving = (await ctx.db.control.query(IN_FLIGHT, [recordId])).rowCount;
  const here = (await ctx.db.control.query("SELECT class FROM record_locations WHERE record_id = $1", [recordId])).rows[0]?.class;
  const hidden = (await recordsDb(ctx, job.class).query("SELECT hidden_at IS NOT NULL AS h FROM records WHERE id = $1", [recordId])).rows[0]?.h === true;
  if (here === job.class && !hidden && !moving) return null;
  return withRecordLock(ctx, recordId, async () => {
    const loc = (await ctx.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [recordId])).rows[0];
    if (!loc || loc.deleted) return "skipped";
    if (loc.class !== job.class) { await stagePending(ctx, loc.class, recordId, "handoff: the record moved to the other data class during the conversion"); return "handoff"; }
    if ((await ctx.db.control.query(IN_FLIGHT, [recordId])).rowCount) { await stagePending(ctx, job.class, recordId, "handoff: a class move is in progress — the conversion goes on after it"); return "handoff"; }
    return null;
  });
}

/**
 * Whether other open-DB records refer to this record's original file. A key with this record's id (new uploads,
 * records.ts originalKey; a move copy under its own key) is its alone: nothing to check, and a DB fault won't block removal
 * Older keys (hash and file name) — originalRefs: used, free or unknown (the check failed).
 */
function openRefs(ctx: Ctx, recordId: string, key: string): Promise<"used" | "free" | "unknown"> {
  return recordIdOfKey(key) === recordId ? Promise.resolve("free") : originalRefs(ctx, "open", key, [recordId]);
}
const UNCHECKED_REFS = new Error("file references could not be checked, so the file was kept");

/** Acceptance hook processing.open_check_fault — read from the DB, like llm_fault: no wait for a settings reload. */
async function openCheckFault(ctx: Ctx): Promise<unknown> {
  return (await ctx.db.control.query("SELECT value FROM settings WHERE instance_id = $1 AND category = 'processing' AND key = 'open_check_fault'", [ctx.instanceId])).rows[0]?.value ?? null;
}

/**
 * Fallback attempts are used up: a file with a finding must not lie in the open storage with no
 * end. The original is copied to the closed bucket under the same key (the move's «Retry» treats it as moved) and
 * deleted from the open one; if the closed storage refused it, the file is deleted as on a plain refusal (else anyone with
 * open bucket credentials could read it). moved — in closed; removed — deleted (original key cleared); kept — left
 * (could not delete: logged), null — no original.
 * If another open DB record needs the file under that key (older uploads key by content hash and file name,
 * shared by equal files of different people), it stays in the open bucket: it is another's file and passed its own
 * check. The closed bucket copy stays the record's (moved); not copied — the record's key is cleared (removed). If refs
 * could not be checked — as with a failed delete: kept, the record keeps the key («needed» is the dangerous
 * side: the file would stay in the open bucket, unlinked and with no tombstone).
 * `keepOnCopyFail` — a person's file in a team or project: by design
 * such a file is not rejected but kept closed, and the space's people see it. If the closed storage refused the copy,
 * the file is NOT deleted: it stays in the open bucket under its key (kept); the record keeps the key. Nobody gets it
 * (rows hidden, the conversion not `done` — originals.ts); «Retry» on the move takes it to closed, the trash cleanup
 * deletes it. It leaves the open one only after a confirmed copy. Personal open — as before: deleted.
 */
async function originalOutOfOpen(ctx: Ctx, recordId: string, original: { key: string | null; mime: string | null }, keepOnCopyFail = false): Promise<"moved" | "removed" | "kept" | null> {
  if (!original.key) return null;
  const a = ctx.s3("open"), b = ctx.s3("closed");
  if (!a) return "kept";
  // a class of the failure, never the storage provider's text
  const warn = (what: string) => (e: unknown) => { log.warn(what, { record_id: recordId, error: failureClass(e) }); };
  const refs = await openRefs(ctx, recordId, original.key);
  const removeOpen = async (done: "moved" | "removed"): Promise<"moved" | "removed" | "kept"> => {
    if (refs === "used") return done;
    if (refs === "unknown") { warn("open_check_fallback_original_remove_failed")(UNCHECKED_REFS); return "kept"; }
    return s3Remove(a, original.key!).then(() => done, (e) => { warn("open_check_fallback_original_remove_failed")(e); return "kept" as const; });
  };
  try {
    if (!b) throw new Error("closed-class storage is not configured");
    await s3Put(b, original.key, await s3GetBuffer(a, original.key), original.mime ?? "application/octet-stream");
  } catch (e) {
    warn("open_check_fallback_original_copy_failed")(e);
    // a file in a team or project is the only original of an accepted document: not deleted before a confirmed copy
    return keepOnCopyFail ? "kept" : removeOpen("removed");
  }
  return removeOpen("moved");
}

/**
 * The personal-open PDF fallback: a finding in the text — memory moves it to closed. Under the lock
 * of the record: deleted — skipped; closed already («Close» won) — closed copy's stage pending, handoff; space no longer
 * the owner's personal one — null (the old refusal). A running move (say, a person's «Close») takes the record itself:
 * the mark refers to it, the stage is pending. Attempts used up and no move — a terminal refusal: the rows stay
 * hidden, the original leaves open storage (originalOutOfOpen). Else the move precedes hiding rows, so the reconciler
 * won't show them again; rows hidden, stage pending, mark in attrs (the finished move puts it in the locator; until then
 * the record is open), a journal event with author — the owner's «My actions».
 * `shared` — a person's file from the workspace into a team or project (keep_closed_on_findings, switches
 * on): the fallback also in the record's team or project; otherwise only one's own personal space. In a team or project
 * a terminal refusal keeps the original even when the closed storage refused it (kept, the key stays).
 */
async function fallbackToClosed(ctx: Ctx, job: StageJob, rec: Rec, db: pg.Pool, found: Omit<OpenCheckFallback, "tries" | "move_id">,
                                original: { key: string | null; mime: string | null }, shared = false, claim?: StageClaim): Promise<ConvertOutcome | null> {
  const limit = ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit;
  return withRecordLock(ctx, rec.id, async (): Promise<ConvertOutcome | null> => {
    const loc = (await ctx.db.control.query("SELECT class, deleted, space_id FROM record_locations WHERE record_id = $1", [rec.id])).rows[0];
    if (!loc || loc.deleted) return "skipped";
    if (loc.class !== job.class) { await stagePending(ctx, loc.class, rec.id, "handoff: the record was closed during the conversion"); return "handoff"; }
    const sp = (await ctx.db.control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [loc.space_id])).rows[0];
    const here = sp?.kind === "personal" ? sp.owner_id === rec.owner_id : shared && (sp?.kind === "team" || sp?.kind === "project");
    if (!sp || !here) return null;
    const attrs = (await db.query("SELECT attrs FROM records WHERE id = $1", [rec.id])).rows[0]?.attrs ?? {};
    const tries = parseOpenCheckFallback(attrs.open_check_fallback)?.tries ?? 0;
    const inflight = (await ctx.db.control.query(IN_FLIGHT, [rec.id])).rows[0];
    if (tries >= limit && !inflight) {
      // fenced by the claim: the stage row is under the transaction lock from the claim check on — a late pass
      // takes no original and writes no refusal over the new claimer's result
      let moved: Awaited<ReturnType<typeof originalOutOfOpen>> = null;
      await tx(db, async (c) => {
        await holdClaim(claim, c);
        // a person's file in a team or project — if the closed storage refuses, the original stays (kept), not deleted
        moved = await originalOutOfOpen(ctx, rec.id, original, sp.kind !== "personal");
        // the rows stay hidden: agents do not see a document with a finding until an admin retries the move
        await c.query(`${TREE} UPDATE records SET hidden_at = COALESCE(hidden_at, now()) WHERE id IN (SELECT id FROM tree)`, [rec.id]);
        if (moved === "removed") await c.query("UPDATE record_content SET original_key = NULL WHERE record_id = $1", [rec.id]);
        await mergeConversion(c, rec.id, { status: "failed", error_kind: "open_check_fallback_failed" });
      });
      await auditWorker(ctx, { event_type: "processing", class: job.class, record_ids: [rec.id], space_id: rec.space_id,
                               details: { op: "open_check_fallback_failed", via: "convert", tries, kinds: found.kinds, rules: found.rules, author: rec.owner_id, ...(moved ? { original: moved } : {}) } });
      log.warn("converter_open_check_fallback_failed", { record_id: rec.id, tries, original: moved });
      // the original's fate by outcome (once always «removed»; in a team or project it now stays). The stage
      // reason is cut to 200 chars with its code (stageErrorText); the texts fit
      const file = moved === "kept" ? "the original file was saved and is unavailable to anyone. “Retry” in “Class transfers” finishes the move"
        : `${moved === "moved" ? "the original file is already in closed storage" : moved === "removed" ? "the original file was deleted (closed storage rejected it)" : "the original file is missing"}. “Retry” in “Class transfers” resumes conversion`;
      throw new StageRefused("open_check_fallback_failed", `closed-class move failed ${tries} times; the document is hidden, ${file}`);
    }
    const moveId: string = inflight?.id ?? newId();
    // is the claim still this pass's? else a late pass would open a move and return to pending a stage that
    // another did
    await holdClaim(claim);
    if (!inflight)
      await ctx.db.control.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'open_check_fallback')", [moveId, rec.id, rec.owner_id]);
    const mark: OpenCheckFallback = { ...found, tries: tries + 1, move_id: moveId };
    try {
      await tx(db, async (c) => {
        await holdClaim(claim, c);
        await c.query(`${TREE} UPDATE records SET hidden_at = COALESCE(hidden_at, now()) WHERE id IN (SELECT id FROM tree)`, [rec.id]);
        await c.query("UPDATE records SET attrs = attrs || jsonb_build_object('open_check_fallback', $2::jsonb) WHERE id = $1", [rec.id, JSON.stringify(mark)]);
        await c.query(`UPDATE record_stages SET status = 'pending', attempts = 0, terminal = false, last_error = 'open_check_fallback: document is moving to the closed class', updated_at = now()
                       WHERE record_id = $1 AND stage = 'converted'`, [rec.id]);
      });
    } catch (e) {
      // claim lost between opening the move and the mark: our unstarted move is dropped (the rows are not hidden)
      if (e instanceof StageClaimLost && !inflight) {
        const gone = await ctx.db.control.query("DELETE FROM class_moves WHERE id = $1 AND status = 'pending'", [moveId])
          .then((r) => r.rowCount ?? 0, (err) => { log.warn("open_check_fallback_unwind_failed", { record_id: rec.id, error: failureClass(err) }); return 0; });
        // while the move was on record an index pass of the tree may have waited for it (holdWait, up to
        // HOLD_WAIT_CAP_SEC) — the move is gone without settling, the record stays in its class: its held stages are due now,
        // as after a failed move. Not deleted (the scheduler took it already) — that move settles and wakes them itself
        if (gone) await wakeHeldIndex(ctx, job.class, rec.id, null, moveId);
      }
      throw e;
    }
    await auditWorker(ctx, { event_type: "processing", class: job.class, record_ids: [rec.id], space_id: rec.space_id,
                             details: { op: "open_check_fallback", via: "convert", check_via: "convert", kinds: mark.kinds, rules: mark.rules, openable: mark.openable,
                                        move_id: moveId, tries: mark.tries, author: rec.owner_id,
                                        // in a team or project: «My actions» name the reasons in words
                                        ...(sp.kind !== "personal" ? { shared: true } : {}) } });
    log.info("converter_open_check_fallback", { record_id: rec.id, move_id: moveId, rules: mark.rules, tries: mark.tries });
    return "handoff";
  });
}

/**
 * «Never open» rules that need no content (domain tag, title pattern, linked entity kind,
 * space) — for a person's workspace PDF in a team or project: the gateway asked them only
 * on a finding in the title or file name; a text finding here is the same «no» as markdown at the gateway (the old
 * refusal, not a closed file). The gateway's pure function (neverOpenFindings); no rules — record DBs stay untouched.
 */
async function neverOpenHere(ctx: Ctx, db: pg.Pool, rec: Rec): Promise<FallbackFinding[]> {
  const rules = (await ctx.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [ctx.instanceId])).rows;
  if (!rules.length) return [];
  const row = (await db.query("SELECT domain_tags, source_kind FROM records WHERE id = $1", [rec.id])).rows[0];
  const domains = (row?.domain_tags ?? []) as string[];
  const entIds = (await db.query("SELECT DISTINCT entity_id FROM record_entities WHERE record_id = $1", [rec.id])).rows.map((r) => r.entity_id);
  const kinds = entIds.length ? (await ctx.db.control.query("SELECT DISTINCT kind FROM entities WHERE id = ANY($1)", [entIds])).rows.map((r) => String(r.kind)) : [];
  const slug = String((await ctx.db.control.query("SELECT slug FROM spaces WHERE id = $1", [rec.space_id])).rows[0]?.slug ?? "");
  return neverOpenFindings(rules, { type: rec.type, title: rec.title, domains, entityKinds: kinds, spaceSlug: slug,
                                    sourceKind: (row?.source_kind as string | undefined) ?? null, sourceRef: rec.source_ref });
}

/** The record is still in its owner's own personal space (personal open) — for the worker's refusal text. */
async function inOwnPersonal(ctx: Ctx, rec: Rec): Promise<boolean> {
  if (rec.attrs?.personal_open !== true) return false;
  const r = (await ctx.db.control.query(
    "SELECT s.kind, s.owner_id FROM record_locations l JOIN spaces s ON s.id = l.space_id WHERE l.record_id = $1", [rec.id])).rows[0];
  return r?.kind === "personal" && r.owner_id === rec.owner_id;
}

/**
 * Outcome fields of the last run in `attrs.conversion`. A «waiting for the converter» mark (new upload, rerun) drops them:
 * merged with the old mark, it would else show `pending` next to the old refusal or verdict (gateway conversionView).
 */
const OUTCOME_KEYS: readonly string[] = ["error_kind", "error_code", "verdict", "extraction_state", "export_id", "export_profile", "certified", "converted_at", "unchecked",
                                         "findings", "result_path", "processing_profile", "dc_status", "warning_codes", "agent_file", "agent_file_why", "source_format",
                                         "converter_release", "ocr_units"];

/**
 * Conversion facts in `records.attrs.conversion`; shown by the gateway's `conversionView`. A mark is MERGED with the old,
 * not put in its place: fields this step does not know (upload generation, run, the original's flags,
 * move marks) are kept; `drop` — which fields to remove. With a stage claim — in a transaction with its renewal on the same
 * connection: the stage row is locked till commit; claim lost (another process runs the stage) — rollback, StageClaimLost,
 * the late one writes nothing. Exported for the test.
 */
export async function patchConversion(db: pg.Pool, recordId: string, patch: Record<string, unknown>, claim?: StageClaim, drop: readonly string[] = []): Promise<void> {
  if (!claim) { await mergeConversion(db, recordId, patch, drop); return; }
  await tx(db, async (c) => {
    if (!(await claim.touch(c))) throw new StageClaimLost();
    await mergeConversion(c, recordId, patch, drop);
  });
}

/** Merges the `conversion` mark on the given connection (inside a fenced transaction): `drop` is removed, `patch` goes on top. */
async function mergeConversion(c: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">, recordId: string, patch: Record<string, unknown>, drop: readonly string[] = []): Promise<void> {
  await c.query(`UPDATE records SET attrs = attrs || jsonb_build_object('conversion',
                   (CASE WHEN jsonb_typeof(attrs->'conversion') = 'object' THEN attrs->'conversion' ELSE '{}'::jsonb END - $2::text[]) || $3::jsonb)
                 WHERE id = $1`, [recordId, [...drop], JSON.stringify(patch)]);
}

/** Is the stage claim still this pass's? no — StageClaimLost; `c` is the transaction connection (stage row locked until commit). */
async function holdClaim(claim: StageClaim | undefined, c?: pg.PoolClient): Promise<void> {
  if (claim && !(await claim.touch(c))) throw new StageClaimLost();
}

/** A non-negative integer from `conversion` (counters, generation); else 0. */
const count = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Waiting for the fast-lane draft to be published: the `fast-lane` run has finished, but
 * `GET /runs/{id}/fast-lane` still answers 404 (on the converter, publishing lags behind the run state).
 * In a pass — every 5 s up to 15 s; then the wait is out of the pass (StageWait once per `stageWaitSec`); `giveUpMs`
 * after the first 404 — step error `result_missing`, mismatch counter. An object, not constants: tests do not wait.
 */
export const FAST_LANE_PUBLISH_WAIT = { pollMs: 5_000, totalMs: 15_000, stageWaitSec: 60, giveUpMs: 30 * 60_000 };

/** How many times per attempt to order a new export in place of a dead one (converterExportGone): the «expired — new» chain ends. */
const EXPORT_RENEWALS = 2;

/** Fast-lane `failed` codes for «document too large» — a terminal `too_large`, like the converter's 413. */
const FAST_LANE_SIZE_ERRORS: ReadonlySet<string> = new Set(["input_too_large", "too_many_pages", "resource_limit"]);


/** Extensions the converter knows (the SUPPORTED_EXTENSIONS list of its fast-lane service). */
const CONVERTER_EXTENSIONS: ReadonlySet<string> = new Set(["pdf", "docx", "docm", "doc", "odt", "rtf", "epub", "pptx", "pptm", "ppsx", "ppt", "odp",
                                                           "xlsx", "xlsm", "xlsb", "xls", "ods", "csv", "txt", "md", "html", "htm"]);

/**
 * The file name for the converter — `<record_id>.<extension>` for all classes: a full name, a customer's
 * name and such in the file name do not stay at the converter forever (memory cannot delete its copy). Extension —
 * by the original's normalized type (the gateway found the format by its bytes — `Report.doc` holding a DOCX goes
 * as `.docx`); a type outside the converter's formats (old records) — by the real name, if the converter knows it: a tail
 * of the name after the last dot with no real extension («Offer.Final», «Act 10.2026») is part of the name too.
 * Else `bin`. The name itself stays in memory's `attrs.filename` and in the open check.
 */
export function converterFileName(recordId: string, filename: unknown, mime: string | null | undefined): string {
  const tail = /\.([A-Za-z0-9]{1,10})$/u.exec(typeof filename === "string" ? filename : "")?.[1]?.toLowerCase();
  const ext = tail && CONVERTER_EXTENSIONS.has(tail) ? tail : null;
  return `${recordId}.${formatOfMime(mime) ?? ext ?? "bin"}`;
}

/** The text and facts of a run's result — of one shape on both paths: the export and the fast lane. */
interface Converted {
  text: string;
  pages: number | null;
  /** For the open check and `conversion.extraction_state`. */
  extraction: ExtractionState | null;
  certified: boolean;
  exportProfile: string;
  exportId: string | null;
  /** More fields in `attrs.conversion`: result path, warnings, file to agents, format, release. */
  fields: Record<string, unknown>;
}

/**
 * The file to agents on the export path: a fast-OCR mark in `document.md` (lines read by a model with no
 * second check) — `agent_file = false`, reason `ocr`, as for a recognized fast-lane scan. A run's `partial` and
 * `unavailable` — the same reasons (`ocr`, `no_text`): the file is withheld anyway by extraction state (originals.ts).
 * Images and hidden PDF parts are not parsed here: that comes with a newer version of the
 * converter (JSON path, fastLaneOutcome).
 */
function exportAgentFile(extraction: ExtractionState | null, fastOcr: boolean, mime: string | null | undefined): { agent_file: boolean; agent_file_why: AgentFileWhy[] } {
  const why: AgentFileWhy[] = [];
  if (fastOcr || extraction === "partial") why.push("ocr");
  // an office file does not take the export path — office files are accepted only with the fast lane; just in
  // case, no file to agents here too
  const format = formatOfMime(mime);
  if (format && format !== "pdf" && format !== "csv") why.push("office");
  if (extraction === "unavailable") why.push("no_text");
  return { agent_file: why.length === 0, agent_file_why: why };
}

/**
 * The error for a fast-lane `failed` outcome: a terminal refusal — `too_large` for «too large», otherwise `rejected`;
 * an unknown code — a step error with a retry. The code goes to `ConverterError.code` and `conversion.error_code`: the
 * workspace turns it into words, not the error text.
 */
function fastLaneFailure(o: Pick<FastLaneOutcome, "error_code">, terminal: boolean): ConverterError {
  const code = o.error_code ?? "conversion_failed";
  const message = `converter could not process the document (${code})`;
  // an unknown code — also the mismatch counter: this is how the contract breaks, not the document
  if (!terminal) return new ConverterError("http", message, undefined, false, undefined, code, { mismatch: true });
  return new ConverterError(FAST_LANE_SIZE_ERRORS.has(code) ? "too_large" : "rejected", message, undefined, true, undefined, code);
}

/**
 * The original from class storage for the converter. No file under the key — terminal «original not found» (a retry
 * is useless); another storage failure — ConverterStorageError: the stage waits for storage, no attempts spent and
 * the converter breaker is not touched (class `storage`).
 */
async function readOriginal(s3: NonNullable<ReturnType<Ctx["s3"]>>, key: string): Promise<Buffer> {
  try { return await s3GetBuffer(s3, key); }
  catch (e) {
    const code = String((e as { code?: unknown }).code ?? "");
    if (code === "NoSuchKey" || code === "NotFound")
      throw new ConverterError("rejected", "original file was not found in storage. Upload the document again", undefined, true, undefined, "original_missing");
    throw new ConverterStorageError(`original file storage did not return the file (${code || (e as Error).name || "error"})`);
  }
}

/** The `records.attrs.conversion` mark as an object (else empty). */
type Conv = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The pause before a run retry after a transient conversion failure («one rerun_wait +10 min»). */
const FAILED_RERUN_DELAY_MS = 10 * 60_000;
/** The wait under a mismatch block and an admission pause: look again in 5 min. */
const BLOCK_WAIT_MS = 300_000;

/** Texts of the watchdog's final failure — for analysis; for people the workspace writes its own words by code. */
const WATCHDOG_FAIL_TEXT: Record<WatchdogFailCode, string> = {
  converter_fail_retryable: "converter could not process the document after retries",
  converter_cancelled: "processing was stopped by the converter",
  converter_stuck: "converter never started processing the document",
  converter_deadline: "converter did not finish processing within the time limit",
};

/**
 * Fast-lane `failed` codes → the refusal kind in `conversion.error_kind`: by it the workspace names the reason
 * in words (with no new conversionView fields), and so does the agent (read.ts, conversionNote). «Too large» — by
 * kind `too_large` (fastLaneFailure).
 */
const FAST_LANE_KINDS: Readonly<Record<string, string>> = {
  encrypted: "converter_encrypted", unsupported_format: "converter_unsupported",
  // PDF branch: damaged or no pages (the converter's PdfFailure) — «file damaged»
  malformed_document: "converter_malformed", malformed_pdf: "converter_malformed", no_pages: "converter_malformed",
  // the conversion itself failed even after a run retry — «the converter could not handle the document»
  timeout: "converter_gave_up", converter_crashed: "converter_gave_up", memory_limit: "converter_gave_up", converter_output_invalid: "converter_gave_up",
};

/** Error kind in `conversion.error_kind` (conversionView): memory's own codes as is, the rest by the client error kind. */
function errorKindOf(e: unknown): string {
  if (e instanceof ConverterNoText) return "converter_no_text";
  if (!(e instanceof ConverterError)) return "converter_error";
  const code = e.code ?? "";
  if (code === "original_changed" || code === "original_missing") return code;
  // memory's watchdog codes; converter codes like converter_crashed do not belong here — they are fast-lane `failed`
  if (code in WATCHDOG_FAIL_TEXT) return code;
  if (code === "doc_error_limit") return "converter_doc_error";
  if (code === "result_missing" || code === "copies_limit") return `converter_${code}`;
  if (e.kind !== "too_large" && FAST_LANE_KINDS[code]) return FAST_LANE_KINDS[code]!;
  // unexpected outcome (a fast-lane code off the list, a reply off the schema, a refused run action): «it did not
  // work — an admin will look»; 500 stays `converter_http` — «the converter answered with an error»
  if (e.mismatch === true || code === "unexpected_response" || code.startsWith("run_control_")) return "converter_unexpected";
  return `converter_${e.kind}`;
}

/**
 * Stage `converted` — one short pass over the conversion phase (the conversion queue). `claim` is runStage's stage claim:
 * renewed on every converter poll; it fences the marks in `conversion` and the outcome. Without it (manual run, unit
 * tests) — as before, unfenced.
 *
 * `conversion.phase` values:
 *   no phase  — queued: admission (admitConversion) and the `uploading` intent; after a final failure and the button — by
 *               `next_action` (`refetch` — poll the old run again, `new_run` — a new run on the document, `upload` —
 *               upload); old records with `run_id` — poll with no upload;
 *   uploading — the `pending_action` intent (upload by generation keys, new run `run-<n>`, `/retry` `retry-<n>`): a retry
 *               after a crash sends the same body, same key;
 *   submitted — polling and the watchdog; a finished run — `fetching`;
 *   rerun_wait — OCR rerun (ocr_failed) or rerun after a transient failure; when due — admission with priority and `/retry`;
 *   fetching  — the result, the open check (as before), the outcome in one fenced transaction.
 * Waits are StageWait (no attempt spent): polling by schedule, the queue by position, result publishing once a minute.
 * A final failure (terminal refusal, attempts used up, watchdog failure) drops the phase and writes `next_action`.
 */
export async function convertDocument(ctx: Ctx, job: StageJob, claim?: StageClaim): Promise<ConvertOutcome> {
  const loaded = await loadRecord(ctx, job.class, job.record_id);
  if (!loaded) return "skipped";                                   // record gone or no longer current
  const { rec, original } = loaded;
  if (rec.type !== "document") return "skipped";                   // only documents of convertible formats get this stage
  // a duplicate job during a running move (rows hidden) — leave the stage to the move
  const early = await handoffIfMoving(ctx, job, rec.id);
  if (early) return early;
  // shown to agents «as text only»: the file lies in the closed bucket,
  // agents already read the recognized text — a rerun would replace it with text the author did not agree to. First
  // the author hides it from agents; the event goes to «My actions»
  if (job.class === "open" && rec.attrs?.original_closed === true) {
    await auditWorker(ctx, { event_type: "processing", class: "open", record_ids: [rec.id], space_id: rec.space_id,
                             details: { op: "convert_refused", reason: "original_closed", author: rec.owner_id } });
    throw new StageRefused("original_closed", "To process the file again, first hide the record from agents");
  }

  const db = recordsDb(ctx, job.class);
  const raw = rec.attrs?.conversion;
  // current conversion state: every mark is merged both in the DB (patchConversion) and here
  const conv: Conv = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Conv) } : {};
  // an open-class check refusal is final (the original is deleted): a stage rerun (the «Retry» button, «process now»)
  // must not rewrite the reason to «original not saved» or call the converter again
  if (conv.status === "failed" && conv.error_kind === "open_check")
    throw new StageRefused("open_check", await inOwnPersonal(ctx, rec)
      ? "the document was refused because its text was not checked or failed the check. Upload it again"
      : "document text did not pass the open check. Upload the document to a closed team space");
  // the result path and its facts — into both the outcome and the final refusal mark: for analysis, with no content
  const meta: Record<string, unknown> = {};
  // extraction state of the JSON path: there the run's `extraction_summary` is not read
  let onJson = false, jsonExtraction: ExtractionState | null = null;
  let run: ConverterRun | null = null;
  // stage attempt number (runStage's claim raised it): the last — final failed, a refusal with no findings in the open
  // check
  let attempt = 0;
  const limit = ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit;
  const started = Date.now();

  /** A `conversion` mark: claim-fenced, merged with the old one here and in the DB. */
  const patch = async (p: Record<string, unknown>, drop: readonly string[] = []): Promise<void> => {
    await patchConversion(db, rec.id, p, claim, drop);
    for (const k of drop) delete conv[k];
    Object.assign(conv, p);
  };
  /** Wake the queue from a pass: the record left the window (fetching, suspicion, rerun_wait). A failure is only logged. */
  const wake = async (): Promise<void> => {
    await ctx.wakeConversion?.().catch((e) => log.warn("converter_wake_failed", { record_id: rec.id, error: failureClass(e) }));   // logged
  };
  const event = (details: Record<string, unknown>): Promise<void> => conversionEvent(ctx, job, details, rec.space_id);
  /** Record runs left at the converter with no record: to the journal; no cancel (the account has none). */
  const orphanRun = async (why: string): Promise<void> => {
    if (str(conv.run_id)) await event({ op: "orphan_run", run_id: str(conv.run_id), document_id: str(conv.document_id), why });
  };

  try {
    // not configured — a wait under the `config` breaker (convertPass), not spent attempts
    const cfg = converterConfig(ctx.settings);
    if (!cfg) throw new ConverterError("auth", `document converter is not configured: ${converterMissing(ctx.settings).join(", ") || "integrations.converter_*"}`, undefined, false, undefined, "not_configured");
    const s3 = ctx.s3(job.class);
    if (!s3) throw new ConverterStorageError(`storage for class ${job.class} is not configured. The original file cannot be read`, "storage_not_configured");
    attempt = Number((await db.query("SELECT attempts FROM record_stages WHERE record_id = $1 AND stage = 'converted'", [rec.id])).rows[0]?.attempts ?? 0);
    // a client per job, one login session per process; SIGTERM aborts the request (`aborted`)
    const session = converterSession(cfg);
    const signal = ctx.abort;
    // upload generation: the base of upload keys is the record and generation, no attempt number; it grows only when
    // the old upload is lost (bumpGen), at most CONVERTER_MAX_GEN_BUMPS times per cycle, never reset
    let gen = count(conv.gen);
    const filename = String(rec.attrs?.filename ?? rec.source_ref ?? `${rec.id}.pdf`);
    /** Bench chaos hook: a pass point — a failure on request via `processing.conversion_fault`; no test hooks — nothing. */
    const fault = (point: ConversionFaultPoint): Promise<void> => conversionFaultAt(ctx, point, [rec.title, filename]);
    const hooks = testHooksEnabled();
    /** Dedupe by sha is on (`integrations.converter_dedup`): only then does the upload intent carry the search flag. */
    const dedupOn = converterDedup(ctx.settings) === "document";
    const client = (): ConverterClient => new ConverterClient(cfg, { idempotencyBase: converterIdempotencyBase(rec.id, gen), session, ...(signal ? { signal } : {}), ...(hooks ? { onStep: fault } : {}) });
    // the converter gets a neutral name; the real one stays in attrs.filename and goes to the open check
    const converterName = converterFileName(rec.id, filename, original.mime);
    const maxReruns = cfg.maxReruns ?? DEFAULT_CONVERTER_MAX_RERUNS;
    const limits: WatchdogLimits = {
      suspectMin: Number(ctx.settings.get("integrations.converter_accepted_suspect_min", 30)) || 30,
      rerunMin: Number(ctx.settings.get("integrations.converter_accepted_rerun_min", 90)) || 90,
      deadlineHours: Number(ctx.settings.get("integrations.converter_run_deadline_hours", 10)) || 10,
      maxReruns,
    };
    // the stage claim is renewed on every converter poll: claim lost — StageClaimLost, the late one writes nothing
    const touch = async (): Promise<void> => { if (claim && !(await claim.touch())) throw new StageClaimLost(); };
    /** A pause inside a pass; a process stop breaks it (`aborted`). */
    const pause = (ms: number): Promise<void> => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new ConverterError("network", "the run was interrupted because the worker stopped", undefined, false, undefined, "aborted")); return; }
      const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
      const stop = () => { clearTimeout(t); reject(new ConverterError("network", "the run was interrupted because the worker stopped", undefined, false, undefined, "aborted")); };
      signal?.addEventListener("abort", stop, { once: true });
    });
    /** «At the converter since …»: the cycle's first send time — the wait code's tail; the workspace shows it as HH:MM. */
    const since = (): string => str(conv.submitted_at) ?? str(conv.run_started_at) ?? new Date().toISOString();

    // ---------------------------------------------------------- upload generation and intents
    // New upload generation: the old one is lost — 404 of run or document, 404 of the upload session, key reused with other
    // parameters, a closed session. Each bump counts as a mismatch: under its block — a wait, not a bump.
    // Limit: CONVERTER_MAX_GEN_BUMPS per cycle, then step error `copies_limit`. `inWindow` — already admitted to window
    // K (it holds a place in flight): the upload intent at once. Else (a 404 after «Retry» with new_run, on the refetch path,
    // in phase fetching out of window) — generation +1, phase dropped, `next_action = upload`: admission decides
    // the upload (admitUpload); window K and the «new» pause hold, and an admission wait won't bump twice
    const bumpGen = async (why: ConverterGenBumpWhy, lostDoc: string | null = null, inWindow = true): Promise<void> => {
      const m = await noteConversionMismatch(ctx, job, `gen_bump:${why}`);
      if (m.blocked) throw new StageWait(new Date(Date.now() + BLOCK_WAIT_MS), "converter_wait:mismatch");
      if (count(conv.gen_bumps) >= CONVERTER_MAX_GEN_BUMPS)
        throw new ConverterError("http", "converter lost the document upload several times. The administrator can retry processing", undefined, false, undefined, "copies_limit");
      // current document's generation before the bump: «Retry» checks by it if a fresh upload is due (uploadNeedsFreshGen)
      const docGen = str(conv.document_id) ? (conv.doc_gen === undefined || conv.doc_gen === null ? gen : count(conv.doc_gen)) : null;
      gen += 1;
      const lost = lostDoc ? [...new Set([...strList(conv.lost_document_ids), lostDoc])] : null;
      const base = { gen, gen_bumps: count(conv.gen_bumps) + 1, gen_why: why, status: "pending", ...(docGen !== null ? { doc_gen: docGen } : {}), ...(lost ? { lost_document_ids: lost } : {}) };
      if (inWindow) await patch({ ...base, phase: "uploading", pending_action: { kind: "upload", seq: gen, ...(dedupOn && DEDUP_AFTER.has(why) ? { dedup: true } : {}) } });
      else await patch({ ...base, next_action: "upload" }, ["phase", "pending_action", "suspect_since", "rerun_at", "admitted_at", "fetch_404_since"]);
      log.info("converter_gen_bump", { record_id: rec.id, gen, gen_bumps: conv.gen_bumps, why, in_window: inWindow });
      await event({ op: "gen_bump", gen, why });
      if (lostDoc) await event({ op: "document_lost", document_id: lostDoc, gen });
    };
    /** Admitted to the window this cycle? (the admission intent writes `admitted_at`; refetch and fetching do not). */
    const admitted = (): boolean => Boolean(str(conv.admitted_at));
    /**
     * The converter has no such run (404 on `GET /runs/{id}`): same account — document lost, a new generation and upload
     * (off-window — via admission, bumpGen); account changed (`conversion.principal` ≠ `gate.principal`) — breaker
     * `config`: no new copies under another account until an admin confirms the change («Check
     * connection» with «account changed on purpose» — `principal_ack`): after that — as a lost document.
     */
    const runGone = async (inWindow: boolean): Promise<ConversionPhase> => {
      const { gate } = await readConverterGate(ctx.db.control, ctx.instanceId);
      const mine = str(conv.principal);
      if (mine && gate.principal && mine !== gate.principal && !principalAcked(gate))
        throw new ConverterError("auth", "converter account changed and can no longer access earlier documents", 404, false, undefined, CONVERTER_PRINCIPAL_CHANGED, { login: true });
      log.info("converter_run_gone", { record_id: rec.id, run_id: str(conv.run_id), in_window: inWindow });
      await bumpGen("run_not_found", str(conv.document_id), inWindow);
      return inWindow ? "uploading" : admitUpload();
    };
    /** Not admitted: a wait by position or by why the window is closed. */
    const notAdmitted = (r: AdmitResult): StageWait => {
      if (r.block === "hold_new") return new StageWait(new Date(Date.now() + BLOCK_WAIT_MS), "converter_wait:hold_new");
      if (r.block === "mismatch" || r.block === "stalled") return new StageWait(new Date(Date.now() + BLOCK_WAIT_MS), `converter_wait:${r.block}`);
      if (r.block === "gate") return new StageWait(new Date(Date.now() + 60_000), "converter_wait:unavailable", true);
      return new StageWait(new Date(Date.now() + queueBackoffSec(r.position, r.free) * 1000), queueWaitCode(r.position + r.inFlight));
    };
    /** Window admission with an intent; not let in — a wait. */
    const admit = async (intent: Record<string, unknown>, kind: PendingAction["kind"]): Promise<void> => {
      const r = await admitConversion(ctx, job, () => patch(intent, ["next_action"]));
      if (!r.admitted) throw notAdmitted(r);
      log.info("converter_admitted", { record_id: rec.id, kind, position: r.position, free: r.free });
      await event({ op: "admitted", kind, position: r.position, free: r.free });
    };
    /**
     * Would admission let the record in now (same count, same lock, no intent): no — a wait. Before a request to the
     * converter that only an admitted record needs (the last run for a new run): waiting in the queue does not
     * poke the converter on every pass.
     */
    const admitPeek = async (): Promise<void> => {
      const r = await admitConversion(ctx, job, async () => undefined);
      if (!r.admitted) throw notAdmitted(r);
    };
    /**
     * Upload admission. `fresh` — a new cycle after a final failure while this generation has a document
     * (uploadNeedsFreshGen): generation +1 in the same intent — the same keys would return the old document and first run.
     * A person's decision, not a loss: the mismatch counter and `gen_bumps` stay as they are.
     */
    const admitUpload = async (fresh: ConverterGenBumpWhy | null = null): Promise<ConversionPhase> => {
      const next = fresh ? gen + 1 : gen;
      // a new upload without a fresh generation (new record, bump after an off-window 404, «Retry» before the first copy) —
      // first look for an already uploaded document; a fresh generation by a person's choice — upload at once
      await admit({ status: "pending", phase: "uploading", gen: next, gen_bumps: count(conv.gen_bumps), pending_action: { kind: "upload", seq: next, ...(dedupOn && !fresh ? { dedup: true } : {}) },
                    admitted_at: new Date().toISOString(),
                    ...(fresh ? { gen_why: fresh } : {}) }, "upload");
      if (fresh) {
        gen = next;
        log.info("converter_gen_bump", { record_id: rec.id, gen, gen_bumps: count(conv.gen_bumps), why: fresh, in_window: true });
        await event({ op: "gen_bump", gen, why: fresh });
      }
      return "uploading";
    };
    /** A new run on the document: only on a fast-mode run; the body comes from the intent (`policy_release_id`). */
    const newRunIntent = (r: ConverterRun, why: string): Record<string, unknown> => {
      if (r.processing_profile && !CONVERTER_FAST_PROFILES.has(r.processing_profile))
        throw new ConverterError("http", "converter run is not in fast mode. The memory will not start a new run", undefined, false, undefined, "profile_not_fast", { mismatch: true });
      const seq = count(conv.action_seq) + 1;
      return { status: "pending", phase: "uploading", action_seq: seq, pending_action: { kind: "run", seq, why, policy_release_id: r.policy_release_id ?? null } };
    };

    // ---------------------------------------------------------- no phase: the queue or a new cycle after «Retry»
    const enter = async (): Promise<ConversionPhase> => {
      const status = str(conv.status);
      // a fresh record (or an old «waiting» mark, no run) — into the queue
      if (!status || (status === "pending" && !str(conv.run_id))) return admitUpload();
      // a new cycle: a final failure (or a ready document) and «Retry» / «Process now» / reprocessing —
      // cycle counts restart (the button no longer resets them: waits return the attempt; its number can't tell cycles).
      // Once per cycle (CYCLE_MARK): admission-wait passes do not erase the wait count (`waiting_since`)
      if (cycleStartDue(conv)) await patch({ ...CYCLE_RESET, submitted_at: null, [CYCLE_MARK]: new Date().toISOString() });
      const next = legacyNextAction(conv);
      if (next === "refetch") {
        const now = new Date().toISOString();
        await patch({ status: "pending", phase: "submitted", submitted_at: str(conv.submitted_at) ?? now, ...(str(conv.run_started_at) ? {} : { run_started_at: now }) }, ["next_action"]);
        return "submitted";
      }
      if (next === "new_run") {
        // last run: its profile and policy release; network before the admission lock, only if admission would let
        // it in: a queue wait leaves the converter alone
        await admitPeek();
        let last: ConverterRun;
        try { last = await client().run(str(conv.run_id)!); }
        catch (e) { if (e instanceof ConverterError && e.status === 404) return runGone(false); throw e; }
        await admit({ ...newRunIntent(last, "repeat"), admitted_at: new Date().toISOString() }, "run");
        return "uploading";
      }
      // upload: this generation already gave a document (run refused an action, profile not fast, document lost in the
      // last cycle) — a fresh generation, else the converter would return the old document and the first run
      return admitUpload(uploadNeedsFreshGen(conv) ? (conv.error_code === "run_control_conflict" ? "run_control_conflict" : "new_cycle") : null);
    };

    // ---------------------------------------------------------- dedupe by sha
    /** A search refusal after which dedupe is just skipped (upload as before): not unavailability, not login, not a stop. */
    const skippable = (e: unknown): boolean => e instanceof ConverterError && !e.login && e.code !== "aborted" && e.status !== undefined && e.status !== 429 && !(e.status >= 502 && e.status <= 504);
    /**
     * Is a document found at the converter an upload of our own class (fail closed by default)? The neutral
     * name `<record>.<extension>` — this record or a record of our class by locator; a record of the other class (including one
     * with no DB document mark yet: it fell between upload end and mark) — no. No name, another one (a document from
     * before neutral names, an unknown field in the reply) or no such record in memory (purged — its copy is on the
     * delete list) — only if a record of our class refers to the document. Else no candidate: upload our own copy.
     */
    const ownClassUpload = async (d: ConverterDocument): Promise<boolean> => {
      const id = CONVERTER_NAME_ID.exec(d.filename ?? "")?.[1]?.toLowerCase();
      if (id === rec.id) return true;
      if (id) {
        const loc = (await ctx.db.control.query("SELECT class FROM record_locations WHERE record_id = $1", [id])).rows[0];
        if (loc) return loc.class === job.class;
      }
      return Boolean((await db.query("SELECT 1 FROM records WHERE attrs->'conversion'->>'document_id' = $1 LIMIT 1", [d.document_id])).rowCount);
    };
    /**
     * A document already uploaded with the same sha: (1) our class's DB records with that fingerprint and a known document
     * of the same converter account; (2) else a converter search (v2, fallback v1). A candidate is skipped if lost for any
     * record of our class or tied to one of the other class (deleting one document shared by two classes would take away
     * a live record's source); one found at the converter — also if not known as our class's upload (ownClassUpload).
     * (3) Check the document by `GET /documents/{id}`: 404 — into this record's `lost_document_ids` (neighbours skip it),
     * then upload. The new run's policy release comes from the document's last run; not fast
     * mode or no release — upload. Another's run and result are never taken: if found, the record gets its own run.
     */
    const dedupFind = async (sha: string): Promise<{ document_id: string; policy_release_id: string; source: "local" | "dc"; principal: string | null } | null> => {
      const other: DataClass = job.class === "open" ? "closed" : "open";
      const lostMine = new Set(strList(conv.lost_document_ids));
      const { gate } = await readConverterGate(ctx.db.control, ctx.instanceId);
      const usable = async (docId: string): Promise<boolean> => {
        if (lostMine.has(docId)) return false;
        if ((await db.query("SELECT 1 FROM records WHERE attrs->'conversion'->'lost_document_ids' ? $1 LIMIT 1", [docId])).rowCount) return false;
        return !(await recordsDb(ctx, other).query(
          "SELECT 1 FROM records WHERE attrs->'conversion'->>'document_id' = $1 OR attrs->'conversion'->'lost_document_ids' ? $1 LIMIT 1", [docId])).rowCount;
      };
      const local = await db.query(
        `SELECT attrs->'conversion'->>'document_id' AS document_id, attrs->'conversion'->>'run_id' AS run_id, attrs->'conversion'->>'principal' AS principal
         FROM records WHERE attrs ? 'source_sha256' AND attrs->>'source_sha256' = $1 AND id <> $2 AND COALESCE(attrs->'conversion'->>'document_id', '') <> ''
         ORDER BY updated_at DESC LIMIT 20`, [sha, rec.id]);
      const seen = new Set<string>();
      let found: { document_id: string; source: "local" | "dc"; runHint: string | null } | null = null;
      for (const r of local.rows as Array<{ document_id: string; run_id: string | null; principal: string | null }>) {
        if (seen.has(r.document_id)) continue;
        seen.add(r.document_id);
        // another account's document is hidden from ours (404: «none» or «foreign»): no candidate, not «lost»
        if (r.principal && gate.principal && r.principal !== gate.principal) continue;
        if (await usable(r.document_id)) { found = { document_id: r.document_id, source: "local", runHint: r.run_id }; break; }
      }
      const c = client();
      if (!found) {
        const { docs } = await c.findDocumentsBySha(sha);
        for (const d of docs) {
          if (seen.has(d.document_id)) continue;
          seen.add(d.document_id);
          if (d.data_classification && d.data_classification !== cfg.classification) continue;
          if (!(await ownClassUpload(d))) continue;
          if (await usable(d.document_id)) { found = { document_id: d.document_id, source: "dc", runHint: d.latest_run_id }; break; }
        }
      }
      if (!found) return null;
      let doc: ConverterDocument | null;
      try { doc = await c.getDocument(found.document_id); }
      catch (e) {
        if (!skippable(e)) throw e;
        log.info("converter_dedup_skipped", { record_id: rec.id, document_id: found.document_id, status: (e as ConverterError).status ?? null });
        return null;
      }
      if (!doc) {
        await patch({ lost_document_ids: [...new Set([...strList(conv.lost_document_ids), found.document_id])] });
        log.info("converter_dedup_document_lost", { record_id: rec.id, document_id: found.document_id, source: found.source });
        await event({ op: "document_lost", document_id: found.document_id, why: "dedup_check", source: found.source });
        return null;
      }
      if ((doc.source_sha256 && doc.source_sha256 !== sha) || (doc.data_classification && doc.data_classification !== cfg.classification)) return null;
      for (const runId of [...new Set([doc.latest_run_id, found.runHint].filter((x): x is string => !!x))]) {
        let r: ConverterRun;
        try { r = await c.run(runId); }
        catch (e) { if (e instanceof ConverterError && (e.status === 404 || skippable(e))) continue; throw e; }
        if ((r.document_id && r.document_id !== found.document_id) || !r.policy_release_id) continue;
        if (r.processing_profile && !CONVERTER_FAST_PROFILES.has(r.processing_profile)) continue;
        return { document_id: found.document_id, policy_release_id: r.policy_release_id, source: found.source, principal: c.principal };
      }
      log.info("converter_dedup_no_release", { record_id: rec.id, document_id: found.document_id, source: found.source });
      return null;
    };

    // ---------------------------------------------------------- uploading: upload
    const stepUpload = async (): Promise<ConversionPhase> => {
      // the original is needed only for a new upload (the closed copy after the fallback is finished by the same run)
      if (!original.key) throw new ConverterError("rejected", "the original file was not saved to storage. There is nothing to convert", undefined, true, undefined, "original_missing");
      const bytes = await readOriginal(s3, original.key);
      // original bytes not as accepted: terminal refusal; an old record with no fingerprint — write it
      const sha = createHash("sha256").update(bytes).digest("hex");
      const known = str(rec.attrs?.source_sha256);
      if (known && known !== sha) throw new ConverterError("rejected", "the file in storage has changed — upload it again", undefined, true, undefined, "original_changed");
      if (!known) await writeSourceSha(db, rec.id, sha, claim);
      // a new upload: first an already uploaded document with the same sha — the record gets its own run on it
      const intent = pendingAction(conv);
      if (intent?.kind === "upload" && intent.dedup) {
        const reuse = dedupOn ? await dedupFind(sha) : null;
        if (reuse) {
          const seq = count(conv.action_seq) + 1;
          // the record's old run (lost — hence the generation bump) is not tied to the found document: it goes to
          // prior_runs — else a failure of the new run would give next_action = new_run on the lost run,
          // and «Retry» on its 404 would mark a neighbour's live document lost class-wide
          await patch({ status: "pending", phase: "uploading", document_id: reuse.document_id, doc_gen: gen, dedup_from: reuse.source, action_seq: seq,
                        principal: reuse.principal ?? str(conv.principal), pending_action: { kind: "run", seq, why: "dedup", policy_release_id: reuse.policy_release_id },
                        ...(retireRun(conv, "dedup", new Date()) ?? {}) }, str(conv.run_id) ? RUN_FIELDS : []);
          log.info("converter_dedup_found", { record_id: rec.id, document_id: reuse.document_id, source: reuse.source, seq });
          return "uploading";
        }
        // the flag is dropped before the first upload call: a retry after a crash mid-upload repeats it with the same keys
        // (same document and run at the converter), no new search — else it would find its own document and a second run
        await patch({ pending_action: { kind: "upload", seq: intent.seq } });
      }
      // flags from the PDF original's bytes that the fast lane does not read
      const sourceFlags = pdfSourceFlags(bytes);
      let up: { run_id: string; document_id: string } | null = null;
      while (!up) {
        const c = client();
        try { up = await c.upload(bytes, converterName, { classification: cfg.classification, profile: cfg.profile }); }
        catch (e) {
          const why = converterUploadLost(e);
          if (!why) throw e;
          log.info("converter_upload_lost", { record_id: rec.id, gen, why, status: (e as ConverterError).status ?? null });
          await bumpGen(why);
          // upload session 404 — a new intent with a sha search: the next step searches first and drops the flag before
          // the upload. Uploading on here is not allowed — after a crash mid-upload the search intent would find its own copy
          if (dedupOn && DEDUP_AFTER.has(why)) return "uploading";
          continue;
        }
        await fault("before_submitted_patch");
        const now = new Date();
        await patch({ status: "pending", phase: "submitted", profile: cfg.profile, gen, doc_gen: gen, source_flags: sourceFlags, principal: c.principal ?? str(conv.principal),
                      submitted_at: str(conv.submitted_at) ?? now.toISOString(), stuck: null,
                      ...runChange(conv, { run_id: up.run_id, document_id: up.document_id, why: "upload", now }) }, OUTCOME_KEYS);
        log.info("converter_uploaded", { record_id: rec.id, run_id: up.run_id, gen, bytes: bytes.length });
        await event({ op: "uploaded", run_id: up.run_id, document_id: up.document_id, gen, bytes: bytes.length });
      }
      return stepPoll(true);
    };

    // ---------------------------------------------------------- uploading: a new run on the document or /retry
    const stepAction = async (p: PendingAction): Promise<ConversionPhase> => {
      const runId = str(conv.run_id), docId = str(conv.document_id);
      const why = p.why ?? (p.kind === "retry" ? "fail_retryable" : "repeat");
      // no run or document — nothing to repeat; upload with the same generation
      if ((p.kind === "retry" && !runId) || (p.kind === "run" && !docId)) {
        await patch({ pending_action: { kind: "upload", seq: gen } });
        return "uploading";
      }
      let child: ConverterRun;
      try {
        if (p.kind === "retry") child = await client().withBase(converterActionBase(rec.id, "retry", p.seq)).retryRun(runId!, "retry", why);
        else {
          if (!p.policy_release_id)
            throw new ConverterError("http", "converter run has no policy release. A new run cannot start", undefined, false, undefined, "policy_release_missing", { mismatch: true });
          child = await client().withBase(converterActionBase(rec.id, "run", p.seq)).startDocumentRun(docId!, converterDocumentRunBody(p.policy_release_id, why), "start");
        }
      } catch (e) {
        if (!(e instanceof ConverterError)) throw e;
        // the action key is taken by another body (409 run_control_idempotency_conflict): action number +1 once and
        // the mismatch counter
        if (e.code === "run_control_idempotency_conflict" && count(conv.action_conflict_seq) !== p.seq) {
          const m = await noteConversionMismatch(ctx, job, e.code);
          if (m.blocked) throw new StageWait(new Date(Date.now() + BLOCK_WAIT_MS), "converter_wait:mismatch");
          const seq = count(conv.action_seq) + 1;
          await patch({ action_seq: seq, action_conflict_seq: seq, pending_action: { ...p, seq } });
          return "uploading";
        }
        // the document found by dedupe vanished between the check and the run: it goes to the lost (neighbours skip it), upload
        // with this generation (it uploaded nothing yet), no second search
        if (e.status === 404 && p.kind === "run" && why === "dedup") {
          log.info("converter_dedup_document_gone", { record_id: rec.id, document_id: docId });
          await patch({ lost_document_ids: [...new Set([...strList(conv.lost_document_ids), docId!])], pending_action: { kind: "upload", seq: gen } }, ["document_id", "dedup_from"]);
          await event({ op: "document_lost", document_id: docId, why: "dedup_run", gen });
          return "uploading";
        }
        // no such document at the converter (DocumentNotFound): new generation, upload, no dedupe on it; a record off the
        // window (action begun on path refetch) — upload via admission
        if (e.status === 404 && p.kind === "run") {
          log.info("converter_document_gone", { record_id: rec.id, document_id: docId });
          const inWindow = admitted();
          await bumpGen("document_not_found", docId, inWindow);
          return inWindow ? "uploading" : admitUpload();
        }
        if (e.status === 404 && p.kind === "retry") return runGone(admitted());
        // «request off the schema» on a run action — a step error and a mismatch, not a refusal of the document
        if (e.terminal && (e.status === 400 || e.status === 409 || e.status === 422))
          throw new ConverterError("http", e.message, e.status, false, e.detail, e.code ?? `http_${e.status}`, { mismatch: true });
        throw e;
      }
      await fault("before_submitted_patch");
      const now = new Date();
      // an OCR rerun (ocr_failed) has its own counter ocr_reruns, set on entering rerun_wait; the record's first run on a
      // document found by dedupe is not a rerun: no counter, no old parent run (that one is from another document)
      const reuse = p.kind === "run" && why === "dedup";
      const counted = !(p.kind === "retry" && why.startsWith("ocr_failed")) && !reuse;
      await patch({ status: "pending", phase: "submitted", rerun_why: reuse ? null : why, submitted_at: str(conv.submitted_at) ?? now.toISOString(), stuck: null,
                    ...(counted ? { reruns: count(conv.reruns) + 1 } : {}),
                    ...runChange(conv, { run_id: child.run_id, document_id: child.document_id || docId, why, now, parent: !reuse }) }, OUTCOME_KEYS);
      if (reuse) {
        log.info("converter_dedup_reuse", { record_id: rec.id, run_id: child.run_id, document_id: child.document_id || docId, source: str(conv.dedup_from) });
        await event({ op: "dedup_reuse", run_id: child.run_id, document_id: child.document_id || docId, source: str(conv.dedup_from), seq: p.seq });
        return stepPoll(true);
      }
      log.info(p.kind === "retry" ? "converter_rerun" : "converter_new_run", { record_id: rec.id, run_id: child.run_id, parent_run_id: runId, reruns: conv.reruns ?? 0, why });
      await event({ op: p.kind === "retry" ? "rerun" : "new_run", run_id: child.run_id, parent_run_id: runId, why, seq: p.seq });
      return stepPoll(true);
    };
    const stepUploading = async (): Promise<ConversionPhase> => {
      const p = pendingAction(conv);
      if (!p) { await patch({ pending_action: { kind: "upload", seq: gen } }); return "uploading"; }
      return p.kind === "upload" ? stepUpload() : stepAction(p);
    };

    // ---------------------------------------------------------- submitted: polling and the watchdog
    const stepPoll = async (inline: boolean): Promise<ConversionPhase> => {
      const runId = str(conv.run_id);
      if (!runId) { await patch({ phase: "uploading", pending_action: { kind: "upload", seq: gen } }); return "uploading"; }
      // inline wait right after a run change: up to 20 s, polling no more often than converter_poll_sec
      const until = inline ? Date.now() + CONVERSION_INLINE_WAIT.totalMs : 0;
      const every = Math.max(1, Math.min(CONVERSION_INLINE_WAIT.pollMs, cfg.pollMs));
      for (;;) {
        await fault("poll");
        let r: ConverterRun;
        try { r = await client().run(runId); }
        catch (e) { if (e instanceof ConverterError && e.status === 404) return runGone(admitted()); throw e; }
        run = r;
        const now = new Date();
        const d = watchdogDecision({ status: r.status, runStartedAt: str(conv.run_started_at), suspectSince: str(conv.suspect_since), reruns: count(conv.reruns), now, limits });
        // the converter state is written only on a change: a poll is one record_stages row
        const seen: Record<string, unknown> = r.status !== conv.dc_status ? { dc_status: r.status, dc_status_since: now.toISOString() } : {};
        if (d.kind === "finished") {
          await patch({ ...seen, phase: "fetching", suspect_since: null, fetch_404_since: null, processing_profile: r.processing_profile ?? null });
          await noteConversionResult(ctx);
          await wake();
          return "fetching";
        }
        if (d.kind === "retry") {
          const seq = count(conv.action_seq) + 1;
          await patch({ ...seen, phase: "uploading", suspect_since: null, action_seq: seq, pending_action: { kind: "retry", seq, why: d.why } });
          return "uploading";
        }
        if (d.kind === "new_run") {
          if (Object.keys(seen).length) await patch(seen);
          await patch({ ...newRunIntent(r, d.why), suspect_since: null });
          return "uploading";
        }
        if (d.kind === "fail") {
          if (Object.keys(seen).length) await patch(seen);
          throw new ConverterError("http", WATCHDOG_FAIL_TEXT[d.code], undefined, false, undefined, d.code, { exhausted: true });
        }
        if (d.kind === "suspect") {
          // ACCEPTED too long with live health: the record leaves the window, the next takes its place, alert
          if ((await converterHealth(cfg)).ok) {
            const minutes = Math.floor((now.getTime() - Date.parse(str(conv.run_started_at) ?? now.toISOString())) / 60_000);
            await patch({ ...seen, suspect_since: now.toISOString() });
            log.warn("converter_alert", { reason: "accepted_stuck", record_id: rec.id, run_id: runId, minutes });
            await event({ op: "suspect", run_id: runId, minutes });
            await event({ op: "alert", reason: "accepted_stuck", run_id: runId, minutes });
            await wake();
          } else if (Object.keys(seen).length) await patch(seen);
        } else if (Object.keys(seen).length || d.clearSuspect) await patch({ ...seen, ...(d.clearSuspect ? { suspect_since: null } : {}) });
        if (inline && Date.now() + every <= until) { await touch(); await pause(every); continue; }
        const age = Math.max(0, now.getTime() - Date.parse(str(conv.run_started_at) ?? now.toISOString()));
        throw new StageWait(new Date(Date.now() + (inline ? 30 : pollDelaySec(age)) * 1000), `converter_wait:poll: ${since()}`);
      }
    };

    // ---------------------------------------------------------- rerun_wait: a recognition or run rerun
    const stepRerunWait = async (): Promise<ConversionPhase> => {
      const why = str(conv.rerun_why) ?? "ocr_failed";
      const at = Date.parse(str(conv.rerun_at) ?? "");
      if (Number.isFinite(at) && at > Date.now())
        throw new StageWait(new Date(at), `converter_wait:${why.startsWith("ocr_failed") ? "ocr_rerun" : "rerun"}: ${new Date(at).toISOString()}`);
      const seq = count(conv.action_seq) + 1;
      await admit({ status: "pending", phase: "uploading", action_seq: seq, pending_action: { kind: "retry", seq, why }, admitted_at: new Date().toISOString() }, "retry");
      return "uploading";
    };
    /** A rerun later: phase rerun_wait with a due time; the window place is freed. */
    const toRerunWait = async (why: string, delayMs: number, counters: Record<string, unknown>): Promise<never> => {
      const at = new Date(Date.now() + delayMs);
      await patch({ phase: "rerun_wait", rerun_at: at.toISOString(), rerun_why: why, ...counters });
      log.info("converter_rerun_wait", { record_id: rec.id, run_id: str(conv.run_id), why, at: at.toISOString() });
      await wake();
      throw new StageWait(at, `converter_wait:${why.startsWith("ocr_failed") ? "ocr_rerun" : "rerun"}: ${at.toISOString()}`);
    };

    // ---------------------------------------------------------- fetching: result, open check, outcome
    // hidden PDF part flags of a run uploaded before they were kept — from the original; no original — no agent file anyway
    const flags = async (): Promise<string[]> => {
      const known = Array.isArray(conv.source_flags) ? strList(conv.source_flags) : null;
      if (known) return known;
      if (!original.key) return [];
      // the result exists at the converter: a lost file here is a step error, as before, not a refusal
      const got = pdfSourceFlags(await readOriginal(s3, original.key).catch((e: unknown) => {
        throw e instanceof ConverterError && e.code === "original_missing" ? new ConverterError("http", e.message, undefined, false, undefined, "original_missing") : e;
      }));
      await patch({ source_flags: got });
      return got;
    };
    const stepApply = async (): Promise<ConvertOutcome | ConversionPhase> => {
      const runId = str(conv.run_id), docId = str(conv.document_id);
      if (!runId) { await patch({ phase: "uploading", pending_action: { kind: "upload", seq: gen } }); return "uploading"; }
      for (const k of Object.keys(meta)) delete meta[k];
      onJson = false; jsonExtraction = null;
      if (!run || run.run_id !== runId) {
        // phase fetching is off window K: new upload only via admission
        try { run = await client().run(runId); }
        catch (e) { if (e instanceof ConverterError && e.status === 404) return runGone(false); throw e; }
      }
      // run not finished (a run change past this phase) — poll again
      if (!RUN_FINISHED.has(run!.status)) { await patch({ phase: "submitted" }); return "submitted"; }

      // ---------------------------------------------------------- export path (runs started before the fast lane)
      const viaExport = async (): Promise<Converted> => {
        meta.result_path = "export";
        // Export profile by the run outcome, like the converter's profile gate: a draft — only for an
        // uncertified outcome, a package — only PASS_*; otherwise the converter refuses (409, assurance conflict).
        const verdict = run!.status, state = extractionState(run!);
        const profile = chooseExportProfile(verdict);
        log.info("converter_export_profile_chosen", { record_id: rec.id, run_id: runId, verdict, extraction_state: state, export_profile: profile });
        if (!profile) throw new ConverterError("rejected", `converter run ${verdict}: no output to export`, undefined, true);
        // an export no longer served (expired after 7 days — «Retry» a week later; revoked; archive gone) —
        // a new export of the same run under its own key (converterExportGone): the old key would return the same one forever
        const c = client();
        let created = await c.createExport(runId, profile);
        let archive: Buffer | null = null;
        for (let renewed = 0; !archive; renewed++) {
          try {
            await c.waitExport(created.export_id, { timeoutMs: cfg.timeoutMs, pollMs: cfg.pollMs, onPoll: touch });
            archive = await c.download(created.export_id);
          } catch (e) {
            if (renewed >= EXPORT_RENEWALS || !converterExportGone(e)) throw e;
            log.info("converter_export_renewed", { record_id: rec.id, run_id: runId, export_id: created.export_id, code: (e as ConverterError).code ?? null });
            created = await c.createExport(runId, profile, created.export_id);
          }
        }
        let bundle: ConverterBundle;
        try { bundle = readConverterBundle(archive, { maxBytes: cfg.textMaxBytes ?? cfg.maxResponseBytes }); }   // text cap: converter_text_max_bytes
        catch (e) {
          // no text, and the converter said it extracted none (a scan with no text layer) — a clearer reason than «empty
          // document.md». Only this refusal: a broken archive or one without document.md keeps the old reason
          if (e instanceof ConverterNoText && state === "unavailable")
            throw new ConverterNoText(`converter extracted no text (a scan without recognizable text or an empty document): ${e.message}`);
          throw e;
        }
        // the fast-OCR mark is looked for before normalizing: a scan read by a model is `partial` (the whole
        // scan path), and no file goes to agents
        const { extraction, fast_ocr } = exportPathExtraction(run!, bundle.markdown);
        if (fast_ocr) log.info("converter_fast_ocr_note", { record_id: rec.id, run_id: runId, extraction_state: state });
        const { text, pages } = normalizeConverterMarkdown(bundle.markdown);
        return { text, pages, extraction, exportProfile: profile, exportId: created.export_id,
                 // «Certified» is an export property: a profile without a seal (or a warning file in the archive) means a draft
                 certified: !UNCERTIFIED_EXPORT_PROFILES.has(profile) && bundle.certified,
                 fields: { result_path: "export", warning_codes: [], ...exportAgentFile(extraction, fast_ocr, original.mime), source_format: formatOfMime(original.mime),
                           converter_release: null, ocr_units: null } };
      };

      // ---------------------------------------------------------- fast-lane path
      // JSON `/fast-lane`; a 404 for a finished fast-lane run — the result is not published yet: a short wait inside the
      // pass, then a wait outside it once a minute up to 30 min from the first 404, then a step error
      // `result_missing`, mismatch counter. Archive — when JSON has no text (over 32 MiB), the reply exceeds
      // converter_result_max_bytes or missed one request's time limit
      const viaFastLane = async (fastLane: boolean): Promise<{ result: FastLaneResult; path: "json" | "bundle" }> => {
        const until = Date.now() + FAST_LANE_PUBLISH_WAIT.totalMs;
        const c = client();
        let result: FastLaneResult | null = null, reason: FastLaneBundleReason | null = null;
        for (;;) {
          try { result = await c.fastLaneResult(runId); reason = fastLaneBundleReason(result); break; }
          catch (e) {
            reason = fastLaneBundleReason(e);
            if (reason) break;
            if (!(e instanceof ConverterError) || e.status !== 404) throw e;
            // safety net 2: not a fast-lane run, and the export already refused (409) — going back to it is pointless:
            // no path gave a result; the old terminal refusal
            if (!fastLane) throw new ConverterError("rejected", "converter did not return a run result through export or fast mode", 404, true, e.detail, e.code);
            if (Date.now() + FAST_LANE_PUBLISH_WAIT.pollMs <= until) { await touch(); await pause(FAST_LANE_PUBLISH_WAIT.pollMs); continue; }
            const first = Date.parse(str(conv.fetch_404_since) ?? "");
            const from = Number.isFinite(first) ? first : Date.now();
            if (!Number.isFinite(first)) await patch({ fetch_404_since: new Date(from).toISOString() });
            if (Date.now() - from >= FAST_LANE_PUBLISH_WAIT.giveUpMs) {
              log.info("converter_fast_lane_missing", { record_id: rec.id, run_id: runId });
              throw new ConverterError("http", `converter did not publish a fast-mode result (waited ${Math.round(FAST_LANE_PUBLISH_WAIT.giveUpMs / 60_000)} min)`,
                                       404, false, e.detail, "result_missing", { mismatch: true });
            }
            throw new StageWait(new Date(Date.now() + FAST_LANE_PUBLISH_WAIT.stageWaitSec * 1000), `converter_wait:publish: ${since()}`);
          }
        }
        if (!reason) return { result: result!, path: "json" };
        log.info("converter_fast_lane_bundle", { record_id: rec.id, run_id: runId, why: reason });
        return { result: await c.fastLaneBundle(runId, { lowerBoundBytes: result ? fastLaneBundleLowerBound(result) : null }), path: "bundle" };
      };

      // ---------------------------------------------------------- result: the path by the run profile
      // the path is by the run profile, not by a «fast lane shipped» flag: runs started before it finish by export
      const fastLane = run!.processing_profile === CONVERTER_FAST_LANE_PROFILE;
      meta.processing_profile = run!.processing_profile ?? null;
      let res: Converted | null = null;
      if (!fastLane) {
        try { res = await viaExport(); }
        catch (e) {
          // safety net 1: the converter gives no export of this run — the text via the fast-mode path
          if (!(e instanceof ConverterError) || e.kind !== "assurance_conflict") throw e;
          log.info("converter_export_assurance_conflict", { record_id: rec.id, run_id: runId });
        }
      }
      if (!res) {
        onJson = true; jsonExtraction = null;
        const got = await viaFastLane(fastLane);
        meta.result_path = got.path;
        // extraction state and agent file — only from the fast-lane outcome: the run's `extraction_summary` here is
        // `partial` even for one cut table, and `ready` for a scan read by a model
        const outcome = fastLaneOutcome(got.result, { sourceFlags: got.result.status === "failed" ? [] : await flags(), sourceFormat: formatOfMime(original.mime) });
        jsonExtraction = outcome.extraction;
        Object.assign(meta, { dc_status: outcome.dc_status, warning_codes: outcome.warning_codes, source_format: outcome.source_format,
                              converter_release: outcome.converter_release, ocr_units: outcome.ocr_units });
        if (outcome.dc_status === "failed") {
          meta.error_code = outcome.error_code;
          // the conversion itself failed (timeout, converter_crashed …) — one run retry in 10 min, then final
          if (outcome.error_class === "rerun" && count(conv.failed_reruns) < 1 && count(conv.reruns) < maxReruns)
            return toRerunWait(`conversion_failed:${outcome.error_code}`, FAILED_RERUN_DELAY_MS, { failed_reruns: count(conv.failed_reruns) + 1 });
          throw fastLaneFailure(outcome, outcome.error_class !== "job_error");
        }
        // the model could not read some pages (ocr_failed:*): one recognition rerun after converter_ocr_rerun_delay_min
        if (outcome.ocr_rerun && count(conv.ocr_reruns) < 1) {
          const delayMin = Math.max(1, Number(ctx.settings.get("integrations.converter_ocr_rerun_delay_min", 60)) || 60);
          return toRerunWait("ocr_failed", delayMin * 60_000, { ocr_reruns: count(conv.ocr_reruns) + 1 });
        }
        res = { text: outcome.text, pages: outcome.pages, extraction: outcome.extraction, certified: outcome.certified, exportProfile: outcome.export_profile, exportId: null,
                fields: { result_path: got.path, warning_codes: outcome.warning_codes, agent_file: outcome.agent_file, agent_file_why: outcome.agent_file_why,
                          source_format: outcome.source_format, converter_release: outcome.converter_release, ocr_units: outcome.ocr_units, dc_status: outcome.dc_status } };
      }
      await fault("after_fetch");
      const { text, pages, extraction } = res;
      const verdict = run!.status;

      // the fallback to closed took place — this record's run at the converter is left without it
      let fellBack = false;
      const fallback = async (...args: Parameters<typeof fallbackToClosed>): Promise<ConvertOutcome | null> => {
        const o = await fallbackToClosed(args[0], args[1], args[2], args[3], args[4], args[5], args[6] ?? false, claim);
        if (o === "handoff") fellBack = true;
        return o;
      };
      const openCheck = async (): Promise<ConvertOutcome | null> => {
        // Text goes into the open class only after the check (like a gateway write): a finding — the text is not written,
        // the original leaves open storage (else the space's readers would download it), the stage fails with no retries.
        // Empty text (a textless scan) cannot be checked — also a refusal: the original with data would reach readers.
        // The same for text the converter itself calls «not extracted» (`unavailable`): it holds page markup, images and
        // rejected OCR reads, and the content of image pages is not checked.
        // The check did not fit open_check.timeout_sec or did not run — a stage error (retry later), and on the last
        // attempt — refusal without findings: else conversion is «pending» forever with no journal trace. The original is
        // not served until conversion ends (gateway, originals.ts). Journal and `conversion` keep rules and kinds, no content.
        if (job.class === "open") {
          const settings = openCheckSettings(ctx.settings);
          let findings: OpenCheckFinding[] = [];
          // «never open» rules that fired: the refusal reason names them first
          let never: FallbackFinding[] = [];
          // page marks alone are also «text not extracted» (a scan with no text layer: the converter gives only page markup);
          // the converter's `unavailable` mark too, whatever is left in the text
          const bare = text.replace(/<!--\s*page:\s*\d+\s*-->/gu, "").trim();
          let unchecked: OpenCheckUnchecked | null = settings.enabled && (!bare || extraction === "unavailable") ? "empty_text" : null;
          // a person's file from the workspace into a team or project: panel switches as of conversion time
          const ds = rec.attrs?.keep_closed_on_findings === true ? despiteSettings(ctx.settings) : null;
          const keep = !!ds && ds.enabled && ds.projects;
          // …and some of its pages are scans, with scan text display on: the recognized text is checked as usual (findings
          // decide between close and refuse), but the document itself never gets into open — only by the fallback to closed
          const scans = keep && ds!.scansText && settings.enabled && extraction === "partial";
          // some pages are scans or images (`partial`): the recognized text
          // can be checked, but image pages (signature page, passport copy) cannot, and the whole original would reach agents.
          // Such a document is not taken into open; in personal open — the fallback to closed (like a scan with no text)
          if (settings.enabled && !unchecked && extraction === "partial" && !scans) unchecked = "partial_text";
          // title and file name were checked at upload, but readers see them with the text: a client's name in the title
          // and their email at the start of the file give no findings apart — so they are also checked joined, like at the
          // gateway (openFindings) and move (maintenance.ts); joined findings map to field and position (joinedTexts().map)
          const checked = joinedTexts([{ field: "title", value: rec.title }, { field: "filename", value: typeof rec.attrs?.filename === "string" ? rec.attrs.filename : null },
                                       { field: "text", value: text }]);
          if (!unchecked) {
            try {
              // test hook: «check server busy» for records with the substring in title or file name
              if (settings.enabled && openCheckFaultHit(await openCheckFault(ctx), [{ field: "title", value: rec.title }, { field: "filename", value: filename }]))
                throw new OpenCheckTimeout(settings.timeout_sec, "queue_full");
              findings = checked.map(await runOpenCheck(settings, checked.texts));
            }
            catch (e) {
              // check server busy or out of time — a stage error, retry later; on the last attempt — refusal with no findings:
              // the check itself ran out of time — timeout; server busy or stream unavailable — busy
              if (attempt < ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit) throw e;
              unchecked = e instanceof OpenCheckTimeout ? openCheckTimeoutUnchecked(e) : "check_failed";
            }
          }
          // personal open: a finding or a scan with no text — the fallback to closed, not a refusal; «busy» and «out of time» —
          // the old refusal. The space is checked under the lock in fallbackToClosed
          if (rec.attrs?.personal_open === true && (findings.length || unchecked === "empty_text" || unchecked === "partial_text")) {
            // some pages are scans: the recognized text is checked for the reason in the mark (findings next to «scans»);
            // a failure of this check decides nothing — the record goes to closed anyway, its mark says «text not checked»
            let textChecked = unchecked !== "empty_text";
            if (unchecked === "partial_text")
              findings = await runOpenCheck(settings, checked.texts).then(checked.map, () => { textChecked = false; return []; });
            // the list is cut — a second pass with the secrets, NDA and custom rules: openable by the uncut kinds
            const strict = openCheckTruncated(findings)
              ? await runOpenCheck(strictOpenCheckSettings(settings), checked.texts).then(checked.map, () => null) : undefined;
            const mark = openCheckFallback("convert", findings, { strict, ...(unchecked === "empty_text" || unchecked === "partial_text" ? { unchecked, textChecked } : {}) });
            const out = await fallback(ctx, job, rec, db, mark, original);
            if (out) return out;
          }
          // a person's file from the workspace into a team or project: findings that may be shown «despite» in a
          // team or project (all rules — even those past the list limit), or a scan of some pages — the fallback to
          // closed in the same space; «no» (secret, NDA, custom rule, passport, insurance number, card, a «never
          // open» rule) — the old refusal, naming them. The pass failed to run — as the main check: a stage retry; on the
          // last attempt — refusal, no findings
          if (keep && !unchecked && (findings.length || scans)) {
            let sweep: { never: OpenCheckFinding[]; more: OpenCheckFinding[]; complete: boolean } | null = null;
            try {
              sweep = await sweepRules(findings, "shared", async (accepted) => ({ findings: checked.map(await runOpenCheck(acceptedSettings(settings, accepted), checked.texts)), unchecked: null }));
            } catch (e) {
              if (attempt < ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit) throw e;
              unchecked = e instanceof OpenCheckTimeout ? openCheckTimeoutUnchecked(e) : "check_failed";
            }
            // «never open» rules — only when the rest allows keeping it closed (a read failure — a stage retry)
            if (sweep && !sweep.never.length && sweep.complete) never = await neverOpenHere(ctx, db, rec);
            if (sweep && !sweep.never.length && sweep.complete && !never.length) {
              // the mark also gets one finding per rule past the list limit: the mark's kind carries no rules
              const mark = openCheckFallback("convert", sampleEveryRule(findings, sweep.more, OPEN_CHECK_MAX_FINDINGS),
                                             { ...(openCheckTruncated(findings) ? { strict: sweep.more } : {}), ...(scans ? { unchecked: "partial_text" as const } : {}) });
              const out = await fallback(ctx, job, rec, db, mark, original, true);
              if (out) return out;
            }
            if (sweep?.never.length) findings = [...sweep.never.filter((f) => !findings.includes(f)), ...findings];
            // fallback not taken (the record left the team or project) and no findings — a scan is still not open: refusal as before
            if (scans && !unchecked && !findings.length && !never.length) unchecked = "partial_text";
          }
          if (unchecked || findings.length || never.length) {
            // the record is moving or has moved («Close» during conversion): not a refusal — the move takes the
            // original and stage (pending); the closed class completes it with no open check. Deleting the original here
            // would move into closed a record with no file and a failed conversion
            const moving = await handoffIfMoving(ctx, job, rec.id);
            if (moving) return moving;
            const rules = [...new Set([...never, ...findings].map((f) => f.rule))], kinds = [...new Set([...never, ...findings].map((f) => f.kind))];
            // the original key is cleared only if the file is deleted: else it stays in storage unreferenced (the trash cleanup
            // removes it). A file under the same key that another open-DB record needs (identical files share a key) — it
            // stays with it, and this record's key is cleared: the refused document has no original now. If refs could not
            // be checked — as with a failed delete: file and key stay, not a «foreign file» with the key cleared from the record
            const refs = original.key ? await openRefs(ctx, rec.id, original.key) : null;
            if (refs === "unknown") log.warn("open_check_original_remove_failed", { record_id: rec.id, error: UNCHECKED_REFS.message });
            // fenced by the claim: the stage row is under the transaction lock from the claim check until commit —
            // a late pass (its stage was taken over, maybe already done) neither deletes the original nor writes a refusal.
            // The mark is MERGED with the old one (generation, action number, prior runs, lost documents stay); dropped:
            // last cycle's outcome, phase
            await tx(db, async (c) => {
              await holdClaim(claim, c);
              const removed = !original.key || refs === "unknown" ? false
                : refs === "used" ? true
                : await s3Remove(s3, original.key).then(() => true, (e) => { log.warn("open_check_original_remove_failed", { record_id: rec.id, error: (e as Error).message.slice(0, 120) }); return false; });
              if (removed) await c.query("UPDATE record_content SET original_key = NULL WHERE record_id = $1", [rec.id]);
              // extraction state also goes with a refusal: by `partial` the workspace names the reason («some pages are scans»)
              await mergeConversion(c, rec.id, {
                status: "failed", error_kind: "open_check", profile: cfg.profile, run_id: runId, document_id: docId, gen, ...(extraction ? { extraction_state: extraction } : {}),
                ...(unchecked ? { unchecked } : { findings: [...never, ...findings].map((f) => ({ rule: f.rule, kind: f.kind })) }) }, [...OUTCOME_KEYS, ...CYCLE_END_DROP, "next_action"]);
            });
            await auditWorker(ctx, { event_type: "processing", class: "open", record_ids: [rec.id], space_id: rec.space_id,
                                     details: { op: "open_check_refused", via: "convert", kinds, rules, ...(unchecked ? { unchecked } : {}) } });
            log.info("converter_open_check_refused", { record_id: rec.id, run_id: runId, rules, unchecked });
            // check server busy every attempt: the document is not bad, just unchecked — the original already left open
            // storage, so «upload again», not «retry». In one's own personal space
            // no «to the team's closed space» advice: a refusal there never has findings; the same upload again
            // is taken anew (a dead record is not «the same file», write.ts)
            // Words for an employee (the stage in the workspace, «Unprocessed»): «shared space», not «open class»
            if (unchecked && await inOwnPersonal(ctx, rec))
              throw new StageRefused("open_check", `${OPEN_CHECK_UNCHECKED[unchecked]}: the document was refused because its text was not checked. The original file was deleted. Upload it again ${unchecked === "check_failed" ? "later" : "in a few minutes"}`);
            throw new StageRefused("open_check", unchecked === "busy"
              ? `${OPEN_CHECK_UNCHECKED.busy}: the document could not be checked on any attempt and was refused by the shared space. Upload it again later or to a closed team space`
              : unchecked
              ? `${OPEN_CHECK_UNCHECKED[unchecked]}: this document cannot be accepted in a shared space. Upload it to a closed team space`
              : `${[never.length ? `“never open” rule: ${[...new Set(never.map((f) => f.reason))].join(", ")}` : null,
                   findings.length ? `appears to contain ${openCheckReasons(findings)}` : null].filter(Boolean).join("; ")}; upload the document to a closed team space`);
          }
        }
        return null;
      };
      let checked: ConvertOutcome | null;
      try { checked = await openCheck(); }
      catch (e) {
        // an open check refusal: the original leaves open storage, but the copy at the converter stays
        if (e instanceof StageRefused && e.kind === "open_check") await orphanRun("open_check_refused");
        throw e;
      }
      if (checked) { if (fellBack) await orphanRun("open_check_fallback"); return checked; }

      // «Certified» is a property of the export (export path) or always false (the fast lane does not certify).
      // The extra fields — result path, file to agents (the AGENT_FILE condition in originals.ts), format, converter release,
      // reruns; not shown outside (`conversionView`): the contract holds. The outcome replaces the whole mark (phase, wait
      // and past refusal fields go), while upload generation, action number and lost documents stay: they are never
      // reset
      const certified = res.certified, profile = res.exportProfile;
      const conversion = {
        status: "done", run_id: runId, document_id: docId, verdict, ...(extraction ? { extraction_state: extraction } : {}),
        ...(res.exportId ? { export_id: res.exportId } : {}), export_profile: profile, profile: cfg.profile, certified,
        converted_at: new Date().toISOString(), processing_profile: meta.processing_profile ?? null, ...res.fields,
        ...(str(conv.parent_run_id) ? { parent_run_id: conv.parent_run_id } : {}), ...(count(conv.reruns) ? { reruns: count(conv.reruns) } : {}),
        ...(str(conv.rerun_why) ? { rerun_why: conv.rerun_why } : {}), ...(Array.isArray(conv.source_flags) ? { source_flags: strList(conv.source_flags) } : {}),
        ...(str(conv.principal) ? { principal: conv.principal } : {}), ...(str(conv.submitted_at) ? { submitted_at: conv.submitted_at } : {}),
        ...(Array.isArray(conv.prior_runs) && conv.prior_runs.length ? { prior_runs: conv.prior_runs } : {}),
        ...(strList(conv.lost_document_ids).length ? { lost_document_ids: strList(conv.lost_document_ids) } : {}),
        ...(count(conv.ocr_reruns) ? { ocr_reruns: count(conv.ocr_reruns) } : {}),
        gen, action_seq: count(conv.action_seq),
      };
      // the record may have moved during conversion («Close»): the text is written only where the record lives now,
      // under the record lock (a move holds it all along) and with the «stage done» mark — else the text would land in
      // rows the move already deleted, or a move between the text write and runStage's mark would copy the stage
      // as `running`
      await fault("before_final");
      const out = await withRecordLock(ctx, rec.id, async (): Promise<ConvertOutcome> => {
        const loc = (await ctx.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [rec.id])).rows[0];
        if (!loc || loc.deleted) return "skipped";
        if (loc.class !== job.class) { await stagePending(ctx, loc.class, rec.id, "handoff: the record moved to the other data class during the conversion"); return "handoff"; }
        if ((await ctx.db.control.query(IN_FLIGHT, [rec.id])).rowCount) { await stagePending(ctx, job.class, rec.id, "handoff: a class move is in progress — the conversion goes on after it"); return "handoff"; }
        // a new version of a converted document replaces the current one in this same transaction (doc-version-finish.ts)
        await withDocVersionFinish(ctx, job.class, rec.id, (finishVersion) => tx(db, async (c) => {
          // the outcome is claim-fenced and written first — the stage row is locked until commit: another process took the
          // stage — rollback, no text, no mark. claim_token is not cleared: runStage's fenced mark does that
          const stage = await c.query(`UPDATE record_stages SET status = 'done', version = $2, last_error = NULL, updated_at = now()
                                       WHERE record_id = $1 AND stage = 'converted'${claim ? " AND claim_token = $3" : ""}`, claim ? [rec.id, job.version, claim.token] : [rec.id, job.version]);
          if (claim && !stage.rowCount) throw new StageClaimLost();
          await c.query("UPDATE record_content SET text = $2, pages = $3 WHERE record_id = $1", [rec.id, text, pages]);
          await c.query("UPDATE records SET token_count = $2, attrs = attrs || jsonb_build_object('conversion', $3::jsonb) WHERE id = $1",
            [rec.id, estimateTokens(text), JSON.stringify(conversion)]);
          await finishVersion(c);
        }), { claim });
        return "done";
      });
      if (out !== "done") return out;
      log.info("converter_done", { record_id: rec.id, run_id: runId, verdict, extraction_state: extraction, export_profile: profile, certified, pages, chars: text.length,
                                   result_path: res.fields.result_path, agent_file: res.fields.agent_file, reruns: count(conv.reruns), ms: Date.now() - started });
      await event({ op: "applied", run_id: runId, result_path: res.fields.result_path ?? null, extraction_state: extraction ?? null, ms: Date.now() - started });
      return "done";
    };

    // ---------------------------------------------------------- the pass: phase to phase until a wait or outcome
    let phase: ConversionPhase = conversionPhase(conv) ?? await enter();
    for (let hops = 0; ; hops++) {
      // phases change a few times per pass (upload → poll → apply); more is a logic fault, not work
      if (hops > 12) throw new ConverterError("http", "conversion run did not converge", undefined, false, undefined, "pass_loop");
      if (phase === "uploading") phase = await stepUploading();
      else if (phase === "submitted") phase = await stepPoll(false);
      else if (phase === "rerun_wait") phase = await stepRerunWait();
      else {
        const out = await stepApply();
        if (out === "done" || out === "skipped" || out === "handoff") return out;
        phase = out;
      }
    }
  } catch (e) {
    // claim lost: another process runs the stage — no marks, runStage exits quietly. But «Close» in the middle of
    // a converter wait looks the same: the move copied the stage row to closed as
    // `running` with the old claim and deleted rows here — renewal failed. Then the stage in the record's class now
    // is pending again (handoff; under the record lock the move finishes), else the copy hangs until stuck_running_hours
    if (e instanceof StageClaimLost) {
      const moved = await handoffIfMoving(ctx, job, rec.id).catch((err) => { log.warn("convert_handoff_check_failed", { record_id: rec.id, error: (err as Error).message.slice(0, 120) }); return null; });
      if (moved === "handoff") return moved;
      throw e;
    }
    // an error or a retry (check server busy, converter unavailable, converter refusal) while the record is being moved
    // or has moved («Close»): the stage goes to the record's class now; else the failure would land in gone rows, and
    // the closed copy would hang as `running` until stuck_running_hours. StageRefused was settled above under the same
    // check
    if (!(e instanceof StageRefused)) {
      const moving = await handoffIfMoving(ctx, job, rec.id).catch((err) => { log.warn("convert_handoff_check_failed", { record_id: rec.id, error: (err as Error).message.slice(0, 120) }); return null; });
      if (moving) return moving;
    }
    if (e instanceof StageWait || e instanceof StageRefused) throw e;
    // mismatch: an unexpected outcome — the counter; under its block — a wait with no attempt spent
    const c = classifyConverterError(e);
    if (c.cls === "job_error" && c.mismatch) {
      const m = await noteConversionMismatch(ctx, job, c.code).catch((err) => { log.warn("converter_mismatch_note_failed", { error: (err as Error).message.slice(0, 120) }); return { blocked: false }; });
      if (m.blocked) throw new StageWait(new Date(Date.now() + BLOCK_WAIT_MS), "converter_wait:mismatch");
    }
    // a final failure (terminal refusal, attempts used up, watchdog failure) shows in `conversion`, not only in the
    // stage: else the record is «pending» forever. The phase is dropped, `next_action` by the reason: «Retry»
    // fetches the result again, starts a new run or uploads the file again
    const final = (e instanceof ConverterError && (e.terminal || e.exhausted === true)) || (c.cls === "job_error" && attempt >= limit);
    if (final) {
      const code = e instanceof ConverterError ? e.code ?? null : null;
      // the pass steps (closures) assign the run — the compiler can't see that
      const lastRun = run as ConverterRun | null;
      // extraction state: on the JSON path — from the fast-lane outcome, on the export path — from the run, as before
      const extraction = (onJson as boolean) ? jsonExtraction : lastRun ? extractionState(lastRun) : null;
      const next = nextActionFor({ phase: conversionPhase(conv), pendingKind: pendingAction(conv)?.kind ?? null, code, runId: str(conv.run_id), dcFailed: meta.dc_status === "failed" });
      let lost = false;
      await patchConversion(db, rec.id, {
        // «no text in the export» has its own code: the panel suggests a PDF with text instead of blaming the converter
        status: "failed", error_kind: errorKindOf(e), ...(code ? { error_code: code } : {}), next_action: next, profile: CONVERTER_FAST_PROFILE,
        ...(str(conv.run_id) ? { run_id: conv.run_id } : {}), ...(str(conv.document_id) ? { document_id: conv.document_id } : {}),
        ...(lastRun?.status ? { verdict: lastRun.status } : {}), ...(extraction ? { extraction_state: extraction } : {}),
        // result path, the fast-lane `failed` code — for analysis and the workspace's texts
        ...meta,
      }, claim, CYCLE_END_DROP).catch((err) => {
        if (err instanceof StageClaimLost) lost = true;
        else log.warn("conversion_failed_mark_failed", { record_id: rec.id, error: (err as Error).message.slice(0, 120) });
      });
      if (lost) throw new StageClaimLost();
      await event({ op: "failed", code: code ?? c.code, error_kind: errorKindOf(e), next_action: next, run_id: str(conv.run_id) });
    }
    // only ids and the machine code: the converter's error text (it may hold the file name) is not logged;
    // by run_id the full text is found in the converter's own log
    if (e instanceof ConverterError)
      log.warn("converter_failed", { record_id: rec.id, run_id: str(conv.run_id), document_id: str(conv.document_id), kind: e.kind, code: e.code ?? null, status: e.status ?? null,
                                     terminal: e.terminal, final });
    throw e;
  }
}

/** The byte fingerprint of an old record's original: only if it is not there yet; fenced by the claim. */
async function writeSourceSha(db: pg.Pool, recordId: string, sha: string, claim?: StageClaim): Promise<void> {
  const sql = "UPDATE records SET attrs = attrs || jsonb_build_object('source_sha256', $2::text) WHERE id = $1 AND NOT (attrs ? 'source_sha256')";
  if (!claim) { await db.query(sql, [recordId, sha]); return; }
  await tx(db, async (c) => {
    if (!(await claim.touch(c))) throw new StageClaimLost();
    await c.query(sql, [recordId, sha]);
  });
}
