// "Make available to agents".
// The author of a record the open check kept closed shows it to agents themselves — as a person in the workplace, in
// personal, team and project spaces (not in "Company common knowledge", not a meeting). First a preview: what the check found
// (by rule, with the count and where), who will see the record, what the consent covers — and a signed 15-minute consent token.
// The consent is bound to a version: a content fingerprint of the whole tree (with colleagues' marks), a readers fingerprint,
// the root's space, the scope (solo/shared), "text only" and the record's last move. "Show" checks all of it
// again, the move once more on the copy (worker). Matches are in neither answers nor the log; fingerprints only in the token and
// in class_moves. The shared parts (fingerprints, token, rule verdict, switches) are in packages/shared/src/despite.ts.
import { acceptedSettings, ACCEPTABLE_RULES, audiencePrint, audienceRows, CHAIN_TREE, CONSENT_ENTITIES_SQL, consentPayload, consentRows, consentScope, contentPrint, despiteKeys,
         despiteSettings, despiteVerdict, invalid, meetingOrigin, MemoryError, neverOpenFromTree, openCheckReasons, openCheckSettings, openCheckTruncated, openTreeTooLarge, signConsent, verifyConsent,
         type ConsentRow, type ConsentRows, type DespiteKeys, type DespiteScope, type OpenCheckFinding, type OpenCheckSettings, type OpenCheckText,
         type OpenCheckUnchecked } from "@memory/shared";
import type pg from "pg";
import type { App, Caller } from "./context.ts";
import { canWrite, readableSpaces, spaceArchived, type Locator, type SpaceAccess } from "./access.ts";
import { audit } from "./audit.ts";
import { openCheckOutcome, refuseOpen, treeTexts } from "./open-check.ts";
import { neverOpenReason, openTarget } from "./owner.ts";
import { requireHuman } from "./workplace.ts";

// ---------------------------------------------------------------- keys
const keyCache = new Map<string, DespiteKeys>();
/**
 * Keys of the fingerprints and the token signature: from App (index.ts computes them once at start), else from the app secret,
 * cached per process (an App assembled by hand: unit tests, service scripts).
 */
export function despiteKeysOf(app: Pick<App, "appSecret" | "despiteKeys">): DespiteKeys {
  if (app.despiteKeys) return app.despiteKeys;
  let k = keyCache.get(app.appSecret);
  if (!k) { k = despiteKeys(app.appSecret); keyCache.set(app.appSecret, k); }
  return k;
}

/** The closed base in the system context: one's own record's tree rows for fingerprints and counts — a server action, no content answered. */
const closedSys = (app: App) => app.db.records("closed", { classes: ["open", "closed"] as const, tier: "system" as const });

// ---------------------------------------------------------------- "stale" and "not allowed" answers
/** Why the consent no longer holds (details.open_check.stale): the record changed, a new finding, readers changed, it expired. */
export type StaleReason = "changed" | "more_found" | "audience" | "expired";
const STALE_TEXT: Record<StaleReason, string> = {
  changed: "The record changed while this page was open. Review the check results again",
  more_found: "The check found something new in the record. Review the results again",
  audience: "Who can see this record has changed. Review who will be able to see it",
  expired: "The page was open too long. The memory checked the record again. Review the results",
};
/** "Stale" is a 422 open_check without findings: the workplace returns the author to the panel with a new preview. */
export const staleOpen = (stale: StaleReason): MemoryError =>
  new MemoryError("open_check", STALE_TEXT[stale], { hint: "Refresh the record page so the memory can check it again and show what it finds", details: { open_check: { via: "open", findings: [], stale } } });

const STALE_PAGE = "This page is out of date. Refresh it and confirm again";

/** Why it cannot be shown (403 forbidden, details.reason; the not_allowed state of the preview). */
export type NotAllowedReason = "org_space" | "org_placement" | "other_spaces" | "meeting" | "archived" | "no_write" | "disabled" | "projects_disabled" | "scans_disabled";
/** The author no longer reads the space (excluded) — without its name (only readable spaces are named). */
const noWriteText = (s: string | null) => `You can no longer edit records ${s ? `in the space “${s}”` : "in this space"}, so you cannot show this record to agents.`;
/**
 * How to make what is needed available to agents when this record cannot be shown (like the workplace's SHOW_ANYWAY_ANEW):
 * as a new record. Editing one's note does not remove the finding — a fix lands as a new version, the old one stays in
 * the chain, and the check and the move take the whole chain (CHAIN_TREE).
 */
export const DESPITE_ANEW = "as a new note, or upload a corrected file again (editing this record will not help: memory checks its earlier versions too)";
/** "Meeting": a meeting and what was derived from it — and a record whose source memory can no longer check. */
export const MEETING_NOT_ALLOWED = "Meetings and records derived from them cannot be shown this way. Neither can records whose source was deleted or whose source link is incomplete: memory cannot verify whether they came from a meeting.";
/** The texts verbatim, with a full stop: the workplace shows the 403 message as is. */
const NOT_ALLOWED_TEXT: Record<NotAllowedReason, (space: string | null) => string> = {
  org_space: () => `You cannot show a record in “Company knowledge” to agents with this finding. Save what you need without the flagged content ${DESPITE_ANEW}.`,
  org_placement: () => "This record is placed in “Company knowledge”, so it cannot be shown to agents with this finding.",
  other_spaces: () => "Some records extracted from this record are in another space, so they cannot all be shown together.",
  // and a record whose origin can no longer be checked (the source purged, the link written incompletely)
  meeting: () => MEETING_NOT_ALLOWED,
  archived: noWriteText,
  no_write: noWriteText,
  disabled: () => `The administrator turned off “Make available to agents”. Save what you need without the flagged content ${DESPITE_ANEW}, or ask the administrator.`,
  projects_disabled: () => `The administrator turned off “Make available to agents” for team spaces and projects. Save what you need without the flagged content ${DESPITE_ANEW}, or ask the administrator.`,
  // only for "Show": showing scans as text was turned off between the preview and the click; the preview answers
  // never/scans_disabled with the same text
  scans_disabled: () => "The administrator has disabled showing scans as text. Only people can see the file.",
};
export const notAllowed = (reason: NotAllowedReason, spaceName: string | null): MemoryError =>
  new MemoryError("forbidden", NOT_ALLOWED_TEXT[reason](spaceName), { details: { reason } });

// ---------------------------------------------------------------- scope and "from a meeting"
export interface SpaceView { id: string; slug: string; name: string; kind: string }
export type ScopeOutcome = { scope: DespiteScope; space: SpaceView; readable: Map<string, SpaceAccess> } | { refuse: NotAllowedReason; space: SpaceView | null };

/**
 * Where and to whom it may be shown. In order: the root's space ("Common knowledge" — org_space, archive — archived), the
 * author's right to write there (`readableSpaces` with the archive, `canWrite`: reader, excluded — no_write), tree rows outside
 * the root's space (other_spaces), placement in "Common knowledge" (org_placement), a meeting and what was derived from it
 * (meeting), the scope — "only you" or "not only you" — and the panel switches (disabled, projects_disabled). A space
 * is named in the answer only if the author reads it: one excluded from a project gets `space: null` and "in this
 * space".
 */
export async function despiteScope(app: App, caller: Caller, loc: Pick<Locator, "record_id" | "space_id">, c: ConsentRows): Promise<ScopeOutcome> {
  const me = caller.person!;
  const sp = (await app.db.control.query("SELECT id, slug, name, kind, owner_id, archived_at FROM spaces WHERE id = $1", [loc.space_id])).rows[0];
  if (!sp) return { refuse: "no_write", space: null };
  const space: SpaceView = { id: sp.id, slug: sp.slug, name: sp.name, kind: sp.kind };
  if (sp.kind === "org") return { refuse: "org_space", space };
  // the author's role as for a read by id (map with archive; the access-author-role-pg guard test matches it with the worker)
  const readable = await readableSpaces(app, caller, { archived: true });
  const mine = readable.get(sp.id);
  if (sp.archived_at) return { refuse: "archived", space: mine ? space : null };
  if (!mine || !canWrite(mine)) return { refuse: "no_write", space: mine ? space : null };
  if (c.rows.some((r) => r.space_id !== sp.id)) return { refuse: "other_spaces", space };
  const placed = [...new Set(c.placements.map((p) => p.space_id))];
  if (placed.length && (await app.db.control.query("SELECT 1 FROM spaces WHERE id = ANY($1::uuid[]) AND kind = 'org' LIMIT 1", [placed])).rowCount) return { refuse: "org_placement", space };
  if (await isMeetingTree(app, c.rows, loc.record_id)) return { refuse: "meeting", space };
  const scope = consentScope(c, { spaceId: sp.id, spaceKind: sp.kind, spaceOwner: sp.owner_id }, me.id);
  const ds = despiteSettings(app.settings);
  if (!ds.enabled) return { refuse: "disabled", space };
  if (scope === "shared" && !ds.projects) return { refuse: "projects_disabled", space };
  return { scope, space, readable };
}

/**
 * A meeting and what was derived from it (meetings are never shown) — the shared sign `meetingOrigin`
 * (shared/despite.ts): a transcript in the tree, a mark on a tree row (MEETING_MARK_SQL: "passed from a meeting", a keeper's copy
 * from a meeting, detaching from a meeting, a lost or unfinished origin), a derived_from
 * link (confirmed or active) to a meeting at any depth — via retellings of retellings, versions of one's note and ancestors
 * of sources, with the same mark on the source. The same sign is repeated by the worker's gate on
 * the copy. Read in the system context, without content: the tree is in the record's closed base (a closed one is shown),
 * the sources in the bases of both classes.
 */
export async function isMeetingTree(app: App, rows: ReadonlyArray<Pick<ConsentRow, "id" | "type">>, rootId: string): Promise<boolean> {
  return meetingOrigin({ tree: closedSys(app), control: app.db.control,
                         records: (cls) => app.db.records(cls, { classes: ["open", "closed"] as const, tier: "system" as const }) }, rows, rootId);
}

// ---------------------------------------------------------------- what the check found
/**
 * A rule's finding in the preview: in how many checked places (a field, a text variant, an extracted record) it fired
 * at least once — NOT how many matches (the check marks the first in each place; the panel says exactly
 * "in N places"), whether there are more (the round is cut), where — in the record itself and in the extracted ones.
 */
export interface FoundRule { rule: string; kind: string; reason: string; count: number; more: boolean; in_record: number; in_extracted: number }
export interface Discovery { rules: string[]; found: FoundRule[]; never: OpenCheckFinding[]; unchecked: OpenCheckUnchecked | null }
/** No more rounds than rules that can be accepted, plus one — to make sure nothing is behind them. */
export const DISCOVER_ROUNDS = ACCEPTABLE_RULES.length + 1;

/**
 * All rules the check would find: round after round with the rules found so far turned off — the limit of
 * 20 findings hides neither a tax ID nor a secret behind phones. A secret, a client from the NDA list, the administrator's own
 * rule — `never` and stop (passport, national ID number and card are decided by scope by the caller). Writes no log, never throws:
 * "not checked" goes into `unchecked`. No convergence within DISCOVER_ROUNDS rounds — `check_failed`.
 * The finding count: a round that hit the limit does not know which rule's findings were cut (19 phones and 3 tax IDs — in
 * the round 19 and 1), and a rule found in it is turned off afterwards. So after convergence each such rule is counted
 * in a pass of its own — only it, the other found ones off: under 20 the count is exact, else "20 or more" (`more`).
 * Check passes IN ALL — rounds and recounts together — are at most DISCOVER_ROUNDS (recounts beyond the rounds doubled
 * the time and the places in the check queue). Budget spent — an uncounted rule keeps its round's count with "or more":
 * that is true, there are no fewer.
 */
export async function discoverRules(app: App, caller: Caller, a: { texts: OpenCheckText[]; unchecked: OpenCheckUnchecked | null; settings: OpenCheckSettings;
                                                                   recordId: string; spaceId: string }): Promise<Discovery> {
  const found = new Map<string, FoundRule>();
  const done = (o: Partial<Discovery> = {}): Discovery => ({ rules: [...found.keys()].sort(), found: [...found.values()].sort((x, y) => x.rule.localeCompare(y.rule)), never: [], unchecked: null, ...o });
  let passes = 0;
  const pass = (accepted: string[]) => {
    passes++;
    return openCheckOutcome(app, caller, { via: "open", texts: a.texts, unchecked: a.unchecked, recordId: a.recordId, spaceId: a.spaceId, settings: acceptedSettings(a.settings, accepted) });
  };
  for (let round = 0; round < DISCOVER_ROUNDS; round++) {
    const out = await pass([...found.keys()]);
    if (out.unchecked) return done({ unchecked: out.unchecked });
    if (!out.findings.length) {
      // recounting the rules of rounds that hit the limit: only this rule — the other found ones off
      for (const x of [...found.values()].filter((f) => f.more)) {
        if (passes >= DISCOVER_ROUNDS) break;                 // the total pass budget is spent — the round's count, "or more"
        const one = await pass([...found.keys()].filter((r) => r !== x.rule));
        if (one.unchecked) return done({ unchecked: one.unchecked });
        const mine = one.findings.filter((f) => f.rule === x.rule);
        Object.assign(x, { count: mine.length, more: openCheckTruncated(one.findings), in_record: mine.filter((f) => f.field !== "derived").length,
                           in_extracted: mine.filter((f) => f.field === "derived").length });
      }
      return done();
    }
    const never = out.findings.filter((f) => despiteVerdict(f.rule, "solo") === "never");
    if (never.length) return done({ never });
    const more = openCheckTruncated(out.findings), before = found.size;
    for (const f of out.findings) {
      const x = found.get(f.rule) ?? { rule: f.rule, kind: f.kind, reason: f.reason, count: 0, more: false, in_record: 0, in_extracted: 0 };
      x.count++;
      if (f.field === "derived") x.in_extracted++; else x.in_record++;
      if (more) x.more = true;
      found.set(f.rule, x);
    }
    if (found.size === before) break;                         // the rule is off yet the finding repeated — cannot happen; do not spin
  }
  return done({ unchecked: "check_failed" });
}

// ---------------------------------------------------------------- who will see
export interface AudienceView { total: number; spaces: Array<{ slug: string; name: string; kind: string }>; other_spaces: number; people: number }

/**
 * Who will see the record: the people of the root's space and of the placement spaces (active membership; for spaces outside
 * departments the owner too; personal — the owner only), the readers of the tree rows and the author; inactive ones do not count.
 * Only the spaces the author reads are named; the rest by count. `people` — readers by separate access
 * beyond the members of those spaces.
 */
export async function audienceOf(app: App, readable: Map<string, SpaceAccess>, rootSpaceId: string, c: Pick<ConsentRows, "placements" | "people">, author: string): Promise<AudienceView> {
  const spaceIds = [...new Set([rootSpaceId, ...c.placements.map((p) => p.space_id)])];
  const members = new Set((await app.db.control.query(
    `SELECT m.person_id AS id FROM space_members_effective m JOIN spaces s ON s.id = m.space_id AND s.kind <> 'personal' JOIN people p ON p.id = m.person_id AND p.active
      WHERE m.space_id = ANY($1::uuid[])
     UNION SELECT s.owner_id FROM spaces s JOIN people p ON p.id = s.owner_id AND p.active
      WHERE s.id = ANY($1::uuid[]) AND (s.kind = 'personal' OR s.org_unit_id IS NULL)`, [spaceIds])).rows.map((r) => r.id as string));
  const listed = [...new Set(c.people.map((p) => p.person_id))].filter((id) => id !== author && !members.has(id));
  const extra = listed.length ? (await app.db.control.query("SELECT id FROM people WHERE id = ANY($1::uuid[]) AND active", [listed])).rows.map((r) => r.id as string) : [];
  members.add(author);
  const named = spaceIds.map((id) => readable.get(id)).filter((s): s is SpaceAccess => !!s);
  return { total: new Set([...members, ...extra]).size, spaces: named.map((s) => ({ slug: s.slug, name: s.name, kind: s.kind })), other_spaces: spaceIds.length - named.length, people: extra.length };
}

/**
 * Tree rows except the root and the marks (events, summaries, older versions of one's note — they are in the chain without
 * parent_id), and colleagues' "wrong/stale" marks — live ones, without the deleted.
 */
async function treeCounts(app: App, id: string, author: string): Promise<{ extracted: number; marks: number }> {
  const r = (await closedSys(app).query(`${CHAIN_TREE} SELECT
      count(*) FILTER (WHERE r.id <> $1 AND NOT (r.source_kind = 'correction' AND r.type = 'note'))::int AS extracted,
      count(*) FILTER (WHERE r.source_kind = 'correction' AND r.type = 'note' AND COALESCE(r.attrs #>> '{correction,by}', '') <> $2)::int AS marks
    FROM records r WHERE r.id IN (SELECT id FROM tree) AND r.deleted_at IS NULL`, [id, author])).rows[0];
  return { extracted: Number(r?.extracted ?? 0), marks: Number(r?.marks ?? 0) };
}

/** The root is a document where some pages are scans: it can be shown only as text. */
export const isPartialDoc = (rows: ReadonlyArray<Pick<ConsentRow, "id" | "type" | "extraction">>, rootId: string): boolean =>
  rows.some((r) => r.id === rootId && r.type === "document" && r.extraction === "partial");

/** The record's last move (id) — the token's `lm`: "shown and hidden" after the preview — the consent is stale. */
const lastMoveOf = async (q: Pick<pg.Pool, "query">, id: string): Promise<string | null> =>
  ((await q.query("SELECT id FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [id])).rows[0]?.id as string | undefined) ?? null;

/** "Never open" by the locator (card, space) and by the tree (tag, title, entity kind) — as the worker does. */
async function neverOpenOf(app: App, loc: Locator, rows: ConsentRow[], id: string): Promise<string | null> {
  const byLocator = await neverOpenReason(app, loc);
  if (byLocator) return byLocator;
  const rules = (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows;
  if (!rules.length) return null;
  const ents = (await closedSys(app).query(CONSENT_ENTITIES_SQL, [id])).rows.map((r) => r.entity_id as string);
  const kinds = ents.length ? (await app.db.control.query("SELECT DISTINCT kind FROM entities WHERE id = ANY($1::uuid[])", [ents])).rows.map((r) => r.kind as string) : [];
  return neverOpenFromTree(rules, rows, kinds);
}

// ---------------------------------------------------------------- switches for the workplace
/** The "Make available to agents" switches in the answer's words (GET /me/show-anyway). */
export interface ShowAnywayToggles { enabled: boolean; projects: boolean; scans_text: boolean }

/**
 * Switches for the workplace (GET /me/show-anyway: "off — no button anywhere"): the record page does not
 * show the "Make available to agents" link where showing is off, and the check banner's advice says what to do instead of
 * it. Workplace session only. The values are the same the preview and the worker read (despiteSettings).
 */
export async function showAnywayToggles(app: App, caller: Caller): Promise<ShowAnywayToggles> {
  await requireHuman(app, caller, "Check whether “Make available to agents” is enabled", { path: "/records", section: "My records" });
  const ds = despiteSettings(app.settings);
  return { enabled: ds.enabled, projects: ds.projects, scans_text: ds.scansText };
}

// ---------------------------------------------------------------- preview
export type PreviewState = "clean" | "show_anyway" | "never" | "not_allowed" | "unchecked" | "open" | "in_progress";
export type PreviewReason = NotAllowedReason | "never_rule" | "sensitive_pii" | "empty_text" | "too_large" | "scans_disabled" | "conversion_pending" | "busy" | "check_failed";
export interface OpenPreview {
  state: PreviewState; reason?: PreviewReason; scope?: DespiteScope; space?: { slug: string; name: string; kind: string };
  findings?: FoundRule[]; never?: Array<{ rule: string; kind: string; reason: string }>; audience?: AudienceView; tree?: { extracted: number; marks: number };
  text_only?: boolean; consent?: string; expires_at?: string;
}

/** The check's "not checked" as a preview state: wait and retry, or "not allowed" (no text, too large, scans off). */
const UNCHECKED_STATE: Record<OpenCheckUnchecked, { state: "unchecked" | "never"; reason: PreviewReason }> = {
  busy: { state: "unchecked", reason: "busy" }, timeout: { state: "unchecked", reason: "busy" }, check_failed: { state: "unchecked", reason: "check_failed" },
  original_unavailable: { state: "unchecked", reason: "check_failed" }, conversion_pending: { state: "unchecked", reason: "conversion_pending" },
  empty_text: { state: "never", reason: "empty_text" }, conversion_failed: { state: "never", reason: "empty_text" },
  original_too_large: { state: "never", reason: "too_large" }, tree_too_large: { state: "never", reason: "too_large" },
  partial_text: { state: "never", reason: "scans_disabled" },
};

const rulesView = (f: ReadonlyArray<{ rule: string; kind: string; reason: string }>) => {
  const seen = new Map<string, { rule: string; kind: string; reason: string }>();
  for (const x of f) if (!seen.has(x.rule)) seen.set(x.rule, { rule: x.rule, kind: x.kind, reason: x.reason });
  return [...seen.values()];
};

/**
 * The "Make available to agents" preview (POST /records/{id}/open/preview): a workplace session only and the
 * author only (not the author or missing — 404, part of a tree — 400 derived, as at /open). Writes no log: no title is given,
 * and the author sees the finding kinds of their own record anyway. The check: fresh settings, at most DISCOVER_ROUNDS rounds.
 */
export async function openPreview(app: App, caller: Caller, reqId: string): Promise<OpenPreview> {
  await requireHuman(app, caller, "Show the record to agents", { path: `/records/${reqId}`, section: "Record" });
  const me = caller.person!;
  const { id, loc, cut } = await openTarget(app, caller, reqId, me.id);
  const last = (await app.db.control.query("SELECT id, status, to_class FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [id])).rows[0];
  if (last && ["pending", "copying", "verifying"].includes(last.status)) return { state: "in_progress" };
  if (loc.class === "open") return { state: "open" };
  // the chain head was not found in full — like a too large tree: showing does not start from here
  if (cut) return UNCHECKED_STATE.tree_too_large;
  // archive: "Show" in an archived space only undoes a closing made after archiving (as /open)
  const arch = await spaceArchived(app, loc.space_id);
  if (arch) {
    const undo = (await app.db.control.query("SELECT to_class, requested_at > $2 AS after FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [id, arch.archived_at])).rows[0];
    if (!(undo?.to_class === "closed" && undo.after === true)) return { state: "not_allowed", reason: "archived" };
  }
  await app.settings.load(true).catch(() => undefined);
  const ds = despiteSettings(app.settings);
  // the tree is too large for the check — before reading its rows for fingerprints: the answer is the one
  // the check below would give; with the check off — the plain "Show to agents", as before
  if (openCheckSettings(app.settings).enabled && await openTreeTooLarge({ records: closedSys(app) }, id, { live: false })) return UNCHECKED_STATE.tree_too_large;
  const c = await consentRows(closedSys(app), app.db.control, id);
  const textOnly = isPartialDoc(c.rows, id) && ds.scansText;
  const never = await neverOpenOf(app, loc, c.rows, id);
  if (never) return { state: "never", reason: "never_rule", never: [{ rule: "never_open", kind: "never_open", reason: never }] };
  // the open check is off entirely: no findings — the plain "Show to agents", as /open does (despiteConsent
  // then does not check the consent); otherwise a "text only" scan would get a token, and /open would move the file too
  if (!openCheckSettings(app.settings).enabled) return { state: "clean" };
  const tree = await treeTexts(app, "closed", id, { live: false, textOnly });
  const found = await discoverRules(app, caller, { texts: tree.texts, unchecked: tree.unchecked, settings: openCheckSettings(app.settings), recordId: id, spaceId: loc.space_id });
  if (found.unchecked) return UNCHECKED_STATE[found.unchecked];
  if (!found.never.length && !found.rules.length && !textOnly) return { state: "clean" };
  const sc = await despiteScope(app, caller, loc, c);
  if ("refuse" in sc) return { state: "not_allowed", reason: sc.refuse, ...(sc.space ? { space: { slug: sc.space.slug, name: sc.space.name, kind: sc.space.kind } } : {}) };
  const space = { slug: sc.space.slug, name: sc.space.name, kind: sc.space.kind };
  // one's own record — one's own reasons are fine: rule, kind and reason in words, without positions and matches
  if (found.never.length) return { state: "never", reason: "never_rule", scope: sc.scope, space, never: rulesView(found.never) };
  const pii = found.found.filter((f) => despiteVerdict(f.rule, sc.scope) === "never");
  if (pii.length) return { state: "never", reason: "sensitive_pii", scope: sc.scope, space, never: rulesView(pii) };
  const keys = despiteKeysOf(app);
  const payload = consentPayload({ rid: id, pid: me.id, kid: caller.keyId, sid: loc.space_id, aud: audiencePrint(keys.print, c),
                                   print: contentPrint(keys.print, { rows: c.rows, entityNames: c.entityNames, textOnly }), rules: found.rules, text_only: textOnly,
                                   scope: sc.scope, lm: await lastMoveOf(app.db.control, id) });
  return { state: "show_anyway", scope: sc.scope, space, findings: found.found, audience: await audienceOf(app, sc.readable, loc.space_id, c, me.id),
           tree: await treeCounts(app, id, me.id), text_only: textOnly, consent: signConsent(keys.token, payload), expires_at: new Date(payload.exp * 1000).toISOString() };
}

// ---------------------------------------------------------------- consent at "Show"
/** The accepted consent: what to pass to the move (class_moves) and to the log. */
export interface DespiteAccepted {
  rules: string[]; textOnly: boolean; print: string; aud: string; sid: string; scope: DespiteScope; lm: string | null;
  spaceKind: string; audienceTotal: number;
}

/**
 * Checking the consent at "Show" with `despite_findings: true` (open(), steps 2 and 4–7): the token (signature, whose, expiry),
 * the tree not too large (before reading its rows), where showing is possible and the switches (including showing scans
 * as text, if the consent was for a scan — scans_disabled), the root's space and the scope (a move — "who sees it changed"),
 * then "text only" and the content fingerprint ("the record changed"), then the readers' fingerprint
 * (placement, reader), then one check with the accepted rules off on fresh settings. The order "content before readers" is as at the gate
 * of the worker: a new tree row changes both fingerprints. null — the open check is off (as before: no findings, a plain open) or there is nothing to accept.
 */
export async function despiteConsent(app: App, caller: Caller, a: { id: string; loc: Locator; consent?: string }): Promise<DespiteAccepted | null> {
  const me = caller.person!;
  const enabled = openCheckSettings(app.settings).enabled;
  if (a.consent === undefined) {
    if (!enabled) return null;
    throw invalid(STALE_PAGE, { reason: "consent_required" });
  }
  const keys = despiteKeysOf(app);
  const v = verifyConsent(keys.token, a.consent, Date.now(), { rid: a.id, pid: me.id, kid: caller.keyId });
  if ("error" in v) {
    if (v.error === "invalid") throw invalid(STALE_PAGE, { reason: "consent_invalid" });
    throw staleOpen("expired");
  }
  if (!enabled) return null;
  const p = v.payload;
  const guard = { via: "open" as const, texts: [] as OpenCheckText[], spaceId: a.loc.space_id, recordId: a.id };
  if (await openTreeTooLarge({ records: closedSys(app) }, a.id, { live: false })) await refuseOpen(app, caller, guard, { findings: [], unchecked: "tree_too_large" });
  const c = await consentRows(closedSys(app), app.db.control, a.id);
  const sc = await despiteScope(app, caller, a.loc, c);
  if ("refuse" in sc) throw notAllowed(sc.refuse, sc.space?.name ?? null);
  // consent was for a "text only" scan, and scans as text were turned off since: "not allowed", not "the record changed"
  // — the preview would now answer never/scans_disabled
  if (p.text_only && !despiteSettings(app.settings).scansText) throw notAllowed("scans_disabled", sc.space.name);
  // the order is as at the worker's gate: space and scope → content → readers. A new tree row
  // (a colleague's mark) changes both fingerprints — that is "the record changed"; placement, reader and the audience part
  // do not change the content — "who sees it changed"
  if (a.loc.space_id !== p.sid || sc.scope !== p.scope) throw staleOpen("audience");
  const textOnly = isPartialDoc(c.rows, a.id) && despiteSettings(app.settings).scansText;
  if (textOnly !== p.text_only) throw staleOpen("changed");
  if (contentPrint(keys.print, { rows: c.rows, entityNames: c.entityNames, textOnly: p.text_only }) !== p.print) throw staleOpen("changed");
  if (audiencePrint(keys.print, c) !== p.aud) throw staleOpen("audience");
  // passport, national ID number and card — only "only you" (the base enforces it itself: class_moves_shared_pii_check)
  if (p.rules.some((r) => despiteVerdict(r, p.scope) === "never")) throw staleOpen("audience");
  const tree = await treeTexts(app, "closed", a.id, { live: false, textOnly: p.text_only });
  guard.texts = tree.texts;
  const out = await openCheckOutcome(app, caller, { ...guard, unchecked: tree.unchecked, settings: acceptedSettings(openCheckSettings(app.settings), p.rules) });
  if (out.unchecked) await refuseOpen(app, caller, guard, out);
  if (out.findings.length) {
    const never = out.findings.filter((f) => despiteVerdict(f.rule, p.scope) === "never");
    if (never.length) {
      await audit(app, caller, { event_type: "write", class: "closed", record_ids: [a.id], space_id: a.loc.space_id,
                                 details: { op: "open_check_refused", via: "open", kinds: [...new Set(never.map((f) => f.kind))], rules: [...new Set(never.map((f) => f.rule))],
                                            never_by_word: true, ...(p.rules.length ? { accepted_rules: p.rules } : {}) } });
      throw new MemoryError("open_check", `You cannot show this record to agents, even if you consent. It appears to contain ${openCheckReasons(never)}`,
        { hint: `If agents need the information, save what they need without the flagged content ${DESPITE_ANEW}`,
          details: { open_check: { via: "open", findings: never, never_by_word: true, stale: "more_found" } } });
    }
    throw staleOpen("more_found");
  }
  if (!p.rules.length && !p.text_only) return null;
  const aud = await audienceOf(app, sc.readable, a.loc.space_id, c, me.id);
  return { rules: p.rules, textOnly: p.text_only, print: p.print, aud: p.aud, sid: p.sid, scope: p.scope, lm: p.lm, spaceKind: sc.space.kind, audienceTotal: aud.total };
}

/**
 * Under the record lock (startOpenMove): the last move is the same as at the preview (else shown and hidden —
 * `changed`), the root's space and the readers are unchanged (`audience`). Under the lock only the readers are read — tree rows
 * without texts, the placements and readers of the closed base: the lock is not held while content is read; control is not
 * needed at all (entities are not among the readers).
 */
export async function despiteUnderLock(app: App, a: { id: string; lastId: string | null; spaceId: string; d: Pick<DespiteAccepted, "lm" | "sid" | "aud"> }): Promise<void> {
  if (a.lastId !== a.d.lm) throw staleOpen("changed");
  if (a.spaceId !== a.d.sid) throw staleOpen("audience");
  const c = await audienceRows(closedSys(app), a.id);
  if (audiencePrint(despiteKeysOf(app).print, c) !== a.d.aud) throw staleOpen("audience");
}
