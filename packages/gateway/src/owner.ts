import { personalAgent } from "./personal-agent.ts";
// Owner operations: only at a person's explicit request, always with an audit event. Not available to service keys.
// The right to open and delete is decided by the locator (ownership) — without a T2 key reading the closed database.
import type pg from "pg";
import { acceptedKinds, acceptedReasons, archivedDenied, BY_WORD_SCOPE, despiteSettings, gateAllows, inProgress, invalid, log, MemoryError, neverOpen, newId, notFound, openableByWord, openCheckReasons,
         openCheckSettings, openCheckWhy, parseOpenCheckMarkStrict, recordPath, ruleOpenableByWord, SCANS_SHOWABLE_ADVICE, scansShowableByAuthor, showAnywayPath, showAnywayWhere,
         syncDeletionMarks, tx, WORKPROFILE_PREFIX, WORKPROFILE_PUBLIC_PREFIX, type ByWordConfirmation,
         type DataClass, type OpenCheckFinding } from "@memory/shared";
import { underOwnerLocks, underRecordLock } from "./owner-lock.ts";
import { underGuideRestore } from "./space-guide-ref.ts";
import { CHAIN_HEAD, CHAIN_HEAD_CUT, CHAIN_TREE, ensureProjectEntity, isChainType, HELD_TRANSFER_TEXTS, entityNameNeedsOpenCheck, isDirectoryCardRow, isSpaceGuideRow, isWorkProfileRow, spaceMove, TAG_TREE_SQL, widenPending } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { canWrite, loadReadable, locate, lockReconcile, readableSpaces, reconcileAccess, resolveSpace, spaceArchived, type Locator, type SpaceAccess } from "./access.ts";
import { audit, auditShownClosed } from "./audit.ts";
import { requireHuman, workplaceUrl, workplaceWhere } from "./workplace.ts";
import { guardOpen, guardOpenWord, moveUnchecked, refuseOpen, treeTexts } from "./open-check.ts";
import { despiteConsent, despiteUnderLock, type DespiteAccepted } from "./despite-open.ts";
import { lastMoveShownShared } from "./despite-shown.ts";
import { closeReturned, heldOriginsNow, heldTrashIds, isHeldTransfer, onRestoreHold, recheckExtraRules, recheckHoldsReady, refusePurgeHeld, restoreCloseHead, restoreHeldClosed, returnedDespite } from "./trash-held.ts";
import { byWordTreeOk } from "./records.ts";
import { gateOf } from "./visibility.ts";
import { isExternal } from "./channel.ts";
import { deniedSlot, noteDenied, traceDenied } from "./denied-audit.ts";
import { archivedManageDenied, createOwnedSpace, membersOf, resolveWithArchive, SLUG_RE } from "./spaces.ts";
import { extendedOpenGate, JOURNAL_TAIL, markEvent, openWriteMode } from "./extended-open.ts";
import { agentMemberAddGated, confirmationAnswer, humanConfirmationRequired, needsConfirmation } from "./promote-confirmation.ts";
import { curatorOnlyInWorkplace, enterOrg, isOrgCurator, leaveOrg, orgDelete, promoteOrgText, type EnterOut } from "./org-review.ts";
import { orgAncestorUnits } from "./org-hold.ts";
import { isHumanSession } from "./workplace.ts";
import { checkConfirmWider, markWidened, promoteDerivation, readBasis, widenedMark } from "./derivation.ts";
import { withKeyLock } from "./control-lock.ts";
import { currentProfileRef, PROFILE_COPY_TEXT, profileLockKey, unpublishProfile, type UnpublishReason } from "./profile.ts";

const NIL = "00000000-0000-0000-0000-000000000000";
// the record tree and the version chain of one's own note: closing and deleting forever take all versions
const TREE = CHAIN_TREE;

/**
 * Head of the version chain (agent note or document, version-chain.ts): close and delete of an older version take the lock,
 * the move and the trash batch of the head — one request and one batch for the whole chain, not two competing ones. For any
 * other record it is the record itself. Only ids of the own chain are read (ownedLocator has checked the rights).
 */
async function chainHeadOf(app: App, caller: Caller, loc: Locator, id: string): Promise<string> {
  if (!isChainType(loc.type)) return id;
  const head = (await app.db.recordsForWrite(loc.class, caller.scope).query(CHAIN_HEAD, [id])).rows[0]?.id;
  return typeof head === "string" ? head : id;
}

/**
 * A correction record (`source_kind = correction`, a note) — a participant's words, yet it belongs to the author
 * of the corrected record: alone it does not move into another space — only together with the corrected record's
 * tree. Between classes — like any derived one (derivedAlone).
 */
async function correctionNoteAlone(app: App, caller: Caller, loc: Locator, id: string): Promise<void> {
  if (loc.type !== "note") return;
  const row = (await app.db.recordsForWrite(loc.class, caller.scope).query("SELECT source_kind::text AS k, parent_id FROM records WHERE id = $1", [id])).rows[0];
  if (row?.k !== "correction" || !row.parent_id) return;
  throw invalid("A correction record can only be moved with the corrected record. Move the corrected record", { reason: "correction_note" });
}

/**
 * A derived record (one with a parent: a meeting event and summary, an event version, a correction record) lies in one database
 * with its tree — the parent_id foreign key does not leave the class database, so its parent is always in the same database.
 * Between classes it moves only together with the source record (the tree root): alone, the move failed on the foreign
 * key on every attempt. The refusal names the root — `root_id`: it is closed or opened
 * as a whole. The root is in the same database as the record: its author or the space owner sees it.
 */
const ROOT_OF = `WITH RECURSIVE up AS (SELECT id, parent_id, 0 AS depth FROM records WHERE id = $1
  UNION ALL SELECT r.id, r.parent_id, u.depth + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.depth < 64)
  SELECT id FROM up ORDER BY depth DESC LIMIT 1`;
async function derivedAlone(app: App, caller: Caller, loc: Locator, id: string, to: "open" | "closed"): Promise<void> {
  if (loc.class === to) return;                              // already there — the repeat is idempotent, no move
  const db = app.db.recordsForWrite(loc.class, caller.scope);
  const row = (await db.query("SELECT source_kind::text AS k, type::text AS t, parent_id FROM records WHERE id = $1", [id])).rows[0];
  if (!row?.parent_id) return;
  const root = ((await db.query(ROOT_OF, [id])).rows[0]?.id ?? row.parent_id) as string;
  if (to === "open" && row.k === "correction" && row.t === "note")
    throw invalid("A correction record can only be made open with the corrected record. Make the corrected record open", { reason: "correction_note", root_id: root });
  throw invalid(to === "closed"
    ? "This record is part of another record (such as a meeting event or a correction) and cannot be closed on its own. Close the source record to close it and all its parts"
    : "This record is part of another record (such as a meeting event or a correction) and cannot be made open on its own. Make the source record open to open it and all its parts",
    { reason: "derived", root_id: root });
}

/**
 * What to open: an earlier version of one's own note — the chain head: one request and one lock
 * for all the chain, the check mark — of the current version (own_note drops it from the earlier one). A correction — see above.
 * `cut`: the climb to the head hit the CHAIN_HEAD step limit or a cycle — the "head" found is not the current
 * version. Showing does not start from it (the caller answers as for a too large tree — tree_too_large): the consent trace
 * would land on an intermediate version, newer ones would reach open untraced, and the panel log would give their titles.
 */
export async function openTarget(app: App, caller: Caller, id: string, me: string): Promise<{ id: string; loc: Locator; cut: boolean }> {
  const loc0 = await locate(app, id);
  if (!loc0 || loc0.owner_id !== me || loc0.deleted) throw notFound();
  // the external agents' address: one's own closed record — as a missing one
  if (isExternal(caller) && loc0.class === "closed") throw notFound();
  const head = await chainHeadOf(app, caller, loc0, id);
  const loc = head === id ? loc0 : await locate(app, head);
  if (!loc || loc.owner_id !== me || loc.deleted) throw notFound();
  await derivedAlone(app, caller, loc, head, "open");
  const cut = isChainType(loc0.type)
    && (await app.db.recordsForWrite(loc0.class, caller.scope).query(CHAIN_HEAD_CUT, [head])).rows[0]?.cut === true;
  return { id: head, loc, cut };
}

/** The show refusal for a chain head found incompletely (openTarget, `cut`): the same as for a too large tree. */
const refuseCutChain = (app: App, caller: Caller, via: "open" | "open_word", loc: Locator, id: string): Promise<never> =>
  refuseOpen(app, caller, { via, texts: [], spaceId: loc.space_id, recordId: id }, { findings: [], unchecked: "tree_too_large" });

function requirePerson(caller: Caller) { if (!caller.person) throw notFound(); return caller.person; }

/**
 * Review units of a part's source records (summary, decision, correction — the record has a parent): all ancestors by parent_id
 * with an org_reviews row, the nearest first, superseded — to the successor (orgAncestorUnits). No parent or rows — empty.
 * Moving a part into org on its own starts its review from them: a hold, "awaiting a decision", "sent back" (not only the nearest
 * ancestor: the meeting was sent back while its decision has its own "left" row — the agent still does not take the part out).
 */
async function sourceUnitsOf(app: App, db: Pick<pg.Pool, "query">, id: string): Promise<string[]> {
  return (await orgAncestorUnits(app.db.control, db, id)).map((r) => r.record_id);
}

/**
 * The record lock: the class move worker holds the same lock for the whole move. Taken — the record
 * is moving: deletion answers in_progress "retry in a minute" instead of spoiling the move (a live copy in another database).
 * The control transaction is held until fn ends — the locator edit is inside it too.
 */

/**
 * A closed team space by an agent (memory_space_create): only at a person's explicit request. An open project
 * space is created by the person in the workplace (spaces.ts). The common creation code: a taken slug (including that of
 * an invisible space) — a suffix, not an error: "taken" would reveal another's space exists; no race,
 * with a per-person limit, reserved slugs and a check of the name, description and slug (via space).
 * A slug taken by a space the caller cannot see gets a random suffix, not "-2" — the number would reveal the hidden
 * space and its siblings; that the requested slug is taken at all remains visible (projectSlugCandidates, spaces.ts).
 */
export async function spaceCreate(app: App, caller: Caller, a: { name: string; slug?: string; description?: string; members?: string[] }) {
  requirePerson(caller);
  if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 120) throw invalid("name: a name of 1 to 120 characters");
  if (a.slug && !SLUG_RE.test(a.slug)) throw invalid("slug: 2 to 63 characters, using Latin letters, digits and hyphens");
  const members = membersOf(a.members, 500);
  // access.agent_member_add = workplace: members named at creation are added members too — an agent's key creates
  // the space only without them; refused before any side effect (no space, no extended_open event), the logins are not looked up
  if (members.length && agentMemberAddGated(app, caller)) {
    await noteDenied(app, caller, { tool: "memory_space_create", denied: "human_confirmation_required" });
    throw humanConfirmationRequired(app, "/projects/new", "Projects");
  }
  // all members' agents see the description at the start of every session (memory_me) — in effect open text: an agent that reads
  // closed does not set it without permission; the name — as before, through the open check
  // with the administrator's permission — the description is set, the space_create event carries extended_open (log, report)
  const mark = a.description?.trim() ? await extendedOpenGate(app, caller, { attempt: "space_meta", space: { id: null, slug: a.slug ?? null } }) : null;
  const out = await createOwnedSpace(app, caller, { kind: "team", name: a.name.trim(), ...(a.slug ? { slug: a.slug } : {}), description: a.description?.trim() || null,
                                                    defaultClass: "closed", members, via: "mcp", auditDetails: markEvent(mark) });
  const result = { slug: out.slug, path: `/spaces/${out.slug}`, name: out.name, class: "closed" as const, members_added: out.members_added, members_unknown: out.members_unknown };
  return { result, text: `Created team space ${result.path} (closed class). Members added: ${result.members_added.length}${mark ? JOURNAL_TAIL : ""}` };
}

/**
 * A space under the owner's control (role owner): a team or a project. Not the owner — the same as no such space.
 * An archived one only narrows: removing a member is allowed (`archived: "narrow"`), adding — an archive refusal.
 */
async function ownedSpace(app: App, caller: Caller, ref: string, o: { archived?: "deny" | "narrow"; tool: string }): Promise<SpaceAccess> {
  const s = await resolveWithArchive(app, caller, ref);
  if (!s || s.role !== "owner" || (s.kind !== "team" && s.kind !== "project")) {
    // the refusal leaves a trace without naming the space; the answer stays the plain not_found
    await noteDenied(app, caller, { tool: o.tool, denied: "not_found" });
    throw notFound();
  }
  if (s.archived_at && o.archived !== "narrow") throw archivedManageDenied(s);
  return s;
}

export async function spaceAddMember(app: App, caller: Caller, a: { space: string; login: string }) {
  const me = requirePerson(caller), s = await ownedSpace(app, caller, a.space, { tool: "memory_space_add_member" });
  // access.agent_member_add = workplace: an agent's key does not add a colleague to the whole space; refused once
  // the owner's rights are proven and before the login is looked up — the answer is the same for a known and an unknown login
  if (agentMemberAddGated(app, caller)) {
    await noteDenied(app, caller, { tool: "memory_space_add_member", denied: "human_confirmation_required" });
    throw humanConfirmationRequired(app, `/projects/${s.slug}?tab=members`, "Members");
  }
  const p = (await app.db.control.query("SELECT id, COALESCE(attrs->>'demo','') = 'true' AS demo FROM people WHERE login = $1 AND instance_id = $2 AND active", [a.login.trim().toLowerCase(), app.instanceId])).rows[0];
  if (!p) throw invalid("No person with that login is in the org table");
  // the showcase demo persona does not mix with real people either way
  if (p.demo) throw invalid("A showcase demo persona cannot join a space");
  const login = a.login.trim().toLowerCase();
  // one cannot add oneself as a member: only the space owner can add, and their owner row — by
  // the org table (the department head) or by a role assignment — would become manual, and the owner rights would stay with them
  // forever, even after the head changes
  if (p.id === me.id) throw invalid("You are already in this space and cannot add yourself as a member");
  // the owner is already in the space: their row does not change — adding again is not an error (the contract), the answer —
  // role: owner, added: false. In a department space the membership row makes the owner:
  // owner_id there may remember a removed head who is now an ordinary member
  const already = { result: { space: s.slug, login, role: "owner", added: false }, text: `${login} already owns ${s.slug}. Their membership was not changed` };
  if (p.id === s.owner_id && !s.org_unit_id) return already;
  // an explicit addition fixes the membership: the org table reconcile does not remove manual rows; it leaves the owner row alone
  const r = await tx(app.db.control, async (q) => {
    const ids = [s.id, p.id];
    for (;;) {
      const { rows: [before] } = await q.query<{ role: string; source: string; has_grant_or_expiry: boolean }>(
        `SELECT role, source, (grant_id IS NOT NULL OR expires_at IS NOT NULL) AS has_grant_or_expiry
         FROM space_members WHERE space_id = $1 AND person_id = $2 FOR UPDATE`, ids);
      if (!before) {
        const inserted = await q.query(
          `INSERT INTO space_members (space_id, person_id, role, added_by, source) VALUES ($1,$2,'member',$3,'manual')
           ON CONFLICT (space_id, person_id) DO NOTHING`, [...ids, me.id]);
        if (inserted.rowCount) return { role: "member", inserted: true };
        // A concurrent insert won. Read and lock its row before deciding whether to update.
        continue;
      }
      if (before.role === "owner") return null;
      const role = before.role === "reader" ? "member" : before.role;
      if (before.role === role && before.source === "manual" && !before.has_grant_or_expiry) return { role, inserted: false };
      await q.query(
        "UPDATE space_members SET source = 'manual', grant_id = NULL, expires_at = NULL, role = $3 WHERE space_id = $1 AND person_id = $2",
        [...ids, role]);
      return { role, inserted: false, before };
    }
  });
  if (!r) return already;                         // the owner row (head by the org table, assigned, by role) — as it was
  if (r.inserted || r.before) {
    await audit(app, caller, { event_type: "admin", space_id: s.id, details: {
      tool: "memory_space_add_member", person: p.id, outcome: r.inserted ? "added" : "changed",
      ...(r.before ? { role_before: r.before.role, role: r.role, source_before: r.before.source, source: "manual" } : {}),
    } });
  }
  const result = { space: s.slug, login, role: r.role, added: r.inserted };
  return { result, text: `${result.login} is a member of ${s.slug}` };
}

/**
 * Only a manual membership is removed: a derived one — by a directory group, an assignment, the org table — the next
 * reconcile would silently bring back; for it — invalid_argument with where it is removed, the row stays. A manual one over
 * a derived one (a group member added by hand) is removed, and the membership reconcile in the same transaction brings back
 * the derived one at once: the person keeps access until the next reconcile, and it does not bring it back silently.
 * The answer is honest — removed: false and where the rest is removed.
 */
export async function spaceRemoveMember(app: App, caller: Caller, a: { space: string; login: string }) {
  requirePerson(caller);
  const s = await ownedSpace(app, caller, a.space, { archived: "narrow", tool: "memory_space_remove_member" });
  const login = a.login.trim().toLowerCase();
  const p = (await app.db.control.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0];
  // the owner: outside departments — owner_id; in a department space — the owner row (see spaceAddMember), otherwise
  // one assigned by the administrator would get "was not a member"
  const ownerRow = p && s.org_unit_id
    ? Boolean((await app.db.control.query("SELECT 1 FROM space_members WHERE space_id = $1 AND person_id = $2 AND role = 'owner'", [s.id, p.id])).rowCount) : false;
  if ((p?.id === s.owner_id && !s.org_unit_id) || ownerRow) throw invalid("The space owner cannot be removed");
  const out = p ? await tx(app.db.control, async (q) => {
    await lockReconcile(q, app.instanceId);              // before deleting: else a reconcile and we wait on each other (deadlock)
    const gone = ((await q.query("DELETE FROM space_members WHERE space_id = $1 AND person_id = $2 AND role <> 'owner' AND source = 'manual'", [s.id, p.id])).rowCount ?? 0) > 0;
    if (gone) await reconcileAccess(q, app.instanceId, false);
    const left = (await q.query("SELECT source FROM space_members WHERE space_id = $1 AND person_id = $2", [s.id, p.id])).rows[0]?.source as string | undefined;
    return { gone, left: left ?? null };
  }) : { gone: false, left: null };
  if (!out.gone && out.left && out.left !== "manual") throw invalid(await derivedWhy(app, s.id, p.id, login, out.left));
  const remains = out.gone && out.left ? out.left : null;         // manual removed, the derived basis remains
  if (out.gone) {
    await audit(app, caller, { event_type: "admin", space_id: s.id, details: {
      tool: "memory_space_remove_member", person: p.id, outcome: "removed", ...(remains ? { remains } : {}),
    } });
  }
  const result = { space: s.slug, login, removed: out.gone && !remains };
  if (remains) return { result, text: `The direct membership in ${s.slug} was removed, but the person remains a member: ${await derivedWhy(app, s.id, p.id, login, remains)}` };
  return { result, text: result.removed ? `${result.login} is no longer a member of ${s.slug}` : `${result.login} was not a member of ${s.slug}` };
}

/** Where derived membership ends: directory group — in the directory or by unlink, assignment — by the admin, org table — in it. */
async function derivedWhy(app: App, spaceId: string, personId: string, login: string, source: string): Promise<string> {
  if (source === "group") {
    const groups = (await app.db.control.query(
      `SELECT DISTINCT g.display_name FROM space_groups g JOIN directory_group_members d ON d.group_key = g.group_key AND d.instance_id = $3
       WHERE g.space_id = $1 AND d.person_id = $2 ORDER BY 1 LIMIT 5`, [spaceId, personId, app.instanceId])).rows.map((x) => x.display_name as string);
    return `${login} is a member through a directory group${groups.length ? ` ${groups.join(", ")}` : ""}. Remove the membership in the directory or unlink the group in the workspace`;
  }
  if (source === "grant") return `${login} is a member through a role assignment. The memory administrator can remove the membership by revoking the grant`;
  return `${login} is a member through the org table (department). Change the membership in the org table`;
}

/**
 * The record owner or its space owner — by locator, without querying the records database. The exception —
 * "Company common knowledge": for another's org record the org owner's (curator's) rights give nothing — neither to an agent
 * nor in the workplace; the curator moves, returns and deletes it only in "Common knowledge review" (forbidden with a link).
 * The external agents' address says nothing about closed: moving, closing and deleting a closed-class record
 * answer not_found there — as for a missing one.
 */
export async function ownedLocator(app: App, caller: Caller, id: string, spaces: Map<string, SpaceAccess>): Promise<Locator> {
  const me = requirePerson(caller), loc = await locate(app, id);
  if (!loc) throw notFound();
  if (isExternal(caller) && loc.class === "closed") throw notFound();
  if (loc.owner_id !== me.id && spaces.get(loc.space_id)?.role !== "owner") throw notFound();
  if (loc.owner_id !== me.id && spaces.get(loc.space_id)?.kind === "org") throw curatorOnlyInWorkplace(app);
  return loc;
}

export async function neverOpenReason(app: App, loc: Locator, targetSpace?: SpaceAccess, control: Pick<pg.Pool, "query"> = app.db.control): Promise<string | null> {
  const { rows } = await control.query("SELECT kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId]);
  const slug = (await control.query("SELECT slug FROM spaces WHERE id = $1", [loc.space_id])).rows[0]?.slug;
  let card: boolean | null = null;
  for (const r of rows) {
    // by the locator, the rules that need no content are checked: a person's card from the directory and the space.
    // The rules by domain tag and by title are checked by the move_class worker in the system context before the move.
    // A card is only a directory record (isDirectoryCardRow): an employee's work profile is type profile too, but the cards
    // rule does not touch it. The locator has no source — one record row is read lazily
    if (r.kind === "entity_kind" && r.pattern === "person" && loc.type === "profile") {
      card ??= await directoryCardOf(app, loc);
      if (card) return r.reason;
    }
    if (r.kind === "space" && (r.pattern === slug || r.pattern === targetSpace?.slug)) return r.reason;
  }
  return null;
}

/**
 * Is a `profile` record by locator a directory card? The source is read in the record's class DB in the system context, without
 * content (like the open-by-word gate, byWordTreeOk). No row (a locator without a record: a move failure) — "a card":
 * in doubt the personal-data rule applies, as before the narrowing.
 */
async function directoryCardOf(app: App, loc: Pick<Locator, "record_id" | "class">): Promise<boolean> {
  const row = (await app.db.records(loc.class, { classes: ["open", "closed"], tier: "system" })
    .query("SELECT type, source_kind, source_ref FROM records WHERE id = $1", [loc.record_id])).rows[0];
  return row ? isDirectoryCardRow(row) : true;
}

/** An employee card from the directory: the org table fills it — it moves nowhere. A public profile may move. */
export const DIRECTORY_CARD_REFUSAL = "The company directory maintains colleague profiles; they cannot be moved";
/** A wrapper of the common isDirectoryCardRow: the default type is profile (move rows pick no type; `people:` occurs only on a card). */
export const isDirectoryCard = (r: { type?: string | null; source_kind?: string | null; source_ref?: string | null } | undefined): boolean =>
  !!r && isDirectoryCardRow({ type: r.type ?? "profile", source_kind: r.source_kind, source_ref: r.source_ref });
/**
 * An employee's work profile always lies in their personal space: the current profile lookup searches only there,
 * and a move would create a second current profile. The "Show to colleagues" copy shows it to colleagues.
 */
export const WORK_PROFILE_MOVE_REFUSAL = "You cannot move a work profile to another space. Use “Show to colleagues” to make it visible to colleagues";
/** The "How we work" map is each space's own: a move would make it someone else's note. */
export const SPACE_GUIDE_MOVE_REFUSAL = "You cannot move the “How we work” guide to another space. Each space has its own guide, which its owner can edit on the guide page";

/**
 * The work profile by locator: `personal` — a version of the personal profile (`workprofile:`), `copy` — the copy for
 * colleagues in org (`workprofile-public:`), else null. The source is read in the class DB in the system context, no content.
 */
export async function workProfileKindOf(app: App, loc: Pick<Locator, "record_id" | "class" | "type">): Promise<"personal" | "copy" | null> {
  if (loc.type !== "profile") return null;
  const row = (await app.db.records(loc.class, { classes: ["open", "closed"], tier: "system" })
    .query("SELECT type, source_kind, source_ref FROM records WHERE id = $1", [loc.record_id])).rows[0];
  if (!row || !isWorkProfileRow(row)) return null;
  return String(row.source_ref).startsWith(WORKPROFILE_PUBLIC_PREFIX) ? "copy" : String(row.source_ref).startsWith(WORKPROFILE_PREFIX) ? "personal" : null;
}

/** The colleagues' copy is not closed or deleted alone: the profile drives it — flags, "Hide from agents", profile deletion. */
const copyRefusal = (): MemoryError => invalid(PROFILE_COPY_TEXT, { reason: "profile_public_copy" });

/** A profile is not hidden or deleted under record locks (as a plan item) — only one at a time. */
export const PROFILE_ONE_BY_ONE_TEXT = "To hide a work profile from agents or delete it, act on it individually in “My profile”";

/**
 * Hiding or deleting the personal profile — under the person's profile lock (the same as the profile write): first the copy for
 * colleagues goes (no trash), then the action. The action fails after the copy is gone — the copy returns at the next save of
 * the flags; the other way round (profile hidden, copy left) would be worse — colleagues would see the hidden one.
 * Under record locks (a plan item: withOwnerLocks and a DB snapshot with FOR UPDATE) no wait for the profile lock — refusal: the
 * profile write holds that lock and waits for a version row under plan locks; Postgres sees no such cycle, both would hang until
 * a gateway restart; removing the copy would also leave the plan's transactions (locators — past its control). The plan does not
 * take a profile anyway (plans.ts permission → not_applicable) — this is a safeguard.
 */
async function withProfileUnpublished<T>(app: App, caller: Caller, ownerId: string, reason: UnpublishReason, fn: () => Promise<T>): Promise<T> {
  if (underOwnerLocks()) throw invalid(PROFILE_ONE_BY_ONE_TEXT);
  return withKeyLock(profileLockKey(ownerId), async () => {
    await unpublishProfile(app, caller, ownerId, reason);
    return fn();
  });
}

/** The source's reader restriction (PUT /ingest/access) — in the words of the move answer. */
const RESTRICTED_TEXT = "The meeting service restricted the audience";

/**
 * The root scope after the move — what the derivation check compares with sources: the author (widen) widens to "space", except
 * a root restricted by the source (it stays "people", as in spaceMove); the space owner does not widen another's record
 * — the scope stays.
 */
async function audienceAfterMove(db: Pick<pg.Pool, "query">, id: string, widen: boolean): Promise<string> {
  const r = (await db.query(`SELECT audience, COALESCE(attrs #>> '{access,restricted_by_source}', '') = 'true' AS restricted FROM records WHERE id = $1`, [id])).rows[0];
  return widen && !r?.restricted ? "space" : (r?.audience as string | undefined) ?? "space";
}

/**
 * Does the caller read the record by id — the same gate as reading (loadReadable). "Not found" and "moving" — does not
 * read: in doubt the open check findings are not shown.
 */
export async function readsRecord(app: App, caller: Caller, id: string, spaces?: Map<string, SpaceAccess>): Promise<boolean> {
  try {
    await loadReadable(app, caller, id, spaces);
    return true;
  } catch (e) {
    if (e instanceof MemoryError && (e.code === "not_found" || e.code === "in_progress")) return false;
    throw e;
  }
}

type PromoteArgs = { id: string; to_space: string; confirm_wider?: boolean };
type PromoteOptions = { mode?: "promote" | "move_space"; viaPlan?: boolean };
/**
 * `promote` as other modules import it: a refused agent call leaves a trace (denied-audit.ts); inside a plan the
 * item outcome (gone, no_rights) is the trace already. The body below keeps the name `promote` in this module — the guard
 * tests of the gates (extended-open-static, extended-mark, archive-calls) read that function.
 */
async function promoteTraced(app: App, caller: Caller, a: PromoteArgs, o: PromoteOptions = {}): ReturnType<typeof promote> {
  return o.viaPlan ? promote(app, caller, a, o) : traceDenied(app, caller, "memory_promote", () => promote(app, caller, a, o));
}
export { promoteTraced as promote };

async function promote(app: App, caller: Caller, a: PromoteArgs, o: PromoteOptions = {}) {
  // the "wider than sources" confirmation — only a person in the workplace and not from a plan (an input error — before rights)
  checkConfirmWider(app, caller, a.confirm_wider, o.viaPlan === true, a.id);
  // the map with the archive: an archived one's owner learns their role, a reader of an archived target — an honest refusal
  const me = requirePerson(caller), spaces = await readableSpaces(app, caller, { archived: true });
  const loc = await ownedLocator(app, caller, a.id, spaces);
  if (loc.deleted) throw notFound();
  await correctionNoteAlone(app, caller, loc, a.id);
  const target = await resolveSpace(app, caller, a.to_space, spaces);
  if (!target) throw notFound();
  // Return to personal: only the author and only into their own personal space — the space owner does not take another's record
  // to themselves. The source — any space, an archived one too (the author no longer reads it, the record is theirs).
  const back = target.kind === "personal";
  if (back && (loc.owner_id !== me.id || target.owner_id !== me.id)) throw notFound();
  // Archive: nothing moves into or out of an archived space — except the author returning their record to personal
  // (the reader circle only narrows)
  if (target.archived_at) throw archivedDenied(target.slug, target.archived_at);
  if (!back) { const from = await spaceArchived(app, loc.space_id, spaces); if (from) throw archivedDenied(from.slug, from.archived_at); }
  // nobody takes another's record out of org — neither the curator nor the org owner: only the author
  if (spaces.get(loc.space_id)?.kind === "org" && loc.owner_id !== me.id) throw notFound();
  if (o.mode === "move_space") {
    const source = spaces.get(loc.space_id);
    if (!source || !["team", "project"].includes(source.kind) || !["team", "project"].includes(target.kind)
        || !canWrite(source) || !canWrite(target)) throw notFound();
  }
  // into org the record owner promotes; into a team space — one who may write there
  if (target.kind === "org" && loc.owner_id !== me.id) throw notFound();
  if (target.kind !== "org" && !canWrite(target)) throw notFound();
  if (target.kind === "org") { const reason = await neverOpenReason(app, loc, target); if (reason) throw neverOpen(reason); }
  const db = app.db.recordsForWrite(loc.class, caller.scope);
  const srcRow = (await db.query("SELECT source_kind, source_ref, parent_id, type FROM records WHERE id = $1", [a.id])).rows[0];
  if (isDirectoryCard(srcRow)) throw invalid(DIRECTORY_CARD_REFUSAL);
  if (isWorkProfileRow(srcRow)) throw invalid(WORK_PROFILE_MOVE_REFUSAL);
  if (isSpaceGuideRow(srcRow)) throw invalid(SPACE_GUIDE_MOVE_REFUSAL);
  // the space owner (the head) moves another's record without widening its scope: the "people" reader list is kept;
  // a return only narrows the reader circle — the scope, confirmation and class do not change
  const widen = loc.owner_id === me.id && !back;
  // A move into the same space changes nothing — "no change", no gate, no write and no event; but if
  // the author widens the reader circle so (rows with the "people" scope not restricted by the source) — the same gates as a move
  // into another space: derivation, extended key, open check. Under the lock spaceMove rechecks the layout (sameSpaceGated)
  const same = !back && target.id === loc.space_id;
  const sameWiden = same && widen && await widenPending(db, a.id, loc.owner_id, target.id);
  const gated = !back && (!same || sameWiden);
  // a retelling wider than its sources is moved only by a person with confirmation — before the extended-key gate. The scope
  // after the move: the author widens it to "space", the space owner with another's record does not; a root
  // whose reader circle the source restricted stays "people" for the author too (spaceMove, widenOf) — its
  // readers do not widen, and it needs no "wider than sources" confirmation
  const derivedCheck = !gated ? null : await promoteDerivation(app, caller, {
    recordId: a.id, db, cls: loc.class, target, confirm: a.confirm_wider, viaPlan: o.viaPlan === true, spaces,
    audienceAfter: await audienceAfterMove(db, a.id, widen) });
  // access.promote_confirmation = human: every check above ran unchanged, so the refusals are the former ones. A
  // widening move by anyone but a person in the workplace moves nothing: it becomes a request (a one-item plan) that a
  // person applies in the workplace — before any side effect below (the extended_open event, the project entity). An item
  // of a plan by such a caller is never executed either (second line: a plan made before the setting, a forgotten
  // applyVia). An extended key barred from open writes keeps today's refusal of the gate: it must not queue such a move.
  const confirm = gated && needsConfirmation(app, caller);
  if (confirm && o.viaPlan) throw humanConfirmationRequired(app, `/records/${a.id}`, "Record");
  if (confirm && !(loc.class === "open" && openWriteMode(caller) === "denied")) {
    const { confirmationPlan } = await import("./plans.ts"); // lazy: plans.ts imports this module
    const p = await confirmationPlan(app, caller, { id: a.id, target, op: o.mode === "move_space" ? "move_space" : "promote" });
    return confirmationAnswer(app, { id: a.id, planId: p.planId, expiresAt: p.expiresAt });
  }
  // moving an open record into another space is a write into open: an agent that reads closed does not do it without the
  // administrator's permission; a return into one's own personal space only narrows the reader circle — no gate
  // with permission — the move is logged (extended_open), the record itself is not marked: its content is not new
  const mark = gated && loc.class === "open"
    ? await extendedOpenGate(app, caller, { attempt: "promote", space: { id: target.id, slug: target.slug }, recordId: a.id }) : null;
  if (confirm) throw humanConfirmationRequired(app, `/records/${a.id}`, "Record"); // the gate above refused already: nothing below runs for a request
  const projectEntity = target.kind === "project"
    ? await ensureProjectEntity(app.db.control, { ...target, instance_id: app.instanceId }, { update: false }) : null;
  // org curators: entering org puts the record under review, the author taking it out — a left row (the hold stays).
  // The review unit is the head of the version chain of one's own note: the move carries the whole chain, one row.
  const toOrg = target.kind === "org" && loc.space_id !== target.id, fromOrg = spaces.get(loc.space_id)?.kind === "org" && target.kind !== "org";
  // the space head moves another's record they do not read themselves (a meeting without them): the open check refusal
  // comes without findings. The move is still available to them. Reading is checked before the record
  // lock: inside it the control connection is already taken, a second from the same pool is not taken
  const hideFindings = !back && loc.class === "open" && target.id !== loc.space_id && loc.owner_id !== me.id
    && !(await readsRecord(app, caller, a.id, spaces));
  const unitId = toOrg || fromOrg ? await chainHeadOf(app, caller, loc, a.id) : a.id;
  // a tree part (summary, meeting decision) into org on its own: the hold and "sent back" of the source records go with it
  const sourceUnits = toOrg ? await sourceUnitsOf(app, db, unitId) : [];
  const curator = toOrg && isOrgCurator(caller, spaces), human = isHumanSession(caller) && !o.viaPlan;
  let entered = null as EnterOut | null;
  // Under the record lock, like "Close" and "Open": a class move (including the personal open fallback —
  // the worker decides "the record is still personal" under the same lock) and a space change do not interleave. A class
  // move is running or its rows are hidden — in_progress: else the rows would go to the other database with the old space, and
  // the locator with the new one, and the answer "the class did not change" would be a lie
  const out = await underRecordLock(app, a.id, () => { throw inProgress(10); }, async (q) => {
    const busy = (await q.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [a.id])).rowCount;
    // The class, home or owner changed after the first locator — repeat the rights check and the DB choice on the fresh state.
    const now = (await q.query("SELECT class, space_id, owner_id FROM record_locations WHERE record_id = $1", [a.id])).rows[0];
    const row = (await db.query("SELECT hidden_at IS NOT NULL AS hidden, space_id, owner_id, COALESCE((attrs->>'original_closed')::boolean, false) AS original_closed FROM records WHERE id = $1", [a.id])).rows[0];
    // the record home is in the row (it decides the readers), the rights — by the locator; they diverged (a move failure between
    // the records database and control) — do not move by a stale locator until the class reconciler brings it to the row.
    // the custodian job changes a meeting's owner (handing over and returning the organizer under the same record lock),
    // and in a project or team — with no home change. Rights, widening (widen) and "return to personal" (back) were computed for
    // the former owner — the row or locator has another (and the tail where the row has the new one, the locator still the old) —
    // repeat: a fresh ownedLocator recomputes everything for the current organizer
    if (busy || row?.hidden || now?.class !== loc.class || now?.space_id !== loc.space_id || now?.owner_id !== loc.owner_id
        || (row && (row.space_id !== now.space_id || row.owner_id !== now.owner_id))) throw inProgress(10);
    // The background reconcile may not have reached the record yet (a rollout, a team conversion, a partial failure). We ensure
    // the source project entity, and count its still missing mark in the check as future history.
    const source = (await q.query("SELECT id, slug, name, instance_id FROM spaces WHERE id = $1 AND kind = 'project' AND instance_id = $2", [loc.space_id, app.instanceId])).rows[0];
    const sourceEntity = source ? await ensureProjectEntity(q, source, { update: false }) : null;
    // The control query uses the already taken control connection: parallel moves do not wait for one more
    // slot in the same pool. The advisory lock is held from reading the source home until the move ends. A return to personal
    // adds no new readers — it has no open check.
    if (gated && loc.class === "open") {
      const tree = await treeTexts(app, "open", a.id, { live: true, targetSpaceId: target.id, control: q });
      if (sourceEntity && entityNameNeedsOpenCheck("space", source.id, target.id)) {
        const name = (await q.query("SELECT display_name FROM entities WHERE id = $1", [sourceEntity])).rows[0]?.display_name;
        if (typeof name === "string" && name.trim()) {
          const names = tree.texts.find((text) => text.field === "entities");
          if (names) names.value = [names.value, name].filter(Boolean).join("\n");
          else tree.texts.push({ field: "entities", value: name });
        }
      }
      // a document shown to agents "as text only" (original_closed) — scans are not dropped: the consent was for the current
      // reader circle, a move — after "hide" and a new showing
      await guardOpen(app, caller, { via: "promote", spaceId: target.id, recordId: a.id, texts: tree.texts, unchecked: moveUnchecked(tree.unchecked, row?.original_closed === true), hideFindings });
    }
    // the review row — in the lock transaction BEFORE moving the rows: a move failure rolls it back too; the root
    // scope — before widening (bring back "people" on a return)
    if (toOrg) {
      const aud = (await db.query("SELECT audience FROM records WHERE id = $1", [unitId])).rows[0]?.audience ?? null;
      entered = await enterOrg(q, app, { recordId: unitId, via: "promote", caller, curator, human, extended: mark !== null,
                                         fromSpaceId: loc.space_id, fromAudience: aud, ancestorUnitIds: sourceUnits });
    } else if (fromOrg) await leaveOrg(q, unitId, me.id);
    // The core (space-move.ts): the set's row lock first, the set — by a fresh statement, UPDATE by the list, locators
    // upsert, a space_moves trace. A return carries the author's version chain and trees together with the deleted rows.
    return spaceMove(q, db, { recordId: a.id, cls: loc.class, toSpaceId: target.id, actorId: me.id, authorId: loc.owner_id,
                              op: back ? "return" : o.mode === "move_space" ? "move_space" : "promote", widen, ...(same ? { sameSpaceGated: sameWiden } : {}) }, async (c, _moved, set) => {
      // the set's links and declared counts are reread under the lock — changed after the check (including a set without
      // origin: a parallel repeat added a link) — repeat (in_progress)
      if (derivedCheck && (await readBasis(c, q, a.id)).fingerprint !== derivedCheck.fingerprint) throw inProgress(10);
      if (derivedCheck?.widened) await markWidened(c, a.id, widenedMark(me.id, "promote"));
      // The source project's history mark and the home change are committed together; on a check refusal the marks stayed.
      // The source project's marks stay on a return (history).
      if (sourceEntity) await c.query(TAG_TREE_SQL, [a.id, sourceEntity]);
      if (projectEntity) await c.query(TAG_TREE_SQL, [a.id, projectEntity]);
      if (widen) await c.query(`UPDATE records SET confirmed_at = COALESCE(confirmed_at, now()), confirmed_by = COALESCE(confirmed_by, $2) WHERE id = $1`, [a.id, me.id]);
      // the record's people list (meeting participants) keeps access after the move — the answer names their number;
      // on a return the author is not counted in the list: "you and the meeting participants (N)"
      const listed: number = (await c.query(back ? "SELECT count(*)::int AS n FROM record_people WHERE record_id = $1 AND person_id <> $2"
                                                 : "SELECT count(*)::int AS n FROM record_people WHERE record_id = $1", back ? [a.id, loc.owner_id] : [a.id])).rows[0]?.n ?? 0;
      if (!back) return { listed, placements: 0, parentAway: null as string | null };
      // the same file uploaded somewhere else too (record_placements) stays there: the count — only over the spaces the author sees
      const placed = (await c.query("SELECT DISTINCT space_id FROM record_placements WHERE record_id = ANY($1::uuid[]) AND space_id <> $2",
                                    [set.map((r) => r.id), target.id])).rows.map((r) => r.space_id as string);
      const root = set.find((r) => r.id === a.id);
      // a derived record (summary, decision) is returned: its source record stayed outside personal — hint to return it too
      const parentHome = root?.parent_id ? (await c.query("SELECT space_id FROM records WHERE id = $1", [root.parent_id])).rows[0]?.space_id : null;
      return { listed, placements: placed.filter((id) => spaces.has(id)).length, parentAway: parentHome && parentHome !== target.id ? root!.parent_id : null };
    });
  });
  if (out.status === "gone") throw notFound();
  const root = out.set.find((m) => m.id === a.id)!;
  if (out.status === "already") {
    // nothing changed — no UPDATE, no event; the path — by the record row (the meeting date), not by the locator. The
    // unchanged sign — to the workplace and the agent, so they need not parse the text. A move into the same space —
    // is "no change" too; for one restricted by the source — why the reader circle was not widened
    const path = recordPath(target.slug, root.type, root.occurred_at, a.id);
    const why = root.restricted ? `. ${RESTRICTED_TEXT}` : "";
    return { result: { id: a.id, path, space: target.slug, class: loc.class, derived_moved: 0, unchanged: true as const },
             text: back ? `The record is already in the author’s personal space: ${path}. Nothing changed`
                        : `The record is already in ${target.slug}: ${path}. Its audience did not change${why}. Nothing changed` };
  }
  // moved — only rows that changed home (on a tail return, what already lay in personal does not count); the scope — post-move.
  // Into the same space the home does not change: "moved" is only what had its reader circle widened
  const sameHome = new Map(out.set.map((r) => [r.id, r]));
  const moved = same ? out.moved.filter((m) => sameHome.get(m.id)?.audience !== m.audience) : out.moved, { listed, placements, parentAway } = out.extra;
  const after = out.moved.find((m) => m.id === a.id);
  const derived = moved.filter((m) => m.id !== a.id).length;
  const recordIds = [a.id, ...moved.map((m) => m.id).filter((id) => id !== a.id)];
  // a return: from where — the space it was actually returned from (the root, else the first row that changed home), not personal
  const returnedFrom = (after ?? moved.find((m) => m.from_space))?.from_space ?? null;
  // the author sees a move by other hands (the space owner) in "My actions" — details.author;
  // a return — op: return, by: author (org review takes the same op with by: curator|auto); no author or text in the event
  const details = back
    ? { tool: "memory_promote", op: "return", by: "author", from_space: returnedFrom, to_space: target.slug, derived, placements_left: placements }
    : { tool: "memory_promote", ...(o.mode === "move_space" ? { op: "move_space" } : {}), from_space: loc.space_id, to_space: target.slug, ...(loc.owner_id !== me.id ? { author: loc.owner_id } : {}),
        ...(same ? { widen_only: true } : {}),
        ...markEvent(mark), ...(entered ? { org_review: entered.state, cycle: entered.cycle } : fromOrg ? { org_review: "left" } : {}),
        ...(derivedCheck?.widened ? { widened_by_human: true } : {}) };
  await audit(app, caller, { event_type: "promote", class: loc.class, record_ids: recordIds, space_id: target.id, details });
  const result = { id: a.id, path: recordPath(target.slug, root.type, root.occurred_at, a.id), space: target.slug, class: loc.class, derived_moved: derived,
                   ...(derivedCheck?.widened ? { widened_by_human: true as const } : {}),
                   ...(back && placements > 0 ? { placements_left: placements } : {}), ...(back && parentAway ? { parent_left: parentAway } : {}),
                   // a move into org for review (contract 0.9.0): where it returns — the slug to the author only
                   ...(entered ? { org_review: { state: entered.state as "unreviewed" | "confirmed" | "community" | "exempt",
                                                 return_after: entered.return_after ? new Date(entered.return_after).toISOString() : null,
                                                 return_to: entered.return_after && loc.owner_id === me.id ? spaces.get(loc.space_id)?.slug ?? null : null } } : {}) };
  const listedWho = root.type === "transcript" ? "meeting participants" : "people on the record’s access list";
  if (back) {
    // honestly: who sees it now, that what was read cannot be taken back, that the class stays; without "space members u-…".
    // A file: the placements are not removed — it is the same record, the members of those spaces still find and read it
    // (visibility: the "space" scope and the placement), including those the author does not see: there — without a number
    const file = root.type === "document";
    const cls = loc.class === "closed"
      ? "The class is still closed, so cloud agents using personal keys cannot read it"
      : "The class is still open, so the author’s cloud agents can still read it with the author’s personal key";
    const parts = [
      `The record was returned to the author’s personal space: ${result.path}`,
      `Only the author can see it now${listed ? `; ${listedWho} (${listed}) keep their access` : ""}${file ? " — except in other spaces where colleagues uploaded the same file: it remains searchable and readable there" : ""}. Only the author can return a record to their personal space`,
      `${file ? "Other colleagues" : "Colleagues"} lost search and read access immediately because permissions are checked on every read. Agents may have kept a copy of what they already read`,
      cls,
      `Derived records and earlier versions returned with it: ${derived}`,
      ...(placements ? [`The same file was also uploaded to ${placements} ${placements === 1 ? "space" : "spaces"}, which the author can see`] : []),
      ...(parentAway ? [`The source record is still outside the personal space. Return the source record too: ${parentAway}`] : []),
    ];
    return { result, text: `${parts.join(". ")}.` };
  }
  // honestly: who sees the record now and what its class means for agents. The scope — after the move: the author
  // widens it to "space" (widen), the space owner with another's record does not
  // restricted by the source — honestly: the meetings service restricted the reader circle, not the move
  const who = (after?.audience ?? root.audience) === "people"
    ? root.restricted ? `${RESTRICTED_TEXT}: only ${listedWho} (${listed}) can see it. Only the meeting service can widen access`
      : `The audience did not expand. The same ${listedWho} (${listed}) can see it because the space owner moved the record instead of the author`
    : `Now visible to ${target.kind === "org" ? "all employees" : `members of the space ${target.slug}`}${listed ? `; ${listedWho} (${listed}) keep their access` : ""}`;
  const restrictedLeft = out.set.some((r) => r.restricted && r.id !== a.id && out.moved.some((m) => m.id === r.id))
    ? `. Only people on the relevant access list can see parts for which ${RESTRICTED_TEXT.toLowerCase()}` : "";
  const cls = loc.class === "closed"
    ? "The class is still closed. Cloud agents using personal keys cannot read it. T0 services can read it on behalf of employees. Only a person can show it to agents in the workspace"
    : "The class is still open, so employees’ cloud agents can read it with personal keys";
  const widenedLine = derivedCheck?.widened ? ". This record is a retelling. You chose to move it to a wider audience than its sources, so people without access to the sources can see it" : "";
  const head = same ? `The record’s audience was widened in ${target.slug}: ${result.path}` : `The record was moved to ${target.slug}: ${result.path}`;
  return { result, text: `${head}. ${who}${restrictedLeft}. ${cls}. ${same ? "Derived records with a wider audience" : "Derived records moved"}: ${result.derived_moved}${widenedLine}${mark ? JOURNAL_TAIL : ""}` +
                         promoteOrgText(app, entered, { recordId: unitId, fromSlug: spaces.get(loc.space_id)?.slug ?? "original space", curator }) };
}

// ---------------------------------------------------------------- open by a person's word
/** Why the record does not open by word (details.gate of the forbidden refusal): the wrong key, not own personal space or other
 * readers, no check mark or it is already used, agents' writes off, the check off; `workplace`
 * — the record is not in one's own personal space: only the author in the workplace can show it. */
export type ByWordGate = "key" | "space" | "marker" | "notebook" | "disabled" | "workplace";

const GATE_WHY: Record<ByWordGate, string> = {
  key: "memory_open is available only to cloud agents using a person’s personal key",
  workplace: "outside your personal space, only the author can show the record to agents in the workspace",
  space: "your confirmation can only make your own record open in your personal space, without other readers or copies in other spaces",
  marker: "confirmation only works once and only for a record that the open check saved as closed. After “Hide from agents”, only a person can show it again",
  notebook: "the person disabled agent writes to their personal space",
  disabled: "the administrator disabled the open check",
};

/**
 * A forbidden refusal with a link to the "Make available to agents" panel: `details.workplace_path` — always
 * (`/records/<id>?show=anyway`), `details.workplace_url` — when the workplace address is set. Without the address the text names
 * the relative path and "the administrator knows the workplace address". The error schema has only code, message, hint,
 * retry_after, reason, details.
 */
export function byWordForbidden(app: App, id: string | null, gate: ByWordGate): MemoryError {
  const path = id ? showAnywayPath(id) : "/records";
  const url = workplaceUrl(app, path);
  const where = url ? `A person can show it to agents in the workspace: ${url}`
    : `Ask the person to open the record ${path} in the workspace (the administrator knows the workspace address)`;
  return new MemoryError("forbidden", `This record cannot be made open with your confirmation: ${GATE_WHY[gate]}. ${where}`,
    { hint: "Send the person the workspace link. Do not open it or select the button on their behalf", details: { gate, workplace_path: path, ...(url ? { workplace_url: url } : {}) } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `memory_open` asked by a caller that may not use it (gate `key`: an extended key, a script key, a workplace
 * session — the tool is not in its list, mcp.ts answers forbidden) leaves the event the data policy promises:
 * `open {op: open_word_denied, gate: key}`. The record is named only when it is the caller's own; an external caller
 * (its answer is not_found) and a repeat of the same key within a minute leave nothing. Never throws.
 */
export async function noteByWordDenied(app: App, caller: Caller, id: unknown): Promise<void> {
  try {
    if (!deniedSlot(app, caller, "memory_open")) return;
    const loc = typeof id === "string" && UUID.test(id) && caller.person ? await locate(app, id) : null;
    const own = loc && loc.owner_id === caller.person?.id ? loc : null;
    await audit(app, caller, { event_type: "open", ...(own ? { class: own.class, record_ids: [id as string], space_id: own.space_id } : {}),
                               details: { op: "open_word_denied", via: caller.transport ?? "mcp", tool: "memory_open", gate: "key" } });
  } catch (e) {
    log.warn("open_word_denied_trace_failed", { error: ((e as Error)?.message ?? "").slice(0, 300) });
  }
}

/**
 * Gate 1: a person's personal key without the closed class — a cloud agent; not a preview, not "on behalf of", not a script
 * key. memory_open is not shown to a workplace session, an extended key, a script or services (mcp.ts). Nor to the external
 * agents' address: it says nothing about closed, a direct call there is not_found.
 */
export function openByWordCaller(caller: Caller): boolean {
  return personalAgent(caller)
    && !caller.scope.classes.includes("closed") && caller.clientKind !== "script" && !isExternal(caller);
}

/** The root mark in the closed database (attrs) and the trace of an earlier opening by word. */
async function rootMarks(app: App, recordId: string): Promise<{ mark: unknown; accepted: unknown }> {
  const db = app.db.records("closed", { classes: ["open", "closed"] as const, tier: "system" as const });
  const row = (await db.query("SELECT attrs -> 'open_check_fallback' AS mark, attrs -> 'open_check_accepted' AS accepted FROM records WHERE id = $1", [recordId])).rows[0];
  return { mark: row?.mark ?? null, accepted: row?.accepted ?? null };
}

type OpenOut = { result: { id: string; class: "open"; status: "done" | "in_progress"; move_id: string;
                           accepted?: { rules: string[]; kinds: string[]; reasons: string[] }; confirmation?: ByWordConfirmation }; text: string };
const acceptedView = (rules: readonly string[] | null | undefined) => {
  const r = [...new Set(rules ?? [])];
  return { rules: r, kinds: acceptedKinds(r), reasons: acceptedReasons(r) };
};

/** `despite` — "Make available to agents" with consent to a version: fingerprints, space, scope, "as text only", the last move. */
interface StartArgs { id: string; ownerId: string; spaceId: string; accepted: string[] | null; confirmation: ByWordConfirmation | null; via: "person" | "agent_relayed" | "human_workplace";
                      despite?: DespiteAccepted }
const BUSY_MOVE = ["pending", "copying", "verifying"];
/**
 * "Please wait": no move started. `details.reason: closing` — this record is being closed: the workplace writes "the record
 * is being hidden from agents now"; without it — another showing of this record (a second tab) or another action holds
 * the lock, and then the text is neutral.
 */
const openBusy = (closing: boolean) => (closing ? new MemoryError("in_progress", "The record is being hidden from agents", { retry_after: 10, details: { reason: "closing" } }) : inProgress(10));

/**
 * Starts a closed → open move under the record lock: two simultaneous "open" calls do not start two moves,
 * deletion does not cut in. Under the lock the class, a running move and — for an opening by word — the space,
 * placements and readers are reread. A closing is running — in_progress for any opening (before, the person's button
 * got a false "move running"). "Make available to agents": "already running" — only the same showing (the same
 * consent fingerprint), otherwise in_progress; under the lock — the last move is the same as at the preview, and the reader
 * circle is the same; class_moves gets the fingerprints, space, scope and "as text only".
 */
async function startOpenMove(app: App, a: StartArgs, running: (moveId: string, rules: string[] | null) => OpenOut): Promise<{ early?: OpenOut; denied?: string; moveId?: string }> {
  // the same showing — the same consent fingerprint; a plain opening and one by word have none
  const same = (cur: { accepted_print?: string | null }): boolean => !a.despite || cur.accepted_print === a.despite.print;
  return underRecordLock<{ early?: OpenOut; denied?: string; moveId?: string }>(app, a.id, async () => {
    // not only a move holds the lock: memory_promote, deletion, "Close", restoring from the trash and the conversion
    // text take it too. "Move already running" — only if the last move is an opening and it is running; otherwise
    // no move was started, and an in_progress answer with the old move_id would be a lie — retry later (as close).
    // Read after the lock transaction ends (underRecordLock): the control connection is already back in the pool
    const cur = (await app.db.control.query("SELECT id, status, to_class, accepted_rules, accepted_print FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [a.id])).rows[0];
    if (!cur || cur.to_class !== "open" || !BUSY_MOVE.includes(cur.status) || !same(cur)) throw openBusy(!!cur && cur.to_class === "closed" && BUSY_MOVE.includes(cur.status));
    return { early: running(cur.id as string, cur.accepted_rules ?? null) };
  }, async (q) => {
    const now = (await q.query("SELECT class, deleted, space_id, owner_id FROM record_locations WHERE record_id = $1", [a.id])).rows[0];
    if (!now || now.deleted) throw notFound();
    // the organizer and home — again under the lock (as in promote): openTarget checked the rights before the tree check,
    // and meanwhile the custodian job could give the meeting back to its organizer (or hand it to the custodian) under the same
    // record:<id> lock. Another owner in the locator — not_found (a repeat would give not_found in openTarget anyway). The row
    // is with another or in another home while the locator is old (tail of an organizer change or a failed move) — in_progress:
    // a pass aligns the locator. Another locator home (moved to a team or project during the check) — in_progress: a repeat
    // checks the record anew at its current place; opening by word and "Make available to agents" have their refusals below
    if (now.owner_id !== a.ownerId) throw notFound();
    const row = (await app.db.recordsForWrite(now.class as DataClass, "system").query("SELECT owner_id, space_id FROM records WHERE id = $1", [a.id])).rows[0] as
      { owner_id: string; space_id: string } | undefined;
    if (row && (row.owner_id !== now.owner_id || row.space_id !== now.space_id)) throw inProgress(10);
    const last = (await q.query("SELECT id, status, error, to_class, accepted_rules, accepted_print FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [a.id])).rows[0];
    const busy = last && BUSY_MOVE.includes(last.status);
    if (now.class === "open" && !busy)
      return { early: { result: { id: a.id, class: "open", status: "done", move_id: last?.id ?? NIL, ...(a.confirmation ? { accepted: acceptedView([]), confirmation: a.confirmation } : {}) }, text: "The record is already in the open class" } };
    if (busy) {
      // a closing is running — opening comes after it: by word and by the person's button; another showing running — later too
      if (last.to_class !== "open" || !same(last)) throw openBusy(last.to_class === "closed");
      return { early: running(last.id as string, last.accepted_rules ?? null) };
    }
    if (last?.status === "failed" && typeof last.error === "string" && last.error.startsWith("never_open:")) throw neverOpen(last.error.slice("never_open:".length));
    if (a.confirmation === "agent_relayed" && a.accepted) {
      // the space may have changed (memory_promote) during the check — opening by word only in one's own personal space
      if (now.space_id !== a.spaceId || !(await byWordTreeOk(app, a.id, a.spaceId, a.ownerId, q))) throw byWordForbidden(app, a.id, "space");
    }
    if (a.despite) await despiteUnderLock(app, { id: a.id, lastId: (last?.id as string | undefined) ?? null, spaceId: now.space_id, d: a.despite });
    if (now.space_id !== a.spaceId) throw inProgress(10);   // a plain opening — the home changed after the check
    // control — only through the held q: ~10 parallel "Open" calls, holding a connection and asking for a second, hung the pool
    const loc = await locate(app, a.id, q);
    const reason = loc ? await neverOpenReason(app, loc, undefined, q) : null;
    if (reason) return { denied: reason };
    const moveId = newId(), d = a.despite;
    await q.query(`INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via, accepted_rules, confirmation, accepted_print, accepted_aud, accepted_space_id, accepted_scope, text_only)
                   VALUES ($1,$2,'closed','open',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                  [moveId, a.id, a.ownerId, a.via, a.accepted && a.accepted.length ? a.accepted : null, a.confirmation,
                   d?.print ?? null, d?.aud ?? null, d?.sid ?? null, d?.scope ?? null, d?.textOnly === true]);
    return { moveId };
  });
}

/**
 * Is the record a retelling: declared at write time or there are derived_from links in the set. Own record metadata is read
 * (set ids and attrs.derived_declared) by the write pool: a personal key without the closed class calls memory_open — the closed
 * database read pool is not given to it. A read failure — not a retelling (the log matters less than the opening).
 */
export async function isRetelling(app: App, caller: Caller, cls: DataClass, id: string): Promise<boolean> {
  try {
    const b = await readBasis(app.db.recordsForWrite(cls, caller.scope), app.db.control, id);
    return b.declared > 0 || b.sources.length > 0;
  } catch {
    return false;
  }
}

/**
 * Open a class: a person in the workplace — REST POST /records/{id}/open. Only the record author opens:
 * the space owner does not open another's record. The log records a confirmation by a person in the workplace.
 * `despite_findings` with `consent` — "Make available to agents": the author shows to agents
 * a record the check left closed, in personal, a team or a project, having agreed in the preview to what
 * the check found and who will see it. The consent is for a version: despiteConsent checks the token, scope, circle, content and
 * checks the record once more; under the lock — the last move and the circle (startOpenMove), on the copy — the worker.
 */
export async function open(app: App, caller: Caller, req: { id: string; despite_findings?: boolean; consent?: string }) {
  const me = requirePerson(caller);
  await requireHuman(app, caller, "Show the record to agents", { path: `/records/${req.id}`, section: "Record" });
  // an earlier version of one's own note — the chain head opens; the answer has the id that was asked
  const { id, loc, cut } = await openTarget(app, caller, req.id, me.id);
  // Archive: "Open" in an archived space — only undoing a closing made after archiving (an agent closed, a person
  // brings it back); anything else — refused: opening widens the archive's reader circle
  const arch = await spaceArchived(app, loc.space_id);
  if (arch) {
    const last = (await app.db.control.query("SELECT to_class, requested_at > $2 AS after FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [id, arch.archived_at])).rows[0];
    if (!(last?.to_class === "closed" && last.after === true)) throw archivedDenied(arch.slug, arch.archived_at);
  }
  const a = { ...req, id };
  const asked = <T extends { result: { id: string } }>(o: T): T => ({ ...o, result: { ...o.result, id: req.id } });
  // the content of the record and derived ones passes the open-class check before the move: the person sees the refusal
  // at once. The move worker checks THE SAME texts (open-check-texts.ts: the tree's deleted rows too — the move copies them,
  // text originals, entity names) with fresh settings — so the settings are reread here too: otherwise the gateway
  // would pass from cache what the move fails on, and the person would press "Open" round and round. A document without
  // checked text (converting, conversion failed, empty text) does not open.
  let d: DespiteAccepted | null = null;
  if (loc.class === "closed") {
    if (cut) await refuseCutChain(app, caller, "open", loc, a.id);
    await app.settings.load(true).catch(() => undefined);
    // "Make available to agents": the check is off — as before, no findings, a plain opening (a token, if any, is verified)
    if (a.despite_findings === true) d = await despiteConsent(app, caller, { id: a.id, loc, consent: a.consent });
    if (!d) {
      const tree = await treeTexts(app, "closed", a.id, { live: false });
      await guardOpen(app, caller, { via: "open", spaceId: loc.space_id, recordId: a.id, texts: tree.texts, unchecked: tree.unchecked, uncheckedVersion: tree.uncheckedVersion === true });
    }
  }
  const accepted = d?.rules.length ? d.rules : null;
  const running = (moveId: string): OpenOut => ({ result: { id: a.id, class: "open", status: "in_progress", move_id: moveId }, text: "The move is already in progress" });
  const started = await startOpenMove(app, { id: a.id, ownerId: me.id, spaceId: loc.space_id, accepted, confirmation: "human_workplace", via: d ? "human_workplace" : "person",
                                             ...(d ? { despite: d } : {}) }, running);
  if (started.early) return asked(started.early);
  if (started.denied) {
    await audit(app, caller, { event_type: "open", class: loc.class, record_ids: [a.id], details: { op: "open", via: "workplace", denied: "never_open" } });
    throw neverOpen(started.denied!);
  }
  const moveId = started.moveId!;
  await app.queue.kick({ instance: app.instanceId, class: "closed", record_id: a.id, lane: "now" });
  const view = d ? acceptedView(d.rules) : null;
  // a person may open a retelling — this is no refusal; the log notes that a retelling was opened
  const derived = await isRetelling(app, caller, loc.class, a.id);
  // showing despite a finding: scope, space kind, how many people will see it, "as text only" — no fingerprints
  await audit(app, caller, { event_type: "open", class: "closed", record_ids: [a.id], space_id: loc.space_id,
                             details: { op: "open", via: "workplace", move_id: moveId, confirmation: "human_workplace", ...(view ? { accepted_rules: view.rules, kinds: view.kinds } : {}),
                                        ...(d ? { despite: true, scope: d.scope, space_kind: d.spaceKind, audience_total: d.audienceTotal, text_only: d.textOnly } : {}),
                                        ...(derived ? { derived: true } : {}) } });
  const scans = d?.textOnly ? ". Agents get only the extracted text, without the file or scanned pages" : "";
  return { result: { id: req.id, class: "open" as const, status: "in_progress" as const, move_id: moveId,
                     ...(view ? { accepted: view, confirmation: "human_workplace" as const, text_only: d!.textOnly } : {}) },
           text: view ? `${view.rules.length ? `Showing to agents is in progress despite a finding. Accepted: ${view.reasons.join(", ")} (${BY_WORD_SCOPE})` : "Showing to agents is in progress"}${scans}. The record is moving to the open database`
                      : "The record is moving to the open database. Try reading it again in a few seconds" };
}

/**
 * Open by a person's word (memory_open): a narrow exception to "only a
 * person opens". The gates in order: 1 — a cloud agent with a personal key; 2 — one's own live record, otherwise
 * not_found; 3 — already open — done; 4 — the open check is on; 5 — the tree only in one's own personal space, without placements
 * and other readers; 6 — a fallback mark of the right form, no opening by word yet; 7 — agents' writes in the
 * personal space are on; 8 — all kinds of the mark can open by word (otherwise open_check never_by_word); 4–7 not met —
 * forbidden with a link. Then the tree check with fresh settings and the accepted rules off (the mark's rules)
 * and the move with `accepted_rules`, `confirmation: agent_relayed` — the worker checks everything once more on the copy.
 */
export async function openByWord(app: App, caller: Caller, req: { id: string }) {
  if (isExternal(caller)) throw notFound();                // the external agents' address: no such tool
  if (!openByWordCaller(caller)) { await noteByWordDenied(app, caller, req.id); throw byWordForbidden(app, req.id, "key"); }
  const me = caller.person!;
  // an earlier version of one's own note — the chain head opens by its mark, the answer has the id that was asked
  const { id, loc, cut } = await openTarget(app, caller, req.id, me.id);
  const a = { id };
  const asked = <T extends { result: { id: string } }>(o: T): T => ({ ...o, result: { ...o.result, id: req.id } });
  const done = (moveId: string): OpenOut => ({ result: { id: a.id, class: "open", status: "done", move_id: moveId, accepted: acceptedView([]), confirmation: "agent_relayed" }, text: "The record is already in the open class" });
  const running = (moveId: string, rules: string[] | null): OpenOut => ({ result: { id: a.id, class: "open", status: "in_progress", move_id: moveId, accepted: acceptedView(rules), confirmation: "agent_relayed" },
                                                                          text: "The move to the open class is already in progress. This key can read the record in a few seconds" });
  const deny = async (gate: ByWordGate): Promise<never> => {
    await audit(app, caller, { event_type: "open", class: loc.class, record_ids: [a.id], space_id: loc.space_id, details: { op: "open_word_denied", via: caller.transport ?? "mcp", tool: "memory_open", gate } });
    throw byWordForbidden(app, a.id, gate);
  };
  if (loc.class === "open") {
    const last = (await app.db.control.query("SELECT id, status, to_class, accepted_rules FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [a.id])).rows[0];
    if (last && ["pending", "copying", "verifying"].includes(last.status)) { if (last.to_class !== "open") throw openBusy(true); return asked(running(last.id, last.accepted_rules ?? null)); }
    return asked(done(last?.id ?? NIL));
  }
  // the workplace gate: outside one's own personal space an agent does not open by word and
  // learns no findings — before the check settings, marks, trace and tree; the check does not run (no "probe"). The link —
  // to the "Make available to agents" panel: only the author in the workplace can show it
  const home = (await app.db.control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [loc.space_id])).rows[0];
  if (home?.kind !== "personal" || home.owner_id !== me.id) return deny("workplace");
  if (cut) await refuseCutChain(app, caller, "open_word", loc, a.id);
  await app.settings.load(true).catch(() => undefined);
  if (!openCheckSettings(app.settings).enabled) return deny("disabled");
  if (!(await byWordTreeOk(app, a.id, loc.space_id, me.id))) return deny("space");
  const mark = parseOpenCheckMarkStrict(loc.open_check), marks = await rootMarks(app, a.id);
  if (!mark || !parseOpenCheckMarkStrict(marks.mark) || marks.accepted) return deny("marker");
  const notebook = (await app.db.control.query("SELECT notebook FROM people WHERE id = $1", [me.id])).rows[0]?.notebook;
  if (notebook === false) return deny("notebook");
  if (!openableByWord(mark)) {
    const never = mark.findings.filter((f) => !ruleOpenableByWord(f.rule));
    const findings = (never.length ? never : mark.findings) as OpenCheckFinding[];
    // a PDF without text (`unchecked: empty_text`) or with scans of some pages (`partial_text`) — the mark may come
    // without findings: the reason in words, not an empty "looks like". Findings that open by word next to scans —
    // are not the refusal reason: then the whole reason, with "scans"
    const why = never.length || (findings.length && !mark.unchecked) ? `appears to contain ${openCheckReasons(findings)}` : openCheckWhy(mark);
    const unchecked = mark.unchecked ? { unchecked: mark.unchecked } : {};
    await audit(app, caller, { event_type: "write", class: "closed", record_ids: [a.id], space_id: loc.space_id,
                               details: { op: "open_check_refused", via: "open_word", kinds: mark.kinds, rules: mark.rules, never_by_word: true, ...unchecked } });
    // scans of some pages without anything unopenable: the agent does not open by word, but the author can show the recognized
    // text with a button in the workplace — not "remove it and write it again" (a repeat would return the same document)
    const hint = scansShowableByAuthor(mark)
      ? `${SCANS_SHOWABLE_ADVICE}: ${showAnywayWhere(a.id, workplaceUrl(app, showAnywayPath(a.id)))}`
      : "Remove this and save the record again. Agents cannot make secrets, clients on the strict NDA list, information blocked by the administrator’s custom rules or a document without extracted text available";
    throw new MemoryError("open_check", `This record cannot be made open even with your confirmation: ${why}`,
      { hint, details: { open_check: { via: "open_word", findings, never_by_word: true, ...unchecked } } });
  }
  const accepted = [...new Set(mark.rules)];
  // the tree check with fresh settings (settings.load above) — BEFORE taking the lock: rules are slow, the move holds the lock
  const tree = await treeTexts(app, "closed", a.id, { live: false });
  await guardOpenWord(app, caller, { texts: tree.texts, spaceId: loc.space_id, recordId: a.id, unchecked: tree.unchecked, accepted, workplaceUrl: workplaceUrl(app, showAnywayPath(a.id)) });
  const started = await startOpenMove(app, { id: a.id, ownerId: me.id, spaceId: loc.space_id, accepted, confirmation: "agent_relayed", via: "agent_relayed" }, running);
  if (started.early) return asked(started.early);
  if (started.denied) {
    await audit(app, caller, { event_type: "open", class: loc.class, record_ids: [a.id], details: { op: "open", via: caller.transport ?? "mcp", tool: "memory_open", denied: "never_open" } });
    throw neverOpen(started.denied!);
  }
  const moveId = started.moveId!;
  await app.queue.kick({ instance: app.instanceId, class: "closed", record_id: a.id, lane: "now" });
  const view = acceptedView(accepted);
  const derived = await isRetelling(app, caller, loc.class, a.id);
  await audit(app, caller, { event_type: "open", class: "closed", record_ids: [a.id], space_id: loc.space_id,
                             details: { op: "open", via: caller.transport ?? "mcp", tool: "memory_open", move_id: moveId, confirmation: "agent_relayed", accepted_rules: view.rules, kinds: view.kinds,
                                        ...(derived ? { derived: true } : {}) } });
  return { result: { id: req.id, class: "open" as const, status: "in_progress" as const, move_id: moveId, accepted: view, confirmation: "agent_relayed" as const },
           text: `Moving the record to the open class with the person’s confirmation. Accepted: ${view.reasons.join(", ")} (${BY_WORD_SCOPE}). This key can read the record in a few seconds. `
             + `The memory will check it again with the latest settings and may refuse. The person will see any refusal in “My actions”. You cannot take back what agents already read. To close it again, use memory_close` };
}

/**
 * The closeMove outcome: a move started (`affected` — tree rows in the open database, counted before the worker is woken;
 * `recordId` — the chain head it started on), a closing already running, the record already closed, the record busy with another
 * action (retry later).
 */
export type CloseMoveOut = { moveId: string; affected: number; recordId: string } | { running: string } | { already: string } | { busy: true };

/**
 * Ordering a record's closing (taken out of close): under the record lock — an open → closed move in class_moves with
 * `via` (person by default; despite_rollback — the administrator hid what was shown despite a finding), then the rows in the open
 * database are hidden (hidden_at) and the worker is woken. A move into a team, deletion, "Open" and conversion take the lock too:
 * "closing already running" — only if the last move is a closing and it is running; an opening is running or another action holds
 * the lock — `busy` (as for "Open"). The caller checks the rights. Read after the lock transaction ends —
 * the control connection is already back in the pool. `scope` — the caller's scope (a person closes with own scope, as before);
 * without it — the system one (an administrator's rollback). Tree rows are counted before the worker is woken: a fast worker
 * managed to move the record before the count, and the answer named one row instead of the tree.
 *
 * An earlier version of one's own note is closed from the chain HEAD, whoever calls: an administrator's
 * rollback took the id from the move history as is — an earlier version with its old showing and the head with its new one
 * gave two requests for one tree under different locks, and two worker moves could erase each other's only hidden
 * copy. Under the head lock a running move of ANY chain version is the same "closing already running" or "busy": requests
 * started on an earlier version before (before the fix, restoring from the trash) get no second move.
 * `recordId` in the answer is the head: the closing, the event and the worker wake-up go by it.
 *
 * The head and the chain members are reread UNDER the lock: between reading the head and taking the lock the author could
 * correct the note — a new version B became the head, and a request on the earlier A under lock A and a move check over the stale
 * members {A} let through B's closing, started meanwhile under lock B — two moves of one tree. The head under the lock
 * differs — a try with the new head (up to CLOSE_HEAD_TRIES times, then "busy"); running moves are sought by the fresh members.
 * Under the head lock no new version appears: an own_note correction takes the same record:<head> lock (corrections.ts,
 * withOwnerLocks) and edits only the current version — so the recheck is enough, no lock on the whole chain is needed.
 *
 * `expect` — the locator the caller checked rights by before the lock (a person's "Hide from agents" and memory_close: the author
 * or the space owner, ownedLocator). Under the lock it is checked against the locator and the record row (as in trashRecord
 * and startOpenMove): the custodian job changes a meeting's organizer under the same
 * record:<id> lock — in a project or team without a home change, in two transactions (the records DB commits first). The owner,
 * home or deletion diverged, or the row is with another while the locator is old (the tail) — in_progress, no request, the rows
 * are not hidden: a repeat rechecks the rights by a fresh locator (to the former custodian — not_found). The admin's rollback
 * (`despite_rollback`) and the closing on restore from the trash pass no `expect` — a service mode, the rights there
 * are checked otherwise.
 */
const CLOSE_HEAD_TRIES = 3;

/**
 * The closing rights checked before the lock (`loc0`) are still the same under the record:<head> lock. No locator or the record
 * is deleted — not_found (a repeat would answer so too). Another owner or home in the locator — in_progress. The records DB row
 * with another owner or in another home while the locator is the old one (the tail of an organizer change or a failed move) —
 * in_progress: a pass aligns the locator. The row is read with the system scope, as in startOpenMove: the caller's scope must not
 * hide it. control — only through the held q.
 */
async function closeRightsUnchanged(app: App, q: Pick<pg.PoolClient, "query">, loc0: Locator): Promise<void> {
  const cur = (await q.query("SELECT class, space_id, owner_id, deleted FROM record_locations WHERE record_id = $1", [loc0.record_id])).rows[0] as
    { class: DataClass; space_id: string; owner_id: string; deleted: boolean } | undefined;
  if (!cur || cur.deleted) throw notFound();
  if (cur.owner_id !== loc0.owner_id || cur.space_id !== loc0.space_id) throw inProgress(10);
  const row = (await app.db.recordsForWrite(cur.class, "system").query("SELECT owner_id, space_id FROM records WHERE id = $1", [loc0.record_id])).rows[0] as
    { owner_id: string; space_id: string } | undefined;
  if (row && (row.owner_id !== cur.owner_id || row.space_id !== cur.space_id)) throw inProgress(10);
}

export async function closeMove(app: App, a: { recordId: string; requestedBy: string; via?: string | null; scope?: Caller["scope"]; expect?: Locator }): Promise<CloseMoveOut> {
  const db = app.db.recordsForWrite("open", a.scope ?? "system");
  const headOf = async (id: string) => ((await db.query(CHAIN_HEAD, [id])).rows[0]?.id as string | undefined) ?? id;
  // chain versions (and their derived ones): class moves start only on roots, but a request past the head is possible
  const chainOf = (head: string) => db.query(`${TREE} SELECT id FROM tree`, [head]).then((r) => r.rows.map((x) => x.id as string), () => [head]);
  const inChain = (q: Pick<pg.Pool, "query">, head: string, chain: string[]) => q.query(
    `SELECT id, status, to_class FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [[...new Set([head, ...chain])]]).then((r) => r.rows[0] as { id: string; to_class: string } | undefined);
  type Attempt = CloseMoveOut | { moved: string };
  let recordId = await headOf(a.recordId);
  let started: Attempt = { busy: true };
  for (let i = 0; i < CLOSE_HEAD_TRIES; i++) {
    const head = recordId, chain = await chainOf(head);
    started = await underRecordLock<Attempt>(app, head, async () => {
      // "busy" — by the members read before the lock: here only the "running or busy" answer, no request
      const cur = await inChain(app.db.control, head, chain);
      return cur && cur.to_class === "closed" ? { running: cur.id } : { busy: true };
    }, async (q) => {
      const fresh = await headOf(head);
      if (fresh !== head) return { moved: fresh };
      const now = (await q.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [head])).rows[0];
      if (!now || now.deleted) throw notFound();
      // the caller's rights — by the locator read before the lock; before the request and before hiding the rows
      if (a.expect) await closeRightsUnchanged(app, q, a.expect);
      const busy = await inChain(q, head, await chainOf(head));
      if (busy) return busy.to_class === "closed" ? { running: busy.id } : { busy: true };   // an opening runs — close after it
      if (now.class === "closed") {                                                          // the repeat is idempotent
        const last = (await q.query("SELECT id FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [head])).rows[0];
        return { already: (last?.id as string | undefined) ?? NIL };
      }
      const moveId = newId();
      await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,$4)", [moveId, head, a.requestedBy, a.via ?? "person"]);
      return { moveId, affected: 1, recordId: head };
    });
    if (!("moved" in started)) break;
    recordId = started.moved;
    started = { busy: true };   // tries used up and the head keeps changing — "busy", retry later
  }
  if (!("moveId" in started)) return started as CloseMoveOut;
  // the move started — the rows are hidden at once, without waiting for the worker (it hides them itself if this failed)
  await tx(db, async (q) => {
    // Match the worker's source order: stages lock parents before their derived rows, then UUID within a generation.
    await q.query(`${TREE}, lock_order AS (
      SELECT id, ARRAY[id] AS path FROM chain
      UNION ALL SELECT r.id, p.path || r.id FROM records r JOIN lock_order p ON r.parent_id = p.id
        WHERE NOT r.id = ANY(p.path)
    ) SELECT r.id FROM records r JOIN lock_order p ON p.id = r.id
      ORDER BY cardinality(p.path), r.id FOR UPDATE OF r`, [recordId]);
    await q.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [recordId]);
  })
    .catch((e) => log.warn("close_hide_deferred", { record_id: recordId, error: (e as Error).message.slice(0, 120) }));
  const affected: number = await db.query(`${TREE} SELECT count(*)::int AS n FROM tree`, [recordId]).then((r) => Math.max(1, r.rows[0]?.n ?? 1), () => 1);
  await app.queue.kick({ instance: app.instanceId, class: "open", record_id: recordId, lane: "now" });
  return { moveId: started.moveId, affected, recordId };
}

/**
 * Close: bring an open record with its derived ones back into the closed class. The author
 * and the record's space owner close it — an agent (memory_close) or a workplace button. First the open database rows are hidden
 * (hidden_at) — search and reading stop giving them at once, then the worker moves the tree by the same mechanism as
 * opening, with the original file into closed storage. Closing does not recall what agents have already read.
 */
export async function close(app: App, caller: Caller, req: { id: string }) {
  // "Close" narrows the reader circle — allowed in an archive too, for the author and the archive owner: the map with the archive
  const me = requirePerson(caller), spaces = await readableSpaces(app, caller, { archived: true });
  const loc = await ownedLocator(app, caller, req.id, spaces);
  if (loc.deleted) throw notFound();
  // the colleagues' copy is not closed alone; hiding the profile from agents — first remove the copy (under the profile lock)
  const profileKind = await workProfileKindOf(app, loc);
  if (profileKind === "copy") throw copyRefusal();
  if (profileKind === "personal") return withProfileUnpublished(app, caller, loc.owner_id, "profile_hidden", () => closeLocated(app, caller, me, req, loc));
  return closeLocated(app, caller, me, req, loc);
}

async function closeLocated(app: App, caller: Caller, me: { id: string }, req: { id: string }, loc: Locator) {
  const a = { id: await chainHeadOf(app, caller, loc, req.id) };   // an earlier version of own note — the whole chain closes
  await derivedAlone(app, caller, loc, a.id, "closed");
  type CloseOut = { result: { id: string; class: "closed"; status: "done" | "in_progress"; move_id: string; affected?: number }; text: string };
  const running = (moveId: string): CloseOut => ({ result: { id: req.id, class: "closed", status: "in_progress", move_id: moveId }, text: "Closing is already in progress. Agents can no longer find the record. Moving it to the closed database will take a few seconds" });
  // the worker rolls back a failed closing (rows visible again) — the answer "agents do not find the record" would be a lie under
  // another's lock: retry later
  // the rights were checked by loc before the lock — closeMove rechecks it under the lock
  const started = await closeMove(app, { recordId: a.id, requestedBy: me.id, scope: caller.scope, expect: loc });
  if ("busy" in started) throw inProgress(10);
  if ("running" in started) return running(started.running);
  if ("already" in started) return { result: { id: req.id, class: "closed" as const, status: "done" as const, move_id: started.already }, text: "The record is already in the closed class" };
  const { moveId, affected } = started;
  await audit(app, caller, { event_type: "class_move", class: "open", record_ids: [a.id], space_id: loc.space_id,
                             details: { op: "close", move_id: moveId, affected, by: loc.owner_id === me.id ? "author" : "space_owner",
                                        ...(loc.owner_id !== me.id ? { author: loc.owner_id } : {}) } });
  return { result: { id: req.id, class: "closed", status: "in_progress" as const, move_id: moveId, affected },
           text: `Closing has started. Agents can no longer find the record${affected > 1 ? ` and its derived records or earlier versions (${affected - 1})` : ""}, and moving it to the closed database will take a few seconds. Agents may have kept a copy if they already read it. Closing prevents future access. Only a person in the workspace can show the record to agents again: ${workplaceWhere(app, `/records/${req.id}`, "Record")}` };
}

/** The trash term in days (access.trash_days): an integer from 1, 30 by default. */
export function trashDays(app: App): number {
  const n = Math.round(Number(app.settings.get("access.trash_days", 30)));
  return Number.isFinite(n) && n >= 1 ? n : 30;
}

/**
 * Delete (the former name memory_forget is a hidden synonym): the record and its derived ones go into the trash in one
 * batch (deleted_batch = the deleted record's id) for access.trash_days days. The author and the space owner delete — they are
 * equal. "Delete forever" (immediately in the synonym) — only a person in the workplace: an agent is refused
 * BEFORE deleting, with a link to the trash. The records DB is written before the locator — the reconciler aligns the locator.
 */
export async function deleteRecord(app: App, caller: Caller, a: { id: string; immediately?: boolean }, tool = "memory_delete") {
  // deleting is allowed in an archive too — to the author and the archived space's owner: the map with the archive
  const me = requirePerson(caller), spaces = await readableSpaces(app, caller, { archived: true });
  if (a.immediately) await requireHuman(app, caller, "Delete permanently");
  // the curator's "Delete record" on the page of another's org record: the same as "Delete" in "Common knowledge review" — first
  // a return to where it came from, then the trash there; the curator's agent — a refusal with a link (ownedLocator)
  const pre = await locate(app, a.id);
  if (pre && !pre.deleted && pre.owner_id !== me.id && spaces.get(pre.space_id)?.kind === "org" && isOrgCurator(caller, spaces) && isHumanSession(caller) && !a.immediately)
    return curatorDeleteFromRecord(app, caller, a.id, tool);
  const loc0 = await ownedLocator(app, caller, a.id, spaces);
  const days = trashDays(app);
  // an earlier version of one's own note — the whole chain goes to the trash in one batch of the head (mark_deleted_chain)
  const head = loc0.deleted ? a.id : await chainHeadOf(app, caller, loc0, a.id);
  // the colleagues' copy is not deleted alone; deleting the personal profile — first remove the copy (under the profile lock)
  const profileKind = loc0.deleted ? null : await workProfileKindOf(app, loc0);
  if (profileKind === "copy") throw copyRefusal();
  // a handed-over meeting of a departed person whose records are kept is never deleted forever — 409 purge_held before any change
  if (a.immediately) await refusePurgeHeld(app, loc0.class, head);
  const trash = () => trashRecord(app, caller.scope, loc0, head, me.id, days, a.immediately === true);
  const { out, loc } = profileKind === "personal" ? await withProfileUnpublished(app, caller, loc0.owner_id, "profile_public_off", trash) : await trash();
  if (a.immediately) await app.queue.kick({ instance: app.instanceId, class: loc.class, record_id: head, lane: "now" });
  const affected = out.ids.length;   // the batch size, not newly marked ones: a repeat — the same answer (outputSchema: minimum 1)
  await audit(app, caller, { event_type: "forget", class: loc.class, record_ids: out.ids, space_id: loc.space_id,
                             details: { tool, action: a.immediately ? "purge_now" : "delete", batch: out.row.deleted_batch ?? a.id, affected, trash_days: days,
                                        ...(loc.owner_id !== me.id ? { author: loc.owner_id } : {}) } });   // to the author — in "My actions"
  const trashUrl = workplaceUrl(app, "/trash");
  const result = { id: a.id, deleted_at: new Date(out.row.deleted_at).toISOString(), purge_after: new Date(out.row.purge_after).toISOString(), affected, ...(trashUrl ? { trash_url: trashUrl } : {}) };
  if (a.immediately) return { result, text: `The record was permanently deleted. The next cleanup job will remove it, and it cannot be restored. Records affected: ${affected}` };
  // a meeting event: deleting it does not stop a re-extraction from bringing it back
  const meetingEvent = loc.type === "event" && ["pipeline", "correction"].includes(
    (await app.db.recordsForWrite(loc.class, caller.scope).query("SELECT source_kind::text AS k FROM records WHERE id = $1", [a.id])).rows[0]?.k ?? "");
  const reextract = meetingEvent ? " This is a meeting event. If it was extracted incorrectly, correct it with memory_correct (wrong or outdated). Otherwise, extracting the meeting again will bring it back." : "";
  // a held handed-over meeting of a departed person: it has no purge term while the former organizer's records are kept
  if (await isHeldTransfer(app, loc.class, head))
    return { result, text: `The record was deleted and can no longer be found. Records affected: ${affected}. It is ${HELD_TRANSFER_TEXTS.deleted}. A person can restore it in the workspace: ${workplaceWhere(app, "/trash", "Trash")}` };
  return { result, text: `The record was deleted and can no longer be found. Records affected: ${affected}. It stays in Trash until ${result.purge_after.slice(0, 10)} (retention is ${days} days), then it and the original are removed permanently. A person can restore or permanently delete it in the workspace: ${workplaceWhere(app, "/trash", "Trash")}${reextract}` };
}

/** The trash after the curator's return (orgDelete): the whole version chain in one batch of the head, for the curator. */
export const orgTrash = (app: App, caller: Caller, id: string) => async (loc: Locator): Promise<{ ids: string[]; deleted_at: Date; purge_after: Date }> => {
  const me = requirePerson(caller);
  const head = await chainHeadOf(app, caller, loc, id);
  const { out } = await trashRecord(app, caller.scope, loc, head, me.id, trashDays(app));
  return { ids: out.ids, deleted_at: out.row.deleted_at, purge_after: out.row.purge_after };
};

/**
 * The curator's deletion of another's org record from the record page (a session): the answer — in the memory_delete form.
 * The curator here is never the author (deleteRecord), so the source space is not named: "returned to the author —
 * to where it came from", as "Delete" in "Common knowledge review" (deleteReview).
 */
async function curatorDeleteFromRecord(app: App, caller: Caller, id: string, tool: string) {
  const days = trashDays(app);
  const d = await orgDelete(app, caller, id, orgTrash(app, caller, id));
  if (!d.trash) {
    const result = { id, deleted_at: new Date().toISOString(), purge_after: new Date().toISOString(), affected: 1 };
    return { result, text: `The record was returned to the author at its original location, but could not be deleted there (${tool}). The author or the owner of that space can delete it.` };
  }
  const trashUrl = workplaceUrl(app, "/trash");
  const result = { id, deleted_at: new Date(d.trash.deleted_at).toISOString(), purge_after: new Date(d.trash.purge_after).toISOString(), affected: Math.max(1, d.trash.ids.length), ...(trashUrl ? { trash_url: trashUrl } : {}) };
  return { result, text: d.author_dismissed
    ? `The record was moved from “Company knowledge” to Trash. The author no longer works here and the record had nowhere to return to. It stays in Trash until ${result.purge_after.slice(0, 10)}.`
    : `The record was returned to the author at its original location and immediately moved to Trash there until ${result.purge_after.slice(0, 10)} (${days} days in Trash). The author can restore it to its original location outside “Company knowledge”.` };
}

/**
 * A record with its derived ones — into the trash in one batch (the caller checked the rights: the author or the space owner —
 * deleteRecord, the administrator at a participant's request; `by` — who deleted, null for the panel administrator).
 * Under the record lock: while the worker moves the record between classes, the deletion waits; the class is reread under
 * the lock — a move could end between the rights check and taking the lock.
 */
export async function trashRecord(app: App, scope: Caller["scope"], loc0: Locator, id: string, by: string | null, days = trashDays(app), immediately = false) {
  const a = { id, immediately };
  return underRecordLock(app, a.id, () => { throw inProgress(60); }, async (q) => {
    const locs = (await q.query("SELECT record_id, class, space_id, owner_id, deleted FROM record_locations WHERE record_id = ANY($1::uuid[])", [[a.id, loc0.record_id]])).rows;
    const cur = locs.find((l) => l.record_id === a.id), checked = locs.find((l) => l.record_id === loc0.record_id);
    // rights were checked by loc0 before the lock — the record may have moved or returned to the author's personal meanwhile (or
    // a move failed between the records DB and control: the home in the row, rights by the locator). Place, owner or deletion
    // diverged — in_progress: a repeat passes the rights check anew by a fresh locator. The class is taken fresh, as before
    // (a class move does not change rights)
    if (checked && (checked.space_id !== loc0.space_id || checked.owner_id !== loc0.owner_id || checked.deleted !== loc0.deleted)) throw inProgress(10);
    const loc = { ...loc0, class: (cur?.class ?? loc0.class) as typeof loc0.class };
    const db = app.db.recordsForWrite(loc.class, scope);
    if (checked) {
      // and the row (as in promote): the custodian job changes a meeting's organizer in a project or team
      // without a home change, in two transactions — the records DB commits first. The tail where the row is with the returned
      // organizer, the locator still with the former custodian — in_progress too: else they would delete (even "forever")
      // a meeting no longer theirs by a stale locator. A pass aligns the locator, a repeat with a fresh ownedLocator — not_found
      const row = (await app.db.recordsForWrite(checked.class, scope).query("SELECT space_id, owner_id FROM records WHERE id = $1", [loc0.record_id])).rows[0] as
        { space_id: string; owner_id: string } | undefined;
      if (row && (row.space_id !== checked.space_id || row.owner_id !== checked.owner_id)) throw inProgress(10);
    }
    const out = await tx(db, async (c) => {
      // the tree and the version chain of own note: the existing mark_deleted does not change, a new function takes the chain
      await c.query("SELECT mark_deleted_chain($1, $2, make_interval(days => $3::int)) AS n", [a.id, by, days]);
      // "forever" — the record and its derived ones (the tree), even if the record is already in the trash in the parent's batch
      const tree = a.immediately ? (await c.query(`${TREE} UPDATE records SET purge_after = now() WHERE id IN (SELECT id FROM tree) AND deleted_at IS NOT NULL RETURNING id`, [a.id])).rows.map((r) => r.id as string) : [];
      const row = (await c.query("SELECT deleted_at, purge_after, deleted_batch FROM records WHERE id = $1", [a.id])).rows[0];
      if (!row) return null;
      // a repeat on an already deleted record — the same batch and answer; one deleted before the trash (no batch) — alone
      const batch = row.deleted_batch ? (await c.query("SELECT id FROM records WHERE deleted_batch = $1", [row.deleted_batch])).rows.map((r) => r.id as string) : [a.id];
      return { row, ids: [...new Set([...batch, ...tree])] };
    });
    if (!out) throw notFound();
    await syncDeletionMarks(q, db, out.ids);
    return { out, loc };
  });
}

// ---------------------------------------------------------------- trash
// A trash item is a deletion batch: the root (deleted_batch = id) and all that went with it in one action. The record author
// and its space owner see it; the list is built from locators — a personal key (T2) does not read the closed database, the titles
// of closed records are not given to it.

/** A trash batch root the caller may see: the author or the space owner (an archived one too). Otherwise not_found. */
export async function trashRoot(app: App, caller: Caller, id: string): Promise<{ class: "open" | "closed"; space_id: string; owner_id: string; deleted_at: Date | null; deleted_by: string | null; org: boolean;
  held: boolean }> {
  const me = requirePerson(caller), spaces = await readableSpaces(app, caller, { archived: true });
  const l = (await app.db.control.query(
    "SELECT class, space_id, owner_id, deleted_at, deleted_by, purge_after > now() AS live FROM record_locations WHERE record_id = $1 AND deleted AND deleted_batch = record_id", [id])).rows[0];
  if (!l || (l.owner_id !== me.id && spaces.get(l.space_id)?.role !== "owner")) throw notFound();
  // a held handed-over meeting of a departed person: "Delete forever" is not allowed, and after the term it is still in the trash
  const held = await isHeldTransfer(app, l.class, id);
  if (l.live !== true && !held) throw notFound();
  const { live: _live, ...row } = l;
  return { ...row, org: spaces.get(l.space_id)?.kind === "org", held };
}

export async function trashList(app: App, caller: Caller, q: { limit: number; offset: number }) {
  const me = requirePerson(caller), spaces = await readableSpaces(app, caller, { archived: true });
  const owned = [...spaces.values()].filter((s) => s.role === "owner").map((s) => s.id);
  // held handed-over meetings of departed people — in the list after the trash term too, without a term or "Delete forever"
  const origins = await heldOriginsNow(app);
  const expired = origins.length ? (await app.db.control.query(
    `SELECT record_id AS id, class FROM record_locations WHERE deleted AND deleted_batch = record_id AND (owner_id = $1 OR space_id = ANY($2::uuid[]))`,
    [me.id, owned])).rows as Array<{ id: string; class: "open" | "closed" }> : [];
  const held = await heldTrashIds(app, expired, origins);
  // archive: an item of an archived space is restored only if deleted after archiving (undoing an action)
  const { rows } = await app.db.control.query(
    `SELECT l.record_id AS id, l.class, l.type, l.owner_id, l.created_at, l.deleted_at, l.deleted_by, l.purge_after,
            s.slug, s.name AS space_name, s.kind AS space_kind,
            (s.archived_at IS NOT NULL AND s.kind IN ('team','project')) AS space_archived,
            ((s.archived_at IS NULL OR s.kind NOT IN ('team','project') OR l.deleted_at > s.archived_at)
             AND (s.kind <> 'org' OR (l.owner_id = $1 AND l.deleted_by IS NOT DISTINCT FROM l.owner_id))) AS restorable, o.login AS owner_login, o.display_name AS owner_name, d.login AS by_login, d.display_name AS by_name,
            (d.id IS NOT NULL AND ((s.owner_id = d.id AND s.org_unit_id IS NULL) OR EXISTS (SELECT 1 FROM space_members_effective m WHERE m.space_id = s.id AND m.person_id = d.id AND m.role = 'owner'))) AS by_space_owner,
            (SELECT count(*)::int FROM record_locations x WHERE x.deleted AND x.deleted_batch = l.record_id) AS affected,
            (SELECT jsonb_object_agg(z.type, z.n) FROM (SELECT x.type, count(*)::int AS n FROM record_locations x
               WHERE x.deleted AND x.deleted_batch = l.record_id AND x.record_id <> l.record_id GROUP BY x.type) z) AS derived,
            (l.deleted_by IS NULL AND EXISTS (SELECT 1 FROM deletion_requests q WHERE q.record_id = l.record_id AND q.instance_id = $3)) AS by_request,
            round(extract(epoch FROM (l.purge_after - l.deleted_at)) / 86400)::int AS kept_days
     FROM record_locations l JOIN spaces s ON s.id = l.space_id AND s.instance_id = $3 JOIN people o ON o.id = l.owner_id LEFT JOIN people d ON d.id = l.deleted_by
     WHERE l.deleted AND l.deleted_batch = l.record_id AND (l.purge_after > now() OR l.record_id = ANY($6::uuid[])) AND (l.owner_id = $1 OR l.space_id = ANY($2::uuid[]))
     ORDER BY l.deleted_at DESC, l.record_id LIMIT $4 OFFSET $5`, [me.id, owned, app.instanceId, q.limit + 1, q.offset, [...held]]);
  const page = rows.slice(0, q.limit);
  // titles: only to a key the class is available to — the builder's gate: to an extended key in closed — its own ones
  // the event kind (decision, task…) — by the same gate as the title: the others get only the record type
  const titles = new Map<string, string | null>(), kinds = new Map<string, string | null>(), gate = gateOf(caller);
  for (const cls of ["open", "closed"] as const) {
    const ids = page.filter((r) => r.class === cls && gateAllows(gate[cls], r.owner_id as string, me.id)).map((r) => r.id as string);
    if (!ids.length) continue;
    for (const t of (await app.db.records(cls, caller.scope).query("SELECT id, title, event_kind FROM records WHERE id = ANY($1::uuid[])", [ids])).rows) {
      titles.set(t.id, t.title ?? null);
      kinds.set(t.id, t.event_kind ?? null);
    }
  }
  // titles of closed ones are a read of closed: the event before the answer; a log failure — the list is not given
  await auditShownClosed(app, caller, page.filter((r) => r.class === "closed" && titles.get(r.id) != null).map((r) => r.id as string), "trash");
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    items: page.map((r) => ({
      id: r.id, type: r.type, class: r.class, title: titles.get(r.id) ?? null, event_kind: kinds.get(r.id) ?? null,
      space: { slug: r.slug, name: r.space_name, kind: r.space_kind, archived: r.space_archived === true },
      owner: { login: r.owner_login, display_name: r.owner_name }, author_is_me: r.owner_id === me.id,
      created_at: iso(r.created_at), deleted_at: iso(r.deleted_at), purge_after: held.has(r.id) ? null : iso(r.purge_after),
      // a handed-over meeting of a departed person: kept while their records are kept; "Delete forever" — 409 purge_held
      ...(held.has(r.id) ? { held: "transferred_meeting" as const } : {}),
      deleted_by: r.by_login ? { login: r.by_login, display_name: r.by_name } : null,
      // who deleted when not a person: the administrator at a meeting participant's request (deletion_requests)
      // or a service job (test cleanup, a departed person's personal space — a shorter term, kept_days)
      deleted_reason: r.deleted_by ? null : r.by_request === true ? "deletion_request" as const : "automatic" as const,
      deleted_by_me: r.deleted_by === me.id, deleted_by_space_owner: Boolean(r.by_space_owner) && r.deleted_by !== r.owner_id,
      affected: Math.max(1, r.affected as number),
      // what went with the record — by kind (summaries, decisions…), without titles: the same locators as affected
      derived: (r.derived ?? {}) as Record<string, number>,
      kept_days: Math.max(0, Number(r.kept_days ?? 0)),
      restorable: r.restorable === true,
    })),
    next_cursor: rows.length > q.limit ? String(q.offset + q.limit) : null,
    // the trash term from the settings — for the "deleted items are kept N days" line and a note if an item's term is shorter
    trash_days: trashDays(app),
  };
}

/**
 * Restore exactly the batch: the record and what went with it in one deletion. A derived one before its parent — not allowed.
 *
 * Shown to agents "not only to you" while showing is off in teams and projects: "Hide
 * what was shown" does not close a deleted one (it cannot be closed), and a restore brought such a record back open — the agents
 * of members read it again, though the admin turned showing off and rolled it back. A restore is in effect a new showing, and new
 * showings are banned by the switch: a batch whose record's last non-failed move is a showing with the shared scope comes back
 * HIDDEN (hidden_at is set in the transaction that lifts the deletion mark — agents never see it, even briefly), and under the
 * same lock a closing starts on the author's behalf (`via: despite_rollback`, as for a rollback; in the author's "My actions" —
 * `close_rollback`). The worker moves the batch into the closed database. Shown "only to you" and showing on — as before.
 *
 * The "How we work" map: a batch with a current map version while another live map of the same space exists — `400
 * space_guide_exists` (underGuideRestore): one current map per space.
 */
export async function restoreFromTrash(app: App, caller: Caller, id: string) {
  await requireHuman(app, caller, "Restore from Trash");
  const root = await trashRoot(app, caller, id);
  // into "Company common knowledge" only the author restores from the trash what they deleted themselves. What was deleted
  // by the curator lies in the trash where the record came from; what a non-author deleted in org (earlier, the admin on request)
  // is not restored back into org — otherwise the trash would bypass the curators' review
  if (root.org && (root.owner_id !== caller.person!.id || root.deleted_by !== root.owner_id))
    throw new MemoryError("forbidden", "Only the author can restore a record they deleted to “Company knowledge”. Someone else deleted this record, so it cannot be restored there. The author can save it again for curator review",
      { details: { reason: "org_restore" } });
  // Archive: into an archived space only what was deleted after archiving is restored — undoing an agent's action;
  // one deleted earlier would bring into the archive a live record that was not there
  const arch = await spaceArchived(app, root.space_id);
  if (arch && !(root.deleted_at && new Date(root.deleted_at) > arch.archived_at)) {
    const day = arch.archived_at.toISOString().slice(0, 10);
    throw archivedDenied(arch.slug, arch.archived_at, `The space ${arch.slug} was archived on ${day}, after this record was deleted. The record cannot be restored to an archived space. The space owner or memory administrator must restore the space first.`);
  }
  // a personal profile from the trash does not stand next to a new one — a person has one current profile version
  const rootType = (await app.db.control.query("SELECT type FROM record_locations WHERE record_id = $1", [id])).rows[0]?.type as string | undefined;
  if (rootType === "profile" && await workProfileKindOf(app, { record_id: id, class: root.class, type: "profile" }) === "personal"
      && await currentProfileRef(app, root.owner_id, root.space_id))
    throw invalid("You already have a new work profile. To restore the old one, delete the new one first",
                  { reason: "profile_exists" });
  // the switches — fresh ones (the administrator could have turned showing off a minute ago), only for an open batch
  let showOff = false;
  if (root.class === "open") {
    await app.settings.load(true).catch(() => undefined);
    const ds = despiteSettings(app.settings);
    showOff = !(ds.enabled && ds.projects);
  }
  // the "How we work" map: with another live map of the space the batch is not restored — one current map
  return underGuideRestore(app, root.class, id, () => restoreBatch(app, caller, id, root, showOff));
}

/** Restoring a batch after the restoreFromTrash checks: under the record lock, then processing and the log. */
async function restoreBatch(app: App, caller: Caller, id: string, root: { class: "open" | "closed"; space_id: string; owner_id: string; held?: boolean }, showOff: boolean) {
  const db = app.db.recordsForWrite(root.class, caller.scope);
  let reclosed: string | null = null;
  // how the restored record is closed (assigned inside the lock — an object, not variables: TS narrowing does not see them)
  // part — for a part of a live record the closing is started on its tree head (its id, author, space and tree rows)
  const closedBy: { recheck: string | null; handBack: boolean; part: { head: string; author: string; space: string; affected: number } | null } = { recheck: null, handBack: false, part: null };
  const holds = root.class === "open" && await recheckHoldsReady(app);
  const ids = await underRecordLock(app, id, () => { throw inProgress(60); }, async (q) => {
    let revoke = false;
    const moving = async () => !!(await q.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [id])).rowCount;
    // the open recheck: a record in the trash with a finding (an on_restore row; held and kept — the closing did not get through)
    // — is restored closed at once
    const hold = holds ? await onRestoreHold(q, app.instanceId, id, recheckExtraRules(app)) : null;
    // a part of a live record deleted on its own is closed only together with its tree head: the request,
    // mark and hold — on the head, its whole tree is hidden (restoreCloseHead; busy — 409 "retry")
    const target = hold ? await restoreCloseHead(app, q, id) : null;
    const closing = hold && !(await moving()) ? await restoreHeldClosed(q, app.instanceId, id, root.owner_id, hold, target) : null;
    // a meeting returned to a departed person's trash and shown despite a finding by someone else — closed at once too
    const returned = !closing && root.class === "open" && await returnedDespite(app, q, id, root.owner_id) && !(await moving())
      ? await closeReturned(q, id, root.owner_id) : null;
    const ids = await tx(db, async (c) => {
      // a held handed-over meeting is restored after the trash term too
      const r = (await c.query(`SELECT parent_id FROM records WHERE id = $1 AND deleted_batch = $1 AND deleted_at IS NOT NULL${root.held ? "" : " AND purge_after > now()"} FOR UPDATE`, [id])).rows[0];
      if (!r) throw notFound();
      if (r.parent_id && (await c.query("SELECT 1 FROM records WHERE id = $1 AND deleted_at IS NOT NULL", [r.parent_id])).rowCount)
        throw invalid("Restore the source record first. This derived record was deleted separately, and the source record is also in Trash");
      const back = (await c.query("UPDATE records SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, deleted_batch = NULL WHERE deleted_batch = $1 AND deleted_at IS NOT NULL RETURNING id", [id])).rows.map((x) => x.id as string);
      // shown "not only to you" while showing is off — the batch rows stay hidden until the move into closed
      // (the batch root's tree with its version chain is closed — the same the worker moves). The showing — the last non-failed
      // move of the whole batch, not of each version separately
      if (showOff && await lastMoveShownShared(q, back)) {
        revoke = true;
        await c.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [id]);
      }
      // a recheck finding: the rows stay hidden, the mark (with the move id) — in root attrs; control holds the closing request
      if (returned) {
        closedBy.handBack = true;
        await c.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [id]);
      }
      if (closing) {
        closedBy.recheck = hold!.why;
        await c.query(`${TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [closing.head]);
        await c.query("UPDATE records SET attrs = COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('open_check_fallback', $2::jsonb) WHERE id = $1", [closing.head, JSON.stringify(closing.mark)]);
        if (target) closedBy.part = { head: target.head, author: target.owner, space: target.space ?? root.space_id,
                                      affected: Number((await c.query(`${TREE} SELECT count(*)::int AS n FROM tree`, [target.head])).rows[0]?.n ?? back.length) };
      }
      // processing the trash stopped is finished: a stage "skipped" by the handler while the record lay
      // in the trash (formerly for good) and one waiting for restore (in_trash) — are queued again. A legitimate skip (an empty
      // transcript, the wrong type) becomes a skip again on retry without a model call; a skip by replacement with a new version
      // or by a person's correction (last_error superseded/suppressed) stays
      await c.query(
        `UPDATE record_stages s SET status = 'pending', attempts = 0, last_error = NULL, version = NULL, terminal = false, updated_at = now()
           FROM records r WHERE r.id = s.record_id AND r.id = ANY($1::uuid[]) AND r.is_current
            AND ((s.status = 'skipped' AND s.last_error IS NULL) OR (s.status = 'pending' AND COALESCE(s.last_error, '') LIKE 'in_trash:%'))`, [back]);
      return back;
    });
    await syncDeletionMarks(q, db, ids);
    // the closing — under the restore's lock: the class reconciler does not take the hidden rows for an abandoned closing
    // (they have a running move), the worker starts only once the lock is gone. A move is already running — no second one.
    // The records DB commits before control: if the gateway fell or control did not answer between the two COMMITs, the rows stay
    // hidden without a request, and the locator — "in the trash". The class reconciler finishes such a closing: the last
    // non-failed move is a "not only to you" showing and showing is off — it does not show the rows but starts the same closing
    if (closing) reclosed = closing.moveId;
    else if (returned) reclosed = returned;
    else if (revoke && !(await q.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [id])).rowCount) {
      reclosed = newId();
      await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'despite_rollback')", [reclosed, id, root.owner_id]);
    }
    return ids;
  });
  if (reclosed) {
    const part = closedBy.part;
    await app.queue.kick({ instance: app.instanceId, class: "open", record_id: part?.head ?? id, lane: "now" });
    // to the author — "hidden from agents by the administrator" (close_rollback): showing is off, the restored record closes.
    // A part of a live record: its tree head is closed — the event is about it, the restored part — in part
    await audit(app, caller, { event_type: "class_move", class: "open", record_ids: [part?.head ?? id], space_id: part?.space ?? root.space_id,
                               details: closedBy.recheck ? { op: "close", move_id: reclosed, affected: part?.affected ?? ids.length, via: "nda_recheck", why: closedBy.recheck, by: "auto",
                                                             author: part?.author ?? root.owner_id, on_restore: true, ...(part ? { part: id } : {}) }
                                      : closedBy.handBack ? { op: "close", move_id: reclosed, affected: ids.length, via: "organizer_transfer", by: "auto", author: root.owner_id, on_restore: true }
                                                 : { op: "close", move_id: reclosed, affected: ids.length, by: "admin_rollback", author: root.owner_id, on_restore: true } });
  }
  // wake the restored one's processing: the lane is night, and the scheduler itself puts a "process now" record into "now"
  // (a batch being closed — not: the closed class continues its processing after the move)
  const waiting = ids.length && !reclosed ? (await db.query("SELECT DISTINCT record_id FROM record_stages WHERE record_id = ANY($1::uuid[]) AND status = 'pending'", [ids])).rows.map((x) => x.record_id as string) : [];
  for (const rid of waiting) await app.queue.kick({ instance: app.instanceId, class: root.class, record_id: rid, lane: "night" });
  await audit(app, caller, { event_type: "forget", class: root.class, record_ids: ids, space_id: root.space_id, details: { action: "restore", batch: id, affected: ids.length, ...(reclosed ? { closed_on_restore: true } : {}) } });
  // where it returned: the record kind and the space — for the "The record is back in "Personal"" summary with "Open"
  const home = (await app.db.control.query("SELECT l.type, s.slug, s.name, s.kind FROM record_locations l JOIN spaces s ON s.id = l.space_id WHERE l.record_id = $1", [id])).rows[0];
  return { id, restored: ids.length, ...(home ? { type: home.type as string, space: { slug: home.slug as string, name: home.name as string, kind: home.kind as string } } : {}),
           ...(reclosed ? { closed_on_restore: true as const, ...(closedBy.recheck ? { closed_why: "nda_recheck" as const } : closedBy.handBack ? { closed_why: "organizer_transfer" as const } : {}) } : {}) };
}

/** Delete forever: the batch is purged by the next job (the original — by the same job), a purged tombstone. */
export async function purgeFromTrash(app: App, caller: Caller, id: string) {
  await requireHuman(app, caller, "Delete permanently");
  const root = await trashRoot(app, caller, id);
  // a handed-over meeting of a departed person whose records are kept — 409 purge_held, the item stays in the trash
  if (root.held) await refusePurgeHeld(app, root.class, id);
  const db = app.db.recordsForWrite(root.class, caller.scope);
  const ids = (await db.query("UPDATE records SET purge_after = now() WHERE deleted_batch = $1 AND deleted_at IS NOT NULL RETURNING id", [id])).rows.map((x) => x.id as string);
  if (!ids.length) throw notFound();
  await syncDeletionMarks(app.db.control, db, ids);
  await app.queue.kick({ instance: app.instanceId, class: root.class, record_id: id, lane: "now" });
  await audit(app, caller, { event_type: "forget", class: root.class, record_ids: ids, space_id: root.space_id, details: { action: "trash_purge", batch: id, affected: ids.length } });   // "delete forever" from the trash
  return { id, affected: ids.length };
}
