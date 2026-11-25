import { inheritCardReview } from "./org-review.ts";
import { custodyAfterDelete, dismissedCustody, dismissedDueSql, dismissedMeetings, dismissedNotify, EMPTY_CUSTODY, EMPTY_MEETINGS, EMPTY_NOTIFY, type CustodyPassResult, type MeetingsPassResult,
         type NotifyPassResult } from "./custody.ts";
import { createHash } from "node:crypto";
import { acceptedSettings, ACCEPTABLE_RULES, audiencePrint, authorRole, canWriteRole, carryOrgReview, CHAIN_HEAD, CHAIN_TREE, CHAIN_TREES, chainTreeSql, consentRows, consentScope, contentPrint, custodyPolicy, CORRECTIONS_SUPERSEDE_SQL,
         despiteSettings, despiteShown, despiteVerdict, ensureProjectEntity, joinedTexts, LINEAGE_LOST_SQL, log, meetingOrigin, MemoryError, neverOpenFromTree, newId, OPEN_CHECK_UNCHECKED, openCheckReasons, openCheckSettings, OpenCheckTimeout,
         openCheckTimeoutUnchecked, openTreeTexts, legacyCharsetOf, legacyScanCharsetsOf, orgReviewEnabled, lastMoveShownShared, parseOpenCheckAccepted, parseOpenCheckMarkStrict, recheckHoldSummary, recheckHoldsToHead, recheckMark, recordPath, reviewDays, ruleOpenableByWord, runOpenCheck,
         HELD_ORIGINS_SQL, heldTreeCte, s3GetBuffer, s3Has, s3Put, s3Remove, showcaseSql, spaceMove, syncDeletionMarks, testLoginSql, tx, type ByWordConfirmation, type DataClass, type DespiteScope, type OpenCheckFinding, type OpenCheckUnchecked, type OpenRecheckWhy, type S3Target } from "@memory/shared";
import { LockConnectionLost, watchLock } from "@memory/shared";
import { auditWorker, auditWorkerStrict, recordsDb, type Ctx, type DbCtx } from "../ctx.ts";
import { QUEUE_OF, TOO_SLOW_PREFIX, versionFor } from "../stages.ts";
import { HOLD_CODE, HOLD_LONG_CODE } from "./indexing.ts";
import { nightCapState, nightWaiting } from "../night-cap.ts";
import { detachForMove } from "../conversion-rules.ts";
import { outcomesRetention } from "./outcomes.ts";
import { copyLinkDetailsForClose, deleteLocators, dropMovedDetails, purgeLinks, rollbackCopiedLinkDetails, sweepLinks, switchLinkClasses, type CopiedLinkDetails, type HeldLocator, type LinkSweepResult } from "./links.ts";

const TREE = CHAIN_TREE;
// Stages lock the parent before updating derived rows. UUID order (or an UPDATE's scan order) can lock a child first
// and deadlock with such a stage. Lock every source generation parent-first, then keep these locks through the write.
// A path also bounds traversal if malformed parent links contain a cycle; version-chain roots share depth zero.
const MOVE_SOURCE_LOCK = `${TREE}, lock_order AS (
  SELECT id, ARRAY[id] AS path FROM chain
  UNION ALL SELECT r.id, p.path || r.id FROM records r JOIN lock_order p ON r.parent_id = p.id
    WHERE NOT r.id = ANY(p.path)
) SELECT r.id FROM records r JOIN lock_order p ON p.id = r.id
  ORDER BY cardinality(p.path), r.id FOR UPDATE OF r`;
const TABLES = ["record_content", "record_people", "record_placements", "record_entities", "record_stages", "chunks"] as const;
const KEY: Record<string, string> = { record_content: "record_id", record_people: "record_id", record_placements: "record_id", record_entities: "record_id", record_stages: "record_id", chunks: "record_id" };
export const CORRECTIONS_SUPERSEDE = CORRECTIONS_SUPERSEDE_SQL;
export const CORRECTIONS_OF_TREE = "SELECT * FROM record_corrections WHERE target_id = ANY($1::uuid[]) OR result_id = ANY($1::uuid[])";
const TREES_OF = `${chainTreeSql("ANY($1::uuid[])")} SELECT id FROM tree`;

export function correctionCopy(row: Record<string, any>, moving: ReadonlySet<string>): Record<string, any> {
  return (row.status === "planned" || row.status === "proposed") && moving.has(row.target_id)
    ? { ...row, status: "superseded", text: null, fields: null, quote: null } : row;
}

async function neverOpenFull(ctx: Ctx, from: DataClass, recordId: string): Promise<string | null> {
  const db = recordsDb(ctx, from);
  const rules = (await ctx.db.control.query("SELECT kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [ctx.instanceId])).rows;
  const recs = (await db.query(`${TREE} SELECT r.id, r.type, r.title, r.domain_tags, r.space_id, r.source_kind, r.source_ref FROM records r WHERE r.id IN (SELECT id FROM tree)`, [recordId])).rows;
  const entIds = (await db.query(`${TREE} SELECT DISTINCT entity_id FROM record_entities WHERE record_id IN (SELECT id FROM tree)`, [recordId])).rows.map((r) => r.entity_id);
  const kinds = new Set<string>(entIds.length ? (await ctx.db.control.query("SELECT DISTINCT kind FROM entities WHERE id = ANY($1)", [entIds])).rows.map((r) => r.kind) : []);
  const rootSpace = recs.find((r) => r.id === recordId)?.space_id as string | undefined;
  const slug = rootSpace && rules.some((r) => r.kind === "space")
    ? ((await ctx.db.control.query("SELECT slug FROM spaces WHERE id = $1", [rootSpace])).rows[0]?.slug as string | undefined) ?? null : null;
  return neverOpenFromTree(rules, recs, kinds, slug);
}

async function openCheckFull(ctx: Ctx, db: ReturnType<typeof recordsDb>, s3: ReturnType<Ctx["s3"]>, recordId: string, accepted: readonly string[] = [], textOnly = false): Promise<{ reasons: string; kinds: string[]; rules: string[]; unchecked?: string } | null> {
  const settings = accepted.length ? acceptedSettings(openCheckSettings(ctx.settings), accepted) : openCheckSettings(ctx.settings);
  const tree = await openTreeTexts({ records: db, control: ctx.db.control, original: s3 ? (key) => s3GetBuffer(s3, key) : undefined, legacyCharset: legacyCharsetOf(ctx.settings), scanCharsets: legacyScanCharsetsOf(ctx.settings) }, recordId, { live: false, textOnly });
  const refuse = (u: OpenCheckUnchecked) => ({ reasons: OPEN_CHECK_UNCHECKED[u], kinds: [], rules: [], unchecked: u });
  if (settings.enabled && tree.unchecked) return refuse(tree.unchecked);
  let findings: OpenCheckFinding[];
  const j = joinedTexts(tree.texts);
  try { findings = j.map(await runOpenCheck(settings, j.texts)); }
  catch (e) {
    if (e instanceof OpenCheckTimeout) return refuse(openCheckTimeoutUnchecked(e));
    log.warn("open_check_failed", { via: "move", error: String((e as Error)?.message ?? e).slice(0, 200) });
    return refuse("check_failed");
  }
  return findings.length ? { reasons: `appears to contain ${openCheckReasons(findings)}`, kinds: [...new Set(findings.map((f) => f.kind))], rules: [...new Set(findings.map((f) => f.rule))] } : null;
}

const RETRY_MARK = /^(open_check_busy|tree_changed|schema_skew|finish_failed|deadlock): attempt (\d+)/;
const RETRY_AFTER = /retry after (\S+)$/;
type RetryWhy = "open_check_busy" | "tree_changed" | "schema_skew" | "finish_failed" | "deadlock";
const RETRY_REASON: Record<RetryWhy, string> = {
  open_check_busy: OPEN_CHECK_UNCHECKED.busy,
  tree_changed: "new derived records appeared during the transfer",
  schema_skew: "a deployment is in progress: the destination database does not yet have the new column or table",
  finish_failed: "the final transfer step failed. The record is hidden until the retry",
  deadlock: "a concurrent transaction caused a deadlock",
};
const RETRY_EVENT: Record<RetryWhy, string> = {
  open_check_busy: "class_move_open_check_busy", tree_changed: "class_move_tree_changed", schema_skew: "class_move_schema_skew",
  finish_failed: "class_move_finish_failed",
  deadlock: "class_move_deadlock",
};

async function retryNotDue(ctx: Ctx, moveId: string): Promise<boolean> {
  const e = (await ctx.db.control.query("SELECT error FROM class_moves WHERE id = $1", [moveId])).rows[0]?.error;
  const at = typeof e === "string" && RETRY_MARK.test(e) ? Date.parse(RETRY_AFTER.exec(e)?.[1] ?? "") : NaN;
  return Number.isFinite(at) && at - Date.now() > 5_000;
}

async function retryLater(ctx: Ctx, mv: { id: string; record_id: string; from_class: DataClass }, why: RetryWhy, cleanup: () => Promise<void>): Promise<boolean> {
  const limit = Math.max(1, Math.round(Number(ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 })?.limit)) || 3);
  const prev = (await ctx.db.control.query("SELECT error FROM class_moves WHERE id = $1", [mv.id])).rows[0]?.error;
  const attempt = Number(RETRY_MARK.exec(typeof prev === "string" ? prev : "")?.[2] ?? 0) + 1;
  if (attempt >= limit) return false;
  try { await cleanup(); }
  catch (e) {
    log.warn("class_move_cleanup_failed", { move_id: mv.id, error: (e as Error).message.slice(0, 120) });
    return false;
  }
  const delay = 60 * attempt;
  await ctx.db.control.query("UPDATE class_moves SET status = 'pending', error = $2 WHERE id = $1",
                             [mv.id, `${why}: attempt ${attempt} of ${limit} — ${RETRY_REASON[why]}; retry after ${new Date(Date.now() + delay * 1000).toISOString()}`]);
  await ctx.boss?.send("kick", { instance: ctx.instanceId, class: mv.from_class, record_id: mv.record_id, lane: "now" },
                       { startAfter: delay, singletonKey: `${mv.record_id}:move_retry`, retryLimit: 3, expireInSeconds: 900 })
    .catch((e: Error) => log.warn("class_move_retry_kick_failed", { move_id: mv.id, error: e.message.slice(0, 120) }));
  log.warn(RETRY_EVENT[why], { move_id: mv.id, record_id: mv.record_id, attempt, limit, retry_after_sec: delay });
  return true;
}

export class TreeChanged extends Error {
  constructor(readonly added: number) { super(`record tree changed during transfer: ${added} new records. The source was not deleted`); }
}

export class LineageChanged extends Error {
  constructor(readonly rows: number) { super(`record lineage changed after the copy was checked: ${rows} marked rows. The source was not deleted`); }
}

export async function originalRefs(ctx: DbCtx, cls: DataClass, key: string, except: readonly string[] = []): Promise<"used" | "free" | "unknown"> {
  try {
    const own = async () => !!(await recordsDb(ctx, cls).query("SELECT 1 FROM record_content WHERE original_key = $1 AND NOT record_id = ANY($2::uuid[]) LIMIT 1", [key, except])).rowCount;
    if (await own()) return "used";
    if (cls !== "closed") return "free";
    if ((await recordsDb(ctx, "open").query(
      `SELECT 1 FROM record_content c JOIN records r ON r.id = c.record_id WHERE c.original_key = $1 AND NOT c.record_id = ANY($2::uuid[]) AND (${HELD_SQL("r")} OR ${CLOSED_FILE_SQL("r")}) LIMIT 1`,
      [key, except])).rowCount) return "used";
    return (await own()) ? "used" : "free";
  } catch (e) {
    log.warn("original_refs_check_failed", { class: cls, error: (e as Error).message.slice(0, 120) });
    return "unknown";
  }
}

export async function originalStillUsed(ctx: DbCtx, cls: DataClass, key: string, except: readonly string[] = []): Promise<boolean> {
  return (await originalRefs(ctx, cls, key, except)) !== "free";
}

export function ownOriginalKey(key: string, recordId: string): string {
  const i = key.lastIndexOf("/"), name = key.slice(i + 1);
  return name.startsWith(`${recordId}-`) ? key : `${key.slice(0, i + 1)}${recordId}-${name}`;
}

export function keyBeforeRekey(key: string, recordId: string): string | null {
  const i = key.lastIndexOf("/"), name = key.slice(i + 1), prefix = `${recordId}-`;
  return name.startsWith(prefix) && name.length > prefix.length ? `${key.slice(0, i + 1)}${name.slice(prefix.length)}` : null;
}

async function removeOriginals(ctx: Ctx, cls: DataClass, keys: Iterable<string>, except: readonly string[], what: string, moveId: string): Promise<{ failed: number; kept: number; unchecked: number }> {
  const b = ctx.s3(cls), out = { failed: 0, kept: 0, unchecked: 0 };
  if (!b) return out;
  for (const key of new Set(keys)) {
    const refs = await originalRefs(ctx, cls, key, except);
    if (refs === "used") { out.kept++; continue; }
    if (refs === "unknown") { out.unchecked++; log.warn(what, { move_id: moveId, error: "file references could not be checked, so the file was kept" }); continue; }
    await s3Remove(b, key).catch((e) => { out.failed++; log.warn(what, { move_id: moveId, error: (e as Error).message.slice(0, 120) }); });
  }
  if (out.kept) log.info("class_move_original_shared", { move_id: moveId, class: cls, kept: out.kept });
  return out;
}

const COPY_TABLES = ["records", ...TABLES, "chunk_embeddings", "record_corrections"];
const COLUMNS_SQL = `SELECT c.relname AS t, a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[]) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''`;
const skewSeen = new Map<string, { at: number; missing: string[] }>();
export async function schemaSkew(ctx: Ctx, from: DataClass, to: DataClass): Promise<string[]> {
  const key = `${from}>${to}`, hit = skewSeen.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.missing;
  const cols = async (cls: DataClass) => new Set((await recordsDb(ctx, cls).query(COLUMNS_SQL, [COPY_TABLES])).rows.map((r) => `${r.t}.${r.c}`));
  const [a, b] = [await cols(from), await cols(to)];
  const missing = [...a].filter((x) => !b.has(x)).sort();
  skewSeen.set(key, { at: Date.now(), missing });
  return missing;
}
export const forgetSchemaSkew = (): void => skewSeen.clear();
async function closeFailed(ctx: Ctx, mv: MoveRow, error: string): Promise<void> {
  if (error.startsWith("record_deleted")) return;
  if (mv.via === "open_check_fallback") return;
  const loc = (await ctx.db.control.query("SELECT owner_id, space_id FROM record_locations WHERE record_id = $1", [mv.record_id])).rows[0];
  for (const author of new Set([mv.requested_by, loc?.owner_id].filter((x): x is string => typeof x === "string" && x.length > 0)))
    await auditWorker(ctx, { event_type: "class_move", class: mv.from_class, record_ids: [mv.record_id], space_id: loc?.space_id ?? null,
                             details: { op: "close_failed", move_id: mv.id, author } });
}

const SKEW_CODES = new Set(["42703", "42P01"]);
const skewFailure = (to: DataClass, missing: string[]) =>
  `schema_skew: the ${to === "closed" ? "closed" : "open"}-class database is missing ${missing.length ? missing.slice(0, 3).join(", ") + (missing.length > 3 ? ` and ${missing.length - 3} more` : "") : "a required column or table"}. Record database schemas differ, and all attempts have been used`;

const HELD_SQL = (a: string) => `(${a}.attrs -> 'conversion' ->> 'error_kind') = 'open_check_fallback_failed'`;
const CLOSED_FILE_SQL = (a: string) => `COALESCE(${a}.attrs ? 'original_closed', false)`;

async function closedByFallback(ctx: Ctx, dst: ReturnType<typeof recordsDb>, moveId: string, recordId: string, ids: string[]): Promise<{ mark: string | null; resumed: number }> {
  const via = (await ctx.db.control.query("SELECT via FROM class_moves WHERE id = $1", [moveId])).rows[0]?.via;
  const fb = (await dst.query("SELECT attrs -> 'open_check_fallback' AS fb FROM records WHERE id = $1", [recordId])).rows[0]?.fb;
  const mark = fb && typeof fb === "object" && (via === "open_check_fallback" || fb.move_id === moveId) ? JSON.stringify(fb) : null;
  const held = (await dst.query(`SELECT id FROM records r WHERE id = ANY($1::uuid[]) AND ${HELD_SQL("r")}`, [ids])).rows.map((r) => r.id as string);
  if (held.length) {
    await dst.query(`UPDATE record_stages SET status = 'pending', attempts = 0, terminal = false, last_error = 'open_check_fallback: document moved to the closed class — conversion continues', updated_at = now()
                     WHERE record_id = ANY($1::uuid[]) AND stage = 'converted' AND status IN ('failed','pending')`, [held]);
    await dst.query(`UPDATE records SET attrs = jsonb_set(attrs, '{conversion}', (COALESCE(attrs -> 'conversion', '{}'::jsonb) - 'error_kind') || '{"status":"pending"}'::jsonb)
                     WHERE id = ANY($1::uuid[])`, [held]);
    log.info("open_check_fallback_resumed", { move_id: moveId, records: held.length });
  }
  return { mark, resumed: held.length };
}

async function detachSharedConversions(src: ReturnType<typeof recordsDb>, dst: ReturnType<typeof recordsDb>, ids: string[], moveId: string): Promise<number> {
  const moved = (await dst.query("SELECT id, attrs->'conversion' AS c FROM records WHERE id = ANY($1::uuid[]) AND jsonb_typeof(attrs->'conversion') = 'object'", [ids]))
    .rows as Array<{ id: string; c: Record<string, unknown> }>;
  const docs = new Set<string>();
  for (const m of moved) {
    if (typeof m.c.document_id === "string" && m.c.document_id) docs.add(m.c.document_id);
    if (Array.isArray(m.c.lost_document_ids)) for (const d of m.c.lost_document_ids) if (typeof d === "string" && d) docs.add(d);
  }
  if (!docs.size) return 0;
  const shared = new Set<string>();
  for (const r of (await src.query(
    `SELECT attrs->'conversion'->>'document_id' AS d, attrs->'conversion'->'lost_document_ids' AS lost FROM records
      WHERE NOT (id = ANY($1::uuid[])) AND jsonb_typeof(attrs->'conversion') = 'object'
        AND (attrs->'conversion'->>'document_id' = ANY($2::text[])
             OR (jsonb_typeof(attrs->'conversion'->'lost_document_ids') = 'array' AND attrs->'conversion'->'lost_document_ids' ?| $2::text[]))`, [ids, [...docs]])).rows) {
    if (typeof r.d === "string" && docs.has(r.d)) shared.add(r.d);
    if (Array.isArray(r.lost)) for (const d of r.lost) if (typeof d === "string" && docs.has(d)) shared.add(d);
  }
  if (!shared.size) return 0;
  let n = 0;
  const now = new Date();
  for (const m of moved) {
    const x = detachForMove(m.c, shared, now);
    if (!x) continue;
    await dst.query("UPDATE records SET attrs = jsonb_set(attrs, '{conversion}', ((attrs->'conversion') - $2::text[]) || $3::jsonb) WHERE id = $1", [m.id, x.drop, JSON.stringify(x.patch)]);
    n++;
  }
  if (n) log.info("class_move_conversion_detached", { move_id: moveId, records: n });
  return n;
}

export async function fallbackRetryDelaySec(ctx: DbCtx, recordId: string, moveIds: string[]): Promise<number> {
  if (!moveIds.length) return 0;
  const r = (await ctx.db.control.query(
    `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, COALESCE(bool_or(id = ANY($2::uuid[]) AND status = 'failed'), false) AS now_failed
     FROM class_moves WHERE record_id = $1 AND via = 'open_check_fallback'`, [recordId, moveIds])).rows[0];
  if (!r?.now_failed) return 0;
  const limit = Math.max(1, Math.round(Number(ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 })?.limit)) || 3);
  return r.failed >= limit ? 0 : Math.min(900, 60 * Number(r.failed));
}

const movesInFlight = new Set<string>();

export async function withRecordLock<T>(ctx: DbCtx, recordId: string, fn: (alive: () => Promise<void>) => Promise<T>): Promise<T> {
  const client = await ctx.db.control.connect();
  let clean = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`record:${recordId}`]);
    const watch = watchLock(client);
    try {
      const result = await fn(watch.alive);
      if (watch.lost()) throw new LockConnectionLost();
      return result;
    } finally {
      try {
        if (!watch.lost())
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`record:${recordId}`]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "record_lock" });
        }
      } finally { watch.done(); }
    }
  } finally { client.release(!clean); }
}

interface MoveFault { pause_sec?: number; pause_before_check_sec?: number; fail?: "verify" | "storage" | "finish"; keep?: boolean }

interface MoveRow { id: string; record_id: string; from_class: DataClass; to_class: DataClass; status: string; requested_by: string; accepted_rules: string[] | null; confirmation: ByWordConfirmation | null;
                   accepted_print: string | null; accepted_aud: string | null; accepted_space_id: string | null; accepted_scope: DespiteScope | null; text_only: boolean;
                   via: string }
const MOVE_COLS = "id, record_id, from_class, to_class, status, requested_by, accepted_rules, confirmation, accepted_print, accepted_aud, accepted_space_id, accepted_scope, text_only, via";

async function byWordGateOnCopy(ctx: Ctx, dst: ReturnType<typeof recordsDb>, mv: MoveRow): Promise<string | null> {
  if (mv.confirmation === "human_workplace" && mv.accepted_print) return despiteGateOnCopy(ctx, dst, mv);
  if (!openCheckSettings(ctx.settings).enabled) return "disabled";
  if (!(mv.accepted_rules ?? []).every(ruleOpenableByWord)) return "rules";
  const root = (await dst.query("SELECT space_id, owner_id, attrs -> 'open_check_fallback' AS mark, attrs -> 'open_check_accepted' AS accepted FROM records WHERE id = $1", [mv.record_id])).rows[0];
  if (!root || root.owner_id !== mv.requested_by) return "space";
  const sp = (await ctx.db.control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [root.space_id])).rows[0];
  if (!sp || sp.kind !== "personal" || sp.owner_id !== mv.requested_by) return "space";
  const t = (await dst.query(`${TREE}
    SELECT (SELECT count(*) FROM records WHERE id IN (SELECT id FROM tree) AND (space_id <> $2 OR audience <> 'space'))::int AS foreign_rows,
           (SELECT count(*) FROM record_placements WHERE record_id IN (SELECT id FROM tree) AND space_id <> $2)::int AS placements,
           (SELECT count(*) FROM record_people WHERE record_id IN (SELECT id FROM tree) AND person_id <> $3)::int AS others`, [mv.record_id, root.space_id, mv.requested_by])).rows[0];
  if (t.foreign_rows || t.placements || t.others) return "space";
  const own = parseOpenCheckAccepted(root.accepted)?.move_id === mv.id;
  if (mv.confirmation === "agent_relayed") {
    if (!own && (!parseOpenCheckMarkStrict(root.mark) || root.accepted)) return "marker";
    const notebook = (await ctx.db.control.query("SELECT notebook FROM people WHERE id = $1", [mv.requested_by])).rows[0]?.notebook;
    if (notebook === false) return "notebook";
  } else if (!own && !parseOpenCheckMarkStrict(root.mark) && !parseOpenCheckAccepted(root.accepted)) return "marker";
  return null;
}

async function despiteGateOnCopy(ctx: Ctx, dst: ReturnType<typeof recordsDb>, mv: MoveRow): Promise<string | null> {
  const accepted = mv.accepted_rules ?? [];
  if (despiteSwitchedOff(ctx, mv)) return "disabled";
  if (!accepted.every((r) => (ACCEPTABLE_RULES as readonly string[]).includes(r))) return "rules";
  if (!ctx.despiteKeys) throw new Error("consent fingerprint key is not configured. Cannot verify consent to show the record despite a finding");
  const root = (await dst.query("SELECT space_id, owner_id FROM records WHERE id = $1", [mv.record_id])).rows[0];
  if (!root || root.owner_id !== mv.requested_by) return "changed";
  if (root.space_id !== mv.accepted_space_id) return "audience";
  const author = await despiteAuthorGate(ctx, mv);
  if (author) return author;
  const c = await consentRows(dst, ctx.db.control, mv.record_id);
  if (c.rows.some((r) => r.space_id !== root.space_id)) return "audience";
  const placed = [...new Set(c.placements.map((p) => p.space_id))];
  if (placed.length && (await ctx.db.control.query("SELECT 1 FROM spaces WHERE id = ANY($1::uuid[]) AND kind = 'org' LIMIT 1", [placed])).rowCount) return "audience";
  if (await meetingOrigin({ tree: dst, control: ctx.db.control, records: (k) => recordsDb(ctx, k) }, c.rows, mv.record_id)) return "changed";
  const sp = (await ctx.db.control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [root.space_id])).rows[0];
  const scope = consentScope(c, { spaceId: root.space_id, spaceKind: sp?.kind ?? null, spaceOwner: sp?.owner_id ?? null }, mv.requested_by);
  if (scope !== mv.accepted_scope) return "audience";
  if (accepted.some((r) => despiteVerdict(r, scope) === "never")) return "audience";
  if (contentPrint(ctx.despiteKeys.print, { rows: c.rows, entityNames: c.entityNames, textOnly: mv.text_only }) !== mv.accepted_print) return "changed";
  if (audiencePrint(ctx.despiteKeys.print, c) !== mv.accepted_aud) return "audience";
  return null;
}

function despiteSwitchedOff(ctx: Ctx, mv: MoveRow): boolean {
  const ds = despiteSettings(ctx.settings);
  return !ds.enabled || (mv.accepted_scope === "shared" && !ds.projects) || (mv.text_only && !ds.scansText);
}

async function despiteAuthorGate(ctx: Ctx, mv: MoveRow): Promise<"audience" | "no_write" | null> {
  if (!mv.accepted_space_id) return "audience";
  const role = await authorRole(ctx.db.control, { instanceId: ctx.instanceId, personId: mv.requested_by, spaceId: mv.accepted_space_id });
  if (!role.kind || role.kind === "org") return "audience";
  if (role.archived || !canWriteRole(role)) return "no_write";
  return null;
}

async function despiteLateGate(ctx: Ctx, mv: MoveRow): Promise<"disabled" | "audience" | "no_write" | null> {
  await reloadSettings(ctx);
  if (despiteSwitchedOff(ctx, mv)) return "disabled";
  return despiteAuthorGate(ctx, mv);
}

async function reloadSettings(ctx: Pick<DbCtx, "settings">): Promise<void> {
  try { await ctx.settings.load(true); }
  catch (e) { throw new Error(`settings could not be read. Showing the record did not proceed: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
}

async function resumeRefusal(ctx: Ctx, dst: ReturnType<typeof recordsDb>, mv: MoveRow, accepted: string[], textOnly: boolean, byWord: boolean, pauseSec = 0)
  : Promise<null | "retry" | { error: string; event: Parameters<typeof auditWorker>[1] }> {
  await reloadSettings(ctx);
  const byWordDetails = byWord ? { author: mv.requested_by, accepted_rules: accepted, confirmation: mv.confirmation,
                                   ...(textOnly ? { text_only: true } : {}), ...(mv.accepted_scope ? { scope: mv.accepted_scope } : {}) } : {};
  const never = await neverOpenFull(ctx, mv.to_class, mv.record_id);
  if (never) return { error: `never_open:${never}`, event: { event_type: "class_move", class: mv.from_class, record_ids: [mv.record_id],
                                                             details: { move_id: mv.id, denied: "never_open", resumed: true, ...byWordDetails } } };
  if (byWord) {
    const gate = await byWordGateOnCopy(ctx, dst, mv);
    if (gate) return { error: `open_check:gate=${gate}: ${gateReason(gate, mv)}`,
                       event: { event_type: "processing", class: mv.from_class, record_ids: [mv.record_id],
                                details: { op: "open_check_refused", via: "move", move_id: mv.id, kinds: [], rules: [], gate, resumed: true, ...byWordDetails } } };
  }
  const found = await openCheckFull(ctx, dst, ctx.s3(mv.to_class), mv.record_id, accepted, textOnly);
  if (found?.unchecked === "busy" && await retryLater(ctx, mv, "open_check_busy", async () => undefined)) return "retry";
  if (found) return { error: `open_check:${found.reasons}`, event: { event_type: "processing", class: mv.from_class, record_ids: [mv.record_id],
                                                                     details: { op: "open_check_refused", via: "move", move_id: mv.id, kinds: found.kinds, rules: found.rules,
                                                                                ...(found.unchecked ? { unchecked: found.unchecked } : {}), resumed: true, ...byWordDetails } } };
  if (byWord && mv.confirmation === "human_workplace" && mv.accepted_print) {
    if (pauseSec > 0) await new Promise((r) => setTimeout(r, Math.min(120, pauseSec) * 1000));
    const late = await despiteLateGate(ctx, mv);
    if (late)
      return { error: `open_check:gate=${late}: ${gateReason(late, mv)}`,
               event: { event_type: "processing", class: mv.from_class, record_ids: [mv.record_id],
                        details: { op: "open_check_refused", via: "move", move_id: mv.id, kinds: [], rules: [], gate: late, resumed: true, ...byWordDetails } } };
  }
  await ctx.db.control.query("UPDATE class_moves SET error = NULL WHERE id = $1 AND error LIKE 'open_check_busy:%'", [mv.id]);
  return null;
}

async function refuseResumed(ctx: Ctx, mv: MoveRow, moveId: string, error: string): Promise<string> {
  log.warn("class_move_failed", { move_id: moveId, record_id: mv.record_id, from: mv.from_class, to: mv.to_class, error: error.slice(0, 200) });
  const back = await tx(ctx.db.control, async (c) => {
    await c.query("UPDATE class_moves SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('pending','copying','verifying')", [moveId, error.slice(0, 500)]);
    const going = (await c.query("SELECT id FROM class_moves WHERE record_id = $1 AND to_class = 'closed' AND status IN ('pending','copying','verifying') ORDER BY requested_at LIMIT 1",
                                 [mv.record_id])).rows[0]?.id as string | undefined;
    if (going) return going;
    const id = newId();
    await c.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'resume_refused')", [id, mv.record_id, mv.requested_by]);
    return id;
  });
  log.warn("class_move_resume_refused", { move_id: moveId, return_move_id: back, record_id: mv.record_id });
  return back;
}

/**
 * A class move settled — done (its last step) or failed. The indexed stages of its tree that waited for it
 * (holdWait: nothing is sent and no chunk is written while a move is in flight, the wait doubles up to HOLD_WAIT_CAP_SEC)
 * are due now in `cls`, the class where the records end up, and their waiting index jobs start now and run in that class:
 * the job of a closed or opened record still names the class it was queued in, where the record has no row any more.
 * Every waiting index job of the tree moves to `cls` (not only the jobs of the stages woken here), and starts
 * now when its stage in `cls` is due. A stage waiting for another reason keeps its term (and its job its start). Best effort: a failure is a log line, and the stage keeps its term
 * (the scheduler takes it then).: also called by the conversion fallback when it deletes its own pending move
 * (convert.ts fallbackToClosed) — that move settles without a step of its own. Not woken here: a stage whose pass is running at this moment — it writes its own wait
 * after the move settled and is taken at that term (one wait at most, MOVE_WAIT_SEC doubled).
 */
export async function wakeHeldIndex(ctx: Ctx, cls: DataClass, recordId: string, ids: readonly string[] | null, moveId: string): Promise<void> {
  try {
    const db = recordsDb(ctx, cls);
    const tree = ids ?? (await db.query(`${TREE} SELECT id FROM tree`, [recordId])).rows.map((r) => r.id as string);
    if (!tree.length) return;
    const woken = (await db.query(
      `UPDATE record_stages SET retry_at = now() WHERE stage = 'indexed' AND status = 'pending' AND record_id = ANY($1::uuid[]) AND retry_at > now()
         AND (starts_with(last_error, $2) OR starts_with(last_error, $3)) RETURNING record_id::text AS id`, [tree, HOLD_CODE, HOLD_LONG_CODE])).rows.map((r) => r.id as string);
    // the copy of a stage row in `cls` can be older than the source's (a hold pass that repeated after the copy
    // step wrote its later term only into the source row and its job; a copy taken before the first hold has no hold
    // reason). So every waiting index job of the tree moves to `cls`, whatever the copy says; it starts now when the
    // stage in `cls` is due now (woken above, or its copied term already past), otherwise it keeps its term
    const due = (await db.query(
      `SELECT record_id::text AS id FROM record_stages WHERE stage = 'indexed' AND status = 'pending' AND record_id = ANY($1::uuid[]) AND (retry_at IS NULL OR retry_at <= now())`,
      [tree])).rows.map((r) => r.id as string);
    const jobs = await ctx.db.control.query(
      `UPDATE pgboss.job SET start_after = CASE WHEN split_part(singleton_key, ':', 1) = ANY($4::text[]) THEN now() ELSE start_after END,
              data = jsonb_set(data, '{class}', to_jsonb($3::text))
        WHERE name = $1 AND state IN ('created','retry') AND split_part(singleton_key, ':', 1) = ANY($2::text[]) AND split_part(singleton_key, ':', 2) = 'indexed'`,
      [QUEUE_OF.indexed, tree, cls, due]);
    if (woken.length || jobs.rowCount) log.info("index_hold_woken", { move_id: moveId, class: cls, stages: woken.length, jobs: jobs.rowCount ?? 0 });
  } catch (e) {
    log.warn("index_hold_wake_failed", { move_id: moveId, class: cls, error: String((e as Error)?.message ?? e).slice(0, 120) });
  }
}

async function returnToClosed(ctx: Ctx, recordId: string, back: string): Promise<void> {
  if (movesInFlight.has(back)) return;
  movesInFlight.add(back);
  try { await moveClassRun(ctx, back); }
  catch (e) { log.warn("class_move_return_failed", { move_id: back, record_id: recordId, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  finally { movesInFlight.delete(back); }
}

const GATE_REASON: Record<string, string> = {
  disabled: "open check is turned off", rules: "one of the accepted rules prevents opening on request", space: "the record exists outside the owner’s personal space",
  marker: "no open check mark exists or the record was already made open on request", notebook: "agent writes to personal spaces are turned off",
  changed: "the record changed after the author gave consent", audience: "who can see the record has changed",
  no_write: "the author can no longer edit records in this space",
  consent_needed: "consent was given before the memory was updated. The author must consent again",
};
const gateReason = (gate: string, mv: MoveRow): string =>
  gate === "disabled" && mv.confirmation === "human_workplace" && mv.accepted_print ? "the administrator has disabled showing the record" : GATE_REASON[gate] ?? gate;

const DERIVED_SYNC_SQL = `UPDATE records SET attrs = (CASE WHEN $2::boolean AND $5::text IS NULL THEN attrs - 'derived_lost_cause' ELSE attrs END)
    || CASE WHEN $2::boolean THEN '{"derived_lost": true}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN jsonb_array_length($3::jsonb) > 0 THEN jsonb_build_object('derived_pending', (
         SELECT jsonb_agg(p ORDER BY p) FROM (SELECT jsonb_array_elements_text($3::jsonb) AS p
           UNION SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(attrs->'derived_pending') = 'array' THEN attrs->'derived_pending' ELSE '[]'::jsonb END)) x))
       ELSE '{}'::jsonb END
    || CASE WHEN $4::int > COALESCE(CASE WHEN (attrs->>'derived_declared') ~ '^[0-9]+$' THEN (attrs->>'derived_declared')::int END, 0)
            THEN jsonb_build_object('derived_declared', $4::int) ELSE '{}'::jsonb END
  WHERE id = $1`;

export async function moveClass(ctx: Ctx, moveId: string): Promise<void> {
  if (movesInFlight.has(moveId)) return;
  movesInFlight.add(moveId);
  try {
    const rec = (await ctx.db.control.query("SELECT record_id FROM class_moves WHERE id = $1", [moveId])).rows[0];
    if (rec) await withRecordLock(ctx, rec.record_id, () => moveClassRun(ctx, moveId));
  } finally { movesInFlight.delete(moveId); }
}

async function moveClassRun(ctx: Ctx, moveId: string): Promise<void> {
  const mv = (await ctx.db.control.query(`SELECT ${MOVE_COLS} FROM class_moves WHERE id = $1`, [moveId])).rows[0] as MoveRow | undefined;
  if (!mv || mv.status === "done" || mv.status === "failed") return;
  if (mv.status === "pending" && await retryNotDue(ctx, moveId)) return;
  await ctx.settings.load(true).catch(() => undefined);
  const fault = (ctx.settings.get<MoveFault>("processing.class_move_fault", {}) ?? {}) as MoveFault;
  const from: DataClass = mv.from_class, to: DataClass = mv.to_class, src = recordsDb(ctx, from), dst = recordsDb(ctx, to);
  let inserted: string[] = [], copiedFiles: string[] = [], copiedCorrections: string[] = [], srcDeleted = false, finished = false;
  let linkDetails: CopiedLinkDetails = { copied: [], inserted: [] };
  const accepted = mv.accepted_rules ?? [];
  const textOnly = to === "open" && mv.text_only === true;
  const byWord = to === "open" && (accepted.length > 0 || textOnly);
  const byWordDetails = byWord ? { author: mv.requested_by, accepted_rules: accepted, confirmation: mv.confirmation,
                                   ...(textOnly ? { text_only: true } : {}), ...(mv.accepted_scope ? { scope: mv.accepted_scope } : {}) } : {};
  let reported = false;
  const cleanupCopy = async (strict: boolean) => {
    const soft = <T>(p: Promise<T>, what: string) => strict ? p : p.catch((e) => { log.warn(what, { move_id: moveId, error: String((e as Error)?.message ?? e).slice(0, 120) }); return undefined; });
    await soft(rollbackCopiedLinkDetails(ctx, linkDetails.inserted), "class_move_link_cleanup_failed");
    if (inserted.length) await soft(dst.query("DELETE FROM records WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL", [inserted]), "class_move_cleanup_failed");
    if (copiedCorrections.length) await soft(dst.query("DELETE FROM record_corrections WHERE id = ANY($1::uuid[])", [copiedCorrections]), "class_move_cleanup_failed");
    const removed = await removeOriginals(ctx, to, copiedFiles, [], "class_move_cleanup_failed", moveId);
    if (strict && removed.failed) throw new Error(`copied files could not be removed: ${removed.failed}`);
  };
  const fail = async (error: string) => {
    log.warn("class_move_failed", { move_id: moveId, record_id: mv.record_id, from, to, error: error.slice(0, 200) });
    let shown = 0;
    const home = to === "closed" && !srcDeleted && mv.via !== "resume_refused" && mv.via !== "despite_rollback" && mv.via !== "nda_recheck"
      ? await ctx.db.control.query("SELECT class FROM record_locations WHERE record_id = $1", [mv.record_id])
          .then((r) => ({ known: true, cls: r.rows[0]?.class as string | undefined }),
                (e) => { log.warn("class_move_unhide_skipped", { move_id: moveId, error: String((e as Error)?.message ?? e).slice(0, 120) }); return { known: false, cls: undefined }; })
      : { known: false, cls: undefined };
    if (home.known && (home.cls === undefined || home.cls === from))
      shown = await tx(src, async (c) => {
        await c.query(MOVE_SOURCE_LOCK, [mv.record_id]);
        return c.query(`${TREE} UPDATE records SET hidden_at = NULL WHERE id IN (SELECT id FROM tree) AND hidden_at IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM records h WHERE h.id = $1 AND ${HELD_SQL("h")})`, [mv.record_id]);
      })
        .then((r) => r.rowCount ?? 0, (e) => { log.warn("class_move_unhide_failed", { move_id: moveId, error: (e as Error).message.slice(0, 120) }); return 0; });
    if (!srcDeleted && !fault.keep) await cleanupCopy(false);
    await ctx.db.control.query("UPDATE class_moves SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [moveId, error.slice(0, 500)]);
    // the record stays in the source class — its held indexed stages are due now (after the source was deleted the
    // only copy is hidden in the target class and waits for the move's repeat: nothing to wake)
    if (!srcDeleted) await wakeHeldIndex(ctx, from, mv.record_id, null, moveId);
    if (mv.via === "nda_recheck" && error.startsWith("record_deleted")) await recheckOnRestore(ctx, [mv.record_id]);
    if (to === "closed" && !srcDeleted && shown > 0)
      await closeFailed(ctx, mv, error).catch((x: Error) => log.warn("class_move_audit_failed", { move_id: moveId, error: x.message.slice(0, 120) }));
  };
  const unfinished = async (e: unknown): Promise<"handled" | "keep"> => {
    const later = () => retryLater(ctx, mv, "finish_failed", async () => undefined).catch((x) => {
      log.warn("class_move_retry_failed", { move_id: moveId, error: String((x as Error)?.message ?? x).slice(0, 120) });
      return false;
    });
    try { await dst.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [mv.record_id]); }
    catch (x) {
      log.warn("class_move_finish_hide_failed", { move_id: moveId, record_id: mv.record_id, error: String((x as Error)?.message ?? x).slice(0, 120) });
      return "keep";
    }
    if (await later()) return "handled";
    const back = await refuseResumed(ctx, mv, moveId, `finish_failed: ${String((e as Error)?.message ?? e)}`).catch((x) => {
      log.warn("class_move_refusal_deferred", { move_id: moveId, record_id: mv.record_id, error: String((x as Error)?.message ?? x).slice(0, 200) });
      return null;
    });
    if (!back) return "keep";
    reported = true;
    if (byWord)
      await auditWorker(ctx, { event_type: "class_move", class: from, record_ids: [mv.record_id], details: { move_id: moveId, failed: "error", ...byWordDetails } })
        .catch((x: Error) => log.warn("class_move_audit_failed", { move_id: moveId, error: x.message.slice(0, 120) }));
    await returnToClosed(ctx, mv.record_id, back);
    return "handled";
  };
  try {
    if (to === "open" && mv.status === "pending" && mv.confirmation === "human_workplace" && accepted.length > 0 && !mv.accepted_print
        && (await src.query("SELECT 1 FROM records WHERE id = $1", [mv.record_id])).rowCount) {
      await fail(`open_check:gate=consent_needed: ${GATE_REASON.consent_needed}`);
      reported = true;
      await auditWorker(ctx, { event_type: "processing", class: from, record_ids: [mv.record_id],
                               details: { op: "open_check_refused", via: "move", move_id: moveId, kinds: [], rules: [], gate: "consent_needed", ...byWordDetails } });
      return;
    }
    if (to === "open") {
      const reason = await neverOpenFull(ctx, from, mv.record_id);
      if (reason) {
        await fail(`never_open:${reason}`);
        reported = true;
        await auditWorker(ctx, { event_type: "class_move", class: from, record_ids: [mv.record_id], details: { move_id: moveId, denied: "never_open", ...byWordDetails } });
        return;
      }
    }
    if (to === "closed") await tx(src, async (c) => {
      await c.query(MOVE_SOURCE_LOCK, [mv.record_id]);
      await c.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [mv.record_id]);
    });
    const root = (await src.query("SELECT deleted_at FROM records WHERE id = $1", [mv.record_id])).rows[0];
    const loc = (await ctx.db.control.query("SELECT deleted FROM record_locations WHERE record_id = $1", [mv.record_id])).rows[0];
    if (root?.deleted_at || loc?.deleted) { await fail("record_deleted: the record was deleted before the transfer started"); return; }
    await ctx.db.control.query("UPDATE class_moves SET status = 'copying' WHERE id = $1", [moveId]);
    let ids = (await src.query(`${TREE} SELECT id FROM tree`, [mv.record_id])).rows.map((r) => r.id as string);
    const originals: string[] = [];
    if (!ids.length) {
      srcDeleted = true;
      ids = (await dst.query(`${TREE} SELECT id FROM tree`, [mv.record_id])).rows.map((r) => r.id as string);
      if (!ids.length) { await fail("record not found in the source or destination database"); return; }
      for (const r of (await dst.query(`SELECT c.record_id, c.original_key FROM record_content c JOIN records r ON r.id = c.record_id
                                         WHERE c.record_id = ANY($1::uuid[]) AND c.original_key IS NOT NULL AND NOT ${CLOSED_FILE_SQL("r")}`, [ids])).rows) {
        originals.push(r.original_key as string);
        const before = keyBeforeRekey(r.original_key as string, r.record_id as string);
        if (before) originals.push(before);
      }
      if (to === "closed") linkDetails = await copyLinkDetailsForClose(ctx, ids);
      log.warn("class_move_resumed", { move_id: moveId, records: ids.length, from, to });
      if (to === "open") {
        const refused = await resumeRefusal(ctx, dst, mv, byWord ? accepted : [], textOnly, byWord, Number(fault.pause_sec) || 0);
        if (refused === "retry") return;
        if (refused) {
          await dst.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [mv.record_id]);
          const back = await refuseResumed(ctx, mv, moveId, refused.error).catch((e) => {
            log.warn("class_move_refusal_deferred", { move_id: moveId, record_id: mv.record_id, error: String((e as Error)?.message ?? e).slice(0, 200) });
            return null;
          });
          if (!back) return;
          reported = true;
          await auditWorker(ctx, refused.event);
          await returnToClosed(ctx, mv.record_id, back);
          return;
        }
      }
    } else {
      const skew = await schemaSkew(ctx, from, to);
      if (skew.length) {
        log.warn("class_move_schema_differs", { move_id: moveId, from, to, missing: skew.slice(0, 10) });
        if (await retryLater(ctx, mv, "schema_skew", async () => undefined)) return;
        throw new Error(skewFailure(to, skew));
      }
      const rows: Record<string, any[]> = { records: (await src.query("SELECT * FROM records WHERE id = ANY($1::uuid[]) ORDER BY created_at, (parent_id IS NOT NULL)", [ids])).rows };
      const parent = rows.records!.find((r) => r.id === mv.record_id)?.parent_id as string | null | undefined;
      if (parent && !ids.includes(parent)) {
        await fail("parent_other_class: a derived record moves only with its source record");
        return;
      }
      for (const t of TABLES) rows[t] = (await src.query(`SELECT * FROM ${t} WHERE ${KEY[t]} = ANY($1::uuid[])`, [ids])).rows;
      rows.record_stages = rows.record_stages!.map((row) =>
        row.status === "running" ? { ...row, attempts: Math.max(row.attempts - 1, 0) } : row);
      const moving = new Set(ids), hiddenAt = new Date();
      rows.record_corrections = to === "closed" ? (await src.query(CORRECTIONS_OF_TREE, [ids])).rows.map((r) => correctionCopy(r, moving)) : [];
      copiedCorrections = rows.record_corrections.map((r) => r.id as string);
      for (const r of rows.records!) {
        for (const col of ["supersedes_id", "superseded_by_id"] as const)
          if (r[col] && !moving.has(r[col])) { r.attrs = { ...(r.attrs ?? {}), [`${col}_other_class`]: r[col] }; r[col] = null; }
        r.hidden_at = hiddenAt;
      }
      const chunkIds = rows.chunks!.map((c) => c.id);
      rows.chunk_embeddings = chunkIds.length ? (await src.query("SELECT chunk_id, embedder_id, embedding::text AS embedding, input_hash, source, created_at FROM chunk_embeddings WHERE chunk_id = ANY($1::uuid[])", [chunkIds])).rows : [];
      // derived columns are never copied: raw_terms is generated, tsv is filled by the target's trigger in the target's
      // full-text configuration — the two databases may be in different languages or rebuild states
      const DERIVED = new Set(["tsv", "raw_terms"]);
      inserted = ids;
      const versionLinks = rows.records!.filter((r) => r.supersedes_id || r.superseded_by_id)
        .map((r) => ({ id: r.id as string, supersedes_id: r.supersedes_id as string | null, superseded_by_id: r.superseded_by_id as string | null }));
      try {
        await tx(dst, async (c) => {
          const stale = (await c.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL", [ids])).rows.map((r) => r.id as string);
          if (stale.length) {
            await c.query("DELETE FROM records WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL", [stale]);
            log.warn("class_move_stale_copy_removed", { move_id: moveId, records: stale.length, to });
          }
          if (copiedCorrections.length) await c.query("DELETE FROM record_corrections WHERE id = ANY($1::uuid[])", [copiedCorrections]);
          for (const t of COPY_TABLES) for (const src0 of rows[t]!) {
            const row = t === "records" && (src0.supersedes_id || src0.superseded_by_id) ? { ...src0, supersedes_id: null, superseded_by_id: null } : src0;
            const cols = Object.keys(row).filter((k) => !DERIVED.has(k));
            const vals = cols.map((k) => (k === "class" ? to : row[k] !== null && typeof row[k] === "object" && !(row[k] instanceof Date) && !Buffer.isBuffer(row[k]) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k]));
            await c.query(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map((k, i) => (t === "chunk_embeddings" && k === "embedding" ? `$${i + 1}::halfvec` : `$${i + 1}`)).join(",")}) ON CONFLICT DO NOTHING`, vals);
          }
          for (const v of versionLinks)
            await c.query("UPDATE records SET supersedes_id = $2, superseded_by_id = $3 WHERE id = $1", [v.id, v.supersedes_id, v.superseded_by_id]);
        });
      } catch (e) {
        if (!SKEW_CODES.has(String((e as { code?: unknown })?.code ?? ""))) throw e;
        forgetSchemaSkew();
        log.warn("class_move_schema_differs", { move_id: moveId, from, to, error: (e as Error).message.slice(0, 120) });
        if (await retryLater(ctx, mv, "schema_skew", () => cleanupCopy(true))) return;
        throw new Error(`${skewFailure(to, [])} (${(e as Error).message.slice(0, 120)})`);
      }
      if (textOnly) await dst.query(`UPDATE records SET attrs = COALESCE(attrs, '{}'::jsonb) || '{"original_closed": true}'::jsonb WHERE id = $1`, [mv.record_id]);
      if (to === "closed") await dst.query("UPDATE records SET attrs = attrs - 'original_closed' WHERE id = ANY($1::uuid[]) AND attrs ? 'original_closed'", [ids]);
      await detachSharedConversions(src, dst, ids, moveId);
      if (to === "closed") linkDetails = await copyLinkDetailsForClose(ctx, ids);
      await ctx.db.control.query("UPDATE class_moves SET status = 'verifying' WHERE id = $1", [moveId]);
      for (const t of ["records", "record_content", "chunks"]) {
        const col = t === "records" ? "id" : "record_id";
        const n = (await dst.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${col} = ANY($1::uuid[])`, [ids])).rows[0].n - (fault.fail === "verify" && t === "records" ? 1 : 0);
        if (n !== rows[t]!.length) throw new Error(`row count check for ${t}: ${n} ≠ ${rows[t]!.length}`);
      }
      const correctionsMoved = rows.record_corrections!.length
        ? (await dst.query("SELECT id FROM record_corrections WHERE id = ANY($1::uuid[])", [rows.record_corrections!.map((r) => r.id)])).rows.map((r) => r.id as string) : [];
      if (correctionsMoved.length !== rows.record_corrections!.length)
        log.warn("class_move_corrections_kept", { move_id: moveId, kept: rows.record_corrections!.length - correctionsMoved.length });
      for (const cRow of rows.record_content!) if (cRow.original_key) {
        if (textOnly && cRow.record_id === mv.record_id) continue;
        const a = ctx.s3(from), b = ctx.s3(to);
        if (!a || !b) throw new Error("storage is not configured. The original file was not moved");
        try {
          if (fault.fail === "storage") throw new Error("failure requested by the acceptance test");
          let body: Buffer;
          try { body = await s3GetBuffer(a, cRow.original_key); }
          catch (e) {
            if (await s3Has(b, cRow.original_key)) continue;
            throw e;
          }
          let key = cRow.original_key as string;
          let existed = await s3Has(b, key);
          if (existed && await originalStillUsed(ctx, to, key, ids)) {
            key = ownOriginalKey(key, cRow.record_id as string);
            await dst.query("UPDATE record_content SET original_key = $2 WHERE record_id = $1", [cRow.record_id, key]);
            existed = await s3Has(b, key);
            log.info("class_move_original_rekeyed", { move_id: moveId, record_id: cRow.record_id, to });
          }
          await s3Put(b, key, body, cRow.original_mime ?? "application/octet-stream");
          if (!existed || to === "open") copiedFiles.push(key);
          originals.push(cRow.original_key);
        } catch (e) { throw new Error(`the original file was not moved to storage for class ${to}: ${(e as Error).message.slice(0, 160)}`); }
      }
      if (to === "open" && Number(fault.pause_before_check_sec) > 0) await new Promise((r) => setTimeout(r, Math.min(120, Number(fault.pause_before_check_sec)) * 1000));
      if (byWord) {
        await reloadSettings(ctx);
        const gate = await byWordGateOnCopy(ctx, dst, mv);
        if (gate) {
          await fail(`open_check:gate=${gate}: ${gateReason(gate, mv)}`);
          reported = true;
          await auditWorker(ctx, { event_type: "processing", class: from, record_ids: [mv.record_id],
                                   details: { op: "open_check_refused", via: "move", move_id: moveId, kinds: [], rules: [], gate, ...byWordDetails } });
          return;
        }
      }
      if (to === "open") {
        const found = await openCheckFull(ctx, dst, ctx.s3(to), mv.record_id, byWord ? accepted : [], textOnly);
        if (found?.unchecked === "busy" && await retryLater(ctx, mv, "open_check_busy", () => cleanupCopy(true))) return;
        if (!found) await ctx.db.control.query("UPDATE class_moves SET error = NULL WHERE id = $1 AND error LIKE 'open_check_busy:%'", [moveId]);
        if (found) {
          await fail(`open_check:${found.reasons}`);
          reported = true;
          await auditWorker(ctx, { event_type: "processing", class: from, record_ids: [mv.record_id],
                                   details: { op: "open_check_refused", via: "move", move_id: moveId, kinds: found.kinds, rules: found.rules, ...(found.unchecked ? { unchecked: found.unchecked } : {}), ...byWordDetails } });
          return;
        }
        if (byWord) {
          const trace = { move_id: moveId, rules: accepted, at: new Date().toISOString(), confirmation: mv.confirmation,
                          ...(textOnly ? { text_only: true } : {}), ...(mv.accepted_scope ? { scope: mv.accepted_scope } : {}) };
          await dst.query("UPDATE records SET attrs = COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('open_check_accepted', $2::jsonb) WHERE id = $1", [mv.record_id, JSON.stringify(trace)]);
          await dst.query("UPDATE records SET attrs = COALESCE(attrs, '{}'::jsonb) - 'open_check_fallback' WHERE id = ANY($1::uuid[]) AND attrs ? 'open_check_fallback'", [ids]);
        }
      }
      if (Number(fault.pause_sec) > 0) await new Promise((r) => setTimeout(r, Math.min(120, Number(fault.pause_sec)) * 1000));
      if (byWord && mv.confirmation === "human_workplace" && mv.accepted_print) {
        const late = await despiteLateGate(ctx, mv);
        if (late) {
          await fail(`open_check:gate=${late}: ${gateReason(late, mv)}`);
          reported = true;
          await auditWorker(ctx, { event_type: "processing", class: from, record_ids: [mv.record_id],
                                   details: { op: "open_check_refused", via: "move", move_id: moveId, kinds: [], rules: [], gate: late, ...byWordDetails } });
          return;
        }
      }
      const marks = (await src.query("SELECT id, deleted_at, deleted_by, purge_after, deleted_batch FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL", [ids])).rows;
      for (const m of marks)
        await dst.query("UPDATE records SET deleted_at = $2, deleted_by = $3, purge_after = $4, deleted_batch = $5 WHERE id = $1 AND deleted_at IS NULL", [m.id, m.deleted_at, m.deleted_by, m.purge_after, m.deleted_batch]);
      await tx(src, async (c) => {
        await c.query(MOVE_SOURCE_LOCK, [mv.record_id]);
        const derived = (await c.query(
          `SELECT id, attrs->'derived_lost' AS lost, attrs->>'derived_lost_cause' AS lost_cause, attrs->'derived_pending' AS pending, attrs->'derived_declared' AS declared FROM records
            WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids])).rows.filter((d) => d.lost !== null || d.pending !== null || d.declared !== null);
        const added = (await c.query(`${TREE} SELECT id FROM tree`, [mv.record_id])).rows.map((r) => r.id as string).filter((id) => !moving.has(id));
        if (added.length) throw new TreeChanged(added.length);
        if (byWord && mv.confirmation === "human_workplace" && mv.accepted_print) {
          const late = (await c.query(`SELECT count(*)::int AS n FROM records r WHERE r.id = ANY($1::uuid[]) AND ${LINEAGE_LOST_SQL("r")}`, [ids])).rows[0]?.n ?? 0;
          if (late) throw new LineageChanged(late);
        }
        const have = (await dst.query("SELECT count(*)::int AS n FROM records WHERE id = ANY($1::uuid[])", [ids])).rows[0]?.n ?? 0;
        if (have !== ids.length) throw new Error(`the copy is missing from the destination database: ${have} of ${ids.length} rows. The source was not deleted`);
        for (const d of derived) await dst.query(DERIVED_SYNC_SQL, [d.id, d.lost === true, JSON.stringify(Array.isArray(d.pending) ? d.pending : []),
                                                                    typeof d.declared === "number" ? d.declared : 0, typeof d.lost_cause === "string" ? d.lost_cause : null]);
        await c.query(`INSERT INTO record_tombstones (id, source_hash, reason, moved_to_class) SELECT id, source_hash, 'moved', $2::data_class FROM records WHERE id = ANY($1::uuid[])
                       ON CONFLICT (id) DO UPDATE SET reason = 'moved', moved_to_class = EXCLUDED.moved_to_class, at = now()`, [ids, to]);
        await c.query("DELETE FROM records WHERE id = ANY($1::uuid[])", [ids]);
        if (correctionsMoved.length) await c.query("DELETE FROM record_corrections WHERE id = ANY($1::uuid[])", [correctionsMoved]);
        await c.query(CORRECTIONS_SUPERSEDE, [ids]);
      });
      srcDeleted = true;
    }
    const closing = to === "closed" ? await closedByFallback(ctx, dst, moveId, mv.record_id, ids) : null;
    await dst.query("UPDATE records SET hidden_at = NULL WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL", [ids]);
    const present = (await dst.query("SELECT count(*)::int AS n FROM records WHERE id = ANY($1::uuid[])", [ids])).rows[0]?.n ?? 0;
    if (present !== ids.length) throw new Error(`the copy is missing from the destination database: ${present} of ${ids.length} rows. The transfer is incomplete`);
    await dst.query("DELETE FROM record_tombstones WHERE id = ANY($1::uuid[]) AND reason = 'moved'", [ids]);
    if (to === "open" && fault.fail === "finish") throw new Error("final step failure requested by the acceptance test");
    const links = await tx(ctx.db.control, async (c) => {
      await c.query("SELECT id FROM record_links WHERE src_id = ANY($1::uuid[]) OR dst_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
      if (to === "closed") linkDetails = await copyLinkDetailsForClose(ctx, ids);
      await c.query(
        `UPDATE record_locations SET class = $2, open_check = CASE WHEN $2 = 'open' THEN NULL WHEN record_id = $4 AND $3::jsonb IS NOT NULL THEN $3::jsonb ELSE open_check END,
              updated_at = now() WHERE record_id = ANY($1::uuid[])`, [ids, to, closing?.mark ?? null, mv.record_id]);
      const count = await switchLinkClasses(c, ids, to);
      await c.query("UPDATE class_moves SET status = 'done', finished_at = now(), error = CASE WHEN error ~ '^(open_check_busy|tree_changed|schema_skew|finish_failed): attempt ' THEN NULL ELSE error END WHERE id = $1", [moveId]);
      return count;
    });
    finished = true;
    // the move's last step — the held indexed stages of the tree are due now in the class the record ended up in
    await wakeHeldIndex(ctx, to, mv.record_id, ids, moveId);
    if (to === "open")
      await ctx.db.control.query(`UPDATE open_recheck_holds SET state = 'released', updated_at = now()
                                   WHERE record_id = ANY($1::uuid[]) AND state IN ('held','kept','on_restore','failed')`, [ids])
        .catch((e) => log.warn("open_recheck_release_failed", { move_id: moveId, error: (e as Error).message.slice(0, 120) }));
    if (to === "closed") await dropMovedDetails(ctx, linkDetails.copied, from);
    const swept = await removeOriginals(ctx, from, originals, ids, "move_original_cleanup_failed", moveId);
    const leftovers = swept.failed + swept.unchecked;
    await auditWorker(ctx, { event_type: "class_move", class: to, record_ids: ids, details: { move_id: moveId, from, to, links, link_details_moved: linkDetails.copied.length, ...byWordDetails, ...(leftovers ? { original_leftovers: leftovers } : {}) } });
    log.info("class_moved", { move_id: moveId, records: ids.length, from, to });
  } catch (e) {
    if (finished) {
      log.warn("class_move_after_done_failed", { move_id: moveId, record_id: mv.record_id, from, to, error: String((e as Error)?.message ?? e).slice(0, 200) });
      return;
    }
    if ((e as { code?: string })?.code === "40P01" && !srcDeleted && await retryLater(ctx, mv, "deadlock", () => cleanupCopy(true))) return;
    if (e instanceof TreeChanged && !srcDeleted && await retryLater(ctx, mv, "tree_changed", () => cleanupCopy(true))) return;
    if (e instanceof LineageChanged && !srcDeleted) {
      await fail(`open_check:gate=changed: ${gateReason("changed", mv)}`);
      reported = true;
      await auditWorker(ctx, { event_type: "processing", class: from, record_ids: [mv.record_id],
                               details: { op: "open_check_refused", via: "move", move_id: moveId, kinds: [], rules: [], gate: "changed", ...byWordDetails } });
      return;
    }
    if (srcDeleted && to === "open") { if (await unfinished(e) === "handled") return; throw e; }
    await fail((e as Error).message);
    if (byWord && !reported)
      await auditWorker(ctx, { event_type: "class_move", class: from, record_ids: [mv.record_id], details: { move_id: moveId, failed: "error", ...byWordDetails } })
        .catch((x: Error) => log.warn("class_move_audit_failed", { move_id: moveId, error: x.message.slice(0, 120) }));
    throw e;
  }
}

export const LOCATOR_GRACE_MIN = 10;
const HOME_REPAIR_MAX = 200;
const ACTIVE_REVIEW = ["unreviewed", "confirmed", "community", "exempt"];

const HOME_LOCKS_SQL = `WITH RECURSIVE up AS (
    SELECT id, parent_id, 0 AS d FROM records WHERE id = $1
    UNION ALL SELECT r.id, r.parent_id, u.d + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.d < 50),
  chain AS (
    SELECT id, supersedes_id, superseded_by_id FROM records WHERE id IN (SELECT id FROM up)
    UNION SELECT r.id, r.supersedes_id, r.superseded_by_id FROM records r JOIN chain c ON r.id IN (c.supersedes_id, c.superseded_by_id))
  SELECT DISTINCT id FROM chain`;

async function versionReview(ctx: DbCtx, q: import("pg").PoolClient, prevId: string, id: string, spaceId: string, audience: string): Promise<void> {
  const carried = await carryOrgReview(q, prevId, id);
  const org = (await q.query("SELECT kind FROM spaces WHERE id = $1", [spaceId])).rows[0]?.kind === "org";
  if (!org || !orgReviewEnabled(ctx.settings)) return;
  const days = reviewDays(ctx.settings);
  if (carried === null)
    await q.query(`INSERT INTO org_reviews (record_id, instance_id, state, entered_via, entered_human, from_audience, return_after)
                   VALUES ($1, $2, 'unreviewed', 'version', false, $3, now() + make_interval(days => $4::int)) ON CONFLICT (record_id) DO NOTHING`,
                  [id, ctx.instanceId, audience === "people" ? "people" : "space", days]);
  else
    await q.query(`UPDATE org_reviews SET state = 'unreviewed', entered_via = 'version', entered_human = false, entered_at = now(),
                     return_after = COALESCE(return_after, now() + make_interval(days => $2::int)), decided_at = NULL, decided_by = NULL, decided_via = NULL
                    WHERE record_id = $1 AND state IN ('confirmed','community')`, [id, days]);
}

async function homeReview(ctx: DbCtx, q: import("pg").PoolClient, id: string, fromSpace: string, toSpace: string, audience: string): Promise<void> {
  const kinds = new Map((await q.query("SELECT id, kind FROM spaces WHERE id = ANY($1::uuid[])", [[fromSpace, toSpace]])).rows.map((r) => [r.id as string, r.kind as string]));
  const toOrg = kinds.get(toSpace) === "org", fromOrg = kinds.get(fromSpace) === "org";
  if (fromOrg && !toOrg) {
    await q.query(`UPDATE org_reviews SET state = 'left', decided_at = now(), decided_by = NULL, decided_via = 'system'
                    WHERE record_id = $1 AND state IN ('unreviewed','confirmed','community')`, [id]);
    return;
  }
  if (!toOrg || fromOrg || !orgReviewEnabled(ctx.settings)) return;
  const days = reviewDays(ctx.settings);
  const aud = audience === "people" ? "people" : "space";
  const cur = (await q.query("SELECT state FROM org_reviews WHERE record_id = $1 FOR UPDATE", [id])).rows[0];
  if (!cur)
    await q.query(`INSERT INTO org_reviews (record_id, instance_id, state, entered_via, entered_human, from_space_id, from_audience, return_after)
                   VALUES ($1, $2, 'unreviewed', 'promote', false, $3, $4, now() + make_interval(days => $5::int))`, [id, ctx.instanceId, fromSpace, aud, days]);
  else if (!ACTIVE_REVIEW.includes(cur.state) && cur.state !== "superseded")
    await q.query(`UPDATE org_reviews SET state = 'unreviewed', cycle = cycle + 1, entered_at = now(), entered_via = 'promote', entered_by = NULL, entered_human = false,
                     from_space_id = $2, return_after = now() + make_interval(days => $3::int), decided_at = NULL, decided_by = NULL, decided_via = NULL, returned_to = NULL
                    WHERE record_id = $1`, [id, fromSpace, days]);
}

export async function repairHome(ctx: DbCtx, cls: DataClass, id: string): Promise<"locator" | "space" | null> {
  const db = recordsDb(ctx, cls);
  const ids = (await db.query(HOME_LOCKS_SQL, [id])).rows.map((r) => r.id as string).sort();
  if (!ids.length) return null;
  return tx(ctx.db.control, async (q) => {
    for (const x of ids)
      if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${x}`])).rows[0]?.ok) return null;
    if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [ids])).rowCount) return null;
    const r = (await db.query(
      `SELECT id, type::text AS type, space_id, owner_id, audience::text AS audience, parent_id, is_current, supersedes_id, source_hash, attrs,
              hidden_at IS NOT NULL AS hidden, deleted_at IS NOT NULL AS deleted, ingested_at < now() - make_interval(mins => $2::int) AS aged
       FROM records WHERE id = $1`, [id, LOCATOR_GRACE_MIN])).rows[0];
    if (!r || r.hidden) return null;
    const loc = (await q.query("SELECT class, space_id FROM record_locations WHERE record_id = $1", [id])).rows[0];
    if (!loc) {
      if (r.deleted || !r.attrs?.correction || !r.aged) return null;
      const ins = await q.query(
        "INSERT INTO record_locations (record_id, class, space_id, type, owner_id, source_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (record_id) DO NOTHING",
        [id, cls, r.space_id, r.type, r.owner_id, r.source_hash ?? null]);
      if (!ins.rowCount) return null;
      if (r.supersedes_id && r.attrs.correction?.kind === "own_note") {
        await versionReview(ctx, q, r.supersedes_id, id, r.space_id, r.audience);
        await q.query("UPDATE record_locations SET source_hash = NULL, open_check = NULL WHERE record_id = $1", [r.supersedes_id]);
      }
      return "locator";
    }
    if (loc.class !== cls || loc.space_id === r.space_id) return null;
    await q.query("UPDATE record_locations SET space_id = $2, updated_at = now() WHERE record_id = $1", [id, r.space_id]);
    if (!r.parent_id && r.is_current && !r.deleted) await homeReview(ctx, q, id, loc.space_id, r.space_id, r.audience);
    return "space";
  });
}

export async function tryRecordLocks<T>(ctx: DbCtx, ids: string[], fn: (alive: () => Promise<void>) => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const client = await ctx.db.control.connect();
  const held: string[] = [];
  let broken = false;
  let watch: ReturnType<typeof watchLock> | undefined;
  try {
    for (const id of [...new Set(ids)].sort()) {
      let ok: boolean;
      try { ok = (await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok === true; }
      catch (e) { broken = true; throw e; }
      if (!ok) return { busy: true };
      held.push(id);
    }
    watch = watchLock(client);
    const value = await fn(watch.alive);
    if (watch.lost()) throw new LockConnectionLost();
    return { busy: false, value };
  } finally {
    try {
      for (const id of held.reverse()) {
        if (watch?.lost()) break;
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`record:${id}`]).catch(() => { broken = true; });
      }
      if (watch?.lost()) {
        broken = true;
        log.warn("lock_connection_lost", { job: "record_lock" });
      }
    } finally {
      watch?.done();
      client.release(broken);
    }
  }
}

const ROOTS_OF = `WITH RECURSIVE up AS (
    SELECT id AS start, id, parent_id, 0 AS depth FROM records WHERE id = ANY($1::uuid[])
    UNION ALL SELECT u.start, r.id, r.parent_id, u.depth + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.depth < 1000
  ) SELECT start, id AS root FROM up WHERE parent_id IS NULL`;
const CHAIN_OF = `${chainTreeSql("$1")} SELECT id FROM chain`;

async function removeDupes(ctx: DbCtx, cls: DataClass, dupes: string[]): Promise<{ removed: number; skipped: number }> {
  const db = recordsDb(ctx, cls), odb = recordsDb(ctx, cls === "open" ? "closed" : "open");
  const rootOf = new Map<string, string>();
  for (const r of (await db.query(ROOTS_OF, [dupes])).rows) rootOf.set(r.start as string, r.root as string);
  const chainOf = new Map<string, string[]>(), groups = new Map<string, { keys: string[]; ids: string[] }>();
  for (const id of dupes) {
    const root = rootOf.get(id) ?? id;
    let keys = chainOf.get(root);
    if (!keys) {
      keys = (await db.query(CHAIN_OF, [root])).rows.map((r) => r.id as string);
      if (!keys.includes(root)) keys.push(root);
      keys.sort();
      for (const k of keys) chainOf.set(k, keys);
    }
    const g = keys.join(","), group = groups.get(g) ?? { keys, ids: [] };
    group.ids.push(id);
    groups.set(g, group);
  }
  const out = { removed: 0, skipped: 0 };
  for (const g of groups.values()) {
    const r = await tryRecordLocks(ctx, g.keys, async (): Promise<number | null> => {
      const inflight = (await ctx.db.control.query("SELECT record_id FROM class_moves WHERE status IN ('pending','copying','verifying')")).rows.map((x) => x.record_id as string);
      if (inflight.some((x) => g.keys.includes(x))) return null;
      const busy = new Set(inflight.length ? (await db.query(TREES_OF, [inflight])).rows.map((x) => x.id as string) : []);
      let left = g.ids.filter((id) => !busy.has(id));
      if (!left.length) return null;
      const loc = new Map<string, string>((await ctx.db.control.query("SELECT record_id, class FROM record_locations WHERE record_id = ANY($1::uuid[])", [left])).rows.map((x) => [x.record_id as string, x.class as string]));
      const hidden = new Set((await db.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL", [left])).rows.map((x) => x.id as string));
      left = left.filter((id) => (loc.has(id) ? loc.get(id) !== cls : hidden.has(id)));
      if (!left.length) return 0;
      const there = new Set((await odb.query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [left])).rows.map((x) => x.id as string));
      left = left.filter((id) => there.has(id));
      return left.length ? (await db.query("DELETE FROM records WHERE id = ANY($1::uuid[])", [left])).rowCount ?? 0 : 0;
    });
    if (r.busy || r.value === null) out.skipped++;
    else out.removed += r.value;
  }
  if (out.skipped) log.info("class_reconcile_skipped_locked", { class: cls, groups: out.skipped });
  return out;
}

interface Reclosed { moveId: string; head: string; author: string; space: string | null; tree: string[]; restored: boolean; retry: boolean }
export const RECLOSE_PAUSE_MIN = 30;
const RECLOSE_TRIES_SQL = `SELECT count(*)::int AS n, COALESCE(bool_or(finished_at IS NULL OR finished_at > now() - make_interval(mins => $2::int)), false) AS recent
  FROM class_moves WHERE record_id = ANY($1::uuid[]) AND via = $3 AND status = 'failed'
   AND requested_at > COALESCE((SELECT max(requested_at) FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status <> 'failed'), '-infinity'::timestamptz)`;

async function recheckOnRestore(ctx: DbCtx, ids: string[]): Promise<number> {
  return ctx.db.control.query(`UPDATE open_recheck_holds SET state = 'on_restore', held_at = COALESCE(held_at, now()), updated_at = now()
                                WHERE record_id = ANY($1::uuid[]) AND state IN ('held','kept')`, [ids])
    .then((r) => r.rowCount ?? 0, (e) => { log.warn("open_recheck_on_restore_failed", { records: ids.length, error: String((e as Error)?.message ?? e).slice(0, 120) }); return 0; });
}

interface RecheckReclosed { moveId: string; head: string; tree: string[]; marks: number; event: { author: string; space: string | null; why: OpenRecheckWhy } | null }
function whyOfMark(m: Record<string, unknown> | undefined): OpenRecheckWhy {
  const kinds = Array.isArray(m?.kinds) ? m!.kinds as unknown[] : [], rules = Array.isArray(m?.rules) ? m!.rules as unknown[] : [];
  return kinds.includes("unchecked") ? "unchecked" : rules.length && !rules.includes("nda") ? "rules" : "nda";
}

async function liveRecheckHolds(ctx: DbCtx, ids: string[]): Promise<Array<{ record_id: string; run_id: string; rules: string[] | null; why: string | null }>> {
  if (!ids.length || !(await ctx.db.control.query("SELECT to_regclass('open_recheck_holds') IS NOT NULL AS ok")).rows[0]?.ok) return [];
  const hs = (await ctx.db.control.query(
    `SELECT record_id, run_id, rules, why FROM open_recheck_holds WHERE instance_id = $1 AND record_id = ANY($2::uuid[]) AND state IN ('on_restore','held','kept')
      ORDER BY held_at DESC NULLS LAST, updated_at DESC`, [ctx.instanceId, ids])).rows as Array<{ record_id: string; run_id: string; rules: string[] | null; why: string | null }>;
  if (!hs.length) return [];
  const live = new Set((await recordsDb(ctx, "open").query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [[...new Set(hs.map((h) => h.record_id))]]))
    .rows.map((r) => r.id as string));
  return hs.filter((h) => live.has(h.record_id));
}

async function recloseRecheck(ctx: DbCtx, abandoned: string[]): Promise<{ keep: Set<string>; reclosed: RecheckReclosed[]; skipped: number }> {
  const out = { keep: new Set<string>(), reclosed: [] as RecheckReclosed[], skipped: 0 };
  const db = recordsDb(ctx, "open");
  const rootOf = new Map<string, string>();
  for (const r of (await db.query(ROOTS_OF, [abandoned])).rows) rootOf.set(r.start as string, r.root as string);
  const roots = [...new Set(abandoned.map((id) => rootOf.get(id) ?? id))];
  const treeOf = new Map<string, string[]>();
  for (const r of (await db.query(`${CHAIN_TREES} SELECT start, id FROM tree`, [roots])).rows) {
    const t = treeOf.get(r.start as string) ?? [];
    t.push(r.id as string);
    treeOf.set(r.start as string, t);
  }
  const all = [...new Set([...treeOf.values()].flat())];
  const touched = all.length ? new Set((await ctx.db.control.query("SELECT DISTINCT record_id FROM class_moves WHERE record_id = ANY($1::uuid[]) AND via = 'nda_recheck'", [all]))
    .rows.map((r) => r.record_id as string)) : new Set<string>();
  const holding = new Set((await liveRecheckHolds(ctx, all)).map((h) => h.record_id));
  if (!touched.size && !holding.size) return out;
  await reloadSettings(ctx);
  const limit = Math.max(1, Math.round(Number(ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 })?.limit)) || 3);
  const extra = openCheckSettings(ctx.settings).extra_rules ?? [];
  const seen = new Set<string>();
  for (const root of roots) {
    const tree = [...new Set(treeOf.get(root) ?? [root])].sort();
    const key = tree.join(",");
    if (seen.has(key) || !tree.some((id) => touched.has(id) || holding.has(id))) continue;
    seen.add(key);
    const lastOf = async () => (await ctx.db.control.query("SELECT record_id, via, to_class, status FROM class_moves WHERE record_id = ANY($1::uuid[]) ORDER BY requested_at DESC LIMIT 1", [tree])).rows[0] as
      { record_id: string; via: string | null; to_class: string; status: string } | undefined;
    const failedRecheck = (m: Awaited<ReturnType<typeof lastOf>>) => m?.via === "nda_recheck" && m.to_class === "closed" && m.status === "failed";
    const last = await lastOf();
    const failed = failedRecheck(last);
    const head = ((await db.query(CHAIN_HEAD, [root])).rows[0]?.id as string | undefined) ?? root;
    const h = (await db.query("SELECT hidden_at IS NOT NULL AS hidden, deleted_at IS NOT NULL AS deleted FROM records WHERE id = $1", [head])).rows[0] as
      { hidden: boolean; deleted: boolean } | undefined;
    if (!h) { for (const id of tree) out.keep.add(id); continue; }
    if (failed && h.deleted) { await recheckOnRestore(ctx, tree); continue; }
    const mode = failed && h.hidden ? "retry" as const
      : failed && !h.deleted && last!.record_id !== head ? "whole" as const
      : !failed && h.hidden && !h.deleted && tree.some((id) => holding.has(id)) ? "whole" as const : null;
    if (!mode) continue;
    for (const id of tree) out.keep.add(id);
    const tries = (await ctx.db.control.query(RECLOSE_TRIES_SQL, [tree, RECLOSE_PAUSE_MIN, "nda_recheck"])).rows[0] as { n: number; recent: boolean };
    if (tries.n >= limit) { log.warn("class_reconcile_recheck_exhausted", { record_id: head, failed: tries.n, limit }); continue; }
    if (tries.n && tries.recent) continue;
    const chain = (await db.query(CHAIN_OF, [root])).rows.map((r) => r.id as string);
    const r = await tryRecordLocks(ctx, chain.length ? chain : [head], async (): Promise<RecheckReclosed | null> => {
      if ((await ctx.db.control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [tree])).rowCount) return null;
      const row = (await db.query("SELECT hidden_at IS NOT NULL AS hidden, deleted_at IS NOT NULL AS deleted FROM records WHERE id = $1", [head])).rows[0];
      if (!row || row.deleted || (mode === "retry" && !row.hidden)) return null;
      const loc = (await ctx.db.control.query("SELECT class, owner_id, space_id, deleted, deleted_at IS NOT NULL AS trash FROM record_locations WHERE record_id = $1", [head])).rows[0];
      if (mode === "retry") {
        if (!loc || loc.class !== "open" || loc.deleted) return null;
        const moveId = newId();
        await db.query(`UPDATE records SET attrs = jsonb_set(attrs, '{open_check_fallback,move_id}', to_jsonb($2::text))
                         WHERE id = $1 AND attrs -> 'open_check_fallback' ->> 'via' = 'nda_recheck'`, [head, moveId]);
        await ctx.db.control.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'nda_recheck')",
                                   [moveId, head, loc.owner_id]);
        await ctx.db.control.query("UPDATE open_recheck_holds SET move_id = $2, updated_at = now() WHERE record_id = ANY($1::uuid[]) AND state IN ('held','kept')", [tree, moveId])
          .catch((e) => log.warn("open_recheck_hold_move_failed", { move_id: moveId, error: String((e as Error)?.message ?? e).slice(0, 120) }));
        return { moveId, head, tree, marks: 0, event: null };
      }
      if (!loc || loc.class !== "open" || (loc.deleted && !loc.trash)) return null;
      const lastNow = await lastOf();
      const part = failedRecheck(lastNow) && lastNow!.record_id !== head ? lastNow!.record_id : null;
      const hs = await liveRecheckHolds(ctx, tree);
      if (!part && !(row.hidden && hs.length)) return null;
      const trashed = (await ctx.db.control.query("SELECT record_id FROM record_locations WHERE record_id = ANY($1::uuid[]) AND deleted AND deleted_at IS NOT NULL", [tree])).rows.map((x) => x.record_id as string);
      const alive = trashed.length ? (await db.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [trashed])).rows.map((x) => x.id as string) : [];
      const marks = alive.length ? await syncDeletionMarks(ctx.db.control, db, alive) : 0;
      await db.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [head]);
      const moveId = newId();
      const sum = recheckHoldSummary(hs, extra);
      const prior = (await db.query("SELECT id, attrs -> 'open_check_fallback' AS m FROM records WHERE id = ANY($1::uuid[]) AND attrs -> 'open_check_fallback' ->> 'via' = 'nda_recheck'",
                                    [[head, ...(part ? [part] : [])]])).rows as Array<{ id: string; m: Record<string, unknown> }>;
      const was = prior.find((x) => x.id === head)?.m ?? prior[0]?.m;
      const mark = was ? { ...was, move_id: moveId } : sum ? recheckMark(sum.found, { moveId, run: sum.run, unchecked: sum.unchecked }) : null;
      if (mark) await db.query("UPDATE records SET attrs = COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('open_check_fallback', $2::jsonb) WHERE id = $1", [head, JSON.stringify(mark)]);
      await ctx.db.control.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'nda_recheck')",
                                 [moveId, head, loc.owner_id]);
      const ids = [...new Set([...hs.map((x) => x.record_id), ...(part ? [part] : [])])];
      if (sum) await recheckHoldsToHead(ctx.db.control, { instanceId: ctx.instanceId, head, ids, moveId, sum, spaceId: (loc.space_id as string | null) ?? null, ownerId: loc.owner_id as string })
        .catch((e) => log.warn("open_recheck_hold_move_failed", { move_id: moveId, error: String((e as Error)?.message ?? e).slice(0, 120) }));
      log.warn("class_reconcile_recheck_whole", { move_id: moveId, record_id: head, part: Boolean(part), restored: alive.length });
      return { moveId, head, tree, marks, event: { author: loc.owner_id as string, space: (loc.space_id as string | null) ?? null, why: sum?.why ?? whyOfMark(was) } };
    });
    if (r.busy) { out.skipped++; continue; }
    if (r.value) out.reclosed.push(r.value);
  }
  return out;
}

async function recloseReturned(ctx: DbCtx, abandoned: string[]): Promise<{ keep: Set<string>; reclosed: Reclosed[]; skipped: number; marks: number }> {
  const out = { keep: new Set<string>(), reclosed: [] as Reclosed[], skipped: 0, marks: 0 };
  const db = recordsDb(ctx, "open");
  const rootOf = new Map<string, string>();
  for (const r of (await db.query(ROOTS_OF, [abandoned])).rows) rootOf.set(r.start as string, r.root as string);
  const roots = [...new Set(abandoned.map((id) => rootOf.get(id) ?? id))];
  const BACK = `SELECT id, owner_id, attrs -> 'organizer_return' ->> 'at' AS since FROM records
    WHERE id = ANY($1::uuid[]) AND parent_id IS NULL AND attrs -> 'organizer_return' -> 'trashed' = 'true'::jsonb
      AND owner_id::text = attrs -> 'organizer_return' ->> 'to' AND hidden_at IS NOT NULL AND deleted_at IS NULL`;
  const back = (await db.query(BACK, [roots])).rows as Array<{ id: string; owner_id: string; since: string | null }>;
  if (!back.length) return out;
  const due = await despiteShown(ctx.db.control, back.map((r) => ({ id: r.id, holder: r.owner_id, since: r.since })));
  if (!due.size) return out;
  await reloadSettings(ctx);
  const limit = Math.max(1, Math.round(Number(ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 })?.limit)) || 3);
  const live = (l: { class: string; deleted: boolean; trash: boolean } | undefined) => l?.class === "open" && (!l.deleted || l.trash);
  for (const b of back) {
    if (!due.has(b.id)) continue;
    const tree = (await db.query(TREES_OF, [[b.id]])).rows.map((r) => r.id as string);
    for (const id of tree) out.keep.add(id);
    const tries = (await ctx.db.control.query(RECLOSE_TRIES_SQL, [tree, RECLOSE_PAUSE_MIN, "organizer_transfer"])).rows[0] as { n: number; recent: boolean };
    if (tries.n >= limit) { log.warn("class_reconcile_returned_exhausted", { record_id: b.id, failed: tries.n, limit }); continue; }
    if (tries.n && tries.recent) continue;
    const r = await tryRecordLocks(ctx, [b.id], async (): Promise<(Reclosed & { marks: number }) | null> => {
      if ((await ctx.db.control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [tree])).rowCount) return null;
      const now = (await db.query(BACK, [[b.id]])).rows[0] as { owner_id: string; since: string | null } | undefined;
      if (!now || now.owner_id !== b.owner_id) return null;
      const loc = (await ctx.db.control.query("SELECT class, owner_id, space_id, deleted, deleted_at IS NOT NULL AS trash FROM record_locations WHERE record_id = $1", [b.id])).rows[0];
      if (!loc || !live(loc) || !(await despiteShown(ctx.db.control, [{ id: b.id, holder: now.owner_id, since: now.since }])).size) return null;
      const trashed = (await ctx.db.control.query("SELECT record_id FROM record_locations WHERE record_id = ANY($1::uuid[]) AND deleted AND deleted_at IS NOT NULL", [tree])).rows.map((x) => x.record_id as string);
      const alive = trashed.length ? (await db.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [trashed])).rows.map((x) => x.id as string) : [];
      const marks = alive.length ? await syncDeletionMarks(ctx.db.control, db, alive) : 0;
      const moveId = newId();
      await ctx.db.control.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'organizer_transfer')",
                                 [moveId, b.id, now.owner_id]);
      return { moveId, head: b.id, author: now.owner_id, space: (loc.space_id as string | null) ?? null, tree, restored: loc.deleted === true, retry: tries.n > 0, marks };
    });
    if (r.busy) { out.skipped++; continue; }
    if (!r.value) continue;
    out.marks += r.value.marks;
    out.reclosed.push(r.value);
  }
  return out;
}
async function recloseShown(ctx: DbCtx, abandoned: string[]): Promise<{ keep: Set<string>; reclosed: Reclosed[]; skipped: number; marks: number }> {
  const out = { keep: new Set<string>(), reclosed: [] as Reclosed[], skipped: 0, marks: 0 };
  await reloadSettings(ctx);
  const ds = despiteSettings(ctx.settings);
  if (ds.enabled && ds.projects) return out;
  const limit = Math.max(1, Math.round(Number(ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 })?.limit)) || 3);
  const db = recordsDb(ctx, "open");
  const rootOf = new Map<string, string>();
  for (const r of (await db.query(ROOTS_OF, [abandoned])).rows) rootOf.set(r.start as string, r.root as string);
  const chainOf = new Map<string, string[]>(), groups = new Map<string, string[]>();
  for (const id of abandoned) {
    const root = rootOf.get(id) ?? id;
    let keys = chainOf.get(root);
    if (!keys) {
      keys = (await db.query(CHAIN_OF, [root])).rows.map((r) => r.id as string);
      if (!keys.includes(root)) keys.push(root);
      keys.sort();
      for (const k of keys) chainOf.set(k, keys);
    }
    groups.set(keys.join(","), keys);
  }
  const live = (l: { class: string; deleted: boolean; trash: boolean } | undefined) => l?.class === "open" && (!l.deleted || l.trash);
  for (const keys of groups.values()) {
    const head = ((await db.query(CHAIN_HEAD, [keys[0]])).rows[0]?.id as string | undefined) ?? keys[0]!;
    const h = (await db.query("SELECT hidden_at IS NOT NULL AS hidden, deleted_at IS NOT NULL AS deleted FROM records WHERE id = $1", [head])).rows[0] as
      { hidden: boolean; deleted: boolean } | undefined;
    if (!h) {
      for (const r of (await db.query(TREES_OF, [keys])).rows) out.keep.add(r.id as string);
      continue;
    }
    const hl = (await ctx.db.control.query("SELECT class, deleted, deleted_at IS NOT NULL AS trash FROM record_locations WHERE record_id = $1", [head])).rows[0] as
      { class: string; deleted: boolean; trash: boolean } | undefined;
    if (!h.hidden || h.deleted || !live(hl)) continue;
    if (!(await lastMoveShownShared(ctx.db.control, keys))) continue;
    const tree = (await db.query(TREES_OF, [keys])).rows.map((r) => r.id as string);
    for (const id of tree) out.keep.add(id);
    const r = await tryRecordLocks(ctx, keys, async (): Promise<(Reclosed & { marks: number }) | null> => {
      if ((await ctx.db.control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [tree])).rowCount) return null;
      const row = (await db.query("SELECT hidden_at IS NOT NULL AS hidden, deleted_at IS NOT NULL AS deleted FROM records WHERE id = $1", [head])).rows[0];
      if (!row?.hidden || row.deleted) return null;
      const loc = (await ctx.db.control.query("SELECT class, owner_id, space_id, deleted, deleted_at IS NOT NULL AS trash FROM record_locations WHERE record_id = $1", [head])).rows[0];
      if (!loc || !live(loc) || !(await lastMoveShownShared(ctx.db.control, keys))) return null;
      const tries = (await ctx.db.control.query(RECLOSE_TRIES_SQL, [tree, RECLOSE_PAUSE_MIN, "despite_rollback"])).rows[0] as { n: number; recent: boolean };
      if (tries.n >= limit) { log.warn("class_reconcile_reclose_exhausted", { record_id: head, failed: tries.n, limit }); return null; }
      if (tries.n && tries.recent) return null;
      const trashed = (await ctx.db.control.query("SELECT record_id FROM record_locations WHERE record_id = ANY($1::uuid[]) AND deleted AND deleted_at IS NOT NULL", [tree])).rows.map((x) => x.record_id as string);
      const alive = trashed.length ? (await db.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [trashed])).rows.map((x) => x.id as string) : [];
      const marks = alive.length ? await syncDeletionMarks(ctx.db.control, db, alive) : 0;
      const moveId = newId();
      await ctx.db.control.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'despite_rollback')",
                                 [moveId, head, loc.owner_id]);
      return { moveId, head, author: loc.owner_id as string, space: (loc.space_id as string | null) ?? null, tree, restored: loc.deleted === true, retry: tries.n > 0, marks };
    });
    if (r.busy) { out.skipped++; continue; }
    if (!r.value) continue;
    out.marks += r.value.marks;
    out.reclosed.push(r.value);
  }
  return out;
}

export async function reconcileClasses(ctx: DbCtx): Promise<{ removed: number; deleted_synced: number; marks_synced: number; orphans: number; unhidden: number; reclosed: number; skipped_locked: number;
                                                               locators_restored: number; space_repaired: number; links: LinkSweepResult }> {
  const out = { removed: 0, deleted_synced: 0, marks_synced: 0, orphans: 0, unhidden: 0, reclosed: 0, skipped_locked: 0, locators_restored: 0, space_repaired: 0 };
  const trashDays = Math.max(1, Math.round(Number(ctx.settings.get("access.trash_days", 30)) || 30));
  const roots = (await ctx.db.control.query("SELECT record_id FROM class_moves WHERE status IN ('pending','copying','verifying')")).rows.map((r) => r.record_id as string);
  const moving = new Set(roots);
  if (roots.length)
    for (const cls of ["open", "closed"] as DataClass[])
      for (const r of (await recordsDb(ctx, cls).query(TREES_OF, [roots])).rows)
        moving.add(r.id as string);
  for (const cls of ["open", "closed"] as DataClass[]) {
    const other: DataClass = cls === "open" ? "closed" : "open", db = recordsDb(ctx, cls), odb = recordsDb(ctx, other);
    const rows = (await db.query(`SELECT r.id, r.hidden_at IS NOT NULL AS hidden, r.deleted_at IS NOT NULL AS deleted, r.space_id, r.attrs ? 'correction' AS correction,
                                         COALESCE(${HELD_SQL("r")} OR EXISTS (SELECT 1 FROM records p WHERE p.id = r.parent_id AND ${HELD_SQL("p")}), false) AS held
                                  FROM records r ORDER BY r.id LIMIT 200000`)).rows;
    const ids = rows.map((r) => r.id as string);
    const locs = new Map<string, { class: DataClass; deleted: boolean; trash: boolean; space_id: string }>();
    for (let i = 0; i < ids.length; i += 5000)
      for (const l of (await ctx.db.control.query("SELECT record_id, class, deleted, deleted_at IS NOT NULL AS trash, space_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [ids.slice(i, i + 5000)])).rows)
        locs.set(l.record_id, { class: l.class, deleted: l.deleted, trash: l.trash, space_id: l.space_id });
    let abandoned = rows.filter((r) => !moving.has(r.id) && r.hidden && !r.held && locs.get(r.id)?.class === cls).map((r) => r.id as string);
    if (abandoned.length) {
      const late = (await ctx.db.control.query("SELECT record_id FROM class_moves WHERE status IN ('pending','copying','verifying')")).rows.map((r) => r.record_id as string);
      if (late.length) {
        const fresh = new Set((await db.query(TREES_OF, [late])).rows.map((r) => r.id as string));
        abandoned = abandoned.filter((id) => !fresh.has(id));
      }
    }
    if (cls === "open" && abandoned.length) {
      const rr = await recloseRecheck(ctx, abandoned)
        .catch((e) => { log.warn("class_reconcile_recheck_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) }); return null; });
      abandoned = rr ? abandoned.filter((id) => !rr.keep.has(id)) : [];
      for (const m of rr?.reclosed ?? []) {
        for (const id of m.tree) moving.add(id);
        out.reclosed++;
        out.marks_synced += m.marks;
        if (m.event) await auditWorker(ctx, { event_type: "class_move", class: "open", record_ids: [m.head], space_id: m.event.space,
                                              details: { op: "close", move_id: m.moveId, affected: m.tree.length, via: "nda_recheck", why: m.event.why, by: "auto", author: m.event.author,
                                                         on_restore: true, reconcile: true } });
        else log.info("class_reconcile_recheck_retry", { move_id: m.moveId, record_id: m.head });
        await (ctx as Partial<Ctx>).boss?.send("kick", { instance: ctx.instanceId, class: "open", record_id: m.head, lane: "now" },
                                               { priority: 10, singletonKey: `${m.head}:now`, retryLimit: 3, expireInSeconds: 900 })
          .catch((e: Error) => log.warn("class_reconcile_kick_failed", { move_id: m.moveId, error: e.message.slice(0, 120) }));
      }
      if (rr) out.skipped_locked += rr.skipped;
    }
    if (cls === "open" && abandoned.length) {
      const rt = await recloseReturned(ctx, abandoned)
        .catch((e) => { log.warn("class_reconcile_returned_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) }); return null; });
      abandoned = rt ? abandoned.filter((id) => !rt.keep.has(id)) : [];
      for (const m of rt?.reclosed ?? []) {
        for (const id of m.tree) moving.add(id);
        out.reclosed++;
        if (m.retry) log.info("class_reconcile_returned_retry", { move_id: m.moveId, record_id: m.head });
        else await auditWorker(ctx, { event_type: "class_move", class: "open", record_ids: [m.head], space_id: m.space,
                                      details: { op: "close", move_id: m.moveId, affected: m.tree.length, via: "organizer_transfer", by: "auto", author: m.author, reconcile: true,
                                                 ...(m.restored ? { on_restore: true } : {}) } });
        await (ctx as Partial<Ctx>).boss?.send("kick", { instance: ctx.instanceId, class: "open", record_id: m.head, lane: "now" },
                                               { priority: 10, singletonKey: `${m.head}:now`, retryLimit: 3, expireInSeconds: 900 })
          .catch((e: Error) => log.warn("class_reconcile_kick_failed", { move_id: m.moveId, error: e.message.slice(0, 120) }));
      }
      if (rt) { out.marks_synced += rt.marks; out.skipped_locked += rt.skipped; }
    }
    if (cls === "open" && abandoned.length) {
      const rc = await recloseShown(ctx, abandoned)
        .catch((e) => { log.warn("class_reconcile_reclose_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) }); return null; });
      abandoned = rc ? abandoned.filter((id) => !rc.keep.has(id)) : [];
      for (const m of rc?.reclosed ?? []) {
        for (const id of m.tree) moving.add(id);
        out.reclosed++;
        if (m.retry) log.info("class_reconcile_reclose_retry", { move_id: m.moveId, record_id: m.head });
        else await auditWorker(ctx, { event_type: "class_move", class: "open", record_ids: [m.head], space_id: m.space,
                                      details: { op: "close", move_id: m.moveId, affected: m.tree.length, by: "admin_rollback", author: m.author, reconcile: true, ...(m.restored ? { on_restore: true } : {}) } });
        await (ctx as Partial<Ctx>).boss?.send("kick", { instance: ctx.instanceId, class: "open", record_id: m.head, lane: "now" },
                                               { priority: 10, singletonKey: `${m.head}:now`, retryLimit: 3, expireInSeconds: 900 })
          .catch((e: Error) => log.warn("class_reconcile_kick_failed", { move_id: m.moveId, error: e.message.slice(0, 120) }));
      }
      if (rc) { out.marks_synced += rc.marks; out.skipped_locked += rc.skipped; }
    }
    if (abandoned.length) out.unhidden += (await db.query("UPDATE records SET hidden_at = NULL WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL", [abandoned])).rowCount ?? 0;
    const stray = rows.filter((r) => !moving.has(r.id) && (locs.get(r.id) ? locs.get(r.id)!.class !== cls : r.hidden));
    if (stray.length) {
      const inOther = new Set((await odb.query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [stray.map((r) => r.id)])).rows.map((r) => r.id as string));
      const dupes = stray.filter((r) => inOther.has(r.id)).map((r) => r.id as string);
      if (dupes.length) {
        const r = await removeDupes(ctx, cls, dupes);
        out.removed += r.removed; out.skipped_locked += r.skipped;
      }
      out.orphans += stray.length - dupes.length;
    }
    const own = rows.filter((r) => !moving.has(r.id) && locs.get(r.id)?.class === cls);
    for (const r of own.filter((x) => !x.deleted && locs.get(x.id)!.deleted)) {
      if (!locs.get(r.id)!.trash)
        out.deleted_synced += (await db.query("SELECT mark_deleted($1, NULL, make_interval(days => $2::int)) AS n", [r.id, trashDays])).rows[0].n as number;
      out.marks_synced += await syncDeletionMarks(ctx.db.control, db, [r.id]);
    }
    const unsynced = own.filter((x) => x.deleted && !locs.get(x.id)!.deleted).map((x) => x.id as string);
    if (unsynced.length) out.marks_synced += await syncDeletionMarks(ctx.db.control, db, unsynced);
    const homeless = rows.filter((r) => !moving.has(r.id) && !r.hidden && !r.deleted && r.correction && !locs.get(r.id));
    const astray = rows.filter((r) => !moving.has(r.id) && !r.hidden && locs.get(r.id)?.class === cls && locs.get(r.id)!.space_id !== r.space_id);
    for (const r of [...homeless, ...astray].slice(0, HOME_REPAIR_MAX)) {
      const done = await repairHome(ctx, cls, r.id).catch((e) => { log.warn("class_reconcile_home_failed", { record_id: r.id, class: cls, error: (e as Error).message.slice(0, 160) }); return null; });
      if (done === "locator") out.locators_restored++;
      else if (done === "space") out.space_repaired++;
    }
  }
  await ctx.db.control.query("DELETE FROM action_plans WHERE instance_id=$1 AND expires_at < now() - interval '7 days'", [ctx.instanceId]);
  await cancelStalePlanned(ctx);
  const links = await sweepLinks(ctx, moving);
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'class_reconcile', $2, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, JSON.stringify({ ...out, links, at: new Date().toISOString() })]);
  if (out.removed || out.deleted_synced || out.marks_synced || out.orphans || out.unhidden || out.reclosed || out.locators_restored || out.space_repaired) {
    log.warn("class_reconcile", out);
    await auditWorker(ctx, { event_type: "class_move", details: { reconcile: out } });
  }
  return { ...out, links };
}

export async function cancelStalePlanned(ctx: DbCtx): Promise<Record<DataClass, number>> {
  const out: Record<DataClass, number> = { open: 0, closed: 0 };
  for (const cls of ["open", "closed"] as DataClass[]) {
    try {
      const n = (await recordsDb(ctx, cls).query(
        "UPDATE record_corrections SET status = 'cancelled', text = NULL, fields = NULL, quote = NULL WHERE status = 'planned' AND created_at < now() - interval '1 day'")).rowCount ?? 0;
      out[cls] = n;
      if (n) log.info("planned_corrections_cancelled", { class: cls, n });
    } catch (e) {
      log.warn("planned_corrections_cancel_failed", { class: cls, error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
  return out;
}

async function orphanConverterRuns(ctx: DbCtx, cls: DataClass, rows: Array<{ id: string; conversion: unknown }>): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const c = (r.conversion ?? null) as { run_id?: unknown; document_id?: unknown } | null;
    if (typeof c?.run_id !== "string" || !c.run_id) continue;
    await auditWorker(ctx, { event_type: "processing", class: cls, record_ids: [r.id],
                             details: { job: "conversion", op: "orphan_run", run_id: c.run_id, document_id: typeof c.document_id === "string" ? c.document_id : null, why: "purge" } });
    n++;
  }
  if (n) log.info("purge_converter_orphans", { runs: n });
  return n;
}

export const CORRECTIONS_PURGE = "DELETE FROM record_corrections WHERE target_id = ANY($1::uuid[])";
export const CORRECTIONS_RESULT_GONE = "UPDATE record_corrections SET result_id = NULL WHERE result_id = ANY($1::uuid[])";
const DESCENDANTS = "WITH RECURSIVE tree AS (SELECT r.id FROM records r WHERE r.parent_id = ANY($1::uuid[]) UNION ALL SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id)";
export const PURGE_BATCH = 500;

export type PurgeCtx = DbCtx & { s3: (cls: DataClass) => S3Target | null };
export interface PurgeOpts {
  ids?: { open: string[]; closed: string[] };
  guard?: { owners: string[]; spaces: string[] };
  strict?: { reason: "test_purge"; plan: string; basis: string | null; mode: "manual" | "auto" };
  exceptSpaces?: string[];
  exceptOrigins?: string[];
  cutoff?: Date;
}
export interface PurgeResult { busy: boolean; purged: number; links: number;
  held?: HeldLocator[];
  more?: boolean }

export class PurgeStop extends Error {
  constructor(readonly code: "S2" | "S9", message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}

type PurgeRow = { id: string; source_hash: Buffer | null; conversion: any; original_key: string | null; owner_id: string; space_id: string; original_closed: boolean | null };

async function purgeClassTx(ctx: PurgeCtx, cls: DataClass, opts: PurgeOpts, alive: () => Promise<void>): Promise<PurgeRow[]> {
  const ids = opts.ids ? opts.ids[cls] : null;
  if (ids && !ids.length) return [];
  const params: unknown[] = [];
  const where = ["r.deleted_at IS NOT NULL"];
  if (opts.cutoff) { params.push(opts.cutoff); where.push(`r.purge_after <= $${params.length}::timestamptz`); }
  else where.push("r.purge_after <= now()");
  if (ids) { params.push(ids); where.push(`r.id = ANY($${params.length}::uuid[])`); }
  if (opts.guard) {
    params.push(opts.guard.owners); where.push(`r.owner_id = ANY($${params.length}::uuid[])`);
    params.push(opts.guard.spaces); where.push(`r.space_id = ANY($${params.length}::uuid[])`);
  }
  if (opts.exceptSpaces?.length) { params.push(opts.exceptSpaces); where.push(`NOT (r.space_id = ANY($${params.length}::uuid[]))`); }
  let held = "";
  if (opts.exceptOrigins?.length) {
    params.push(opts.exceptOrigins);
    held = `WITH RECURSIVE ${heldTreeCte(params.length)} `;
    where.push("NOT r.id IN (SELECT id FROM held_tree)");
  }
  const cols = "r.id, r.source_hash, r.attrs -> 'conversion' AS conversion, c.original_key, r.owner_id, r.space_id, (r.attrs->>'original_closed')::boolean AS original_closed";
  return await tx(recordsDb(ctx, cls), async (c) => {
    const roots: PurgeRow[] = (await c.query(
      `${held}SELECT ${cols} FROM records r LEFT JOIN record_content c ON c.record_id = r.id
        WHERE ${where.join(" AND ")} ORDER BY r.purge_after, r.id LIMIT ${PURGE_BATCH} FOR UPDATE OF r`, params)).rows;
    if (!roots.length) return [];
    const rootIds = roots.map((r) => r.id);
    const kidsOf = async (): Promise<PurgeRow[]> => (await c.query(
      `${DESCENDANTS} SELECT ${cols} FROM records r LEFT JOIN record_content c ON c.record_id = r.id
        WHERE r.id IN (SELECT id FROM tree) AND NOT r.id = ANY($1::uuid[]) ORDER BY r.id FOR UPDATE OF r`, [rootIds])).rows;
    let kids = await kidsOf();
    if (opts.exceptSpaces?.length && kids.some((k) => opts.exceptSpaces!.includes(k.space_id))) {
      const cut = (await c.query(
        `UPDATE records k SET parent_id = NULL,
                attrs = k.attrs || jsonb_build_object('detached_from', jsonb_build_object('record_id', p.id, 'type', p.type, 'occurred_at', p.occurred_at,
                                                                                         'reason', 'purge_held', 'at', now()))
           FROM records p
          WHERE k.id = ANY($1::uuid[]) AND k.parent_id = p.id AND k.space_id = ANY($2::uuid[]) AND NOT (p.space_id = ANY($2::uuid[]))
         RETURNING k.id`, [kids.filter((k) => opts.exceptSpaces!.includes(k.space_id)).map((k) => k.id), opts.exceptSpaces])).rows;
      if (cut.length) {
        log.warn("purge_held_detached", { class: cls, records: cut.length });
        kids = await kidsOf();
      }
    }
    if (opts.exceptOrigins?.length && kids.length) {
      const cut = (await c.query(
        `WITH RECURSIVE ${heldTreeCte(2)}
         UPDATE records k SET parent_id = NULL,
                attrs = k.attrs || jsonb_build_object('detached_from', jsonb_build_object('record_id', p.id, 'type', p.type, 'occurred_at', p.occurred_at,
                                                                                         'reason', 'purge_held', 'at', now()))
           FROM records p
          WHERE k.id = ANY($1::uuid[]) AND k.parent_id = p.id AND k.id IN (SELECT id FROM held_tree) AND NOT p.id IN (SELECT id FROM held_tree)
         RETURNING k.id`, [kids.map((k) => k.id), opts.exceptOrigins])).rows;
      if (cut.length) {
        log.warn("purge_held_detached", { class: cls, records: cut.length, via: "organizer_transfer" });
        kids = await kidsOf();
      }
    }
    const all = [...roots, ...kids];
    if (opts.guard) {
      const owners = new Set(opts.guard.owners), spaces = new Set(opts.guard.spaces);
      const outside = all.filter((r) => !owners.has(r.owner_id) || !spaces.has(r.space_id));
      if (outside.length) throw new PurgeStop("S2", `purge: ${outside.length} record tree rows are outside the guard`, { class: cls, ids: outside.slice(0, 20).map((r) => r.id) });
    }
    if (opts.strict) {
      await alive();
      try {
        await auditWorkerStrict(ctx, { event_type: "purge", class: cls, record_ids: all.map((r) => r.id),
          details: { reason: opts.strict.reason, purged: all.length, roots: roots.length, plan: opts.strict.plan, basis: opts.strict.basis, mode: opts.strict.mode } });
      } catch (e) { throw new PurgeStop("S9", `purge: log was not written (${(e as Error).message.slice(0, 120)})`, { class: cls }); }
    }
    await alive();
    await c.query(
      `INSERT INTO record_tombstones (id, source_hash, reason) SELECT id, h, 'purged' FROM unnest($1::uuid[], $2::bytea[]) AS t(id, h)
       ON CONFLICT (id) DO UPDATE SET reason = 'purged', moved_to_class = NULL, source_hash = EXCLUDED.source_hash, at = now()`,
      [all.map((r) => r.id), all.map((r) => r.source_hash)]);
    const del = opts.guard
      ? await c.query("DELETE FROM records WHERE id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[]) AND space_id = ANY($3::uuid[])", [rootIds, opts.guard.owners, opts.guard.spaces])
      : await c.query("DELETE FROM records WHERE id = ANY($1::uuid[])", [rootIds]);
    if ((del.rowCount ?? 0) !== roots.length) throw new Error(`purge: deleted ${del.rowCount} of ${roots.length} locked roots`);
    const left = (await c.query("SELECT count(*)::int AS n FROM records WHERE id = ANY($1::uuid[])", [all.map((r) => r.id)])).rows[0].n as number;
    if (left) throw new Error(`purge: ${left} record tree rows remain after DELETE`);
    await c.query(CORRECTIONS_PURGE, [all.map((r) => r.id)]);
    await c.query(CORRECTIONS_RESULT_GONE, [all.map((r) => r.id)]);
    await alive();
    return all;
  });
}

async function afterPurge(ctx: PurgeCtx, cls: DataClass, gone: PurgeRow[], opts: PurgeOpts, alive: () => Promise<void>): Promise<{ links: number; held: HeldLocator[] }> {
  await alive();
  await orphanConverterRuns(ctx, cls, gone).catch((e) => log.warn("purge_converter_orphans_failed", { error: (e as Error).message.slice(0, 120) }));
  const s3 = ctx.s3(cls);
  for (const d of gone) if (d.original_key && s3) {
    if (!(await originalStillUsed(ctx, cls, d.original_key))) {
      await alive();
      await s3Remove(s3, d.original_key).catch((e) => log.warn("purge_original_failed", { record_id: d.id, error: (e as Error).message.slice(0, 120) }));
    }
    const closedB = cls === "open" && (d.conversion?.error_kind === "open_check_fallback_failed" || d.original_closed === true) ? ctx.s3("closed") : null;
    if (closedB && !(await originalStillUsed(ctx, "closed", d.original_key))) {
      await alive();
      await s3Remove(closedB, d.original_key).catch((e) => log.warn("purge_original_failed", { record_id: d.id, error: (e as Error).message.slice(0, 120) }));
    }
  }
  const ids = gone.map((d) => d.id);
  const other = recordsDb(ctx, cls === "open" ? "closed" : "open");
  await alive();
  await other.query(CORRECTIONS_PURGE, [ids]).catch((e) => log.warn("purge_corrections_failed", { error: (e as Error).message.slice(0, 120) }));
  await alive();
  await other.query(CORRECTIONS_RESULT_GONE, [ids]).catch((e) => log.warn("purge_corrections_failed", { error: (e as Error).message.slice(0, 120) }));
  let links = 0, linksFailed = false;
  await alive();
  try { links = await purgeLinks(ctx, ids); }
  catch (e) {
    linksFailed = true;
    log.warn("purge_links_failed", { class: cls, records: ids.length, error: (e as Error).message.slice(0, 120) });
  }
  await alive();
  const { held } = await deleteLocators(ctx.db.control, ids);
  await alive();
  await ctx.db.control.query("UPDATE open_recheck_holds SET state = 'gone', updated_at = now() WHERE record_id = ANY($1::uuid[]) AND state IN ('pending','held','kept','on_restore','failed')", [ids])
    .catch((e) => log.warn("open_recheck_gone_failed", { records: ids.length, error: String((e as Error)?.message ?? e).slice(0, 120) }));
  await alive();
  await ctx.db.control.query("DELETE FROM deletion_requests WHERE record_id = ANY($1::uuid[])", [ids]);
  await alive();
  if (!opts.strict) await auditWorker(ctx, { event_type: "purge", class: cls, record_ids: ids, details: { purged: gone.length, links, ...(linksFailed ? { links_failed: true } : {}) } });
  return { links, held };
}

export async function heldTrashSpaces(ctx: DbCtx): Promise<string[]> {
  return (await heldTrashSnapshot(ctx)).spaces;
}

export async function heldTrashSnapshot(ctx: DbCtx): Promise<{ spaces: string[]; origins: string[]; dismissed: number; at: Date }> {
  const keep = custodyPolicy(ctx.settings).personal === "keep";
  const r = (await ctx.db.control.query(
    `SELECT now() AS at, ${keep ? `ARRAY(SELECT s.id FROM spaces s JOIN people p ON p.id = s.owner_id
      WHERE s.kind = 'personal' AND s.instance_id = $1 AND NOT p.active AND NOT ${testLoginSql("p")} AND NOT ${showcaseSql("p")} ORDER BY s.id)` : "'{}'::uuid[]"} AS spaces,
      ${keep ? `ARRAY(${HELD_ORIGINS_SQL})` : "'{}'::text[]"} AS origins,
      ${keep ? `(SELECT count(*)::int FROM people p WHERE p.instance_id = $1 AND NOT p.active AND NOT ${testLoginSql("p")} AND NOT ${showcaseSql("p")})` : "0"} AS dismissed`,
    keep ? [ctx.instanceId] : [])).rows[0];
  return { spaces: (r?.spaces ?? []) as string[], origins: (r?.origins ?? []) as string[], dismissed: Number(r?.dismissed ?? 0), at: new Date(r.at) };
}

export const HELD_PURGE_FROZEN = "9999-12-31T00:00:00Z";

const TRASH_HOLD_TOP_WHERE = `k.space_id = ANY($1::uuid[]) AND NOT (p.space_id = ANY($1::uuid[]))
  AND (k.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AND k.hidden_at IS NULL`;
export const TRASH_HOLD_DETACH_SQL = `UPDATE records k SET parent_id = NULL,
    attrs = k.attrs || jsonb_build_object('detached_from', jsonb_build_object('record_id', p.id, 'type', p.type, 'occurred_at', p.occurred_at,
                                                                             'reason', 'trash_hold', 'at', now()))
  FROM records p
  WHERE k.parent_id = p.id AND ${TRASH_HOLD_TOP_WHERE}
  RETURNING k.id`;

export async function dismissedTrashHold(ctx: DbCtx, args: string[] = []): Promise<{ mode: "freeze" | "thaw" | "check"; spaces: number; origins: number; frozen: number; to_freeze: number;
  transferred: number; at_risk: number; changed: number; detached: number }> {
  const mode = args.includes("--freeze") ? "freeze" : args.includes("--thaw") ? "thaw" : "check";
  if (args.includes("--freeze") && args.includes("--thaw")) throw new Error("dismissed_trash_hold: use either --freeze or --thaw");
  const snap = await heldTrashSnapshot(ctx);
  const spaces = snap.spaces, origins = snap.origins;
  const heldRow = (k: string) => `(${k}.space_id = ANY($1::uuid[]) OR ${k}.id IN (SELECT id FROM held_tree))`;
  let frozen = 0, toFreeze = 0, transferred = 0, atRisk = 0, changed = 0, detached = 0;
  for (const cls of ["open", "closed"] as DataClass[]) {
    const db = recordsDb(ctx, cls);
    if (mode === "freeze" && (spaces.length || origins.length)) {
      const done = await tx(db, async (c) => {
        await c.query(
          `WITH RECURSIVE ${heldTreeCte(2)}
           SELECT k.id FROM records k LEFT JOIN records p ON p.id = k.parent_id
            WHERE (k.deleted_at IS NOT NULL AND NOT k.attrs ? 'held_purge_after' AND ${heldRow("k")})
               OR (k.space_id = ANY($1::uuid[]) AND p.id IS NOT NULL AND ${TRASH_HOLD_TOP_WHERE})
            ORDER BY k.id FOR UPDATE OF k`, [spaces, origins]);
        const cut = spaces.length ? (await c.query(TRASH_HOLD_DETACH_SQL, [spaces])).rowCount ?? 0 : 0;
        const n = (await c.query(
          `WITH RECURSIVE ${heldTreeCte(2)}
           UPDATE records k SET attrs = k.attrs || jsonb_build_object('held_purge_after', k.purge_after), purge_after = $3::timestamptz
            WHERE k.deleted_at IS NOT NULL AND ${heldRow("k")} AND NOT k.attrs ? 'held_purge_after'`, [spaces, origins, HELD_PURGE_FROZEN])).rowCount ?? 0;
        return { cut, n };
      });
      detached += done.cut; changed += done.n;
    }
    if (mode === "thaw")
      changed += (await db.query(
        `UPDATE records SET purge_after = CASE WHEN deleted_at IS NOT NULL AND purge_after = $1::timestamptz THEN (attrs->>'held_purge_after')::timestamptz ELSE purge_after END,
                attrs = attrs - 'held_purge_after'
          WHERE attrs ? 'held_purge_after'`, [HELD_PURGE_FROZEN])).rowCount ?? 0;
    const n = (await db.query(
      `WITH RECURSIVE ${heldTreeCte(2)}
       SELECT count(*) FILTER (WHERE r.attrs ? 'held_purge_after')::int AS frozen,
              count(*) FILTER (WHERE r.deleted_at IS NOT NULL AND ${heldRow("r")} AND NOT r.attrs ? 'held_purge_after')::int AS to_freeze,
              count(*) FILTER (WHERE r.deleted_at IS NOT NULL AND r.id IN (SELECT id FROM held_tree))::int AS transferred,
              (SELECT count(*) FROM records k JOIN records p ON p.id = k.parent_id WHERE k.space_id = ANY($1::uuid[]) AND ${TRASH_HOLD_TOP_WHERE})::int AS at_risk
         FROM records r WHERE r.attrs ? 'held_purge_after' OR (r.deleted_at IS NOT NULL AND ${heldRow("r")})`, [spaces, origins])).rows[0];
    frozen += Number(n?.frozen ?? 0); toFreeze += Number(n?.to_freeze ?? 0); transferred += Number(n?.transferred ?? 0); atRisk += Number(n?.at_risk ?? 0);
  }
  if (mode !== "check") log.info("dismissed_trash_hold", { mode, spaces: spaces.length, origins: snap.dismissed, changed, detached });
  return { mode, spaces: spaces.length, origins: snap.dismissed, frozen, to_freeze: toFreeze, transferred, at_risk: atRisk, changed, detached };
}

export async function purgeLocked(ctx: PurgeCtx, opts: PurgeOpts = {}): Promise<PurgeResult> {
  const regular = !opts.ids && !opts.guard && !opts.exceptSpaces;
  const client = await ctx.db.control.connect();
  let broken: Error | boolean | undefined;
  try {
    let ok: boolean;
    try { ok = (await client.query("SELECT pg_try_advisory_lock(hashtext('purge:' || $1)) AS ok", [ctx.instanceId])).rows[0].ok as boolean; }
    catch (e) { broken = e as Error; throw e; }
    if (!ok) return { busy: true, purged: 0, links: 0 };
    const watch = watchLock(client);
    try {
      if (regular) { const snap = await heldTrashSnapshot(ctx); opts = { ...opts, exceptSpaces: snap.spaces, exceptOrigins: snap.origins, cutoff: snap.at }; }
      let purged = 0, links = 0, more = false;
      const held: HeldLocator[] = [];
      for (const cls of ["open", "closed"] as DataClass[]) {
        await watch.alive();
        const gone = await purgeClassTx(ctx, cls, opts, watch.alive);
        if (gone.length >= PURGE_BATCH) more = true;
        if (!gone.length) continue;
        const after = await afterPurge(ctx, cls, gone, opts, watch.alive);
        links += after.links; held.push(...after.held);
        purged += gone.length;
      }
      if (purged) log.info("purged", { records: purged, ...(opts.strict ? { reason: opts.strict.reason, mode: opts.strict.mode } : {}) });
      return { busy: false, purged, links, ...(held.length ? { held } : {}), ...(more ? { more } : {}) };
    } finally {
      try {
        if (!watch.lost()) {
          try { await client.query("SELECT pg_advisory_unlock(hashtext('purge:' || $1))", [ctx.instanceId]); }
          catch (e) { broken = e as Error; }
        }
        if (watch.lost()) {
          broken = true;
          log.warn("lock_connection_lost", { job: "purge" });
        }
      } finally { watch.done(); }
    }
  } finally {
    client.release(broken);
  }
}

let purgeChain: Promise<unknown> = Promise.resolve();
export function purgeSerial(ctx: PurgeCtx, opts: PurgeOpts = {}): Promise<PurgeResult> {
  const run = purgeChain.then(() => purgeLocked(ctx, opts));
  purgeChain = run.catch(() => undefined);
  return run;
}

export async function purgeRetrying(ctx: PurgeCtx, opts: PurgeOpts = {}, o: { everyMs?: number; maxMs?: number } = {}): Promise<PurgeResult> {
  const every = o.everyMs ?? 2_000, until = Date.now() + (o.maxMs ?? 60_000);
  for (;;) {
    const r = await purgeSerial(ctx, opts);
    if (!r.busy || Date.now() + every > until) return r;
    await new Promise((res) => setTimeout(res, every));
  }
}

let purgePending: { run: Promise<PurgeResult>; asks: number } | null = null;
export function purgeSoon(ctx: PurgeCtx, o: { everyMs?: number; maxMs?: number } = {}): Promise<PurgeResult> {
  if (purgePending) { purgePending.asks++; return purgePending.run; }
  const every = o.everyMs ?? 2_000, maxMs = o.maxMs ?? 60_000;
  const me: { run: Promise<PurgeResult>; asks: number } = { run: Promise.resolve({ busy: false, purged: 0, links: 0 }), asks: 1 };
  me.run = purgeChain.then(async () => {
    if (purgePending === me) purgePending = null;
    const until = Date.now() + maxMs, asks = me.asks;
    let total: PurgeResult = { busy: false, purged: 0, links: 0 }, passes = 0;
    for (;;) {
      const r = await purgeLocked(ctx);
      if (r.busy) {
        if (Date.now() + every > until) return passes ? total : r;
        await new Promise((res) => setTimeout(res, every));
        continue;
      }
      passes++;
      const held = [...(total.held ?? []), ...(r.held ?? [])];
      total = { busy: false, purged: total.purged + r.purged, links: total.links + r.links, ...(held.length ? { held } : {}) };
      if (!r.more || passes >= asks) return total;
    }
  });
  purgePending = me;
  purgeChain = me.run.catch(() => undefined);
  return me.run;
}

export function kickPurge(ctx: PurgeCtx): Promise<void> {
  return purgeSoon(ctx).then((r) => { if (r.busy) log.warn("purge_busy", { waited_sec: 60 }); },
                             (e) => log.warn("purge_kick_failed", { error: String((e as Error)?.message ?? e).slice(0, 120) }));
}

export async function purge(ctx: PurgeCtx): Promise<number> {
  const r = await purgeSerial(ctx);
  return r.busy ? 0 : r.purged;
}

export const REEXTRACT_STAGES = ["summary", "events", "described"] as const;

export async function reextract(ctx: DbCtx, opts: { limit?: number } = {}): Promise<{ queued: number; limit: number; by_stage: Record<string, number> }> {
  const configured = Number(ctx.settings.get("processing.backfill_per_night", 200));
  const limit = Math.max(0, Math.floor(opts.limit ?? (Number.isFinite(configured) ? configured : 200)));
  const by_stage: Record<string, number> = {};
  if (!limit) return { queued: 0, limit, by_stage };

  const stages: string[] = [], versions: string[] = [];
  for (const stage of REEXTRACT_STAGES) { stages.push(stage); versions.push(await versionFor(ctx, stage)); }

  let left = limit, queued = 0, entities = 0, calmed = 0;
  for (const cls of ["open", "closed"] as DataClass[]) {
    if (left <= 0) break;
    const { rows } = await recordsDb(ctx, cls).query(
      `WITH want AS (SELECT * FROM unnest($1::text[], $2::text[]) AS w(stage, version)),
            stale AS (
              SELECT s.record_id, s.stage FROM record_stages s
              JOIN records_live r ON r.id = s.record_id
              JOIN want w ON w.stage = s.stage::text
              WHERE s.status = 'done' AND s.version IS DISTINCT FROM w.version
              ORDER BY s.updated_at LIMIT $3),
            upd AS (
              UPDATE record_stages t SET status = 'pending', attempts = 0, terminal = false,
                     last_error = 'reextract: the stage ran with an older prompt version', updated_at = now()
              FROM stale WHERE t.record_id = stale.record_id AND t.stage = stale.stage
              RETURNING t.record_id, t.stage::text AS stage),
            -- Links to projects, companies and people are based on new mentions: the entities stage is queued again (after model
            -- stages — nextStage), linkEntities removes earlier links from the model
            ent AS (
              UPDATE record_stages e SET status = 'pending', attempts = 0, terminal = false, version = NULL,
                     last_error = 'reextract: links are recalculated from new mentions', updated_at = now()
              WHERE e.record_id IN (SELECT record_id FROM upd) AND e.stage = 'entities' AND e.status IN ('done','skipped','failed')
              RETURNING e.record_id),
            -- Reprocessing runs at night: the earlier “Process now” request (and the transcriber flag)
            -- no longer applies to the record. It is cleared only when no other unfinished stage remains — a new request is
            -- preserved; explicitly choosing “Process now” sets the flag again. An unfinished stage can still run on its own:
            -- it is waiting, running or failed with retries remaining; a stopped stage (terminal refusal, retry limit, “too
            -- slow”) will not run on its own or keep the flag — otherwise reprocessing could run during the day. The CTE snapshot is
            -- from before the updates: reset stages still show as done
            calm AS (
              UPDATE records r SET attrs = r.attrs - 'process_now_at'
              WHERE r.id IN (SELECT record_id FROM upd) AND r.attrs ? 'process_now_at'
                AND NOT EXISTS (SELECT 1 FROM record_stages o WHERE o.record_id = r.id AND o.stage <> 'entities'
                                  AND (o.status IN ('pending','running')
                                       OR (o.status = 'failed' AND NOT o.terminal AND o.attempts < $4 AND COALESCE(o.last_error, '') NOT LIKE '${TOO_SLOW_PREFIX}%')))
              RETURNING r.id)
       SELECT record_id, stage, (SELECT count(*) FROM ent)::int AS entities, (SELECT count(*) FROM calm)::int AS calmed FROM upd`,
      [stages, versions, left, ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit]);
    const here: Record<string, number> = {};
    for (const row of rows) { here[row.stage] = (here[row.stage] ?? 0) + 1; by_stage[row.stage] = (by_stage[row.stage] ?? 0) + 1; }
    entities += Number(rows[0]?.entities ?? 0); calmed += Number(rows[0]?.calmed ?? 0);
    left -= rows.length; queued += rows.length;
    if (rows.length) await auditWorker(ctx, { event_type: "processing", class: cls,
      record_ids: [...new Set(rows.map((r) => r.record_id as string))], details: { job: "reextract", stages: here, limit } });
  }
  log.info("reextract", { queued, limit, by_stage, entities, now_cleared: calmed, versions: Object.fromEntries(stages.map((s, i) => [s, versions[i]])) });
  return { queued, limit, by_stage };
}

export const REEXTRACT_GAP_HOURS = 18;

export async function reextractNightly(ctx: DbCtx, gapHours = REEXTRACT_GAP_HOURS): Promise<(Awaited<ReturnType<typeof reextract>> & { skipped?: "night_cap" }) | null> {
  const due = await tx(ctx.db.control, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('reextract:' || $1))", [ctx.instanceId]);
    const last = (await c.query(
      `SELECT (value->>'at')::timestamptz > now() - make_interval(hours => $2) AS recent FROM maintenance_state WHERE instance_id = $1 AND key = 'reextract_last'`,
      [ctx.instanceId, gapHours])).rows[0];
    if (last?.recent === true) return false;
    await c.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'reextract_last', jsonb_build_object('at', now()), now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId]);
    return true;
  });
  if (!due) return null;
  const cap = await nightCapState(ctx, { fresh: true });
  if (cap.capped || cap.prev?.capped_at) {
    const waiting = await nightWaiting(ctx);
    if (waiting === null || waiting > 0) {
      const limit = Math.max(0, Math.floor(Number(ctx.settings.get("processing.backfill_per_night", 200)) || 0));
      log.info("reextract_skipped", { reason: "night_cap", waiting });
      await auditWorker(ctx, { event_type: "processing", details: { job: "reextract", skipped: "night_cap", waiting, cap: cap.cap,
                                                                    last_tokens: cap.capped ? cap.tokens : cap.prev?.tokens ?? 0 } });
      return { queued: 0, limit, by_stage: {}, skipped: "night_cap" };
    }
  }
  return reextract(ctx);
}

export const DISMISSED_DETACH_SQL = `UPDATE records c SET parent_id = NULL,
    attrs = c.attrs || jsonb_build_object('detached_from', jsonb_build_object('record_id', p.id, 'type', p.type, 'occurred_at', p.occurred_at,
                                                                             'reason', 'dismissed_retention', 'at', now()))
  FROM records p
  WHERE c.parent_id = p.id AND p.space_id = $1 AND c.space_id <> $1
    AND (c.deleted_at IS NULL OR c.deleted_batch IS DISTINCT FROM p.deleted_batch)
  RETURNING c.id`;

async function dismissedMoveBusy(ctx: DbCtx, spaceId: string, moving: string[]): Promise<boolean> {
  if (!moving.length) return false;
  for (const cls of ["open", "closed"] as DataClass[]) {
    const hit = await recordsDb(ctx, cls).query(
      `${chainTreeSql("ANY($1::uuid[])")} SELECT 1 FROM records r WHERE r.id IN (SELECT id FROM tree)
         AND (r.space_id = $2 OR EXISTS (SELECT 1 FROM records p WHERE p.id = r.parent_id AND p.space_id = $2)) LIMIT 1`, [moving, spaceId]);
    if (hit.rowCount) return true;
  }
  return false;
}

const DISMISSED_PLACED_SQL = `SELECT r.id, pl.space_id, pl.placed_at FROM records r JOIN record_placements pl ON pl.record_id = r.id AND pl.space_id <> r.space_id
  WHERE r.space_id = $1 AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND r.is_current AND r.audience = 'space'
  ORDER BY r.id, pl.placed_at, pl.space_id`;

export function dismissedTarget<S extends { kind: string }>(placed: ReadonlyArray<{ space: S | undefined; placed_at: Date | string }>): S | null {
  const ok = placed.filter((p): p is { space: S; placed_at: Date | string } => !!p.space && ["team", "project", "org"].includes(p.space.kind));
  ok.sort((a, b) => Number(a.space.kind === "org") - Number(b.space.kind === "org") || new Date(a.placed_at).getTime() - new Date(b.placed_at).getTime());
  return ok[0]?.space ?? null;
}

const DISMISSED_ORG_REVIEW_SQL = `INSERT INTO org_reviews (record_id, instance_id, state, entered_via, entered_by, entered_human, extended, from_space_id, from_audience, return_after)
  VALUES ($1, $2, 'unreviewed', 'promote', NULL, false, false, $3, 'space', now() + make_interval(days => $4::int))
  ON CONFLICT (record_id) DO UPDATE SET state = 'unreviewed', cycle = org_reviews.cycle + 1, entered_at = now(), entered_via = EXCLUDED.entered_via,
    entered_by = NULL, entered_human = false, extended = false, from_space_id = EXCLUDED.from_space_id, from_audience = EXCLUDED.from_audience,
    exempt_kind = NULL, return_after = COALESCE(org_reviews.return_after, EXCLUDED.return_after),
    decided_at = NULL, decided_by = NULL, decided_via = NULL, returned_to = NULL
  WHERE org_reviews.state IN ('left','superseded')`;

const DISMISSED_ORG_REFUSED = ["returned", "deleted"];

const DISMISSED_STILL_DUE_SQL = `SELECT 1 FROM people p JOIN spaces s ON s.id = $2 AND s.kind = 'personal' AND s.owner_id = p.id
  WHERE p.id = $1 AND NOT p.active AND s.archived_at IS NOT NULL AND s.archived_at < now() - make_interval(days => $3)
  FOR SHARE OF p`;

type Due = { person_id: string; space_id: string; days: number };
const stillDue = async (q: Pick<import("pg").PoolClient, "query">, d: Due): Promise<boolean> =>
  !!(await q.query(DISMISSED_STILL_DUE_SQL, [d.person_id, d.space_id, d.days])).rowCount;

async function dismissedRelocate(ctx: DbCtx, d: Due, alive?: () => Promise<void>): Promise<{ moved: number; busy: boolean; gone: boolean }> {
  let moved = 0;
  for (const cls of ["open", "closed"] as DataClass[]) {
    const db = recordsDb(ctx, cls);
    const rows = (await db.query(DISMISSED_PLACED_SQL, [d.space_id])).rows as Array<{ id: string; space_id: string; placed_at: Date }>;
    if (!rows.length) continue;
    const spaces = new Map((await ctx.db.control.query(
      "SELECT id, slug, name, kind, instance_id FROM spaces WHERE id = ANY($1::uuid[]) AND instance_id = $2 AND archived_at IS NULL",
      [[...new Set(rows.map((r) => r.space_id))], ctx.instanceId])).rows.map((s) => [s.id as string, s as { id: string; slug: string; name: string; kind: string; instance_id: string }]));
    const byRec = new Map<string, Array<{ space: { id: string; slug: string; name: string; kind: string; instance_id: string } | undefined; placed_at: Date }>>();
    for (const r of rows) byRec.set(r.id, [...(byRec.get(r.id) ?? []), { space: spaces.get(r.space_id), placed_at: r.placed_at }]);
    for (const [id, placed] of byRec) {
      const to = dismissedTarget(placed);
      if (!to) continue;
      const out = await tx(ctx.db.control, async (q) => {
        if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok) return "busy" as const;
        if (!(await stillDue(q, d))) return "gone" as const;
        if (to.kind === "org") {
          const st = (await q.query("SELECT state FROM org_reviews WHERE record_id = $1 FOR UPDATE", [id])).rows[0]?.state as string | undefined;
          if (st && DISMISSED_ORG_REFUSED.includes(st)) return "refused" as const;
        }
        if (alive) await alive();
        const entity = to.kind === "project" ? await ensureProjectEntity(q, to, { update: false }) : null;
        try {
          return await spaceMove(q, db, { recordId: id, cls, toSpaceId: to.id, actorId: null, authorId: d.person_id, op: "move_space", widen: false,
                                          onlyFrom: d.space_id, rootOnly: true }, async (c) => {
            await c.query("DELETE FROM record_placements WHERE record_id = $1 AND space_id = $2", [id, to.id]);
            if (entity) await c.query(
              "INSERT INTO record_entities (record_id, entity_id, role, method, confidence) VALUES ($1, $2, 'space', 'stated_by_human', 1.0) ON CONFLICT DO NOTHING", [id, entity]);
            if (to.kind === "org" && orgReviewEnabled(ctx.settings))
              await q.query(DISMISSED_ORG_REVIEW_SQL, [id, ctx.instanceId, d.space_id, reviewDays(ctx.settings)]);
            return (await c.query("SELECT count(*)::int AS n FROM record_placements WHERE record_id = $1", [id])).rows[0].n as number;
          });
        } catch (e) {
          if (e instanceof MemoryError && e.code === "in_progress") return "busy" as const;
          throw e;
        }
      });
      if (out === "busy") return { moved, busy: true, gone: false };
      if (out === "gone") return { moved, busy: false, gone: true };
      if (out === "refused") {
        log.info("dismissed_retention_org_refused", { space_id: d.space_id, record_id: id });
        continue;
      }
      if (out.status !== "moved") continue;
      moved++;
      await auditWorker(ctx, { event_type: "promote", class: cls, record_ids: [id], space_id: to.id,
        details: { job: "dismissed_retention", op: "move_space", by: "auto", from_space: d.space_id, to_space: to.slug, author: d.person_id, placements_left: out.extra } });
    }
  }
  return { moved, busy: false, gone: false };
}

async function dismissedClassTx(c: import("pg").PoolClient, spaceId: string): Promise<{ ids: string[]; detached: string[] } | null> {
  const rows = (await c.query(
    `SELECT r.id, p.id IS NULL AS top FROM records r LEFT JOIN records p ON p.id = r.parent_id AND p.space_id = $1 AND p.deleted_at IS NULL
     WHERE r.space_id = $1 AND r.deleted_at IS NULL ORDER BY r.id FOR UPDATE OF r`, [spaceId])).rows as Array<{ id: string; top: boolean }>;
  if (!rows.length) return null;
  const detached = (await c.query(DISMISSED_DETACH_SQL, [spaceId])).rows.map((r) => r.id as string);
  const roots = [...rows.filter((r) => r.top), ...rows.filter((r) => !r.top)].map((r) => r.id);
  for (const id of roots) await c.query("SELECT mark_deleted($1, NULL, interval '7 days')", [id]);
  const marked = (await c.query("SELECT id, space_id FROM records WHERE deleted_batch = ANY($1::uuid[]) AND deleted_at IS NOT NULL", [roots])).rows as Array<{ id: string; space_id: string }>;
  const away = marked.filter((r) => r.space_id !== spaceId);
  if (away.length) throw new Error(`dismissed_retention: deletion would include ${away.length} rows outside the personal space — rolled back`);
  return { ids: marked.map((r) => r.id), detached };
}

export async function dismissedProfileCopies(ctx: DbCtx): Promise<number> {
  const locs = (await ctx.db.control.query(
    `SELECT l.record_id, l.space_id FROM record_locations l
       JOIN spaces s ON s.id = l.space_id AND s.kind = 'org' AND s.instance_id = $1
       JOIN people p ON p.id = l.owner_id AND NOT p.active
      WHERE l.type = 'profile' AND l.class = 'open' AND NOT l.deleted`, [ctx.instanceId])).rows as Array<{ record_id: string; space_id: string }>;
  if (!locs.length) return 0;
  const db = recordsDb(ctx, "open");
  const copies = (await db.query(
    `SELECT id FROM records WHERE id = ANY($1::uuid[]) AND type = 'profile' AND source_kind = 'agent' AND source_ref LIKE 'workprofile-public:%' AND deleted_at IS NULL`,
    [locs.map((l) => l.record_id)])).rows.map((r) => r.id as string);
  if (!copies.length) return 0;
  await tx(db, async (c) => { for (const id of copies) await c.query("SELECT mark_deleted_chain($1, NULL, interval '0')", [id]); });
  const ids = (await db.query("SELECT id FROM records WHERE deleted_batch = ANY($1::uuid[])", [copies])).rows.map((r) => r.id as string);
  await syncDeletionMarks(ctx.db.control, db, ids);
  await auditWorker(ctx, { event_type: "forget", class: "open", record_ids: ids, space_id: locs[0]!.space_id,
    details: { op: "profile_public_off", reason: "profile_owner_left", action: "purge_now", affected: ids.length } });
  log.info("dismissed_profile_copies", { copies: copies.length, affected: ids.length });
  return copies.length;
}

export interface DismissedPass { busy?: true; frozen: number; custody: CustodyPassResult; meetings: MeetingsPassResult; notify: NotifyPassResult;
  people: number; records: number; kept: number; relocated: number; skipped: number }

export async function dismissedRetention(ctx: DbCtx): Promise<DismissedPass> {
  const lock = await ctx.db.control.connect();
  let clean = false;
  try {
    const ok = (await lock.query("SELECT pg_try_advisory_lock(hashtext('dismissed_retention:' || $1)) AS ok", [ctx.instanceId])).rows[0]?.ok === true;
    if (!ok) {
      clean = true;
      log.info("dismissed_retention_pass_busy", { instance: ctx.instanceId });
      return { busy: true, frozen: 0, custody: { ...EMPTY_CUSTODY }, meetings: { ...EMPTY_MEETINGS }, notify: { ...EMPTY_NOTIFY }, people: 0, records: 0, kept: 0, relocated: 0, skipped: 0 };
    }
    const watch = watchLock(lock);
    try { return await dismissedPass(ctx, watch.alive); }
    finally {
      try {
        if (!watch.lost())
          await lock.query("SELECT pg_advisory_unlock(hashtext('dismissed_retention:' || $1))", [ctx.instanceId]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "dismissed_retention" });
        }
      } finally { watch.done(); }
    }
  } finally { lock.release(!clean); }
}

async function dismissedPass(ctx: DbCtx, alive?: () => Promise<void>): Promise<DismissedPass> {
  await ctx.settings.load(true);
  const policy = custodyPolicy(ctx.settings);
  const days = Number(ctx.settings.get("access.dismissed_retention_days", 90));
  if (alive) await alive();
  const frozen = (await ctx.db.control.query(
    `UPDATE spaces s SET archived_at = now() FROM people p
     WHERE s.kind = 'personal' AND s.owner_id = p.id AND p.instance_id = $1 AND NOT p.active AND s.archived_at IS NULL
       AND COALESCE(p.attrs->>'demo', '') <> 'true'`, [ctx.instanceId])).rowCount ?? 0;
  if (frozen) log.info("dismissed_spaces_frozen", { spaces: frozen });
  if (alive) await alive();
  try { await dismissedProfileCopies(ctx); }
  catch (e) { log.error("dismissed_retention_failed", { step: "profile_public", error: (e as Error).message.slice(0, 200) }); }
  let custody: CustodyPassResult = { ...EMPTY_CUSTODY }, meetings: MeetingsPassResult = { ...EMPTY_MEETINGS };
  try { custody = await dismissedCustody(ctx, policy, alive); }
  catch (e) {
    if (e instanceof LockConnectionLost) throw e;
    log.error("dismissed_retention_failed", { step: "custody", error: (e as Error).message.slice(0, 200) });
  }
  try { meetings = await dismissedMeetings(ctx, policy, alive); }
  catch (e) {
    if (e instanceof LockConnectionLost) throw e;
    log.error("dismissed_retention_failed", { step: "meetings", error: (e as Error).message.slice(0, 200) });
  }
  let notify: NotifyPassResult = { ...EMPTY_NOTIFY };
  try { notify = await dismissedNotify(ctx, policy, alive); }
  catch (e) {
    if (e instanceof LockConnectionLost) throw e;
    log.error("dismissed_retention_failed", { step: "notify", error: (e as Error).message.slice(0, 200) });
  }
  const base = { frozen, custody, meetings, notify };
  if (!Number.isFinite(days) || days <= 0) return { ...base, people: 0, records: 0, kept: 0, relocated: 0, skipped: 0 };
  const due = (await ctx.db.control.query(dismissedDueSql(policy), [ctx.instanceId, days])).rows;
  const moving = due.length ? (await ctx.db.control.query("SELECT record_id FROM class_moves WHERE status IN ('pending','copying','verifying')")).rows.map((r) => r.record_id as string) : [];
  let people = 0, records = 0, kept = 0, relocated = 0, skipped = 0;
  for (const row of due) {
    if (alive) await alive();
    const d: Due = { person_id: row.person_id, space_id: row.space_id, days };
    if (await dismissedMoveBusy(ctx, d.space_id, moving)) {
      skipped++;
      log.warn("dismissed_retention_busy", { space_id: d.space_id, reason: "class_move" });
      continue;
    }
    let rel: { moved: number; busy: boolean; gone: boolean };
    try { rel = await dismissedRelocate(ctx, d, alive); }
    catch (e) {
      if (e instanceof LockConnectionLost) throw e;
      log.error("dismissed_retention_failed", { space_id: d.space_id, step: "relocate", error: (e as Error).message.slice(0, 200) });
      skipped++;
      continue;
    }
    relocated += rel.moved;
    if (rel.gone) {
      log.info("dismissed_retention_reactivated", { space_id: d.space_id, step: "relocate", relocated: rel.moved });
      continue;
    }
    if (rel.busy) {
      skipped++;
      log.warn("dismissed_retention_busy", { space_id: d.space_id, reason: "placed_document" });
      continue;
    }
    const all: string[] = [];
    let keptHere = 0, complete = true;
    for (const cls of ["open", "closed"] as DataClass[]) {
      const db = recordsDb(ctx, cls);
      let out: { ids: string[]; detached: string[] } | null | "gone";
      try {
        out = await tx(ctx.db.control, async (q) => {
          if (!(await stillDue(q, d))) return "gone" as const;
          if (alive) await alive();
          return tx(db, (c) => dismissedClassTx(c, d.space_id));
        });
      }
      catch (e) {
        if (e instanceof LockConnectionLost) throw e;
        log.error("dismissed_retention_failed", { space_id: d.space_id, class: cls, error: (e as Error).message.slice(0, 200) });
        complete = false;
        break;
      }
      if (out === "gone") {
        log.info("dismissed_retention_reactivated", { space_id: d.space_id, step: "delete", class: cls });
        complete = false;
        break;
      }
      if (!out) continue;
      await syncDeletionMarks(ctx.db.control, db, out.ids);
      all.push(...out.ids);
      if (out.detached.length) {
        keptHere += out.detached.length;
        await auditWorker(ctx, { event_type: "processing", class: cls, record_ids: out.detached, space_id: d.space_id,
          details: { job: "dismissed_retention", op: "detached", person: d.person_id, detached: out.detached.length } });
      }
    }
    kept += keptHere;
    if (all.length) {
      people++; records += all.length;
      await auditWorker(ctx, { event_type: "forget", record_ids: all, space_id: d.space_id,
        details: { reason: "dismissed_retention", person: d.person_id, retention_days: days, affected: all.length, kept_elsewhere: keptHere, relocated: rel.moved } });
    }
    if (complete) await custodyAfterDelete(ctx, d, alive).catch((e) => {
      if (e instanceof LockConnectionLost) throw e;
      log.warn("dismissed_custody_end_failed", { space_id: d.space_id, error: (e as Error).message.slice(0, 200) });
    });
  }
  if (people || skipped || relocated) log.info("dismissed_retention_applied", { people, records, kept, relocated, skipped, retention_days: days });
  return { ...base, people, records, kept, relocated, skipped };
}

export interface ProfileSource { display_name: string; role: string | null; department: string | null; manager: string | null;
  attrs?: { domains?: unknown; projects?: unknown } | null }

const filled = (v: string | null | undefined): string => (v ?? "").replace(/\s+/g, " ").trim();
const listOf = (v: unknown): string => (Array.isArray(v) ? v.map((x) => filled(String(x ?? ""))).filter(Boolean).join(", ") : "");

export function profileCardText(p: ProfileSource): string {
  const who = [filled(p.department) && `Department: ${filled(p.department)}`, filled(p.manager) && `Manager: ${filled(p.manager)}`];
  const what = [listOf(p.attrs?.domains) && `Domains: ${listOf(p.attrs?.domains)}`, listOf(p.attrs?.projects) && `Projects: ${listOf(p.attrs?.projects)}`];
  return [`# ${profileTitle(p)}`, who.filter(Boolean).join(" · "), what.filter(Boolean).join(" · ")].filter(Boolean).join("\n");
}

export const profileTitle = (p: Pick<ProfileSource, "display_name" | "role">): string => `${p.display_name} — ${filled(p.role) || "colleague"}`;

export const profileSummaryLine = (p: Pick<ProfileSource, "role" | "department">): string =>
  [filled(p.role) || "colleague", filled(p.department)].filter(Boolean).join(", ");

export async function profilesSync(ctx: Ctx): Promise<{ created: number; updated: number; retired: number; merged: number; fresh: string[] }> {
  const org = (await ctx.db.control.query("SELECT id, slug FROM spaces WHERE kind = 'org' AND instance_id = $1", [ctx.instanceId])).rows[0];
  if (!org) return { created: 0, updated: 0, retired: 0, merged: 0, fresh: [] };
  const people = (await ctx.db.control.query(
    `SELECT p.id, p.login, p.display_name, p.department, p.role, p.attrs, (SELECT m.display_name FROM people m WHERE m.login = p.manager_login) AS manager
     FROM people p WHERE p.instance_id = $1 AND p.active AND COALESCE(p.attrs->>'demo','') <> 'true'`, [ctx.instanceId])).rows;
  const db = recordsDb(ctx, "closed"); let created = 0, updated = 0, merged = 0;
  const fresh: string[] = [];
  const retire = async (extraId: string, keepId: string): Promise<void> => {
    await inheritCardReview(ctx.db.control, extraId, keepId);
    const r = await db.query("UPDATE records SET is_current = false, superseded_by_id = $1 WHERE id = $2 AND is_current", [keepId, extraId]);
    await db.query("DELETE FROM chunks WHERE record_id = $1", [extraId]);
    merged += r.rowCount ?? 0;
  };
  for (const p of people) {
    const text = profileCardText(p);
    const hash = createHash("sha256").update(text).digest(), ref = `people:${p.login}`;
    const cur = (await db.query(
      `SELECT id, version, source_hash, source_ref FROM records
       WHERE owner_id = $1 AND space_id = $2 AND source_kind = 'pipeline' AND type = 'profile' AND source_ref LIKE 'people:%' AND is_current AND deleted_at IS NULL
       ORDER BY (source_ref = $3) DESC, version DESC, created_at DESC`, [p.id, org.id, ref])).rows;
    const prev = cur[0], extra = cur.slice(1) as Array<{ id: string }>;
    if (prev && Buffer.compare(prev.source_hash, hash) === 0) {
      if (prev.source_ref !== ref) await db.query("UPDATE records SET source_ref = $2 WHERE id = $1", [prev.id, ref]);
      for (const x of extra) await retire(x.id, prev.id);
      continue;
    }
    const id = newId();
    await ctx.db.control.query("INSERT INTO record_locations (record_id, class, space_id, type, owner_id) VALUES ($1,'closed',$2,'profile',$3)", [id, org.id, p.id]);
    if (prev) await inheritCardReview(ctx.db.control, prev.id, id);
    await tx(db, async (c) => {
      await c.query(
        `INSERT INTO records (id, type, class, space_id, audience, owner_id, source_kind, source_ref, method, origin, occurred_at, title, summary_line, source_hash, version, supersedes_id, processor)
         VALUES ($1,'profile','closed',$2,'space',$3,'pipeline',$4,'source_document','agent',now(),$5,$6,$7,$8,$9,'{"job":"profiles_sync"}')`,
        [id, org.id, p.id, ref, profileTitle(p), profileSummaryLine(p), hash, prev ? prev.version + 1 : 1, prev?.id ?? null]);
      await c.query("INSERT INTO record_content (record_id, text) VALUES ($1,$2)", [id, text]);
      await c.query("INSERT INTO record_stages (record_id, stage) VALUES ($1,'indexed')", [id]);
      if (prev) await c.query("UPDATE records SET is_current = false, superseded_by_id = $1 WHERE id = $2", [id, prev.id]);
    });
    if (prev) await db.query("DELETE FROM chunks WHERE record_id = $1", [prev.id]);
    for (const x of extra) await retire(x.id, id);
    fresh.push(id);
    prev ? updated++ : created++;
  }
  const demo = (await ctx.db.control.query("SELECT id FROM people WHERE instance_id = $1 AND COALESCE(attrs->>'demo','') = 'true'", [ctx.instanceId])).rows.map((r) => r.id as string);
  const stale = demo.length
    ? (await db.query("SELECT id FROM records WHERE source_kind = 'pipeline' AND type = 'profile' AND source_ref LIKE 'people:%' AND owner_id = ANY($1::uuid[]) AND deleted_at IS NULL", [demo])).rows.map((r) => r.id as string)
    : [];
  if (stale.length) {
    await tx(db, async (c) => { for (const id of stale) await c.query("SELECT mark_deleted($1, NULL, interval '0')", [id]); });
    await syncDeletionMarks(ctx.db.control, db, stale);
    await auditWorker(ctx, { event_type: "forget", class: "closed", record_ids: stale, space_id: org.id, details: { reason: "demo_profile", affected: stale.length } });
  }
  const trashed = demo.length
    ? (await db.query("UPDATE records SET purge_after = now() WHERE source_kind = 'pipeline' AND type = 'profile' AND source_ref LIKE 'people:%' AND owner_id = ANY($1::uuid[]) AND deleted_at IS NOT NULL AND purge_after > now() RETURNING id", [demo])).rows.map((r) => r.id as string)
    : [];
  if (trashed.length) {
    await syncDeletionMarks(ctx.db.control, db, trashed);
    await auditWorker(ctx, { event_type: "forget", class: "closed", record_ids: trashed, space_id: org.id, details: { reason: "demo_profile", action: "trash_expired", affected: trashed.length } });
  }
  if (created || updated || merged || stale.length || trashed.length)
    log.info("profiles_synced", { created, updated, merged, retired: stale.length, trash_expired: trashed.length, path_example: recordPath(org.slug, "profile", new Date(), "…") });
  return { created, updated, retired: stale.length + trashed.length, merged, fresh };
}

export async function auditMaint(maint: import("pg").Pool): Promise<void> {
  for (const ahead of [0, 1, 2]) {
    try { await maint.query("SELECT audit_ensure_partition((date_trunc('month', current_date) + make_interval(months => $1))::date)", [ahead]); }
    catch (e) {
      const msg = (e as Error).message;
      log.warn("audit_partition_failed", { months_ahead: ahead, error: msg.slice(0, 200),
        cause: /default partition/i.test(msg) ? "audit_events_default already has rows for this month. Move them manually before creating the partition" : "see error" });
    }
  }
  const n = (await maint.query("SELECT audit_scrub_query_text() AS n")).rows[0].n;
  if (n) log.info("audit_scrubbed", { events: n });
  try {
    const gone = await outcomesRetention(maint);
    if (Object.values(gone).some(Boolean)) log.info("outcomes_retention", gone);
  } catch (e) { log.warn("outcomes_retention_failed", { error: (e as Error).message.slice(0, 200) }); }
}

export async function projectTagsSync(ctx: DbCtx): Promise<{ entities: number; collisions: number; tagged_open: number; tagged_closed: number }> {
  const out = { entities: 0, collisions: 0, tagged_open: 0, tagged_closed: 0 };
  const projects = (await ctx.db.control.query("SELECT id, slug, name, instance_id FROM spaces WHERE kind = 'project' AND instance_id = $1 ORDER BY id", [ctx.instanceId])).rows;
  const spaceIds: string[] = [], entityIds: string[] = [];
  for (const space of projects) {
    const id = await tx(ctx.db.control, async (q) => {
      const current = (await q.query("SELECT id, slug, name, instance_id FROM spaces WHERE id = $1 AND kind = 'project' AND instance_id = $2 FOR SHARE", [space.id, ctx.instanceId])).rows[0];
      return current ? ensureProjectEntity(q, current, { update: true }) : undefined;
    });
    if (id === undefined) continue;
    if (id === null) { out.collisions++; continue; }
    out.entities++; spaceIds.push(space.id); entityIds.push(id);
  }
  if (spaceIds.length) for (const cls of ["open", "closed"] as const) {
    const result = await recordsDb(ctx, cls).query(
      `WITH projects AS (SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS p(space_id, entity_id)), candidates AS (
         SELECT r.id, p.entity_id FROM records r JOIN projects p ON p.space_id = r.space_id
         WHERE r.deleted_at IS NULL AND r.hidden_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM record_entities e WHERE e.record_id = r.id AND e.entity_id = p.entity_id AND e.role = 'space')
         ORDER BY r.id LIMIT 5000
       )
       INSERT INTO record_entities (record_id, entity_id, role, method, confidence)
       SELECT id, entity_id, 'space', 'stated_by_human', 1.0 FROM candidates ON CONFLICT DO NOTHING`, [spaceIds, entityIds]);
    out[cls === "open" ? "tagged_open" : "tagged_closed"] = result.rowCount ?? 0;
  }
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'project_tags', $2, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, JSON.stringify({ ...out, at: new Date().toISOString() })]);
  log.info("project_tags_synced", out);
  return out;
}

export async function spaceInvitesExpire(ctx: DbCtx): Promise<{ removed: number }> {
  const removed = (await ctx.db.control.query("DELETE FROM space_invites WHERE instance_id = $1 AND expires_at <= now()", [ctx.instanceId])).rowCount ?? 0;
  if (removed) log.info("space_invites_expired", { removed });
  return { removed };
}
