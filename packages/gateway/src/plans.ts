// A plan records only ids and facts. Titles are read each time with the current rights.
import type pg from "pg";
import { archivedDenied, asData, binder, fingerprintOf, inProgress, instanceTz, invalid, isArchivedDenied, isSpaceGuideRow, isWorkProfileRow, LockConnectionLost, MemoryError, newId, notFound, parseDateBound, parseEntityKey, pipelineText,
         reversedRange, tx, upperBoundOp, visibleSql, watchLock, type DataClass, type DateBound, CHAIN_TREE } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { textsOf, type McpTexts } from "./mcp-texts.ts";
import { canWrite, classAllowed, loadReadable, locate, readableSpaces, resolveSpace, spaceReaders, visibilityFor, type RecordRow, type SpaceAccess } from "./access.ts";
import { audit, auditContext, auditRead } from "./audit.ts";
import { close, deleteRecord, isDirectoryCard, neverOpenReason, open, promote, purgeFromTrash, trashDays, trashRoot } from "./owner.ts";
import { withOwnerLocks, withControlConnection, withRecordSnapshot } from "./owner-lock.ts";
import { withCommittedOwnerEffects } from "./owner-effects.ts";
import { entityReadableById, entityUuid } from "./records.ts";
import { decodeKeyset, encodeKeyset, keysetAtSql } from "./paging.ts";
import { requireHuman, workplaceUrl, workplaceWhere } from "./workplace.ts";
import { applyPlannedCorrection, cancelPlannedRows, canonicalFields, correctionCaller, correctionRole, decideStatus, dedupeOf, kindApplicable, nonParticipant, plannedEffects,
         plannedStatus, replaceActor, targetFingerprint, targetOf, type CorrectionRole, type Target } from "./corrections.ts";
import { extendedOpenGate, isExtendedOpenDenial, openWriteMode } from "./extended-open.ts";
import { isDerivationDenial, promoteDerivation } from "./derivation.ts";
import { heldIds } from "./org-hold.ts";
import { isExternal } from "./channel.ts";
import { traceDenied } from "./denied-audit.ts";
import { canOwnConfirmation, humanConfirmationRequired, isConfirmationDenial, promoteConfirmationOn } from "./promote-confirmation.ts";
import { isHumanSession } from "./workplace.ts";
import { bulkOpenDenied, bulkOpenState } from "./bulk-open.ts";
import { bulkOpenText } from "./bulk-open.messages.ts";

/**
 * The words of a plan's criteria in `doc` (SQL expression; `query` — its bound parameter): matched in the full-text
 * configurations of this records database (retrieval_config) and as written (simple). The configuration is
 * taken from the joined pg_ts_config row, never by casting the stored name: a name the database does not know (a
 * dropped configuration) is skipped instead of failing the whole query.
 */
export function criteriaWordsSql(doc: string, query: string): string {
  return `(EXISTS (SELECT 1 FROM retrieval_config rc CROSS JOIN LATERAL unnest(rc.fts_configs || COALESCE(rc.fts_pending, '{}')) AS f(cfg)
                 JOIN pg_catalog.pg_ts_config t ON t.cfgname = f.cfg AND pg_catalog.pg_ts_config_is_visible(t.oid)
                 WHERE to_tsvector(t.oid::regconfig,${doc}) @@ plainto_tsquery(t.oid::regconfig,${query}))
          OR to_tsvector('simple',${doc}) @@ plainto_tsquery('simple',${query}))`;
}

// open: bulk "show to agents" — created only by the workspace route of "What my agent sees", applied only there
export type PlanOp = "delete" | "close" | "promote" | "move_space" | "purge" | "correct_bulk" | "open";
interface Criteria { space?: string; types?: string[]; event_kinds?: string[]; entity?: string; author?: string; from?: string; to?: string; domains?: string[]; query?: string }
/** Replace the assignee in all current events of one meeting (only op correct_bulk). */
interface CorrectBulk { meeting_id: string; actors_map: { from: string; to: string } }
export interface PlanArgs { op: PlanOp; ids?: string[]; criteria?: Criteria; to_space?: string; correct?: CorrectBulk }
export type Facts = Record<string, unknown>;
interface Candidate { id: string; class: DataClass; space_id: string; owner_id: string; type: string; title: string | null; parent_id: string | null; is_current: boolean; source_kind: string; source_ref: string | null; ancestors: string[]; locks: string[]; fingerprint: string; derived: number; slug: string; archived: boolean;
  /** The event's assignees (attrs.actors) — only for the correct_bulk plan page; not part of the fingerprint. */
  actors: string[];
  /** The plan page in the workplace: the space title and kind, the event kind — not a slug and not a code. */
  space_name: string; space_kind: string; event_kind: string | null }
interface PlanRow { id: string; person_id: string; key_id: string; created_via: "mcp" | "workplace"; op: PlanOp; params: { to_space_id?: string; meeting_id?: string; confirmation?: "agent_request" }; apply_via: "mcp" | "workplace"; apply_reason: string | null; status: string; items_total: number; cascade_total: number; spaces_total: number; created_at: Date; expires_at: Date; started_at: Date | null; applied_at: Date | null; result: ApplyResult | null; at_key?: string }
/** effect of a correct_bulk item: in control — only the draft id and, after applying, its status, no names. */
interface ItemRow { record_id: string; ord: number; class: DataClass; space_id: string; fingerprint: string; status: string; reason: string | null;
  effect: { kind: string; derived: number; trash_days?: number; correction_id?: string; status?: "applied" | "proposed" } }
type CorrectedStatus = "applied" | "proposed";
export interface ApplyResult { plan_id: string; status: "applied" | "partially_applied" | "applying"; done: number; skipped: number; excluded: number; remaining: number;
  items: { id: string; outcome: string; reason: string | null; status: CorrectedStatus | null }[]; trash_url: string | null }
// what planTool accepts from anybody; `open` is not here — only the workspace route may ask for it (planTool option)
const OPS: PlanOp[] = ["delete", "close", "promote", "move_space", "purge", "correct_bulk"];
const LABELS: Record<PlanOp, string> = { delete: "Move to Trash", close: "Hide from agents", promote: "Move", move_space: "Move between spaces", purge: "Delete permanently",
  correct_bulk: "Correct the assignee in meeting events", open: bulkOpenText("label") };
const FINAL = ["expired", "cancelled", "applied", "partially_applied"];
const problem = (reason: string, message: string, details: Facts = {}) => invalid(message, { reason, ...details });
const iso = (v: Date | string | null) => v ? new Date(v).toISOString() : null;
const bounded = (app: App, key: string, fallback: number, min: number, max: number) => {
  const value = Number(app.settings.get(key, fallback));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};
// fallback numbers — the same as in the seed: a setting cleared in the panel (null) is read from here
const ttl = (app: App) => bounded(app, "access.plan_ttl_minutes", 30, 1, 120);
const maximum = (app: App) => bounded(app, "limits.plan_max_items", 1000, 1, 2000);
const threshold = (app: App) => bounded(app, "access.plan_agent_max_items", 200, 0, 2000);
/** How long an agent's move request waits for the person, hours; the same fallback as the seed. */
const confirmTtlHours = (app: App) => bounded(app, "access.promote_confirmation_ttl_hours", 72, 1, 168);
/** At most this many agent move requests of one person wait for confirmation at a time. */
export const CONFIRMATION_PENDING_MAX = 20;

function person(caller: Caller): string {
  if (caller.principalType !== "person" || !caller.person || caller.onBehalfOf) throw new MemoryError("forbidden", "Only a person and their keys can access change plans");
  return caller.person.id;
}
function workplaceOnly(app: App, id: string): MemoryError {
  return new MemoryError("forbidden", "Only a person can apply this change plan in the workspace", { details: { reason: "workplace_only", workplace_url: workplaceUrl(app, `/plans/${id}`) } });
}
/** The external agent address says nothing about closed content: a closed-class record there is as nonexistent. */
const hiddenHere = (caller: Caller, cls: DataClass): boolean => cls === "closed" && isExternal(caller);

/**
 * Who applies a plan. `gate.confirm` (access.promote_confirmation is on): a promote or move_space plan whose target
 * is not a personal space, prepared by anyone but a person in the workplace, is applied only in the workplace — so the
 * multi-record path (memory_plan + memory_apply) cannot bypass the confirmation of a single move.
 */
export function applyVia(caller: Caller, op: PlanOp, items: number, spaces: number, max: number, used = 0,
                         gate: { target?: Pick<SpaceAccess, "kind"> | null; confirm: boolean } = { confirm: false }): { via: "mcp" | "workplace"; reason: string | null } {
  const confirmed = gate.confirm && (op === "promote" || op === "move_space") && gate.target?.kind !== "personal";
  const reason = op === "open" ? "workplace_only_op" : caller.preview ? "preview_key" : caller.clientKind === "script" ? "script_key"
    : caller.keyKind === "session" ? "created_in_workplace" : op === "purge" || op === "correct_bulk" || confirmed ? "workplace_only_op"
    : spaces > 1 ? "many_spaces" : items + used > max ? "over_threshold" : null;
  return { via: reason ? "workplace" : "mcp", reason };
}
export function effectText(op: PlanOp, effect: ItemRow["effect"], targetSlug?: string, targetKind?: string): string {
  if (op === "open") return effect.derived ? bulkOpenText("effect_derived", { n: String(effect.derived) }) : bulkOpenText("effect");
  // a move into one's own personal space is a return: the person sees "Return to personal", without the personal space slug
  const label = op === "promote" && targetKind === "personal" ? "Return to personal space" : `${LABELS[op]}${targetSlug ? ` to ${targetSlug}` : ""}`;
  return `${label}${effect.derived ? ` with derived records (${effect.derived})` : ""}${op === "delete" ? `; in Trash for ${effect.trash_days ?? 30} days.` : op === "purge" ? "; cannot be restored" : op === "close" ? "; agents with a personal key will no longer see the record" : ""}`;
}

/**
 * The memory_plan answer text. Many clients give the model only the text, not structuredContent: `plan_id` and the link
 * to the plan are in the heading, outside the data markers (like search_id of search), else the agent cannot apply the plan.
 * Each line has the record id: the agent builds exclude_ids from them when asked to spare something. An agent with no skill
 * (MCP only) would otherwise show the numbers to the employee — so the heading says they are not shown to the person.
 */
export function planText(p: { label: string; count: number; noun: string; via: "mcp" | "workplace"; planId: string; workplaceUrl: string | null; expiresAt: string;
                              items: { id: string; title: string | null; space: string; effect: string }[]; truncated: boolean }, texts: McpTexts): string {
  const how = p.via === "mcp"
    ? `Show the list to the person. Use memory_apply with this plan_id only after they explicitly agree. The id values at the end of rows are for exclude_ids and should be hidden from the person.${p.workplaceUrl ? ` Plan in the workspace: ${p.workplaceUrl}.` : ""}`
    : `Only a person can apply this plan in the workspace: ${p.workplaceUrl ?? "the “Bulk changes” section"}. Hide the id values at the end of the rows from the person.`;
  const shown = p.truncated ? `\nShowing the first ${p.items.length} of ${p.count}.` : "";
  const lines = p.items.map((r, i) => `${i + 1}. ${r.title ?? "untitled"} · ${r.space} — ${r.effect} · id ${r.id}`);
  return `Plan “${p.label}”: ${p.count} ${p.noun} · plan_id ${p.planId}. ${how} Valid until ${p.expiresAt}.${shown}\n${asData(lines.join("\n"), { texts })}`;
}

/** The fingerprint skips the background updated_at/attrs and holds the tree set: new derivatives need a new showing to delete. */
async function itemFacts(app: App, caller: Caller, id: string, op: PlanOp, spaces: Map<string, SpaceAccess>): Promise<Candidate> {
  const loc = await locate(app, id);
  if (!loc || !caller.scope.classes.includes(loc.class) || !classAllowed(caller, loc.class, loc.owner_id)) throw notFound(); // vis-ok: class gate before the pool
  let rec: RecordRow, db: pg.Pool;
  if (op === "purge") {
    await trashRoot(app, caller, id);
    db = app.db.records(loc.class, caller.scope);
    rec = (await db.query("SELECT * FROM records WHERE id = $1 AND deleted_at IS NOT NULL AND hidden_at IS NULL", [id])).rows[0];
    if (!rec) throw notFound();
  } else ({ rec, db } = await loadReadable(app, caller, id, spaces));
  const ancestors = (await db.query(`WITH RECURSIVE a AS (SELECT id, parent_id FROM records WHERE id = $1
    UNION SELECT r.id, r.parent_id FROM records r JOIN a ON r.id = a.parent_id) SELECT id FROM a`, [id])).rows.map(r => r.id as string);
  // the tree and the version chain of one's own note: a plan item changes the old versions too
  const rows = (await db.query(`${CHAIN_TREE}
    SELECT r.id, r.class, r.space_id, r.owner_id, r.audience, r.is_current, r.version, r.superseded_by_id,
      r.deleted_at, r.deleted_batch, r.purge_after, r.hidden_at,
      (SELECT md5(string_agg(person_id::text, ',' ORDER BY person_id)) FROM record_people WHERE record_id = r.id) AS people,
      (SELECT md5(string_agg(space_id::text, ',' ORDER BY space_id)) FROM record_placements WHERE record_id = r.id) AS placements
    FROM records r JOIN tree ON tree.id = r.id ORDER BY r.id`, [id])).rows; // Facts of the action's rights, not content output
  const space = (await app.db.control.query("SELECT slug, name, kind, archived_at FROM spaces WHERE id = $1 AND instance_id = $2", [rec.space_id, app.instanceId])).rows[0];
  if (!space) throw notFound();
  return { id, class: loc.class, space_id: rec.space_id, owner_id: rec.owner_id, type: rec.type, title: rec.title,
    parent_id: rec.parent_id, is_current: rec.is_current, source_kind: rec.source_kind, source_ref: rec.source_ref ?? null, ancestors, locks: [...new Set([...ancestors, ...rows.map(r => r.id as string)])],
    fingerprint: fingerprintOf(rows), derived: Math.max(0, rows.length - 1), slug: space.slug, archived: !!space.archived_at,
    actors: Array.isArray(rec.attrs?.actors) ? (rec.attrs.actors as unknown[]).map(String) : [],
    space_name: space.name, space_kind: space.kind, event_kind: rec.event_kind ?? null };
}

/** The space map with the archive for checking sources (one per map of live ones: building a plan is one query). */
const archivedMaps = new WeakMap<Map<string, SpaceAccess>, Promise<Map<string, SpaceAccess>>>();
function withArchived(app: App, caller: Caller, spaces: Map<string, SpaceAccess>): Promise<Map<string, SpaceAccess>> {
  let m = archivedMaps.get(spaces);
  if (!m) { m = readableSpaces(app, caller, { archived: true }); archivedMaps.set(spaces, m); }
  return m;
}

async function permission(app: App, caller: Caller, row: Candidate, op: PlanOp, spaces: Map<string, SpaceAccess>, target?: SpaceAccess): Promise<string | null> {
  const me = caller.person!.id;
  // returning one's own record to personal — from an archived space too (an exception to the archive rule); delete, close
  // and delete for good are allowed in the archive (the readers only narrow)
  const back = op === "promote" && target?.kind === "personal";
  if (row.archived && !(back && row.owner_id === me) && !["delete", "close", "purge"].includes(op)) return "archived";
  if (!row.is_current && op !== "purge") return "not_current";
  if (row.source_kind === "correction" && row.type === "note" && row.parent_id) return "derived";
  // a plan does not hide or delete the work profile and its copy for colleagues: to hide or delete a profile —
  // first remove the copy under the profile lock; a plan item holds record locks and the snapshot — waiting for the profile lock
  // there means a deadlock with a simultaneous profile write; the copy is never closed singly. Singly — memory_close / memory_delete
  if ((op === "close" || op === "delete") && isWorkProfileRow(row)) return "not_applicable";
  // a derivative is closed only together with its source record: the tree lives in one class base (owner.ts derivedAlone)
  if (op === "close" && row.parent_id && row.class === "open") return "derived";
  // bulk "show to agents": the author's own closed record that the one rule of bulk-open.ts accepts — the same SQL as
  // the count and the candidate list; under the item's locks at apply time it is evaluated again
  if (op === "open") {
    if (row.owner_id !== me) return "no_rights";
    if (row.class !== "closed") return "not_applicable";
    return bulkOpenDenied(app, caller, row.id, spaces);
  }
  if (row.owner_id !== caller.person!.id && spaces.get(row.space_id)?.role !== "owner") return "no_rights";
  // another's org record is moved, closed and deleted by the curator only in "Shared knowledge review"
  if (row.owner_id !== me && spaces.get(row.space_id)?.kind === "org" && op !== "purge") return "no_rights";
  if ((await app.db.control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [row.ancestors])).rowCount) return "in_progress";
  if (op === "promote" || op === "move_space") {
    if (!target) return "no_rights";
    // an employee card is filled by the directory — it is moved nowhere; the work profile — only in personal;
    // the "How we work" map — only in its own space
    if (isDirectoryCard(row) || isWorkProfileRow(row) || isSpaceGuideRow(row)) return "not_applicable";
    // no one carries another's record out of the organizational space, the org curator included
    if (spaces.get(row.space_id)?.kind === "org" && row.owner_id !== me) return "no_rights";
    if (target.id === row.space_id) return "same_space";
    if (target.kind === "personal" && (row.owner_id !== me || target.owner_id !== me)) return "no_rights";
    if (target.kind === "org") {
      if (row.owner_id !== caller.person!.id) return "no_rights";
      if (await neverOpenReason(app, { record_id: row.id, ...row, deleted: false, created_at: null, open_check: null }, target)) return "never_open";
    } else if (!canWrite(target)) return "no_rights";
    if (op === "move_space") {
      const from = spaces.get(row.space_id);
      if (!from || !canWrite(from) || !["team", "project"].includes(from.kind) || !["team", "project"].includes(target.kind)) return "no_rights";
    }
    if ((await app.db.control.query("SELECT 1 FROM spaces WHERE id = $1 AND archived_at IS NOT NULL", [target.id])).rowCount) return "archived";
    // an agent reading closed content does not move an open record without permission (one's own personal — without the gate)
    if (row.class === "open" && target.kind !== "personal" && openWriteMode(caller) === "denied") return "extended_open";
    // a plan does not move a retelling wider than its sources — the check as for an agent, without a journal event;
    // applying by a person in the workplace is a plan item too, not a confirmation (confirm_wider only in "Move").
    // Sources are read by the map with the archive, as in memory_promote: a source of an archived space where
    // the person is a participant is read by id — else the plan would refuse derived_wider where the move passes
    const db = app.db.records(row.class, caller.scope);
    const audience = row.owner_id === me ? "space" : (await db.query("SELECT audience FROM records WHERE id = $1", [row.id])).rows[0]?.audience ?? "space";
    try {
      await promoteDerivation(app, caller, { recordId: row.id, db, cls: row.class, target, audienceAfter: audience, viaPlan: true, spaces: await withArchived(app, caller, spaces), quiet: true });
    } catch (e) {
      if (isDerivationDenial(e)) return "derived_wider";
      if (e instanceof MemoryError && e.code === "in_progress") return "in_progress";
      throw e;
    }
  }
  return null;
}

/** The query filter — all lexemes, LIMIT by root records. No models are called while planning. */
async function expandCriteria(app: App, caller: Caller, op: PlanOp, f: Criteria, spaces: Map<string, SpaceAccess>): Promise<{ ids: string[]; safe: Facts }> {
  if (!f.space && !f.author && !f.entity && !f.query) throw problem("needs_narrowing", "Specify a space, entity, author or query");
  if (op === "purge" && Object.keys(f).some(k => !["space", "types"].includes(k))) throw problem("unsupported_op", "Trash can be filtered by space and record type");
  // a day is the whole day in memory's time zone: "until October 5" takes October 5 up to 23:59:59 in that zone, not up to 03:00;
  // a date-time — only with a zone: the bounds of a bulk action are not guessed
  const bounds: { from?: DateBound; to?: DateBound } = {}, tz = instanceTz(app.settings);
  for (const side of ["from", "to"] as const) {
    const date = f[side];
    if (!date) continue;
    const b = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date) ? parseDateBound(date, side, tz) : null;
    if (!b) throw invalid("Date: an existing date in YYYY-MM-DD format, or an ISO date and time with a time zone");
    bounds[side] = b;
  }
  if (bounds.from && bounds.to && reversedRange(bounds.from, bounds.to)) throw invalid("from cannot be later than to");
  const scope = f.space ? await resolveSpace(app, caller, f.space, spaces) : null;
  if (f.space && !scope) throw notFound();
  let author: string | null = null, entity: string | null = null;
  if (f.author) {
    if (f.author === "me") author = caller.person!.id;
    else {
      const p = (await app.db.control.query("SELECT id, COALESCE(attrs->>'demo','') = 'true' AS demo FROM people WHERE login = $1 AND instance_id = $2", [f.author.toLowerCase(), app.instanceId])).rows[0];
      if (!p || p.demo !== (caller.person!.demo === true)) throw notFound();
      author = p.id;
    }
  }
  if (f.entity) {
    const key = parseEntityKey(f.entity);
    if (!key) throw invalid("Unrecognized entity key");
    entity = await entityUuid(app, key);
    if (!entity || !await entityReadableById(app, caller, entity)) throw notFound();
  }
  const safe: Facts = { ...(scope ? { space_id: scope.id } : {}), ...(author ? { author_id: author } : {}), ...(entity ? { entity_id: entity } : {}),
    ...(f.types ? { types: f.types } : {}), ...(f.event_kinds ? { event_kinds: f.event_kinds } : {}), ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}), ...(f.domains ? { domains: f.domains } : {}), has_query: !!f.query };
  const max = maximum(app), ids: string[] = [];
  if (op === "purge") {
    const owned = [...spaces.values()].filter(s => s.role === "owner").map(s => s.id);
    const args: unknown[] = [app.instanceId, caller.person!.id, owned, caller.scope.classes], b = binder(args);
    const where = ["s.instance_id = $1", "l.deleted AND l.deleted_batch = l.record_id AND l.purge_after > now()", "(l.owner_id = $2 OR l.space_id = ANY($3::uuid[]))", "l.class = ANY($4::text[])"];
    if (caller.keyKind === "extended") where.push("(l.class = 'open' OR l.owner_id = $2)"); // vis-ok: trash rights and class gate
    if (scope) where.push(`l.space_id = ${b(scope.id)}`);
    if (f.types?.length) where.push(`l.type = ANY(${b(f.types)}::text[])`);
    return { ids: (await app.db.control.query(`SELECT l.record_id FROM record_locations l JOIN spaces s ON s.id=l.space_id WHERE ${where.join(" AND ")} ORDER BY l.record_id LIMIT ${b(max + 1)}`, args)).rows.map(r => r.record_id), safe };
  }
  const { spec } = await visibilityFor(app, caller, { spaces, scope: scope ? [scope.id] : null });
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], b = binder(args), vis = visibleSql(spec, cls, b);
    if (!vis) continue;
    // the org records held as "Wrong / not for everyone" and their derivatives are not found by agents in any mode
    // — in plan selection too: else plan counters, by trying words, would reveal what a held record holds
    const held = await heldIds(app, caller, cls);
    const where = [vis, "r.parent_id IS NULL"];
    if (held.length) where.push(`r.id <> ALL(${b(held)}::uuid[])`);
    if (f.types?.length) where.push(`r.type = ANY(${b(f.types)}::record_type[])`);
    if (f.event_kinds?.length) where.push(`r.event_kind = ANY(${b(f.event_kinds)}::event_kind[])`);
    if (author) where.push(`r.owner_id = ${b(author)}`);
    if (entity) where.push(`EXISTS (SELECT 1 FROM record_entities re WHERE re.record_id=r.id AND re.entity_id=${b(entity)})`);
    if (bounds.from) where.push(`r.occurred_at >= ${b(bounds.from.at.toISOString())}::timestamptz`);
    if (bounds.to) where.push(`r.occurred_at ${upperBoundOp(bounds.to)} ${b(bounds.to.at.toISOString())}::timestamptz`);
    if (f.domains?.length) where.push(`r.domain_tags && ${b(f.domains)}::text[]`);
    if (f.query) {
      // the words are matched in the full-text configurations of this database (retrieval_config) and as written (simple)
      const query = b(f.query), childVis = visibleSql(spec, cls, b, "d");
      const childHeld = held.length ? ` AND d.id <> ALL(${b(held)}::uuid[])` : "";
      where.push(`EXISTS (WITH RECURSIVE branch AS (SELECT r.id UNION SELECT ch.id FROM records_live ch JOIN branch p ON ch.parent_id=p.id)
        SELECT 1 FROM branch JOIN records_live d ON d.id=branch.id LEFT JOIN record_content c ON c.record_id=d.id
        WHERE ${childVis}${childHeld} AND ${criteriaWordsSql("COALESCE(d.title,'') || ' ' || COALESCE(c.text,'')", query)})`);
    }
    const rows = (await app.db.records(cls, caller.scope).query(`SELECT r.id FROM records_live r WHERE ${where.join(" AND ")} ORDER BY r.occurred_at DESC,r.id LIMIT ${b(max + 1)}`, args)).rows;
    ids.push(...rows.map(r => r.id as string));
    if (ids.length > max) break;
  }
  return { ids, safe };
}

async function shownAudit(app: App, caller: Caller, rows: { id: string; class: DataClass }[], op: string) {
  for (const cls of ["open", "closed"] as const) {
    const ids = rows.filter(r => r.class === cls).map(r => r.id);
    if (!ids.length) continue;
    await auditRead(app, caller, { event_type: "list", class: cls, record_ids: ids, details: { op } });
    if (cls === "closed" && caller.keyKind === "extended") await audit(app, caller, { event_type: "extended_key_use", class: cls, record_ids: ids, details: { op } }, { strict: true }); // vis-ok: the key type decides an extra audit event, not record visibility
  }
}
async function usedByAgent(app: App, who: string, minutes: number, q: Pick<pg.Pool, "query"> = app.db.control): Promise<number> {
  const row = (await q.query(`SELECT count(*)::int AS n FROM action_plan_items i JOIN action_plans p ON p.id=i.plan_id
    WHERE p.person_id=$1 AND p.instance_id=$2 AND i.status='done' AND i.done_at > now()-make_interval(mins=>$3::int)
      AND i.applied_via='mcp'`, [who, app.instanceId, minutes])).rows[0];
  return row?.n ?? 0;
}

/** `planTool` as other modules import it: a refusal over a foreign or missing space, person, entity or meeting leaves a trace (denied-audit.ts). */
async function planTraced(app: App, caller: Caller, a: PlanArgs, o: { fromAgentView?: boolean; criteria?: Facts } = {}): ReturnType<typeof planTool> {
  return traceDenied(app, caller, "memory_plan", () => planTool(app, caller, a, o));
}
export { planTraced as planTool };

/**
 * `o.fromAgentView` — only the route POST /api/v1/me/agent-view/open-plan sets it: op `open` is refused to every other
 * caller, a key and a session without the option alike, before any database read (the MCP schema is not the only lock).
 * `o.criteria` — what the route selected by ({space_id?, types?}), stored with the plan instead of the ids' origin.
 */
async function planTool(app: App, caller: Caller, a: PlanArgs, o: { fromAgentView?: boolean; criteria?: Facts } = {}) {
  const who = person(caller), op = a.op;
  const allowed = op === "open" ? o.fromAgentView === true && isHumanSession(caller) && !isExternal(caller) : OPS.includes(op);
  if (!allowed) throw problem("unsupported_op", "Change plans do not support this operation");
  if (op === "open" && (!a.ids || a.criteria || a.to_space || a.correct)) throw invalid(bulkOpenText("ids_only"));
  // correct — only for correct_bulk and only it (instead of ids and criteria); other fields it does not need
  if ((op === "correct_bulk") !== !!a.correct) throw invalid(op === "correct_bulk" ? "correct_bulk requires correct: meeting_id and actors_map" : "Use correct only with op correct_bulk");
  if (op === "correct_bulk") {
    if (a.ids || a.criteria || a.to_space) throw invalid("For correct_bulk, provide only correct. Omit ids, criteria and to_space");
    return correctBulk(app, caller, who, a.correct!);
  }
  if (!!a.ids === !!a.criteria) throw invalid("Specify exactly one of these: ids or criteria");
  if (a.ids && (!a.ids.length || new Set(a.ids).size !== a.ids.length)) throw invalid("ids: a non-empty list with no duplicates");
  const max = maximum(app), spaces = await readableSpaces(app, caller);
  const target = a.to_space ? await resolveSpace(app, caller, a.to_space, spaces) : null;
  if (["promote", "move_space"].includes(op) && !target) throw notFound();
  const expanded = a.ids ? { ids: a.ids, safe: (op === "open" ? o.criteria : undefined) ?? {} } : await expandCriteria(app, caller, op, a.criteria!, spaces);
  if (expanded.ids.length > max) throw problem("too_many_items", `More than ${max} records match. Narrow the criteria`, { found_more_than: max });
  const skipped = new Map<string, number>(), skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const eligible: Candidate[] = [];
  for (const id of expanded.ids) {
    try {
      const row = await itemFacts(app, caller, id, op, spaces), reason = await permission(app, caller, row, op, spaces, target ?? undefined);
      if (reason) skip(reason); else eligible.push(row);
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      if (e.code === "not_found") skip("not_found"); else if (e.code === "in_progress") skip("in_progress"); else throw e;
    }
  }
  const selected = new Set(eligible.map(r => r.id));
  const rows = eligible.filter(r => { if (r.ancestors.some(id => id !== r.id && selected.has(id))) { skip("derived"); return false; } return true; });
  const totals = { items: rows.length, cascade: rows.reduce((n, r) => n + r.derived, 0), spaces: new Set(rows.map(r => r.space_id)).size };
  const base = { op, items: rows.slice(0, 20).map(r => ({ id: r.id, title: r.title?.slice(0, 300) ?? null, type: r.type, space: r.slug, class: r.class,
    effect: effectText(op, { kind: op, derived: r.derived, trash_days: trashDays(app) }, target?.slug, target?.kind) })), items_truncated: rows.length > 20, skipped: [...skipped].map(([reason, count]) => ({ reason, count })), totals };
  if (!rows.length) return { result: { ...base, status: "empty" as const }, text: "No matching records can be changed with your permissions. Nothing changed." };
  await shownAudit(app, caller, rows.slice(0, 20), "plan_view");
  const id = newId(), minutes = ttl(app), used = await usedByAgent(app, who, minutes), via = applyVia(caller, op, rows.length, totals.spaces, threshold(app), used, { target, confirm: promoteConfirmationOn(app) });
  const expires = new Date(Date.now() + minutes * 60_000);
  await tx(app.db.control, async q => {
    await q.query(`INSERT INTO action_plans (id,instance_id,person_id,key_id,created_via,op,params,apply_via,apply_reason,items_total,spaces_total,cascade_total,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, app.instanceId, who, caller.keyId, caller.keyKind === "session" ? "workplace" : "mcp", op,
      JSON.stringify({ ...(target ? { to_space_id: target.id } : {}), criteria: expanded.safe }), via.via, via.reason, rows.length, totals.spaces, totals.cascade, expires]);
    for (const [ord, r] of rows.entries()) await q.query(`INSERT INTO action_plan_items (plan_id,ord,record_id,class,space_id,fingerprint,effect) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, ord, r.id, r.class, r.space_id, r.fingerprint, JSON.stringify({ kind: op, derived: r.derived, ...(op === "delete" ? { trash_days: trashDays(app) } : {}) })]);
  });
  await audit(app, caller, { event_type: "write", details: { op: "plan", plan_id: id, plan_op: op, items: rows.length, skipped: Object.fromEntries(skipped), apply_via: via.via, apply_reason: via.reason, criteria: expanded.safe } });
  const result = { ...base, plan_id: id, status: "pending" as const, expires_at: expires.toISOString(), apply_via: via.via, apply_reason: via.reason, workplace_url: workplaceUrl(app, `/plans/${id}`) };
  return { result, text: planText({ label: LABELS[op], count: rows.length, noun: rows.length === 1 ? "record" : "records", via: via.via, planId: id, workplaceUrl: result.workplace_url, expiresAt: result.expires_at,
                                    items: base.items, truncated: base.items_truncated }, textsOf(app)) };
}

/**
 * An agent's move that needs a person: a one-item plan `promote` / `move_space` that only a person applies in the
 * workplace (`apply_via: workplace`, `apply_reason: workplace_only_op`, `params.confirmation: agent_request`; the term —
 * access.promote_confirmation_ttl_hours). promote() calls it after its own checks of rights and before any side effect.
 * The item is built as for memory_plan: a caller that cannot own a plan, a record the caller cannot read (a space owner
 * moving a meeting without him, a closed record of a cloud key) or an item the plan mechanism would skip now get the
 * refusal human_confirmation_required — the person moves it from the record page. Under one lock per person: a pending
 * request for the same record and target is returned as it is (no new event); one whose record changed since is cancelled
 * and replaced; while the person applies a plan of the record, or once the record has moved since its facts were read, the
 * answer is in_progress (no second request); at most CONFIRMATION_PENDING_MAX requests wait. The journal gets the event
 * every plan writes (`write {op: plan, confirmation: agent_request}`), not `promote`: nothing has moved, and the reports count `promote`
 * events as moves. No top-level record_ids, no title: the event names ids only.
 */
export async function confirmationPlan(app: App, caller: Caller, a: { id: string; target: SpaceAccess; op: "promote" | "move_space" }): Promise<{ planId: string; expiresAt: string; created: boolean }> {
  const refuse = () => humanConfirmationRequired(app, `/records/${a.id}`, "Record");
  if (!canOwnConfirmation(caller)) throw refuse();
  const who = caller.person!.id, spaces = await readableSpaces(app, caller);
  let row: Candidate;
  try { row = await itemFacts(app, caller, a.id, a.op, spaces); }
  catch (e) { if (e instanceof MemoryError && e.code === "not_found") throw refuse(); throw e; }
  const reason = await permission(app, caller, row, a.op, spaces, a.target);
  if (reason === "in_progress") throw inProgress(10);
  if (reason) throw refuse();
  await cancelPlannedRows(app, caller, { planIds: await settleOwnPlans(app, who) });
  const hours = confirmTtlHours(app);
  const out = await tx(app.db.control, async q => {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`promote-confirmation:${who}`]);
    // the person is applying a plan of this record, or the record moved after the facts above were read (an apply that has
    // just finished): no second request for it — in_progress, the agent's repeat then sees the move. A plan
    // counts as being applied only inside its apply term (started_at + the plan's term, as applyTool counts it) or while an
    // apply of it really runs (its session lock `plan:<id>` is held — read from pg_locks, not taken): an apply the person
    // abandoned past its term would otherwise block the agent's request for ever (final); its pending items are
    // skipped `expired` by the next apply anyway
    const busy = (await q.query(`SELECT 1 FROM action_plans p JOIN action_plan_items i ON i.plan_id = p.id
      WHERE p.instance_id=$1 AND p.person_id=$2 AND p.status='applying' AND i.record_id=$3 AND i.status='pending'
        AND (p.started_at IS NULL OR p.started_at + (p.expires_at - p.created_at) > now()
             OR EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.objsubid=1 AND l.granted
                          AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
                          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('plan:' || p.id::text, 0)))
      LIMIT 1`, [app.instanceId, who, a.id])).rowCount;
    const here = (await q.query("SELECT space_id FROM record_locations WHERE record_id=$1", [a.id])).rows[0]?.space_id as string | undefined;
    if (busy || (here && here !== row.space_id)) throw inProgress(10);
    const same = (await q.query(`SELECT p.id, p.expires_at, i.fingerprint FROM action_plans p JOIN action_plan_items i ON i.plan_id = p.id
      WHERE p.instance_id=$1 AND p.person_id=$2 AND p.status='pending' AND p.expires_at>now() AND p.params->>'confirmation'='agent_request'
        AND p.op=$3 AND p.params->>'to_space_id'=$4 AND i.record_id=$5 AND i.status='pending' ORDER BY p.created_at DESC LIMIT 1`,
      [app.instanceId, who, a.op, a.target.id, a.id])).rows[0];
    if (same && same.fingerprint === row.fingerprint) return { planId: same.id as string, expiresAt: iso(same.expires_at)!, created: false, replaces: null };
    if (same) await q.query("UPDATE action_plans SET status='cancelled' WHERE id=$1 AND status='pending'", [same.id]);
    const waiting = (await q.query(`SELECT count(*)::int AS n FROM action_plans WHERE instance_id=$1 AND person_id=$2 AND status='pending'
      AND expires_at>now() AND params ? 'confirmation'`, [app.instanceId, who])).rows[0]?.n ?? 0;
    if (waiting >= CONFIRMATION_PENDING_MAX)
      throw new MemoryError("rate_limited", `${CONFIRMATION_PENDING_MAX} moves already wait for the person's confirmation in the workplace. Ask the person to apply or cancel them first.`,
        { retry_after: 600, details: { reason: "confirmation_pending_limit", workplace_url: workplaceUrl(app, "/plans") } });
    const id = newId(), expires = new Date(Date.now() + hours * 3_600_000);
    await q.query(`INSERT INTO action_plans (id,instance_id,person_id,key_id,created_via,op,params,apply_via,apply_reason,items_total,spaces_total,cascade_total,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, app.instanceId, who, caller.keyId, caller.keyKind === "session" ? "workplace" : "mcp", a.op,
      JSON.stringify({ to_space_id: a.target.id, confirmation: "agent_request", criteria: {} }), "workplace", "workplace_only_op", 1, 1, row.derived, expires]);
    await q.query(`INSERT INTO action_plan_items (plan_id,ord,record_id,class,space_id,fingerprint,effect) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, 0, row.id, row.class, row.space_id, row.fingerprint, JSON.stringify({ kind: a.op, derived: row.derived })]);
    return { planId: id, expiresAt: expires.toISOString(), created: true, replaces: same ? same.id as string : null };
  });
  if (out.created) await audit(app, caller, { event_type: "write", details: { op: "plan", plan_id: out.planId, plan_op: a.op, items: 1, skipped: {}, apply_via: "workplace",
    apply_reason: "workplace_only_op", confirmation: "agent_request", record_id: a.id, to_space_id: a.target.id, criteria: {}, ...(out.replaces ? { replaces: out.replaces } : {}) } });
  return { planId: out.planId, expiresAt: out.expiresAt, created: out.created };
}

interface Corrected { row: Candidate; role: CorrectionRole; fields: { actors: string[] }; matched: string; targetFp: string }

/**
 * "Replace the assignee in all events of one meeting". It is built by a person who reads the meeting
 * (correctionCaller, origin human: a script — origin_not_allowed; the preview, the system, a service w/o correct — forbidden).
 * The events are the meeting's current children visible to the caller; each passes the same gate as memory_correct
 * extraction_error at building time. The new assignee lists are `planned` drafts in the meeting's class base (the person's
 * words — only there, under the meeting lock with the class reread); in control — only ids. Only a session applies it.
 * A draft is already a write of words into the meeting's class base, so an open meeting gets the
 * memory_correct gate (attempt correct) at building: an agent reading closed content without admin permission — the item
 * is skipped with `extended_open` (as a move in plans), no insert. A workplace session is not under the gate.
 */
async function correctBulk(app: App, caller: Caller, me: string, c: CorrectBulk) {
  const human = correctionCaller(caller, "human");
  const from = c.actors_map?.from, to = c.actors_map?.to;
  if (typeof c.meeting_id !== "string" || typeof from !== "string" || typeof to !== "string" || !from.trim() || !to.trim() || [...from].length > 120 || [...to].length > 120)
    throw invalid("correct: include meeting_id and actors_map with “from” and “to” assignees, each 1 to 120 characters long");
  const max = maximum(app), spaces = await readableSpaces(app, caller);
  const meeting = await targetOf(app, caller, c.meeting_id, spaces);
  if (meeting.rec.type !== "transcript") throw problem("kind_not_applicable", "To replace the assignee in all events, specify the meeting itself. You cannot do this on an individual event");
  if (pipelineText.normalize(from) === pipelineText.normalize(to)) throw invalid("“From” and “to” assignees are the same");
  if (meeting.space.archived) throw archivedDenied(meeting.space.slug, meeting.space.archived_at);   // a single archive refusal
  const moving = async (ids: string[]) => !!(await app.db.control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [ids])).rowCount;
  if (await moving(meeting.lockIds)) throw new MemoryError("in_progress", "The meeting is moving between classes. Try again in a minute", { retry_after: 10 });
  const cls = meeting.rec.class;
  const { spec } = await visibilityFor(app, caller, { spaces, scope: [meeting.space.id] });
  const args: unknown[] = [], b = binder(args), vis = visibleSql(spec, cls, b);
  const ids = vis ? (await app.db.records(cls, caller.scope).query(
    `SELECT r.id FROM records_live r WHERE ${vis} AND r.parent_id = ${b(meeting.rec.id)} AND r.type = 'event' AND r.is_current ORDER BY r.occurred_at, r.id LIMIT ${b(max + 1)}`, args)).rows.map(r => r.id as string) : [];
  if (ids.length > max) throw problem("too_many_items", `The meeting has more than ${max} events, which is too many for one change plan`, { found_more_than: max });
  const skipped = new Map<string, number>(), skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  // the gate — once per space of open events: one refusal event in the journal per building, not per
  // meeting event (up to 500); the id in the event is the meeting one tried to correct
  const gates = new Map<string, Promise<boolean>>();
  const deniedIn = (t: Target): Promise<boolean> => {
    let g = gates.get(t.space.id);
    if (!g) {
      g = extendedOpenGate(app, caller, { attempt: "correct", space: { id: t.space.id, slug: t.space.slug }, recordId: meeting.rec.id })
        .then(() => false, (e: unknown) => { if (isExtendedOpenDenial(e)) return true; throw e; });
      gates.set(t.space.id, g);
    }
    return g;
  };
  const rows: Corrected[] = [];
  for (const id of ids) {
    try {
      const t = await targetOf(app, caller, id, spaces);
      if (t.space.archived) { skip("archived"); continue; }
      const actors = Array.isArray(t.rec.attrs?.actors) ? (t.rec.attrs.actors as unknown[]).map(String) : [];
      const swap = kindApplicable("extraction_error", { type: t.rec.type, source_kind: t.rec.source_kind, parent_type: t.parentType }) ? replaceActor(actors, from, to) : null;
      if (!swap) { skip("not_applicable"); continue; }
      if (await moving(t.lockIds)) { skip("in_progress"); continue; }
      const role = correctionRole({ me, ownerId: t.rec.owner_id, spaceRole: t.space.role, participant: t.participant });
      try { decideStatus("extraction_error", role, "human", nonParticipant(app)); } catch (e) { if (e instanceof MemoryError && e.code === "forbidden") { skip("no_rights"); continue; } throw e; }
      // the order as in memory_correct: right → class → gate (the open check — at applying)
      if (t.rec.class === "open" && await deniedIn(t)) { skip("extended_open"); continue; }
      const row = await itemFacts(app, caller, id, "correct_bulk", spaces);
      rows.push({ row, role, fields: canonicalFields({ actors: swap.next }) as { actors: string[] }, matched: swap.matched, targetFp: await targetFingerprint(app.db.records(cls, caller.scope), id) });
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      if (e.code === "not_found") skip("not_found"); else if (e.code === "in_progress") skip("in_progress"); else throw e;
    }
  }
  // drafts of my finished correct_bulk plans go out (a repeat after expiry does not hit the old ones)
  await cancelPlannedRows(app, caller, { planIds: await finishedCorrectBulkPlans(app, me) });
  // as written in the event (a name from the model may be long — the effect output is at most 300 signs)
  const effect = (r: Corrected) => `Assignee “${[...r.matched].slice(0, 120).join("")}” → “${to.trim()}”`;
  const totals = { items: rows.length, cascade: 0, spaces: rows.length ? 1 : 0 };
  const base = { op: "correct_bulk" as const, items: rows.slice(0, 20).map(r => ({ id: r.row.id, title: r.row.title?.slice(0, 300) ?? null, type: r.row.type, space: r.row.slug, class: r.row.class, effect: effect(r) })),
    items_truncated: rows.length > 20, skipped: [...skipped].map(([reason, count]) => ({ reason, count })), totals };
  if (!rows.length) return { result: { ...base, status: "empty" as const }, text: skipped.has("extended_open")
    ? `This meeting’s events are open. This key can read a person’s closed records, but can only write to open spaces if the memory administrator grants permission in the key settings. No plan was created and nothing changed. A person can replace the assignee in the workspace: ${workplaceWhere(app, `/records/${meeting.rec.id}`, "Record")}`
    : "There are no meeting events with this assignee that you can correct. Nothing changed." };
  await shownAudit(app, caller, rows.slice(0, 20).map(r => r.row), "plan_view");
  const id = newId(), minutes = ttl(app), via = applyVia(caller, "correct_bulk", rows.length, 1, threshold(app));
  const expires = new Date(Date.now() + minutes * 60_000);
  const planned = rows.map(r => ({ ...r, correctionId: newId() }));
  // under the lock of the meeting and its ancestors (as propose): the class is reread — drafts land where the meeting is now
  await withOwnerLocks(app, meeting.lockIds, async q => {
    const loc = (await q.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [meeting.rec.id])).rows[0];
    if (!loc || loc.deleted || loc.class !== cls) throw new MemoryError("in_progress", "The meeting is moving between classes. Try again in a minute", { retry_after: 10 });
    await tx(app.db.recordsForWrite(cls, caller.scope), async t => {
      for (const r of planned) await t.query(
        `INSERT INTO record_corrections (id, target_id, kind, status, origin, via, by_person, by_role, key_id, fields, target_fp, dedupe, plan_id)
         VALUES ($1,$2,'extraction_error','planned','human','plan',$3,$4,$5,$6,$7,$8,$9)`,
        [r.correctionId, r.row.id, me, r.role, human.keyId, JSON.stringify(r.fields), r.targetFp,
         dedupeOf({ target: r.row.id, kind: "extraction_error", by: me, text: null, fields: r.fields, quote: null, newer: null }), id]);
    });
  });
  try {
    await tx(app.db.control, async q => {
      await q.query(`INSERT INTO action_plans (id,instance_id,person_id,key_id,created_via,op,params,apply_via,apply_reason,items_total,spaces_total,cascade_total,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, app.instanceId, me, caller.keyId, caller.keyKind === "session" ? "workplace" : "mcp", "correct_bulk",
        JSON.stringify({ meeting_id: meeting.rec.id }), via.via, via.reason, planned.length, 1, 0, expires]);
      for (const [ord, r] of planned.entries()) await q.query(`INSERT INTO action_plan_items (plan_id,ord,record_id,class,space_id,fingerprint,effect) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, ord, r.row.id, r.row.class, r.row.space_id, r.row.fingerprint, JSON.stringify({ kind: "correct", derived: 0, correction_id: r.correctionId })]);
    });
  } catch (e) {
    // no plan — the drafts go out at once (else maintenance puts them out after a day)
    await cancelPlannedRows(app, caller, { planIds: [id] });
    throw e;
  }
  await audit(app, caller, { event_type: "write", details: { op: "plan", plan_id: id, plan_op: "correct_bulk", items: planned.length, skipped: Object.fromEntries(skipped), apply_via: via.via,
                                                             apply_reason: via.reason, criteria: { meeting_id: meeting.rec.id } } });
  const result = { ...base, plan_id: id, status: "pending" as const, expires_at: expires.toISOString(), apply_via: via.via, apply_reason: via.reason, workplace_url: workplaceUrl(app, `/plans/${id}`) };
  return { result, text: planText({ label: LABELS.correct_bulk, count: planned.length, noun: "events", via: via.via, planId: id, workplaceUrl: result.workplace_url, expiresAt: result.expires_at,
                                    items: base.items, truncated: base.items_truncated }, textsOf(app)) };
}

/** Own pending plans: expired → expired, by a revoked or expired key → cancelled (as the plan list). Returns the affected correct_bulk ones. */
async function settleOwnPlans(app: App, who: string): Promise<string[]> {
  const expired = await app.db.control.query("UPDATE action_plans SET status='expired' WHERE person_id=$1 AND instance_id=$2 AND status='pending' AND expires_at<=now() RETURNING id, op", [who, app.instanceId]);
  const revoked = await app.db.control.query("UPDATE action_plans p SET status='cancelled' FROM api_keys k WHERE p.key_id=k.id AND (k.revoked_at IS NOT NULL OR k.expires_at<=now()) AND p.person_id=$1 AND p.instance_id=$2 AND p.status='pending' RETURNING p.id, p.op", [who, app.instanceId]);
  return [...(expired.rows ?? []), ...(revoked.rows ?? [])].filter(r => r.op === "correct_bulk").map(r => r.id as string);
}
/** My correct_bulk plans in a final status (after moving the expired and revoked ones). Drafts without a plan row do not count. */
export async function finishedCorrectBulkPlans(app: App, who: string): Promise<string[]> {
  await settleOwnPlans(app, who);
  return (await app.db.control.query("SELECT id FROM action_plans WHERE person_id=$1 AND instance_id=$2 AND op='correct_bulk' AND status = ANY($3::text[])", [who, app.instanceId, FINAL])).rows.map(r => r.id as string);
}
/** Key revocation (rest DELETE /me/keys/:id): the key's pending plans are cancelled, correct_bulk drafts go out at once. */
export async function cancelPlansOfKey(app: App, caller: Caller, keyId: string): Promise<void> {
  const rows = (await app.db.control.query("UPDATE action_plans SET status='cancelled' WHERE key_id=$1 AND status='pending' RETURNING id, op", [keyId])).rows;
  await cancelPlannedRows(app, caller, { planIds: rows.filter(r => r.op === "correct_bulk").map(r => r.id as string) });
}

async function ownedPlan(app: App, caller: Caller, id: string): Promise<PlanRow> {
  const who = person(caller);
  const p = (await app.db.control.query<PlanRow>("SELECT * FROM action_plans WHERE id=$1 AND person_id=$2 AND instance_id=$3", [id, who, app.instanceId])).rows[0];
  if (!p) throw notFound();
  if (p.status === "pending") {
    const revoked = p.created_via === "mcp" && (await app.db.control.query("SELECT 1 FROM api_keys WHERE id=$1 AND (revoked_at IS NOT NULL OR expires_at<=now())", [p.key_id])).rowCount;
    if (revoked || new Date(p.expires_at).getTime() <= Date.now()) {
      p.status = revoked ? "cancelled" : "expired";
      await app.db.control.query("UPDATE action_plans SET status=$2 WHERE id=$1 AND status='pending'", [id, p.status]);
      if (p.op === "correct_bulk") await cancelPlannedRows(app, caller, { planIds: [id] });
    }
  }
  return p;
}
async function withPlanLock<T>(app: App, id: string, fn: (q: pg.PoolClient, alive: () => Promise<void>) => Promise<T>): Promise<T> {
  const q = await app.db.control.connect(); let locked = false, clean = false;
  let watch: ReturnType<typeof watchLock> | undefined;
  try {
    locked = !!(await q.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [`plan:${id}`])).rows[0]?.ok;
    if (!locked) throw inProgress();
    watch = watchLock(q);
    const result = await fn(q, watch.alive);
    if (watch.lost()) throw new LockConnectionLost();
    return result;
  } finally {
    try {
      if (!locked) clean = true;
      else if (!watch?.lost()) await q.query("SELECT pg_advisory_unlock_all()").then(() => { clean = true; }, () => undefined);
    } finally {
      if (watch?.lost()) clean = false;
      watch?.done();
      q.release(!clean);
    }
  }
}
/** proposed — correct_bulk items that became a proposal (done with effect.status = proposed); 0 for other operations. */
async function counts(app: App, id: string): Promise<{ pending: number; excluded: number; done: number; skipped: number; proposed: number }> {
  const out = { pending: 0, excluded: 0, done: 0, skipped: 0, proposed: 0 };
  for (const r of (await app.db.control.query("SELECT status,count(*)::int AS n,(count(*) FILTER (WHERE status='done' AND effect->>'status'='proposed'))::int AS proposed FROM action_plan_items WHERE plan_id=$1 GROUP BY status", [id])).rows) {
    out[r.status as "pending" | "excluded" | "done" | "skipped"] = r.n;
    out.proposed += r.proposed ?? 0;
  }
  return out;
}
async function resultOf(app: App, p: PlanRow): Promise<ApplyResult> {
  const c = await counts(app, p.id), items = (await app.db.control.query("SELECT record_id AS id,status AS outcome,reason,effect->>'status' AS status FROM action_plan_items WHERE plan_id=$1 AND status<>'pending' ORDER BY ord LIMIT 50", [p.id])).rows
    .map(r => ({ id: r.id, outcome: r.outcome, reason: r.reason, status: r.status ?? null })) as ApplyResult["items"];
  return { plan_id: p.id, status: c.pending ? "applying" : c.skipped ? "partially_applied" : "applied", done: c.done, skipped: c.skipped, excluded: c.excluded, remaining: c.pending, items, trash_url: p.op === "delete" ? workplaceUrl(app, "/trash") : null };
}

/** The time limit of a started plan (as long as it had between creation and expiry, counted from the start) has passed. */
function pastDeadline(p: PlanRow): boolean {
  const deadline = p.started_at && new Date(p.started_at).getTime() + (new Date(p.expires_at).getTime() - new Date(p.created_at).getTime());
  return !!deadline && Date.now() > deadline;
}
/** The refusal of bulk "show to agents" while it or the open check is switched off (settings as they are in `app` now). */
function bulkOpenOff(app: App): MemoryError | null {
  const st = bulkOpenState(app);
  return st.reason ? new MemoryError("forbidden", bulkOpenText(st.reason === "bulk_open_disabled" ? "disabled" : "check_disabled"), { details: { reason: st.reason } }) : null;
}
const isBulkOpenOff = (e: MemoryError): boolean => e.code === "forbidden" && ["bulk_open_disabled", "open_check_disabled"].includes(String((e.extra.details as Record<string, unknown> | undefined)?.reason));

/**
 * `applyTool` as other modules import it: a refusal — foreign or missing plan, expired, cancelled, workplace only —
 * leaves a trace (denied-audit.ts) that names the plan only when it is the caller's own. The body keeps the name `applyTool`
 * in this module (extended-open-static reads it).
 */
async function applyTraced(app: App, caller: Caller, a: { plan_id: string; exclude_ids?: string[] }): ReturnType<typeof applyTool> {
  return traceDenied(app, caller, "memory_apply", () => applyTool(app, caller, a), { planId: a.plan_id });
}
export { applyTraced as applyTool };

async function applyTool(app: App, caller: Caller, a: { plan_id: string; exclude_ids?: string[] }) {
  person(caller);
  if (caller.preview || caller.clientKind === "script") throw workplaceOnly(app, a.plan_id);
  await ownedPlan(app, caller, a.plan_id); // another's plan is always not_found, also while its lock is taken
  const result = await withPlanLock(app, a.plan_id, async q => {
    app = withControlConnection(app, q);
    const p = await ownedPlan(app, caller, a.plan_id);
    // bulk "show to agents": a person in the workspace only, and only while bulk open and the open check are on —
    // read fresh, not from the gateway's cache (another writer may have switched them off). The plan and its items stay
    // untouched: a plan not started expires by its time limit, a started one may be cancelled (cancelPlan) and past its
    // time limit this call closes it — the rest is skipped as expired below, nothing is opened
    if (p.op === "open") {
      if (!isHumanSession(caller)) throw workplaceOnly(app, p.id);
      await app.settings.load(true).catch(() => undefined);
      const off = bulkOpenOff(app);
      if (off && !(p.status === "applying" && pastDeadline(p))) throw off;
    }
    if (caller.keyKind !== "session" && p.apply_via === "workplace") throw workplaceOnly(app, p.id);
    if (p.status === "cancelled") throw problem("plan_cancelled", "Plan cancelled");
    if (p.status === "expired") throw problem("plan_expired", "The plan expired. Create a new one");
    if (p.result && ["applied", "partially_applied"].includes(p.status)) return p.result;
    let personLocked = false;
    try {
      if (caller.keyKind !== "session") {
        personLocked = !!(await q.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [`plan-person:${p.person_id}`])).rows[0]?.ok;
        if (!personLocked) throw inProgress();

      }
      if (a.exclude_ids?.length) {
        // the plan lock is a session lock, not a transaction: removals are fixed at once; a refusal below (limit, threshold,
        // busy) breaks the call. A repeat with the same list finds the removed items and continues the plan, not an error
        const found = (await q.query("SELECT record_id FROM action_plan_items WHERE plan_id=$1 AND status IN ('pending','excluded') AND record_id=ANY($2::uuid[])", [p.id, a.exclude_ids])).rows;
        if (found.length !== new Set(a.exclude_ids).size) throw problem("exclude_not_in_plan", "You can only exclude pending changes in this plan");
        await q.query("UPDATE action_plan_items SET status='excluded' WHERE plan_id=$1 AND record_id=ANY($2::uuid[]) AND status='pending'", [p.id, a.exclude_ids]);
      }
      if (caller.keyKind !== "session") {
        const pending = (await counts(app, p.id)).pending;
        if (await usedByAgent(app, p.person_id, ttl(app), q) + pending > threshold(app)) {
          await q.query("UPDATE action_plans SET apply_via='workplace',apply_reason='over_threshold' WHERE id=$1", [p.id]);
          throw workplaceOnly(app, p.id);
        }
      }
      if (pastDeadline(p)) await q.query("UPDATE action_plan_items SET status='skipped',reason='expired',done_at=now() WHERE plan_id=$1 AND status='pending'", [p.id]);
      const chunk = Math.max(1, Math.min(50, app.limiter.snapshot(caller, ["memory_apply"]).memory_apply!.limit));
      const items = (await q.query<ItemRow>("SELECT * FROM action_plan_items WHERE plan_id=$1 AND status='pending' ORDER BY ord LIMIT $2", [p.id, chunk])).rows;
      if (items.length) app.limiter.check(caller, "memory_apply", items.length);
      if (p.status === "pending") {
        // Key revocation and expiry can happen after ownedPlan. The start does not overwrite their final status.
        const started = await q.query("UPDATE action_plans SET status='applying',started_at=COALESCE(started_at,now()) WHERE id=$1 AND status='pending' AND expires_at>now() AND (created_via='workplace' OR NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id=action_plans.key_id AND (k.revoked_at IS NOT NULL OR k.expires_at<=now()))) RETURNING started_at", [p.id]);
        if (!started.rowCount) {
          const latest = await ownedPlan(app, caller, p.id);
          if (latest.status === "cancelled") throw problem("plan_cancelled", "Plan cancelled");
          if (latest.status === "expired") throw problem("plan_expired", "The plan expired. Create a new one");
          throw inProgress();
        }
      }
      for (const item of items) {
        let reason: string | null = null, corrected: CorrectedStatus | null = null;
        let saved = false;
        // correct_bulk: the correction result (applied/proposed) is added to the item's effect — only the status, no names
        const saveItem = () => q.query("UPDATE action_plan_items SET status=$3,reason=$4,done_at=now(),applied_via=$5,effect=CASE WHEN $6::text IS NULL THEN effect ELSE effect || jsonb_build_object('status',$6::text) END WHERE plan_id=$1 AND ord=$2 AND status='pending'",
          [p.id, item.ord, reason ? "skipped" : "done", reason, reason ? null : caller.keyKind === "session" ? "workplace" : "mcp", reason ? null : corrected]);
        if (p.op === "correct_bulk") {
          ({ reason, status: corrected } = await applyCorrectItem(app, caller, p, item));
          await saveItem();
          continue;
        }
        try {
          // A class change is found by the locator BEFORE the pool opens. T2 does not even do a service read of the closed base.
          // The external agent address: a record that became closed is "no record", as a deleted one
          const loc = await locate(app, item.record_id);
          if (!loc || hiddenHere(caller, loc.class)) reason = "gone";
          else if (loc.class !== item.class) reason = "changed";
          else {
            const spaces = await readableSpaces(app, caller);
            const initial = await itemFacts(app, caller, item.record_id, p.op, spaces);
            await withCommittedOwnerEffects(app, effectApp => withOwnerLocks(effectApp, initial.locks, async () => {
              const lockedLoc = await locate(effectApp, item.record_id);
              if (!lockedLoc || hiddenHere(caller, lockedLoc.class)) { reason = "gone"; return; }
              if (lockedLoc.class !== item.class) { reason = "changed"; return; }
              await withRecordSnapshot(effectApp, { class: item.class, scope: caller.scope, ids: initial.locks }, async recordApp => {
                const freshSpaces = await readableSpaces(recordApp, caller), fresh = await itemFacts(recordApp, caller, item.record_id, p.op, freshSpaces);
                if (fresh.locks.some(id => !initial.locks.includes(id))) throw inProgress();
                if (fresh.fingerprint !== item.fingerprint) { reason = "changed"; return; }
                if (p.op === "delete" && item.effect.trash_days !== trashDays(recordApp)) { reason = "changed"; return; }
                let target: SpaceAccess | undefined;
                if (p.params.to_space_id) {
                  target = freshSpaces.get(p.params.to_space_id);
                  if ((await recordApp.db.control.query("SELECT 1 FROM spaces WHERE id = $1 AND archived_at IS NOT NULL", [p.params.to_space_id])).rowCount) { reason = "archived"; return; }
                }
                const denied = await permission(recordApp, caller, fresh, p.op, freshSpaces, target);
                if (denied) { reason = p.op === "open" ? (["archived", "in_progress", "open_check", "never_open", "no_rights"].includes(denied) ? denied : "changed") : denied === "archived" ? "archived" : denied === "in_progress" ? "in_progress" : denied === "never_open" ? "never_open" : denied === "extended_open" ? "extended_open" : denied === "derived_wider" ? "derived_wider" : "no_rights"; return; }
                await auditContext.run({ plan_id: p.id }, async () => {
                  if (p.op === "delete") await deleteRecord(recordApp, caller, { id: item.record_id });
                  else if (p.op === "close") await close(recordApp, caller, { id: item.record_id });
                  else if (p.op === "purge") await purgeFromTrash(recordApp, caller, item.record_id);
                  // the unchanged single open(): the check again, never despite_findings, never a consent token. open() reads
                  // the settings again; if bulk open or the open check went off meanwhile (open() would then open without the
                  // check), the item is undone — both transactions are still open — and the page stops
                  else if (p.op === "open") {
                    await open(recordApp, caller, { id: item.record_id });
                    await recordApp.settings.load(true).catch(() => undefined);
                    const off = bulkOpenOff(recordApp);
                    if (off) throw off;
                  }
                  else await promote(recordApp, caller, { id: item.record_id, to_space: target!.slug }, { mode: p.op as "promote" | "move_space", viaPlan: true });
                });
                // An error writing the result rolls back the action: both transactions are still open.
                await saveItem();
                saved = true;
              });
            }));
          }
        } catch (e) {
          if (!(e instanceof MemoryError)) throw e; // an unknown failure keeps pending for a safe repeated call
          // bulk open or the open check switched off during the page: the item stays pending, the call answers the refusal
          if (p.op === "open" && isBulkOpenOff(e)) throw e;
          // an archive refusal from the action (the space went to the archive after the permission check): archived, not failed
          reason = e.code === "not_found" ? "gone" : isExtendedOpenDenial(e) ? "extended_open" : isDerivationDenial(e) ? "derived_wider" : isArchivedDenied(e) ? "archived"
            : ["in_progress", "open_check", "never_open"].includes(e.code) ? e.code
            // second line inside promote(): a key never applies a move that needs a person (a plan made before the setting)
            : isConfirmationDenial(e) ? "no_rights" : "failed";
        }
        if (!saved) await saveItem();
      }
      const out = await resultOf(app, p);
      if (!out.remaining) {
        await q.query("UPDATE action_plans SET status=$2,result=$3,applied_at=now() WHERE id=$1", [p.id, out.status, JSON.stringify(out)]);
        // unfinished drafts of a finished plan (skipped, removed) go out at once
        if (p.op === "correct_bulk") await cancelPlannedRows(app, caller, { planIds: [p.id] });
        await audit(app, caller, { event_type: "write", details: { op: "plan_apply", plan_id: p.id, plan_op: p.op, done: out.done, excluded: out.excluded, skipped: out.skipped, via: caller.keyKind === "session" ? "workplace" : "mcp" } });
      }
      return out;
    } finally { if (personLocked) await q.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`plan-person:${p.person_id}`]); }
  });
  return { result, text: `Applied: ${result.done}; skipped: ${result.skipped}; excluded: ${result.excluded}; remaining: ${result.remaining}.${result.trash_url ? ` Trash: ${result.trash_url}` : ""}` };
}

/**
 * A correct_bulk item, no plan snapshot: the correction itself takes the locks of target and ancestors and checks under them
 * currency and fingerprint. Idempotence is on the draft row: already applied/proposed (a failure between correction and result)
 * → done with that status without a check and a journal; no row → gone; put out or outdated → changed.
 */
async function applyCorrectItem(app: App, caller: Caller, p: PlanRow, item: ItemRow): Promise<{ reason: string | null; status: CorrectedStatus | null }> {
  const skipped = (reason: string) => ({ reason, status: null });
  try {
    const loc = await locate(app, item.record_id);
    if (!loc || hiddenHere(caller, loc.class)) return skipped("gone");
    if (loc.class !== item.class || !item.effect.correction_id) return skipped("changed");
    const o = { rowId: item.effect.correction_id, cls: item.class, planId: p.id };
    const state = await plannedStatus(app, caller, o);
    if (state === "applied" || state === "proposed") return { reason: null, status: state };
    if (!state) return skipped("gone");
    if (state !== "planned") return skipped("changed");
    const fresh = await itemFacts(app, caller, item.record_id, p.op, await readableSpaces(app, caller));
    if (fresh.fingerprint !== item.fingerprint) return skipped("changed");
    if (fresh.archived) return skipped("archived");
    const done = await auditContext.run({ plan_id: p.id }, () => applyPlannedCorrection(app, caller, o));
    return { reason: null, status: done.status };
  } catch (e) {
    if (!(e instanceof MemoryError)) throw e; // an unknown failure keeps pending for a safe repeated call
    const why = (e.extra.details as Record<string, unknown> | undefined)?.reason;
    if (e.code === "not_found") return skipped("gone");
    // a gate refusal (the caller is under the gate) — skipped extended_open, not failed (as for a move)
    if (isExtendedOpenDenial(e)) return skipped("extended_open");
    if (e.code === "in_progress" || e.code === "open_check") return skipped(e.code);
    if (isArchivedDenied(e)) return skipped("archived");                    // an archive refusal — class_denied with details.archived
    if (e.code === "forbidden") return skipped("no_rights");
    if (e.code === "invalid_argument" && ["not_current", "superseded", "not_planned"].includes(String(why))) return skipped("changed");
    return skipped("failed");
  }
}

/**
 * target — where the plan moves (promote, move_space): title and kind — only of a space the person reads now
 * (the readableSpaces map); else null. For the workplace button: "Move 5 records to 'Pilot'".
 */
async function summary(app: App, p: PlanRow, spaces?: Map<string, SpaceAccess>) {
  const key = (await app.db.control.query("SELECT client_label AS label,client_kind FROM api_keys WHERE id=$1", [p.key_id])).rows[0] ?? null;
  const to = p.params.to_space_id ? spaces?.get(p.params.to_space_id) : undefined;
  return { id: p.id, op: p.op, status: p.status, created_via: p.created_via, created_at: iso(p.created_at)!, expires_at: iso(p.expires_at)!, started_at: iso(p.started_at), applied_at: iso(p.applied_at),
    totals: { items: p.items_total, cascade: p.cascade_total, spaces: p.spaces_total }, counts: await counts(app, p.id), apply_via: p.apply_via, apply_reason: p.apply_reason, workplace_url: workplaceUrl(app, `/plans/${p.id}`), key, result: p.result,
    target: to ? { name: to.name, kind: to.kind } : null };
}
async function human(app: App, caller: Caller) { await requireHuman(app, caller, "Manage change plans", { path: "/plans", section: "Bulk changes" }); }
export async function listPlans(app: App, caller: Caller, o: { status: string; limit: number; cursor?: string }) {
  await human(app, caller); const who = person(caller);
  if (!["pending", "all"].includes(o.status)) throw invalid("status: pending or all");
  await cancelPlannedRows(app, caller, { planIds: await settleOwnPlans(app, who) });
  const cur = decodeKeyset(o.cursor), args: unknown[] = [who, app.instanceId], b = binder(args);
  const where = ["person_id=$1", "instance_id=$2", ...(o.status === "pending" ? ["status IN ('pending','applying')"] : [])];
  if (cur) where.push(`(created_at,id)<(${b(cur.at)}::timestamptz,${b(cur.id)}::uuid)`);
  const rows = (await app.db.control.query<PlanRow>(`SELECT *,${keysetAtSql("created_at")} AS at_key FROM action_plans WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ${b(o.limit + 1)}`, args)).rows;
  const page = rows.slice(0, o.limit), items = [], spaces = page.some(p => p.params.to_space_id) ? await readableSpaces(app, caller) : undefined;
  for (const p of page) items.push(await summary(app, p, spaces));
  return { items, next_cursor: rows.length > o.limit ? encodeKeyset(page.at(-1)!.at_key!, page.at(-1)!.id) : null, pending: await pendingOf(app, who) };
}
const pendingOf = async (app: App, who: string): Promise<number> =>
  (await app.db.control.query("SELECT count(*)::int AS n FROM action_plans WHERE person_id=$1 AND instance_id=$2 AND status IN ('pending','applying')", [who, app.instanceId])).rows[0].n;
/**
 * The "Bulk changes" counter for the workplace menu summary (GET /me/nav): the same `pending` number as the list, and likewise
 * after moving expired and revoked plans (settleOwnPlans) — only without the plan page.
 */
export async function pendingPlansCount(app: App, caller: Caller): Promise<number> {
  await human(app, caller); const who = person(caller);
  await cancelPlannedRows(app, caller, { planIds: await settleOwnPlans(app, who) });
  return pendingOf(app, who);
}
export async function planDetail(app: App, caller: Caller, id: string, o: { limit: number; offset: number }) {
  await human(app, caller); const p = await ownedPlan(app, caller, id), spaces = await readableSpaces(app, caller);
  const rows = (await app.db.control.query<ItemRow>("SELECT * FROM action_plan_items WHERE plan_id=$1 ORDER BY ord LIMIT $2 OFFSET $3", [id, o.limit + 1, o.offset])).rows;
  const shown: Candidate[] = [], items = [];
  const page = rows.slice(0, o.limit), facts = new Map<string, Candidate>();
  for (const item of page) {
    try { const rec = await itemFacts(app, caller, item.record_id, p.op, spaces); facts.set(item.record_id, rec); shown.push(rec); }
    catch (e) { if (!(e instanceof MemoryError) || !["not_found", "in_progress"].includes(e.code)) throw e; }
  }
  // correct_bulk: "was → became" — only for items the session reads now, and by the draft (own rows)
  const drafts = new Map<string, Awaited<ReturnType<typeof plannedEffects>>>();
  if (p.op === "correct_bulk") for (const cls of ["open", "closed"] as const) {
    const ids = page.filter(i => i.class === cls && facts.has(i.record_id) && i.status !== "done" && i.effect.correction_id).map(i => i.effect.correction_id!);
    if (ids.length) drafts.set(cls, await plannedEffects(app, caller, cls, ids));
  }
  const to = p.params.to_space_id ? spaces.get(p.params.to_space_id) : undefined;
  for (const item of page) {
    const rec = facts.get(item.record_id) ?? null;
    const effect = p.op === "correct_bulk" ? correctEffect(item, rec, drafts.get(item.class)?.get(item.effect.correction_id ?? ""))
      // for a person — the space title in quotes, not a slug; for an agent memory_plan still gives the slug
      : effectText(p.op, item.effect, to ? `«${to.name}»` : undefined, to?.kind);
    items.push({ id: item.record_id, ord: item.ord, title: rec?.title?.slice(0, 300) ?? null, type: rec?.type ?? null, space: rec?.slug ?? null, class: item.class,
      space_name: rec?.space_name ?? null, space_kind: rec?.space_kind ?? null, event_kind: rec?.event_kind ?? null,
      effect, correction_status: item.effect.status ?? null, status: item.status, reason: item.reason, unavailable: !rec });
  }
  await shownAudit(app, caller, shown, "plan_view");
  return { ...await summary(app, p, spaces), ...(p.op === "open" ? { open_preview: await openPreview(app, p.id, spaces) } : {}), items,
           next_cursor: rows.length > o.limit ? String(o.offset + o.limit) : null };
}

export interface OpenPreview { spaces: Array<{ slug: string; name: string; kind: string; records: number; readers: { kind: "self" | "list" | "all"; count: number | null } }> }
/**
 * Preview of a bulk "show to agents" plan: per space, how many records of the plan and how
 * many people's agents will be able to read them — the personal space: only you; a team or project: its readers
 * (spaceReaders; the company space — everybody, never in such a plan: bulk-open.ts). Numbers only; the sentence about
 * images and scans is the workspace's. Excluded items are not counted; a space the person no longer reads is left
 * out (its items are skipped at apply time).
 */
export async function openPreview(app: App, planId: string, spaces: Map<string, SpaceAccess>): Promise<OpenPreview> {
  const groups = (await app.db.control.query("SELECT space_id, count(*)::int AS n FROM action_plan_items WHERE plan_id = $1 AND status <> 'excluded' GROUP BY space_id", [planId])).rows as Array<{ space_id: string; n: number }>;
  const out: OpenPreview["spaces"] = [];
  for (const g of groups) {
    const s = spaces.get(g.space_id);
    if (!s) continue;
    const r = await spaceReaders(app, s);
    out.push({ slug: s.slug, name: s.name, kind: s.kind, records: g.n, readers: r.kind === "list" ? { kind: "list", count: r.ids.length } : r.kind === "self" ? { kind: "self", count: 1 } : { kind: "all", count: null } });
  }
  return { spaces: out.sort((a, b) => b.records - a.records || a.slug.localeCompare(b.slug)) };
}
/**
 * The consequence of a correct_bulk item on the plan page: before applying — "Assignee 'was' → 'became'" by the draft and
 * the current event (compared after normalization, several — joined by ", "); an unavailable item, a put-out draft or
 * an empty difference — without names. After applying — the item's result.
 */
function correctEffect(item: ItemRow, rec: Candidate | null, draft: { status: string; actors: string[] | null } | undefined): string {
  if (item.status === "done") return item.effect.status === "proposed" ? "Sent for confirmation" : "Assignee corrected";
  if (item.status !== "pending" && item.status !== "excluded") return "Correct the assignee";
  if (!rec || !draft || draft.status !== "planned" || !draft.actors) return "Correct the assignee";
  const norm = (v: string) => pipelineText.normalize(v) || v;
  const before = rec.actors, next = draft.actors, has = (list: string[], v: string) => list.some(x => norm(x) === norm(v));
  const was = before.filter(v => !has(next, v)), now = next.filter(v => !has(before, v));
  return was.length && now.length ? `Assignee “${was.join(", ")}” → “${now.join(", ")}”` : "Correct the assignee";
}

export async function patchPlan(app: App, caller: Caller, id: string, changes: { exclude?: string[]; include?: string[] }) {
  await human(app, caller);
  await ownedPlan(app, caller, id);
  return withPlanLock(app, id, async q => {
    app = withControlConnection(app, q);
    const p = await ownedPlan(app, caller, id);
    if (p.status !== "pending") throw problem(p.status === "expired" ? "plan_expired" : "plan_started", "You can only edit the list before applying the plan");
    const exclude = changes.exclude ?? [], include = changes.include ?? [], ids = [...new Set([...exclude, ...include])];
    if (exclude.some(x => include.includes(x))) throw invalid("A change cannot be excluded and restored in the same request");
    const found = (await q.query("SELECT record_id FROM action_plan_items WHERE plan_id=$1 AND record_id=ANY($2::uuid[])", [id, ids])).rows;
    if (found.length !== ids.length) throw problem("exclude_not_in_plan", "These changes are outside the plan");
    await tx(app.db.control, async t => {
      if (exclude.length) await t.query("UPDATE action_plan_items SET status='excluded' WHERE plan_id=$1 AND record_id=ANY($2::uuid[])", [id, exclude]);
      if (include.length) await t.query("UPDATE action_plan_items SET status='pending' WHERE plan_id=$1 AND record_id=ANY($2::uuid[])", [id, include]);
    });
    return { excluded: (await counts(app, id)).excluded };
  });
}
export async function cancelPlan(app: App, caller: Caller, id: string) {
  await human(app, caller);
  await ownedPlan(app, caller, id);
  return withPlanLock(app, id, async q => {
    app = withControlConnection(app, q);
    const p = await ownedPlan(app, caller, id);
    if (p.status === "cancelled") return { status: "cancelled" as const };
    // a started plan of bulk "show to agents" may be cancelled too: what is not applied yet stays closed, what is applied
    // stays applied (otherwise, while bulk open is switched off, the person could neither finish nor cancel it)
    if (p.op === "open" && p.status === "applying") {
      await q.query("UPDATE action_plans SET status='cancelled' WHERE id=$1", [id]);
      await audit(app, caller, { event_type: "write", details: { op: "plan_cancel", plan_id: id, plan_op: p.op, started: true } });
      return { status: "cancelled" as const };
    }
    if (p.status !== "pending") throw problem("plan_started", "You can only cancel a plan before it starts applying");
    await q.query("UPDATE action_plans SET status='cancelled' WHERE id=$1", [id]);
    if (p.op === "correct_bulk") await cancelPlannedRows(app, caller, { planIds: [id] });
    await audit(app, caller, { event_type: "write", details: { op: "plan_cancel", plan_id: id, plan_op: p.op } });
    return { status: "cancelled" as const };
  });
}
