import { failureClass } from "@memory/connectors";
import { registerConnections, registerOAuthMetadata } from "./oauth.ts";
import { registerAgentAuth } from "./agent-auth/routes.ts";
import { registerExternalAccess } from "./external-access.ts";
import { registerFactorRoutes } from "./factor-routes.ts";
import { registerLocalPasswordChange } from "./local-password-change.ts";
import { applyTool, cancelPlan, cancelPlansOfKey, listPlans, patchPlan, planDetail } from "./plans.ts";
import { confirmCorrection, correctionsSummary, myCorrections, recordCorrections, rejectCorrection, withdrawCorrection } from "./corrections.ts";
import { registerOrgReviewPeople } from "./org-review-people.ts";
import { registerMeNav } from "./me-nav.ts";
import { registerCustody } from "./custody.ts";
import { registerEdgeHold } from "./edge-hold.ts";
import { registerOpenRecheckRecord } from "./open-recheck-admin.ts";
import { ME_LISTS } from "./limits.ts";
// REST /api/v1 for services, buttons and the admin panel (contracts/openapi-ingest.yaml). The same key, the same rights and error
// codes as in MCP; services with obo_allowed add X-On-Behalf-Of. Additive routes of the role model are marked.
import { Hono, type Context } from "hono";
import type pg from "pg";
import { streamingBodyLimit } from "./body-limit.ts";
import { getConnInfo } from "@hono/node-server/conninfo";
import { archivedDenied, CONSENT_MAX_LEN, generateApiKey, invalid, meetingHandoverBusy, MemoryError, newId, notFound, parseClientKind, recordPath, tooLarge, tx, log, kindFromPrefix, nightWindowOf } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { authenticate, baseUrlOf, clientAddress, HttpReject, oboReadRefused, originAllowed } from "./auth.ts";
import { isExternal, requestChannel } from "./channel.ts";
import { archivedOnlyNarrows, loadReadable, readableSpaces, resolveSpace } from "./access.ts";
import { derivedVisible } from "./visibility.ts";
import { dropHeldDerived } from "./org-hold.ts";
import { leaveOrgNarrowed } from "./org-review.ts";
import { intParam, isUuidParam, offsetCursor, timeParam } from "./paging.ts";
import { conversionView, createRecord, ENTITIES_MAX, ownHiddenRecord, ownOpenAccepted, ownOpenCheck, queueOf, resolveEntities, sourceHash, stagesOf } from "./records.ts";
import { declineDeletion, myDeletionRequests, parseDeletionReason, requestDeletion } from "./deletion-requests.ts";
import { leaveMyMeeting, listMyMeetings, meetingsFilterParams, meetingsSummary, participantsView, setParticipants, setProjectMark } from "./my-meetings.ts";
import { recordReaders } from "./readers.ts";
import { me, processNow, serviceSpaceOnly, upload } from "./write.ts";
import { audit, AUDIT_UNAVAILABLE_TEXT, AuditUnavailable, auditRead, auditShownClosed, MY_AUDIT_VIEWS, myAuditPage, reasonsFor, withoutReasons, type MyAuditView } from "./audit.ts";
import { withRecordTitles } from "./my-audit-titles.ts";
import { adminPlaneHealth, healthState } from "./health.ts";
import { mainListenerApprovalGuard } from "./admin-plane/approvals.ts";
import { originalBucket, originalInfo, registerOriginals, signedOriginalUrl } from "./originals.ts";
import { toolsFor } from "./mcp.ts";
import { personKeyExpiry } from "./key-expiry.ts";
import { jsonObjectBody, myKeyNarrowing, rejectUnknownFields } from "./key-kind.ts";
import { open, purgeFromTrash, restoreFromTrash, trashList } from "./owner.ts";
import { openPreview, showAnywayToggles } from "./despite-open.ts";
import { linksTestHookOn, linksVisibleTo, linkStatuses } from "./links.ts";
import { isHumanSession, requireHuman } from "./workplace.ts";
import { registerAgentView } from "./agent-view.ts";
import { registerMorningNote } from "./morning-note.ts";
import { meetingDecisions } from "./decisions.ts";
import { recordDerivation, recordDerivationSources } from "./derivation.ts";
import { handover, handoverForm } from "./handover.ts";
import { callToSpace, cancelInvite, changeSpaceClass, setMemberRole, spaceMembersView } from "./space-people.ts";
import { endPersonSessions, endSession, listSessions } from "./user-sessions.ts";
import { adminRoutes } from "./admin.ts";
import { alertsRoutes } from "./admin-plane/alerts-routes.ts";
import { registerLdapLogin } from "./ldap-login.ts";
import { registerLocalLogin } from "./local-login.ts";
import { registerLocalSetup } from "./local-accounts-admin.ts";
import { registerOidcLogin } from "./oidc-login.ts";
import { registerSkillRoutes } from "./skill-routes.ts";
import { registerConnectorHooks } from "./connectors/index.ts";
import { registerDirectory } from "./directory.ts";
import { oboConsentRoutes } from "./obo-consent.ts";
import { registerConsentApi } from "./agent-auth/consent-api.ts";
import { acceptMeeting, cancelMeetingMail, checkParticipants, consentText, leftMarks, MEETING_HANDOVER_TEXT, meetingFamilyLocked, meetingOwner, parseMeetingBody, withMeetingLock, type MeetingChannel } from "./meetings.ts";
import { serializeMeeting } from "./meetings/serialize.ts";
import { withRecordLocksWait } from "./owner-lock.ts";
import type { PendingParticipant } from "./participants.ts";
import { acceptUpload, issueUpload } from "./uploads.ts";
import { createProject, mySpace, SLUG_RE, spaceReadmeConfig, transferMySpace, updateMySpace } from "./spaces.ts";
import { archiveMySpace, listMySpaces, unarchiveMySpace } from "./archive.ts";
import { bindSpaceGroup, DirectoryReject, listSpaceGroups, syncMySpaceGroups, unbindMySpaceGroup } from "./space-groups.ts";
import { poolBusy } from "./control-lock.ts";
import { registerProfileRoutes } from "./profile.ts";
import { registerSpaceGuideRoutes } from "./space-guide.ts";
import { registerVersions, versionStatusFields } from "./doc-versions.ts";
import { requireOverviewEnabled, spaceOverview } from "./space-overview.ts";
import { requireAddableEnabled, spaceAddable } from "./space-addable.ts";
import { registerExport } from "./export/routes.ts";

type Env = { Variables: { caller: Caller } };

/** Body limit for a document upload: file + multipart/base64 overhead. /mcp has the same (memory_upload with content_base64). */
export const uploadBodyLimit = (app: App): number => Math.ceil(app.settings.get("limits.upload_max_bytes", 20_971_520) * 1.4) + 1_048_576;

/**
 * A comma list from a form: empty elements are skipped. With a limit, parsing stops at the (max+1)-th element —
 * that is already the "at most max" refusal further on, and hundreds of thousands of keys are not parsed whole.
 */
export function commaList(v: unknown, max = Infinity): string[] | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const out: string[] = [];
  for (let i = 0; i <= v.length && out.length <= max;) {
    const j = v.indexOf(",", i), end = j < 0 ? v.length : j;
    const item = v.slice(i, end).trim();
    if (item) out.push(item);
    i = end + 1;
  }
  return out;
}

/**
 * The route pattern (`/api/v1/originals/:signed`): it goes into the log, not the address with a signature or ticket. A route
 * not matched (or matched only by the general `*`) — the path without values after the first three segments.
 */
export function routeTemplate(c: Context): string {
  let path = "";
  try { path = c.req.routePath ?? ""; } catch { path = ""; }
  if (path && !path.endsWith("*")) return path.slice(0, 200);
  return c.req.path.split("/").slice(0, 4).join("/").slice(0, 200);
}

export function errorResponse(c: Context, e: unknown, app?: App): Response {
  if (e instanceof HttpReject) return c.json({ code: e.code, message: e.message }, e.status);
  e = poolBusy(e) ?? e;                         // the control pool gave no connection in time — "retry", not 500
  // the directory is not connected (409 ldap_disabled) or unavailable (503 ldap_*) — directory groups in spaces
  if (e instanceof DirectoryReject) return c.json({ code: e.code, message: e.message }, e.status);
  if (e instanceof MemoryError) {
    if (e.code === "rate_limited") {
      c.header("Retry-After", String(e.extra.retry_after ?? 1)); c.header("RateLimit-Remaining", "0");
      // The log gets the route pattern, not the address itself: the /originals/<signature> address is a full
      // link to a closed document, and auditors read the log; method — tells the workplace background read (GET by a session —
      // "service" in "My actions") from an action
      if (app) void audit(app, (c.get as (k: string) => Caller | undefined)("caller") ?? null, { event_type: "rate_limited", details: { path: routeTemplate(c), method: c.req.method } });
    }
    if (e.code === "in_progress" && typeof e.extra.retry_after === "number") c.header("Retry-After", String(e.extra.retry_after));
    return c.json(e.body(), e.status as any);
  }
  // the log did not accept a read of closed: closed is not given out — a reason the person understands, not "internal error"
  if (e instanceof AuditUnavailable) {
    log.error("rest_audit_unavailable", { path: routeTemplate(c) });   // the route, never the caller's path
    return c.json({ code: "internal", message: AUDIT_UNAVAILABLE_TEXT }, 503);
  }
  log.error("rest_internal_error", { error: failureClass(e) });   // a class, never the exception
  return c.json({ code: "internal", message: "Internal error" }, 500);
}

/** Operation by allow-list: a service — its list; a personal key — ops_override (if set); the system key — only the admin API. */
function requireOp(caller: Caller, op: string): void {
  if (caller.principalType === "system") throw new HttpReject(403, "forbidden", "The system key is for the admin API only");
  if (caller.allowedOps && !caller.allowedOps.has(op)) {
    // reading on behalf of a person without their consent: the event — here, on a real refusal, not on entry
    oboReadRefused(caller, op);
    throw new HttpReject(403, "forbidden", `Operation ${op} is outside the key’s allow-list`);
  }
}
/** Source routes (transcriber, button by object_key) — only for service keys: a personal key cannot check others' transcripts. */
function requireService(caller: Caller, op: string): void {
  requireOp(caller, op);
  if (caller.principalType !== "service") throw new HttpReject(403, "forbidden", `Operation ${op} requires a service key`);
}

/** The client socket address (node-server); outside node-server — unknown. */
export const remoteOf = (c: Context): string | null => { try { return getConnInfo(c).remote.address ?? null; } catch { return null; } };

/**
 * Rate limit on REST: the same windows and settings as MCP — 429 with Retry-After.
 * REST buckets: `me_audit`, `me_keys`, `me_keys_view`, `nav`, `ingest`, `status`, `original`; for `/api/v1/me` — the same bucket as
 * memory_me (a workplace session — session_me, bucketOf in limits.ts); `/me/access`, `/me/trash` — ME_LISTS, the memory_me window
 * for everyone, the session too.
 */
const limited = (app: App, bucket: string) => async (c: Context<Env>, next: () => Promise<void>) => {
  app.limiter.check(c.get("caller"), bucket);
  await next();
};

/**
 * The switch — before the limit: a switched-off feature answers 403 and spends no limit window. Needed by blocks that
 * the workplace page asks on every showing ("Space overview", "Can be added"): switched off, they do not
 * bring 429 closer for the card and members, and do not answer 429 themselves instead of 403.
 */
const switchedOn = (check: () => void) => async (_c: Context<Env>, next: () => Promise<void>) => {
  check();
  await next();
};

const intQuery = (c: Context, name: string, def: number, min: number, max: number): number => intParam(c.req.query(name), def, min, max, name);

/** A record tree by roots (derived ones — by parent_id). */
const TREE = "WITH RECURSIVE t AS (SELECT id FROM records WHERE id = ANY($1::uuid[]) UNION ALL SELECT r.id FROM records r JOIN t ON r.parent_id = t.id) SELECT id FROM t";

/** A service "on behalf of" without the read operation (the transcriber: reading on behalf of is off, obo_read). */
export const serviceWithoutRead = (caller: Pick<Caller, "principalType" | "onBehalfOf" | "allowedOps">): boolean =>
  caller.principalType === "service" && caller.onBehalfOf && !!caller.allowedOps && !caller.allowedOps.has("read");

/**
 * Record state to a service without reading — only for records it accepted itself (attrs.access.asserted_by — its name, as in
 * PUT /ingest/access): names of summaries and decisions of another's record, closed ones too, are not given by number — 404, as
 * for a missing one. For its own meetings the answer is as before — with derived and titles.
 */
export const statusForeignToService = (caller: Pick<Caller, "principalType" | "onBehalfOf" | "allowedOps" | "service">, assertedBy: unknown): boolean =>
  serviceWithoutRead(caller) && assertedBy !== caller.service?.name;

/**
 * A key without a network binding only narrows the reader circle: for EACH record of the tree the new circle is
 * a subset of its current one (its people and owner). Before, the union of people of all meeting versions counted as current, and
 * a forged new version with oneself among participants opened the old transcript through this route.
 */
export async function unboundOnlyNarrows(q: { query: (sql: string, v: unknown[]) => Promise<{ rows: any[] }> }, tree: string[], ids: string[], ownerId: string): Promise<void> {
  if (!tree.length) return;
  const people = new Map<string, Set<string>>(tree.map((id) => [id, new Set([ownerId])]));
  for (const r of (await q.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [tree])).rows) people.get(r.record_id)?.add(r.person_id);
  const added = new Set(ids.filter((p) => tree.some((id) => !people.get(id)!.has(p)))).size;
  if (added) throw new HttpReject(403, "forbidden", `A key without an address binding can only remove readers, but this request adds ${added}. Bind the key to the service address under “Services and keys” in the admin panel`);
}

// The check "in an archive the circle only narrows" over a tree (PUT /ingest/access) lives in access.ts: the meeting members edit
// calls it too (meetings.ts applyParticipants); here — a re-export for old imports
export { archivedOnlyNarrows };

/** The record's rights version +1 — the readers changed (without an audience change). */
const ACL_BUMP = "UPDATE records SET attrs = jsonb_set(jsonb_set(attrs, '{access,acl_version}', to_jsonb(COALESCE((attrs #>> '{access,acl_version}')::int, 1) + 1)), '{access,acl_checked_at}', to_jsonb(now())) WHERE id = ANY($1::uuid[])";
/**
 * The mark "the meetings service set the reader circle" (`attrs.access.narrowed_by_source`) — to the whole tree, wherever it
 * lies: in the organizer's personal space, in a space, only placed in another. By it "Can be added" (space-addable.ts) does not
 * offer the meeting, and a new meeting version inherits it (meetings.ts). restricted_by_source stays as it was — only outside
 * personal, with the promoted_restricted count; the mark does not go into answers.
 */
const NARROWED_MARK = "UPDATE records SET attrs = jsonb_set(attrs, '{access}', COALESCE(attrs->'access', '{}'::jsonb) || '{\"narrowed_by_source\": true}'::jsonb) WHERE id = ANY($1::uuid[])";

/**
 * `PUT /api/v1/ingest/access` (additive, the role model): a source reports the new reader list of its object —
 * a cascade to derived ones. A service with ingest_transcripts and X-On-Behalf-Of checks the route; `waitSec` — waiting for
 * class move locks, 20 s by default.
 *
 * Meeting versions in the trash only narrow (one removed does not come back by restoring a version or at
 * first sign-in — as with "Remove" and a new meeting version); a meeting opened to agents despite a finding
 * gets no new readers — only narrowing and the participants_not_added warning, as on a transcript repeat.
 * Those who left the meeting themselves (the participants_left mark) do not come back — readers_left in the answer.
 */
export async function ingestAccess(app: App, caller: Caller, b: any, o: { waitSec?: number } = {}) {
  if (!caller.person) throw new HttpReject(403, "forbidden", "Set X-On-Behalf-Of to the object owner’s login");
  if (typeof b?.source_ref !== "string" || !Array.isArray(b?.readers)) throw invalid("Provide source_ref and readers[]");
  if (b.readers.length > 200) throw invalid("readers accepts at most 200");
  const person = caller.person;
  const readerLogins = new Set<string>([person.login, ...b.readers.map((l: string) => String(l).trim().toLowerCase())]);
  const ids: string[] = [], unknown: string[] = [], loginOf = new Map<string, string>();
  for (const login of readerLogins) {
    const p = (await app.db.control.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0];
    if (p) { ids.push(p.id); loginOf.set(p.id, login); } else unknown.push(login);
  }
  const idOf = new Map<string, string>([...loginOf].map(([id, login]) => [login, id]));
  // idsIn — readers minus those who left themselves (marks are read under the locks below); outside — for the answer and log
  const idsAll = ids;
  let idsIn = ids, readersLeft: string[] = [];
  // named readers with a card — meeting participants (attrs.participants)
  const named = new Set<string>(b.readers.map((l: string) => String(l).trim().toLowerCase()));
  const known = [...readerLogins].filter((l) => named.has(l) && !unknown.includes(l));
  const lateKnown = new Map<string, string>();   // login → people.id: the card and grant came between the card search and the lock
  // the source outranks the owner: the restriction applies to the whole tree, including records promoted
  // by the owner from personal into team ones; such records get the attrs.access.restricted_by_source mark and are counted in the answer
  // only records of THIS service (attrs.access.asserted_by): another transcriber with the same owner
  // and the same source_ref does not change the reader list — for it there are no such records (404)
  const OF_SERVICE = `FROM records WHERE source_kind = 'transcriber' AND source_ref = $1 AND owner_id = $2 AND attrs #>> '{access,asserted_by}' = $3`;
  const ROOTS = `${OF_SERVICE} AND deleted_at IS NULL`;
  const rootArgs = [b.source_ref, person.id, caller.service!.name];
  const ownerId = person.id;
  // Under the record locks: the same record:<id> that a move between open and closed holds, and the same
  // meeting intake queue as a transcript repeat and an edit in the workplace. A move is running — we wait; if not in time —
  // 409 in_progress (retry later), not a 200 the move would overwrite. The roots of both classes are reread under the locks;
  // a version absent from the locked ones (it reached the organizer after the selection) — 409, not an edit without a lock.
  // Anything to change — by versions not in the trash (404); versions in the trash — under the same locks, only narrowing
  const result = await withMeetingLock(`${ownerId}\u0000${b.source_ref}`, async () => {
    const live: string[] = [], trashed: string[] = [];
    for (const cls of ["open", "closed"] as const)
      for (const x of (await app.db.recordsForWrite(cls, caller.scope).query(`SELECT id, deleted_at IS NOT NULL AS trashed ${OF_SERVICE}`, rootArgs)).rows)
        (x.trashed ? trashed : live).push(x.id as string);
    if (!live.length) throw notFound();
    // under control locks — only with the lock connection `ctl`: a batch of simultaneous
    // /ingest/access calls, each holding a connection and asking for a second, exhausted the control pool
    return withRecordLocksWait(app, [...live, ...trashed], async (ctl) => {
      // a meeting in the middle of passing to a new organizer: part of the versions is already with the custodian (or, on
      // a return, still with them) — the reader list would change only for a part; 409 in a minute, as a members edit in the work
      // place. Under the root locks: the hand-over job will not shift them, and those shifted before the locks are visible
      await meetingFamilyLocked(app, caller, ctl, { ownerId, ref: b.source_ref, locked: [...live, ...trashed] });
      // the version set did not grow: versions were picked before the locks, and the job could meanwhile return to the organizer
      // one more (a return locks only its own root, and the family is no longer split — all versions are with them) or hand them
      // as custodian the root of another chain with the same number. The edit below picks the OF_SERVICE set anew and would touch
      // a version without its lock — a parallel class move of that version (its "Open" at the organizer) would put a copy with
      // the old reader list over the 200 answer. The same 409, a retry locks the whole set. anchor is not passed: the set here is
      // exactly OF_SERVICE, not the meetingRootIds chains
      const lockedIds = new Set([...live, ...trashed]);
      for (const cls of ["open", "closed"] as const)
        if ((await app.db.recordsForWrite(cls, caller.scope).query(`SELECT 1 ${OF_SERVICE} AND id <> ALL($4::uuid[]) LIMIT 1`, [...rootArgs, [...lockedIds]])).rowCount)
          throw meetingHandoverBusy(MEETING_HANDOVER_TEXT);
      // those who left the meeting themselves: a new reader list does not silently bring them back —
      // they go into neither live nor trashed versions, the answer has readers_left; only the organizer can bring them back in
      // the workplace. Marks — from the live roots, under the locks
      const left = new Set<string>();
      for (const cls of ["open", "closed"] as const)
        for (const x of (await app.db.recordsForWrite(cls, caller.scope).query(`SELECT attrs->'participants_left' AS l ${ROOTS}`, rootArgs)).rows)
          for (const m of leftMarks({ participants_left: x.l })) if (m.login !== person.login.toLowerCase()) left.add(m.login);
      readersLeft = [...readerLogins].filter((l) => left.has(l));
      const leftIds = new Set(readersLeft.map((l) => idOf.get(l)).filter((x): x is string => !!x));
      const ids = idsAll.filter((id) => !leftIds.has(id));
      idsIn = ids;
      // a key without a network binding only narrows the reader circle: a leaked key must not open others' meetings to anyone.
      // The current circle is each tree record's own: its people and the owner (unboundOnlyNarrows); adding someone
      // beyond it needs a key bound to the service address. Before editing both classes and again — in the transaction of each
      // class below. Versions in the trash only narrow — we do not check them
      if (!caller.netBound) {
        let found = false;
        for (const cls of ["open", "closed"] as const) {
          const db = app.db.recordsForWrite(cls, caller.scope);
          const roots = (await db.query(`SELECT id ${ROOTS}`, rootArgs)).rows.map((x) => x.id as string);
          if (!roots.length) continue;
          found = true;
          await unboundOnlyNarrows(db, (await db.query(TREE, [roots])).rows.map((x) => x.id as string), ids, ownerId);
        }
        if (!found) throw notFound();
      }
      // a meeting in an archived project or team: the reader circle only narrows — adding is not allowed. Before
      // editing both classes (otherwise one class would have been rewritten), and again — in the transaction of each class below
      for (const cls of ["open", "closed"] as const) {
        const db = app.db.recordsForWrite(cls, caller.scope);
        const roots = (await db.query(`SELECT id ${ROOTS}`, rootArgs)).rows.map((x) => x.id as string);
        if (roots.length) await archivedOnlyNarrows(app, db, (await db.query(TREE, [roots])).rows.map((x) => x.id as string), ids, ownerId, ctl);
      }
      const personalSpace: string | null = (await ctl.query("SELECT id FROM spaces WHERE kind = 'personal' AND owner_id = $1", [ownerId])).rows[0]?.id ?? null;
      let affected: string[] = [], promotedRestricted = 0;
      const allRoots: string[] = [], removed = new Set<string>(), trashedTouched: string[] = [], notAdded = new Set<string>();
      const trees: Array<["open" | "closed", string[]]> = [];
      const readerOf = (x: unknown): boolean => { const l = String((x as { login?: unknown })?.login ?? "").toLowerCase(); return readerLogins.has(l) && !left.has(l); };
      for (const cls of ["open", "closed"] as const) {
        const db = app.db.recordsForWrite(cls, caller.scope);
        const out = await tx(db, async (q) => {
          // roots (and trashed versions) — FOR UPDATE in id order, as the worker's replaceDerived: summaries or decisions that
          // the worker writes now are either already visible to the tree below or will copy the meeting people after the replace
          const all = (await q.query(`SELECT id, deleted_at IS NOT NULL AS trashed, attrs->'participants_pending' AS pending, attrs->'open_check_accepted' AS accepted ${OF_SERVICE} ORDER BY id FOR UPDATE`, rootArgs))
            .rows as Array<{ id: string; trashed: boolean; pending: unknown; accepted: unknown }>;
          // here too: the version reached the organizer after the check above — not edited without its lock. The transaction
          // of this class rolls back; the open database, if already committed, is only narrowed — the source gets 409 and retries
          if (all.some((x) => !lockedIds.has(x.id))) throw meetingHandoverBusy(MEETING_HANDOVER_TEXT);
          // a named reader without a card could first sign in while this request ran: the sign-in made a card, the grant
          // (grantPendingMeetings) added them to the meeting people, off the waiting list — before our lock. Their cards
          // are reread under it: else the people replace below erases them and they are no longer waiting — lost for good.
          // Only those already among the live root's people are taken: this is not an addition (the key
          // without binding and the archive check against the current circle); those not yet granted wait, as before. Under the
          // control locks — with the lock connection `ctl`
          const liveIds = all.filter((x) => !x.trashed).map((x) => x.id);
          const late = unknown.length && liveIds.length
            ? (await ctl.query("SELECT id, login FROM people WHERE login = ANY($1::text[]) AND instance_id = $2", [unknown, app.instanceId])).rows as Array<{ id: string; login: string }> : [];
          const granted = late.length ? new Set((await q.query("SELECT DISTINCT person_id FROM record_people WHERE record_id = ANY($1::uuid[]) AND person_id = ANY($2::uuid[])",
                                                               [liveIds, late.map((x) => x.id)])).rows.map((x) => x.person_id as string)) : new Set<string>();
          const lateTx = late.filter((p) => granted.has(p.id));
          const idsTx = [...new Set([...ids, ...lateTx.map((p) => p.id)])], knownTx = [...new Set([...known.filter((l) => !left.has(l)), ...lateTx.map((p) => p.login.toLowerCase())])];
          const loginTx = new Map(loginOf);
          for (const p of lateTx) loginTx.set(p.id, p.login.toLowerCase());
          // a version in the trash: only narrowing — the removed leave its people and derived ones, "waiting for a card" ones not
          // on the list are removed; none added. Else a restore (or a waiting one's first sign-in) would return the removed
          const binned: string[] = [];
          for (const r of all.filter((x) => x.trashed)) {
            const tree = (await q.query(TREE, [[r.id]])).rows.map((x) => x.id as string);
            // and the version in the trash is marked: once restored, it must not become a "Can be added" candidate
            await q.query(NARROWED_MARK, [tree]);
            const del = await q.query("DELETE FROM record_people WHERE record_id = ANY($1::uuid[]) AND person_id <> ALL($2::uuid[]) AND person_id <> $3 RETURNING person_id", [tree, idsTx, ownerId]);
            for (const x of del.rows) removed.add(x.person_id as string);
            const keep = Array.isArray(r.pending) ? r.pending.filter(readerOf) : null;
            const pendingGone = !!keep && keep.length !== (r.pending as unknown[]).length;
            if (pendingGone) await q.query("UPDATE records SET attrs = attrs || jsonb_build_object('participants_pending', $2::jsonb) WHERE id = $1", [r.id, JSON.stringify(keep)]);
            if (!del.rowCount && !pendingGone) continue;
            await q.query(ACL_BUMP, [tree]);
            binned.push(...tree);
          }
          const roots = all.filter((x) => !x.trashed);
          if (!roots.length) return { tree: [] as string[], promoted: 0, roots: all.map((x) => x.id), binned, late: lateTx };
          const tree = (await q.query(TREE, [roots.map((x) => x.id)])).rows.map((x) => x.id as string);
          if (!caller.netBound) await unboundOnlyNarrows(q, tree, idsTx, ownerId);
          await archivedOnlyNarrows(app, q, tree, idsTx, ownerId, ctl);
          for (const x of (await q.query("SELECT DISTINCT person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [roots.map((x) => x.id)])).rows)
            if (!idsTx.includes(x.person_id)) removed.add(x.person_id as string);
          await q.query("UPDATE records SET audience = 'people' WHERE id = ANY($1::uuid[])", [tree]);
          await q.query(ACL_BUMP, [tree]);
          await q.query("UPDATE chunks SET audience = 'people' WHERE record_id = ANY($1::uuid[])", [tree]);
          // a meeting opened to agents despite a finding (only the owner reads it) — we put no new readers into it,
          // only narrow (as a transcript repeat): the readers are the list, minus those the root did not have
          const participantsOf = new Map<string, string[]>();
          for (const r of roots) {
            const rootTree = (await q.query(TREE, [[r.id]])).rows.map((x) => x.id as string);
            let readers = idsTx;
            if (cls === "open" && r.accepted) {
              const had = new Set<string>((await q.query("SELECT person_id FROM record_people WHERE record_id = $1", [r.id])).rows.map((x) => x.person_id as string));
              readers = idsTx.filter((id) => id === ownerId || had.has(id));
              for (const id of idsTx) if (!readers.includes(id)) notAdded.add(loginTx.get(id) ?? id);
            }
            const inRoot = new Set(readers.map((id) => loginTx.get(id)).filter((l): l is string => !!l));
            participantsOf.set(r.id, knownTx.filter((l) => inRoot.has(l)));
            await q.query("DELETE FROM record_people WHERE record_id = ANY($1::uuid[])", [rootTree]);
            await q.query("INSERT INTO record_people (record_id, person_id) SELECT t, p FROM unnest($1::uuid[]) t CROSS JOIN unnest($2::uuid[]) p ON CONFLICT DO NOTHING", [rootTree, readers]);
          }
          // "waiting for a card" ones not in the reader list: else at first sign-in they would get the meeting again; and not
          // those who already have a card — they read at once. Participants (attrs.participants) — named
          // readers with a card in the root's people (for one "despite a finding" — minus those not put in); those not found at
          // intake (participants_unresolved) are not touched
          for (const root of roots) {
            const keep = (Array.isArray(root.pending) ? root.pending as PendingParticipant[] : [])
              .filter((x) => readerOf(x) && !knownTx.includes(String(x?.login ?? "").toLowerCase()));
            await q.query("UPDATE records SET attrs = (attrs - 'participants_pending') || jsonb_build_object('participants', $2::jsonb) || $3::jsonb WHERE id = $1",
                          [root.id, JSON.stringify(participantsOf.get(root.id) ?? []), JSON.stringify(keep.length ? { participants_pending: keep } : {})]);
          }
          const promoted = await q.query(
            "UPDATE records SET attrs = jsonb_set(attrs, '{access}', COALESCE(attrs->'access', '{}'::jsonb) || '{\"restricted_by_source\": true}'::jsonb) WHERE id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR space_id <> $2)", [tree, personalSpace]);
          // the circle is set by the source — in personal too: restricted_by_source above does not mark it
          await q.query(NARROWED_MARK, [tree]);
          return { tree, promoted: promoted.rowCount ?? 0, roots: all.map((x) => x.id), binned, late: lateTx };
        });
        affected = affected.concat(out.tree); promotedRestricted += out.promoted; allRoots.push(...out.roots); trashedTouched.push(...out.binned);
        for (const p of out.late) lateKnown.set(p.login.toLowerCase(), p.id);
        trees.push([cls, out.tree]);
      }
      if (!affected.length) throw notFound();
      return { affected, promotedRestricted, roots: allRoots, removed: [...removed], trees, trashed: trashedTouched, notAdded: [...notAdded] };
    }, { waitSec: o.waitSec });
  });
  // readers — also those the grant added mid-request; they are no longer among the not found; those who left themselves —
  // not readers (readers_left)
  const readersCount = new Set([...idsIn, ...lateKnown.values()]).size, stillUnknown = unknown.filter((l) => !lateKnown.has(l));
  await audit(app, caller, { event_type: "write", record_ids: [...result.affected, ...result.trashed],
                             details: { op: "ingest_access", readers: readersCount, ...(readersLeft.length ? { readers_left: readersLeft.length } : {}),
                                        promoted_restricted: result.promotedRestricted, net_bound: caller.netBound,
                                        ...(result.trashed.length ? { trashed_narrowed: result.trashed.length } : {}), ...(result.notAdded.length ? { not_added: result.notAdded.length } : {}) } });
  // emails about the meeting to those who are no longer readers do not go out, over all versions, the trash too
  if (result.removed.length) await cancelMeetingMail(app, result.roots, result.removed);
  // the reader circle was narrowed by the source: tree records in "Company common knowledge" leave it for where they came from
  // — by the same path as the author's "Move back", a memory decision. After
  // the move locks: the return takes its own record:<id> locks (returnFromOrg); under ours it would find it busy. Versions in
  // the trash stay in org: nobody reads them there. The circle is saved: leaveOrgNarrowed never throws (a failure — to the log,
  // a job picks it up), the second class is not skipped
  for (const [cls, tree] of result.trees) await leaveOrgNarrowed(app, caller, cls, tree, "system");
  return { source_ref: b.source_ref as string, records_updated: result.affected.length, readers: readersCount, readers_unknown: stillUnknown, promoted_restricted: result.promotedRestricted,
           ...(readersLeft.length ? { readers_left: readersLeft } : {}), ...(result.notAdded.length ? { warnings: ["participants_not_added"] } : {}) };
}

export function buildRest(app: App, o: { adminSeparate?: boolean } = {}): Hono<Env> {
  const r = new Hono<Env>();
  r.onError((e, c) => errorResponse(c, e, app));
  registerOAuthMetadata(r, app);
  // the protocol routes of the built-in agent sign-in server (agent-auth/routes.ts): metadata,
  // /oauth/authorize and its continuation, /oauth/token, /oauth/revoke — without a key, before the key check, with their
  // own 16 KiB body limit; outside agent_auth.mode = builtin (or not ready) the router's 404
  registerAgentAuth(r, app, remoteOf);
  // the hooks routes of connectors: signed requests of external systems, without a key, before the general body
  // limit (their own one, integrations.webhooks_max_body_mb) and the key check; everything under /api/v1/hooks ends here
  registerConnectorHooks(r, app, (c) => clientAddress(app, c.req.raw, remoteOf(c)));
  const tooBig = (c: Context) => errorResponse(c, tooLarge("The request body exceeds the size limit"), app);
  // the body size is limited before reading into memory (multipart used to be buffered whole before the upload_max_bytes check)
  // the meeting upload link reads the body itself — with its ticket's limit (meetings.upload_max_mb at issue time)
  r.use("/api/v1/*", (c, next) => c.req.path.startsWith("/api/v1/uploads/") ? next()
    : streamingBodyLimit(c.req.path === "/api/v1/ingest/documents" ? uploadBodyLimit(app) : 4 * 1_048_576, tooBig)(c, next));
  // The Origin gate — not only on /mcp: the access.origin_allowlist list closes both entries.
  // A request without an Origin header is not a browser (services, desktop MCP clients, the panel from the server): it passes.
  r.use("/api/v1/*", async (c, next) => {
    if (!originAllowed(app, c.req.raw)) return c.json({ code: "forbidden", message: "Origin is outside the allowlist" }, 403);
    await next();
  });

  // health: without a key — only the status; check details and a forced refresh — to the system key (config disclosure)
  r.get("/api/v1/health", async (c) => {
    // the external agents' address: only the status, the key is not parsed at all; the answer code — as always
    if (isExternal(await requestChannel(app, c.req.raw, remoteOf(c)))) {
      const h = await healthState(app);
      return c.json({ status: h.status }, h.status === "fail_closed" ? 503 : 200);
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    let system = false;
    if (bearer && (kindFromPrefix(bearer) === "system" || bearer.startsWith("mem_adm_"))) {
      try { system = (await authenticate(app, c.req.raw, remoteOf(c))).principalType === "system"; } catch { system = false; }
    }
    const h = await healthState(app, system && c.req.query("force") === "1");
    // whether the admin listener is separate and strict mode — only to the system key and panel session; status unaffected
    const body = system ? { ...h, admin_plane: adminPlaneHealth(app) } : { status: h.status, version: h.version, instance: h.instance };
    return c.json(body, h.status === "fail_closed" ? 503 : 200);
  });
  // a signed link is shown without a key: the limit window — by the checked signature;
  // in fail-closed the original is not given, like all other content — 503, as for the upload link
  registerOriginals(r, app, remoteOf, async (c) => (await healthState(app)).status === "fail_closed"
    ? c.json({ code: "forbidden", message: "The installation is not serving requests (fail-closed): see /api/v1/health" }, 503) : null);

  // a one-time meeting upload link: without a key — the issuing key's rights; the limit window — by the client address
  r.put("/api/v1/uploads/:ticket", async (c) => {
    const ip = await clientAddress(app, c.req.raw, remoteOf(c));
    app.limiter.checkAnonymous("upload", ip ?? "unknown");
    if ((await healthState(app)).status === "fail_closed") return c.json(serializeMeeting("Error", { code: "forbidden", message: "The installation is not serving requests (fail-closed): see /api/v1/health" }, "base"), 503);
    // the link base of the caller: on the external channel the configured public address
    const { channel } = await requestChannel(app, c.req.raw, remoteOf(c));
    const res = await acceptUpload(app, c.req.param("ticket"), c.req.raw, ip, baseUrlOf(c.req.raw, { app, channel }));
    return c.json(res.body, res.status);
  });

  // a person's sign-in with a company account: without a key, only from the workplace server
  registerLdapLogin(r, app, remoteOf);
  registerLocalLogin(r, app, remoteOf);
  registerLocalSetup(r, app, remoteOf);
  // sign-in via the identity provider: the sign-in start and the return from it — also only from the workplace server
  registerOidcLogin(r, app, remoteOf);
  // the memory skill without a key: the core, archive and manifest — before the key check and in fail-closed (they hold no data)
  registerSkillRoutes(r, app, remoteOf);

  r.use("/api/v1/*", async (c, next) => {
    // the transport — into the write event (details.via): keys without a program that upload over REST are scripts
    c.set("caller", { ...(await authenticate(app, c.req.raw, remoteOf(c))), transport: "rest" });
    const h = await healthState(app);
    // fail-closed: data is not served; the admin API stays — otherwise the required settings could not be filled
    if (h.status === "fail_closed" && !c.req.path.startsWith("/api/v1/admin/")) return c.json({ code: "forbidden", message: "The installation is not serving requests (fail-closed): see /api/v1/health" }, 503);
    await next();
  });

  // directory search: the workplace and services with the directory operation
  registerDirectory(r, app);
  // consents to reading "on behalf of": /api/v1/me/obo-consents — the routes are filled by a later part
  r.route("/", oboConsentRoutes(app));

  r.get("/api/v1/me", limited(app, "memory_me"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json((await me(app, caller, toolsFor(caller).map((t) => t.name))).result);
  });

  r.get("/api/v1/me/audit", limited(app, "me_audit"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    if (!caller.person) throw notFound();
    const limit = intQuery(c, "limit", 50, 1, 200);
    // exclude_auto=true: without lists the workplace loaded itself (the auto field) — the Overview and "My
    // actions" show only what the person and their agents did; by default — as before, with the auto mark
    const excl = c.req.query("exclude_auto");
    if (excl !== undefined && excl !== "" && excl !== "true" && excl !== "false") throw invalid("exclude_auto: true or false");
    // view: main — the main, agents — agents, me — the person in the workplace, all — everything (the default,
    // as before); the filter goes before LIMIT — the page is full
    const view = c.req.query("view") || "all";
    if (!(MY_AUDIT_VIEWS as readonly string[]).includes(view)) throw invalid(`view: ${MY_AUDIT_VIEWS.join(" | ")}`);
    // titles=true — record names are asked only by the "My actions" feed: the Overview and other requests need none, and
    // names of closed ones are a read of closed with a log entry (without the flag — no visibility checks and no event)
    const titles = c.req.query("titles");
    if (titles !== undefined && titles !== "" && titles !== "true" && titles !== "false") throw invalid("titles: true or false");
    // the cursor is an opaque string "time with microseconds + count shown" without the event id;
    // the old time cursor is accepted; junk in from/to/cursor — 400
    const full = await myAuditPage(app, caller.person.id, { limit, from: timeParam(c.req.query("from"), "from"), to: timeParam(c.req.query("to"), "to"),
                                                            eventType: c.req.query("event_type"), cursor: c.req.query("cursor"), excludeAuto: excl === "true", view: view as MyAuditView,
                                                            // to an agent (not a session) — no custodian reads of a departed person's personal space
                                                            hideCustody: !isHumanSession(caller) });
    // what the check found in a file saved closed in a team or project — only to a person in the work
    // place; to an agent, script or extended key — without reasons
    const page = reasonsFor(caller) ? full : { ...full, items: withoutReasons(full.items) };
    // record names — by titles=true, only to the person's own workplace session, only those visible to them; to an agent key — none
    return c.json(titles === "true" ? { ...page, items: await withRecordTitles(app, caller, page.items) } : page);
  });

  // additive (the role model): on what basis the person has access to each space; archived ones too, with the
  // archived mark: reading an archive is access too, and the person sees its basis
  r.get("/api/v1/me/access", limited(app, ME_LISTS), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    const spaces = [...(await readableSpaces(app, caller, { archived: true })).values()].sort((a, b) => a.slug.localeCompare(b.slug));
    const grants = caller.person ? (await app.db.control.query(
      `SELECT g.id, g.role_code, r.name, r.memory_effect, g.actions, g.scope_kind, g.scope_ref, g.basis_source, g.basis_ref, g.approved_by, g.valid_from, g.valid_to
       FROM role_grants g JOIN roles r ON r.code = g.role_code WHERE g.person_id = $1 AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now())`, [caller.person.id])).rows : [];
    return c.json({
      classes_readable: caller.scope.classes, key: { kind: caller.keyKind, tier: caller.tier },
      spaces: spaces.map((s) => ({ slug: s.slug, kind: s.kind, role: s.role, via: s.via, grant_id: s.grant_id, expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null,
                                   ...(s.archived_at ? { archived: true } : {}) })),
      grants,
    });
  });

  // ---------------------------------------------------------------- self-service keys:
  // a person issues and revokes their personal keys themselves; issuing for another — only the administrator with a basis
  const ownKeys = (caller: Caller) => {
    if (caller.principalType !== "person" || !caller.person || caller.onBehalfOf) throw new HttpReject(403, "forbidden", "Only a person can manage their own keys in the workspace or with their personal key");
    return caller.person;
  };
  /** The panel preview key is not a full person session: one cannot make oneself a key for a year from it. */
  const notPreview = (caller: Caller): void => {
    if (caller.preview) throw new HttpReject(403, "forbidden", "Key issuance and revocation are unavailable in preview");
  };
  registerConnections(r, app);
  // the sign-in transaction API of the built-in agent sign-in: workplace listener only
  registerConsentApi(r, app);
  registerExternalAccess(r, app, remoteOf);   // "Access from outside" in the workplace: only the person turns it on
  registerFactorRoutes(r, app);              // second factor in the workplace: only the person sets it up, from inside
  registerLocalPasswordChange(r, app);
  // the list — bucket me_keys_view (a session has its own, a key — me_keys, bucketOf): read by Overview, "Connect an agent"
  // (polled every 15 s) and "Keys and agents"; issuing, changing and revoking keys — me_keys, as before
  r.get("/api/v1/me/keys", limited(app, "me_keys_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me"); const p = ownKeys(caller);
    const limit = intQuery(c, "limit", 50, 1, 100), offset = offsetCursor(c.req.query("cursor"));
    const { rows } = await app.db.control.query(
      `SELECT id, key_prefix, kind, tier, client_label, client_kind, basis, preview, open_write, created_at, expires_at, last_used_at, revoked_at,
              (id = $2::uuid) AS current, (CASE WHEN created_by = $1 THEN 'self' ELSE 'admin' END) AS issued_by
       FROM api_keys WHERE auth_method = 'api_key' AND principal_type = 'person' AND principal_id = $1 AND instance_id = $3 ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [p.id, caller.keyId, app.instanceId, limit + 1, offset]);
    return c.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });
  r.post("/api/v1/me/keys", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me"); const p = ownKeys(caller);
    notPreview(caller);
    // issuing a key is a person's action: an agent with a personal key does not make itself a new one; and only by
    // a workplace session (an extended key does not issue keys — it is not a session either)
    await requireHuman(app, caller, "Issue a key", { path: "/keys", section: "Keys and agents" });
    // the body is an object: JSON `null` (or an array, a string) used to slip past the {} substitute and fail 500 on a field read
    const b = jsonObjectBody(await c.req.json().catch(() => null), "MyKeyIssue");
    if (b.client_label !== undefined && b.client_label !== null && (typeof b.client_label !== "string" || b.client_label.length > 60)) throw invalid("client_label: a string of up to 60 characters");
    const expiresAt = personKeyExpiry(b.expires_at);                  // required, at most 90 days ahead
    // the key program is required: parsed after the term — the refusal texts about the term do not change
    const clientKind = parseClientKind(b.client_kind, { required: true });
    const max = app.settings.get("limits.personal_keys_max", 5);
    const key = generateApiKey("personal"), id = newId();
    // the limit is counted and applied in one transaction under the person's row lock: parallel requests
    // otherwise counted the same number and issued more than the limit
    const active = await tx(app.db.control, async (q) => {
      await q.query("SELECT 1 FROM people WHERE id = $1 FOR UPDATE", [p.id]);
      const n = (await q.query("SELECT count(*)::int AS n FROM api_keys WHERE auth_method = 'api_key' AND principal_type = 'person' AND principal_id = $1 AND kind = 'personal' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [p.id])).rows[0].n as number;
      if (n >= max) return n;
      await q.query(
        "INSERT INTO api_keys (id, key_prefix, key_hash, principal_type, principal_id, kind, tier, instance_id, client_label, client_kind, expires_at, created_by, basis) VALUES ($1,$2,$3,'person',$4,'personal','T2',$5,$6,$7,$8,$4,'self_service')",
        [id, key.prefix, key.hash, p.id, app.instanceId, b.client_label ?? null, clientKind, expiresAt]);
      return -1;
    });
    if (active >= 0) throw invalid(`You already have ${active} active personal keys (limit: ${max}). Revoke any you no longer need`);
    await audit(app, caller, { event_type: "admin", details: { op: "key_issue_self", key_id: id, client_label: b.client_label ?? null, client_kind: clientKind } });
    return c.json({ key: { id, key_prefix: key.prefix, kind: "personal", tier: "T2", client_label: b.client_label ?? null, client_kind: clientKind, expires_at: expiresAt }, secret: key.plain }, 201);   // the secret — once
  });
  // The program of one's own key: only narrowing to script — a key that a script actually
  // uses is marked without reissue. Widening (script → cloud) is not allowed: a script would get open
  // personal data. Only a person in the workplace, only their own active key; an agent does not change the program with its key.
  r.patch("/api/v1/me/keys/:id", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me"); const p = ownKeys(caller);
    notPreview(caller);
    await requireHuman(app, caller, "Edit the key", { path: "/keys", section: "Keys and agents" });
    const id = c.req.param("id"); if (!isUuidParam(id)) throw notFound();
    const narrow = myKeyNarrowing(await c.req.json().catch(() => null));
    if ("open_write" in narrow) {
      // remove the permission to write into open from one's own extended key: only narrowing —
      // the administrator turns it on; a key without the flag — 200 without changes and without an event
      const was = await tx(app.db.control, async (q) => {
        const cur = (await q.query(
          `SELECT open_write FROM api_keys WHERE auth_method = 'api_key' AND id = $1 AND instance_id = $2 AND principal_type = 'person' AND principal_id = $3 AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE`, [id, app.instanceId, p.id])).rows[0];
        if (!cur) return null;
        if (cur.open_write) await q.query("UPDATE api_keys SET open_write = false WHERE id = $1", [id]);
        return { on: cur.open_write === true };
      });
      if (!was) throw notFound();
      if (was.on) await audit(app, caller, { event_type: "admin", details: { op: "key_open_write_off", key_id: id, author: p.id } });
      return c.json({ id, open_write: false });
    }
    const to = narrow.client_kind;
    // the old value and the change — in one query under a row lock: a parallel mark does not write the event twice
    const row = await tx(app.db.control, async (q) => {
      const cur = (await q.query(
        `SELECT client_kind FROM api_keys WHERE auth_method = 'api_key' AND id = $1 AND instance_id = $2 AND principal_type = 'person' AND principal_id = $3 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE`, [id, app.instanceId, p.id])).rows[0];
      if (!cur) return null;
      if (cur.client_kind !== to) await q.query("UPDATE api_keys SET client_kind = $2 WHERE id = $1", [id, to]);
      return { from: (cur.client_kind ?? null) as string | null };
    });
    if (!row) throw notFound();
    if (row.from !== to) await audit(app, caller, { event_type: "admin", details: { op: "key_client_kind_set", key_id: id, from: row.from, to } });
    return c.json({ id, client_kind: to });
  });
  r.delete("/api/v1/me/keys/:id", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me"); const p = ownKeys(caller);
    notPreview(caller);
    // revoking a key is also a person's action: an agent does not kill a person's keys, even its own
    await requireHuman(app, caller, "Revoke the key", { path: "/keys", section: "Keys and agents" });
    const id = c.req.param("id"); if (!isUuidParam(id)) throw notFound();
    const res = await app.db.control.query("UPDATE api_keys SET revoked_at = now() WHERE auth_method = 'api_key' AND id = $1 AND principal_type = 'person' AND principal_id = $2 AND revoked_at IS NULL", [id, p.id]);
    if (!res.rowCount) throw notFound();
    // the key's waiting plans are cancelled; correct_bulk drafts go out at once
    await cancelPlansOfKey(app, caller, id!);
    await audit(app, caller, { event_type: "admin", details: { op: "key_revoke_self", key_id: id } });
    return c.body(null, 204);
  });

  // workplace routes are not available to API keys, even with the operation in the allow-list.
  const planCaller = async (c: Context<Env>, op = "plan") => {
    const caller = c.get("caller");
    await requireHuman(app, caller, "Manage change plans", { path: "/plans", section: "Bulk changes" });
    if (!caller.allowedOps?.has("owner")) requireOp(caller, op);
    return caller;
  };
  r.get("/api/v1/me/plans", limited(app, "plans_view"), async c => {
    const caller = await planCaller(c);
    return c.json(await listPlans(app, caller, { status: c.req.query("status") ?? "pending", limit: intQuery(c, "limit", 30, 1, 100), cursor: c.req.query("cursor") }));
  });
  r.get("/api/v1/me/plans/:id", limited(app, "plans_view"), async c => {
    const caller = await planCaller(c), id = c.req.param("id")!; if (!isUuidParam(id)) throw notFound();
    return c.json(await planDetail(app, caller, id, { limit: intQuery(c, "limit", 30, 1, 100), offset: offsetCursor(c.req.query("cursor")) }));
  });
  r.patch("/api/v1/me/plans/:id/items", limited(app, "plans_view"), async c => {
    const caller = await planCaller(c), id = c.req.param("id")!; if (!isUuidParam(id)) throw notFound();
    const body = jsonObjectBody(await c.req.json(), "Change plan"); rejectUnknownFields(body, ["exclude", "include"]);
    for (const field of ["exclude", "include"]) if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].length > 2000 || !body[field].every(isUuidParam))) throw invalid(`${field}: a list of IDs`);
    return c.json(await patchPlan(app, caller, id, body));
  });
  r.post("/api/v1/me/plans/:id/apply", async c => {
    const caller = await planCaller(c, "apply"), id = c.req.param("id")!; if (!isUuidParam(id)) throw notFound();
    const body = jsonObjectBody(await c.req.json(), "Change plan"); rejectUnknownFields(body, []);
    return c.json((await applyTool(app, caller, { plan_id: id })).result);
  });
  r.post("/api/v1/me/plans/:id/cancel", limited(app, "plans_view"), async c => {
    const caller = await planCaller(c), id = c.req.param("id")!; if (!isUuidParam(id)) throw notFound();
    const body = jsonObjectBody(await c.req.json(), "Change plan"); rejectUnknownFields(body, []);
    return c.json(await cancelPlan(app, caller, id));
  });

  // corrections. Deciding on them and viewing one's own — only a workplace session (requireHuman
  // inside); a record's corrections — to people, visibility — by the builder. Limit buckets — corrections_view, memory_correct;
  // the correct operation in the key's ops_override (the preview is narrowed to reading — gets 403).
  const correctionsCaller = (c: Context<Env>) => {
    const caller = c.get("caller");
    if (caller.allowedOps && !caller.allowedOps.has("correct")) requireOp(caller, "correct");
    return caller;
  };
  r.get("/api/v1/records/:id/corrections", limited(app, "corrections_view"), async c => {
    const caller = c.get("caller"); requireOp(caller, "read");
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    return c.json(await recordCorrections(app, caller, id));
  });
  // a record's origin for the workplace record page (the warning at "Move", the line at "Show to
  // agents") — only a person in the workplace, the record — by read right; kind, declared, widened by a person or not, no ids
  r.get("/api/v1/records/:id/derivation", limited(app, "corrections_view"), async c => c.json(await recordDerivation(app, c.get("caller"), c.req.param("id") ?? "")));
  // the "Based on" block of the record page — for all who read the record (not only the author): only a person in the workplace
  // (requireHuman inside), sources — visible to the reader, up to 20; showing closed names — a list event before the answer
  r.get("/api/v1/records/:id/derivation/sources", limited(app, "memory_read"), async c => c.json(await recordDerivationSources(app, c.get("caller"), c.req.param("id") ?? "")));
  // "Who sees" on the record page — only a person in the workplace (requireHuman inside), the record — by read
  // right (loadReadable, the same not_found as memory_read); bucket — memory_read, the content is not read
  r.get("/api/v1/records/:id/readers", limited(app, "memory_read"), async c => c.json(await recordReaders(app, c.get("caller"), c.req.param("id") ?? "")));
  // meeting decisions with kind, term and people — only a person in the workplace (requireHuman inside),
  // the meeting — by read right, cards — by the visibility builder; showing closed — a list event in the log
  r.get("/api/v1/records/:id/decisions", limited(app, "memory_read"), async c => c.json(await meetingDecisions(app, c.get("caller"), c.req.param("id") ?? "")));
  // "Hand over to a project" — only a person in the workplace (requireHuman first inside handover.ts; no MCP tool).
  // The form — its own bucket handover_view (picking a project re-asks it), the hand-over — owner_ops (bucket handover)
  r.get("/api/v1/records/:id/handover", limited(app, "handover_view"), async c => {
    const to = c.req.query("to");
    return c.json(await handoverForm(app, c.get("caller"), c.req.param("id") ?? "", to ? to.slice(0, 100) : null));
  });
  r.post("/api/v1/records/:id/handover", limited(app, "handover"), async c => {
    const caller = c.get("caller"), id = c.req.param("id") ?? "";
    await requireHuman(app, caller, "Hand over a meeting decision to a project", { path: `/records/${id}`, section: "Record" });
    const out = await handover(app, caller, id, await c.req.json().catch(() => null));
    return c.json(out.body, out.status);
  });
  // the "Record edits" menu counter — the same "waiting for your decision" condition as the list (before the /:id/… routes)
  r.get("/api/v1/me/corrections/summary", limited(app, "corrections_view"), async c => {
    const caller = correctionsCaller(c);
    return c.json(await correctionsSummary(app, caller));
  });
  r.get("/api/v1/me/corrections", limited(app, "corrections_view"), async c => {
    const caller = correctionsCaller(c);
    const role = c.req.query("role") ?? "to_confirm";
    if (role !== "to_confirm" && role !== "mine") throw invalid("role: to_confirm or mine");
    return c.json(await myCorrections(app, caller, { role, limit: intQuery(c, "limit", 30, 1, 100), cursor: c.req.query("cursor") }));
  });
  for (const [action, fn] of [["confirm", confirmCorrection], ["reject", rejectCorrection], ["withdraw", withdrawCorrection]] as const) {
    r.post(`/api/v1/me/corrections/:id/${action}`, limited(app, "memory_correct"), async c => {
      const caller = correctionsCaller(c), id = c.req.param("id")!; if (!isUuidParam(id)) throw notFound();
      const body = jsonObjectBody(await c.req.json().catch(() => ({})), "Correction"); rejectUnknownFields(body, []);
      return c.json(await fn(app, caller, id));
    });
  }

  // "Useful", "Wrong / not for everyone", a record's review, the "Common knowledge review" queue and curator decisions — session only
  registerOrgReviewPeople(r, app);

  // the agent's personal notebook: only a person in the workplace turns it on and off —
  // an agent does not do it with its key (like keys); the state is seen in memory_me (`notebook`)
  r.put("/api/v1/me/notebook", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller");
    await requireHuman(app, caller, "Enable or disable agent writes to your personal space", { path: "/keys", section: "Keys and agents" });
    const b = await c.req.json().catch(() => ({}));
    if (typeof b?.enabled !== "boolean") throw invalid("enabled: true or false");
    await app.db.control.query("UPDATE people SET notebook = $2 WHERE id = $1", [caller.person!.id, b.enabled]);
    await audit(app, caller, { event_type: "admin", details: { op: "notebook_set", enabled: b.enabled } });
    return c.json({ enabled: b.enabled });
  });
  // "What my agent sees" and the person's default for new personal records: a person in the workspace only
  registerAgentView(r, app);

  // ---------------------------------------------------------------- workplace sessions
  // Sign-out and own sessions — only by the session itself: a key (personal, "on behalf of", preview) neither sees sessions nor
  // ends them. "End all" ends the current one too — the workplace then leads to sign-in.
  const ownSession = (caller: Caller) => {
    if (caller.keyKind !== "session" || !caller.person) throw new HttpReject(403, "forbidden", "Only the person can manage their workspace sessions from the workspace. Revoke keys under “Keys and agents”");
    return caller.person;
  };
  r.post("/api/v1/auth/logout", async (c) => {
    const caller = c.get("caller"); ownSession(caller);
    if (await endSession(app, caller.keyId, "logout")) await audit(app, caller, { event_type: "admin", details: { op: "session_end", session_id: caller.keyId, reason: "logout" } });
    return c.body(null, 204);
  });
  r.get("/api/v1/me/sessions", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller"); const p = ownSession(caller);
    return c.json({ items: await listSessions(app, p.id, caller.keyId) });
  });
  r.delete("/api/v1/me/sessions/:id", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller"); const p = ownSession(caller);
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    if (!(await endSession(app, id, "ended_by_person", p.id))) throw notFound();
    await audit(app, caller, { event_type: "admin", details: { op: "session_end", session_id: id, reason: "ended_by_person" } });
    return c.body(null, 204);
  });
  r.post("/api/v1/me/sessions/end-all", limited(app, "me_keys"), async (c) => {
    const caller = c.get("caller"); const p = ownSession(caller);
    const ended = await endPersonSessions(app, [p.id], "end_all");
    await audit(app, caller, { event_type: "admin", details: { op: "sessions_end_all", ended } });
    return c.json({ ended });
  });

  // ---------------------------------------------------------------- trash
  // The list — to a person with their personal (extended) key: what they deleted, what a space owner deleted of theirs and
  // what was deleted in spaces they own. Restore and delete forever — only a person in the workplace.
  const trashOwner = (caller: Caller) => {
    if (caller.principalType !== "person" || !caller.person || caller.onBehalfOf) throw new HttpReject(403, "forbidden", "Only a person can access the Trash from the workspace or with their personal key");
  };
  r.get("/api/v1/me/trash", limited(app, ME_LISTS), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me"); trashOwner(caller);
    return c.json(await trashList(app, caller, { limit: intQuery(c, "limit", 50, 1, 100), offset: offsetCursor(c.req.query("cursor")) }));
  });
  r.post("/api/v1/me/trash/:id/restore", limited(app, "memory_delete"), async (c) => {
    const caller = c.get("caller"); trashOwner(caller);
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    return c.json(await restoreFromTrash(app, caller, id));
  });
  r.delete("/api/v1/me/trash/:id", limited(app, "memory_delete"), async (c) => {
    const caller = c.get("caller"); trashOwner(caller);
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    return c.json(await purgeFromTrash(app, caller, id), 202);
  });

  // ---------------------------------------------------------------- "ask to delete"
  // A participant asks in the workplace; the list — to the person (incoming — on their meetings, outgoing — their requests);
  // "keep the meeting" — the owner, in the workplace. Deleted by the owner (plain "delete") and the administrator (the panel).
  r.post("/api/v1/records/:id/deletion-request", limited(app, "memory_delete"), async (c) => {
    // the reason is optional, from a short list; the body may be omitted
    const b = await c.req.json().catch(() => ({}));
    const out = await requestDeletion(app, c.get("caller"), recordId(c), parseDeletionReason((b as { reason?: unknown } | null)?.reason));
    return c.json(out.body, out.status);
  });
  // its own bucket: the workplace frame asks the list on every page (the counter at "Meetings with me") — memory_me is not spent
  r.get("/api/v1/me/deletion-requests", limited(app, "deletion_requests"), async (c) => {
    const caller = c.get("caller"); trashOwner(caller);
    return c.json(await myDeletionRequests(app, caller));
  });
  r.post("/api/v1/me/deletion-requests/:id/decline", limited(app, "memory_delete"), async (c) => {
    const caller = c.get("caller"); trashOwner(caller);
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    return c.json(await declineDeletion(app, caller, id));
  });

  // ---------------------------------------------------------------- "Meetings with me"
  // The list and summary — only to a person in the workplace (own bucket: the frame asks the summary on every page); the meeting
  // members — to everyone who reads it; editing members — to the organizer in the workplace.
  r.get("/api/v1/me/meetings", limited(app, "meetings"), async (c) => {
    const limit = intParam(c.req.query("limit"), 50, 1, 100), offset = offsetCursor(c.req.query("cursor"));
    // filter: search by name and people, "I am the organizer / I am a participant", "only new";
    // ?space= — meetings by project: only "my" meetings linked to a project the person reads
    const space = c.req.query("space") || null;
    if (space !== null && !SLUG_RE.test(space)) throw invalid("space: a project address with Latin letters, digits and hyphens");
    const f = meetingsFilterParams({ q: c.req.query("q"), role: c.req.query("role"), fresh: c.req.query("new") });
    return c.json(await listMyMeetings(app, c.get("caller"), limit, offset, { ...f, space }));
  });
  r.get("/api/v1/me/meetings/summary", limited(app, "meetings"), async (c) => c.json(await meetingsSummary(app, c.get("caller"))));
  // the workplace menu summary in one request: the frame caches it for 30 s per session
  registerMeNav(r, app);
  registerMorningNote(r, app);   // personal morning note: GET and PUT /api/v1/me/morning-note, a person in the workspace only
  // "Handed to me": a custodian reads a departed employee's personal space themselves — only a person in the workplace
  registerCustody(r, app);
  registerEdgeHold(r, app);   // "Show outside again" and the "Outside" block of the record card: only a person in the workplace
  registerOpenRecheckRecord(r, app);   // the open recheck mark and "Keep hidden": only a person in the workplace
  // "My profile": the employee's work profile — only a person in the workplace, under the access.profile_enabled switch
  registerProfileRoutes(r, app);
  // the "How we work" map: GET and PUT /me/spaces/{slug}/guide — only to a person in the workplace;
  // the access.space_guide_enabled switch
  registerSpaceGuideRoutes(r, app);
  registerVersions(r, app, (caller) => requireOp(caller, "read"));   // version history of a document
  // meeting members are data about people: only one with the read operation may read them — a meeting record service
  // without the right to read on behalf of (obo_read) gets 403 before the database query, as with the corrections route
  r.get("/api/v1/records/:id/participants", limited(app, "memory_read"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "read");
    return c.json(await participantsView(app, caller, recordId(c)));
  });
  // the organizer's mark "a project meeting": who sees the meeting does not change
  r.put("/api/v1/records/:id/project-mark", limited(app, "meetings"), async (c) =>
    c.json(await setProjectMark(app, c.get("caller"), recordId(c), await c.req.json().catch(() => null))));
  r.put("/api/v1/records/:id/participants", limited(app, "memory_delete"), async (c) => {
    const body = await c.req.json().catch(() => { throw invalid("Send a JSON request body: {\"participants\": [...]}"); });
    return c.json(await setParticipants(app, c.get("caller"), recordId(c), body));
  });
  // a participant removes themselves from a meeting: from all versions, the organizer sees it and can bring them back
  r.delete("/api/v1/records/:id/participants/me", limited(app, "memory_delete"), async (c) => c.json(await leaveMyMeeting(app, c.get("caller"), recordId(c))));

  // ---------------------------------------------------------------- project spaces
  // Create a project, change name and description, transfer ownership — only a person in the workplace: a person's key — 403 with
  // a link to "Projects" (spaces.ts). Anyone who reads the space reads the card, by key too. Another's or missing — 404,
  // not the owner — 403. The change limit bucket — owner_ops, for the card, groups and members — spaces_view (limits.ts).
  r.post("/api/v1/me/spaces", limited(app, "memory_space_create"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await createProject(app, caller, await c.req.json().catch(() => null)), 201);
  });
  // the person's space list: archived=true — the "Archive" section (archived ones with records they read)
  r.get("/api/v1/me/spaces", limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    const raw = c.req.query("archived");
    if (raw !== undefined && raw !== "" && raw !== "true" && raw !== "false") throw invalid("archived: true or false");
    return c.json(await listMySpaces(app, caller, { archived: raw === "true", limit: intQuery(c, "limit", 50, 1, 100), cursor: c.req.query("cursor") }));
  });
  // archiving and return by the project owner — only a person in the workplace (archive.ts); a repeat — the same card
  r.post("/api/v1/me/spaces/:slug/archive", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await archiveMySpace(app, caller, c.req.param("slug") ?? ""));
  });
  r.post("/api/v1/me/spaces/:slug/unarchive", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await unarchiveMySpace(app, caller, c.req.param("slug") ?? ""));
  });
  // "More about the space": whether description templates are on, and the blank for forms — only a person in the workplace
  r.get("/api/v1/me/space-readme", limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await spaceReadmeConfig(app, caller));
  });
  r.get("/api/v1/me/spaces/:slug", limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await mySpace(app, caller, c.req.param("slug") ?? ""));
  });
  r.patch("/api/v1/me/spaces/:slug", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await updateMySpace(app, caller, c.req.param("slug") ?? "", await c.req.json().catch(() => null)));
  });
  r.post("/api/v1/me/spaces/:slug/owner", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await transferMySpace(app, caller, c.req.param("slug") ?? "", await c.req.json().catch(() => null)));
  });

  // directory groups in spaces: the owner sees the links, by key too; link,
  // unlink and "Update now" — only a person in the workplace (space-groups.ts). Someone else's — 404, not the owner — 403
  r.get("/api/v1/me/spaces/:slug/groups", limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await listSpaceGroups(app, caller, c.req.param("slug") ?? ""));
  });
  r.post("/api/v1/me/spaces/:slug/groups", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    const out = await bindSpaceGroup(app, caller, c.req.param("slug") ?? "", await c.req.json().catch(() => null));
    return c.json(out.group, out.created ? 201 : 200);
  });
  r.post("/api/v1/me/spaces/:slug/groups/sync", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await syncMySpaceGroups(app, caller, c.req.param("slug") ?? ""));
  });
  r.delete("/api/v1/me/spaces/:slug/groups/:id", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await unbindMySpaceGroup(app, caller, c.req.param("slug") ?? "", c.req.param("id") ?? ""));
  });

  // additive: the space owner sees its members — membership metadata, without record contents.
  // Not the owner — 403: they know the space exists anyway (otherwise they would not refer to the slug).
  // groups — linked directory groups the person is in by the membership cache, on a row of any source: the membership
  // row is one (the strongest role wins), and a manual addition of a group member makes it manual
  // Bucket — spaces_view, as for the card and groups: the project page asks the members on every showing and after
  // every form action; in memory_me it shared the window with the frame's memory_me — after 15 showings the workplace stalled
  // A member and a reader see the members without email and basis (view: reader), for
  // a department — only the count (view: count); to the owner — as before plus the invited (view: owner). space-people.ts
  r.get("/api/v1/me/spaces/:slug/members", limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await spaceMembersView(app, caller, c.req.param("slug") ?? ""));
  });
  // "Call in": with the "member" or "read only" role; one who never signed in —
  // by invitation until first sign-in. A manual member's role and cancelling an invitation — there too. Only in the workplace
  r.post("/api/v1/me/spaces/:slug/members", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    const out = await callToSpace(app, caller, c.req.param("slug") ?? "", await c.req.json().catch(() => null));
    return c.json(out, out.status === "already" ? 200 : 201);
  });
  r.put("/api/v1/me/spaces/:slug/members/:login", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await setMemberRole(app, caller, c.req.param("slug") ?? "", decodeURIComponent(c.req.param("login") ?? ""), await c.req.json().catch(() => null)));
  });
  r.delete("/api/v1/me/spaces/:slug/invites/:login", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await cancelInvite(app, caller, c.req.param("slug") ?? "", decodeURIComponent(c.req.param("login") ?? "")));
  });
  // "Who sees new records": the owner changes it themselves, to "and AI agents" — with open_ack
  r.post("/api/v1/me/spaces/:slug/class", limited(app, "me_spaces"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await changeSpaceClass(app, caller, c.req.param("slug") ?? "", await c.req.json().catch(() => null)));
  });
  // "Space overview": decisions, questions and risks, deadlines, directions and deals, "for the week" — within the
  // reader's rights, to anyone who reads the space (like the card); not a search. The onboarding.space_overview_enabled switch
  r.get("/api/v1/me/spaces/:slug/overview", switchedOn(() => requireOverviewEnabled(app)), limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await spaceOverview(app, caller, c.req.param("slug") ?? "", { block: c.req.query("block"), cursor: c.req.query("cursor"), omit: c.req.query("omit") }));
  });
  // "Can be added": own meetings for 90 days where more than half the participants are members of the space —
  // to a writer of the space; not a search. Moving — by a plan (memory_plan op promote). The onboarding.addable_enabled switch
  r.get("/api/v1/me/spaces/:slug/addable", switchedOn(() => requireAddableEnabled(app)), limited(app, "spaces_view"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "me");
    return c.json(await spaceAddable(app, caller, c.req.param("slug") ?? "", { cursor: c.req.query("cursor") }));
  });
  // space export: a streamed tar.gz of what the person reads in the space, and its preview — workplace session only
  registerExport(r, app);

  // ---------------------------------------------------------------- transcript intake
  // a service — on behalf of the initiator (X-On-Behalf-Of); a person's key — the scripts' fallback path: the meeting
  // goes to the key owner, the "on behalf of" header does not work for a personal key, initiator is optional
  r.post("/api/v1/ingest/transcripts", limited(app, "ingest"), async (c) => {
    const caller = c.get("caller");
    const channel: MeetingChannel = caller.principalType === "service" ? "service" : "script";
    if (channel === "service") requireService(caller, "ingest_transcripts"); else requireOp(caller, "ingest_transcripts");
    meetingOwner(caller, channel);                      // X-On-Behalf-Of and the key kind — before body parsing, as before
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    // agentMarks — a participant as an object {name, is_agent} and segments[].is_agent: only accepted and stored
    const r = await acceptMeeting(app, caller, channel, parseMeetingBody(b, { initiatorRequired: channel === "service", agentMarks: true }));
    return c.json(r.body, r.status);
  });

  // a participants check without a write: the transcriber's send window — where the meeting will land and who is in memory
  r.post("/api/v1/ingest/participants/check", limited(app, "ingest"), async (c) => {
    const caller = c.get("caller");
    requireService(caller, "ingest_transcripts");
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    return c.json(await checkParticipants(app, caller, b));
  });

  // the participants' consent text and its version: the transcriber's send window, the person's agent and script show it
  // to the sender before the checkbox. To those who accept meetings: a service with ingest_transcripts, a person's key or session
  r.get("/api/v1/meetings/consent", async (c) => {
    const caller = c.get("caller");
    if (caller.principalType === "system") throw new HttpReject(403, "forbidden", "The system key is for the admin API only");
    if (caller.principalType === "service" && !caller.allowedOps?.has("ingest_transcripts")) throw new HttpReject(403, "forbidden", "Operation ingest_transcripts is outside the service’s allow-list");
    return c.json(consentText(app));
  });

  // a one-time meeting upload link: a person's key, the script channel; the meeting description is checked at once
  r.post("/api/v1/meetings/uploads", limited(app, "meeting_upload"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "meeting_upload");
    meetingOwner(caller, "script");
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    return c.json(await issueUpload(app, caller, "script", b), 201);
  });

  // a daily reconcile: what memory accepted from THIS service — only a service key, only its records, without content
  r.get("/api/v1/ingest/transcripts", limited(app, "ingest"), async (c) => {
    const caller = c.get("caller"); requireService(caller, "ingest_transcripts");
    const date = c.req.query("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid("date must use the YYYY-MM-DD format");
    const limit = intQuery(c, "limit", 200, 1, 500);
    const tz = nightWindowOf(app.settings).tz;
    const accepted: any[] = [];
    for (const cls of caller.scope.classes) {
      const db = app.db.records(cls, caller.scope);
      const { rows } = await db.query(
        `SELECT r.id, r.source_ref, r.version, r.ingested_at, (SELECT count(*) FILTER (WHERE s.status IN ('done','skipped')) FROM record_stages s WHERE s.record_id = r.id)::int AS done,
                (SELECT count(*) FROM record_stages s WHERE s.record_id = r.id)::int AS total
         FROM records r WHERE r.source_kind = 'transcriber' AND r.deleted_at IS NULL AND r.attrs #>> '{access,asserted_by}' = $2
           AND (r.occurred_at AT TIME ZONE $4)::date = $1::date ORDER BY r.ingested_at LIMIT $3`, [date, caller.service!.name, limit, tz]);   // by started_at in the instance time zone
      accepted.push(...rows.map((x) => ({ meeting_id: x.source_ref, id: x.id, version: x.version, received_at: new Date(x.ingested_at).toISOString(), stages_done: x.done, stages_total: x.total })));
    }
    return c.json(serializeMeeting("ReconcileResult", { date, accepted, next_cursor: null }, "base"));
  });

  // additive (the role model): a source reports the new reader list of its object; a cascade to derived ones
  r.put("/api/v1/ingest/access", limited(app, "ingest"), async (c) => {
    const caller = c.get("caller"); requireService(caller, "ingest_transcripts");
    if (!caller.onBehalfOf || !caller.person) throw new HttpReject(403, "forbidden", "Set X-On-Behalf-Of to the object owner’s login");
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    return c.json(await ingestAccess(app, caller, b));
  });

  // ---------------------------------------------------------------- document intake (button; shared bucket)
  r.post("/api/v1/ingest/documents", limited(app, "ingest"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "ingest_documents");
    if (!caller.person) throw new HttpReject(403, "forbidden", "A person is required. Use a personal key or X-On-Behalf-Of");
    const ct = c.req.header("content-type") ?? "";
    let args: Parameters<typeof upload>[2];
    if (ct.startsWith("multipart/form-data")) {
      const f = await c.req.parseBody();
      const file = f.file;
      if (!(file instanceof File)) throw invalid("Provide the file field");
      args = { filename: file.name, mime: file.type || "application/octet-stream", bytes: Buffer.from(await file.arrayBuffer()), space: f.space as string | undefined, title: f.title as string | undefined, occurred_at: f.occurred_at as string | undefined, entities: commaList(f.entities, ENTITIES_MAX), domains: commaList(f.domains),
               // a new version of a document (a text field; a file under this name is not an id)
               ...(f.replaces !== undefined ? { replaces: f.replaces as string } : {}) };
    } else {
      // by object key — only a service (button, converter) and only from the incoming zone: else any key would read others' bucket originals
      const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
      if (!b?.object_key || !b?.filename || !b?.mime) throw invalid("Provide object_key, filename and mime");
      if (caller.principalType !== "service") throw invalid("Ingestion with object_key is for services. With a personal key, upload the file as multipart/form-data");
      const prefix = app.settings.get("storage.inbox_prefix", "inbox/");
      if (typeof b.object_key !== "string" || !b.object_key.startsWith(prefix) || b.object_key.includes("..")) throw invalid(`object_key must start with ${prefix}`);
      // the map with the archive: an archived one — class_denied with details.archived before reading the incoming, like upload()
      const space = await resolveSpace(app, caller, b.space ?? "me", await readableSpaces(app, caller, { archived: true }));
      if (!space) throw notFound();
      if (space.archived_at) throw archivedDenied(space.slug, space.archived_at);
      serviceSpaceOnly(caller, space);                   // a service with write space — before reading the incoming, as upload()
      // the size limit — before reading into memory: an incoming zone object did not pass intake
      const bytes = await app.storage.get(space.default_class, b.object_key, app.settings.get("limits.upload_max_bytes", 20_971_520)).catch((e: Error) => {
        if (e instanceof MemoryError && e.code === "too_large") throw e;
        log.warn("inbox_object_unavailable", { error: e.message.slice(0, 120) }); return null;
      });
      if (!bytes) throw notFound();
      args = { filename: b.filename, mime: b.mime, bytes, space: b.space, title: b.title, occurred_at: b.occurred_at, entities: b.entities, domains: b.domains, sourceRef: b.source_ref,
               ...(b.replaces !== undefined ? { replaces: b.replaces } : {}) };
    }
    const done = await upload(app, caller, args), out = done.result;
    // the real version of the answered document (a new version, or the current version a repeat resolved to)
    const chain = "chain" in done && done.chain ? done.chain : { version: 1, supersedes_id: null };
    // placed/note: when the file is known but no placement into the requested space was made (the closed class, a personal
    // key), the client must see it — before, the answer text was lost on the way from MCP to REST
    return c.json({ id: out.id, path: out.path, type: "document", space: out.space, class: out.class, version: chain.version, supersedes_id: chain.supersedes_id,
                    // a PDF or office file as a new version replaces the current one after conversion
                    ...("pending" in chain && chain.pending ? { version_pending: true } : {}),
                    already_known: out.already_known, placed: out.placed, note: out.note, stages: out.stages, queue: out.queue,
                    // personal open: the check outcome — to the author; for one's own record closed by the check — the reason
                    ...("open_check" in out && out.open_check ? { open_check: out.open_check } : {}) }, out.already_known ? 200 : 201);
  });

  // ---------------------------------------------------------------- records
  const recordId = (c: Context): string => { const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound(); return id; };   // non-uuid: not 500

  /**
   * One record's state: stages, queue, derived ones, conversion, the source restriction. `shown` — closed
   * derived ones whose names got into the answer: the route writes one log event about them before the answer.
   * `withDerived: false` (`?derived=false`) — only stages: no derived ones in the answer, they are not read or logged
   * (the Overview, "My records" and polling their badges show no names). `o.title` — the record's name and time
   * (`?with=title`, only to a person in the workplace).
   */
  const statusOf = async (caller: Caller, id: string, shown: string[], withDerived = true, o: { title?: boolean; version?: boolean } = {}) => {
    // own closed record by a key without the closed class: stages, no content. A service without reading did not accept such
    // a record: a service key without the closed class is T1, and T1 does not write into closed (classFor) — 404
    const hidden = await ownHiddenRecord(app, caller, id);
    if (hidden && serviceWithoutRead(caller)) throw notFound();
    if (hidden) return { ...hidden, queue: { lane: "night" as const, position: null, eta_sec: null }, derived: [], conversion: null, access: { restricted_by_source: false } };
    const { rec, db, spaces } = await loadReadable(app, caller, id);
    if (statusForeignToService(caller, rec.attrs?.access?.asserted_by)) throw notFound();
    // names of derived ones — only those readable by id and not held "Wrong" in org (to an agent not of the author)
    const derived = withDerived ? await dropHeldDerived(app, caller, rec, await derivedVisible(db, caller, rec, spaces)) : [];
    if (rec.class === "closed") shown.push(...derived.filter((d) => d.title).map((d) => d.id));   // derived: in the record's class DB
    const slug = spaces.get(rec.space_id)?.slug ?? (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [rec.space_id])).rows[0]?.slug ?? "unknown";
    const openCheck = await ownOpenCheck(app, caller, rec);
    const openAccepted = await ownOpenAccepted(app, caller, rec, openCheck);
    const stages = await stagesOf(db, rec.id, { extended: true });   // with the retry term and the "busy" counters
    return { id: rec.id, path: recordPath(slug, rec.type, rec.occurred_at, rec.id), type: rec.type, class: rec.class,
             // name and time — on request (with=title) and only to a person in the workplace: the decision
             // page shows "From the meeting "…" · 5 October" and "← Meeting" by the meeting status, without memory_read (a read
             // of the whole closed meeting). The hidden locator above has none
             ...(o.title ? { title: rec.title ?? null, occurred_at: new Date(rec.occurred_at).toISOString() } : {}), stages,
             // the lane and the wait reason: pause, "busy" with a term, "too slow"
             queue: await queueOf(app, rec.attrs, undefined, { extended: true, stages }),
             derived: derived.map((d) => ({ id: d.id, type: d.type, event_kind: d.event_kind, title: d.title ?? "" })),
             // a converter document: state, run result, whether it is certified; since 0.17.0 — phase, position (by stage), file to agents
             conversion: conversionView(rec.attrs, stages, rec.class),
             access: { restricted_by_source: rec.attrs?.access?.restricted_by_source === true },   // the source restricted a promoted record
             // closed by the open check (personal open): the reason — only to the author and only for a closed one,
             // from the locator — as in memory_read (attrs are history, their mark survives opening)
             ...(openCheck ? { open_check: openCheck } : {}),
             // a trace of an earlier opening by word on a closed one: to show it again — "Make available to agents"
             ...(openAccepted ? { open_check_accepted: openAccepted } : {}),
             // the badge of "My records" — an uploaded document with earlier versions, a converted new version waiting
             // or refused; only on request (with=version, a workspace session) and only for such a document,
             // so every other answer stays as the contract describes it
             ...(o.version ? versionStatusFields(rec) : {}) };
  };

  // For tests only: there is no permanent external links API yet.
  r.get("/api/v1/records/:id/links", limited(app, "memory_read"), async (c) => {
    if (!linksTestHookOn(app)) throw notFound();
    const caller = c.get("caller"); requireOp(caller, "read");
    const id = c.req.param("id");
    if (typeof id !== "string" || !isUuidParam(id)) throw notFound();
    await loadReadable(app, caller, id);
    const { links } = await linksVisibleTo(app, caller, [id], { statuses: linkStatuses(c.req.query("status")) });
    return c.json({ items: links });
  });

  /** `?derived=false` — state without derived ones (only stages); empty or `true` — with derived ones, otherwise 400. */
  const derivedParam = (c: Context): boolean => {
    const v = c.req.query("derived");
    if (v !== undefined && v !== "" && v !== "true" && v !== "false") throw invalid("derived: true or false");
    return v !== "false";
  };

  // Batch state: one pass instead of 50 requests from the "My records" page.
  // Rights — the same as for the single route; unavailable and missing ids are silently dropped (someone else's = missing).
  r.get("/api/v1/records/status", limited(app, "status"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "status");
    const ids = [...new Set((c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) throw invalid("ids: a comma-separated list of record IDs");
    if (ids.length > 50) throw invalid("ids accepts at most 50 IDs at a time");
    const withDerived = derivedParam(c);
    // `with` — a comma list: `title`, `version`; both only for a person in the workspace
    const withs = new Set((c.req.query("with") ?? "").split(",").map((s) => s.trim()));
    const withTitle = withs.has("title") && isHumanSession(caller), withVersion = withs.has("version") && isHumanSession(caller);
    const items = [], shown: string[] = [];
    for (const id of ids) {
      if (!isUuidParam(id)) continue;
      try { items.push(await statusOf(caller, id, shown, withDerived, { title: withTitle, version: withVersion })); } catch (e) { if (!(e instanceof MemoryError)) throw e; }
    }
    // names of closed derived ones — one event for the whole batch and only when they are given ("My records" polling is limited)
    await auditShownClosed(app, caller, shown, "status_derived");
    // names of closed records shown to a person — a list log event, as for correction rows (without content)
    const closedTitled = withTitle ? items.filter((x) => x.class === "closed" && "title" in x).map((x) => x.id) : [];
    if (closedTitled.length) await auditRead(app, caller, { event_type: "list", class: "closed", record_ids: closedTitled, details: { op: "status_title" } });
    return c.json({ items });
  });

  r.get("/api/v1/records/:id/status", limited(app, "status"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "status");
    const shown: string[] = [], out = await statusOf(caller, recordId(c), shown, derivedParam(c));
    await auditShownClosed(app, caller, shown, "status_derived");
    return c.json(out);
  });

  // open a class: only a person in the workplace. An optional body {despite_findings, consent} —
  // "Make available to agents" with the consent from the preview; no body, an empty body or false — the old behavior (an agent
  // opens with memory_open)
  r.post("/api/v1/records/:id/open", limited(app, "memory_open"), async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    const body = parseOpenBody(await c.req.text().catch(() => ""));
    const out = await open(app, caller, { id, despite_findings: body.despite_findings, ...(body.consent !== undefined ? { consent: body.consent } : {}) });
    return c.json(out.result, out.result.status === "in_progress" ? 202 : 200);
  });

  // the "Make available to agents" preview: what the check found, who will see it, a consent token for 15 minutes. Only a work
  // place session and only the author (not the author — 404); own bucket open_preview — not owner_ops: the record page asks it
  // on every panel showing, and "Show", "Close" and a move must not hit the previews
  r.post("/api/v1/records/:id/open/preview", limited(app, "open_preview"), async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound();
    parsePreviewBody(await c.req.text().catch(() => ""));
    return c.json(await openPreview(app, caller, id));
  });
  // the "Make available to agents" switches: the record page hides the link where showing is off. Only a work
  // place session; its own bucket show_anyway: the record page asks it on every showing, while in the memory_me bucket
  // (for a session — the session_me window) it shared the window with the frame's /me, as project members did before spaces_view
  r.get("/api/v1/me/show-anyway", limited(app, "show_anyway"), async (c) => c.json(await showAnywayToggles(app, c.get("caller"))));

  r.post("/api/v1/records/:id/process-now", async (c) => {
    const caller = c.get("caller"); requireOp(caller, "process_now");
    const id = recordId(c);
    const out = await processNow(app, caller, id);
    const slug = (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [out.slugPath.space_id])).rows[0]?.slug ?? "unknown";
    const loc = await loadReadable(app, caller, id);
    return c.json({ id: out.result.id, path: recordPath(slug, out.slugPath.type, loc.rec.occurred_at, out.result.id), type: out.slugPath.type, class: loc.rec.class, stages: out.result.stages, queue: out.result.queue, priority_raised: out.result.priority_raised }, 202);
  });

  r.get("/api/v1/records/:id/original", limited(app, "original"), async (c) => {
    const caller = c.get("caller"); requireOp(caller, "original");
    const { rec } = await loadReadable(app, caller, recordId(c));
    const info = await originalInfo(app, caller, rec.id, rec.class);
    const url = info ? await signedOriginalUrl(app, caller, rec.id, rec.class) : null;
    if (!info || !url) throw notFound();
    // a link to a closed original is already a giving of closed: the log did not accept the event — no link. The file of a record
    // shown to agents "as text only" lies in the closed bucket — and in the log it is closed
    await auditRead(app, caller, { event_type: "read", class: originalBucket(rec.class, info.original_closed), record_ids: [rec.id], space_id: rec.space_id, details: { op: "original_link" } });
    const ttl = app.settings.get("access.original_link_ttl_sec", 600);
    return c.json({ url, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), mime: info.original_mime, bytes: Number(info.original_bytes ?? 0), filename: rec.attrs?.filename });
  });

  // the admin API — here only in legacy; with a separate listener (MEMORY_ADMIN_LISTEN) admin-plane/app.ts mounts it
  // legacy (the admin listener is not separate): the second_signature route with signing on — 403 approval_required
  if (!o.adminSeparate) { r.use("/api/v1/admin/*", mainListenerApprovalGuard(app)); r.route("/api/v1/admin", adminRoutes(app)); r.route("/", alertsRoutes(app, { alertsOnly: true })); }
  return r;
}

/**
 * Body of POST /records/{id}/open: empty — `{despite_findings: false}`; otherwise strictly the object
 * `{despite_findings?: boolean, consent?: string (1..4096)}`, else — 400. open() decides whether `consent` is needed: with
 * the "despite a finding" open check off — a plain opening, also without it.
 */
export function parseOpenBody(raw: string): { despite_findings: boolean; consent?: string } {
  if (!raw.trim()) return { despite_findings: false };
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw invalid("Send a JSON request body of {\"despite_findings\": true, \"consent\": \"…\"} or leave it empty"); }
  const b = jsonObjectBody(body, "{despite_findings, consent}");
  rejectUnknownFields(b, ["despite_findings", "consent"]);
  if (b.despite_findings !== undefined && typeof b.despite_findings !== "boolean") throw invalid("despite_findings must be true or false");
  if (b.consent !== undefined && (typeof b.consent !== "string" || !b.consent.length || b.consent.length > CONSENT_MAX_LEN)) throw invalid(`consent: a string of 1 to ${CONSENT_MAX_LEN} characters`);
  return { despite_findings: b.despite_findings === true, ...(typeof b.consent === "string" ? { consent: b.consent } : {}) };
}

/** Body of POST /records/{id}/open/preview: empty or `{}`, anything else — 400. */
export function parsePreviewBody(raw: string): void {
  if (!raw.trim()) return;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw invalid("The request body must be empty or {}"); }
  rejectUnknownFields(jsonObjectBody(body, "{}"), []);
}
