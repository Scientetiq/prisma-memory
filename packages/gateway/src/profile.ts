// An employee's work profile: one current
// `profile` record in the person's personal space — five sections in `attrs.profile.sections`, each change is a new
// version (`supersedes_id`), the owner sees the history. Only the person writes it: in the workplace or by their agent
// from their words (`origin: human`); not a service "on behalf of", an administrator or a manager. Nothing about people's health,
// family, pay or ratings may be written (shared/src/profile-check.ts). It lands open — it is for the person's cloud agents;
// failed the open check — not saved (the default). The personal notebook switch does not apply to the profile.
// A shared module for the workplace REST and the agent: `memory_remember kind=profile`,
// `memory_me.profile`, `memory_read /me/profile`.
// The `access.profile_enabled` switch (off by default) turns all of it off. The administrator does not read the profile:
// the profile has no panel routes; the log holds section codes, no text.
//
// The copy for colleagues: sections the person marked "Show to colleagues" (except
// "For the agent" — never) lie as a copy in "Company common knowledge" — a `profile` record in org, `source_ref
// workprofile-public:<login>`, the owner is the person, class open. The copy has no versions: each change of what is shown
// replaces it with a new record; the old one is deleted in the same open-database transaction as the new personal version
// without the trash (`purge_after = now()`): no one reads it again, by id or from the trash. Hiding the profile from agents,
// deleting it or leaving the company — removes the copy the same way. An edit of a shown section by an agent with extended access
// (`marked`) is not shown by the copy itself: the section leaves the showing until the person's checkbox.
import type { Context, Hono } from "hono";
import type pg from "pg";
import { applySections, asData, focusStale, focusStaleNote, inProgress, instanceTz, invalid, isProfileSection, log, MemoryError, neverOpenFindings, notFound, openCheckReasons,
         parseProfileAttrs, parsePublicAttrs, PROFILE_ENABLED_SETTING, PROFILE_PATH, PROFILE_SECTION_TITLES, PROFILE_SECTIONS, PROFILE_SETTING, PROFILE_TITLE, privateLifeFindings,
         privateLifeText, profileLimitProblem, profileLimits, profileLimitText, profileText, publicAttrsOf, publicCopyMatches, publicCopyOf, recordPath, dayMonthText, samePublic,
         publicCopyWithin, sectionAt, sectionSpans, syncDeletionMarks, tx, WORKPROFILE_PREFIX, workProfilePublicRef, workProfileRef, type DataClass,
         type OpenCheckFinding, type ProfileAttrs, type ProfileChanges, type ProfileLimits, type ProfileMode, type ProfileSection, type ProfileSections,
         type ProfileSource, type PublicAttrs, type PublicCopy, type PublicSection, type PublicValue } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { textsOf, type McpTexts } from "./mcp-texts.ts";
import { loadReadable, readableSpaces, resolveSpace, type SpaceAccess } from "./access.ts";
import { audit, auditShownClosed } from "./audit.ts";
import { withKeyLock } from "./control-lock.ts";
import { invalidateHeld } from "./org-hold.ts";
import { extendedOpenGate, isExtendedOpenDenial, MARKED_TAIL, openWriteMode } from "./extended-open.ts";
import { guardOpen, refuseOpen } from "./open-check.ts";
import { intParam, offsetCursor } from "./paging.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { createRecord, dropUncommittedLocators, type Admitted, type Created, type NewRecord } from "./records.ts";
import { isHumanSession, requireHuman } from "./workplace.ts";
import { isExternal } from "./channel.ts";

// ---------------------------------------------------------------- texts (plain words)
export const PROFILE_DISABLED_TEXT = "The administrator disabled the work profile";
export const PROFILE_SERVICE_TEXT = "Only the person or their agent relaying their words can write to the profile";
export const PROFILE_PREVIEW_TEXT = "The work profile cannot be changed in preview";
export const PROFILE_GUESS_TEXT = "Write only what the person says in their profile. Tell them what you inferred and save it only if they confirm it (origin: human)";
export const PROFILE_HIDDEN_TEXT = "The profile is hidden from agents. Edit it under “My profile” in the workspace, or select “Show to agents” first";
/**
 * The external agents' address says nothing about closed: a profile the person hid from agents is a closed
 * record, so the refusal to an agent there has no word "hidden" — only that the profile is changed in the workplace.
 */
export const PROFILE_WORKPLACE_TEXT = "You cannot edit the work profile through this address. The person can edit it under “My profile” in the workspace";
export const PROFILE_SCRIPT_TEXT ="A script key cannot relay a person’s words. The person can write to their work profile under “My profile” in the workspace, or ask their agent to write it in conversation";
const OPEN_LEAD = "The record was not accepted into the open class";
const PROFILE_LEAD = "Profile not saved";
const EXTENDED_TEXT = "This key cannot edit the work profile. It has extended access and can read a person’s closed records. Agents using these keys cannot write to open spaces, "
  + "unless the memory administrator grants permission in the key settings. The person can edit their profile under “My profile” in the workspace";
// the copy for colleagues
export const PROFILE_PUBLIC_HIDDEN_TEXT = "Colleagues cannot see a profile while it is hidden from agents. To show sections to colleagues, first select “Show to agents”";
export const PROFILE_PUBLIC_AGENT_TEXT = "Only you and your agents can see “For the agent”. Colleagues cannot see it";
export const PROFILE_PUBLIC_EMPTY_TEXT = "The profile is empty. Fill in at least one section before choosing what to show to colleagues";
export const PROFILE_PUBLIC_NO_ORG_TEXT = "There is no “Company knowledge” space in memory to show the profile to colleagues. Tell the memory administrator";
/** The copy for colleagues is not hidden, deleted or moved on its own: the profile itself runs it. */
export const PROFILE_COPY_TEXT = "This is a copy of the work profile for colleagues in “Company knowledge”. It updates automatically when the profile changes. "
  + "Use “Show to colleagues” in “My profile” to choose what they see. To remove the copy immediately, clear the checkboxes, hide the profile from agents or delete it";
/** The copy's title in "Company common knowledge": whose profile it is — by the name from the directory. */
export const publicTitle = (name: string): string => `${PROFILE_TITLE}: ${name.trim() || "colleague"}`;

/** The edit queue key of one person's profile (a gateway process lock, as elsewhere: a second process — an advisory lock). */
export const profileLockKey = (personId: string): string => `profile:${personId}`;

// ---------------------------------------------------------------- switch and who writes
export const profileEnabled = (app: Pick<App, "settings">): boolean => app.settings.get<boolean>(PROFILE_ENABLED_SETTING, false) === true;

export function requireProfileEnabled(app: Pick<App, "settings">): void {
  if (!profileEnabled(app)) throw new MemoryError("forbidden", PROFILE_DISABLED_TEXT, { details: { reason: "profile_disabled" } });
}

export const limitsOf = (app: Pick<App, "settings">): ProfileLimits => profileLimits(app.settings.get<unknown>(PROFILE_SETTING, null));

/**
 * Who writes the profile: the person with their own key — personal, extended, a connection (OAuth) — or a workplace
 * session. A service "on behalf of", a service without a person and a system key — `forbidden`; the panel preview too.
 */
export function profileWriterProblem(caller: Pick<Caller, "principalType" | "person" | "onBehalfOf" | "preview" | "keyKind">): MemoryError | null {
  if (caller.preview) return new MemoryError("forbidden", PROFILE_PREVIEW_TEXT, { details: { reason: "profile_preview" } });
  if (caller.principalType !== "person" || !caller.person || caller.onBehalfOf || !["personal", "extended", "connection", "session"].includes(caller.keyKind))
    return new MemoryError("forbidden", PROFILE_SERVICE_TEXT, { details: { reason: "profile_service" } });
  return null;
}

/**
 * Section changes from the input: an object `{section: text | null}`, at least one section, only known sections. `append`
 * with empty text — nothing to add. Length is cut by the limits below (in tokens); here — only a rough input bound.
 */
export function checkChanges(raw: unknown, mode: ProfileMode): ProfileChanges {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("sections must be an object {section: text}", { field: "sections" });
  const o = raw as Record<string, unknown>, keys = Object.keys(o);
  const unknown = keys.filter((k) => !(PROFILE_SECTIONS as readonly string[]).includes(k));
  if (unknown.length) throw invalid(`Unknown profile sections: ${unknown.join(", ")}. Allowed sections: ${PROFILE_SECTIONS.join(", ")}`, { field: "sections", unknown });
  if (!keys.length) throw invalid("sections: provide at least one section", { field: "sections" });
  const out: ProfileChanges = {};
  for (const s of PROFILE_SECTIONS) {
    if (!(s in o)) continue;
    const v = o[s];
    if (v !== null && typeof v !== "string") throw invalid(`sections.${s}: text or null`, { field: `sections.${s}` });
    if (typeof v === "string" && v.length > 20_000) throw new MemoryError("too_large", `The “${PROFILE_SECTION_TITLES[s]}” section is too long`, { details: { section: s } });
    if (mode === "append" && !(v ?? "").trim()) throw invalid(`sections.${s}: provide text to add in append mode`, { field: `sections.${s}` });
    out[s] = v as string | null;
  }
  return out;
}

/**
 * "Show to colleagues" checkboxes from the input (`PUT /me/profile`, field `public`): a list of section codes, repeats
 * collapse, the order is the section order. "For the agent" — refusal (the API refuses), an unknown section — refusal.
 * An empty section can be marked too: it gets into the copy once it has text.
 */
export function checkPublic(raw: unknown): ProfileSection[] {
  if (!Array.isArray(raw)) throw invalid("public must list the sections to show to colleagues", { field: "public" });
  if (raw.length > PROFILE_SECTIONS.length * 4) throw invalid("public: the list is too long", { field: "public" });
  const bad = raw.filter((v) => !isProfileSection(v)).map(String);
  if (bad.length) throw invalid(`Unknown profile sections in public: ${bad.join(", ")}. Allowed sections: ${PROFILE_SECTIONS.filter((s) => s !== "agent").join(", ")}`, { field: "public", unknown: bad });
  if (raw.includes("agent")) throw invalid(PROFILE_PUBLIC_AGENT_TEXT, { field: "public", reason: "profile_public_agent" });
  return PROFILE_SECTIONS.filter((s) => raw.includes(s));
}

// ---------------------------------------------------------------- current profile
export interface ProfileRef { id: string; cls: DataClass; version: number; occurred_at: Date }

/**
 * The person's current profile — in both classes: candidates are control locators (the owner, their personal
 * space, type profile, not deleted; the locator knows the class), then in the database of its class — source `workprofile:`,
 * the current version, not deleted. A profile the person hid from agents (closed) is not lost, and a second "current" record
 * does not appear next to it. Only metadata (id, version, date) is read by the system context — without content.
 */
export async function currentProfileRef(app: App, ownerId: string, spaceId: string): Promise<ProfileRef | null> {
  const locs = (await app.db.control.query(
    "SELECT record_id, class FROM record_locations WHERE owner_id = $1 AND space_id = $2 AND type = 'profile' AND NOT deleted", [ownerId, spaceId])).rows as Array<{ record_id: string; class: DataClass }>;
  let best: ProfileRef | null = null;
  for (const cls of ["open", "closed"] as const) {
    const ids = locs.filter((l) => l.class === cls).map((l) => l.record_id);
    if (!ids.length) continue;
    const r = (await app.db.records(cls, { classes: ["open", "closed"], tier: "system" }).query(
      `SELECT id, version, occurred_at FROM records WHERE id = ANY($1::uuid[]) AND type = 'profile' AND source_ref LIKE 'workprofile:%' AND is_current AND deleted_at IS NULL
        ORDER BY version DESC, occurred_at DESC LIMIT 1`, [ids])).rows[0];
    if (r && (!best || r.version > best.version)) best = { id: r.id, cls, version: Number(r.version), occurred_at: new Date(r.occurred_at) };
  }
  return best;
}

/** Current version sections — by the caller's pool (a closed version only for a reader of closed: a session, an extended key). */
async function loadAttrs(app: App, caller: Caller, ref: ProfileRef): Promise<ProfileAttrs> {
  const r = (await app.db.records(ref.cls, caller.scope).query("SELECT attrs FROM records WHERE id = $1 AND deleted_at IS NULL", [ref.id])).rows[0];
  return parseProfileAttrs(r?.attrs?.profile);
}

const personalSpace = async (app: App, caller: Caller): Promise<SpaceAccess> => {
  const space = await resolveSpace(app, caller, "me", await readableSpaces(app, caller));
  if (!space) throw notFound();
  return space;
};

// ---------------------------------------------------------------- open check (the strict path)

/**
 * Open check refusal in profile words: the section (by the finding's place in the text) and what was found. No content —
 * only finding kinds, as in any check refusal.
 */
export function openRefusalText(findings: readonly OpenCheckFinding[], sections: ProfileSections): { message: string; hint: string } {
  const spans = sectionSpans(sections);
  const first = findings[0];
  const section = first ? sectionAt(spans, first.at) : null;
  const here = section ? findings.filter((f) => sectionAt(spans, f.at) === section) : [...findings];
  const where = section ? `In the “${PROFILE_SECTION_TITLES[section]}” section` : "In the profile";
  return { message: `${where}, content resembling ${openCheckReasons([...here])} was found. Your cloud AI agents read your profile. Remove that content and save again`,
           hint: "Your profile was unchanged. Remove that content from the section and save again" };
}

/** Open check refusal with the common start "Record not accepted…" in profile words; its own text (with a section) is kept. */
export function profileOpenError(e: unknown): unknown {
  if (!(e instanceof MemoryError) || e.code !== "open_check" || !e.message.startsWith(OPEN_LEAD)) return e;
  const unchecked = (e.extra.details?.open_check as { unchecked?: unknown } | undefined)?.unchecked;
  return new MemoryError("open_check", PROFILE_LEAD + e.message.slice(OPEN_LEAD.length), {
    hint: unchecked ? "Try again in a minute with the same text. Your profile was unchanged"
      : "A memory administrator’s rule prevents you from showing this type of record to agents. Your profile was unchanged. Ask the memory administrator",
    ...(e.extra.details ? { details: e.extra.details } : {}) });
}

async function admitOpen(app: App, caller: Caller, space: SpaceAccess, sections: ProfileSections, text: string, sourceRef: string): Promise<Created["extended"]> {
  // "never open" rules without content (after narrowing the card rule — the profile is not a card for them): the strict path
  // does not check them itself, and for the profile a matched rule is a refusal too, not a closed write
  const rules = (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows;
  const never = neverOpenFindings(rules, { type: "profile", title: PROFILE_TITLE, domains: [], entityKinds: [], spaceSlug: space.slug, sourceKind: "agent", sourceRef });
  // the gate: an extended key without permission — refusal class_denied (the gate writes the event), with permission — a mark
  let extended: Created["extended"] = null;
  try {
    if (never.length) await refuseOpen(app, caller, { via: "remember", spaceId: space.id, texts: [] }, { findings: [], unchecked: null, never });
    extended = await extendedOpenGate(app, caller, { attempt: "remember", space: { id: space.id, slug: space.slug } });
    await guardOpen(app, caller, { via: "remember", spaceId: space.id, texts: [{ field: "text", value: text }], refusal: (f) => openRefusalText(f, sections) });
  } catch (e) {
    if (isExtendedOpenDenial(e)) throw new MemoryError("class_denied", EXTENDED_TEXT, { hint: "Tell the person. The memory administrator can grant permission", details: (e as MemoryError).extra.details });
    throw profileOpenError(e);
  }
  return extended;
}

// ---------------------------------------------------------------- copy for colleagues

/** The live copy for colleagues: where, when made, under which title, what it shows (`profile_public`) and whether it bears the mark. */
export interface LiveCopy { id: string; space_id: string; occurred_at: Date; title: string; attrs: PublicAttrs; marked: boolean }

/** What colleagues see: the copy's shown sections with dates; no copy — empty and `updated_at: null`. */
export interface PublicPreview { sections: Partial<Record<PublicSection, PublicValue>>; updated_at: string | null }
export const EMPTY_PREVIEW: Readonly<PublicPreview> = Object.freeze({ sections: {}, updated_at: null });

/** The copy's shown sections — only those listed in `sections` and with text, in section order. */
export function previewOf(attrs: PublicAttrs, at: Date | string | null): PublicPreview {
  const sections: PublicPreview["sections"] = {};
  for (const s of attrs.sections) if (attrs.values[s]) sections[s] = { ...attrs.values[s]! };
  return { sections, updated_at: at ? new Date(at).toISOString() : null };
}

/**
 * The person's live copies (a person has one live copy; a failure could make more — then all are replaced). Candidates —
 * control locators (the owner, the instance org, type profile, open class, not deleted), then the open database: source agent and
 * `workprofile-public:`, not deleted. A directory card (pipeline, `people:`, closed) does not get here. The copy is always
 * open: it cannot be hidden alone (owner.ts). Metadata and `attrs` — by the system context: they are the person's own records.
 */
export async function liveCopies(app: App, ownerId: string): Promise<LiveCopy[]> {
  const locs = (await app.db.control.query(
    `SELECT l.record_id, l.space_id FROM record_locations l JOIN spaces s ON s.id = l.space_id AND s.kind = 'org' AND s.instance_id = $2
      WHERE l.owner_id = $1 AND l.type = 'profile' AND l.class = 'open' AND NOT l.deleted`, [ownerId, app.instanceId])).rows as Array<{ record_id: string; space_id: string }>;
  if (!locs.length) return [];
  const rows = (await app.db.records("open", { classes: ["open", "closed"], tier: "system" }).query(
    `SELECT id, occurred_at, title, attrs FROM records WHERE id = ANY($1::uuid[]) AND type = 'profile' AND source_kind = 'agent' AND source_ref LIKE 'workprofile-public:%'
        AND deleted_at IS NULL ORDER BY occurred_at DESC, id DESC`, [locs.map((l) => l.record_id)])).rows;
  return rows.map((r) => ({ id: r.id as string, space_id: locs.find((l) => l.record_id === r.id)!.space_id, occurred_at: new Date(r.occurred_at), title: String(r.title ?? ""),
                            attrs: parsePublicAttrs(r.attrs?.profile_public), marked: !!r.attrs?.extended_write }));
}

/** "Company common knowledge" from the caller's map: every employee reads it. None — null. */
async function orgOf(app: App, caller: Caller): Promise<SpaceAccess | null> {
  return [...(await readableSpaces(app, caller)).values()].find((s) => s.kind === "org") ?? null;
}

/** The start of the common open check refusal on a move (open-check.ts LEAD.promote) — rewritten in profile words. */
export const PROMOTE_LEAD = "The record was not moved because it is in the open class";

/** An open check refusal of the copy in profile words: the section the person shows colleagues, and what was found — no content. */
export function copyRefusalText(findings: readonly OpenCheckFinding[], copy: Pick<PublicCopy, "values">): { message: string; hint: string } {
  const sections: ProfileSections = {};
  for (const [s, v] of Object.entries(copy.values) as Array<[PublicSection, PublicValue]>) sections[s] = { text: v.text, updated_at: v.updated_at, source: "person" };
  const spans = sectionSpans(sections);
  const inText = findings.filter((f) => f.field === "text");
  const first = inText[0];
  const section = first ? sectionAt(spans, first.at) : null;
  const here = section ? inText.filter((f) => sectionAt(spans, f.at) === section) : [...findings];
  const where = section ? `In the “${PROFILE_SECTION_TITLES[section]}” section you show to colleagues,` : "In the content you show to colleagues,";
  return { message: `${where} content resembling ${openCheckReasons([...here])} was found. Colleagues and their AI agents read it in “Company knowledge”. Remove that content or stop showing the section to colleagues, then save again`,
           hint: "Your profile was unchanged. Remove that content from the section or clear “Show to colleagues”" };
}

/** The common copy check refusal ("Record not moved…", a "never open" rule, "not checked") — in profile words. */
export function copyOpenError(e: unknown): unknown {
  if (!(e instanceof MemoryError) || e.code !== "open_check" || !e.message.startsWith(PROMOTE_LEAD)) return e;
  const unchecked = (e.extra.details?.open_check as { unchecked?: unknown } | undefined)?.unchecked;
  return new MemoryError("open_check", PROFILE_LEAD + e.message.slice(PROMOTE_LEAD.length), {
    hint: unchecked ? "Try again in a minute with the same text. Your profile was unchanged"
      : "A memory administrator’s rule prevents you from showing this content to colleagues in “Company knowledge”. Your profile was unchanged. Clear “Show to colleagues” or ask the memory administrator",
    ...(e.extra.details ? { details: e.extra.details } : {}) });
}

/**
 * The copy gate: "never open" rules without content (type, title, org, copy source) and the open check
 * of the copy's title and text via a move into org (`via: promote`), its own refusal text — the section shown to colleagues.
 * A refusal saves nothing — no personal version, no copy. The personal version already passed the gate (a forbidden key —
 * refused earlier); the copy's mark comes from its content — a section by an agent with extended access (`PublicCopy.marked`).
 * `recheck: false` — the new copy shows only what the live copy already shows (the same sections with the same texts, the
 * same title): rules and the open check are not repeated — otherwise a tightened rule would not let one narrow what is shown, and
 * more would stay in "Company common knowledge". The gate — always: this is a write into org.
 */
async function admitCopy(app: App, caller: Caller, org: SpaceAccess, copy: PublicCopy, title: string, sourceRef: string, recheck: boolean): Promise<void> {
  const rules = recheck ? (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows : [];
  const never = neverOpenFindings(rules, { type: "profile", title, domains: [], entityKinds: [], spaceSlug: org.slug, sourceKind: "agent", sourceRef });
  try {
    if (never.length) await refuseOpen(app, caller, { via: "promote", spaceId: org.id, texts: [] }, { findings: [], unchecked: null, never });
    // the gate on the copy too: a request without section edits rebuilds the copy as well — a key for which open
    // is forbidden does not write it; the copy's mark is set by its content, not by this call
    await extendedOpenGate(app, caller, { attempt: "remember", space: { id: org.id, slug: org.slug } });
    if (recheck)
      await guardOpen(app, caller, { via: "promote", spaceId: org.id, texts: [{ field: "title", value: title }, { field: "text", value: copy.text }],
                                     refusal: (f) => copyRefusalText(f, copy) });
  } catch (e) {
    if (isExtendedOpenDenial(e)) throw new MemoryError("class_denied", EXTENDED_TEXT, { hint: "Tell the person. The memory administrator can grant permission", details: (e as MemoryError).extra.details });
    throw copyOpenError(e);
  }
}

/** Ids of all records removed by the `batches` packages (the copy and what went with it: colleagues' corrections to the copy). */
async function batchIds(db: Pick<pg.Pool, "query">, batches: readonly string[]): Promise<string[]> {
  if (!batches.length) return [];
  return (await db.query("SELECT id FROM records WHERE deleted_batch = ANY($1::uuid[])", [[...batches]])).rows.map((r) => r.id as string);
}

/** Remove copies without the trash: a copy delete package with a zero term — it is not in the trash, the purge — by the next job. */
async function purgeCopies(c: Pick<pg.PoolClient, "query">, ids: readonly string[], by: string | null): Promise<void> {
  for (const id of ids) await c.query("SELECT mark_deleted_chain($1, $2, interval '0')", [id, by]);
}

/**
 * The old copy's "Wrong / not for everyone" hold goes with the new one, as for a version: else editing what is shown would drop
 * colleagues' marks and the waiting curator's decision. "Wrong" marks are copied to the new copy (one per person). The review row
 * of the new copy was made by createRecord (entry public_profile). A switched-off curator review makes no row, while
 * the hold works in any switch position (for a version carryOrgReview carries it the same way): if the old copy
 * has a hold, "disputed" or "Wrong" marks, the new copy's row (exempt public_profile) is made here — otherwise
 * held text would become visible to agents, and copying the marks would hit the FK `org_review_marks → org_reviews`.
 * Nothing to carry — no row, as for other records with the review off. Called before the records database COMMIT:
 * agents never see the new copy unheld, even for an instant. true — the new copy is held or disputed (reset the hold cache).
 */
async function carryCopyHold(q: Pick<pg.Pool, "query">, newId: string, oldIds: readonly string[],
                             entry: { instanceId: string; by: string | null; human: boolean; extended: boolean }): Promise<boolean> {
  if (!oldIds.length) return false;
  await q.query(
    `INSERT INTO org_reviews (record_id, instance_id, state, cycle, entered_via, entered_by, entered_human, extended, exempt_kind, held_at, held_by, disputed_at)
     SELECT $1, $3, 'exempt', o.cycle, 'public_profile', $4, $5, $6, 'public_profile', o.held_at, o.held_by, o.disputed_at FROM org_reviews o
      WHERE o.record_id = ANY($2::uuid[])
        AND (o.held_at IS NOT NULL OR o.disputed_at IS NOT NULL OR EXISTS (SELECT 1 FROM org_review_marks m WHERE m.record_id = o.record_id AND m.kind = 'wrong'))
      ORDER BY o.held_at DESC NULLS LAST, o.disputed_at DESC NULLS LAST LIMIT 1
     ON CONFLICT (record_id) DO NOTHING`, [newId, [...oldIds], entry.instanceId, entry.by, entry.human, entry.extended]);
  await q.query(
    `UPDATE org_reviews n SET held_at = o.held_at, held_by = o.held_by, disputed_at = COALESCE(n.disputed_at, o.disputed_at), updated_at = now()
       FROM (SELECT held_at, held_by, disputed_at FROM org_reviews WHERE record_id = ANY($2::uuid[]) AND (held_at IS NOT NULL OR disputed_at IS NOT NULL)
              ORDER BY held_at DESC NULLS LAST, disputed_at DESC NULLS LAST LIMIT 1) o
      WHERE n.record_id = $1 AND n.held_at IS NULL`, [newId, [...oldIds]]);
  // are copied, not moved: a records database rollback drops the new copy's locator by cascade together with the mark copies, and
  // the old copy's marks stay with it; the new copy has no review row — the marks have nowhere to go (FK), so there are none
  await q.query(
    `INSERT INTO org_review_marks (record_id, person_id, kind, reason, team_id, correction_id, cycle, created_at)
     SELECT DISTINCT ON (person_id) $1, person_id, kind, reason, team_id, correction_id, cycle, created_at FROM org_review_marks
      WHERE record_id = ANY($2::uuid[]) AND kind = 'wrong' AND EXISTS (SELECT 1 FROM org_reviews WHERE record_id = $1)
      ORDER BY person_id, created_at DESC
     ON CONFLICT DO NOTHING`, [newId, [...oldIds]]);
  return !!(await q.query("SELECT 1 FROM org_reviews WHERE record_id = $1 AND (held_at IS NOT NULL OR disputed_at IS NOT NULL)", [newId])).rowCount;
}

/** After COMMIT: locators — by the records database, the purge of what was removed — by the next job. Returns the removed id. */
async function afterPurge(app: App, db: Pick<pg.Pool, "query">, roots: readonly string[]): Promise<string[]> {
  const ids = await batchIds(db, roots);
  if (ids.length) await syncDeletionMarks(app.db.control, db, ids);
  for (const id of roots) await app.queue.kick({ instance: app.instanceId, class: "open", record_id: id, lane: "now" });
  return ids;
}

export type UnpublishReason = "profile_public_off" | "profile_hidden";

/**
 * Remove the copy for colleagues entirely: the person hid the profile from agents (`profile_hidden`) or deleted it
 * (`profile_public_off`). No trash; the personal record's checkboxes stay (they come back at the next checkbox save).
 * Under the person's profile lock — the caller already holds it (owner.ts). The profile switch is not checked: what is shown
 * can always be removed. Log: `forget {op: profile_public_off, reason, action: purge_now}`, the removed id. No copy — nothing.
 */
export async function unpublishProfile(app: App, caller: Caller | null, ownerId: string, reason: UnpublishReason): Promise<string[]> {
  const live = await liveCopies(app, ownerId);
  if (!live.length) return [];
  const db = app.db.recordsForWrite("open", caller?.scope ?? "system");
  await tx(db, (c) => purgeCopies(c, live.map((l) => l.id), caller?.person?.id ?? null));
  const ids = await afterPurge(app, db, live.map((l) => l.id));
  await audit(app, caller, { event_type: "forget", class: "open", record_ids: ids, space_id: live[0]!.space_id,
                             details: { op: "profile_public_off", reason, action: "purge_now", affected: ids.length } });
  return ids;
}

// ---------------------------------------------------------------- write
export interface ProfileWrite {
  sections?: unknown;
  /** "Show to colleagues": sections for the copy in org — only a person in the workplace. */
  public?: unknown;
  mode?: ProfileMode;
  /** MCP only: `agent` — the agent's guess, it does not get into the profile. */
  origin?: "human" | "agent";
  via: "workplace" | "mcp";
}
/** What became of the copy for colleagues after the write. */
export interface PublicCopyOut {
  /** What colleagues see now. */
  preview: PublicPreview;
  /** The copy was replaced or removed by this write. */
  changed: boolean;
  /**
   * Shown sections edited by an agent with extended access by the administrator's permission (`marked`): taken off the showing
   * — only the person can show them again with the "Show to colleagues" checkbox.
   */
  unpublished: ProfileSection[];
}
export interface ProfileWritten {
  id: string; version: number; class: DataClass; path: string; already_known: boolean; changed: ProfileSection[]; sections: ProfileSections;
  public: ProfileSection[]; updated_at: string; extended_write: boolean;
  /** The personal space address (slug) — for the `memory_remember` answer (field `space`). */
  space: string;
  public_copy: PublicCopyOut;
}

/**
 * Write profile sections and "Show to colleagues" checkboxes: the switch → who writes → the script key
 * → the agent's guess → input → under the person's lock: the current version (both classes) → hidden and an agent writes —
 * refusal → new sections and checkboxes → nothing changed and the copy matches — `already_known` → limits → "private life" →
 * (open) "never open" rules, the gate, the open check of the personal version → the copy gate → one transaction
 * of the open database: new version with `supersedes_id`, new org copy (entry `public_profile`, exempt), old copies — without
 * the trash. A profile hidden from agents continues its chain closed in the workplace (without the open check), it has
 * no copy. Log: `write {op: "profile", sections, mode}` for the version, `write {op: "profile_public", sections, removed}`
 * for the copy (ids of the new and the removed); removed with no replacement — `forget {op: profile_public_off}`; no text.
 */
export async function writeProfile(app: App, caller: Caller, w: ProfileWrite): Promise<ProfileWritten> {
  requireProfileEnabled(app);
  const who = profileWriterProblem(caller);
  if (who) throw who;
  // a script key writes past the model and does not pass the person's words (as correctionCaller): the profile lands
  // open and goes to all the person's agents in memory_me — such a key does not write it with any origin
  if (caller.clientKind === "script") throw invalid(PROFILE_SCRIPT_TEXT, { reason: "origin_not_allowed" });
  if (w.origin === "agent") throw invalid(PROFILE_GUESS_TEXT, { reason: "profile_agent_guess" });
  const mode: ProfileMode = w.mode ?? "replace";
  // "Show to colleagues" checkboxes — only a person in the workplace (an agent does not change them)
  if (w.public !== undefined && w.via !== "workplace") throw invalid("The person decides what to show to colleagues under “My profile” in the workspace", { field: "public" });
  const wantPublic = w.public === undefined ? null : checkPublic(w.public);
  if (w.sections === undefined && !wantPublic) throw invalid("Provide sections for the section text or public for what to show to colleagues", { field: "sections" });
  const changes = w.sections === undefined ? {} : checkChanges(w.sections, mode);
  const me = caller.person!;
  const space = await personalSpace(app, caller);
  const limits = limitsOf(app);
  return withKeyLock(profileLockKey(me.id), async () => {
    const ref = await currentProfileRef(app, me.id, space.id);
    // an agent does not change a profile hidden from agents (closed by the person) — only a person in the workplace; the external
    // agents' address gets the same refusal without the word "hidden": closed is not spoken of there. A residual sign,
    // noted in openapi-ingest.yaml ("Request channels"): an empty or open profile is written from outside, a hidden one is not,
    // so by the write outcome an external agent tells whether its own profile is hidden. Closing it needs refusing any profile
    // write from outside (`isExternal(caller) && w.via !== "workplace"` before currentProfileRef) — this takes from agents on
    // the external address the profile write from the person's words, so it is left as is
    if (ref?.cls === "closed" && w.via !== "workplace")
      throw isExternal(caller) ? new MemoryError("forbidden", PROFILE_WORKPLACE_TEXT, { details: { reason: "workplace_only" } })
        : new MemoryError("forbidden", PROFILE_HIDDEN_TEXT, { details: { reason: "profile_hidden" } });
    if (ref && (await app.db.control.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [ref.id])).rowCount) throw inProgress();
    const cur = ref ? await loadAttrs(app, caller, ref) : { sections: {}, public: [] } as ProfileAttrs;
    const cls: DataClass = ref?.cls ?? "open";
    const at = new Date();
    const source: ProfileSource = w.via === "workplace" ? "person" : "agent_on_behalf";
    // an agent with extended access by the administrator's permission: its text is not shown to colleagues by itself
    const marked = cls === "open" && openWriteMode(caller) === "marked";
    const { next, changed } = applySections(cur.sections, changes, mode, at.toISOString(), source, marked);
    // colleagues do not see a profile hidden from agents: its checkboxes do not change
    if (wantPublic && cls === "closed" && !samePublic(wantPublic, cur.public)) throw invalid(PROFILE_PUBLIC_HIDDEN_TEXT, { field: "public", reason: "profile_hidden" });
    const asked = wantPublic ?? cur.public;
    const unpublished = marked ? changed.filter((s) => asked.includes(s)) : [];
    const pub = asked.filter((s) => !unpublished.includes(s));
    const publicChanged = !samePublic(pub, cur.public);
    // the copy: only for an open profile; live copies are matched against what must be shown. A copy that does not exist
    // (removed on "Hide from agents" or on profile deletion, the profile restored from the trash or returned to agents) is made
    // only by a person saving the checkboxes in the workplace ("returns at the next checkbox save"): an
    // agent write and a section edit without `public` do not make it — otherwise an agent's action would widen the reader circle.
    // The match still replaces or removes a live copy
    const live = await liveCopies(app, me.id);
    const want = cls === "open" && (live.length > 0 || wantPublic !== null) ? publicCopyOf(next, pub) : null;
    const copyOk = live.length <= 1 && publicCopyMatches(want, live[0] ? { attrs: live[0].attrs, marked: live[0].marked } : null);
    const replace = !copyOk && !!want, removing = copyOk ? [] : live;
    const personalNew = !ref || changed.length > 0 || publicChanged;
    if (!ref && !changed.length) {
      throw w.sections === undefined ? invalid(PROFILE_PUBLIC_EMPTY_TEXT, { field: "public" }) : invalid("The profile is empty. Fill in at least one section", { field: "sections" });
    }
    if (ref && !personalNew && copyOk) {
      // the answer has the current sections: a hidden (closed) profile makes it a showing of closed — with an event, as for "My
      // profile"; the log did not accept it — no answer. Over MCP a closed one does not get here (profile_hidden above)
      if (ref.cls === "closed") await auditShownClosed(app, caller, [ref.id], "profile_view");
      return { id: ref.id, version: ref.version, class: ref.cls, path: recordPath(space.slug, "profile", ref.occurred_at, ref.id), already_known: true, changed: [],
               sections: cur.sections, public: cur.public, updated_at: ref.occurred_at.toISOString(), extended_write: false, space: space.slug,
               public_copy: { preview: live[0] ? previewOf(live[0].attrs, live[0].occurred_at) : { ...EMPTY_PREVIEW }, changed: false, unpublished: [] } };
    }
    if (changed.length) {
      const over = profileLimitProblem(next, changed, limits);
      if (over) throw new MemoryError("too_large", profileLimitText(over), { details: { section: over.section, tokens: over.tokens, max: over.max } });
      const priv = privateLifeFindings(Object.fromEntries(changed.map((s) => [s, next[s]?.text ?? null])), changed)[0];
      if (priv) {
        // into the log — only the section (by default): the log is read by
        // administrators and auditors, and a named employee's topic ("health", "family") is already about their private life.
        // The topic and the word are the caller's own text, they are only in the answer to them
        await audit(app, caller, { event_type: "write", class: null, space_id: space.id, details: { op: "profile_refused", reason: "private_content", section: priv.section } });
        throw invalid(privateLifeText(priv), { reason: "profile_private_content", topic: priv.topic, section: priv.section, word: priv.word });
      }
    }
    const text = profileText(next), sourceRef = workProfileRef(me.login);
    // the personal version's open check — only when section text changes: if only checkboxes changed, the text is that of
    // the current open version, already accepted; a repeated check would not let a checkbox be cleared after rules got stricter
    const extended = personalNew && cls === "open" && changed.length > 0 ? await admitOpen(app, caller, space, next, text, sourceRef) : null;
    // the copy: in org, the open check of its text — before anything is written; it shows only what is already shown — no repeat
    const org = replace ? await orgOf(app, caller) : null;
    if (replace && !org) throw invalid(PROFILE_PUBLIC_NO_ORG_TEXT, { field: "public", reason: "no_org" });
    const title = publicTitle(me.display_name ?? me.login), copyRef = workProfilePublicRef(me.login);
    if (replace) await admitCopy(app, caller, org!, want!, title, copyRef, !live.some((l) => l.title === title && publicCopyWithin(want!, l.attrs)));
    const personalRec: NewRecord = {
      type: "profile", space, classOverride: cls, title: PROFILE_TITLE, text, method: "stated_by_human", origin: "human", confirmed: true,
      sourceKind: "agent", sourceRef, occurredAt: at, entities: { known: [], unresolved: [] }, ownerId: me.id,
      attrs: { profile: { sections: next, public: pub, changed, by: source, ...(publicChanged ? { public_changed: true } : {}) } },
      version: (ref?.version ?? 0) + 1, supersedesId: ref?.id ?? null, auditDetails: { op: "profile", sections: changed, mode, ...(publicChanged ? { public: pub } : {}) },
    };
    const personalAdm: Admitted = { cls, openCheck: null, fallback: null, extended, derived: null };
    const copyRec = (from: string): NewRecord => ({
      type: "profile", space: org!, classOverride: "open", title, text: want!.text, method: "stated_by_human", origin: "human", confirmed: true,
      sourceKind: "agent", sourceRef: copyRef, occurredAt: at, entities: { known: [], unresolved: [] }, ownerId: me.id, attrs: publicAttrsOf(want!, from),
      orgVia: "public_profile", auditExtraIds: removing.map((l) => l.id),
      auditDetails: { op: "profile_public", sections: want!.sections, removed: live[0] ? live[0].attrs.sections.filter((s) => !want!.sections.includes(s)) : [] },
    });
    // the copy's mark — by content (an agent section with extended access, marked by the person): in attrs extended_write,
    // in the curator review row extended — the copy waits for the curator in "Under review"
    const copyAdm: Admitted = { cls: "open", openCheck: null, fallback: null, extended: want?.marked ?? null, derived: null };
    const db = app.db.recordsForWrite("open", caller.scope);
    // assigned in the transaction below (a closure): without the cast TS would narrow them to null
    let created = null as Created | null, copy = null as Created | null;
    if (cls === "open") {
      // one open-database transaction: the personal version, the new copy and the old ones' removal — all or nothing; events and
      // the worker wake-up — after COMMIT, locators of what was created are removed on rollback
      const effects: Array<() => Promise<unknown>> = [], made: string[] = [];
      try {
        await tx(db, async (c) => {
          if (personalNew) { created = await createRecord(app, caller, personalRec, personalAdm, { records: c, effects }); made.push(created.id); }
          if (replace) {
            const fresh = await createRecord(app, caller, copyRec(created?.id ?? ref!.id), copyAdm, { records: c, effects });
            copy = fresh;
            made.push(fresh.id);
            const entry = { instanceId: app.instanceId, by: me.id, human: isHumanSession(caller), extended: !!want!.marked };
            if (await carryCopyHold(app.db.control, fresh.id, removing.map((l) => l.id), entry)) effects.push(async () => invalidateHeld(app));
          }
          await purgeCopies(c, removing.map((l) => l.id), me.id);
        });
      } catch (e) {
        await dropUncommittedLocators(app.db.control, made);
        throw e;
      }
      const purged = removing.length ? await afterPurge(app, db, removing.map((l) => l.id)) : [];
      for (const fx of effects) await fx();
      if (purged.length && !replace)
        await audit(app, caller, { event_type: "forget", class: "open", record_ids: purged, space_id: removing[0]!.space_id,
                                   details: { op: "profile_public_off", reason: "profile_public_off", action: "purge_now", affected: purged.length } });
    } else {
      // hidden from agents: a closed version in its own transaction; no copy may exist — one left by a failure is removed
      if (personalNew) created = await createRecord(app, caller, personalRec, personalAdm);
      if (removing.length) {
        try { await unpublishProfile(app, caller, me.id, "profile_hidden"); }
        catch (e) { log.warn("profile_public_purge_deferred", { person: me.id, error: (e as Error).message.slice(0, 160) }); }
      }
    }
    const shownNow = copy ? previewOf(publicAttrsOf(want!, null).profile_public, at) : copyOk && live[0] ? previewOf(live[0].attrs, live[0].occurred_at) : { ...EMPTY_PREVIEW };
    const public_copy: PublicCopyOut = { preview: shownNow, changed: !!copy || removing.length > 0, unpublished };
    if (!created) {
      // the personal version is the same, only the copy changed (bring it back after "Show to agents")
      if (ref!.cls === "closed") await auditShownClosed(app, caller, [ref!.id], "profile_view");
      return { id: ref!.id, version: ref!.version, class: ref!.cls, path: recordPath(space.slug, "profile", ref!.occurred_at, ref!.id), already_known: true, changed: [],
               sections: cur.sections, public: cur.public, updated_at: ref!.occurred_at.toISOString(), extended_write: false, space: space.slug, public_copy };
    }
    const made: Created = created;
    return { id: made.id, version: (ref?.version ?? 0) + 1, class: made.class, path: made.path, already_known: false, changed, sections: next, public: pub,
             updated_at: at.toISOString(), extended_write: !!made.extended, space: space.slug, public_copy };
  });
}

// ---------------------------------------------------------------- reading in the workplace
export interface MyProfileSectionView { text: string; updated_at: string; source: ProfileSource; stale?: true; extended_write?: true }
export interface MyProfileView {
  id: string | null; version: number | null; updated_at: string | null; path: string | null;
  /** The profile is hidden by the person from agents (closed): agents do not see it, editing — only in the workplace. */
  hidden: boolean;
  sections: Partial<Record<ProfileSection, MyProfileSectionView>>;
  /** Sections marked "Show to colleagues"; "For the agent" — never. */
  public: ProfileSection[];
  /** How colleagues see it: exactly what is in the copy in "Company common knowledge" now; no copy — empty. */
  public_preview: PublicPreview;
  limits: ProfileLimits;
}

export function profileView(o: { id: string | null; version: number | null; updated_at: string | null; path: string | null; hidden: boolean; sections: ProfileSections; public: ProfileSection[];
                                 public_preview?: PublicPreview },
                            limits: ProfileLimits, now: Date = new Date()): MyProfileView {
  const sections: MyProfileView["sections"] = {};
  for (const s of PROFILE_SECTIONS) {
    const v = o.sections[s];
    if (!v) continue;
    sections[s] = { text: v.text, updated_at: v.updated_at, source: v.source, ...(s === "focus" && focusStale(v.updated_at, limits.focus_fresh_days, now) ? { stale: true as const } : {}),
                    ...(v.extended ? { extended_write: true as const } : {}) };
  }
  return { id: o.id, version: o.version, updated_at: o.updated_at, path: o.path, hidden: o.hidden, sections, public: o.public,
           public_preview: o.public_preview ?? { ...EMPTY_PREVIEW }, limits };
}

/** "My profile" (GET /api/v1/me/profile): the current version of one's profile and what colleagues see; hidden (closed) — showing logged. */
export async function readMyProfile(app: App, caller: Caller): Promise<MyProfileView> {
  const space = await personalSpace(app, caller);
  const limits = limitsOf(app);
  const ref = await currentProfileRef(app, caller.person!.id, space.id);
  const live = (await liveCopies(app, caller.person!.id))[0];
  const preview = live ? previewOf(live.attrs, live.occurred_at) : { ...EMPTY_PREVIEW };
  if (!ref) return profileView({ id: null, version: null, updated_at: null, path: null, hidden: false, sections: {}, public: [], public_preview: preview }, limits);
  const attrs = await loadAttrs(app, caller, ref);
  // closed is not given out without a log record: the log did not accept it — no answer
  if (ref.cls === "closed") await auditShownClosed(app, caller, [ref.id], "profile_view");
  return profileView({ id: ref.id, version: ref.version, updated_at: ref.occurred_at.toISOString(), path: recordPath(space.slug, "profile", ref.occurred_at, ref.id),
                       hidden: ref.cls === "closed", sections: attrs.sections, public: attrs.public, public_preview: preview }, limits);
}

export interface ProfileHistoryItem { id: string; version: number; at: string; source: ProfileSource | null; sections_changed: ProfileSection[]; public_changed?: true }

/**
 * One's own profile history: versions newest first, paged — without the text of older versions, only when, who and
 * which sections (and whether what colleagues see changed); a version's text — by a plain record read by id (read only by one who
 * reads the personal space).
 */
export async function myProfileHistory(app: App, caller: Caller, o: { limit: number; offset: number }): Promise<{ items: ProfileHistoryItem[]; next_cursor: string | null }> {
  const space = await personalSpace(app, caller);
  const locs = (await app.db.control.query(
    "SELECT record_id, class FROM record_locations WHERE owner_id = $1 AND space_id = $2 AND type = 'profile' AND NOT deleted", [caller.person!.id, space.id])).rows as Array<{ record_id: string; class: DataClass }>;
  const all: Array<ProfileHistoryItem & { t: number }> = [];
  for (const cls of ["open", "closed"] as const) {
    const ids = locs.filter((l) => l.class === cls).map((l) => l.record_id);
    if (!ids.length || !caller.scope.classes.includes(cls)) continue;
    const rows = (await app.db.records(cls, caller.scope).query(
      `SELECT id, version, occurred_at, attrs #> '{profile,changed}' AS changed, attrs #>> '{profile,by}' AS by, attrs #> '{profile,public_changed}' AS public_changed FROM records
        WHERE id = ANY($1::uuid[]) AND type = 'profile' AND source_ref LIKE 'workprofile:%' AND deleted_at IS NULL`, [ids])).rows;
    for (const r of rows) {
      const p = parseProfileAttrs({ changed: r.changed ?? [], by: r.by, public_changed: r.public_changed });
      all.push({ id: r.id, version: Number(r.version), at: new Date(r.occurred_at).toISOString(), source: p.by ?? null, sections_changed: p.changed ?? [],
                 ...(p.public_changed ? { public_changed: true as const } : {}), t: new Date(r.occurred_at).getTime() });
    }
  }
  all.sort((a, b) => b.version - a.version || b.t - a.t || (a.id < b.id ? 1 : -1));
  const page = all.slice(o.offset, o.offset + o.limit).map(({ t: _t, ...x }) => x);
  return { items: page, next_cursor: all.length > o.offset + o.limit ? String(o.offset + o.limit) : null };
}

// ---------------------------------------------------------------- copy for a colleague
export interface PublicProfileView { login: string; id: string; path: string; updated_at: string; sections: Partial<Record<PublicSection, PublicValue>> }

/**
 * What an employee shows colleagues (`GET /api/v1/people/{login}/profile`): the live copy in org by its read rights
 * (loadReadable: "Company common knowledge", the "Wrong" hold). No person, no copy, or reading not allowed — not_found.
 * The copy is open — no read event (open has no event).
 */
export async function readPublicProfile(app: App, caller: Caller, login: string): Promise<PublicProfileView> {
  if (!login || login.length > 320) throw notFound();
  const person = (await app.db.control.query(
    "SELECT id, login FROM people WHERE instance_id = $1 AND lower(login) = lower($2) ORDER BY active DESC, login LIMIT 1", [app.instanceId, login])).rows[0] as { id: string; login: string } | undefined;
  if (!person) throw notFound();
  const top = (await liveCopies(app, person.id))[0];
  if (!top) throw notFound();
  const { rec, spaces } = await loadReadable(app, caller, top.id);
  const view = previewOf(parsePublicAttrs((rec.attrs as Record<string, unknown> | null)?.profile_public), rec.occurred_at);
  const slug = spaces.get(rec.space_id)?.slug ?? "org";
  return { login: person.login, id: rec.id, path: recordPath(slug, "profile", new Date(rec.occurred_at), rec.id), updated_at: view.updated_at!, sections: view.sections };
}

// ---------------------------------------------------------------- for the agent: memory_remember kind=profile,
// memory_me.profile, memory_read /me/profile — the same `access.profile_enabled` switch

/** memory_remember fields a profile write lacks: the server sets the profile's title, date and links. */
export const PROFILE_FORBIDDEN_FIELDS = ["title", "entities", "occurred_at", "domains", "derived_from", "derivation"] as const;

export interface RememberProfileArgs {
  text: string; kind?: string; section?: unknown; mode?: unknown; origin?: "agent" | "human"; space?: unknown;
  title?: unknown; entities?: unknown; occurred_at?: unknown; domains?: unknown; derived_from?: unknown; derivation?: unknown;
}

/**
 * The `memory_remember kind=profile` input, before rights and the database: section required; mode — replace (default) or append;
 * only one's own profile, only in personal — `space` other than `me` refused (the schema sets `me` by default, Ajv useDefaults:
 * an explicit `me` looks like a missing one, and both fit); title, entities, occurred_at, domains, derived_from, derivation —
 * invalid_argument with the field name. Text as is: edge spaces and an empty section are for applySections (a space in replace
 * clears a section). In append empty text is refused here, with the field `text` (the common check would name
 * the REST field `sections.<section>`, which memory_remember does not have).
 */
export function profileRememberInput(a: RememberProfileArgs): { section: ProfileSection; mode: ProfileMode; text: string } {
  if (a.space !== undefined && a.space !== "me") throw invalid("You can write only to your own work profile in your personal space. Omit space or pass space: me", { field: "space" });
  for (const f of PROFILE_FORBIDDEN_FIELDS)
    if (a[f] !== undefined) throw invalid(`Profile writes have no ${f} field. Pass text, section, mode and origin: human`, { field: f });
  if (a.section === undefined) throw invalid(`With kind: profile, specify section as one of ${PROFILE_SECTIONS.join(", ")}`, { field: "section" });
  if (!isProfileSection(a.section)) throw invalid(`section must be one of these profile sections: ${PROFILE_SECTIONS.join(", ")}`, { field: "section" });
  const mode = a.mode ?? "replace";
  if (mode !== "replace" && mode !== "append") throw invalid("mode must be replace or append", { field: "mode" });
  if (mode === "append" && !(a.text ?? "").trim())
    throw invalid(`In append mode, provide text to add to the “${PROFILE_SECTION_TITLES[a.section]}” section`, { field: "text" });
  return { section: a.section, mode, text: a.text };
}

/**
 * A refusal of the common profile write input — in memory_remember words: writeProfile checks the REST body `{sections}` and
 * names the field `sections` or `sections.<section>`, but the agent has no such field — only `text` and `section`. Such a refusal
 * is renamed: field `text`, the section in details. One case is left: no profile yet, and a space in replace clears a section —
 * nothing to clear. Other refusals (a guess, limits, "private life", rights) — as is.
 */
export function rememberFieldError(e: unknown, section: ProfileSection, text: string): unknown {
  if (!(e instanceof MemoryError) || e.code !== "invalid_argument") return e;
  const field = e.extra.details?.field;
  if (typeof field !== "string" || (field !== "sections" && !field.startsWith("sections."))) return e;
  const title = PROFILE_SECTION_TITLES[section];
  const message = text.trim()
    ? `The text for the “${title}” section was rejected: ${e.message.replace(/^sections(\.\w+)?:\s*/, "")}`
    : `The profile has not been filled in. The “${title}” section is already empty. Pass the text you want to save in text`;
  return invalid(message, { field: "text", section });
}

/** A section's result in the `memory_remember` answer: its text after the write (empty — cleared), when changed, the profile version. */
export interface RememberedSection {
  section: ProfileSection; text: string; updated_at: string; version: number;
  /** Sections shown to colleagues and edited by an agent with extended access — off the showing until the person's checkbox. */
  public_unpublished?: ProfileSection[];
}

/**
 * The answer tail about the copy for colleagues: a section edited by an agent with extended access leaves the showing — only
 * the person can show it again; the copy updated — colleagues see the new; removed (nothing to show) — they no longer see it.
 * The copy was not touched — empty.
 */
export function publicCopyTail(c: (Pick<PublicCopyOut, "changed" | "unpublished"> & { preview?: PublicPreview }) | null | undefined): string {
  if (!c) return "";
  if (c.unpublished.length) {
    const names = c.unpublished.map((s) => `“${PROFILE_SECTION_TITLES[s]}”`).join(", ");
    return ` · ${c.unpublished.length > 1 ? "sections" : "section"} ${names} ${c.unpublished.length > 1 ? "are no longer" : "is no longer"} visible to colleagues: `
      + "the person can show the content again by selecting “Show to colleagues” under “My profile”";
  }
  if (!c.changed) return "";
  return c.preview && !Object.keys(c.preview.sections).length ? " · colleagues can no longer see the profile in “Company knowledge”"
    : " · colleagues can see the updated profile in “Company knowledge”";
}

/** The `memory_remember kind=profile` answer text: what became of the section; its text — between data markers (memory data). */
export function rememberProfileText(r: { already_known: boolean; extended_write: boolean; profile: RememberedSection;
                                           public_copy?: Pick<PublicCopyOut, "changed" | "unpublished"> & { preview?: PublicPreview } }, texts: McpTexts): string {
  const title = PROFILE_SECTION_TITLES[r.profile.section];
  const pub = publicCopyTail(r.public_copy);
  if (r.already_known) return `The profile already has this content. The “${title}” section was unchanged · ${PROFILE_PATH}${pub}`;
  const tail = (r.extended_write ? MARKED_TAIL : "") + pub;
  if (!r.profile.text) return `Profile updated: “${title}” section cleared · version ${r.profile.version} · ${PROFILE_PATH}${tail}`;
  return `Profile updated: “${title}” section · version ${r.profile.version} · ${PROFILE_PATH} · visible to the person and their agents${tail}\n${asData(`## ${title}\n${r.profile.text}`, { texts })}`;
}

/**
 * `memory_remember kind=profile`: input → the common profile write `writeProfile` with `via: "mcp"` (the switch, only
 * a person with their own key, a script key — `origin_not_allowed`, `origin: agent` — refusal `profile_agent_guess`, limits,
 * "private life", the strict open check, a new version under the person's lock). Only one's own profile: this path knows
 * no other profile. An input refusal with the REST field `sections` — renamed to the field `text` (rememberFieldError).
 */
export async function rememberProfile(app: App, caller: Caller, a: RememberProfileArgs) {
  const { section, mode, text } = profileRememberInput(a);
  const out = await writeProfile(app, caller, { sections: { [section]: text }, mode, origin: a.origin ?? "agent", via: "mcp" })
    .catch((e: unknown) => { throw rememberFieldError(e, section, text); });
  const value = out.sections[section];
  const profile: RememberedSection = { section, text: value?.text ?? "", updated_at: value?.updated_at || out.updated_at, version: out.version,
                                       ...(out.public_copy.unpublished.length ? { public_unpublished: out.public_copy.unpublished } : {}) };
  const result = { id: out.id, path: out.path, type: "profile" as const, space: out.space, class: out.class, origin: "human" as const, already_known: out.already_known,
                   profile, ...(out.extended_write ? { extended_write: true as const } : {}) };
  return { result, text: rememberProfileText({ already_known: out.already_known, extended_write: out.extended_write, profile, public_copy: out.public_copy }, textsOf(app)) };
}

/**
 * Whom `memory_me` reads the profile for and whom `memory_read /me/profile` answers: a person with their own key — personal,
 * extended or a connection (OAuth). Not a workplace session (bucket `session_me`: the frame asks /me on every page, and
 * a person's profile is on the "My profile" page), not a service "on behalf of", not a service without a person and not the
 * "view as" panel preview (the administrator does not read the profile).
 */
export function profileReaderOf(caller: Pick<Caller, "principalType" | "person" | "onBehalfOf" | "preview" | "keyKind">): boolean {
  return caller.principalType === "person" && !!caller.person && !caller.onBehalfOf && !caller.preview && ["personal", "extended", "connection"].includes(caller.keyKind);
}

export interface MeProfileSection { text: string; updated_at: string; stale?: true; note?: string }
/** Position and department — from the person's card in control (not from the closed directory card), the manager — by manager_login. */
export interface MeProfileOrg { department: string | null; position: string | null; manager: string | null }
export type MeProfile = { org: MeProfileOrg; path: typeof PROFILE_PATH } & Partial<Record<ProfileSection, MeProfileSection>>;

/**
 * `memory_me.profile` — a pure build: empty sections are not given; `stale` and `note` — only for "Now in progress" older than
 * `focus_fresh_days`; no activity numbers. No section at all — null: the profile is not filled in.
 */
export function meProfileView(sections: ProfileSections, org: MeProfileOrg, limits: ProfileLimits, tz: string, now: Date = new Date()): MeProfile | null {
  const out: MeProfile = { org, path: PROFILE_PATH };
  let any = false;
  for (const s of PROFILE_SECTIONS) {
    const v = sections[s];
    if (!v?.text.trim()) continue;
    any = true;
    out[s] = { text: v.text, updated_at: v.updated_at,
               ...(s === "focus" && focusStale(v.updated_at, limits.focus_fresh_days, now) ? { stale: true as const, note: focusStaleNote(v.updated_at, tz, now) } : {}) };
  }
  return any ? out : null;
}

/** Profile state for the `memory_me` text line. */
export type MeProfileState = { kind: "none" } | { kind: "hidden" } | { kind: "filled"; updated_at: string; focus?: MeProfileSection };

/**
 * The `memory_me` text line: "profile: filled in (updated 12 August)", "profile not filled in" or "profile hidden from agents".
 * For clients that give the model only text — the read path and the mark of a stale "Now in progress".
 */
export function meProfileLine(st: MeProfileState, tz: string, now: Date = new Date()): string {
  if (st.kind === "none") return " · profile is empty";
  if (st.kind === "hidden") return " · profile is hidden from agents (restore access in the workspace)";
  const day = dayMonthText(st.updated_at, tz, now);
  return ` · profile: filled in${day ? ` (updated ${day})` : ""} — read with memory_read ${PROFILE_PATH}${st.focus?.stale ? ` · “Current work” ${st.focus.note}` : ""}`;
}

/** The caller's personal space — from the already read space map or anew. */
const ownSpace = async (app: App, caller: Caller, spaces?: Map<string, SpaceAccess>): Promise<SpaceAccess | null> =>
  resolveSpace(app, caller, "me", spaces ?? await readableSpaces(app, caller));

/**
 * The profile for `memory_me`: the switch is off or the caller is not from profileReaderOf — null (no field, no line).
 * Otherwise: no profile or no section — `profile: null`, "not filled in"; hidden by the person from agents (closed) — `null`,
 * "hidden" (on the external agents' address — as not filled in); open — the object and the id for the event
 * `read {tool: memory_me}`. Sections are read with the caller's pool, only one's own; position and manager — from control.
 */
export async function meProfile(app: App, caller: Caller, spaces?: Map<string, SpaceAccess>, now: Date = new Date())
  : Promise<{ profile: MeProfile | null; line: string; recordId: string | null } | null> {
  if (!profileEnabled(app) || !profileReaderOf(caller)) return null;
  const tz = instanceTz(app.settings);
  const space = await ownSpace(app, caller, spaces);
  const ref = space ? await currentProfileRef(app, caller.person!.id, space.id) : null;
  if (!ref) return { profile: null, line: meProfileLine({ kind: "none" }, tz, now), recordId: null };
  // the external agents' address says nothing about closed: a profile hidden from agents is there exactly like
  // an empty one (`profile: null`, "not filled in"), not "hidden" or "no field" — else the answer shape would tell one's own
  // closed from a missing profile; a write into it — refusal without that word (writeProfile)
  if (ref.cls === "closed") return { profile: null, line: meProfileLine({ kind: isExternal(caller) ? "none" : "hidden" }, tz, now), recordId: null };
  const [attrs, org] = await Promise.all([loadAttrs(app, caller, ref), profileOrg(app, caller.person!.id)]);
  const profile = meProfileView(attrs.sections, org, limitsOf(app), tz, now);
  if (!profile) return { profile: null, line: meProfileLine({ kind: "none" }, tz, now), recordId: null };
  return { profile, line: meProfileLine({ kind: "filled", updated_at: ref.occurred_at.toISOString(), ...(profile.focus ? { focus: profile.focus } : {}) }, tz, now), recordId: ref.id };
}

/**
 * "Now in progress" is stale — for the workplace menu summary (`GET /me/nav`): the line "Update "Now in
 * progress"" on the "Overview". Returns the section update date or null: off, no
 * person, profile or section, the section is fresh. A profile hidden from agents (closed) is not read at all: a showing of closed
 * writes a log event, and the menu summary is asked on every page. Only one's own open record is read with the caller's
 * pool; outwards — one date, no text.
 */
export async function navFocusStale(app: App, caller: Caller, now: Date = new Date()): Promise<string | null> {
  if (!profileEnabled(app) || !caller.person) return null;
  const space = await ownSpace(app, caller);
  const ref = space ? await currentProfileRef(app, caller.person.id, space.id) : null;
  if (!ref || ref.cls !== "open" || !caller.scope.classes.includes("open")) return null;
  const focus = (await loadAttrs(app, caller, ref)).sections.focus;
  return focus?.text.trim() && focusStale(focus.updated_at, limitsOf(app).focus_fresh_days, now) ? focus.updated_at : null;
}

/** Department, position and the current manager's name (by manager_login) from the person's card in control. */
async function profileOrg(app: App, personId: string): Promise<MeProfileOrg> {
  const r = (await app.db.control.query(
    `SELECT p.department, p.role, m.display_name AS manager FROM people p
       LEFT JOIN people m ON m.instance_id = p.instance_id AND m.active AND p.manager_login IS NOT NULL AND lower(m.login) = lower(p.manager_login) AND m.id <> p.id
      WHERE p.id = $1 LIMIT 1`, [personId])).rows[0] as { department: string | null; role: string | null; manager: string | null } | undefined;
  const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { department: clean(r?.department), position: clean(r?.role), manager: clean(r?.manager) };
}

/**
 * `memory_read /me/profile`: the id of one's own current profile version. Off, the caller not from profileReaderOf (a service "on
 * behalf of"), no personal space or profile — `not_found`. Then — a plain read: a hidden profile to a key without
 * the closed class is given as a "closed class" locator, like any own closed record.
 */
export async function profileRecordForPath(app: App, caller: Caller, spaces?: Map<string, SpaceAccess>): Promise<string> {
  if (!profileEnabled(app) || !profileReaderOf(caller)) throw notFound();
  const space = await ownSpace(app, caller, spaces);
  const ref = space ? await currentProfileRef(app, caller.person!.id, space.id) : null;
  if (!ref) throw notFound();
  return ref.id;
}

/**
 * The `memory_read` line at the current version of the work profile ("the same set — via memory_read /me/profile"):
 * "Now in progress" is stale — check with the person. Not the profile, not the current version, off or fresh — empty.
 */
export function profileReadNote(app: Pick<App, "settings">, rec: { type: string; source_ref?: string | null; is_current?: boolean | null; attrs?: Record<string, any> | null },
                                now: Date = new Date()): string {
  if (rec.type !== "profile" || !rec.source_ref?.startsWith(WORKPROFILE_PREFIX) || rec.is_current === false || !profileEnabled(app)) return "";
  const focus = parseProfileAttrs(rec.attrs?.profile).sections.focus;
  if (!focus || !focusStale(focus.updated_at, limitsOf(app).focus_fresh_days, now)) return "";
  return `For “Current work”, ${focusStaleNote(focus.updated_at, instanceTz(app.settings), now)} instead of stating it as fact.`;
}

// ---------------------------------------------------------------- workplace routes
const WHERE = { path: "/me/profile", section: "My profile" };

/**
 * The "My profile" REST: only a person in the workplace (a session), buckets — `spaces_view` for reading and
 * `me_keys` for writing. Switch off — `403` with the "work profile turned off by the administrator" text on all routes.
 */
export function registerProfileRoutes(r: Hono<any>, app: App): void {
  const who = async (c: Context, bucket: "spaces_view" | "me_keys", what: string): Promise<Caller> => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, bucket);
    requireProfileEnabled(app);
    await requireHuman(app, caller, what, WHERE);
    return caller;
  };
  r.get("/api/v1/me/profile", async (c) => c.json(await readMyProfile(app, await who(c, "spaces_view", "View your work profile"))));
  r.put("/api/v1/me/profile", async (c) => {
    const caller = await who(c, "me_keys", "Edit your work profile");
    const body = jsonObjectBody(await c.req.json().catch(() => null), "{sections, public}");
    rejectUnknownFields(body, ["sections", "public"]);
    const out = await writeProfile(app, caller, { sections: body.sections, public: body.public, via: "workplace" });
    return c.json({ already_known: out.already_known, changed: out.changed,
                    profile: profileView({ id: out.id, version: out.version, updated_at: out.updated_at, path: out.path, hidden: out.class === "closed", sections: out.sections,
                                           public: out.public, public_preview: out.public_copy.preview }, limitsOf(app)) });
  });
  r.get("/api/v1/me/profile/history", async (c) => {
    const caller = await who(c, "spaces_view", "View your work profile history");
    return c.json(await myProfileHistory(app, caller, { limit: intParam(c.req.query("limit"), 20, 1, 100, "limit"), offset: offsetCursor(c.req.query("cursor")) }));
  });
  // what a colleague shows colleagues: the copy in "Company common knowledge" by its read rights
  r.get("/api/v1/people/:login/profile", async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "spaces_view");
    requireProfileEnabled(app);
    await requireHuman(app, caller, "View a colleague’s profile", { path: "/people", section: "People" });
    return c.json(await readPublicProfile(app, caller, c.req.param("login")));
  });
}
