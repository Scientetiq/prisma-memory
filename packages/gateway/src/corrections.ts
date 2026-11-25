import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import { createHash } from "node:crypto";
import type pg from "pg";
import { archivedDenied, binder, carryOrgReview, CHAIN_HEAD, CHAIN_TREE, defaultDerivation, estimateTokens, findQuoteInThread, fingerprintOf, gateAllows, insertLinkRetrying, invalid, isSpaceGuideRow, log, MemoryError, neverOpenFindings, newId, notFound,
         DERIVED_LOST_CLASS_CHANGE, meetingOrigin, openCheckFallback, openCheckReasons, pipelineText, QuoteCheckTimeout, rateLimited, recordPath, SCOPE_SYSTEM, setLinkStatus, setLinkStatusOn, syncDeletionMarks, tx,
         visibleSql, CORRECTED_STAGE_NOTE, type DataClass, type LinkActor, type LinkRelation, type LinkStatus, type OpenCheckFallback, type OpenCheckFinding, type OpenCheckText, type QuoteFound } from "@memory/shared";
import { enterOrg, isHumanSession, isOrgCurator } from "./org-review.ts";
import type { App, Caller } from "./context.ts";
import { loadReadable, readableSpaces, visibilityFor, type RecordRow, type SpaceAccess } from "./access.ts";
import { gateOf, recordVisible } from "./visibility.ts";
import { OFF_HINT, personalMode, SCRIPT_HINT } from "./write.ts";
import { audit, auditRead } from "./audit.ts";
import { guardOpen, guardOpenSoft } from "./open-check.ts";
import { withOwnerLocks } from "./owner-lock.ts";
import { extendedOpenGate, MARKED_TAIL, markAttrs, markEvent, proposalExtendedMark, type ExtendedMark } from "./extended-open.ts";
import { checkText, sourceHash } from "./records.ts";
import { readBasis } from "./derivation.ts";
import { requireHuman, workplaceUrl } from "./workplace.ts";
import { decodeKeyset, encodeKeyset, keysetAtSql, keysetCompare } from "./paging.ts";
import { guideEnabled, guideLimitsOf } from "./space-guide-ref.ts";
import { GUIDE_CONFIRM_REFUSAL, GUIDE_PROPOSED_TEXT, GUIDE_ROW_SQL, GUIDE_UNDO_REFUSAL, guideCorrectionRule, guideDecides, guidePageUrl, guideProposalStatus } from "./space-guide-proposals.ts";

export const CORRECTION_KINDS = ["extraction_error", "wrong", "outdated", "own_note"] as const;
export type CorrectionKind = typeof CORRECTION_KINDS[number];
export type CorrectionRole = "author" | "space_owner" | "participant" | "space_member" | "reader";
export type CorrectionStatus = "planned" | "proposed" | "applied" | "rejected" | "withdrawn" | "superseded" | "cancelled";
export interface CorrectFields { title?: string; statement?: string; due?: string | null; actors?: string[] }
export interface CorrectArgs { id: string; kind: CorrectionKind; text?: string; fields?: CorrectFields; quote?: string; newer_id?: string; origin?: "human" | "agent" }
type Effect = "new_version" | "annotation" | "link";

export const CORRECTION_TEXT_MAX = 2000;
const TITLE_CUT = 100;
const problem = (reason: string, message: string, details: Record<string, unknown> = {}) => invalid(message, { reason, ...details });

export function correctionRole(f: { me: string; ownerId: string; spaceRole: SpaceAccess["role"] | null; participant: boolean }): CorrectionRole {
  if (f.ownerId === f.me) return "author";
  if (f.spaceRole === "owner") return "space_owner";
  if (f.participant) return "participant";
  if (f.spaceRole === "member") return "space_member";
  return "reader";
}

export function decideStatus(kind: CorrectionKind, role: CorrectionRole, origin: "human" | "agent", nonParticipant: "proposed" | "deny"): "applied" | "proposed" {
  if (kind === "own_note") {
    if (role === "author" || role === "space_owner") return "applied";
    throw new MemoryError("forbidden", "The author and the space owner can replace the note", { hint: "Propose a correction: wrong or outdated", details: { reason: "own_note_not_author" } });
  }
  if (role === "author" || role === "space_owner" || role === "participant") return "applied";
  if (role === "space_member" && kind === "outdated" && origin === "human") return "applied";
  if (nonParticipant === "deny")
    throw new MemoryError("forbidden", "The author, meeting participants and space owner can correct this record", { details: { reason: "not_participant" } });
  return "proposed";
}

export function canDecide(kind: CorrectionKind, role: CorrectionRole): boolean {
  if (kind === "own_note") return role === "author" || role === "space_owner";
  return role === "author" || role === "space_owner" || role === "participant" || (kind === "outdated" && role === "space_member");
}

export interface TargetFacts { type: string; source_kind: string; parent_type: string | null }

export function kindApplicable(kind: CorrectionKind, t: TargetFacts): boolean {
  if (t.type === "transcript") return false;
  switch (kind) {
    case "extraction_error": return t.type === "event" && ["pipeline", "correction"].includes(t.source_kind) && t.parent_type === "transcript";
    case "wrong": return ["event", "summary", "note", "document"].includes(t.type);
    case "outdated": return ["event", "note", "document"].includes(t.type);
    case "own_note": return t.source_kind === "agent" && ["note", "event"].includes(t.type);
  }
}

export function replaceActor(actors: string[], from: string, to: string): { next: string[]; matched: string } | null {
  const key = pipelineText.normalize(from);
  if (!key) return null;
  let matched: string | null = null;
  const next: string[] = [], seen = new Set<string>();
  for (const a of actors) {
    const hit = pipelineText.normalize(a) === key;
    if (hit && matched === null) matched = a;
    const v = hit ? to.trim() : a;
    const k = pipelineText.normalize(v) || v;
    if (seen.has(k)) continue;
    seen.add(k); next.push(v);
  }
  return matched === null ? null : { next: next.slice(0, 20), matched };
}

const TRANSCRIPT_HINT = "The transcript is the original and cannot be corrected directly. Correct the event or summary (wrong, extraction_error). The meeting owner can fix a transcription error by submitting a new version of the meeting";

export function validateCorrection(a: Pick<CorrectArgs, "kind" | "text" | "fields" | "quote" | "newer_id"> & { origin: "human" | "agent" }, t: TargetFacts): void {
  if (!(CORRECTION_KINDS as readonly string[]).includes(a.kind)) throw problem("kind_not_applicable", "kind: extraction_error, wrong, outdated or own_note");
  if (a.origin === "agent" && !(a.kind === "own_note" || (a.kind === "outdated" && a.newer_id)))
    throw problem("origin_not_allowed", "An agent can replace its own note (own_note) or mark a record as outdated by providing the newer_id value. Other changes require the person’s own words (origin: human)");
  if (t.type === "transcript") throw problem("kind_not_applicable", TRANSCRIPT_HINT);
  if (a.quote !== undefined && a.kind !== "extraction_error") throw problem("kind_not_applicable", "quote is only for extraction_error. Use an exact phrase from the meeting transcript");
  if (a.fields !== undefined && a.kind !== "extraction_error" && a.kind !== "own_note") throw problem("kind_not_applicable", "fields is only for extraction_error and own_note");
  if (a.kind === "own_note" && a.fields && Object.keys(a.fields).some((k) => k !== "title")) throw problem("kind_not_applicable", "own_note accepts only title in fields");
  if (a.text !== undefined && a.kind !== "own_note" && [...a.text].length > CORRECTION_TEXT_MAX)
    throw problem("text_too_long", `Use up to ${CORRECTION_TEXT_MAX} characters for the correction. Briefly say what is correct`);
  if (a.newer_id !== undefined && a.kind !== "outdated") throw problem("kind_not_applicable", "newer_id is only for outdated");
  switch (a.kind) {
    case "extraction_error":
      if (!kindApplicable(a.kind, t)) throw problem("kind_not_applicable", "extraction_error applies only to an event extracted from a meeting. Use wrong or outdated for other records");
      if (!a.fields || !Object.keys(a.fields).length) throw problem("kind_not_applicable", "extraction_error requires fields with the correct title, details, due date or assignees");
      return;
    case "wrong":
      if (!kindApplicable(a.kind, t)) throw problem("kind_not_applicable", "wrong applies to an event, summary, note or document");
      if (!a.text?.trim()) throw problem("kind_not_applicable", "wrong requires text explaining the correction in the person’s own words");
      return;
    case "outdated":
      if (!kindApplicable(a.kind, t)) throw problem("kind_not_applicable", "outdated applies to an event, note or document");
      if (!a.newer_id && !a.text?.trim()) throw problem("kind_not_applicable", "outdated requires newer_id (a newer record) or text (what changed)");
      return;
    case "own_note":
      if (!kindApplicable(a.kind, t)) throw problem("kind_not_applicable", "own_note applies only to a note saved with memory_remember. Use wrong or outdated for other records");
      if (!a.text?.trim()) throw problem("kind_not_applicable", "own_note requires text with the replacement note");
      return;
  }
}

export function canonicalFields(f: CorrectFields | undefined): CorrectFields | null {
  if (!f) return null;
  const out: CorrectFields = {};
  if (typeof f.title === "string" && f.title.trim()) out.title = f.title.trim();
  if (typeof f.statement === "string" && f.statement.trim()) out.statement = f.statement.trim();
  if (f.due === null) out.due = null;
  else if (typeof f.due === "string") {
    const d = f.due.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw invalid("fields.due must be a YYYY-MM-DD date or null");
    out.due = d;
  }
  if (Array.isArray(f.actors)) out.actors = [...new Set(f.actors.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20);
  return Object.keys(out).length ? out : null;
}

export function dedupeOf(a: { target: string; kind: string; by: string; text: string | null; fields: CorrectFields | null; quote: string | null; newer: string | null }): string {
  return fingerprintOf({ v: 1, target: a.target, kind: a.kind, by: a.by, text: a.text?.trim() ?? null, fields: a.fields, quote: a.quote?.trim() ?? null, newer: a.newer });
}

export function parseStatement(text: string | null | undefined): string | null {
  const m = /(?:^|\n)\*\*[^*\n]+\.\*\* ([\s\S]*?)(?:\n\n>(?= |\n|$)|\n*$)/.exec(text ?? "");
  return m && m[1]!.trim() ? m[1]!.trim() : null;
}

export interface MergedEvent { title: string; statement: string; due: string | null; actors: string[]; quote: string; timeFrom: number | null; text: string; attrs: Record<string, unknown> }

export function mergeEventFields(target: { title: string | null; event_kind: string | null; summary_line: string | null; attrs: Record<string, any>; locator: Record<string, any> | null; text: string | null },
                                 fields: CorrectFields | null, quote: string | null, match: QuoteFound | null): MergedEvent {
  const f = fields ?? {}, at = target.attrs ?? {};
  const title = f.title ?? target.title ?? "Event";
  const kept = typeof at.statement === "string" && at.statement.trim() ? at.statement.trim() : null;
  const statement = f.statement ?? kept ?? parseStatement(target.text) ?? target.summary_line ?? "";
  const due = f.due === null ? null : f.due ?? (typeof at.due === "string" && at.due ? at.due : null);
  const actors = f.actors ?? (Array.isArray(at.actors) ? at.actors.map(String) : []);
  const q = quote ?? (typeof at.quote === "string" ? at.quote : "");
  const timeFrom = match?.time_from ?? (typeof target.locator?.time_from === "number" ? target.locator.time_from : null);
  const actorsRole = f.actors !== undefined ? "assignee" : typeof at.actors_role === "string" ? at.actors_role : null;
  const text = pipelineText.renderEvent({ kind: target.event_kind ?? "fact", title, statement, quote: q, timeFrom,
    rationale: typeof at.rationale === "string" ? at.rationale : null, alternatives: Array.isArray(at.alternatives) ? at.alternatives : null, due, actors,
    actorsRole });
  const { confidence: _c, certainty: _ce, match: _m, extended_write: _xw, ...rest } = at;
  return { title, statement, due, actors, quote: q, timeFrom, text, attrs: { ...rest, quote: q, statement, actors, due, ...(actorsRole ? { actors_role: actorsRole } : {}) } };
}

export const effectOf = (kind: CorrectionKind, newer: boolean): Effect =>
  kind === "extraction_error" || kind === "own_note" ? "new_version" : kind === "outdated" && newer ? "link" : "annotation";

export const relationOf = (kind: CorrectionKind): LinkRelation | null => kind === "outdated" ? "replaces" : kind === "own_note" ? null : "corrects";

interface Who { personId: string; via: "mcp" | "workplace"; origin: "human" | "agent"; keyId: string | null }

export function correctionCaller(caller: Caller, origin: "human" | "agent" | undefined): Who {
  if (caller.principalType === "system" || !caller.person) throw new MemoryError("forbidden", "A person or their agent can correct memory. System keys and services acting without a person cannot");
  if (caller.preview) throw new MemoryError("forbidden", "Admin panel preview cannot correct memory", { details: { reason: "preview" } });
  if (caller.principalType === "service" && !caller.allowedOps?.has("correct")) throw new MemoryError("forbidden", "The correct operation is not on the service’s allow-list");
  if (caller.keyKind === "session") return { personId: caller.person.id, via: "workplace", origin: "human", keyId: caller.keyId };
  const o = origin ?? "agent";
  if (o === "human" && caller.clientKind === "script")
    throw problem("origin_not_allowed", "Script keys cannot relay a person’s own words. Use origin human only through an agent in conversation with the person or in the workspace");
  return { personId: caller.person.id, via: "mcp", origin: o, keyId: caller.keyId };
}

export interface Target {
  rec: RecordRow; text: string | null; spaces: Map<string, SpaceAccess>;
  space: { id: string; slug: string; kind: string; owner_id: string | null; archived: boolean; archived_at: Date | null; role: SpaceAccess["role"] | null; default_class: DataClass };
  parentType: string | null; participant: boolean; rootId: string;
  lockIds: string[];
}

export async function targetOf(app: App, caller: Caller, id: string, spaces?: Map<string, SpaceAccess>): Promise<Target> {
  const { rec, db, spaces: all } = await loadReadable(app, caller, id, spaces);
  const me = caller.person!.id;
  const sp = (await app.db.control.query("SELECT id, slug, kind, owner_id, org_unit_id, archived_at, default_class FROM spaces WHERE id = $1 AND instance_id = $2", [rec.space_id, app.instanceId])).rows[0];
  if (!sp) throw notFound();
  const facts = (await db.query(
    `WITH RECURSIVE up AS (SELECT id, parent_id, type, 0 AS depth FROM records WHERE id = $1
       UNION SELECT r.id, r.parent_id, r.type, u.depth + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.depth < 50)
     SELECT (SELECT id FROM up ORDER BY depth DESC LIMIT 1) AS root_id,
            (SELECT array_agg(id::text ORDER BY depth) FROM up) AS up_ids,
            (SELECT type::text FROM up WHERE depth = 1) AS parent_type,
            (SELECT type::text FROM up ORDER BY depth DESC LIMIT 1) AS root_type,
            EXISTS (SELECT 1 FROM record_people WHERE record_id = $1 AND person_id = $2) AS listed,
            (SELECT text FROM record_content WHERE record_id = $1) AS text`, [id, me])).rows[0];
  const participant = !!facts?.listed && facts?.root_type === "transcript";
  const rootId: string = facts?.root_id ?? rec.id;
  return { rec, text: facts?.text ?? null, spaces: all, parentType: facts?.parent_type ?? null, participant, rootId,
           lockIds: [...new Set<string>([rec.id, ...((facts?.up_ids as string[] | null) ?? []), rootId])],
           space: { id: sp.id, slug: sp.slug, kind: sp.kind, owner_id: sp.owner_id, archived: !!sp.archived_at, archived_at: sp.archived_at ?? null, default_class: sp.default_class,
                    role: all.get(sp.id)?.role ?? (sp.owner_id === me && !sp.org_unit_id ? "owner" : null) } };
}

export async function targetFingerprint(db: Pick<pg.Pool, "query">, id: string): Promise<string> {
  const rows = (await db.query(
    `SELECT r.id, r.class, r.space_id, r.owner_id, r.audience, r.is_current, r.version, r.superseded_by_id, r.deleted_at, r.deleted_batch, r.hidden_at IS NOT NULL AS hidden,
            (SELECT md5(string_agg(person_id::text, ',' ORDER BY person_id)) FROM record_people WHERE record_id = r.id) AS people,
            (SELECT md5(string_agg(space_id::text, ',' ORDER BY space_id)) FROM record_placements WHERE record_id = r.id) AS placements
     FROM records r WHERE r.id = $1`, [id])).rows;
  return fingerprintOf(rows);
}

function admitBasics(caller: Caller, t: Target): void {
  if (t.space.archived) throw archivedDenied(t.space.slug, t.space.archived_at);
  if (caller.service?.write_space_id && t.space.id !== caller.service.write_space_id)
    throw new MemoryError("forbidden", "This service writes only to its designated write space, as configured in the admin panel", { details: { reason: "write_space" } });
  if (t.rec.class === "closed" && caller.tier === "T1") throw new MemoryError("class_denied", "A T1 service cannot write closed records");
}

const nonEmpty = (texts: OpenCheckText[]): OpenCheckText[] => texts.filter((x) => typeof x.value === "string" && x.value.trim());

function correctionTexts(d: { text: string | null; fields: CorrectFields | null; quote: string | null }): OpenCheckText[] {
  return nonEmpty([{ field: "text", value: d.text }, { field: "title", value: d.fields?.title ?? null }, { field: "summary", value: d.fields?.statement ?? null },
                   { field: "entities", value: d.fields?.actors?.join("\n") ?? null }, { field: "quote", value: d.quote }]);
}

export const annotationTitle = (kind: "wrong" | "outdated", title: string | null): string => {
  const short = (title ?? "record").slice(0, TITLE_CUT);
  return kind === "wrong" ? `Correction: ${short}` : `No longer valid: ${short}`;
};

export function finalCorrectionTexts(t: { rec: { title: string | null; event_kind: string | null; summary_line: string | null; attrs: Record<string, any>; locator: Record<string, any> | null };
                                          text: string | null },
                                     d: { kind: CorrectionKind; text: string | null; fields: CorrectFields | null; quote: string | null; newer?: boolean }): OpenCheckText[] {
  switch (d.kind) {
    case "own_note":
      return nonEmpty([{ field: "title", value: d.fields?.title ?? t.rec.title }, { field: "text", value: d.text }]);
    case "wrong": case "outdated":
      if (d.kind === "outdated" && d.newer) return correctionTexts(d);
      return nonEmpty([{ field: "title", value: annotationTitle(d.kind, t.rec.title) }, { field: "text", value: d.text }]);
    case "extraction_error": {
      const m = mergeEventFields({ ...t.rec, text: t.text }, d.fields, d.quote, null);
      return nonEmpty([{ field: "title", value: m.title }, { field: "summary", value: m.statement }, { field: "text", value: m.text },
                       { field: "entities", value: m.actors.join("\n") }, { field: "quote", value: m.quote }]);
    }
  }
}

export const workplaceKeepsOpen = (caller: Pick<Caller, "keyKind" | "principalType" | "person" | "onBehalfOf" | "preview">): boolean => isHumanSession(caller);

export type ClosedWhy = "script" | "notebook_off" | "reads_closed" | "service";
export interface Admission { cls: DataClass; fallback: OpenCheckFallback | null; closedWhy: ClosedWhy | null; extended?: ExtendedMark | null }

export async function admitCorrection(app: App, caller: Caller, t: Target,
                                      d: { kind: CorrectionKind; text: string | null; fields: CorrectFields | null; quote: string | null; link?: boolean; newer?: boolean })
  : Promise<Admission> {
  admitBasics(caller, t);
  if (t.rec.class !== "open") return { cls: t.rec.class, fallback: null, closedWhy: null };
  const texts = finalCorrectionTexts(t, { ...d, newer: d.newer ?? d.link });
  if (d.kind === "own_note" && t.space.kind === "personal" && t.space.owner_id === caller.person?.id && t.space.default_class === "closed") {
    const mode = personalMode(caller, { kind: "personal", owner_id: t.space.owner_id, default_class: t.space.default_class });
    if (mode !== "open" && !workplaceKeepsOpen(caller))
      return { cls: "closed", fallback: null, closedWhy: mode === "off" ? "notebook_off" : mode === "script" ? "script" : caller.principalType === "person" ? "reads_closed" : "service" };
    const rules = (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows;
    const never = neverOpenFindings(rules, { type: t.rec.type, title: d.fields?.title ?? t.rec.title, domains: t.rec.domain_tags ?? [], entityKinds: [], spaceSlug: t.space.slug,
                                             sourceKind: t.rec.source_kind, sourceRef: t.rec.source_ref });
    if (never.length) return { cls: "closed", fallback: openCheckFallback("remember", never, { textChecked: false }), closedWhy: null };
    if (!texts.length) return { cls: "open", fallback: null, closedWhy: null };
    const { findings, strict } = await guardOpenSoft(app, caller, { via: "correct", spaceId: t.space.id, recordId: t.rec.id, texts });
    return findings.length ? { cls: "closed", fallback: openCheckFallback("remember", findings, { strict, textChecked: true }), closedWhy: null } : { cls: "open", fallback: null, closedWhy: null };
  }
  const extended = await extendedOpenGate(app, caller, { attempt: d.link ? "link" : "correct", space: { id: t.space.id, slug: t.space.slug }, recordId: t.rec.id });
  if (!texts.length) return { cls: "open", fallback: null, closedWhy: null, extended };
  await guardOpen(app, caller, { via: "correct", spaceId: t.space.id, recordId: t.rec.id, texts, refusal: shownDespiteRefusal(t, d.kind, caller) });
  return { cls: "open", fallback: null, closedWhy: null, extended };
}

export const SHOWN_EDIT_REFUSED = (reasons: string) =>
  `The correction was not saved because its text contains ${reasons} and the record is visible to agents. Hide the record from agents, edit it and show it to agents again.`;
export const SHOWN_MARK_REFUSED = (reasons: string) =>
  `The mark was not saved because the record title contains ${reasons} and agents can see the record and its marks. The mark uses the record title. Ask the author to edit the title or hide the record from agents.`;
const SHOWN_REFUSED_HINT = "Nothing was written. The correction would have been stored alongside the record in its open class";

export function shownDespiteRefusal(t: Pick<Target, "rec">, kind: CorrectionKind, caller: Pick<Caller, "person">):
    ((findings: readonly OpenCheckFinding[]) => { message: string; hint: string } | null) | undefined {
  if (!t.rec.attrs?.open_check_accepted) return undefined;
  return (findings) => {
    if (kind === "own_note") return { message: SHOWN_EDIT_REFUSED(openCheckReasons([...findings])), hint: SHOWN_REFUSED_HINT };
    const inTitle = findings.filter((f) => f.field === "title");
    if ((kind === "wrong" || kind === "outdated") && inTitle.length && caller.person?.id !== t.rec.owner_id)
      return { message: SHOWN_MARK_REFUSED(openCheckReasons(inTitle)), hint: SHOWN_REFUSED_HINT };
    return null;
  };
}

async function checkQuote(app: App, caller: Caller, t: Target, quote: string): Promise<QuoteFound> {
  if (!t.rec.parent_id) throw problem("quote_not_allowed", "The quote is checked against the meeting transcript, but this record has no transcript");
  let meeting: { rec: RecordRow; db: pg.Pool };
  try { meeting = await loadReadable(app, caller, t.rec.parent_id, t.spaces); }
  catch (e) {
    if (e instanceof MemoryError && (e.code === "not_found" || e.code === "in_progress"))
      throw problem("quote_not_allowed", "You cannot see the meeting transcript. Correct the record without quote and have the person verify the phrase in the workspace");
    throw e;
  }
  const text = (await meeting.db.query("SELECT text FROM record_content WHERE record_id = $1", [meeting.rec.id])).rows[0]?.text ?? "";
  const threshold = Number(app.settings.get<{ fuzzy_threshold?: number }>("processing.events", { fuzzy_threshold: 0.9 }).fuzzy_threshold ?? 0.9);
  let found: QuoteFound | null;
  try { found = await findQuoteInThread(text, quote, Number.isFinite(threshold) ? threshold : 0.9); }
  catch (e) {
    if (e instanceof QuoteCheckTimeout && e.why === "queue_full") throw rateLimited(10);
    if (e instanceof QuoteCheckTimeout) throw problem("quote_check_timeout", "The phrase could not be checked against the transcript in time. Nothing changed. Try again in a minute or correct the record without quote");
    throw e;
  }
  if (!found) throw problem("quote_not_found", "The exact phrase was not found in the meeting transcript. Nothing changed. Ask the person to copy the phrase from the transcript excerpt beside the event in the workspace, or correct the record without quote");
  return found;
}

async function newerOf(app: App, caller: Caller, t: Target, newerId: string, origin: "human" | "agent"): Promise<{ id: string; class: DataClass; path: string; source_kind: string }> {
  if (newerId === t.rec.id) throw problem("kind_not_applicable", "newer_id must point to a different, newer record");
  const { rec, db } = await loadReadable(app, caller, newerId, t.spaces);
  if (!rec.is_current) throw problem("not_current", "The newer record has also been replaced. Specify its current version");
  if (new Date(rec.occurred_at).getTime() < new Date(t.rec.occurred_at).getTime()) throw problem("newer_older", "newer_id predates the record being corrected. The “replaced” link points from the newer record to the older one");
  if (origin === "agent" && rec.source_kind === "agent" && ["pipeline", "correction"].includes(t.rec.source_kind))
    throw problem("kind_not_applicable", "An agent cannot replace a meeting event with its own record. Tell the person so they can correct it");
  if (rec.owner_id !== t.rec.owner_id) {
    const owner = { ...caller, keyKind: "session" as const, tier: "T0" as const, scope: SCOPE_SYSTEM, person: { ...caller.person!, id: t.rec.owner_id } } as Caller;
    if (!(await recordVisible(db, owner, rec, await readableSpaces(app, owner))))
      throw problem("newer_not_shared", "The author of the record being corrected cannot see the newer record, so the “replaced” link would be unclear. Choose a record from the same space");
  }
  const slug = (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [rec.space_id])).rows[0]?.slug ?? "?";
  return { id: rec.id, class: rec.class, path: recordPath(slug, rec.type, rec.occurred_at, rec.id), source_kind: rec.source_kind };
}

interface CorrectionRow {
  id: string; target_id: string; kind: CorrectionKind; status: CorrectionStatus; origin: "human" | "agent"; via: "mcp" | "workplace" | "plan";
  by_person: string; by_role: CorrectionRole; key_id: string | null; text: string | null; fields: CorrectFields | null; quote: string | null;
  quote_match: (QuoteFound & { without_quote?: boolean }) | null; newer_id: string | null; result_id: string | null; link_id: string | null;
  target_fp: string; dedupe: string; plan_id: string | null; created_at: Date; decided_by: string | null; decided_at: Date | null; at_key?: string; cls?: DataClass;
}

export function classesFor(caller: Pick<Caller, "scope" | "keyKind" | "person">, t: { cls: DataClass; ownerId: string }): DataClass[] {
  if (t.cls === "closed") return ["closed"];
  const g = gateOf(caller).closed;
  return g === "all" || (g === "own" && t.ownerId === caller.person?.id) ? ["open", "closed"] : ["open"];
}

async function knownByDedupe(app: App, caller: Caller, cls: DataClass, dedupe: string, kind?: CorrectionKind): Promise<CorrectionRow | null> {
  const classes: DataClass[] = cls === "closed" ? ["closed"] : caller.scope.classes.includes("closed") ? ["open", "closed"] : ["open"];
  const pools: Array<[DataClass, pg.Pool]> = classes.map((c) => [c, app.db.records(c, caller.scope)]);
  if (kind === "own_note" && cls === "open" && !caller.scope.classes.includes("closed")) pools.push(["closed", app.db.recordsForWrite("closed", caller.scope)]);
  for (const [c, db] of pools) {
    const row = (await db.query<CorrectionRow>(
      `SELECT id, target_id, kind, status, origin, via, by_person, by_role, key_id, NULL::text AS text, NULL::jsonb AS fields, NULL::text AS quote, quote_match, newer_id,
              result_id, link_id, target_fp, dedupe, plan_id, created_at, decided_by, decided_at
       FROM record_corrections WHERE dedupe = $1 AND status IN ('proposed','applied') LIMIT 1`, [dedupe])).rows[0];
    if (row) return { ...row, cls: c };
  }
  return null;
}

async function pathOf(app: App, caller: Caller, id: string): Promise<string | null> {
  try {
    const { rec } = await loadReadable(app, caller, id);
    const slug = (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [rec.space_id])).rows[0]?.slug as string | undefined;
    return slug ? recordPath(slug, rec.type, rec.occurred_at, id) : null;
  } catch (e) {
    if (!(e instanceof MemoryError) || (e.code !== "not_found" && e.code !== "in_progress")) throw e;
  }
  const me = caller.person?.id ?? null;
  const loc = (await app.db.control.query("SELECT l.class, l.owner_id, l.deleted, s.slug FROM record_locations l JOIN spaces s ON s.id = l.space_id WHERE l.record_id = $1", [id])).rows[0];
  if (!loc || loc.deleted || !me || loc.owner_id !== me) return null;
  if (caller.scope.classes.includes(loc.class) && gateAllows(gateOf(caller)[loc.class as DataClass], loc.owner_id, me)) return null;
  const rec = (await app.db.recordsForWrite(loc.class, caller.scope).query("SELECT type, occurred_at FROM records WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
  return rec ? recordPath(loc.slug, rec.type, rec.occurred_at, id) : null;
}

async function repairResultLocator(app: App, caller: Caller, cls: DataClass, resultId: string): Promise<boolean> {
  if ((await app.db.control.query("SELECT 1 FROM record_locations WHERE record_id = $1", [resultId])).rowCount) return false;
  const db = app.db.recordsForWrite(cls, caller.scope);
  const ROW = `SELECT id, type::text AS type, space_id, owner_id, audience::text AS audience, source_hash, supersedes_id, parent_id, attrs FROM records
               WHERE id = $1 AND attrs ? 'correction' AND hidden_at IS NULL AND deleted_at IS NULL`;
  const r0 = (await db.query(ROW, [resultId])).rows[0];
  if (!r0) return false;
  const target = (r0.supersedes_id ?? r0.parent_id) as string | null;
  let restored = false;
  try {
    restored = await withOwnerLocks(app, [resultId, ...(target ? [target] : [])], async (q) => {
      const r = (await db.query(ROW, [resultId])).rows[0];
      if (!r) return false;
      const ins = await q.query(
        "INSERT INTO record_locations (record_id, class, space_id, type, owner_id, source_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (record_id) DO NOTHING",
        [r.id, cls, r.space_id, r.type, r.owner_id, r.source_hash ?? null]);
      if (!ins.rowCount) return false;
      if (r.supersedes_id && r.attrs?.correction?.kind === "own_note") {
        const kind = (await q.query("SELECT kind FROM spaces WHERE id = $1", [r.space_id])).rows[0]?.kind;
        if (kind === "org")
          await enterOrg(q, app, { recordId: r.id, via: "version", caller, curator: false, human: false, extended: !!r.attrs?.extended_write,
                                   fromSpaceId: null, fromAudience: r.audience === "people" ? "people" : "space", supersedesId: r.supersedes_id });
        else await carryOrgReview(q, r.supersedes_id, r.id);
        await q.query("UPDATE record_locations SET source_hash = NULL, open_check = NULL WHERE record_id = $1", [r.supersedes_id]);
      }
      return true;
    });
  } catch (e) {
    if (e instanceof MemoryError && e.code === "in_progress") return false;
    throw e;
  }
  if (restored) {
    log.warn("correction_locator_restored", { record_id: resultId, class: cls });
    await app.queue.kick({ instance: app.instanceId, class: cls, record_id: resultId, lane: "index" }).catch(() => undefined);
  }
  return restored;
}

const ROLE_WORD: Record<CorrectionRole, string> = { author: "the record author", space_owner: "the space owner", participant: "a meeting participant", space_member: "a space member", reader: "a reader" };

const CLOSED_WHY: Record<ClosedWhy, string> = {
  script: SCRIPT_HINT,
  notebook_off: OFF_HINT,
  reads_closed: "this key reads closed records. Its records in the personal space are closed",
  service: "the service writes closed records to the personal space",
};

function appliedText(kind: CorrectionKind, o: { path: string | null; old: string; quote: QuoteFound | null; newerPath: string | null; targetPath: string; linkNote: string | null;
                                                fallback: OpenCheckFallback | null; closedWhy?: ClosedWhy | null; spaceOwner?: string | null }): string {
  const tail = o.linkNote ? ` ${o.linkNote}` : "";
  switch (kind) {
    case "extraction_error":
      return o.quote
        ? `Corrected in memory: a new event version at ${o.path} was verified against the transcript. Search no longer finds the previous version, but it is available by id ${o.old}. Tell the person that the correction was saved.${tail}`
        : `Corrected in memory: a new event version at ${o.path}. The correction was not verified against the transcript and is marked “Corrected by a participant, quote unverified”. Search no longer finds the previous version.${tail}`;
    case "wrong":
      return `Saved correction ${o.path} alongside the original record and made it searchable. The original record stays as written because it reflects what the source said.${tail}`;
    case "outdated":
      return o.newerPath
        ? `Marked the record as replaced by a newer record (${o.newerPath}). Search results do not show the mark yet. Answer using the newer record. The person can see the link on the record page in the workspace.${tail}`
        : `Marked record ${o.targetPath} as no longer valid. Correction ${o.path} is alongside the original record.${tail}`;
    case "own_note":
      if (o.fallback)
        return `The note was replaced, but the new text was saved as closed at ${o.path} because it appears to contain data unsuitable for open records (${o.fallback.kinds.join(", ")}). The previous open version is in Trash. A person can show the new version to agents in the workspace.`;
      if (o.closedWhy)
        return `The note was replaced and the new text was saved as closed: ${o.path} — ${CLOSED_WHY[o.closedWhy]}. The previous open version is in Trash. A person can show the new version to agents in the workspace.`;
      return `The note was replaced${o.spaceOwner ? ` by space owner ${o.spaceOwner}` : ""}. The new version is ${o.path}. The previous text is no longer searchable and remains in the record history.`;
  }
}

const PROPOSED_TEXT = (url: string | null) => `The correction was proposed and awaits approval. The record author, meeting participants and space owner can apply it directly and will see the proposal under “Record edits” in the workspace${url ? `: ${url}` : ""}. The proposal is visible to you and those who can approve it. Once approved, the correction and your name will be visible to anyone who can see the record.`;

// ---------------------------------------------------------------- memory_correct

export interface CorrectResult {
  correction_id: string; id: string; kind: CorrectionKind; status: "applied" | "proposed"; effect: Effect; result_id: string | null; result_path: string | null;
  quote_checked: boolean; already_known: boolean; by_role: CorrectionRole; workplace_url: string | null;
}

export async function correctTool(app: App, caller: Caller, a: CorrectArgs): Promise<{ result: CorrectResult; text: string }> {
  const who = correctionCaller(caller, a.origin);
  const t = await targetOf(app, caller, a.id);
  const guide = isSpaceGuideRow(t.rec);
  if (guide) {
    if (!guideEnabled(app))
      throw new MemoryError("forbidden", SPACE_GUIDE_CORRECT_REFUSAL, { hint: "Tell the person what to correct in the guide so the space owner can update it", details: { reason: "space_guide_workplace_only" } });
    guideCorrectionRule(a, who.origin, guideLimitsOf(app).max_tokens);
  }
  const targetFp = await targetFingerprint(app.db.records(t.rec.class, caller.scope), t.rec.id);
  if (!guide) validateCorrection({ ...a, origin: who.origin }, { type: t.rec.type, source_kind: t.rec.source_kind, parent_type: t.parentType });
  if (a.kind === "own_note") checkText(app, a.text!);
  const role = correctionRole({ me: who.personId, ownerId: t.rec.owner_id, spaceRole: t.space.role, participant: t.participant });
  if (a.kind === "own_note" && role === "space_owner" && who.origin !== "human")
    throw problem("origin_not_allowed", "As the space owner, you can replace someone else’s note only in the requesting person’s own words: origin human");
  const fields = canonicalFields(a.fields);
  const text = a.text?.trim() ? (a.kind === "own_note" ? a.text : a.text.trim()) : null;
  const quote = a.quote?.trim() || null;
  const dedupe = dedupeOf({ target: t.rec.id, kind: a.kind, by: who.personId, text, fields, quote, newer: a.newer_id ?? null });
  const known = await knownByDedupe(app, caller, t.rec.class, dedupe, a.kind);
  if (known) return knownAnswer(app, caller, known, guide ? t.space.slug : null);
  if (!t.rec.is_current) {
    let current: string | null = null;
    const next = (t.rec as RecordRow & { superseded_by_id?: string | null }).superseded_by_id;
    if (next) {
      await repairResultLocator(app, caller, t.rec.class, next);
      try { current = (await loadReadable(app, caller, next, t.spaces)).rec.id; } catch { current = null; }
    }
    throw problem("not_current", `This is a previous version of the record. Correct the current version${current ? ` (${current})` : ""}`, current ? { current_id: current } : {});
  }
  const status = guide ? guideProposalStatus(role, nonParticipant(app)) : decideStatus(a.kind, role, who.origin, nonParticipant(app));
  const newer = a.newer_id ? await newerOf(app, caller, t, a.newer_id, who.origin) : null;
  const match = quote ? await checkQuote(app, caller, t, quote) : null;
  const adm = await admitCorrection(app, caller, t, { kind: a.kind, text, fields, quote, link: !!newer });
  const draft: Draft = { id: newId(), kind: a.kind, text, fields, quote, match, newer, origin: who.origin, via: who.via, byPerson: who.personId, byRole: role, keyId: who.keyId, dedupe,
                         targetFp };
  if (status === "proposed") return propose(app, caller, t, draft, guide ? t.space.slug : null);
  return applyCorrection(app, caller, t, draft, { personId: who.personId, via: who.via, confirm: null }, adm);
}

export const SPACE_GUIDE_CORRECT_REFUSAL = "Only the space owner can change the “How we work” guide in the workspace. A correction cannot update it. Tell the space owner what to change";

export const nonParticipant = (app: App): "proposed" | "deny" => app.settings.get<string>("access.correct_non_participant", "proposed") === "deny" ? "deny" : "proposed";

interface Draft {
  id: string; kind: CorrectionKind; text: string | null; fields: CorrectFields | null; quote: string | null; match: QuoteFound | null;
  newer: { id: string; class: DataClass; path: string } | null; origin: "human" | "agent"; via: "mcp" | "workplace" | "plan"; byPerson: string; byRole: CorrectionRole;
  keyId: string | null; dedupe: string; targetFp: string;
  quoteDropped?: boolean;
}

async function knownAnswer(app: App, caller: Caller, row: CorrectionRow, guideSlug: string | null = null): Promise<{ result: CorrectResult; text: string }> {
  if (row.status === "applied" && row.result_id && row.cls) await repairResultLocator(app, caller, row.cls, row.result_id);
  const path = row.result_id ? await pathOf(app, caller, row.result_id) : null;
  const result: CorrectResult = { correction_id: row.id, id: row.target_id, kind: row.kind, status: row.status === "applied" ? "applied" : "proposed",
    effect: effectOf(row.kind, !!row.newer_id), result_id: path ? row.result_id : null, result_path: path, quote_checked: !!row.quote_match && !row.quote_match.without_quote,
    already_known: true, by_role: row.by_role,
    workplace_url: row.status === "proposed" ? (guideSlug ? guidePageUrl(app, guideSlug) : workplaceUrl(app, "/corrections")) : null };
  return { result, text: `This correction already exists (${row.status === "applied" ? "applied" : "awaiting a decision"}).` };
}

const MOVED = () => new MemoryError("in_progress", "The record is being moved or has changed. Try again in a minute", { retry_after: 10 });

async function recheckTarget(q: Pick<pg.PoolClient, "query">, db: Pick<pg.Pool, "query">, t: Target, fp?: string): Promise<void> {
  const loc = (await q.query("SELECT class, space_id, deleted FROM record_locations WHERE record_id = $1", [t.rec.id])).rows[0];
  if (!loc || loc.deleted) throw notFound();
  if (loc.class !== t.rec.class) throw new MemoryError("in_progress", "The record is moving between classes. Try again in a minute", { retry_after: 10 });
  if (loc.space_id !== t.rec.space_id) throw MOVED();
  const cur = (await db.query("SELECT deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden FROM records WHERE id = $1", [t.rec.id])).rows[0];
  if (!cur || cur.deleted) throw notFound();
  if (cur.hidden) throw new MemoryError("in_progress", "The record is being moved. Try again in a minute", { retry_after: 10 });
  if (fp !== undefined && await targetFingerprint(db, t.rec.id) !== fp) throw MOVED();
}

async function propose(app: App, caller: Caller, t: Target, d: Draft, guideSlug: string | null = null): Promise<{ result: CorrectResult; text: string }> {
  const db = app.db.recordsForWrite(t.rec.class, caller.scope);
  const ins = await withOwnerLocks(app, t.lockIds, async (q) => {
    await recheckTarget(q, db, t, d.targetFp);
    return db.query(
      `INSERT INTO record_corrections (id, target_id, kind, status, origin, via, by_person, by_role, key_id, text, fields, quote, quote_match, newer_id, target_fp, dedupe)
       VALUES ($1,$2,$3,'proposed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (dedupe) WHERE status IN ('proposed','applied') DO NOTHING`,
      [d.id, t.rec.id, d.kind, d.origin, d.via, d.byPerson, d.byRole, d.keyId, d.text, d.fields ? JSON.stringify(d.fields) : null, d.quote,
       d.match ? JSON.stringify(d.match) : null, d.newer?.id ?? null, d.targetFp, d.dedupe]);
  });
  if (!ins.rowCount) { const known = await knownByDedupe(app, caller, t.rec.class, d.dedupe); if (known) return knownAnswer(app, caller, known, guideSlug); }
  await audit(app, caller, { event_type: "write", class: t.rec.class, record_ids: [t.rec.id], space_id: t.space.id,
    details: { op: "correct", kind: d.kind, status: "proposed", via: d.via, origin: d.origin, by_role: d.byRole, correction_id: d.id, effect: effectOf(d.kind, !!d.newer),
               quote: d.match?.kind ?? "none", ...(t.rec.owner_id !== d.byPerson ? { author: t.rec.owner_id } : {}), ...(guideSlug ? { space_guide: true } : {}) } });
  const url = guideSlug ? guidePageUrl(app, guideSlug) : workplaceUrl(app, "/corrections");
  return { result: { correction_id: d.id, id: t.rec.id, kind: d.kind, status: "proposed", effect: effectOf(d.kind, !!d.newer), result_id: null, result_path: null,
                     quote_checked: !!d.match, already_known: false, by_role: d.byRole, workplace_url: url }, text: guideSlug ? GUIDE_PROPOSED_TEXT(url) : PROPOSED_TEXT(url) };
}

interface Decider { personId: string; via: "mcp" | "workplace"; confirm: { rowId: string; cls: DataClass; role: CorrectionRole } | null; planned?: { rowId: string; cls: DataClass } }
const BUSY = "55P03", DEADLOCK = "40P01", UNIQUE = "23505";
const pgCode = (e: unknown): unknown => (typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : null);

async function applyCorrection(app: App, caller: Caller, t: Target, d: Draft, decider: Decider, adm: Admission)
  : Promise<{ result: CorrectResult; text: string }> {
  const me = decider.personId, now = new Date();
  const effect = effectOf(d.kind, !!d.newer);
  const resultId = effect === "link" ? null : newId();
  const crossClass = d.kind === "own_note" && adm.cls !== t.rec.class;
  let superseded = false, trashed: string[] = [];
  const quoteMatch = d.match ? JSON.stringify(d.match) : (d.kind === "extraction_error" ? JSON.stringify({ without_quote: true }) : null);
  const values = [d.kind, d.origin, d.via, d.byPerson, d.byRole, d.keyId, quoteMatch, d.newer?.id ?? null, resultId, d.targetFp, d.dedupe,
                  decider.confirm ? me : null, decider.confirm ? now : null];
  const INSERT_APPLIED = `INSERT INTO record_corrections (id, target_id, kind, status, origin, via, by_person, by_role, key_id, quote_match, newer_id, result_id, target_fp, dedupe, decided_by, decided_at)
             VALUES ($1,$2,$3,'applied',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
  const maxTokens = app.settings.get<{ maximum: number }>("processing.chunk", { maximum: 480 }).maximum;
  let built: Built | null = null;
  try {
    await withOwnerLocks(app, t.lockIds, async (q) => {
      const db = app.db.recordsForWrite(t.rec.class, caller.scope);
      const loc = (await q.query("SELECT class, space_id, deleted FROM record_locations WHERE record_id = $1", [t.rec.id])).rows[0];
      if (!loc || loc.deleted) throw notFound();
      if (loc.class !== t.rec.class) throw new MemoryError("in_progress", "The record is moving between classes. Try again in a minute", { retry_after: 10 });
      if (!decider.confirm && !decider.planned && loc.space_id !== t.rec.space_id) throw MOVED();
      await tx(db, async (c) => {
        if (d.kind === "extraction_error" && t.rec.parent_id) await c.query("SELECT 1 FROM records WHERE id = $1 FOR KEY SHARE NOWAIT", [t.rec.parent_id]);
        const cur = (await c.query("SELECT * FROM records WHERE id = $1 FOR UPDATE NOWAIT", [t.rec.id])).rows[0] as RecordRow & { hidden_at: Date | null; deleted_at: Date | null; superseded_by_id: string | null } | undefined;
        if (!cur || cur.deleted_at) throw notFound();
        if (cur.hidden_at) throw new MemoryError("in_progress", "The record is being moved. Try again in a minute", { retry_after: 10 });
        if (!decider.confirm && !decider.planned && cur.space_id !== t.rec.space_id) throw MOVED();
        if (decider.confirm) {
          const row = (await c.query("SELECT status FROM record_corrections WHERE id = $1 FOR UPDATE", [decider.confirm.rowId])).rows[0];
          if (!row || row.status !== "proposed") throw problem("not_proposed", "The proposal has already been resolved or withdrawn");
          if (!cur.is_current || await targetFingerprint(c, t.rec.id) !== d.targetFp) {
            await c.query("UPDATE record_corrections SET status = 'superseded', text = NULL, fields = NULL, quote = NULL, decided_by = $2, decided_at = now() WHERE id = $1", [decider.confirm.rowId, me]);
            superseded = true;
            return;
          }
        } else if (decider.planned) {
          if (!cur.is_current || await targetFingerprint(c, t.rec.id) !== d.targetFp) throw problem("superseded", "The record changed after the plan was created. This change was skipped");
        } else if (!cur.is_current) throw problem("not_current", "This is an earlier version of the record and has already been corrected. Correct the current version", cur.superseded_by_id ? { current_id: cur.superseded_by_id } : {});
        built = await withResultClient(c, crossClass ? crossClassPool(app, caller) : null, (w) =>
          buildResult(app, q, c, w, t, cur, d, { resultId, me, decider, now, maxTokens, cls: adm.cls, fallback: adm.fallback, cross: crossClass, mark: adm.extended ?? null,
                                                 org: t.space.kind === "org" ? { caller, curator: isOrgCurator(caller, t.spaces), human: isHumanSession(caller) && !decider.planned } : undefined }));
        if (decider.confirm) {
          await c.query(`UPDATE record_corrections SET status = 'applied', text = NULL, fields = NULL, quote = NULL, quote_match = $5, result_id = $2, decided_by = $3, decided_at = $4 WHERE id = $1`,
            [decider.confirm.rowId, resultId, me, now, quoteMatch]);
        } else if (decider.planned) {
          const upd = await c.query(`UPDATE record_corrections SET status = 'applied', text = NULL, fields = NULL, quote = NULL, quote_match = $5, result_id = $2, by_role = $3, key_id = $4
                                     WHERE id = $1 AND status = 'planned'`, [d.id, resultId, d.byRole, d.keyId, quoteMatch])
            .catch((e: unknown) => { if (pgCode(e) === UNIQUE) throw problem("not_planned", "This correction already exists. This change was skipped"); throw e; });
          if (!upd.rowCount) throw problem("not_planned", "The draft plan is no longer awaiting application");
        } else if (!crossClass) await c.query(INSERT_APPLIED, [d.id, t.rec.id, ...values]);
        if (crossClass) {
          await c.query("SELECT mark_deleted_chain($1, $2, make_interval(days => $3::int))", [t.rec.id, me, trashDaysOf(app)]);
          trashed = (await c.query("SELECT id FROM records WHERE deleted_batch = $1", [t.rec.id])).rows.map((r) => r.id as string);
        }
      });
      if (trashed.length) await syncDeletionMarks(q, db, trashed);
    });
    const b0 = built as Built | null;
    if (crossClass && b0) {
      await tx(app.db.recordsForWrite("closed", caller.scope), async (c) => {
        await c.query("UPDATE records SET hidden_at = NULL WHERE id = $1", [b0.id]);
        if (b0.chunk) await c.query("INSERT INTO chunks (id, record_id, ordinal, text, token_count, space_id, audience, type, occurred_at) VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8)",
          [newId(), b0.id, b0.chunk.text, b0.chunk.tokens, b0.chunk.space, b0.chunk.audience, b0.chunk.type, b0.chunk.occurred]);
        await c.query(INSERT_APPLIED, [d.id, t.rec.id, ...values]);
      }).catch((e: unknown) => log.warn("correction_reveal_failed", { correction_id: d.id, error: String((e as Error)?.message ?? e).slice(0, 160) }));
    }
  } catch (e) {
    if (pgCode(e) === BUSY || pgCode(e) === DEADLOCK) throw new MemoryError("in_progress", "The record is being edited. Try again", { retry_after: 5 });
    if (e instanceof MemoryError && e.code === "invalid_argument" && (e.extra.details as Record<string, unknown> | undefined)?.reason === "not_current" && decider.confirm === null && !decider.planned) {
      const fresh = await knownByDedupe(app, caller, t.rec.class, d.dedupe, d.kind);
      if (fresh) return knownAnswer(app, caller, fresh);
    }
    throw e;
  }
  if (superseded) throw problem("superseded", "The record changed after the proposal was submitted. The proposal is out of date. If the correction is still needed, propose it again on the current version");
  const b = built as Built | null;
  const relation = relationOf(d.kind);
  const correctionId = decider.confirm?.rowId ?? d.id;
  const rowCls: DataClass = crossClass ? "closed" : t.rec.class;
  const actor: LinkActor = d.origin === "human" || decider.via === "workplace" ? { kind: "human", personId: me } : { kind: "agent", personId: me };
  const { linkId, linkNote } = relation
    ? await putCorrectionLink(app, caller, { rowId: correctionId, rowCls, relation, src: d.newer?.id ?? resultId!, dst: t.rec.id, actor, workplace: decider.via === "workplace" })
    : { linkId: null, linkNote: null };
  if (relation && !linkId && effect === "link" && !decider.confirm) {
    await app.db.recordsForWrite(rowCls, caller.scope).query("UPDATE record_corrections SET status = 'cancelled' WHERE id = $1 AND status = 'applied'", [correctionId])
      .catch((e: unknown) => log.warn("correction_cancel_failed", { correction_id: correctionId, error: String((e as Error)?.message ?? e).slice(0, 160) }));
    throw new MemoryError("in_progress", "Could not save the “replaced” link because the record is being edited. Nothing changed. Try again in a minute", { retry_after: 30 });
  }
  if (b) await app.queue.kick({ instance: app.instanceId, class: b.cls, record_id: b.id, lane: "index" });
  const recordIds = [t.rec.id, ...(resultId ? [resultId] : []), ...(d.newer && t.rec.owner_id === me ? [d.newer.id] : [])];
  if (decider.confirm) {
    await audit(app, caller, { event_type: "confirmation", class: t.rec.class, record_ids: recordIds, space_id: t.space.id,
      details: { op: "correct_confirm", correction_id: correctionId, kind: d.kind, by_role: d.byRole, decider_role: decider.confirm.role, effect, ...(linkId ? { link_id: linkId, relation } : {}),
                 ...(d.quoteDropped ? { quote_dropped: true } : {}), ...(t.rec.owner_id !== me ? { author: t.rec.owner_id } : {}), ...markEvent(adm.extended) } });
  } else {
    await audit(app, caller, { event_type: "write", class: t.rec.class, record_ids: recordIds, space_id: t.space.id,
      details: { op: "correct", kind: d.kind, status: "applied", via: d.via, origin: d.origin, by_role: d.byRole, correction_id: correctionId, effect,
                 quote: d.match?.kind ?? "none", ...(linkId ? { link_id: linkId, relation } : {}), ...(adm.fallback && crossClass ? { open_check_fallback: true } : {}),
                 ...(adm.closedWhy && crossClass ? { closed_why: adm.closedWhy } : {}), ...(t.rec.owner_id !== me ? { author: t.rec.owner_id } : {}), ...markEvent(adm.extended) } });
  }
  const result: CorrectResult = { correction_id: correctionId, id: t.rec.id, kind: d.kind, status: "applied", effect, result_id: resultId, result_path: b?.path ?? null,
    quote_checked: !!d.match, already_known: false, by_role: d.byRole, workplace_url: null };
  return { result, text: appliedText(d.kind, { path: b?.path ?? null, old: t.rec.id, quote: d.match, newerPath: d.newer?.path ?? null,
                                         targetPath: recordPath(t.space.slug, t.rec.type, t.rec.occurred_at, t.rec.id), linkNote,
                                         fallback: crossClass ? adm.fallback : null, closedWhy: crossClass ? adm.closedWhy : null,
                                         spaceOwner: d.kind === "own_note" && d.byRole === "space_owner" ? caller.person!.login : null }) + (adm.extended ? MARKED_TAIL : "") };
}

async function putCorrectionLink(app: App, caller: Caller, o: { rowId: string; rowCls: DataClass; relation: LinkRelation; src: string; dst: string; actor: LinkActor; workplace: boolean })
  : Promise<{ linkId: string | null; linkNote: string | null }> {
  const status: "active" | "confirmed" = o.workplace && o.actor.kind === "human" ? "confirmed" : "active";
  try {
    const out = await insertLinkRetrying({ control: app.db.control, records: (cls) => app.db.records(cls, SCOPE_SYSTEM), actor: o.actor,
      quoteThreshold: 0.9, mayApply: () => true, openCheck: async () => "pass" }, { srcId: o.src, dstId: o.dst, relation: o.relation, status });
    await app.db.recordsForWrite(o.rowCls, caller.scope).query("UPDATE record_corrections SET link_id = $2 WHERE id = $1", [o.rowId, out.id]);
    return { linkId: out.id, linkNote: !out.created && out.status === "rejected" ? "A person already rejected this link, so it was not restored." : null };
  } catch (e) {
    log.warn("correction_link_failed", { correction_id: o.rowId, relation: o.relation, error: String((e as Error)?.message ?? e).slice(0, 160) });
    return { linkId: null, linkNote: "The link to the corrected record has not been saved yet. A person can add it by selecting “Confirm” in the workspace." };
  }
}

function crossClassPool(app: App, caller: Caller): pg.Pool {
  void app.db.records("closed", SCOPE_SYSTEM);
  return app.db.recordsForWrite("closed", caller.scope);
}

const trashDaysOf = (app: App): number => { const n = Math.round(Number(app.settings.get("access.trash_days", 30))); return Number.isFinite(n) && n >= 1 ? n : 30; };

interface BuildOpts {
  me: string; decider: Decider; now: Date; maxTokens: number; cls: DataClass; fallback: OpenCheckFallback | null;
  cross: boolean;
  mark?: ExtendedMark | null;
  org?: { caller: Caller; curator: boolean; human: boolean };
}

interface Built {
  id: string; cls: DataClass; path: string;
  chunk: { text: string; tokens: number; space: string; audience: string; type: string; occurred: Date } | null;
}

async function withResultClient<T>(c: pg.PoolClient, resultDb: pg.Pool | null, fn: (w: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!resultDb) return fn(c);
  const w = await resultDb.connect();
  try { return await fn(w); } finally { w.release(); }
}

async function buildResult(app: App, q: pg.PoolClient, c: pg.PoolClient, w: pg.PoolClient, t: Target, cur: RecordRow, d: Draft,
                           o: BuildOpts & { resultId: string | null }): Promise<Built | null> {
  if (!o.resultId) return null;
  const confirmedBy = d.origin === "human" ? o.me : null;
  const meta = { kind: d.kind, by: d.byPerson, by_role: d.byRole, at: o.now.toISOString(), via: d.via, origin: d.origin, correction_id: o.decider.confirm?.rowId ?? d.id,
                 ...(o.decider.confirm ? { confirmed_by: o.me } : {}), ...(d.kind === "extraction_error" && !d.match ? { without_quote: true } : {}) };
  const cross = o.cross;
  let n: { type: string; parent: string | null; sourceKind: string; method: string; occurred: Date; title: string | null; text: string; eventKind: string | null;
           version: number; supersedes: string | null; attrs: Record<string, unknown>; eventKey: string | null; locator: Record<string, unknown> | null; hash: Buffer | null };
  switch (d.kind) {
    case "extraction_error": {
      const m = mergeEventFields({ ...cur, text: t.text }, d.fields, d.quote, d.match);
      n = { type: "event", parent: cur.parent_id, sourceKind: "correction", method: "stated_by_human", occurred: cur.occurred_at, title: m.title, text: m.text, eventKind: cur.event_kind,
            version: cur.version + 1, supersedes: cur.id, attrs: { ...m.attrs, correction: meta }, eventKey: cur.event_key ?? cur.id,
            locator: d.match ? { time_from: d.match.time_from, time_to: d.match.time_to } : cur.locator, hash: null };
      break;
    }
    case "wrong": case "outdated": {
      const slug = t.space.slug, path = recordPath(slug, cur.type, cur.occurred_at, cur.id);
      n = { type: "note", parent: cur.id, sourceKind: "correction", method: "stated_by_human", occurred: o.now,
            title: annotationTitle(d.kind, cur.title),
            text: `${d.text ?? ""}\n\n${d.kind === "wrong" ? "Corrects record" : "No longer valid"}: ${path}`.trim(), eventKind: null, version: 1, supersedes: null,
            attrs: { correction: meta }, eventKey: null, locator: null, hash: null };
      break;
    }
    case "own_note": {
      const title = d.fields?.title ?? cur.title;
      const kindOf = cur.type === "note" ? "note" : (cur.event_kind ?? "fact");
      n = { type: cur.type, parent: null, sourceKind: "agent", method: d.origin === "human" ? "stated_by_human" : "inferred_by_agent", occurred: cur.occurred_at, title,
            text: d.text ?? "", eventKind: cur.event_kind, version: cross ? 1 : cur.version + 1, supersedes: cross ? null : cur.id,
            attrs: { correction: meta, ...(o.fallback ? { open_check_fallback: o.fallback } : {}), ...(cross ? { replaces_open: cur.id, ...await crossDerived(q, c, w, cur) } : {}) },
            eventKey: cross ? null : cur.event_key ?? null, locator: null, hash: sourceHash(Buffer.from(d.text ?? "", "utf8"), { title: title ?? "", kind: kindOf, type: cur.type }) };
      break;
    }
  }
  n.attrs = { ...n.attrs, ...markAttrs(o.mark) };
  const cls = d.kind === "own_note" ? o.cls : cur.class;
  const tokens = estimateTokens(n.text);
  const chunk = tokens <= o.maxTokens && n.text.trim()
    ? { text: [n.title, n.text].filter(Boolean).join("\n"), tokens, space: cur.space_id, audience: cur.audience, type: n.type, occurred: n.occurred } : null;
  try {
    if (cross) await w.query("BEGIN");
    await q.query("INSERT INTO record_locations (record_id, class, space_id, type, owner_id, source_hash, open_check) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [o.resultId, cls, cur.space_id, n.type, cur.owner_id, n.hash, o.fallback ? JSON.stringify(o.fallback) : null]);
    if (d.kind === "own_note" && o.org)
      await enterOrg(q, app, { recordId: o.resultId, via: "version", caller: o.org.caller, curator: o.org.curator, human: o.org.human, extended: !!o.mark,
                               fromSpaceId: null, fromAudience: cur.audience === "people" ? "people" : "space", supersedesId: cur.id });
    else if (d.kind === "own_note") await carryOrgReview(q, cur.id, o.resultId, { nextOutsideOrg: true });
    await w.query(
      `INSERT INTO records (id, type, class, space_id, audience, owner_id, source_kind, source_ref, parent_id, locator, method, origin, confirmed_at, confirmed_by, occurred_at,
                            title, summary_line, event_kind, domain_tags, token_count, source_hash, version, supersedes_id, processor, attrs, event_key, hidden_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [o.resultId, n.type, cls, cur.space_id, cur.audience, cur.owner_id, n.sourceKind, n.parent, n.locator ? JSON.stringify(n.locator) : null, n.method, d.origin,
       confirmedBy ? o.now : null, confirmedBy, n.occurred, n.title, summaryOf(n.type, n.text, d.fields?.statement), n.eventKind, cur.domain_tags ?? [], tokens, n.hash,
       n.version, n.supersedes, JSON.stringify({ by: "memory_correct", v: 1 }), JSON.stringify(n.attrs), n.type === "event" ? n.eventKey : null, cross ? o.now : null]);
    await w.query("INSERT INTO record_content (record_id, text) VALUES ($1,$2)", [o.resultId, n.text]);
    if (!cross) {
      const entityKeep = d.kind === "extraction_error" ? " AND NOT (role = 'mentioned' AND method = 'extracted_by_model')" : "";
      await w.query("INSERT INTO record_people (record_id, person_id) SELECT $1, person_id FROM record_people WHERE record_id = $2 ON CONFLICT DO NOTHING", [o.resultId, cur.id]);
      await w.query("INSERT INTO record_placements (record_id, space_id, placed_by) SELECT $1, space_id, placed_by FROM record_placements WHERE record_id = $2 ON CONFLICT DO NOTHING", [o.resultId, cur.id]);
      await w.query(`INSERT INTO record_entities (record_id, entity_id, role, method, confidence, locator) SELECT $1, entity_id, role, method, confidence, locator FROM record_entities WHERE record_id = $2${entityKeep} ON CONFLICT DO NOTHING`, [o.resultId, cur.id]);
    } else {
      for (const p of (await c.query("SELECT person_id FROM record_people WHERE record_id = $1", [cur.id])).rows) await w.query("INSERT INTO record_people (record_id, person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [o.resultId, p.person_id]);
      for (const e of (await c.query("SELECT entity_id, role, method, confidence FROM record_entities WHERE record_id = $1", [cur.id])).rows)
        await w.query("INSERT INTO record_entities (record_id, entity_id, role, method, confidence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [o.resultId, e.entity_id, e.role, e.method, e.confidence]);
    }
    await w.query("INSERT INTO record_stages (record_id, stage) VALUES ($1,'indexed')", [o.resultId]);
    if (chunk && !cross)
      await w.query("INSERT INTO chunks (id, record_id, ordinal, text, token_count, space_id, audience, type, occurred_at) VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8)",
        [newId(), o.resultId, chunk.text, chunk.tokens, chunk.space, chunk.audience, chunk.type, chunk.occurred]);
    if (cross) await commitOrThrow(w);
  } catch (e) {
    if (cross) await w.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  if (n.supersedes) {
    await c.query("UPDATE records SET is_current = false, superseded_by_id = $1 WHERE id = $2", [o.resultId, n.supersedes]);
    await c.query("UPDATE record_corrections SET status = 'superseded', text = NULL, fields = NULL, quote = NULL WHERE target_id = $1 AND status IN ('planned','proposed') AND id <> $2",
      [n.supersedes, o.decider.confirm?.rowId ?? d.id]);
    await c.query("UPDATE record_stages SET status = 'skipped', last_error = $2, updated_at = now() WHERE record_id = $1 AND status IN ('pending','failed')", [n.supersedes, CORRECTED_STAGE_NOTE]);
    if (d.kind === "own_note") await q.query("UPDATE record_locations SET source_hash = NULL, open_check = NULL WHERE record_id = $1", [n.supersedes]);
  }
  const slug = t.space.slug;
  return { id: o.resultId, cls, path: recordPath(slug, n.type, n.occurred, o.resultId), chunk: cross ? chunk : null };
}

async function crossDerived(q: pg.PoolClient, c: pg.PoolClient, w: pg.PoolClient, cur: RecordRow): Promise<Record<string, unknown>> {
  if (cur.class !== "open") throw new Error(`crossDerived: a version of your own note can only move from open to closed. The target is ${String(cur.class)}`);
  const rows = (await c.query(`${CHAIN_TREE} SELECT r.id, r.type FROM records r JOIN tree ON tree.id = r.id`, [cur.id])).rows as Array<{ id: string; type: string }>;
  const fromMeeting = await meetingOrigin({ tree: c, control: q, records: (cls) => (cls === "open" ? c : w) }, rows, cur.id);
  const meeting = fromMeeting ? { meeting_origin: true } : {};
  const old = await readBasis(c, q, cur.id);
  if (!old.declared && !old.linked && !old.missing) return meeting;
  const stored = cur.attrs?.derivation === "retelling" || cur.attrs?.derivation === "synthesis" ? cur.attrs.derivation : null;
  const n = Math.max(old.declared, old.linked);
  return { ...meeting, derivation: stored ?? (n > 0 ? defaultDerivation(n) : "retelling"), ...(old.declared ? { derived_declared: old.declared } : {}), derived_lost: true,
           ...(fromMeeting ? {} : { derived_lost_cause: DERIVED_LOST_CLASS_CHANGE }) };
}

function summaryOf(type: string, text: string, statement?: string): string | null {
  const line = (statement ?? (type === "event" ? parseStatement(text) ?? text : text)).replace(/\s+/g, " ").trim();
  return line.length > 160 ? line.slice(0, 157) + "…" : line || null;
}

async function rowById(app: App, caller: Caller, id: string): Promise<CorrectionRow | null> {
  for (const cls of caller.scope.classes) {
    const row = (await app.db.records(cls, caller.scope).query<CorrectionRow>("SELECT * FROM record_corrections WHERE id = $1 AND status <> 'planned'", [id])).rows[0];
    if (row) return { ...row, cls };
  }
  return null;
}

function decidesRow(app: App, row: Pick<CorrectionRow, "by_person" | "via" | "kind">, ctx: { t: Target; role: CorrectionRole }, me: string): boolean {
  return isSpaceGuideRow(ctx.t.rec) ? guideEnabled(app) && guideDecides(ctx.t.space, me, row) : row.by_person !== me && canDecide(row.kind, ctx.role);
}

async function decisionContext(app: App, caller: Caller, row: CorrectionRow): Promise<{ t: Target; role: CorrectionRole }> {
  const t = await targetOf(app, caller, row.target_id);
  return { t, role: correctionRole({ me: caller.person!.id, ownerId: t.rec.owner_id, spaceRole: t.space.role, participant: t.participant }) };
}

async function readsParent(app: App, caller: Caller, t: Target): Promise<boolean> {
  if (!t.rec.parent_id) return false;
  try { await loadReadable(app, caller, t.rec.parent_id, t.spaces); return true; } catch { return false; }
}

const proposalMark = (app: App, row: CorrectionRow, t: Target): Promise<ExtendedMark | null> =>
  proposalExtendedMark(app, { cls: t.rec.class, keyId: row.key_id, link: !!row.newer_id });

const humanOnly = (app: App, caller: Caller) => requireHuman(app, caller, "Decide on corrections", { path: "/corrections", section: "Record edits" });

export async function confirmCorrection(app: App, caller: Caller, id: string) {
  await humanOnly(app, caller);
  const row = await rowById(app, caller, id);
  if (!row) throw notFound();
  const me = caller.person!.id;
  const { t, role } = await decisionContext(app, caller, row);
  if (isSpaceGuideRow(t.rec)) {
    if (!decidesRow(app, row, { t, role }, me)) throw notFound();
    throw new MemoryError("forbidden", GUIDE_CONFIRM_REFUSAL, { details: { reason: "space_guide_apply_on_page", space: t.space.slug } });
  }
  if (row.status === "proposed") {
    if (row.by_person === me || !canDecide(row.kind, role)) throw notFound();
    const quoted = !!row.quote && !!row.quote_match && !row.quote_match.without_quote;
    const keepQuote = quoted && await readsParent(app, caller, t);
    const quote = keepQuote ? row.quote : null;
    const adm0 = await admitCorrection(app, caller, t, { kind: row.kind, text: row.text, fields: row.fields, quote, newer: !!row.newer_id });
    const adm = { ...adm0, extended: adm0.extended ?? await proposalMark(app, row, t) };
    const newer = row.newer_id ? await newerOf(app, caller, t, row.newer_id, row.origin) : null;
    const d: Draft = { id: row.id, kind: row.kind, text: row.text, fields: row.fields, quote, match: keepQuote ? row.quote_match : null, quoteDropped: quoted && !keepQuote,
                       newer, origin: row.origin, via: "workplace", byPerson: row.by_person, byRole: row.by_role, keyId: row.key_id, dedupe: row.dedupe, targetFp: row.target_fp };
    await applyCorrection(app, caller, t, d, { personId: me, via: "workplace", confirm: { rowId: row.id, cls: row.cls!, role } }, adm);
    return correctionView(app, caller, (await rowById(app, caller, id))!, { t, role });
  }
  const relation = relationOf(row.kind);
  if (row.status !== "applied" || !relation) throw problem("not_proposed", "There is nothing to confirm here. The correction has already been resolved");
  if (!canDecide(row.kind, role) && row.by_person !== me) throw notFound();
  const own = t.rec.owner_id === me;
  if (!row.link_id) {
    const src = row.newer_id ?? row.result_id;
    if (!src) throw problem("not_proposed", "There is nothing to confirm here. The correction has already been resolved");
    const { linkId } = await putCorrectionLink(app, caller, { rowId: row.id, rowCls: row.cls!, relation, src, dst: row.target_id, actor: { kind: "human", personId: me }, workplace: true });
    if (!linkId) throw new MemoryError("in_progress", "Could not save the link. Try again in a minute", { retry_after: 30 });
    await audit(app, caller, { event_type: "confirmation", class: t.rec.class, record_ids: own ? [src, row.target_id] : [row.target_id], space_id: t.space.id,
      details: { op: "link_confirm", link_id: linkId, relation, correction_id: row.id, decider_role: role, ...(own ? {} : { author: t.rec.owner_id }) } });
    return correctionView(app, caller, (await rowById(app, caller, id))!, { t, role });
  }
  const link = await setLinkStatus(app.db.control, row.link_id, "confirmed", { kind: "human", personId: me }, ["active"]);
  if (!link) throw problem("not_proposed", "A person has already confirmed or rejected the link");
  await audit(app, caller, { event_type: "confirmation", class: t.rec.class, record_ids: own ? [link.src_id, link.dst_id] : [t.rec.id], space_id: t.space.id,
    details: { op: "link_confirm", link_id: link.id, relation: link.relation, correction_id: row.id, decider_role: role, ...(own ? {} : { author: t.rec.owner_id }) } });
  return correctionView(app, caller, row, { t, role });
}

export async function rejectCorrection(app: App, caller: Caller, id: string) {
  await humanOnly(app, caller);
  const row = await rowById(app, caller, id);
  if (!row) throw notFound();
  const me = caller.person!.id;
  const { t, role } = await decisionContext(app, caller, row);
  const guide = isSpaceGuideRow(t.rec);
  if (row.status === "proposed") {
    if (!decidesRow(app, row, { t, role }, me)) throw notFound();
    const upd = await app.db.recordsForWrite(row.cls!, caller.scope).query(
      "UPDATE record_corrections SET status = 'rejected', text = NULL, fields = NULL, quote = NULL, decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed'", [id, me]);
    if (!upd.rowCount) throw problem("not_proposed", "The proposal has already been resolved or withdrawn");
    await audit(app, caller, { event_type: "confirmation", class: t.rec.class, record_ids: [t.rec.id], space_id: t.space.id,
      details: { op: "correct_reject", correction_id: id, kind: row.kind, by_role: row.by_role, decider_role: role, ...(t.rec.owner_id !== me ? { author: t.rec.owner_id } : {}) } });
    return correctionView(app, caller, (await rowById(app, caller, id))!, { t, role });
  }
  if (row.status !== "applied") throw problem("not_proposed", "The correction has already been resolved or withdrawn");
  if (guide) throw problem("not_rejectable", GUIDE_UNDO_REFUSAL);
  if (row.kind === "extraction_error" || row.kind === "own_note") throw problem("not_rejectable", "A new version cannot be rejected. Correct it again with memory_correct or select “Correct” on the record page");
  if (role !== "author" && role !== "space_owner") throw notFound();
  return undoApplied(app, caller, row, t, role, "correct_reject");
}

export async function withdrawCorrection(app: App, caller: Caller, id: string) {
  await humanOnly(app, caller);
  const row = await rowById(app, caller, id);
  if (!row || row.by_person !== caller.person!.id) throw notFound();
  const ctx = await decisionContext(app, caller, row).catch((e: unknown) => {
    if (row.status === "proposed" && e instanceof MemoryError && e.code === "not_found") return null;
    throw e;
  });
  if (row.status === "proposed") {
    const upd = await app.db.recordsForWrite(row.cls!, caller.scope).query(
      "UPDATE record_corrections SET status = 'withdrawn', text = NULL, fields = NULL, quote = NULL, decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed'", [id, caller.person!.id]);
    if (!upd.rowCount) throw problem("not_proposed", "The proposal has already been resolved");
    await audit(app, caller, { event_type: "write", class: ctx ? ctx.t.rec.class : row.cls!, record_ids: ctx ? [ctx.t.rec.id] : [], space_id: ctx?.t.space.id ?? null,
                               details: { op: "correct_withdraw", correction_id: id, kind: row.kind, ...(ctx ? {} : { target_hidden: true }) } });
    const fresh = (await rowById(app, caller, id))!;
    return ctx ? correctionView(app, caller, fresh, ctx) : blindView(app, fresh);
  }
  if (!ctx) throw notFound();
  if (row.status === "applied" && isSpaceGuideRow(ctx.t.rec)) throw problem("not_rejectable", GUIDE_UNDO_REFUSAL);
  if (row.status !== "applied" || row.kind === "extraction_error" || row.kind === "own_note") throw problem("not_rejectable", "You can withdraw a proposal or your own “Wrong” or “Out of date” feedback");
  return undoApplied(app, caller, row, ctx.t, ctx.role, "correct_withdraw");
}

async function undoApplied(app: App, caller: Caller, row: CorrectionRow, t: Target, role: CorrectionRole, op: "correct_reject" | "correct_withdraw") {
  const me = caller.person!.id;
  const status = op === "correct_reject" ? "rejected" : "withdrawn";
  let linkStatus: LinkStatus | null = null;
  await withOwnerLocks(app, t.lockIds, async (q) => {
    if (row.link_id) {
      const shared = op === "correct_withdraw" && await linkSharedByOthers(app, caller, row);
      const link = shared ? null : await setLinkStatusOn(q, row.link_id, "rejected", { kind: "human", personId: me }, ["active", "confirmed"]);
      linkStatus = link?.status ?? (await q.query("SELECT status FROM record_links WHERE id = $1", [row.link_id])).rows[0]?.status ?? null;
    }
    const resultCls = row.result_id ? (await q.query("SELECT class FROM record_locations WHERE record_id = $1", [row.result_id])).rows[0]?.class as DataClass | undefined : undefined;
    const notCurrent = (db: Pick<pg.Pool, "query">) =>
      db.query("UPDATE records SET is_current = false WHERE id = $1 AND source_kind = 'correction' AND parent_id = $2", [row.result_id, row.target_id]);
    if (resultCls && resultCls !== row.cls) await notCurrent(app.db.recordsForWrite(resultCls, caller.scope));
    await tx(app.db.recordsForWrite(row.cls!, caller.scope), async (c) => {
      const upd = await c.query(`UPDATE record_corrections SET status = '${status}', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'applied'`, [row.id, me]);
      if (!upd.rowCount) throw problem("not_proposed", "The correction has already been resolved or withdrawn");
      if (resultCls === row.cls) await notCurrent(c);
    });
  });
  await audit(app, caller, { event_type: "confirmation", class: t.rec.class, record_ids: [t.rec.id, ...(row.result_id ? [row.result_id] : [])], space_id: t.space.id,
    details: { op, correction_id: row.id, kind: row.kind, by_role: row.by_role, decider_role: role, ...(row.link_id ? { link_id: row.link_id, link_status: linkStatus } : {}),
               ...(t.rec.owner_id !== me ? { author: t.rec.owner_id } : {}) } });
  return correctionView(app, caller, (await rowById(app, caller, row.id))!, { t, role });
}

async function linkSharedByOthers(app: App, caller: Caller, row: CorrectionRow): Promise<boolean> {
  for (const cls of caller.scope.classes) {
    const other = await app.db.records(cls, caller.scope).query("SELECT 1 FROM record_corrections WHERE link_id = $1 AND status = 'applied' AND id <> $2 LIMIT 1", [row.link_id, row.id]);
    if (other.rowCount) return true;
  }
  return false;
}

export async function cancelPlannedRows(app: App, caller: Caller, o: { planIds: string[] }): Promise<void> {
  if (!o.planIds.length || !caller.person) return;
  for (const cls of caller.scope.classes) {
    try {
      await app.db.recordsForWrite(cls, caller.scope).query(
        "UPDATE record_corrections SET status = 'cancelled', text = NULL, fields = NULL, quote = NULL WHERE by_person = $1 AND status = 'planned' AND plan_id = ANY($2::uuid[])",
        [caller.person.id, o.planIds]);
    } catch (e) {
      log.warn("planned_cancel_failed", { class: cls, plans: o.planIds.length, error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
}

export async function plannedStatus(app: App, caller: Caller, o: { rowId: string; cls: DataClass; planId: string }): Promise<CorrectionStatus | null> {
  const row = (await app.db.recordsForWrite(o.cls, caller.scope).query("SELECT status FROM record_corrections WHERE id = $1 AND by_person = $2 AND plan_id = $3",
    [o.rowId, caller.person!.id, o.planId])).rows[0];
  return (row?.status as CorrectionStatus | undefined) ?? null;
}

export async function plannedEffects(app: App, caller: Caller, cls: DataClass, rowIds: string[]): Promise<Map<string, { status: CorrectionStatus; actors: string[] | null }>> {
  const out = new Map<string, { status: CorrectionStatus; actors: string[] | null }>();
  if (!rowIds.length || !caller.scope.classes.includes(cls)) return out;
  for (const r of (await app.db.records(cls, caller.scope).query("SELECT id, status, fields FROM record_corrections WHERE id = ANY($1::uuid[]) AND by_person = $2",
    [rowIds, caller.person!.id])).rows) {
    const actors = Array.isArray(r.fields?.actors) ? (r.fields.actors as unknown[]).map(String) : null;
    out.set(r.id as string, { status: r.status as CorrectionStatus, actors });
  }
  return out;
}

export async function applyPlannedCorrection(app: App, caller: Caller, o: { rowId: string; cls: DataClass; planId: string }): Promise<{ status: "applied" | "proposed" }> {
  const who = correctionCaller(caller, "human");
  const db = app.db.recordsForWrite(o.cls, caller.scope);
  const row = (await db.query<CorrectionRow>("SELECT * FROM record_corrections WHERE id = $1 AND by_person = $2 AND plan_id = $3", [o.rowId, who.personId, o.planId])).rows[0];
  if (!row) throw notFound();
  if (row.status === "applied" || row.status === "proposed") return { status: row.status };
  if (row.status !== "planned") throw problem("not_planned", "The draft plan is no longer awaiting application");
  const t = await targetOf(app, caller, row.target_id);
  if (!t.rec.is_current) throw problem("not_current", "The event has already been corrected. This change was skipped");
  validateCorrection({ kind: "extraction_error", fields: row.fields ?? undefined, origin: "human" }, { type: t.rec.type, source_kind: t.rec.source_kind, parent_type: t.parentType });
  const role = correctionRole({ me: who.personId, ownerId: t.rec.owner_id, spaceRole: t.space.role, participant: t.participant });
  const status = decideStatus("extraction_error", role, "human", nonParticipant(app));
  if (await targetFingerprint(app.db.records(t.rec.class, caller.scope), t.rec.id) !== row.target_fp) throw problem("superseded", "The record changed after the plan was created. This change was skipped");
  const adm0 = await admitCorrection(app, caller, t, { kind: "extraction_error", text: null, fields: row.fields, quote: null });
  const composed = adm0.extended ? null : await proposalMark(app, row, t);
  const adm: Admission = { ...adm0, extended: adm0.extended ?? composed };
  const keyId = composed ? row.key_id : who.keyId;
  const known = await knownByDedupe(app, caller, t.rec.class, row.dedupe);
  if (known) {
    await db.query("UPDATE record_corrections SET status = 'cancelled', text = NULL, fields = NULL, quote = NULL WHERE id = $1 AND status = 'planned'", [row.id]);
    return { status: known.status === "applied" ? "applied" : "proposed" };
  }
  if (status === "proposed") return proposePlanned(app, caller, t, row, role, keyId);
  const draft: Draft = { id: row.id, kind: "extraction_error", text: null, fields: row.fields, quote: null, match: null, newer: null, origin: "human", via: "plan",
                         byPerson: who.personId, byRole: role, keyId, dedupe: row.dedupe, targetFp: row.target_fp };
  await applyCorrection(app, caller, t, draft, { personId: who.personId, via: "workplace", confirm: null, planned: { rowId: row.id, cls: o.cls } }, adm);
  return { status: "applied" };
}

async function proposePlanned(app: App, caller: Caller, t: Target, row: CorrectionRow, role: CorrectionRole, keyId: string | null): Promise<{ status: "proposed" }> {
  const db = app.db.recordsForWrite(t.rec.class, caller.scope);
  try {
    await withOwnerLocks(app, t.lockIds, async (q) => {
      await recheckTarget(q, db, t);
      if (await targetFingerprint(db, t.rec.id) !== row.target_fp) throw problem("superseded", "The record changed after the plan was created. This change was skipped");
      const upd = await db.query("UPDATE record_corrections SET status = 'proposed', by_role = $2, key_id = $3 WHERE id = $1 AND status = 'planned'", [row.id, role, keyId]);
      if (!upd.rowCount) throw problem("not_planned", "The draft plan is no longer awaiting application");
    });
  } catch (e) {
    if (pgCode(e) === UNIQUE) {
      await db.query("UPDATE record_corrections SET status = 'cancelled', text = NULL, fields = NULL, quote = NULL WHERE id = $1 AND status = 'planned'", [row.id]);
      return { status: "proposed" };
    }
    if (pgCode(e) === BUSY || pgCode(e) === DEADLOCK) throw new MemoryError("in_progress", "The record is being edited. Try again", { retry_after: 5 });
    throw e;
  }
  await audit(app, caller, { event_type: "write", class: t.rec.class, record_ids: [t.rec.id], space_id: t.space.id,
    details: { op: "correct", kind: "extraction_error", status: "proposed", via: "plan", origin: "human", by_role: role, correction_id: row.id, effect: "new_version", quote: "none",
               ...(t.rec.owner_id !== row.by_person ? { author: t.rec.owner_id } : {}) } });
  return { status: "proposed" };
}

export interface CorrectionMeta {
  kind: CorrectionKind; by_role: CorrectionRole; at: string; origin: "human" | "agent";
  quote_checked: boolean | null;
  by?: string;
  confirmed_by?: string;
}

const CORRECTION_ROLES: readonly CorrectionRole[] = ["author", "space_owner", "participant", "space_member", "reader"];
const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correctionOf = (attrs: Record<string, unknown> | null | undefined): Record<string, unknown> | null => {
  const c = attrs?.correction;
  return c && typeof c === "object" && !Array.isArray(c) ? c as Record<string, unknown> : null;
};

export function correctionPeople(attrs: Record<string, unknown> | null | undefined): string[] {
  const c = correctionOf(attrs);
  return c ? [c.by, c.confirmed_by].filter((x): x is string => typeof x === "string" && PERSON_ID.test(x)) : [];
}

export function correctionMeta(attrs: Record<string, unknown> | null | undefined, loginOf: (id: string) => string | undefined): CorrectionMeta | null {
  const c = correctionOf(attrs);
  if (!c) return null;
  const kind = c.kind as CorrectionKind, role = c.by_role as CorrectionRole, at = typeof c.at === "string" ? Date.parse(c.at) : NaN;
  if (!CORRECTION_KINDS.includes(kind) || !CORRECTION_ROLES.includes(role) || (c.origin !== "human" && c.origin !== "agent") || !Number.isFinite(at)) return null;
  const by = typeof c.by === "string" && PERSON_ID.test(c.by) ? loginOf(c.by) : undefined;
  const confirmed = typeof c.confirmed_by === "string" && PERSON_ID.test(c.confirmed_by) ? loginOf(c.confirmed_by) : undefined;
  return { kind, by_role: role, at: new Date(at).toISOString(), origin: c.origin, quote_checked: kind === "extraction_error" ? c.without_quote !== true : null,
           ...(by ? { by } : {}), ...(confirmed ? { confirmed_by: confirmed } : {}) };
}

export function correctionLine(c: CorrectionMeta): string {
  const quote = c.quote_checked === false ? "; unsupported by the quote: the previous wording from the meeting does not support the new wording"
    : c.quote_checked ? "; supported by a quote from the meeting" : "";
  return `Corrected${c.origin === "agent" ? " (agent inference)" : ""}: ${ROLE_WORD[c.by_role]}${c.by ? ` ${c.by}` : ""}${c.confirmed_by ? `, confirmed by: ${c.confirmed_by}` : ""}, ${c.at.slice(0, 10)}${quote}.`;
}

export interface CorrectionView {
  id: string; kind: CorrectionKind; status: CorrectionStatus; origin: "human" | "agent"; via: string; by_role: CorrectionRole; created_at: string;
  by: { login: string; display_name: string } | null;
  target: { id: string; type: string; title: string | null; space: string; event_kind: string | null };
  text: string | null; fields: CorrectFields | null; quote: string | null; quote_checked: boolean;
  newer: { id: string; title: string | null } | null; result_id: string | null; link_status: LinkStatus | null; decided_at: string | null;
  decided_by_role: CorrectionRole | null;
  can: { confirm: boolean; reject: boolean; withdraw: boolean };
  effect: Effect;
  space_guide?: true;
}

async function correctionView(app: App, caller: Caller, row: CorrectionRow, ctx: { t: Target; role: CorrectionRole }, shown?: Set<string>,
                              decided?: CorrectionRole | null): Promise<CorrectionView> {
  const guide = isSpaceGuideRow(ctx.t.rec);
  const me = caller.person!.id, mine = row.by_person === me, decide = decidesRow(app, row, ctx, me);
  const p = (await app.db.control.query("SELECT login, display_name FROM people WHERE id = $1", [row.by_person])).rows[0];
  const link = row.link_id ? (await app.db.control.query("SELECT status FROM record_links WHERE id = $1", [row.link_id])).rows[0]?.status ?? null : null;
  const readable = async (rid: string): Promise<RecordRow | null> => { try { return (await loadReadable(app, caller, rid, ctx.t.spaces)).rec; } catch { return null; } };
  const n = row.newer_id ? await readable(row.newer_id) : null;
  const r = row.result_id ? await readable(row.result_id) : null;
  for (const x of [ctx.t.rec, n, r]) if (x?.class === "closed") shown?.add(x.id);
  const open = row.status === "proposed" || row.status === "planned";
  const undoable = !guide && row.status === "applied" && (row.kind === "wrong" || row.kind === "outdated");
  const relinkable = !guide && row.status === "applied" && relationOf(row.kind) !== null && (link === "active" || (!row.link_id && !!(row.newer_id ?? row.result_id)));
  const quote = open && row.quote && (mine || await readsParent(app, caller, ctx.t)) ? row.quote : null;
  return {
    id: row.id, kind: row.kind, status: row.status, origin: row.origin, via: row.via, by_role: row.by_role, created_at: new Date(row.created_at).toISOString(),
    by: p ? { login: p.login, display_name: p.display_name } : null,
    target: { id: ctx.t.rec.id, type: ctx.t.rec.type, title: ctx.t.rec.title, space: ctx.t.space.slug, event_kind: ctx.t.rec.event_kind ?? null },
    text: open ? row.text : null, fields: open ? row.fields : null, quote, quote_checked: !!row.quote_match && !row.quote_match.without_quote,
    newer: n ? { id: n.id, title: n.title } : null, result_id: r ? r.id : null, link_status: link, decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decided_by_role: decided !== undefined ? decided : await deciderRole(app, caller, row, ctx.t),
    can: { confirm: (!guide && row.status === "proposed" && decide) || (relinkable && (decide || mine)),
           reject: (row.status === "proposed" && decide) || (undoable && (ctx.role === "author" || ctx.role === "space_owner")),
           withdraw: mine && (row.status === "proposed" || undoable) },
    effect: effectOf(row.kind, !!row.newer_id),
    ...(guide ? { space_guide: true as const } : {}),
  };
}

async function deciderRoles(app: App, caller: Caller, list: ReadonlyArray<{ row: CorrectionRow; t: Target }>): Promise<Map<string, CorrectionRole | null>> {
  const out = new Map<string, CorrectionRole | null>(), ask: Array<{ row: CorrectionRow; t: Target; who: string }> = [];
  for (const { row, t } of list) {
    const who = row.decided_by;
    if (!who || who === row.by_person || (row.status !== "applied" && row.status !== "rejected")) out.set(row.id, null);
    else if (who === t.rec.owner_id) out.set(row.id, "author");
    else ask.push({ row, t, who });
  }
  if (!ask.length) return out;
  const pair = (space: string, person: string) => `${space}:${person}`;
  const facts = new Map<string, { owner: boolean; member: boolean }>();
  for (const r of (await app.db.control.query(
    `SELECT p.space_id, p.person_id,
            (s.owner_id IS NOT DISTINCT FROM p.person_id OR EXISTS (SELECT 1 FROM space_members_effective m WHERE m.space_id = s.id AND m.person_id = p.person_id AND m.role = 'owner')) AS owner,
            EXISTS (SELECT 1 FROM space_members_effective m WHERE m.space_id = s.id AND m.person_id = p.person_id) AS member
       FROM (SELECT DISTINCT space_id, person_id FROM unnest($1::uuid[], $2::uuid[]) AS u(space_id, person_id)) p JOIN spaces s ON s.id = p.space_id`,
    [ask.map((x) => x.t.space.id), ask.map((x) => x.who)])).rows)
    facts.set(pair(r.space_id, r.person_id), { owner: r.owner === true, member: r.member === true });
  const rest = ask.filter((x) => (facts.get(pair(x.t.space.id, x.who))?.owner ? (out.set(x.row.id, "space_owner"), false) : true));
  for (const cls of new Set(rest.map((x) => x.t.rec.class))) {
    const part = rest.filter((x) => x.t.rec.class === cls);
    const listed = new Set((await app.db.records(cls, caller.scope).query(
      `SELECT DISTINCT p.rec_id, p.person_id FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS p(rec_id, person_id, root_id)
        WHERE EXISTS (SELECT 1 FROM record_people rp WHERE rp.record_id = p.rec_id AND rp.person_id = p.person_id)
          AND EXISTS (SELECT 1 FROM records r WHERE r.id = p.root_id AND r.type = 'transcript')`,
      [part.map((x) => x.t.rec.id), part.map((x) => x.who), part.map((x) => x.t.rootId)])).rows.map((r) => pair(r.rec_id, r.person_id)));
    for (const x of part)
      out.set(x.row.id, listed.has(pair(x.t.rec.id, x.who)) ? "participant" : facts.get(pair(x.t.space.id, x.who))?.member ? "space_member" : null);
  }
  return out;
}
const deciderRole = async (app: App, caller: Caller, row: CorrectionRow, t: Target): Promise<CorrectionRole | null> =>
  (await deciderRoles(app, caller, [{ row, t }])).get(row.id) ?? null;

async function blindView(app: App, row: CorrectionRow): Promise<CorrectionView> {
  const p = (await app.db.control.query("SELECT login, display_name FROM people WHERE id = $1", [row.by_person])).rows[0];
  const type = (await app.db.control.query("SELECT type FROM record_locations WHERE record_id = $1", [row.target_id])).rows[0]?.type ?? "record";
  const open = row.status === "proposed" || row.status === "planned";
  return {
    id: row.id, kind: row.kind, status: row.status, origin: row.origin, via: row.via, by_role: row.by_role, created_at: new Date(row.created_at).toISOString(),
    by: p ? { login: p.login, display_name: p.display_name } : null, target: { id: row.target_id, type: String(type), title: null, space: "", event_kind: null },
    text: open ? row.text : null, fields: open ? row.fields : null, quote: open ? row.quote : null, quote_checked: !!row.quote_match && !row.quote_match.without_quote,
    newer: null, result_id: null, link_status: null, decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null, decided_by_role: null,
    can: { confirm: false, reject: false, withdraw: row.status === "proposed" },
    effect: effectOf(row.kind, !!row.newer_id),
  };
}

const rowShown = (row: CorrectionRow, me: string, role: CorrectionRole, decides?: boolean): boolean =>
  row.status === "applied" || row.by_person === me || (decides ?? canDecide(row.kind, role));

async function auditShownClosed(app: App, caller: Caller, shown: Set<string>, kind: "read" | "list"): Promise<void> {
  if (!shown.size) return;
  const event = caller.keyKind === "extended" ? "extended_key_use" : kind; // vis-ok: the log by key kind (as memory_read), not visibility
  await auditRead(app, caller, { event_type: event, class: "closed", record_ids: [...shown], details: { op: "corrections_view" } });
}

export interface KindOffer { kind: CorrectionKind; mode: "apply" | "propose"; closed_result: boolean }
export type CurrentState = "current" | "visible" | "hidden" | "none";
export interface RecordCorrectionsView {
  items: CorrectionView[]; can_apply_directly: boolean; role: CorrectionRole; kinds: KindOffer[];
  current_state: CurrentState; current: { id: string; title: string | null } | null;
  fragment: { meeting_id: string; time_from: number; time_to: number } | null;
  event_fields: { title: string; statement: string; due: string | null; actors: string[] } | null;
}

function kindOffers(app: App, caller: Caller, t: Target, role: CorrectionRole): KindOffer[] {
  if (isSpaceGuideRow(t.rec)) return [];
  try { correctionCaller(caller, "human"); } catch { return []; }
  if (!t.rec.is_current || t.space.archived || t.rec.type === "transcript") return [];
  const facts = { type: t.rec.type, source_kind: t.rec.source_kind, parent_type: t.parentType };
  const out: KindOffer[] = [];
  for (const kind of CORRECTION_KINDS) {
    if (!kindApplicable(kind, facts)) continue;
    let status: "applied" | "proposed";
    try { status = decideStatus(kind, role, "human", nonParticipant(app)); } catch { continue; }
    const closed_result = kind === "own_note" && t.rec.class === "open" && t.space.kind === "personal" && t.space.owner_id === caller.person?.id
      && t.space.default_class === "closed" && personalMode(caller, { kind: "personal", owner_id: t.space.owner_id, default_class: t.space.default_class }) !== "open"
      && !workplaceKeepsOpen(caller);
    out.push({ kind, mode: status === "applied" ? "apply" : "propose", closed_result });
  }
  return out;
}

export async function currentOf(app: App, caller: Caller, t: Target, shown: Set<string>): Promise<{ state: CurrentState; current: { id: string; title: string | null } | null }> {
  if (t.rec.is_current) return { state: "current", current: null };
  const next = (r: RecordRow): string | null => {
    const x = r as RecordRow & { superseded_by_id?: string | null };
    const by = x.superseded_by_id ?? x.attrs?.suppressed_by_correction;
    return typeof by === "string" && by ? by : null;
  };
  let id = next(t.rec);
  if (!id) return { state: "none", current: null };
  for (let step = 0; step < 20 && id; step++) {
    let rec: RecordRow;
    try { rec = (await loadReadable(app, caller, id, t.spaces)).rec; } catch { return { state: "hidden", current: null }; }
    if (rec.is_current) {
      if (rec.class === "closed") shown.add(rec.id);
      return { state: "visible", current: { id: rec.id, title: rec.title } };
    }
    id = next(rec);
  }
  return { state: "hidden", current: null };
}

export async function recordCorrections(app: App, caller: Caller, id: string): Promise<RecordCorrectionsView> {
  if (caller.principalType !== "person" || !caller.person || caller.onBehalfOf) throw new MemoryError("forbidden", "Only a person can see the record’s corrections");
  const t = await targetOf(app, caller, id);
  const me = caller.person.id;
  const role = correctionRole({ me, ownerId: t.rec.owner_id, spaceRole: t.space.role, participant: t.participant });
  const db = app.db.records(t.rec.class, caller.scope);
  const same = t.rec.type === "event" && t.rec.event_key && t.rec.parent_id
    ? (await db.query("SELECT id FROM records WHERE parent_id = $1 AND type = 'event' AND event_key = $2 AND deleted_at IS NULL", [t.rec.parent_id, t.rec.event_key])).rows.map((r) => r.id as string)
    : [];
  const ids = [...new Set([t.rec.id, ...same])];
  const rows: CorrectionRow[] = [];
  for (const cls of classesFor(caller, { cls: t.rec.class, ownerId: t.rec.owner_id }))
    for (const r of (await app.db.records(cls, caller.scope).query<CorrectionRow>("SELECT * FROM record_corrections WHERE target_id = ANY($1::uuid[]) AND status <> 'planned' ORDER BY created_at DESC, id DESC LIMIT 200", [ids])).rows)
      rows.push({ ...r, cls });
  const items: CorrectionView[] = [], shown = new Set<string>(), visible: Array<{ row: CorrectionRow; ctx: { t: Target; role: CorrectionRole } }> = [];
  for (const r of rows) {
    const ctx = r.target_id === t.rec.id ? { t, role } : await decisionContext(app, caller, r).catch(() => null);
    if (ctx && rowShown(r, me, ctx.role, isSpaceGuideRow(ctx.t.rec) ? decidesRow(app, r, ctx, me) : undefined)) visible.push({ row: r, ctx });
  }
  const deciders = await deciderRoles(app, caller, visible.map((x) => ({ row: x.row, t: x.ctx.t })));
  for (const { row: r, ctx } of visible) {
    items.push(await correctionView(app, caller, r, ctx, shown, deciders.get(r.id) ?? null));
    if (r.cls === "closed") shown.add(r.result_id ?? r.target_id);
  }
  const kinds = kindOffers(app, caller, t, role);
  const cur = await currentOf(app, caller, t, shown);
  const facts = { type: t.rec.type, source_kind: t.rec.source_kind, parent_type: t.parentType };
  const extraction = kindApplicable("extraction_error", facts);
  let fragment: RecordCorrectionsView["fragment"] = null, event_fields: RecordCorrectionsView["event_fields"] = null;
  if (extraction) {
    const m = mergeEventFields({ ...t.rec, text: t.text }, null, null, null);
    event_fields = { title: m.title, statement: m.statement, due: m.due, actors: m.actors };
    const loc = t.rec.locator as { time_from?: unknown; time_to?: unknown } | null;
    const tf = typeof loc?.time_from === "number" && Number.isFinite(loc.time_from) ? loc.time_from : null;
    if (tf !== null && t.rec.parent_id && await readsParent(app, caller, t)) {
      const tt = typeof loc?.time_to === "number" && Number.isFinite(loc.time_to) ? loc.time_to : tf;
      fragment = { meeting_id: t.rec.parent_id, time_from: Math.max(0, tf - 60), time_to: tt + 60 };
    }
  }
  const extended = caller.keyKind === "extended"; // vis-ok: the log by key kind (as memory_read), not visibility
  await auditRead(app, caller, { event_type: extended && t.rec.class === "closed" ? "extended_key_use" : "read", class: t.rec.class, record_ids: [t.rec.id],
                                 details: { op: "corrections_view", items: items.length } });
  shown.delete(t.rec.id);
  await auditShownClosed(app, caller, shown, "list");
  return { items, can_apply_directly: !isSpaceGuideRow(t.rec) && role !== "reader" && role !== "space_member", role, kinds, current_state: cur.state, current: cur.current,
           fragment, event_fields };
}

const TO_CONFIRM_JOIN = "JOIN records r ON r.id = k.target_id AND r.deleted_at IS NULL AND r.hidden_at IS NULL";

function toConfirmWhere(b: (v: unknown) => string, me: string, spec: Parameters<typeof visibleSql>[0], cls: DataClass, spaces: Map<string, SpaceAccess>,
                        guideOn: boolean): string | null {
  const vis = visibleSql(spec, cls, b, "r");
  if (!vis) return null;
  const owned = [...spaces.values()].filter((s) => s.role === "owner").map((s) => s.id);
  const member = [...spaces.values()].filter((s) => s.role === "member").map((s) => s.id);
  const guideOwned = [...spaces.values()].filter((s) => s.role === "owner" && s.kind !== "personal" && !s.archived_at).map((s) => s.id);
  const G = GUIDE_ROW_SQL("r");
  return ["k.status = 'proposed'", `(k.by_person <> ${b(me)}::uuid OR (${G} AND k.via = 'mcp'))`, vis, "r.is_current",
    `((${guideOn ? `${G} AND r.space_id = ANY(${b(guideOwned)}::uuid[])` : "FALSE"}) OR (NOT ${G} AND (r.owner_id = ${b(me)}::uuid OR r.space_id = ANY(${b(owned)}::uuid[])
      OR (EXISTS (SELECT 1 FROM record_people rp WHERE rp.record_id = r.id AND rp.person_id = ${b(me)}::uuid) AND r.parent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM records m WHERE m.id = r.parent_id AND m.type = 'transcript'))
      OR (k.kind = 'outdated' AND r.space_id = ANY(${b(member)}::uuid[])))))`].join(" AND ");
}

export async function myCorrections(app: App, caller: Caller, o: { role: "to_confirm" | "mine"; limit: number; cursor?: string }): Promise<{ items: CorrectionView[]; next_cursor: string | null }> {
  await humanOnly(app, caller);
  const me = caller.person!.id;
  const { spec, spaces } = await visibilityFor(app, caller, { byId: true });
  const cur = decodeKeyset(o.cursor);
  const rows: CorrectionRow[] = [];
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], b = binder(args);
    const where: string[] = [];
    if (o.role === "mine") where.push(`k.by_person = ${b(me)}::uuid`, "k.status <> 'planned'");
    else {
      const cond = toConfirmWhere(b, me, spec, cls, spaces, guideEnabled(app));
      if (!cond) continue;
      where.push(cond);
    }
    if (cur) where.push(`(k.created_at, k.id) < (${b(cur.at)}::timestamptz, ${b(cur.id)}::uuid)`);
    const join = o.role === "to_confirm" ? TO_CONFIRM_JOIN : "";
    const found = (await app.db.records(cls, caller.scope).query<CorrectionRow>(
      `SELECT k.*, ${keysetAtSql("k.created_at")} AS at_key FROM record_corrections k ${join} WHERE ${where.join(" AND ")} ORDER BY k.created_at DESC, k.id DESC LIMIT ${b(o.limit + 1)}`, args)).rows;
    rows.push(...found.map((r) => ({ ...r, cls })));
  }
  rows.sort((x, y) => -keysetCompare({ at_key: x.at_key!, id: x.id }, { at_key: y.at_key!, id: y.id }));
  const page = rows.slice(0, o.limit), items: CorrectionView[] = [], shown = new Set<string>();
  const entries: Array<{ row: CorrectionRow; ctx: { t: Target; role: CorrectionRole } | null }> = [];
  for (const r of page) {
    const ctx = await decisionContext(app, caller, r).catch(() => null);
    if (!ctx) { if (o.role === "mine" && r.status === "proposed") entries.push({ row: r, ctx: null }); continue; }
    if (o.role === "to_confirm" && !decidesRow(app, r, ctx, me)) continue;
    entries.push({ row: r, ctx });
  }
  const deciders = await deciderRoles(app, caller, entries.flatMap((x) => (x.ctx ? [{ row: x.row, t: x.ctx.t }] : [])));
  for (const { row: r, ctx } of entries)
    items.push(ctx ? await correctionView(app, caller, r, ctx, shown, deciders.get(r.id) ?? null) : await blindView(app, r));
  await auditShownClosed(app, caller, shown, "list");
  const last = page.at(-1);
  return { items, next_cursor: rows.length > o.limit && last ? encodeKeyset(last.at_key!, last.id) : null };
}

export async function correctionsSummary(app: App, caller: Caller): Promise<{ to_confirm: number }> {
  await humanOnly(app, caller);
  const me = caller.person!.id;
  const { spec, spaces } = await visibilityFor(app, caller, { byId: true });
  let n = 0;
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], b = binder(args);
    const cond = toConfirmWhere(b, me, spec, cls, spaces, guideEnabled(app));
    if (!cond) continue;
    n += (await app.db.records(cls, caller.scope).query(`SELECT count(*)::int AS n FROM record_corrections k ${TO_CONFIRM_JOIN} WHERE ${cond}`, args)).rows[0]?.n ?? 0;
  }
  return { to_confirm: n };
}

export async function chainHead(db: Pick<pg.Pool, "query">, id: string): Promise<string> {
  return (await db.query(CHAIN_HEAD, [id])).rows[0]?.id ?? id;
}

export const _test = { ROLE_WORD, appliedText, PROPOSED_TEXT, summaryOf, rowShown, createHash, CLOSED_WHY };
