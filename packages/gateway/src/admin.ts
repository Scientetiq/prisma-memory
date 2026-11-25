import { rememberSsoLoginState, ssoLoginDefault, type SsoChange } from "./admin-plane/sso-login-watch.ts";
import { registerModelsAdmin } from "./models-admin.ts";
import { orgTableSource } from "@memory/shared";
import { fmtDateTime } from "@memory/i18n";
import { instanceLocale } from "@memory/i18n/context";
import { oauthPolicyLock, revokeOAuthOutsidePolicy, revokePersonConnections } from "./oauth.ts";
import { agentAuthStepNeeded, applyAgentAuthPolicy, futureSettings } from "./agent-auth/policy-step.ts";
import { agentAuthFacts } from "./agent-auth/readiness.ts";
import { loginPolicyLock, withSettingsTx } from "./login-policy.ts";
import { AGENT_AUTH_PROBLEM_TEXT, agentAuthMode, agentAuthProblems, conflict, effectiveMode, isHumanSession, raiseAlert, testHooksEnabled, type AlertInput } from "@memory/shared";
import { approvalIdOf, approverOf, HUMAN_SESSION_REQUIRED, requireApproval, secondSignatureOn, setConditionalApprovalsWired, wouldRequireApproval } from "./admin-plane/approvals.ts";
import { annotate as annotateSettings, check as checkSettings, contourCheck, externalContourLock, notePreMail, SECURITY_MODE_CHANGED, securityModeInTx, settingAuditDetails, settingsSaved,
         transportPreMail } from "./admin-plane/settings-guard.ts";
import { createAdminSession, revokeLocalSessions, revokeAdminSessions } from "./admin-plane/session.ts";
import { localTotpAdminRoutes, localTotpBody } from "./local-totp-routes.ts";
import { NOT_FOUND_BODY } from "./channel.ts";
import { resetLocalTotp, setLocalTotpSetupAvailable, checkLocalSecondFactor, noteFactorlessLogin, otpShapeOk, type FactorCheck } from "./admin-plane/local-totp.ts";
import { humanSessionsHere } from "./admin-plane/human-only.ts";
import { adminLoginTokenKind } from "./admin-plane/legacy-token.ts";
import { adminClientIp, directAdminCall } from "./admin-plane/middleware.ts";
import { currentListener } from "./admin-plane/listeners.ts";
import { breakglassState } from "./admin-plane/breakglass.ts";
import { BREAKGLASS_ONLY } from "./admin-plane/responses.ts";
import { identityChangeMail, identityChangeMailKey, identityMailable, type IdentityLinkChange } from "../../shared/src/identity-mail.ts";
import { canonicalObjectGuid, clearOAuthProviders, CLOUD_AGENT_BASE_SETTING, cloudOAuthMismatch, deployProfile, isNetBound, keyNetworkProblem, isShowcaseLogin, isTestDomainLogin, oauthConfig, oauthProblems, parseCaCerts, testLoginSql, type OidcConfig, type Settings } from "@memory/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { ensureProjectEntity } from "@memory/shared";
import { chainPick, CUSTODY_TEXTS, CustodyRefusal, custodyChainHolds, custodyDataSql, custodyDeletes, custodyMailable, custodyOffMail, custodyOp, custodyPolicy, custodyWorld, CUSTODY_DETACHED_ATTR, detachedOf, enqueueMail, inCustodyScope, fallbackTz, instanceTz, lateManager, lockCustody, meetingsHandedFrom, meetingsMovedOf, setCustodian, showcaseSql, syncCustody, type CustodyChange, type CustodyPerson, type CustodyPolicy, type CustodyWorld } from "@memory/shared";
import { BUILTIN_OPEN_CHECK_RULES, builtinRuleStates, ConverterClient, embeddingsConnectionField, embeddingsModelChangeProblem, embeddingsModelValueProblem, embeddingsSlotChangeProblem, ConverterError, converterConfig, extraRuleRunsAs, openCheckRunnerState, openCheckSettingProblems, openCheckSettings, openCheckTestRefusal, OpenCheckTimeout, converterMissing, generateApiKey, hashAdminPassword, invalid, LDAP_IDENTITY_KEYS, ldapConfig, ldapProblems, log, OIDC_IDENTITY_KEYS, oidcConfig, oidcDiscoveryUrl, oidcProblems, smtpConfig, smtpProblems, MemoryError, newId, notEmpty, notFound, orgUnitId, personId, recordPath, slugify, SettingsTypeError, tx, type Category } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { createLinkTestHook, linkCopies, linksTestHookOn } from "./links.ts";
import { HttpReject, t1Allowed, workplaceClientAddress } from "./auth.ts";
import { closeServiceConsents, serviceConsentsClosedAudit } from "./obo-consent.ts";
import { custodyDetachedAmong, ensurePersonalSpace, insertSpace, lockReconcile, markCustodyDetached, OWNER_IN_FORCE_SQL, readableSpaces, reconcileAccess, renamePersonLogin, setSpaceOwner, slugCandidates } from "./access.ts";
import { audit, parseEventTypes } from "./audit.ts";
import { adminAuditPage } from "./admin-audit.ts";
import { buildClientMismatch, type ClientKeyRow, type ClientSeenRow } from "./client-report.ts";
import { movesReport } from "./report-moves.ts";
import { extendedOpenReport } from "./report-extended.ts";
import { orgReviewReport } from "./report-org-review.ts";
import { DESPITE_MOVE_SQL, despiteReport, registerDespiteAdmin } from "./report-despite.ts";
import { registerOpenRecheckAdmin } from "./open-recheck-admin.ts";
import { emptyQueryTextsAllowed, outcomeRow, outcomesRunning, searchQuality, searchQualitySummary } from "./report-search-quality.ts";
import { rolloutReport } from "./report-rollout.ts";
import { nightCapReport } from "./night-cap.ts";
import { backupsReport } from "./backup-report.ts";
import { MANUAL_TIME_PARAM, manualTimeSection } from "./report-wall-time.ts";
import { decodeKeyset, encodeKeyset, intParam, isUuidParam, keysetAtSql, keysetCompare, offsetCursor } from "./paging.ts";
import { SESSION_CLOCK_SKEW_SEC, SESSION_TTL_SEC, signSession, verifyAdminPasswordAsync, loginFailures, LoginFailures, type SessionFactor } from "./session.ts";
import { fromWorkplace } from "./workplace.ts";
import { ownNetworks, trustedProxies } from "./channel.ts";
import { suppliedFirstRunCode, announceGeneratedFirstRunCode, firstRunCodeRefusal, firstRunCodeRequired, forwardingSigns, requiredFirstRunCode, type RequiredFirstRunCode } from "./first-run-code.ts";
import { stagesOf, tagSpaceRecords } from "./records.ts";
import { resetHealthCache } from "./health.ts";
import { personKeyExpiry } from "./key-expiry.ts";
import { issueClientKind, issueOpenWrite, jsonObjectBody, keyPatchOpenWrite, rejectUnknownFields } from "./key-kind.ts";
import { createSession, endPersonSessions, endSourceSessions, TEST_SESSION_TTL_SEC, testSessionsOn } from "./user-sessions.ts";
import { importedIdentityOwner, registerLdapAdmin, upsertImportedIdentity } from "./ldap-login.ts";
import { registerLocalAccountsAdmin } from "./local-accounts-admin.ts";
import { registerLocalAccountsManage } from "./local-accounts-manage.ts";
import { providers, registerOidcAdmin } from "./oidc-login.ts";
import { mailNotifierFor } from "./identity.ts";
import { registerMailAdmin } from "./mail-admin.ts";
import { registerEdgeExportAdmin } from "./edge-export-admin.ts";
import { registerEdgeAdmin } from "./edge-admin.ts";
import { externalAccessInstalled, externalAdLinkChanged } from "./external-access.ts";
import { registerStatusAdmin } from "./admin-status.ts";
import { registerAgentAuthAdmin } from "./agent-auth/admin.ts";
import { LLM_STAGES, llmSettingsSaved, registerLlmGateRoutes } from "./llm-gate-admin.ts";
import { registerConverterAdmin, WAKE_AFTER_ACTION_MAX, waitingConverterGroup, wakeConverterWaiting } from "./converter-admin.ts";
import { registerDeletionAdmin } from "./deletion-requests.ts";
import { registerConnectorsAdmin } from "./connectors/admin.ts";
import { registerOrgReviewAdmin } from "./org-review.ts";
import { adminLoginOf, operatorOf, operatorPerson, personByLogin, registerOperatorAdmin } from "./operator.ts";
import { grantPendingMeetings } from "./participants.ts";
import { grantSpaceInvites } from "./space-people.ts";
import { openFindings, SPACE_META_FIELDS } from "./open-check.ts";
import { archivedManageDenied, checkSpaceMeta, groupSyncState, metaAfterUpdate, spaceGroupsOf, spaceMetaTexts } from "./spaces.ts";
import { liveRecords, setArchived, syncAfterUnarchive } from "./archive.ts";
import { ORG_SPACE_DESCRIPTION, ORG_SPACE_NAME } from "./org-space.ts";
import { peopleOf, syncGroups, unbindSpaceGroup } from "./space-groups.ts";

type Env = { Variables: { caller: Caller; admin: string; breakglassNarrowOnly?: boolean } };

export const APPROVER_IS_SUBJECT = { code: "approval_self", message: "Another person must sign a request for an action affecting you. The signer would gain access through this request. Submit it again" } as const;

export async function testPurgeReport(app: App) {
  const ctl = app.db.control;
  const state = ((await ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'test_purge'", [app.instanceId])).rows[0]?.value ?? {}) as Record<string, unknown>;
  const mode = app.settings.get<unknown>("access.test_purge", "off") === "auto" ? "auto" : "off";
  const raw = app.settings.get<unknown>("access.test_purge_after_hours", 24);
  const afterHours = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 8760 ? raw : 24;
  const overdue = (await ctl.query(
    `SELECT count(*)::int AS n FROM spaces WHERE instance_id = $1 AND slug LIKE 'zz-smoke-%' AND archived_at < now() - make_interval(hours => $2)`,
    [app.instanceId, afterHours + 2])).rows[0].n as number;
  return { at: state.at ?? null, blocked: Array.isArray(state.blocked) ? state.blocked : [], progress: state.progress ?? null, last_manual: state.last_manual ?? null,
           last_auto: state.last_auto ?? null, backlog: state.backlog ?? null, kept: state.kept ?? null, mode, after_hours: afterHours, smoke: { overdue } };
}

/** The calendar day of an instant in the installation's zone, in the installation's language: en YYYY-MM-DD, ru DD.MM.YYYY. */
export const dayText = (d: Date | string, tz = fallbackTz()): string => fmtDateTime(instanceLocale(), tz, d, "date");

export const reactivationConfirmText = (since: Date | string | null, why: "kept" | "manager" | "meetings" = "kept", tz?: string): string =>
  `the employee is inactive${since ? ` ${dayText(since, tz)}` : ""}, ${why === "manager" ? "they manage former employees whose records are retained"
    : why === "meetings" ? "their meetings were handed over to other employees and will be returned to them" : "their records are retained"}. Reactivate the existing profile only if it is the same person: the employee ID matches or their return has been confirmed`;

export const REACTIVATION_LATE =
  "The import would make the reactivated profiles of former managers the custodians of their former reports’ records. Confirm the managers’ return. Nothing changed";

export const CUSTODIAN_OPERATOR_ROW =
  "the row lists you, the memory administrator, as the former employee’s manager, but their profile lists a different manager. This would make you the custodian of their records. Leave the manager blank or correct the row. You can assign a custodian in the employee’s profile";
export const identityVerifiedIgnoredRow = (idn: string): string =>
  `identity link ${idn}: the org table cannot set verified. The link was saved as unverified. Only the person’s own sign-in can verify it. Already verified links stay verified`;

export const CUSTODIAN_IS_OPERATOR = "custodian_is_operator";
const custodianIsOperator = (message: string, login: string): MemoryError =>
  new MemoryError("invalid_argument", message, { reason: CUSTODIAN_IS_OPERATOR, details: { reason: CUSTODIAN_IS_OPERATOR, logins: [login] } });
export const custodianOperatorWarning = (logins: readonly string[]): string =>
  `under this rule you would become the custodian of former employees’ records (${logins.slice(0, 10).join(", ")}${logins.length > 10 ? ` and ${logins.length - 10} more` : ""}) because you imported or signed off on the org table as memory administrator. Administration gives no read access. The import was rejected and nothing changed. Assign a different custodian in the employee’s profile or correct the managers in the org table`;

export const custodyManagerMissingRow = (manager: string): string =>
  `manager ${manager} was not found in the import or in memory. The department head will be the custodian of the former employee’s records unless you assign someone. If ${manager} appears in memory later, assign them in the employee’s profile if they should become the custodian`;

export const custodyManagerLateRow = (manager: string): string =>
  `manager address ${manager} first appeared in memory after the employee left. The manager will not automatically become the custodian of the employee’s records. If this is the correct manager, assign them in the employee’s profile`;

export const custodyDetachedRow = (d: { person: string; snapshot: boolean }, from: string, to: string): string =>
  `${to} is listed in the org table as former employee ${d.person}’s manager, but the address was new to memory. An employee has now changed their e-mail address (${from} → ${to}), and `
  + (d.snapshot ? `they will not automatically become the custodian of ${d.person}’s records. If they are ${d.person}’s manager, assign them as custodian in ${d.person}’s profile`
                : `they will not automatically become custodian through ${d.person} in the management chain. If they are the correct manager, assign the custodian manually in the former employee’s profile`);

export const CUSTODIAN_OPERATOR_UNLINKED_ROW =
  "the row lists a different manager for the former employee than their profile, and “Administrator access” does not list you. The memory cannot check whether you would become the custodian of their records. List yourself in “Administrator access” and import again, or leave the manager blank";

export async function reactivationProof(q: Queryable, instanceId: string, policy: CustodyPolicy, p: { id: string; login: string },
                                        records: () => readonly Queryable[],
                                        snapshots?: ReadonlyMap<string, { manager: string | null; units: readonly string[] }>):
    Promise<{ since: Date | null; why: "kept" | "manager" | "meetings" | null } | null> {
  const liveOnly = custodyDeletes(policy, p.login);
  const r = (await q.query(
    `SELECT s.archived_at, COALESCE(s.archived_at <= now() - make_interval(days => $3::int), false) AS due,
            EXISTS (SELECT 1 FROM personal_custody c WHERE c.person_id = $1) AS held,
            (s.id IS NOT NULL AND ${custodyDataSql("$1::uuid", "s.id", liveOnly)}) AS has_data,
            EXISTS (SELECT 1 FROM personal_custody c WHERE c.instance_id = $2 AND c.person_id <> $1 AND (c.manager_login = lower($4) OR c.custodian_id = $1)) AS names
       FROM people p LEFT JOIN spaces s ON s.kind = 'personal' AND s.owner_id = p.id
      WHERE p.id = $1 AND COALESCE(p.attrs->>'demo', '') <> 'true'`, [p.id, instanceId, policy.afterDays, p.login])).rows[0];
  if (!r) return null;
  if (r.due && (r.held || (inCustodyScope(policy, p.login) && r.has_data))) return { since: r.archived_at ?? null, why: "kept" };
  if (await meetingsHandedFrom(records(), p.id)) return { since: r.archived_at ?? null, why: "meetings" };
  if (!r.due) return null;
  return { since: r.archived_at ?? null, why: r.names || await custodyChainHolds(q, instanceId, p.id, policy, snapshots) ? "manager" : null };
}

export async function managerOfKept(q: Queryable, instanceId: string, policy: CustodyPolicy, p: { id: string; login: string }): Promise<boolean> {
  const named = (await q.query(
    "SELECT 1 FROM personal_custody c WHERE c.instance_id = $1 AND c.person_id <> $2 AND (c.manager_login = lower($3) OR c.custodian_id = $2) LIMIT 1",
    [instanceId, p.id, p.login])).rowCount;
  return !!named || await custodyChainHolds(q, instanceId, p.id, policy);
}

export async function storedManagerRepeat(q: Queryable, instanceId: string, personId: string, manager: string, card: string | null): Promise<string | null> {
  const kept = (await q.query("SELECT manager_login FROM personal_custody WHERE person_id = $1", [personId])).rows[0];
  const stored = String((kept ? kept.manager_login : card) ?? "").trim().toLowerCase(), m = manager.trim().toLowerCase();
  if (!stored || !m) return null;
  if (stored === m) return stored;
  return (await q.query(
    `SELECT 1 FROM person_identities i JOIN people x ON x.id = i.person_id
      WHERE i.system = 'ad' AND i.source = 'rename' AND lower(i.external_id) = $1 AND lower(x.login) = $2 AND x.instance_id = $3 LIMIT 1`,
    [m, stored, instanceId])).rowCount ? stored : null;
}

export function custodyCounts(changes: readonly CustodyChange[], waiting: number): { assigned: number; changed: number; ended: number; waiting: number } {
  const n = (op: string) => changes.filter((x) => custodyOp(x.reason) === op).length;
  return { assigned: n("custody_assign"), changed: n("custody_change"), ended: n("custody_end"), waiting };
}

export function renameCustodyManager(snapshots: Map<string, { manager: string | null; units: string[] }>, corrections: Map<string, string>, from: string, to: string,
                                     detached: ReadonlySet<string>): void {
  const was = from.trim().toLowerCase(), now = to.trim().toLowerCase();
  if (!was || was === now) return;
  for (const [k, s] of snapshots) if (!detached.has(k) && (s.manager ?? "").trim().toLowerCase() === was) s.manager = now;
  for (const [k, m] of corrections) if (!detached.has(k) && m.trim().toLowerCase() === was) corrections.set(k, now);
}

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
const isoOrNull = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);

function offRule(w: Awaited<ReturnType<typeof custodyWorld>>, r: { person_id: string; custodian_id: string | null; manager_login: string | null; org_unit_ids: string[] | null }): boolean {
  const p = w.byId.get(r.person_id);
  return !!r.custodian_id && (!p || !chainPick(w, p, { manager_login: r.manager_login, org_unit_ids: r.org_unit_ids ?? [] }).chain.includes(r.custodian_id));
}

async function lateManagerOf(q: Queryable, instanceId: string, personId: string, managerLogin: string | null, custodianId: string | null) {
  const m = (managerLogin ?? "").trim().toLowerCase();
  if (!m) return null;
  const rows = (await q.query(
    `SELECT p.id, p.login, p.display_name, p.active, ${showcaseSql("p")} AS demo, p.instance_id, p.manager_login, p.department, NULL AS department_code, p.created_at,
            (SELECT max(s.archived_at) FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = p.id) AS dismissed_at, p.attrs->'${CUSTODY_DETACHED_ATTR}' AS detached
       FROM people p WHERE p.instance_id = $1 AND (p.id = $2 OR lower(p.login) = $3)`, [instanceId, personId, m])).rows
    .map((r) => ({ ...r, detached: detachedOf(r.detached) })) as Array<CustodyPerson & { display_name: string | null }>;
  const p = rows.find((x) => x.id === personId);
  if (!p) return null;
  const w: CustodyWorld = { instanceId, byId: new Map(rows.map((x) => [x.id, x])), byLogin: new Map(rows.map((x) => [x.login.toLowerCase(), x])),
                            snapshotManager: new Map(), units: new Map(), heads: new Map() };
  const x = lateManager(w, p, { manager_login: m }) as (CustodyPerson & { display_name: string | null }) | null;
  return x && x.id !== custodianId ? { login: x.login, display_name: x.display_name ?? null } : null;
}

export async function personCustody(q: Queryable, instanceId: string, personId: string, policy: Pick<CustodyPolicy, "afterDays">, records: readonly Queryable[]) {
  const r = (await q.query(
    `SELECT c.person_id, c.custodian_id, c.basis, c.levels, c.manager_login, c.org_unit_ids, c.meetings_waiting, c.busy_passes,
            c.assigned_by, c.reason, s.archived_at, s.slug AS space_slug, k.login AS custodian_login, k.display_name AS custodian_name
       FROM personal_custody c LEFT JOIN spaces s ON s.id = c.space_id LEFT JOIN people k ON k.id = c.custodian_id
      WHERE c.instance_id = $1 AND c.person_id = $2`, [instanceId, personId])).rows[0];
  if (!r) return null;
  const since = r.archived_at ? new Date(r.archived_at) : null;
  return {
    custodian: r.custodian_id ? { login: r.custodian_login as string, display_name: (r.custodian_name ?? null) as string | null } : null,
    basis: r.basis as string, levels: Number(r.levels), since: since?.toISOString() ?? null,
    active_from: since ? new Date(since.getTime() + policy.afterDays * 86_400_000).toISOString() : null,
    meetings_moved: await meetingsMovedOf(records, personId), meetings_waiting: Number(r.meetings_waiting), busy_passes: Number(r.busy_passes),
    assigned_by: (r.assigned_by ?? null) as string | null, reason: (r.reason ?? null) as string | null,
    manual_off_rule: r.basis === "manual" && offRule(await custodyWorld(q, instanceId), r),
    late_manager: await lateManagerOf(q, instanceId, personId, (r.manager_login ?? null) as string | null, (r.custodian_id ?? null) as string | null),
    closed_opened: null as number | null,
    space: (r.space_slug ?? null) as string | null,
  };
}

export async function custodyClosedOpened(app: App, personId: string): Promise<number | null> {
  try {
    const row = (await app.db.control.query(
      `SELECT c.space_id, s.archived_at FROM personal_custody c LEFT JOIN spaces s ON s.id = c.space_id WHERE c.instance_id = $1 AND c.person_id = $2`,
      [app.instanceId, personId])).rows[0];
    if (!row) return null;
    if (!row.archived_at) return 0;
    const { rows } = await app.db.auditRead().query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE instance_id = $1 AND event_type = 'read' AND at >= $3 AND space_id = $2 AND details->>'op' = 'custody_read' AND details->>'closed' = 'true'
          AND details->>'via' IS DISTINCT FROM 'copy'`,
      [app.instanceId, row.space_id, row.archived_at]);
    return Number(rows[0]?.n ?? 0);
  } catch (e) {
    log.warn("custody_closed_opened_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) });
    return null;
  }
}

export async function dismissedReport(app: App, full = true) {
  const ctl = app.db.control;
  const head = (rows: any[]) => ({ count: Number(rows[0]?.total ?? 0) });
  const without = (await ctl.query(
    `SELECT p.login, p.display_name, s.archived_at, count(*) OVER ()::int AS total FROM personal_custody c JOIN people p ON p.id = c.person_id LEFT JOIN spaces s ON s.id = c.space_id
      WHERE c.instance_id = $1 AND c.custodian_id IS NULL AND NOT p.active ORDER BY s.archived_at DESC NULLS LAST, p.login LIMIT 100`, [app.instanceId])).rows;
  const manualRows = (await ctl.query(
    `SELECT c.person_id, c.custodian_id, c.manager_login, c.org_unit_ids, c.reason, c.assigned_at, p.login, p.display_name, k.login AS custodian_login, k.display_name AS custodian_name
       FROM personal_custody c JOIN people p ON p.id = c.person_id JOIN people k ON k.id = c.custodian_id
      WHERE c.instance_id = $1 AND c.basis = 'manual' AND NOT p.active ORDER BY c.assigned_at DESC, p.login`, [app.instanceId])).rows;
  const world = manualRows.length ? await custodyWorld(ctl, app.instanceId) : null;
  const manual = world ? manualRows.filter((r) => offRule(world, r)) : [];
  const stuck = (await ctl.query(
    `SELECT p.login, p.display_name, c.meetings_waiting, c.busy_passes, count(*) OVER ()::int AS total FROM personal_custody c JOIN people p ON p.id = c.person_id LEFT JOIN spaces s ON s.id = c.space_id
      WHERE c.instance_id = $1 AND NOT p.active AND (c.meetings_conflicts > 0 OR (c.meetings_waiting > 0 AND c.busy_passes >= 24))
      ORDER BY s.archived_at DESC NULLS LAST, p.login LIMIT 100`, [app.instanceId])).rows;
  const byOp = (await ctl.query(
    `SELECT p.login, p.display_name, k.login AS custodian_login, k.display_name AS custodian_name, c.by_operator, c.assigned_at, count(*) OVER ()::int AS total
       FROM personal_custody c JOIN people p ON p.id = c.person_id JOIN people k ON k.id = c.custodian_id
      WHERE c.instance_id = $1 AND c.by_operator IS NOT NULL AND NOT p.active ORDER BY c.assigned_at DESC, p.login LIMIT 100`, [app.instanceId])).rows;
  const items = <T>(xs: T[]): T[] => (full ? xs : []);
  return {
    without_custodian: { ...head(without), items: items(without.map((r) => ({ login: r.login, display_name: r.display_name ?? null, since: isoOrNull(r.archived_at) }))) },
    manual: { count: manual.length, items: items(manual.slice(0, 100).map((r) => ({ login: r.login, display_name: r.display_name ?? null,
      custodian: { login: r.custodian_login, display_name: r.custodian_name ?? null }, reason: r.reason ?? null, at: isoOrNull(r.assigned_at) }))) },
    meetings_stuck: { ...head(stuck), items: items(stuck.map((r) => ({ login: r.login, display_name: r.display_name ?? null, waiting: Number(r.meetings_waiting), busy_passes: Number(r.busy_passes) }))) },
    by_operator: { ...head(byOp), items: items(byOp.map((r) => ({ login: r.login, display_name: r.display_name ?? null,
      custodian: { login: r.custodian_login, display_name: r.custodian_name ?? null }, by: r.by_operator as string, at: isoOrNull(r.assigned_at) }))) },
  };
}

async function hasRole(app: App, personId: string, code: string): Promise<boolean> {
  return Boolean((await app.db.control.query(
    `SELECT 1 FROM role_grants WHERE person_id = $1 AND role_code = $2 AND instance_id = $3
       AND revoked_at IS NULL AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [personId, code, app.instanceId])).rowCount);
}

async function revokeKeysOf(q: { query: (sql: string, args: unknown[]) => Promise<{ rowCount: number | null }> }, principalType: "person" | "service", principalId: string): Promise<number> {
  const res = await q.query("UPDATE api_keys SET revoked_at = now() WHERE principal_type = $1 AND principal_id = $2 AND revoked_at IS NULL", [principalType, principalId]);
  await q.query("UPDATE action_plans p SET status='cancelled' FROM api_keys k WHERE p.key_id=k.id AND p.status='pending' AND k.revoked_at IS NOT NULL AND k.principal_type=$1 AND k.principal_id=$2", [principalType, principalId]);
  return res.rowCount ?? 0;
}

export function identityExternalId(system: string, external: unknown): string | null {
  if (system !== "ad") return String(external);
  return typeof external === "string" ? canonicalObjectGuid(external.trim()) : null;
}

const rowLogin = (p: any): string => String(p?.login ?? "").trim().toLowerCase();
const rowEmployeeId = (p: any): string | null =>
  [p?.employee_id, p?.attrs?.employee_id].map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "")).find(Boolean) ?? null;
const rowsText = (rows: number[]): string => rows.length === 1 ? String(rows[0]) : `${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}`;

export async function orgImportNeedsApproval(q: Pick<pg.Pool, "query">, instanceId: string, people: readonly unknown[], o: { deactivateMissing?: boolean } = {}): Promise<string[]> {
  const rows = people.filter((p): p is Record<string, any> => !!p && typeof p === "object" && /^[^@\s]+@[^@\s]+$/.test(rowLogin(p)));
  if (!rows.length) return [];
  const logins = [...new Set(rows.map(rowLogin))], employees = [...new Set(rows.map(rowEmployeeId).filter((x): x is string => !!x))];
  const cards = (await q.query(
    `SELECT p.id, p.login, p.employee_id, lower(btrim(COALESCE(p.manager_login, ''))) AS manager, COALESCE(p.attrs->>'unit_relation', '') AS unit_relation,
            EXISTS (SELECT 1 FROM spaces s JOIN record_locations l ON l.space_id = s.id WHERE s.kind = 'personal' AND s.owner_id = p.id) AS personal
       FROM people p WHERE p.instance_id = $1 AND (p.login = ANY($2::text[]) OR p.employee_id = ANY($3::text[]))`, [instanceId, logins, employees])).rows as
    Array<{ id: string; login: string; employee_id: string | null; manager: string; unit_relation: string; personal: boolean }>;
  if (!cards.some((x) => x.personal)) return [];
  const byLogin = new Map(cards.map((x) => [x.login, x])), byEmployee = new Map(cards.filter((x) => x.employee_id).map((x) => [x.employee_id!, x]));
  const withRecords = cards.filter((x) => x.personal).map((x) => x.id);
  const links = (await q.query(
    "SELECT system, external_id, person_id, active, COALESCE(source, '') AS source FROM person_identities WHERE person_id = ANY($1::uuid[])", [withRecords])).rows as
    Array<{ system: string; external_id: string; person_id: string; active: boolean; source: string }>;
  const out = new Set<string>();
  for (const p of rows) {
    const login = rowLogin(p), employee = rowEmployeeId(p);
    const card = byLogin.get(login) ?? (employee ? byEmployee.get(employee) : undefined);
    if (!card?.personal) continue;
    if (card.login !== login) { out.add(card.login); continue; }
    const manager = typeof p.manager_login === "string" ? p.manager_login.trim().toLowerCase() : "";
    const active = p.active !== false;
    if (active ? manager !== card.manager : !!manager && manager !== card.manager) { out.add(card.login); continue; }
    if (active) {
      const relation = typeof p.attrs?.unit_relation === "string" ? p.attrs.unit_relation : "";
      if (relation !== card.unit_relation) { out.add(card.login); continue; }
    }
    const listed = Array.isArray(p.attrs?.identities) ? (p.attrs.identities as Array<{ system?: unknown; external_id?: unknown }>) : null;
    if (!listed) continue;
    const mine = links.filter((x) => x.person_id === card.id);
    const named = new Set<string>();
    for (const idn of listed) {
      if (!idn?.system || idn.external_id === undefined) continue;
      const external = identityExternalId(String(idn.system), idn.external_id);
      if (external === null) continue;
      named.add(`${idn.system}:${external}`);
      if (!mine.some((x) => x.active && x.system === idn.system && x.external_id === external)) { out.add(card.login); break; }
    }
    if (o.deactivateMissing && mine.some((x) => x.active && !["ldap_login", "oidc_login"].includes(x.source) && !named.has(`${x.system}:${x.external_id}`)))
      out.add(card.login);
  }
  return [...out].sort();
}

export async function orgImportWidening(q: Pick<pg.Pool, "query">, instanceId: string, people: readonly unknown[],
                                        o: { selfIds?: readonly string[]; orgOwnerLogin?: unknown } = {}): Promise<{ heads: string[]; self: string[]; orgOwner: string | null }> {
  const rows = people.filter((p): p is Record<string, any> => !!p && typeof p === "object" && /^[^@\s]+@[^@\s]+$/.test(rowLogin(p)));
  const logins = [...new Set(rows.map(rowLogin))], employees = [...new Set(rows.map(rowEmployeeId).filter((x): x is string => !!x))];
  const cards = rows.length ? (await q.query(
    `SELECT p.id, p.login, p.employee_id, p.active, lower(btrim(COALESCE(p.manager_login, ''))) AS manager, COALESCE(p.attrs->>'unit_relation', '') AS unit_relation,
            COALESCE(NULLIF(btrim(p.attrs->>'department_code'), ''), '') AS department_code, COALESCE(p.department, '') AS department,
            COALESCE((SELECT array_agg(pu.org_unit_id::text) FROM person_org_units pu WHERE pu.person_id = p.id AND pu.relation = 'head'), '{}') AS heads
       FROM people p WHERE p.instance_id = $1 AND (p.login = ANY($2::text[]) OR p.employee_id = ANY($3::text[]))`, [instanceId, logins, employees])).rows as
    Array<{ id: string; login: string; employee_id: string | null; active: boolean; manager: string; unit_relation: string; department_code: string; department: string; heads: string[] }> : [];
  const byLogin = new Map(cards.map((x) => [x.login, x])), byEmployee = new Map(cards.filter((x) => x.employee_id).map((x) => [x.employee_id!, x]));
  const self = new Set(o.selfIds ?? []);
  const heads = new Set<string>(), mine = new Set<string>();
  for (const p of rows) {
    const login = rowLogin(p), employee = rowEmployeeId(p);
    const card = byLogin.get(login) ?? (employee ? byEmployee.get(employee) : undefined);
    const active = p.active !== false;
    const dept = typeof p.department === "string" ? p.department : "";
    const code = dept && active ? String(p.attrs?.department_code ?? p.department_code ?? "").trim() || slugify(dept, "unit") : "";
    if (active && code && p.attrs?.unit_relation === "head" && !(card?.heads ?? []).includes(orgUnitId(instanceId, code))) heads.add(card?.login ?? login);
    if (!card || !self.has(card.id)) continue;
    const manager = typeof p.manager_login === "string" ? p.manager_login.trim().toLowerCase() : "";
    const relation = active && typeof p.attrs?.unit_relation === "string" ? p.attrs.unit_relation : "";
    const cardCode = card.department_code || (card.department ? slugify(card.department, "unit") : "");
    if ((active && (manager !== card.manager || relation !== card.unit_relation || code !== cardCode)) || (active && !card.active)) mine.add(card.login);
  }
  let orgOwner: string | null = null;
  const owner = typeof o.orgOwnerLogin === "string" ? o.orgOwnerLogin.trim().toLowerCase() : "";
  if (owner) {
    const org = (await q.query("SELECT owner_id FROM spaces WHERE kind = 'org' AND instance_id = $1", [instanceId])).rows[0];
    if (!org?.owner_id) orgOwner = owner;
  }
  return { heads: [...heads].sort(), self: [...mine].sort(), orgOwner };
}

interface CustodyBefore { world: CustodyWorld; rows: Map<string, { manager_login: string | null; org_unit_ids: string[] }> }
async function custodyBefore(q: Pick<pg.PoolClient, "query">, instanceId: string): Promise<CustodyBefore> {
  const world = await custodyWorld(q, instanceId);
  const rows = new Map((await q.query("SELECT person_id, manager_login, org_unit_ids FROM personal_custody WHERE instance_id = $1", [instanceId])).rows
    .map((r) => [r.person_id as string, { manager_login: (r.manager_login ?? null) as string | null, org_unit_ids: (r.org_unit_ids ?? []) as string[] }]));
  return { world, rows };
}

async function custodyRerouted(q: Pick<pg.PoolClient, "query">, instanceId: string, before: CustodyBefore, changes: readonly CustodyChange[]): Promise<string[]> {
  const gained = changes.filter((ch) => ch.to !== null);
  if (!gained.length) return [];
  const after = await custodyWorld(q, instanceId);
  const rowsAfter = new Map((await q.query("SELECT person_id, manager_login, org_unit_ids FROM personal_custody WHERE instance_id = $1 AND person_id = ANY($2::uuid[])",
    [instanceId, gained.map((ch) => ch.person)])).rows.map((r) => [r.person_id as string, { manager_login: (r.manager_login ?? null) as string | null, org_unit_ids: (r.org_unit_ids ?? []) as string[] }]));
  const byId = new Map<string, CustodyPerson>();
  for (const [id, p] of after.byId) {
    const was = before.world.byId.get(id);
    byId.set(id, was ? { ...p, manager_login: was.manager_login, department: was.department, department_code: was.department_code, detached: was.detached } : p);
  }
  const byLogin = new Map<string, CustodyPerson>();
  for (const p of byId.values()) byLogin.set(p.login.toLowerCase(), p);
  for (const [login, p] of before.world.byLogin) { const x = byId.get(p.id); if (x) byLogin.set(login, x); }
  const snapshotManager = new Map<string, string | null>();
  for (const [id, m] of after.snapshotManager) { const was = before.world.byId.get(id); snapshotManager.set(id, was ? (was.manager_login ?? null) : m); }
  for (const [id, m] of before.world.snapshotManager) snapshotManager.set(id, m);
  const sim: CustodyWorld = { instanceId, byId, byLogin, snapshotManager, units: before.world.units, heads: before.world.heads };
  const out: string[] = [];
  for (const ch of gained) {
    const p = byId.get(ch.person), now = rowsAfter.get(ch.person);
    const was = before.world.byId.get(ch.person);
    const snap = before.rows.get(ch.person) ?? (now ? { manager_login: was ? (was.manager_login ?? null) : now.manager_login, org_unit_ids: now.org_unit_ids } : null);
    if (!p || !snap || chainPick(sim, p, snap).id !== ch.to) out.push(ch.person);
  }
  return out;
}

class CustodyNeedsSignature extends Error {
  constructor(readonly logins: string[]) { super("custody_needs_signature"); }
}

export function peopleBatchRepeats(rows: readonly unknown[]): { skipped: Map<number, number>; employee: Map<number, { employeeId: string; rows: number[] }> } {
  const lastOf = new Map<string, number>();
  rows.forEach((p, n) => { const login = rowLogin(p); if (/^[^@\s]+@[^@\s]+$/.test(login)) lastOf.set(login, n); });
  const skipped = new Map<number, number>();
  rows.forEach((p, n) => { const last = lastOf.get(rowLogin(p)); if (last !== undefined && last !== n) skipped.set(n, last); });
  const byEmployee = new Map<string, number[]>();
  rows.forEach((p, n) => {
    if (skipped.has(n) || !lastOf.has(rowLogin(p))) return;
    const e = rowEmployeeId(p);
    if (e) byEmployee.set(e, [...(byEmployee.get(e) ?? []), n]);
  });
  const employee = new Map<number, { employeeId: string; rows: number[] }>();
  for (const [employeeId, at] of byEmployee) if (at.length > 1) for (const n of at) employee.set(n, { employeeId, rows: at.map((i) => i + 1) });
  return { skipped, employee };
}

const DEPT_NO_HEAD_SQL = `s.instance_id = $1 AND s.archived_at IS NULL AND u.active
  AND EXISTS (SELECT 1 FROM person_org_units pu JOIN people pp ON pp.id = pu.person_id AND pp.active WHERE pu.org_unit_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM person_org_units h JOIN people hp ON hp.id = h.person_id AND hp.active WHERE h.org_unit_id = u.id AND h.relation = 'head')`;

const DEPT_UNMANAGED_SQL = "NOT EXISTS (SELECT 1 FROM space_members_effective mo WHERE mo.space_id = s.id AND mo.role = 'owner')";

export async function departmentSpacesWithoutHead(q: Pick<pg.Pool, "query">, instanceId: string) {
  const rows = (await q.query(
    `SELECT s.slug, s.name, count(*) OVER ()::int AS total, (count(*) FILTER (WHERE ${DEPT_UNMANAGED_SQL}) OVER ())::int AS unmanaged,
            ARRAY(SELECT mp.login FROM space_members_effective m JOIN people mp ON mp.id = m.person_id
                  WHERE m.space_id = s.id AND m.role = 'owner' ORDER BY mp.login LIMIT 5) AS managers,
            p.login AS former_head, p.active AS former_head_active,
            (SELECT count(DISTINCT pu.person_id)::int FROM person_org_units pu JOIN people pp ON pp.id = pu.person_id AND pp.active WHERE pu.org_unit_id = u.id) AS members
     FROM spaces s JOIN org_units u ON u.id = s.org_unit_id
     LEFT JOIN people p ON p.id = s.owner_id
       AND NOT EXISTS (SELECT 1 FROM space_members_effective eo WHERE eo.space_id = s.id AND eo.person_id = p.id AND eo.role = 'owner')
     WHERE ${DEPT_NO_HEAD_SQL} ORDER BY s.name, s.slug LIMIT 100`, [instanceId])).rows;
  return { count: (rows[0]?.total ?? 0) as number, unmanaged: (rows[0]?.unmanaged ?? 0) as number,
           items: rows.map((x) => ({ slug: x.slug as string, name: x.name as string, managers: (x.managers ?? []) as string[],
                                     former_head: (x.former_head ?? null) as string | null,
                                     former_head_active: x.former_head == null ? null : Boolean(x.former_head_active), members: x.members as number })) };
}

async function departmentsWithoutHeadWarnings(q: Pick<pg.PoolClient, "query">, instanceId: string, units: Iterable<string>): Promise<string[]> {
  const ids = [...new Set(units)];
  if (!ids.length) return [];
  const rows = (await q.query(
    `SELECT s.name, count(*) OVER ()::int AS total FROM spaces s JOIN org_units u ON u.id = s.org_unit_id
     WHERE ${DEPT_NO_HEAD_SQL} AND ${DEPT_UNMANAGED_SQL} AND u.id = ANY($2::uuid[]) ORDER BY s.name, s.slug LIMIT 20`, [instanceId, ids])).rows;
  const out = rows.map((x) => `department space “${x.name}” has no active department head. Until it has one, the memory administrator manages the space. Assign a department head in the staff list using the department role, or assign a space owner in “Spaces”`);
  const total = rows[0]?.total ?? 0;
  if (total > rows.length) out.push(`other departments without an active department head or assigned owner: ${total - rows.length}. See the report for the full list`);
  return out;
}

export interface DeactivationPreview { will_deactivate: number; active_total: number; sample: Array<{ login: string; display_name: string }> }

export async function deactivationPreview(q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">, instanceId: string, people: readonly unknown[]): Promise<DeactivationPreview> {
  const { skipped } = peopleBatchRepeats(people);
  const logins: string[] = [], employees: Array<string | null> = [], off: boolean[] = [];
  for (const [n, p] of (people as any[]).entries()) {
    const login = rowLogin(p);
    if (skipped.has(n) || !login) continue;
    logins.push(login); employees.push(rowEmployeeId(p)); off.push(p?.active === false);
  }
  const { rows } = await q.query(
    `WITH r AS (SELECT * FROM unnest($2::text[], $3::text[], $4::boolean[]) AS r(login, employee_id, off)),
          hit AS (SELECT p.id, r.off FROM people p JOIN r ON r.login = p.login WHERE p.instance_id = $1 AND p.active
                  UNION ALL
                  SELECT p.id, r.off FROM people p JOIN r ON r.employee_id = p.employee_id WHERE p.instance_id = $1 AND p.active AND r.employee_id IS NOT NULL),
          m AS (SELECT id, bool_or(off) AS off FROM hit GROUP BY id)
     SELECT p.login, p.display_name, count(*) OVER ()::int AS total
     FROM people p LEFT JOIN m ON m.id = p.id
     WHERE p.instance_id = $1 AND p.active AND ((m.id IS NULL AND COALESCE(p.attrs->>'demo','') <> 'true') OR m.off)
     ORDER BY p.display_name, p.login LIMIT 20`, [instanceId, logins, employees, off]);
  const activeTotal = (await q.query("SELECT count(*)::int AS n FROM people WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') <> 'true'", [instanceId])).rows[0].n as number;
  return { will_deactivate: rows[0]?.total ?? 0, active_total: activeTotal, sample: rows.map((x) => ({ login: x.login as string, display_name: x.display_name as string })) };
}

export const massDeactivationShare = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.2);

export const needsMassConfirmation = (p: Pick<DeactivationPreview, "will_deactivate" | "active_total">, share: number): boolean =>
  p.will_deactivate > 0 && p.will_deactivate > share * p.active_total;

export function massDeactivationRefusal(p: DeactivationPreview, share: number, confirmed: number | undefined): MemoryError {
  const pct = `${Math.round(share * 1000) / 10}%`;
  const head = confirmed === undefined
    ? `The full export will deactivate ${p.will_deactivate} of ${p.active_total} active employees, more than ${pct} (setting access.mass_deactivation_share). This can happen when the file is corrupt.`
    : `You confirmed deactivating ${confirmed} people, but the full export will deactivate ${p.will_deactivate} of ${p.active_total} active employees. The group has changed.`;
  return invalid(`${head} Nothing changed. If the file is correct, confirm the deactivation again: confirm_deactivations = ${p.will_deactivate}`,
    { reason: "mass_deactivation", mass_deactivation: { ...p, share } });
}

export function givenNameAttr(raw: unknown): { ok: true; value: string | null | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw !== null && typeof raw !== "string") return { ok: false, message: "given name (attrs.given_name) must be a string or null" };
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (value.length > 100) return { ok: false, message: "given name (attrs.given_name) must be no longer than 100 characters" };
  return { ok: true, value: value || null };
}

function caCertificates(pem: unknown): Array<{ subject: string; sha256: string }> {
  if (typeof pem !== "string" || !pem.trim()) return [];
  try { return parseCaCerts(pem).slice(0, 10).map((x) => ({ subject: x.subject.replace(/\n/g, ", ").slice(0, 200), sha256: x.fingerprint256 })); }
  catch { return [{ subject: "could not be parsed", sha256: createHash("sha256").update(pem).digest("hex") }]; }
}

const OIDC_AUDIT_KEYS = new Set(["enabled", "issuer", "client_id", "redirect_uri", "scopes", "login_groups", "claims", "private_networks"]);
export const OIDC_SECRET_REENTRY = "when changing the issuer, client ID or root certificate, enter the client secret again";
const pemText = (s: string): string => s.replace(/\r\n?/g, "\n").trim();
export const LDAP_SECRET_REENTRY = "when changing directory servers, port, encryption, certificate or account, enter the service account password again";
export const SMTP_SECRET_REENTRY = "when changing the mail server, port, encryption, certificate or username, enter the mail password again";
const LDAP_ANCHORS = ["servers", "port", "tls_mode", "insecure_ack", "ca_cert", "tls_server_name", "bind_dn"] as const;
const SMTP_ANCHORS = ["host", "port", "security", "insecure_ack", "ca_cert", "username"] as const;
export function anchorText(key: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean).sort().join("\n");
  if (v === null || v === undefined || v === false || v === 0) return "";
  if (typeof v !== "string") return String(v);
  const s = pemText(v);
  return key === "host" || key === "tls_server_name" ? s.toLowerCase() : s;
}
const anchorMoved = (keys: readonly string[], before: object, after: object): boolean =>
  keys.some((k) => anchorText(k, (before as Record<string, unknown>)[k]) !== anchorText(k, (after as Record<string, unknown>)[k]));

export function secretAnchorProblems(settings: Pick<Settings, "get">, items: ReadonlyArray<{ category: string; key: string; value?: unknown }>):
    Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  const future = (cat: string) => {
    const next = new Map(items.filter((i) => i.category === cat).map((i) => [`${cat}.${i.key}`, i.value ?? null] as const));
    return { next, get: <T,>(path: `${string}.${string}`, def: T): T => (next.has(path) ? ((next.get(path) ?? def) as T) : settings.get<T>(path, def)) };
  };
  if (items.some((i) => i.category === "ldap")) {
    const f = future("ldap"), before = ldapConfig(settings), after = ldapConfig(f);
    if (before.bind_password && !f.next.has("ldap.bind_password") && anchorMoved(LDAP_ANCHORS, before, after)) out.push({ key: "ldap.bind_password", message: LDAP_SECRET_REENTRY });
  }
  if (items.some((i) => i.category === "oidc")) {
    const f = future("oidc"), before = oidcConfig(settings), after = oidcConfig(f);
    const moved = oidcDiscoveryUrl(after.issuer) !== oidcDiscoveryUrl(before.issuer) || after.client_id !== before.client_id || pemText(after.ca_cert) !== pemText(before.ca_cert);
    if (moved && before.client_secret && !f.next.has("oidc.client_secret")) out.push({ key: "oidc.client_secret", message: OIDC_SECRET_REENTRY });
  }
  if (items.some((i) => i.category === "smtp")) {
    const f = future("smtp"), before = smtpConfig(settings), after = smtpConfig(f);
    if (before.password && !f.next.has("smtp.password") && anchorMoved(SMTP_ANCHORS, before, after)) out.push({ key: "smtp.password", message: SMTP_SECRET_REENTRY });
  }
  return out;
}

export async function endIdentitySessions(sessionApp: App, items: ReadonlyArray<{ category: string; key: string }>): Promise<{ ldap: number; oidc: number }> {
  const ldap = items.some((i) => i.category === "ldap" && LDAP_IDENTITY_KEYS.has(i.key)) ? await endSourceSessions(sessionApp, "ldap", "config_changed") : 0;
  const oidc = items.some((i) => i.category === "oidc" && OIDC_IDENTITY_KEYS.has(i.key)) ? await endSourceSessions(sessionApp, "oidc", "config_changed") : 0;
  return { ldap, oidc };
}

export function settingsWriteSettled(items: ReadonlyArray<{ category?: string }>): void {
  resetHealthCache();
  if (items.some((i) => i?.category === "oidc" || i?.category === "oauth")) { providers.clear(); clearOAuthProviders(); }
}

export function requiredClears(settings: Pick<Settings, "listMasked">, items: Array<{ category: string; key: string; value?: unknown }>): string[] {
  const rows = new Map(settings.listMasked().map((r) => [`${r.category}.${r.key}`, r]));
  return items.filter((i) => (i.value ?? null) === null || i.value === "").map((i) => `${i.category}.${i.key}`)
    .filter((p) => { const r = rows.get(p); return Boolean(r?.required && r.isSet); });
}

export const KEY_UNBOUND_SQL = "(cardinality(COALESCE(k.net_cidrs, '{}'::cidr[])) = 0 OR EXISTS (SELECT 1 FROM unnest(k.net_cidrs) c WHERE masklen(c) = 0))";

export const OBO_READ_KEY_MAX_DAYS = 30;
export function oboReadKeyLimit(now = Date.now()): Date {
  const d = new Date(now + OBO_READ_KEY_MAX_DAYS * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}
export const OBO_READ_LONG_SQL = `(k.expires_at IS NULL OR k.expires_at > (date_trunc('day', now() AT TIME ZONE 'UTC') + make_interval(days => ${OBO_READ_KEY_MAX_DAYS + 1}) - interval '1 millisecond') AT TIME ZONE 'UTC')`;

export function oboReadKeyExpiry(raw: unknown, now = Date.now()): string {
  const limit = oboReadKeyLimit(now);
  const details = { field: "expires_at", max_days: OBO_READ_KEY_MAX_DAYS, latest: limit.toISOString() };
  if (raw === undefined || raw === null || raw === "")
    throw invalid(`expires_at: this service reads on behalf of people, so its key needs an expiry date at most ${OBO_READ_KEY_MAX_DAYS} days ahead`, details);
  const at = typeof raw === "string" ? new Date(raw).getTime() : Number.NaN;
  if (Number.isNaN(at)) throw invalid("expires_at: not a date");
  if (at <= now) throw invalid("expires_at: this date has already passed");
  if (at > limit.getTime())
    throw invalid(`expires_at: this service reads on behalf of people, so its key lasts at most ${OBO_READ_KEY_MAX_DAYS} days (until ${limit.toISOString().slice(0, 10)} inclusive)`, details);
  return new Date(at).toISOString();
}

export const isTestPerson = (p: { active: boolean; login: string; attrs: Record<string, unknown> | null; ad: boolean }): boolean =>
  p.active === true && p.attrs?.test === true && String(p.attrs?.demo ?? "") !== "true" && !isShowcaseLogin(p.login) && !p.ad && isTestDomainLogin(p.login);
export const TEST_PERSON_SQL = (p: string): string =>
  `COALESCE(${p}.active AND ${p}.attrs->'test' = 'true'::jsonb AND NOT ${showcaseSql(p)}
    AND NOT EXISTS (SELECT 1 FROM person_identities ti WHERE ti.person_id = ${p}.id AND ti.system = 'ad' AND ti.active) AND ${testLoginSql(p)}, false)`;

export const PERSON_KEY_ADMIN_TEXT = "Only the person can issue their own key, in the workspace under “Keys and agents”. An administrator issues personal and extended keys only to test persons, for checks";
export const OBO_SERVICE_KEYS_OFF_TEXT = "Issuing keys to services acting on behalf of people is turned off (access.obo_service_keys)";
export const oboServiceKeysOn = (app: Pick<App, "settings">): boolean => app.settings.get<unknown>("access.obo_service_keys", false) === true;
export const keyBindingRequiredText = (what: string): string =>
  `net_cidrs: ${what} only when bound to addresses: give the addresses or networks of the server (for example, 192.0.2.20/32), not the “whole internet” network (/0)`;

export const SYSTEM_KEY_REMOVED_TEXT = "System keys are no longer issued; for maintenance use an administrator session or the CLI";   // contracts/edge/error-codes.json, 1a
export const FINGERPRINT_OBO_TEXT = "A key for an on-behalf-of service is registered by fingerprint only: generate the secret on your side (node tools/keys/gen-service-key.mjs) and send key_sha256 and key_prefix";
export const FINGERPRINT_ONLY_TEXT = "Service keys are registered by fingerprint only (admin.service_keys_by_fingerprint): generate the secret on your side (node tools/keys/gen-service-key.mjs) and send key_sha256 and key_prefix";
export const FINGERPRINT_TAKEN_TEXT = "A key with this fingerprint is already registered: generate a new secret";

export function keyFingerprintOf(kind: string, b: Record<string, unknown> | null | undefined): { hash: Buffer; prefix: string } | null {
  const sha = b?.key_sha256, prefix = b?.key_prefix;
  if ((sha === undefined || sha === null) && (prefix === undefined || prefix === null)) return null;
  if (kind !== "service") throw invalid("key_sha256: only a service key is registered by fingerprint (kind: service)", { field: "key_sha256" });
  const hex = typeof sha === "string" ? sha.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hex)) throw invalid("key_sha256: the sha256 of the key secret, 64 hexadecimal characters", { field: "key_sha256" });
  const p = typeof prefix === "string" ? prefix.trim() : "";
  if (!/^mem_s_[a-z2-7]{2}$/.test(p)) throw invalid("key_prefix: the first 8 characters of the service key secret (mem_s_ and two characters)", { field: "key_prefix" });
  return { hash: Buffer.from(hex, "hex"), prefix: p };
}

export async function legacyKeyCounts(app: Pick<App, "db" | "instanceId">): Promise<{ extended_unbound: number; obo_read_long_keys: number; admin_person_keys: number }> {
  const { rows } = await app.db.control.query(
    `SELECT count(*) FILTER (WHERE k.principal_type = 'person' AND k.kind = 'extended' AND ${KEY_UNBOUND_SQL})::int AS extended_unbound,
            count(*) FILTER (WHERE k.principal_type = 'service' AND s.active AND s.obo_allowed AND s.obo_read AND ${OBO_READ_LONG_SQL})::int AS obo_read_long_keys,
            count(*) FILTER (WHERE k.principal_type = 'person' AND k.kind IN ('personal', 'extended') AND k.preview IS NOT TRUE AND p.active
                               AND k.created_by IS DISTINCT FROM k.principal_id AND NOT ${TEST_PERSON_SQL("p")})::int AS admin_person_keys
     FROM api_keys k LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id
                     LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id
     WHERE k.instance_id = $1 AND k.auth_method = 'api_key' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`, [app.instanceId]);
  const x = rows[0] ?? {};
  return { extended_unbound: x.extended_unbound ?? 0, obo_read_long_keys: x.obo_read_long_keys ?? 0, admin_person_keys: x.admin_person_keys ?? 0 };
}

// Only this security switch accepts a reset at the route boundary. Shared validation stays strict.
const SETTINGS_RESET_TO_DEFAULT = new Set(["admin.sso_login_enabled"]);

export function adminRoutes(app: App): Hono<Env> {
  const r = new Hono<Env>();
  const ctl = app.db.control;
  r.route("/", localTotpAdminRoutes(app));

  r.use("*", async (c, next) => {
    const caller = c.get("caller");
    let ok = caller.principalType === "system";
    if (!ok && caller.principalType === "person" && caller.person && !caller.allowedOps && c.req.method === "GET" && /^\/api\/v1\/admin\/(audit|report|search-quality)$/.test(c.req.path)
        && app.settings.get<boolean>("admin.auditor_key_access", true) !== false)
      ok = await hasRole(app, caller.person.id, "security_auditor");
    if (!ok) throw new HttpReject(403, "forbidden", "Only the admin panel and the system key can access the admin API");
    await next();
  });
  r.use("/internal/*", async (_c, next) => { if (!testHooksEnabled()) throw notFound(); await next(); });
  const adminAudit = (c: { get: (k: "caller") => Caller }, op: string, details: Record<string, unknown> = {}) =>
    audit(app, c.get("caller"), { event_type: "admin", details: { op, ...details, ...(wouldRequireApproval(c as unknown as Context) ? { would_require_approval: true } : {}) } });
  const approval = (c: Context, condition: string, describe: () => string, subject?: string): Promise<Response | null> =>
    requireApproval(c, condition, describe, { app, ...(subject ? { subject } : {}) });
  setConditionalApprovalsWired(true);
  const alertHigh = (code: string, summary: string, details: Record<string, unknown>) =>
    raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code, summary, details });
  const actorOf = (c: { get: (k: "caller") => Caller }): string => c.get("caller").admin?.login ?? adminLoginOf(c as unknown as Context) ?? "system key";
  const custodyAudit = (c: { get: (k: "caller") => Caller }, x: CustodyChange, byOperator = false) => audit(app, c.get("caller"), { event_type: "admin", space_id: x.space,
    details: { op: custodyOp(x.reason), person: x.person, custodian: x.to, previous: x.from, basis: x.basis, levels: x.levels, reason: x.reason,
               ...(byOperator ? { by_operator: true } : {}) } });
  const custodyOffLetter = async (q: pg.PoolClient, policy: CustodyPolicy, ch: CustodyChange, by: string): Promise<void> => {
    if (policy.read === "off" || !mailNotifierFor(app.settings).canDeliver) return;
    const r = (await q.query(
      `SELECT c.assigned_at, p.login, p.display_name, n.login AS n_login, n.active AS n_active, ${showcaseSql("n")} AS n_demo
         FROM personal_custody c JOIN people p ON p.id = c.person_id JOIN people n ON n.id = c.notified_id
        WHERE c.space_id = $1 AND c.instance_id = $2 AND c.notified_id = $3`, [ch.space, app.instanceId, ch.from])).rows[0];
    if (!r || !custodyMailable({ active: r.n_active, demo: r.n_demo, login: r.n_login })) return;
    await enqueueMail(q, app.instanceId, { kind: "custody", to: r.n_login, ...custodyOffMail({ name: (r.display_name as string | null) || (r.login as string) }),
                                           dedupeKey: `custody_off:${ch.space}:${ch.from}:${new Date(r.assigned_at).toISOString()}`, createdBy: by });
  };
  const setBy = (caller: Caller): string => caller.clientLabel?.startsWith("admin:") ? `panel:${caller.clientLabel.slice(6)}` : "system_key";
  const page = (c: any) => ({ limit: intParam(c.req.query("limit"), 100, 1, 500), offset: offsetCursor(c.req.query("cursor")) });
  const uuidParam = (c: any, name = "id"): string => { const v = c.req.param(name); if (!isUuidParam(v)) throw notFound(); return v as string; };

  r.get("/people", async (c) => {
    const { limit, offset } = page(c), q = c.req.query("q"), active = c.req.query("active");
    const test = c.req.query("test");
    if (test !== undefined && test !== "" && test !== "true" && test !== "false") throw invalid("test: true or false");
    const testSql = test === "true" ? ` AND COALESCE(p.attrs->>'demo', '') <> 'true' AND (COALESCE(p.attrs->>'test', '') = 'true' OR ${testLoginSql("p")})` : "";
    const { rows } = await ctl.query(
      `SELECT p.*, (SELECT s.slug FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = p.id) AS personal_space FROM people p
       WHERE p.instance_id = $1 AND ($2::text IS NULL OR p.login ILIKE '%' || $2 || '%' OR p.display_name ILIKE '%' || $2 || '%') AND ($3::boolean IS NULL OR p.active = $3)${testSql}
       ORDER BY p.login LIMIT $4 OFFSET $5`, [app.instanceId, q ?? null, active === undefined ? null : active === "true", limit + 1, offset]);
    return c.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });

  interface OrgOwner { login: string | null; source: "export" | "kept" | "none"; space_id?: string; owner_id?: string }
  const applyOrgOwner = async (q: pg.PoolClient, raw: unknown, warnings: string[]): Promise<OrgOwner> => {
    const org = (await q.query("SELECT s.id, s.owner_id, p.login AS owner_login FROM spaces s LEFT JOIN people p ON p.id = s.owner_id WHERE s.kind = 'org' AND s.instance_id = $1", [app.instanceId])).rows[0];
    if (!org) return { login: null, source: "none" };
    if (org.owner_id) return { login: org.owner_login ?? null, source: "kept" };
    const login = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!login) return { login: null, source: "none" };
    const owner = (await q.query("SELECT id, login FROM people WHERE login = $1 AND instance_id = $2 AND active", [login, app.instanceId])).rows[0];
    if (!owner) { warnings.push(`org_owner_login ${login}: person not found or inactive. No Company knowledge owner was assigned`); return { login: null, source: "none" }; }
    await setSpaceOwner(q, org, owner.id);
    return { login: owner.login, source: "export", space_id: org.id, owner_id: owner.id };
  };

  const uploadPeople = async (c: Context<Env>) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!Array.isArray(b?.people)) throw invalid("Provide a people array");
    if (b.people.length > 20_000) throw invalid("people: at most 20 000 rows at a time");
    const identityLabel = c.get("caller").clientLabel ?? "admin";
    const requireCode = app.settings.get("access.require_department_code", true);
    const confirmed = b.confirm_deactivations;
    if (confirmed !== undefined && !(Number.isInteger(confirmed) && confirmed >= 0))
      throw invalid("confirm_deactivations must be the whole number of people whose deactivation you confirmed, from the preview or the last rejection");
    const confirmBack = b.confirm_reactivations;
    if (confirmBack !== undefined && !(Array.isArray(confirmBack) && confirmBack.length <= 20_000 && confirmBack.every((x: unknown) => typeof x === "string" && /^[^@\s]+@[^@\s]+$/.test(x.trim()))))
      throw invalid("confirm_reactivations is a list of logins (e-mail addresses), up to 20 000, for former employees whose return you confirmed");
    const backConfirmed = new Set<string>(((confirmBack ?? []) as string[]).map((x) => x.trim().toLowerCase()));
    const policy = custodyPolicy(app.settings), tz = instanceTz(app.settings);
    const { person: operator, unknown: operatorUnknown } = await operatorOf(app, c);
    const approver = await personByLogin(app, approverOf(c));
    const selfLogins = new Set([operator?.login, approver?.login].filter((x): x is string => !!x).map((x) => x.toLowerCase()));
    const selfIds = new Set([operator?.id, approver?.id].filter((x): x is string => !!x));
    const sensitive = await orgImportNeedsApproval(ctl, app.instanceId, b.people, { deactivateMissing: !!b.deactivate_missing });
    const widening = await orgImportWidening(ctl, app.instanceId, b.people, { selfIds: operator ? [operator.id] : [], orgOwnerLogin: b.org_owner_login });
    const firstLogins = (xs: readonly string[]) => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? ` and ${xs.length - 5} more` : ""}`;
    const importSummary = (custody: readonly string[] = []) => [
      sensitive.length ? `account links, manager or department role for people with personal records: ${firstLogins(sensitive)}` : "",
      widening.heads.length ? `department heads: ${firstLogins(widening.heads)}` : "",
      widening.self.length ? `department or manager in your own profile: ${firstLogins(widening.self)}` : "",
      widening.orgOwner ? `Company knowledge owner: ${widening.orgOwner}` : "",
      custody.length ? `custodian of former employees’ personal records under the new org structure: ${firstLogins(custody)}` : "",
    ].filter(Boolean).join("; ");
    let covered = approvalIdOf(c) !== null;
    if (sensitive.length || widening.heads.length || widening.self.length || widening.orgOwner) {
      const ap = await approval(c, "identity_links", () => `Importing the org table changes ${importSummary()}`);
      if (ap) return ap;
      covered = true;
    }
    if (approver) {
      const mine = await orgImportWidening(ctl, app.instanceId, b.people, { selfIds: [approver.id], orgOwnerLogin: b.org_owner_login });
      if (mine.self.length || mine.heads.includes(approver.login) || mine.orgOwner === approver.login) return c.json(APPROVER_IS_SUBJECT, 403);
    }
    const uploadId = newId();
    const mailOn = mailNotifierFor(app.settings).canDeliver;
    let sysRecords: readonly Queryable[] | null = null;
    const recordsOf = (): readonly Queryable[] =>
      (sysRecords ??= (["open", "closed"] as const).map((cls) => app.db.records(cls, { classes: ["open", "closed"], tier: "system" })));
    const upload = (checkOutcome: boolean) => tx(ctl, async (q) => {
      await lockCustody(q, app.instanceId);
      const custodyWas = checkOutcome ? await custodyBefore(q, app.instanceId) : null;
      const share = massDeactivationShare(app.settings.get<unknown>("access.mass_deactivation_share", 0.2));
      const mass = b.deactivate_missing ? await deactivationPreview(q, app.instanceId, b.people) : null;
      let created = 0, updated = 0, deactivated = 0, keysRevoked = 0, verifiedIgnored = 0;
      const errors: Array<{ row: number; login: string; message: string; reason?: "reactivation_confirm" }> = [], warnings: string[] = [], seen: string[] = [], touched: string[] = [];
      const rowWarnings: Array<{ row: number; login: string; message: string }> = [];
      const missingCodes = new Map<string, { logins: string[]; rows: number[] }>();
      const parents: Array<{ row: number; login: string; code: string; parent: string }> = [];
      const managers: Array<{ row: number; login: string; manager: string }> = [];
      const firedManagers: Array<{ row: number; login: string; id: string; manager: string }> = [];
      const renamed: Array<{ person: string; from: string; to: string }> = [];
      const detachedRefs: Array<{ row: number; from: string; person: string; personLogin: string; manager_login: string; renamed: string }> = [];
      const danglingWorking = new Map<string, { row: number; from: string; to: string; renamed: string }>();
      const deactivatedPeople: Array<{ person: string; personal_space: string | null }> = [], reactivatedPeople: Array<{ person: string; personal_space: string | null }> = [];
      const reactivatedUnits: string[] = [], testUnitWarned = new Set<string>();
      const touchedUnits = new Set<string>(), offIds: string[] = [];
      const snapshots = new Map<string, { manager: string | null; units: string[] }>(), corrections = new Map<string, string>(), backIds: string[] = [];
      const snapFromRow = new Set<string>(), realCorrections = new Set<string>();
      const recheck: Array<{ row: number; login: string; id: string; since: Date | null }> = [];
      const linkChanges: Array<IdentityLinkChange & { person: string }> = [];
      const txMode = await securityModeInTx(app, q);
      const rolesSecondSignature = secondSignatureOn(app) || txMode === "advanced";
      const rolesHumanOnly = !rolesSecondSignature && txMode === "basic" && humanSessionsHere() && !isHumanSession(c.get("caller").admin ?? null);
      const rolesBack = rolesHumanOnly || rolesSecondSignature;
      const adminRolesBack: Array<{ person: string; login: string; grant: string; role: string; revoked: boolean; reason?: "human_session" | "second_signature" }> = [];
      const freshCards = new Set<string>();
      const repeats = peopleBatchRepeats(b.people);
      for (const [n, p] of (b.people as any[]).entries()) {
        const row = n + 1;
        const login = rowLogin(p);
        const inForce = repeats.skipped.get(n);
        if (inForce !== undefined) { rowWarnings.push({ row, login, message: `login appears more than once in the import. Row ${inForce + 1} takes precedence and this row was skipped` }); continue; }
        if (!/^[^@\s]+@[^@\s]+$/.test(login) || !p?.display_name) { errors.push({ row, login, message: "login (e-mail address) and display_name are required" }); continue; }
        const sameEmployee = repeats.employee.get(n);
        if (sameEmployee) { errors.push({ row, login, message: `employee ID ${sameEmployee.employeeId} appears more than once in the import (rows ${rowsText(sameEmployee.rows)}). Each employee must have a unique ID` }); continue; }
        if (p.active !== undefined && typeof p.active !== "boolean") { errors.push({ row, login, message: "active must be a boolean value, not a string" }); continue; }
        const given = givenNameAttr(p.attrs && typeof p.attrs === "object" ? p.attrs.given_name : undefined);
        if (!given.ok) { errors.push({ row, login, message: given.message }); continue; }
        if (given.value !== undefined) p.attrs = { ...p.attrs, given_name: given.value };
        if (p.attrs && typeof p.attrs === "object" && Object.hasOwn(p.attrs, CUSTODY_DETACHED_ATTR)) {
          const { [CUSTODY_DETACHED_ATTR]: _drop, ...rest } = p.attrs;
          p.attrs = rest;
        }
        const manager = typeof p.manager_login === "string" ? p.manager_login.trim().toLowerCase() : "";
        if (manager && manager === login) { errors.push({ row, login, message: "the person is their own manager (manager_login). Leave this field blank for the head of the company" }); continue; }
        const nowActive = p.active !== false;
        const employeeId = rowEmployeeId(p);
        const departmentCode: string | null = p.department && nowActive ? String(p.attrs?.department_code ?? p.department_code ?? "").trim() || null : null;
        if (p.department && nowActive && !departmentCode) {
          const m = missingCodes.get(String(p.department)) ?? { logins: [], rows: [] };
          m.logins.push(login); m.rows.push(row); missingCodes.set(String(p.department), m);
        }
        const parentCode = p.department && nowActive ? String(p.attrs?.parent_department_code ?? p.parent_department_code ?? "").trim() || null : null;
        if (parentCode && departmentCode && parentCode === departmentCode) { errors.push({ row, login, message: `department ${departmentCode} is listed as its own parent department` }); continue; }
        const byLogin = (await q.query("SELECT id, login, active, employee_id, manager_login FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0];
        const byEmployee = employeeId ? (await q.query("SELECT id, login, active, employee_id, manager_login FROM people WHERE employee_id = $1 AND instance_id = $2", [employeeId, app.instanceId])).rows[0] : null;
        if (byEmployee && byLogin && byEmployee.id !== byLogin.id) { errors.push({ row, login, message: `employee_id ${employeeId} belongs to a different person (${byEmployee.login})` }); continue; }
        if (byLogin && employeeId && byLogin.employee_id && byLogin.employee_id !== employeeId) { errors.push({ row, login, message: `${login} already has a different employee_id (${byLogin.employee_id}). The export cannot change the employee ID` }); continue; }
        let id: string, wasActive: boolean | null = byLogin?.active ?? null;
        if (byEmployee && !byLogin) {
          const from: string = byEmployee.login;
          for (const r of (await q.query("SELECT id FROM people WHERE instance_id = $1 AND active AND lower(manager_login) = $2 AND id <> $3",
                                         [app.instanceId, login, byEmployee.id])).rows)
            if (!danglingWorking.has(r.id)) danglingWorking.set(r.id, { row, from, to: login, renamed: byEmployee.id });
          const detached = await renamePersonLogin(q, app.instanceId, byEmployee.id, from, login, { keep: [...snapFromRow, ...realCorrections] });
          renamed.push({ person: byEmployee.id, from, to: login });
          for (const d of detached) detachedRefs.push({ row, from, person: d.person, personLogin: d.login, manager_login: login, renamed: byEmployee.id });
          renameCustodyManager(snapshots, corrections, from, login,
                               await custodyDetachedAmong(q, [...new Set([...snapshots.keys(), ...corrections.keys()])], from));
          rowWarnings.push({ row, login, message: `employee ID ${employeeId} already belongs to ${from}. The login changed from ${from} to ${login}. If the person did not change their last name or e-mail address, correct the employee ID` });
          id = byEmployee.id; wasActive = byEmployee.active;
        } else if (byLogin) id = byLogin.id;
        else {
          const derived = personId(login);
          id = (await q.query("SELECT 1 FROM people WHERE id = $1", [derived])).rowCount ? newId() : derived;
        }
        const before = byLogin ?? byEmployee;
        if (wasActive === false && nowActive) {
          const proven = !!employeeId && before?.employee_id === employeeId;
          const ask = proven || backConfirmed.has(login) ? null : await reactivationProof(q, app.instanceId, policy, { id, login }, recordsOf, snapshots);
          if (ask?.why) {
            errors.push({ row, login, message: reactivationConfirmText(ask.since, ask.why, tz), reason: "reactivation_confirm" });
            continue;
          }
          if (ask) recheck.push({ row, login, id, since: ask.since });
        }
        if (!nowActive && before && manager && String(before.manager_login ?? "").trim().toLowerCase() !== manager
            && (operatorUnknown || selfLogins.has(manager))) {
          errors.push({ row, login, message: operatorUnknown ? CUSTODIAN_OPERATOR_UNLINKED_ROW : CUSTODIAN_OPERATOR_ROW });
          continue;
        }
        const repeat = !nowActive && wasActive === false && manager ? await storedManagerRepeat(q, app.instanceId, id, manager, before?.manager_login ?? null) : null;
        const rowManager = repeat ?? manager;
        const fresh = !byLogin && !byEmployee;
        const res = fresh
          ? await q.query(
            `INSERT INTO people (id, login, employee_id, display_name, department, manager_login, role, instance_id, active, attrs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT DO NOTHING RETURNING true AS inserted`,
            [id, login, employeeId, p.display_name, p.department ?? null, manager || null, p.role ?? null, app.instanceId, nowActive, JSON.stringify(p.attrs ?? {})])
          : await q.query(
            `UPDATE people SET display_name = $2, employee_id = COALESCE($3, employee_id), department = $4,
                    manager_login = CASE WHEN $7::boolean THEN $5 ELSE COALESCE($5, manager_login) END, role = $6, active = $7,
                    attrs = ((CASE WHEN $7::boolean THEN attrs - '${CUSTODY_DETACHED_ATTR}' ELSE attrs END) - 'unit_relation') || $8::jsonb
              WHERE id = $1 RETURNING false AS inserted`,
            [id, p.display_name, employeeId, p.department ?? null, rowManager || null, p.role ?? null, nowActive, JSON.stringify(p.attrs ?? {})]);
        if (!res.rowCount) { errors.push({ row, login, message: "a directory sign-in created a profile with this login during the import. Try importing again" }); continue; }
        seen.push(id);
        if (nowActive) touched.push(id);
        if (manager && nowActive) managers.push({ row, login, manager });
        else if (manager && repeat === null) firedManagers.push({ row, login, id, manager });
        res.rows[0].inserted ? created++ : updated++;
        if (res.rows[0].inserted) freshCards.add(id);
        if (!nowActive) deactivated++;
        await ensurePersonalSpace(q, app.instanceId, id, login, p.display_name);
        if (!nowActive) {
          offIds.push(id);
          const s = (await q.query("UPDATE spaces SET archived_at = now() WHERE kind = 'personal' AND owner_id = $1 AND archived_at IS NULL RETURNING slug", [id])).rows[0];
          keysRevoked += await revokeKeysOf(q, "person", id);
          await endPersonSessions(app, [id], "deactivated", q);
          if (s || wasActive !== false) deactivatedPeople.push({ person: id, personal_space: s?.slug ?? null });
        } else if (wasActive === false) {
          const s = (await q.query("UPDATE spaces SET archived_at = NULL WHERE kind = 'personal' AND owner_id = $1 AND archived_at IS NOT NULL RETURNING slug", [id])).rows[0];
          reactivatedPeople.push({ person: id, personal_space: s?.slug ?? null });
          backIds.push(id);
          const roles = (rolesSecondSignature
            ? await q.query(`UPDATE role_grants SET revoked_at = now() WHERE person_id = $1 AND instance_id = $2 AND (role_code = ANY($3::text[]) OR scope_kind = 'company')
                                AND revoked_at IS NULL RETURNING id, role_code`, [id, app.instanceId, WIDE_ROLES])
            : rolesHumanOnly
            ? await q.query(`UPDATE role_grants SET revoked_at = now() WHERE person_id = $1 AND instance_id = $2 AND role_code = ANY($3::text[]) AND revoked_at IS NULL
                              RETURNING id, role_code`, [id, app.instanceId, ADMIN_ROLES])
            : await q.query(`SELECT id, role_code FROM role_grants WHERE person_id = $1 AND instance_id = $2 AND role_code = ANY($3::text[]) AND revoked_at IS NULL
                                AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [id, app.instanceId, ADMIN_ROLES])).rows as Array<{ id: string; role_code: string }>;
          for (const g of roles)
            adminRolesBack.push({ person: id, login, grant: g.id, role: g.role_code, revoked: rolesBack,
                                  ...(rolesBack ? { reason: rolesSecondSignature ? "second_signature" as const : "human_session" as const } : {}) });
        }
        const unitsBefore = (await q.query("DELETE FROM person_org_units WHERE person_id = $1 AND source = 'org_table' RETURNING org_unit_id", [id])).rows.map((x) => x.org_unit_id as string);
        for (const u of unitsBefore) touchedUnits.add(u);
        if (!nowActive && wasActive !== false) {
          const snap = manager || String(before?.manager_login ?? "").trim().toLowerCase() || null;
          snapshots.set(id, { manager: snap, units: unitsBefore });
          if (manager) snapFromRow.add(id);
          else if (snap && danglingWorking.get(id)?.to === snap) {
            const dw = danglingWorking.get(id)!;
            if ((await markCustodyDetached(q, [id], snap)).length) detachedRefs.push({ row: dw.row, from: dw.from, person: id, personLogin: login, manager_login: snap, renamed: dw.renamed });
          }
        } else if (!nowActive && rowManager) {
          corrections.set(id, rowManager);
          if (repeat === null) realCorrections.add(id);
        }
        if (p.department && nowActive) {
          const code = departmentCode ?? slugify(p.department, "unit"), uid = orgUnitId(app.instanceId, code);
          touchedUnits.add(uid);
          const testRow = isTestDomainLogin(login) && !isShowcaseLogin(login);
          const prev = (await q.query("SELECT active, attrs->>'real' AS real FROM org_units WHERE id = $1 FOR UPDATE", [uid])).rows[0];
          await q.query(
            `INSERT INTO org_units (id, code, name, instance_id, attrs)
             VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN '{"origin":"test"}'::jsonb ELSE '{"real":true}'::jsonb END)
             ON CONFLICT (id) DO UPDATE SET
               name   = CASE WHEN $5::boolean AND org_units.attrs->>'real' = 'true' THEN org_units.name ELSE EXCLUDED.name END,
               active = org_units.active OR NOT $5::boolean,
               attrs  = CASE WHEN $5::boolean THEN org_units.attrs ELSE (org_units.attrs - 'origin') || '{"real":true}'::jsonb END`,
            [uid, code, p.department, app.instanceId, testRow]);
          if (prev && !prev.active) {
            if (testRow) {
              if (!testUnitWarned.has(uid)) rowWarnings.push({ row, login, message: `department ${code} is inactive. A test row cannot reactivate it` });
              testUnitWarned.add(uid);
            } else if (!reactivatedUnits.includes(uid)) {
              rowWarnings.push({ row, login, message: `department ${code} was inactive. The org table import reactivated it` });
              reactivatedUnits.push(uid);
            }
          }
          await q.query("INSERT INTO person_org_units (person_id, org_unit_id, relation, source) VALUES ($1,$2,$3,'org_table') ON CONFLICT DO NOTHING", [id, uid, p.attrs?.unit_relation === "head" ? "head" : p.attrs?.unit_relation === "deputy" ? "deputy" : "member"]);
          if (parentCode) parents.push({ row, login, code, parent: parentCode });
        }
        const identities = (Array.isArray(p.attrs?.identities) ? p.attrs.identities : []) as Array<{ system: string; external_id: string; verified?: boolean }>;
        for (const idn of identities) {
          if (!idn?.system || idn.external_id === undefined) { errors.push({ row, login, message: "identities requires system and external_id" }); continue; }
          const external = identityExternalId(String(idn.system), idn.external_id);
          if (external === null) { errors.push({ row, login, message: `identities: ad:${String(idn.external_id).slice(0, 60)} is not an objectGUID (format 3f2504e0-4f89-11d3-9a0c-0305e82c3301, without braces)` }); continue; }
          if (await importedIdentityOwner(q, String(idn.system), external, id)) { errors.push({ row, login, message: `identifier ${idn.system}:${external} is already linked to a different person` }); continue; }
          if (idn.verified === true) {
            verifiedIgnored++;
            rowWarnings.push({ row, login, message: identityVerifiedIgnoredRow(`${idn.system}:${external}`) });
          }
          if (await upsertImportedIdentity(q, { system: String(idn.system), external, personId: id, verified: false, verifiedBy: null, label: identityLabel }))
            linkChanges.push({ person: id, system: String(idn.system), externalId: external, change: "added" });
        }
        if (b.deactivate_missing && Array.isArray(p.attrs?.identities))
          for (const x of (await q.query(
            "UPDATE person_identities SET active = false WHERE person_id = $1 AND active AND COALESCE(source, '') NOT IN ('ldap_login', 'oidc_login') AND NOT (system || ':' || external_id = ANY($2::text[])) RETURNING system, external_id",
            [id, identities.filter((i) => i?.system).map((i) => `${i.system}:${identityExternalId(String(i.system), i.external_id) ?? i.external_id}`)])).rows)
            linkChanges.push({ person: id, system: x.system as string, externalId: x.external_id as string, change: "removed" });
      }
      if (b.deactivate_missing && errors.length) { const err = invalid("deactivate_missing: the export contains invalid rows. Nothing changed", { errors }); throw err; }
      if (missingCodes.size && requireCode)
        throw invalid("The export contains departments without department_code. The entire batch was rejected and nothing changed (access.require_department_code)", { departments: [...missingCodes].map(([department, m]) => ({ department, logins: m.logins, rows: m.rows })) });
      for (const [department, m] of missingCodes) warnings.push(`department “${department}” has no department_code. The code was generated from the name (${slugify(department, "unit")}), rows: ${m.logins.length}`);
      if (mass && needsMassConfirmation(mass, share) && confirmed !== mass.will_deactivate) throw massDeactivationRefusal(mass, share, confirmed);
      const parentOf = new Map<string, { row: number; login: string; parent: string; conflict: string[] }>();
      for (const x of parents) {
        const prev = parentOf.get(x.code);
        parentOf.set(x.code, { row: prev?.row ?? x.row, login: prev?.login ?? x.login, parent: x.parent, conflict: prev && prev.parent !== x.parent ? [...prev.conflict, prev.parent] : prev?.conflict ?? [] });
      }
      for (const [code, x] of parentOf) {
        const parentId = orgUnitId(app.instanceId, x.parent);
        if (!(await q.query("SELECT 1 FROM org_units WHERE id = $1 AND instance_id = $2", [parentId, app.instanceId])).rowCount) {
          rowWarnings.push({ row: x.row, login: x.login, message: `parent department ${x.parent} was not found in the upload or in the memory. No parent was set for ${code}` });
          continue;
        }
        if (x.conflict.length) rowWarnings.push({ row: x.row, login: x.login, message: `rows for department ${code} list different parent departments (${[...new Set(x.conflict)].join(", ")}, ${x.parent}). The last one was used: ${x.parent}` });
        await q.query("UPDATE org_units SET parent_id = $2 WHERE id = $1 AND parent_id IS DISTINCT FROM $2", [orgUnitId(app.instanceId, code), parentId]);
      }
      if (b.deactivate_missing && seen.length) {
        const demoLeft = (await q.query(
          "SELECT count(*)::int AS n FROM people WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') = 'true' AND id <> ALL($2::uuid[])", [app.instanceId, seen])).rows[0].n as number;
        if (demoLeft) warnings.push(`the export does not affect demo personas: ${demoLeft}`);
        const gone = (await q.query(
          "UPDATE people SET active = false, attrs = attrs - 'unit_relation' WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') <> 'true' AND id <> ALL($2::uuid[]) RETURNING id, login, manager_login", [app.instanceId, seen])).rows;
        if (gone.length) {
          offIds.push(...gone.map((g) => g.id as string));
          for (const g of gone) {
            snapshots.set(g.id, { manager: g.manager_login ?? null, units: [] });
            const dw = danglingWorking.get(g.id), m = String(g.manager_login ?? "").trim().toLowerCase();
            if (dw && dw.to === m && (await markCustodyDetached(q, [g.id], m)).length)
              detachedRefs.push({ row: dw.row, from: dw.from, person: g.id, personLogin: g.login, manager_login: m, renamed: dw.renamed });
          }
          for (const x of (await q.query("DELETE FROM person_org_units WHERE person_id = ANY($1::uuid[]) AND source = 'org_table' RETURNING person_id, org_unit_id", [gone.map((g) => g.id)])).rows) {
            touchedUnits.add(x.org_unit_id);
            snapshots.get(x.person_id)?.units.push(x.org_unit_id);
          }
        }
        deactivated += gone.length;
        for (const g of gone) {
          const s = (await q.query("UPDATE spaces SET archived_at = now() WHERE kind = 'personal' AND owner_id = $1 AND archived_at IS NULL RETURNING slug", [g.id])).rows[0];
          keysRevoked += await revokeKeysOf(q, "person", g.id);
          await endPersonSessions(app, [g.id], "deactivated", q);
          deactivatedPeople.push({ person: g.id, personal_space: s?.slug ?? null });
        }
      }
      if (managers.length) {
        const known = new Map<string, boolean>((await q.query("SELECT login, active FROM people WHERE instance_id = $1 AND login = ANY($2::text[])",
          [app.instanceId, [...new Set(managers.map((m) => m.manager))]])).rows.map((r) => [r.login as string, r.active as boolean]));
        for (const m of managers) {
          const active = known.get(m.manager);
          if (active === undefined) rowWarnings.push({ row: m.row, login: m.login, message: `manager ${m.manager} was not found in the import or in memory` });
          else if (!active) rowWarnings.push({ row: m.row, login: m.login, message: `manager ${m.manager} is inactive` });
        }
      }
      await q.query(
        `INSERT INTO person_org_units (person_id, org_unit_id, relation, source)
         SELECT DISTINCT ON (u.id) m.id, u.id, 'head', 'org_table'
         FROM org_units u JOIN person_org_units pu ON pu.org_unit_id = u.id JOIN people p ON p.id = pu.person_id AND p.active
         JOIN people m ON m.login = p.manager_login AND m.active AND m.instance_id = u.instance_id
         WHERE u.instance_id = $1 AND NOT EXISTS (SELECT 1 FROM person_org_units h JOIN people hp ON hp.id = h.person_id AND hp.active WHERE h.org_unit_id = u.id AND h.relation = 'head')
         GROUP BY u.id, m.id ORDER BY u.id, count(*) DESC ON CONFLICT DO NOTHING`, [app.instanceId]);
      const custody = await syncCustody(q, app.instanceId, policy, { snapshots, corrections, reactivated: backIds });
      const late: typeof errors = [];
      for (const x of recheck)
        if (await managerOfKept(q, app.instanceId, policy, x))
          late.push({ row: x.row, login: x.login, message: reactivationConfirmText(x.since, "manager", tz), reason: "reactivation_confirm" });
      if (late.length)
        throw invalid(REACTIVATION_LATE, { errors: [...errors.filter((e) => e.reason === "reactivation_confirm"), ...late].sort((a, b) => a.row - b.row) });
      const detachedNow = detachedRefs.filter((d) => !backIds.includes(d.person));
      const keptRows = new Map<string, { space: string; basis: string }>((await q.query(
        "SELECT person_id, space_id, basis FROM personal_custody WHERE instance_id = $1 AND person_id = ANY($2::uuid[])",
        [app.instanceId, [...new Set([...detachedNow.map((d) => d.person), ...firedManagers.map((m) => m.id)])]])).rows
        .map((r) => [r.person_id as string, { space: r.space_id as string, basis: r.basis as string }]));
      const detachedEvents = detachedNow.map((d) => ({ person: d.person, space: keptRows.get(d.person)?.space ?? null, manager_login: d.manager_login, renamed: d.renamed }));
      for (const d of detachedNow)
        rowWarnings.push({ row: d.row, login: d.manager_login, message: custodyDetachedRow({ person: d.personLogin, snapshot: keptRows.has(d.person) }, d.from, d.manager_login) });
      const firedKept = firedManagers.filter((m) => { const k = keptRows.get(m.id); return !!k && k.basis !== "manual"; });
      if (firedKept.length) {
        const w = await custodyWorld(q, app.instanceId);
        for (const m of firedKept) {
          const mgr = (snapshots.get(m.id)?.manager ?? corrections.get(m.id) ?? m.manager).trim().toLowerCase(), who = w.byId.get(m.id);
          if (!w.byLogin.has(mgr)) rowWarnings.push({ row: m.row, login: m.login, message: custodyManagerMissingRow(mgr) });
          else if (who && lateManager(w, who, { manager_login: mgr })) rowWarnings.push({ row: m.row, login: m.login, message: custodyManagerLateRow(mgr) });
        }
      }
      const selfKept = custody.changes.filter((ch) => !!ch.to && selfIds.has(ch.to)).map((ch) => ch.person);
      if (selfKept.length) {
        const logins = (await q.query("SELECT login FROM people WHERE id = ANY($1::uuid[]) ORDER BY login", [selfKept])).rows.map((x) => x.login as string);
        throw new MemoryError("invalid_argument", custodianOperatorWarning(logins), { reason: CUSTODIAN_IS_OPERATOR, details: { reason: CUSTODIAN_IS_OPERATOR, logins } });
      }
      let custodyRerouting: string[] = [];
      if (custodyWas) {
        const ids = await custodyRerouted(q, app.instanceId, custodyWas, custody.changes);
        if (ids.length) {
          custodyRerouting = (await q.query("SELECT login FROM people WHERE id = ANY($1::uuid[]) ORDER BY login", [ids])).rows.map((x) => x.login as string);
          if (secondSignatureOn(app) || approvalIdOf(c) !== null) throw new CustodyNeedsSignature(custodyRerouting);
        }
      }
      const adChanged = [...new Set(linkChanges.filter((x) => x.system === "ad").map((x) => x.person))];
      if (adChanged.length && await externalAccessInstalled(q)) for (const person of adChanged) await externalAdLinkChanged(q, person);
      const linkPeople = [...new Set(linkChanges.map((x) => x.person))].filter((id) => !freshCards.has(id));
      if (linkPeople.length && mailOn) {
        const link = app.settings.str("access.workplace_url") || null;
        for (const p of (await q.query(`SELECT id, login, active, ${showcaseSql("p")} AS demo FROM people p WHERE id = ANY($1::uuid[])`, [linkPeople])).rows)
          if (identityMailable({ active: p.active, demo: p.demo, login: p.login }))
            await enqueueMail(q, app.instanceId, { kind: "identity_change", to: p.login, ...identityChangeMail({ changes: linkChanges.filter((x) => x.person === p.id), link }),
                                                   dedupeKey: identityChangeMailKey(p.id, uploadId), createdBy: setBy(c.get("caller")) });
      }
      if (seen.length && !(await q.query("SELECT 1 FROM spaces WHERE kind = 'org' AND instance_id = $1", [app.instanceId])).rowCount)
        await insertSpace(q, { id: newId(), kind: "org", name: ORG_SPACE_NAME, description: ORG_SPACE_DESCRIPTION, owner_id: null, instance_id: app.instanceId,
                               default_class: "open", created_via: "org_table" }, slugCandidates("org"));
      const orgOwner = await applyOrgOwner(q, b.org_owner_login, warnings);
      const access = await reconcileAccess(q, app.instanceId, app.settings.get("access.org_spaces_auto_create", true));
      if (offIds.length) for (const x of (await q.query("SELECT DISTINCT org_unit_id FROM person_org_units WHERE person_id = ANY($1::uuid[])", [offIds])).rows) touchedUnits.add(x.org_unit_id);
      warnings.push(...await departmentsWithoutHeadWarnings(q, app.instanceId, touchedUnits));
      if (deactivatedPeople.length) {
        for (const x of (await q.query(
          `SELECT p.login, array_agg(s.slug ORDER BY s.slug) AS slugs FROM spaces s JOIN people p ON p.id = s.owner_id
           WHERE s.owner_id = ANY($1::uuid[]) AND s.instance_id = $2 AND s.kind IN ('team','project','org') AND s.org_unit_id IS NULL AND s.archived_at IS NULL
           GROUP BY p.login ORDER BY p.login`, [deactivatedPeople.map((d) => d.person), app.instanceId])).rows)
          warnings.push(`${x.login} has left the company and owned these spaces: ${(x.slugs as string[]).slice(0, 10).join(", ")}${x.slugs.length > 10 ? ` and ${x.slugs.length - 10} more` : ""}. Assign an owner in “Spaces”`);
      }
      return { created, updated, deactivated, renamed: renamed.length, keys_revoked: keysRevoked, identities_verified_ignored: verifiedIgnored, ...(errors.length ? { errors } : {}), warnings, row_warnings: rowWarnings,
               org_owner: { login: orgOwner.login, source: orgOwner.source }, access, custody: custodyCounts(custody.changes, custody.waiting.length),
               ...(adminRolesBack.some((x) => x.revoked) ? { admin_roles_revoked: adminRolesBack.filter((x) => x.revoked).map((x) => ({ login: x.login, role: x.role })) } : {}),
               events: { renamed, deactivatedPeople, reactivatedPeople, reactivatedUnits, orgOwner, touched, custody: custody.changes,
                         detached: detachedEvents, links: linkChanges, custodyRerouting, adminRolesBack } };
    });
    let out: Awaited<ReturnType<typeof upload>>;
    try { out = await upload(!covered); }
    catch (e) {
      if (!(e instanceof CustodyNeedsSignature)) throw e;
      const ap = await approval(c, "identity_links", () => `Importing the org table changes ${importSummary(e.logins)}`);
      if (ap) return ap;
      out = await upload(false);
    }
    if (out.events.custodyRerouting.length && !covered && !secondSignatureOn(app)) await approval(c, "identity_links", () => `Importing the org table changes ${importSummary(out.events.custodyRerouting)}`);
    await app.queue.wake("profiles_sync");
    const { events, ...body } = out;
    for (const x of events.renamed) await adminAudit(c, "person_login_changed", x);
    for (const x of events.detached) await audit(app, c.get("caller"), { event_type: "admin", space_id: x.space,
      details: { op: "custody_manager_detached", person: x.person, manager_login: x.manager_login, renamed: x.renamed } });
    for (const x of events.deactivatedPeople) await adminAudit(c, "person_deactivated", x);
    for (const x of events.reactivatedPeople) await adminAudit(c, "person_reactivated", x);
    for (const x of events.adminRolesBack) {
      const second = x.reason === "second_signature";
      if (x.revoked) await adminAudit(c, "grant_revoke", { grant_id: x.grant, role: x.role, person: x.person,
                                                          reason: second ? "reactivated_without_second_signature" : "reactivated_without_human_session" });
      await alertHigh("admin_role_changed", x.revoked
        ? second
          ? `Profile ${x.login} is active again and role ${x.role} was revoked. Assign the role with a second signature to restore it (${actorOf(c)})`
          : `Profile ${x.login} is active again and role ${x.role} was revoked. Only an administrator in a personal session can restore it (${actorOf(c)})`
        : `Profile ${x.login} and role ${x.role} are active again (${actorOf(c)})`, { role: x.role, person: x.person, action: x.revoked ? "revoked" : "reactivated" });
    }
    for (const unit of events.reactivatedUnits) await adminAudit(c, "org_unit_reactivated", { unit });
    if (events.orgOwner.source === "export") await adminAudit(c, "space_owner_set", { space: events.orgOwner.space_id, owner: events.orgOwner.owner_id, source: "export" });
    for (const x of events.custody) await custodyAudit(c, x);
    for (const x of events.links) await adminAudit(c, "identity_links_change", { person: x.person, system: x.system, external_id: x.externalId, change: x.change });
    const linkPeople = [...new Set(events.links.map((x) => x.person))];
    if (linkPeople.length)
      for (const p of (await ctl.query(
        `SELECT DISTINCT p.id, p.login FROM people p JOIN role_grants g ON g.person_id = p.id AND g.instance_id = p.instance_id
          WHERE p.id = ANY($1::uuid[]) AND g.role_code IN ('memory_admin', 'security_auditor') AND g.revoked_at IS NULL AND g.valid_from <= now()
            AND (g.valid_to IS NULL OR g.valid_to > now())`, [linkPeople])).rows)
        await alertHigh("identity_links_changed", `The org table import changed administrator or auditor accounts for ${p.login} (${actorOf(c)})`,
          { person: p.id, system: [...new Set(events.links.filter((x) => x.person === p.id).map((x) => x.system))].join(","), action: "org_import" });
    if (events.deactivatedPeople.length || events.reactivatedPeople.length || events.custody.length) await app.queue.wake("dismissed_retention");
    if (events.touched.length) {
      const live = (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[]) AND active AND COALESCE(attrs->>'demo','') <> 'true'", [events.touched])).rows;
      await grantPendingMeetings(app, live, "people_upsert", c.get("caller"));
      await grantSpaceInvites(app, live, "people_upsert");
    }
    await adminAudit(c, "people_upsert", { created: out.created, updated: out.updated, deactivated: out.deactivated, renamed: out.renamed, keys_revoked: out.keys_revoked,
                                           identities_verified_ignored: out.identities_verified_ignored });
    return c.json(body);
  };
  r.put("/people", orgTableSource(uploadPeople).people.upload);

  r.post("/people/deactivation-preview", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!Array.isArray(b?.people)) throw invalid("Provide a people array");
    if (b.people.length > 20_000) throw invalid("people: at most 20 000 rows at a time");
    const out = await deactivationPreview(ctl, app.instanceId, b.people);
    const share = massDeactivationShare(app.settings.get<unknown>("access.mass_deactivation_share", 0.2));
    return c.json({ ...out, share, needs_confirmation: needsMassConfirmation(out, share) });
  });

  r.get("/org-units", async (c) => c.json({ items: (await ctl.query(
    `SELECT u.id, u.code, u.name, (SELECT code FROM org_units p WHERE p.id = u.parent_id) AS parent_code, u.active,
            u.attrs->>'origin' AS origin, COALESCE(u.attrs->>'real', '') = 'true' AS real,
            (SELECT s.slug FROM spaces s WHERE s.org_unit_id = u.id) AS space,
            (SELECT array_agg(p.login ORDER BY p.login) FROM person_org_units pu JOIN people p ON p.id = pu.person_id WHERE pu.org_unit_id = u.id AND pu.relation = 'head') AS heads,
            (SELECT count(DISTINCT pu.person_id)::int FROM person_org_units pu JOIN people p ON p.id = pu.person_id AND p.active WHERE pu.org_unit_id = u.id) AS members,
            (EXISTS (SELECT 1 FROM person_org_units pu JOIN people p ON p.id = pu.person_id WHERE pu.org_unit_id = u.id AND COALESCE(p.attrs->>'demo','') = 'true')
             AND NOT EXISTS (SELECT 1 FROM person_org_units pu JOIN people p ON p.id = pu.person_id WHERE pu.org_unit_id = u.id AND COALESCE(p.attrs->>'demo','') <> 'true')) AS demo
     FROM org_units u WHERE u.instance_id = $1 ORDER BY u.code`, [app.instanceId])).rows }));

  r.put("/org-units", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!Array.isArray(b?.org_units)) throw invalid("Provide an org_units array");
    if (b.org_units.some((u: any) => !u?.name)) throw invalid("Each org unit requires name and code");
    if (b.org_units.some((u: any) => u.test !== undefined && typeof u.test !== "boolean")) throw invalid("test must be a boolean value, not a string");
    const warnings: string[] = [];
    const missing: string[] = b.org_units.filter((u: any) => !String(u?.code ?? "").trim()).map((u: any) => String(u.name));
    if (missing.length && app.settings.get("access.require_department_code", true))
      throw invalid("The export contains departments without code (department_code). The entire batch was rejected and nothing changed (access.require_department_code)", { departments: missing.map((department) => ({ department })) });
    for (const n of missing) warnings.push(`department “${n}” has no code. The code was generated from the name (${slugify(n, "unit")})`);
    const codeOf = (u: any): string => String(u.code ?? "").trim() || slugify(String(u.name), "unit");
    const moved: string[] = [];
    for (const u of b.org_units) {
      const id = orgUnitId(app.instanceId, codeOf(u));
      const cur = (await ctl.query("SELECT parent_id FROM org_units WHERE id = $1 AND instance_id = $2", [id, app.instanceId])).rows[0];
      const parent = u.parent_code ? orgUnitId(app.instanceId, String(u.parent_code)) : null;
      if (cur && (cur.parent_id ?? null) !== parent) { moved.push(codeOf(u)); continue; }
      if (u.head_login === undefined) continue;
      const heads = (await ctl.query("SELECT p.login FROM person_org_units pu JOIN people p ON p.id = pu.person_id WHERE pu.org_unit_id = $1 AND pu.relation = 'head'", [id])).rows.map((x) => String(x.login));
      const next = u.head_login ? [String(u.head_login).toLowerCase()] : [];
      if (heads.length !== next.length || heads.some((h) => !next.includes(h))) moved.push(codeOf(u));
    }
    const orgOwner = (await orgImportWidening(ctl, app.instanceId, [], { orgOwnerLogin: b.org_owner_login })).orgOwner;
    if (moved.length || orgOwner) {
      const ap = await approval(c, "org_unit_managers", () => [
        moved.length ? `Change department heads or parent department: ${moved.slice(0, 5).join(", ")}${moved.length > 5 ? ` and ${moved.length - 5} more` : ""}` : "",
        orgOwner ? `Assign Company knowledge owner: ${orgOwner}` : "",
      ].filter(Boolean).join("; "));
      if (ap) return ap;
      const signer = approverOf(c)?.trim().toLowerCase();
      if (signer && (orgOwner === signer || b.org_units.some((u: any) => typeof u.head_login === "string" && u.head_login.trim().toLowerCase() === signer)))
        return c.json(APPROVER_IS_SUBJECT, 403);
    }
    const out = await tx(ctl, async (q) => {
      for (const u of b.org_units) {
        const code = codeOf(u), id = orgUnitId(app.instanceId, code);
        await q.query(
          `INSERT INTO org_units (id, code, name, instance_id, active, attrs)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN '{"origin":"test"}'::jsonb ELSE '{}'::jsonb END)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active,
             attrs = CASE WHEN NOT $6::boolean THEN org_units.attrs - 'origin'
                          WHEN COALESCE(org_units.attrs->>'real', '') <> 'true' THEN org_units.attrs || '{"origin":"test"}'::jsonb
                          ELSE org_units.attrs END`,
          [id, code, u.name, app.instanceId, u.active !== false, u.test === true]);
      }
      for (const u of b.org_units) {
        const id = orgUnitId(app.instanceId, codeOf(u));
        await q.query("UPDATE org_units SET parent_id = $2 WHERE id = $1", [id, u.parent_code ? orgUnitId(app.instanceId, u.parent_code) : null]);
        if (u.head_login !== undefined) {
          const dropped = (await q.query("DELETE FROM person_org_units WHERE org_unit_id = $1 AND relation = 'head' RETURNING person_id, source", [id])).rows;
          let headId: string | null = null;
          if (u.head_login) {
            const p = (await q.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [String(u.head_login).toLowerCase(), app.instanceId])).rows[0];
            if (!p) throw invalid(`Department head ${u.head_login} was not found in the org table`);
            headId = p.id;
            await q.query("INSERT INTO person_org_units (person_id, org_unit_id, relation, source) VALUES ($1,$2,'head','directory') ON CONFLICT DO NOTHING", [p.id, id]);
          }
          const former = dropped.filter((x) => x.source === "org_table" && x.person_id !== headId).map((x) => x.person_id as string);
          if (former.length) {
            await q.query("UPDATE people SET attrs = attrs - 'unit_relation' WHERE id = ANY($1::uuid[]) AND attrs->>'unit_relation' = 'head'", [former]);
            await q.query(
              `INSERT INTO person_org_units (person_id, org_unit_id, relation, source)
               SELECT p.id, $2, 'member', 'org_table' FROM people p WHERE p.id = ANY($1::uuid[]) AND p.active ON CONFLICT DO NOTHING`, [former, id]);
          }
        }
      }
      const orgOwner = await applyOrgOwner(q, b.org_owner_login, warnings);
      const access = await reconcileAccess(q, app.instanceId, app.settings.get("access.org_spaces_auto_create", true));
      warnings.push(...await departmentsWithoutHeadWarnings(q, app.instanceId, b.org_units.map((u: any) => orgUnitId(app.instanceId, codeOf(u)))));
      return { access, orgOwner };
    });
    if (out.orgOwner.source === "export") await adminAudit(c, "space_owner_set", { space: out.orgOwner.space_id, owner: out.orgOwner.owner_id, source: "export" });
    await adminAudit(c, "org_units_upsert", { count: b.org_units.length });
    return c.json({ updated: b.org_units.length, access: out.access, ...(warnings.length ? { warnings } : {}), org_owner: { login: out.orgOwner.login, source: out.orgOwner.source } });
  });

  r.get("/roles", async (c) => c.json({ items: (await ctl.query("SELECT code, name, description, origin, memory_effect, derived, active FROM roles ORDER BY memory_effect = 'none', code")).rows }));

  const ADMIN_ROLES = ["memory_admin", "security_auditor"], WIDE_ROLES = [...ADMIN_ROLES, "company_management", "branch_reader", "org_curator"];
  const GRANT_MODE_CHANGED = { code: "conflict", reason: "security_mode_changed",
    message: "The security mode changed to advanced during the role change. Nothing changed. Try again with a second signature" } as const;
  const grantModeRefusal = async (c: Context, q: pg.PoolClient, roleCode: string, needsSignature: boolean): Promise<"human_session" | "advanced" | null> => {
    const txMode = await securityModeInTx(app, q);
    if (approvalIdOf(c) !== null) return null;
    if (ADMIN_ROLES.includes(roleCode) && txMode === "basic" && humanSessionsHere() && !isHumanSession(c.get("caller").admin ?? null)) return "human_session";
    if (needsSignature && txMode === "advanced") return "advanced";
    return null;
  };
  const WIDE_SQL ="(g.role_code IN ('memory_admin','security_auditor') OR g.scope_kind = 'company')";
  r.get("/grants", async (c) => {
    const { limit, offset } = page(c);
    const login = c.req.query("login"), wideOnly = c.req.query("wide") === "true", role = c.req.query("role");
    const { rows } = await ctl.query(
      `SELECT g.id, p.login, p.display_name, p.active AS person_active, g.role_code, g.actions, g.scope_kind, g.scope_ref, g.basis_source, g.basis_ref, g.approved_by, g.approved_at, g.valid_from, g.valid_to, g.revoked_at,
              (g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now())) AS effective, ${WIDE_SQL} AS wide
       FROM role_grants g JOIN people p ON p.id = g.person_id WHERE g.instance_id = $1 AND ($2::text IS NULL OR p.login = $2) AND (NOT $3 OR ${WIDE_SQL}) AND ($6::text IS NULL OR g.role_code = $6)
       ORDER BY g.created_at DESC, g.id DESC LIMIT $4 OFFSET $5`,
      [app.instanceId, login?.toLowerCase() ?? null, wideOnly, limit + 1, offset, role ?? null]);
    return c.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });

  r.post("/grants", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    const caller = c.get("caller");
    const person = (await ctl.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2 AND active", [String(b?.login ?? "").toLowerCase(), app.instanceId])).rows[0];
    if (!person) throw invalid("Person not found or inactive");
    const self = caller.admin?.personId ?? (caller.principalType === "person" ? caller.person?.id : null) ?? null;
    const basicMode = effectiveMode(app.settings) === "basic" && humanSessionsHere();
    if (self && self === person.id)
      throw new HttpReject(403, "forbidden", basicMode && ADMIN_ROLES.includes(String(b?.role_code ?? "")) ? "You cannot assign a role to yourself. Another memory administrator must do it in a personal session"
        : "You cannot assign a role to yourself. Use another memory administrator or a system key");
    const role = (await ctl.query("SELECT code, derived, memory_effect FROM roles WHERE code = $1 AND active", [b.role_code])).rows[0];
    if (!role) throw invalid("The role is missing from the directory");
    if (ADMIN_ROLES.includes(role.code) && basicMode && !isHumanSession(caller.admin ?? null)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (role.derived) throw invalid("This role comes from the org table and cannot be assigned manually");
    if (!b.basis_source) throw invalid("Provide a basis for the grant: basis_source and basis_ref, the request or decision number");
    const scopeKind = String(b.scope_kind ?? "own"), scopeRef = b.scope_ref ? String(b.scope_ref) : null;
    const orgSlug: string | null = (await ctl.query("SELECT slug FROM spaces WHERE kind = 'org' AND instance_id = $1 AND archived_at IS NULL", [app.instanceId])).rows[0]?.slug ?? null;
    if (role.code === "org_curator" && (scopeKind !== "space" || !orgSlug || scopeRef !== orgSlug))
      throw invalid(`The curator role only applies to “Company knowledge”: scope_kind = space, scope_ref = ${orgSlug ?? "org (Company knowledge does not exist yet. Import the org table)"}`);
    if (role.code === "security_auditor") {
      const op = (await ctl.query("SELECT login FROM admin_users WHERE person_id = $1 AND instance_id = $2 AND disabled_at IS NULL", [person.id, app.instanceId])).rows[0];
      if (op) throw invalid(`The security auditor audits the local administrator’s actions, so these roles must belong to different people (admin@local: ${op.login}). First select another person on the “Administrator access” page`);
    }
    const wide = ["memory_admin", "security_auditor"].includes(role.code) || scopeKind === "company";
    if (wide) {
      if (!["request", "manual"].includes(String(b.basis_source))) throw invalid("For a broad grant (memory_admin, security_auditor, company scope), set basis_source to request or manual");
      if (typeof b.basis_ref !== "string" || b.basis_ref.trim().length < 3) throw invalid("A broad grant (memory_admin, security_auditor, company scope) requires basis_ref, a request or decision number of at least 3 characters");
    }
    if (["org_unit", "org_branch"].includes(scopeKind)) {
      if (!scopeRef || !(await ctl.query("SELECT 1 FROM org_units WHERE instance_id = $1 AND code = $2", [app.instanceId, scopeRef])).rowCount) throw invalid(`Org unit ${scopeRef ?? ""} was not found`);
    } else if (scopeKind === "space" && role.code !== "org_curator") {
      const s = scopeRef ? (await ctl.query("SELECT kind, archived_at FROM spaces WHERE instance_id = $1 AND slug = $2", [app.instanceId, scopeRef])).rows[0] : null;
      if (!s) throw invalid(`Space ${scopeRef ?? ""} was not found`);
      if (s.archived_at) throw invalid(`Space ${scopeRef} is archived. To issue a new grant for it, first choose “Restore from archive” in “Spaces”`);
      if (s.kind !== "team" && s.kind !== "project") throw invalid("The space scope must point to a team space or project space. Only the owner can read a personal space, and everyone can read Company knowledge");
    }
    const actions: string[] = Array.isArray(b.actions) && b.actions.length ? b.actions.map(String) : ["view"];
    const compiledRole = role.memory_effect === "space_owner" ? "owner" : role.memory_effect === "space_reader" ? "reader" : null;
    if (WIDE_ROLES.includes(role.code)) {
      const ap = await approval(c, "wide_role", () => `Assign role ${role.code} to ${String(b.login).toLowerCase()}${scopeRef ? ` (scope ${scopeKind}: ${scopeRef})` : ""}`, person.id);
      if (ap) return ap;
    }
    const out = await tx(ctl, async (q) => {
      const refused = await grantModeRefusal(c, q, role.code, WIDE_ROLES.includes(role.code));
      if (refused) return refused;
      const id = newId();
      await q.query(
        `INSERT INTO role_grants (id, person_id, role_code, actions, scope_kind, scope_ref, basis_source, basis_ref, approved_by, approved_at, valid_to, instance_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9::text IS NOT NULL THEN now() END,$10,$11)`,
        [id, person.id, role.code, actions, scopeKind, scopeRef, b.basis_source, b.basis_ref ?? null, b.approved_by ?? null, b.valid_to ?? null, app.instanceId]);
      return { id, memory_effect: role.memory_effect as string, compiled_role: compiledRole, wide, access: await reconcileAccess(q, app.instanceId, false) };
    });
    if (out === "human_session") return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (out === "advanced") return c.json(GRANT_MODE_CHANGED, 409);
    await adminAudit(c, "grant_create", { grant_id: out.id, role: role.code, person: person.id, scope_kind: scopeKind, wide });
    if (ADMIN_ROLES.includes(role.code))
      await alertHigh("admin_role_changed", `Assigned role ${role.code} to ${String(b.login).toLowerCase()} (${actorOf(c)})`, { role: role.code, person: person.id, action: "granted" });
    return c.json(out, 201);
  });

  r.delete("/grants/:id", async (c) => {
    const id = uuidParam(c);
    const cur = (await ctl.query("SELECT g.role_code, g.person_id, p.login FROM role_grants g JOIN people p ON p.id = g.person_id WHERE g.id = $1 AND g.instance_id = $2 AND g.revoked_at IS NULL",
                                 [id, app.instanceId])).rows[0] as { role_code: string; person_id: string; login: string } | undefined;
    if (!cur) throw notFound();
    if (ADMIN_ROLES.includes(cur.role_code) && effectiveMode(app.settings) === "basic" && humanSessionsHere() && !isHumanSession(c.get("caller").admin ?? null)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (ADMIN_ROLES.includes(cur.role_code)) {
      const ap = await approval(c, "admin_role_revoke", () => `Revoke role ${cur.role_code} from ${cur.login}`, cur.person_id);
      if (ap) return ap;
    }
    const access = await tx(ctl, async (q) => {
      const refused = await grantModeRefusal(c, q, cur.role_code, ADMIN_ROLES.includes(cur.role_code));
      if (refused) return refused;
      const res = await q.query("UPDATE role_grants SET revoked_at = now() WHERE id = $1 AND instance_id = $2 AND revoked_at IS NULL", [id, app.instanceId]);
      if (!res.rowCount) throw notFound();
      return reconcileAccess(q, app.instanceId, false);
    });
    if (access === "human_session") return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (access === "advanced") return c.json(GRANT_MODE_CHANGED, 409);
    await adminAudit(c, "grant_revoke", { grant_id: id });
    if (ADMIN_ROLES.includes(cur.role_code))
      await alertHigh("admin_role_changed", `Revoked role ${cur.role_code} from ${cur.login} (${actorOf(c)})`, { role: cur.role_code, person: cur.person_id, action: "revoked" });
    return c.json({ revoked: true, access });
  });

  const SERVICE_COLS = "id, name, kind, obo_allowed, obo_read, allowed_ops, tier, active, created_at, (SELECT slug FROM spaces sp WHERE sp.id = write_space_id) AS write_space";
  const writeSpaceId = async (slug: unknown): Promise<string | null> => {
    if (slug === null) return null;
    if (typeof slug !== "string" || !slug.trim()) throw invalid("write_space must be the slug of a team space or null");
    const sp = (await ctl.query("SELECT id, kind, archived_at FROM spaces WHERE slug = $1 AND instance_id = $2", [slug.trim(), app.instanceId])).rows[0];
    if (!sp) throw invalid(`Space “${slug}” was not found`);
    if (sp.kind !== "team") throw invalid("Services can write this way only to a team space. Personal spaces and Company knowledge are excluded");
    if (sp.archived_at) throw invalid("Space archived");
    return sp.id as string;
  };
  r.get("/services", async (c) => {
    const { limit, offset } = page(c);
    const active = c.req.query("active");
    if (active !== undefined && !["true", "false"].includes(active)) throw invalid("active: true | false");
    const { rows } = await ctl.query(`SELECT ${SERVICE_COLS} FROM services WHERE instance_id = $1 AND ($4::boolean IS NULL OR active = $4) ORDER BY active DESC, name LIMIT $2 OFFSET $3`,
      [app.instanceId, limit + 1, offset, active === undefined ? null : active === "true"]);
    return c.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });

  r.patch("/services/:id", async (c) => {
    const id = uuidParam(c);
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    const hasActive = b?.active !== undefined, hasRead = b?.obo_read !== undefined, hasSpace = b?.write_space !== undefined;
    if (!hasActive && !hasRead && !hasSpace) throw invalid("Provide active or obo_read (boolean), or write_space (slug or null)");
    if ((hasActive && typeof b.active !== "boolean") || (hasRead && typeof b.obo_read !== "boolean")) throw invalid("active and obo_read must be boolean values");
    if (c.get("breakglassNarrowOnly") === true && (b.active === true || b.obo_read === true || hasSpace)) return c.json(BREAKGLASS_ONLY, 403);
    const space = hasSpace ? await writeSpaceId(b.write_space) : null;
    if (hasRead && b.obo_read === true) {
      const cur = (await ctl.query("SELECT name, obo_read FROM services WHERE id = $1 AND instance_id = $2", [id, app.instanceId])).rows[0];
      if (!cur) throw notFound();
      if (!cur.obo_read) {
        if (!oboServiceKeysOn(app)) throw invalid(OBO_SERVICE_KEYS_OFF_TEXT, { setting: "access.obo_service_keys" });
        const ap = await approval(c, "obo_enable", () => `Allow service ${cur.name} to read on behalf of people`, id);
        if (ap) return ap;
      }
    }
    const out = await tx(ctl, async (q) => {
      if (hasRead && b.obo_read === true) {
        const cur = (await q.query("SELECT obo_read FROM services WHERE id = $1 AND instance_id = $2 FOR UPDATE", [id, app.instanceId])).rows[0];
        if (!cur) throw notFound();
        if (!cur.obo_read) {
          if (!oboServiceKeysOn(app)) throw invalid(OBO_SERVICE_KEYS_OFF_TEXT, { setting: "access.obo_service_keys" });
          const long = (await q.query(
            `SELECT count(*)::int AS n FROM api_keys k WHERE k.principal_type = 'service' AND k.principal_id = $1 AND k.instance_id = $2
               AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND ${OBO_READ_LONG_SQL}`, [id, app.instanceId])).rows[0].n as number;
          if (long)
            throw invalid(`Reading on behalf of people was not enabled. The service has active keys with no expiry or with more than ${OBO_READ_KEY_MAX_DAYS} days until expiry: ${long}. Revoke them and issue keys valid for no more than ${OBO_READ_KEY_MAX_DAYS} days`,
              { long_keys: long, max_days: OBO_READ_KEY_MAX_DAYS });
        }
      }
      const s = (await q.query(`UPDATE services SET active = COALESCE($2, active), obo_read = COALESCE($3, obo_read), write_space_id = CASE WHEN $5 THEN $6::uuid ELSE write_space_id END
                                 WHERE id = $1 AND instance_id = $4 RETURNING ${SERVICE_COLS}`,
        [id, hasActive ? b.active : null, hasRead ? b.obo_read : null, app.instanceId, hasSpace, space])).rows[0];
      if (!s) throw notFound();
      const consents = (hasActive && b.active === false) || (hasRead && b.obo_read === false) ? await closeServiceConsents(q, app.instanceId, id) : [];
      return { service: s, keys_revoked: !hasActive || b.active ? 0 : await revokeKeysOf(q, "service", id), consents };
    });
    if (hasActive) await adminAudit(c, "service_set_active", { service: id, active: b.active, keys_revoked: out.keys_revoked });
    if (hasRead) await adminAudit(c, "service_set_obo_read", { service: id, obo_read: b.obo_read });
    if (hasSpace) await adminAudit(c, "service_set_write_space", { service: id, write_space: out.service.write_space ?? null });
    await serviceConsentsClosedAudit(app, c.get("caller"), id, out.consents);
    return c.json({ ...out.service, keys_revoked: out.keys_revoked });
  });
  const SERVICE_KINDS = ["transcriber", "chat", "meeting_assistant", "converter", "audio_agent", "pipeline", "other"];
  r.post("/services", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!b?.name || !b?.kind || !["T0", "T1"].includes(b?.tier)) throw invalid("Provide name, kind and tier (T0 | T1)");
    if (!SERVICE_KINDS.includes(String(b.kind))) throw invalid(`Service kind: ${SERVICE_KINDS.join(" | ")}`, { kinds: SERVICE_KINDS });
    if (b.tier === "T1" && !t1Allowed(app, String(b.name))) {
      const providers = app.settings.get<string[]>("access.t1_providers", []);
      throw invalid(providers.length ? "This service is not in the trusted T1 provider list (access.t1_providers)" : "No T1 providers are configured (access.t1_providers is empty). The T1 tier is unavailable and the service cannot be registered", { t1_providers: providers });
    }
    if (Boolean(b.obo_allowed) && !oboServiceKeysOn(app)) throw invalid(OBO_SERVICE_KEYS_OFF_TEXT, { setting: "access.obo_service_keys" });
    if ((await ctl.query("SELECT 1 FROM services WHERE name = $1", [b.name])).rowCount) throw invalid("A service with this name already exists");
    if (b.obo_read !== undefined && typeof b.obo_read !== "boolean") throw invalid("obo_read must be a boolean value");
    const space = b.write_space === undefined || b.write_space === "" ? null : await writeSpaceId(b.write_space);
    if (Boolean(b.obo_allowed)) {
      const ap = await approval(c, "obo_allowed", () => `Register service ${String(b.name)} to act “on behalf of” people${b.obo_read === true ? " with permission to read on behalf of people" : ""}`);
      if (ap) return ap;
    }
    const { rows } = await ctl.query(`INSERT INTO services (id, name, kind, obo_allowed, obo_read, allowed_ops, tier, instance_id, write_space_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${SERVICE_COLS}`,
      [newId(), b.name, b.kind, Boolean(b.obo_allowed), Boolean(b.obo_allowed) && b.obo_read === true, b.allowed_ops ?? [], b.tier, app.instanceId, space]);
    await adminAudit(c, "service_create", { service: rows[0].id, obo_read: rows[0].obo_read, ...(rows[0].write_space ? { write_space: rows[0].write_space } : {}) });
    return c.json(rows[0], 201);
  });

  r.delete("/people/:id/connections", async (c) => {
    const id = uuidParam(c), revoked = await revokePersonConnections(app, id);
    await adminAudit(c, "connections_revoke", { person_id: id, revoked });
    return c.json({ revoked });
  });

  const KEY_COLS = `k.id, k.key_prefix, k.principal_type, COALESCE(p.login, s.name) AS principal, k.kind, k.tier, k.ops_override, k.client_label, k.client_kind, k.basis, k.preview, k.net_cidrs::text[] AS net_cidrs, k.expires_at, k.created_at, k.revoked_at, k.last_used_at, host(k.last_used_ip) AS last_used_ip, k.paused_until, k.open_write, s.obo_allowed AS service_obo`;
  r.get("/keys", async (c) => {
    const { limit, offset } = page(c);
    const { rows } = await ctl.query(
      `SELECT ${KEY_COLS} FROM api_keys k LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id
       WHERE k.auth_method = 'api_key' AND k.instance_id = $1 AND ($2::text IS NULL OR p.login = $2 OR s.name = $2) AND ($3 OR k.revoked_at IS NULL)
         AND (NOT $6::boolean OR (k.revoked_at IS NULL AND k.paused_until > now())) ORDER BY k.created_at DESC LIMIT $4 OFFSET $5`,
      [app.instanceId, c.req.query("principal") ?? null, c.req.query("include_revoked") === "true", limit + 1, offset, c.req.query("paused") === "true"]);
    return c.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });

  const keyCidrs = async (raw: unknown): Promise<string[] | null> => {
    if (raw === undefined || raw === null) return null;
    if (!Array.isArray(raw) || !raw.every((x: unknown) => typeof x === "string") || raw.length > 20) throw invalid("net_cidrs must be an array of CIDRs, at most 20", { field: "net_cidrs" });
    const out: string[] = [], bad: string[] = [];
    for (const x of raw.map((v: string) => v.trim()).filter(Boolean)) {
      const res = await ctl.query("SELECT $1::cidr::text AS c", [x]).catch(() => null);
      if (res) out.push(res.rows[0].c as string); else bad.push(x);
    }
    if (bad.length) throw invalid(`Not a CIDR: ${bad.join(", ")}`, { invalid: bad, field: "net_cidrs" });
    // a network that covers a trusted proxy (any profile) or, in internet, the server's own networks and
    // loopback binds the key to everybody behind the proxy. Stored keys are not re-checked. The text names only the input
    const own = deployProfile() === "internet" ? ["127.0.0.0/8", "::1/128", ...ownNetworks()] : [];
    const proxies = trustedProxies(app);
    const covering = out.filter((c) => keyNetworkProblem(c, { proxies, own }) !== null);
    if (covering.length) throw invalid(`net_cidrs: ${covering.join(", ")} cover a trusted proxy or the server's own network — behind the proxy every client would match. Bind the key to the clients' addresses.`,
      { invalid: covering, field: "net_cidrs" });
    return out.length ? out : null;
  };

  r.post("/keys", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (b?.kind === "system") return c.json({ code: "system_key_removed", message: SYSTEM_KEY_REMOVED_TEXT }, 400);
    const kind = b?.kind as "personal" | "service" | "extended";
    if (!["personal", "service", "extended"].includes(kind)) throw invalid("kind: personal | service | extended");
    const cidrs = await keyCidrs(b.net_cidrs);
    const fp = keyFingerprintOf(kind, b);
    let oboService: { id: string; name: string } | null = null;
    if (kind === "service") {
      const s = (await ctl.query("SELECT id, name, obo_allowed FROM services WHERE name = $1 AND instance_id = $2 AND active", [b.principal, app.instanceId])).rows[0];
      if (s?.obo_allowed === true && !oboServiceKeysOn(app)) throw invalid(OBO_SERVICE_KEYS_OFF_TEXT, { setting: "access.obo_service_keys" });
      if (s && !fp && (s.obo_allowed === true || app.settings.get<boolean>("admin.service_keys_by_fingerprint", false) === true))
        throw invalid(s.obo_allowed ? FINGERPRINT_OBO_TEXT : FINGERPRINT_ONLY_TEXT, { field: "key_sha256" });
      if (s?.obo_allowed === true) {
        if (!isNetBound(cidrs)) throw invalid(keyBindingRequiredText("a key for an on-behalf-of service is issued"), { field: "net_cidrs" });
        if ((await ctl.query("SELECT 1 FROM api_keys WHERE key_hash = $1", [fp!.hash])).rowCount) throw conflict(FINGERPRINT_TAKEN_TEXT, { field: "key_sha256" });
        const ap = await approval(c, "obo_service_key", () => `Register key ${fp!.prefix}… for the on-behalf-of service ${s.name}${cidrs?.length ? ` (addresses ${cidrs.slice(0, 3).join(", ")})` : ""}`, s.id);
        if (ap) return ap;
        oboService = { id: s.id, name: s.name };
      }
    }
    const key = fp ? { prefix: fp.prefix, hash: fp.hash, plain: null } : generateApiKey(kind), id = newId();
    const out = await tx(ctl, async (q) => {
      let principalType: "person" | "service", principalId: string | null = null, tier: string;
      let service: { obo_allowed: boolean; obo_read: boolean } | null = null;
      let person: { active: boolean; login: string; attrs: Record<string, unknown> | null; ad: boolean } | null = null;
      if (kind === "service") {
        const s = (await q.query("SELECT id, name, tier, obo_allowed, obo_read FROM services WHERE name = $1 AND instance_id = $2 AND active FOR SHARE", [b.principal, app.instanceId])).rows[0];
        if (!s) throw invalid("Service not found");
        if (!fp && app.settings.get<boolean>("admin.service_keys_by_fingerprint", false) === true) throw invalid(FINGERPRINT_ONLY_TEXT, { field: "key_sha256" });
        if (s.tier === "T1" && !t1Allowed(app, s.name)) {
          const providers = app.settings.get<string[]>("access.t1_providers", []);
          throw invalid(providers.length ? "This T1 service is not in access.t1_providers: no key is issued" : "No T1 providers are configured (access.t1_providers is empty): no key is issued to a T1 service", { t1_providers: providers });
        }
        principalType = "service"; principalId = s.id; tier = s.tier; service = { obo_allowed: s.obo_allowed === true, obo_read: s.obo_read === true };
      } else {
        const p = (await q.query(
          `SELECT p.id, p.login, p.active, p.attrs, EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active) AS ad
           FROM people p WHERE p.login = $1 AND p.instance_id = $2 AND p.active`, [String(b.principal ?? "").toLowerCase(), app.instanceId])).rows[0];
        if (!p) throw invalid("Person not found or inactive");
        principalType = "person"; principalId = p.id; tier = "T2";
        person = { active: p.active, login: p.login, attrs: p.attrs ?? null, ad: p.ad === true };
      }
      const preview = b.preview === true;
      if (person && !(kind === "personal" && preview) && !isTestPerson(person)) throw invalid(PERSON_KEY_ADMIN_TEXT, { field: "principal" });
      if (kind === "extended" && !isNetBound(cidrs)) throw invalid(keyBindingRequiredText("an extended key is issued"), { field: "net_cidrs" });
      if (service?.obo_allowed) {
        if (!oboServiceKeysOn(app)) throw invalid(OBO_SERVICE_KEYS_OFF_TEXT, { setting: "access.obo_service_keys" });
        if (!isNetBound(cidrs)) throw invalid(keyBindingRequiredText("a key for an on-behalf-of service is issued"), { field: "net_cidrs" });
      }
      if (b.ops_override !== undefined && b.ops_override !== null && !(Array.isArray(b.ops_override) && b.ops_override.every((o: unknown) => typeof o === "string"))) throw invalid("ops_override must be an array of operations");
      if (service?.obo_allowed && !oboService) throw conflict("The service has become an on-behalf-of service: register the key again by fingerprint", { field: "key_sha256" });
      if (b.expires_at !== undefined && b.expires_at !== null && Number.isNaN(new Date(b.expires_at).getTime())) throw invalid("expires_at: not a date");
      let basis: string | null = typeof b.basis === "string" ? b.basis.trim().slice(0, 500) : null;
      let expiresAt: string | null = b.expires_at ?? null;
      if (preview) {
        if (kind !== "personal") throw invalid("preview: only a personal key of a demo persona");
        if (!(await q.query("SELECT 1 FROM people WHERE id = $1 AND attrs->>'demo' = 'true'", [principalId])).rowCount) throw invalid("preview: a preview key is issued only to a demo persona (attrs.demo = true)");
        const cap = new Date(Date.now() + 3600_000);
        expiresAt = (expiresAt && new Date(expiresAt) < cap ? new Date(expiresAt) : cap).toISOString();
        basis = basis || "role showcase"; b.client_label = "panel-preview";
      } else if ((kind === "personal" || kind === "extended") && (!basis || basis.length < 3)) throw invalid("basis: the reason for issuing a key on behalf of a person (a request number or a decision), at least 3 characters");
      if (!preview && (kind === "personal" || kind === "extended")) expiresAt = personKeyExpiry(b.expires_at);
      if (service?.obo_allowed && service.obo_read) expiresAt = oboReadKeyExpiry(b.expires_at);
      const clientKind = issueClientKind(kind, preview, b.client_kind);
      const openWrite = issueOpenWrite(kind, preview, b);
      await q.query(
        `INSERT INTO api_keys (id, key_prefix, key_hash, principal_type, principal_id, kind, tier, instance_id, ops_override, client_label, client_kind, net_cidrs, expires_at, created_by, basis, preview, open_write)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::cidr[],$13,$14,$15,$16,$17)`,
        [id, key.prefix, key.hash, principalType, principalId, kind, tier, app.instanceId, b.ops_override ?? null, b.client_label ?? null, clientKind, cidrs, expiresAt, c.get("caller").person?.id ?? null, basis, preview, openWrite.openWrite]);
      const row = (await q.query(`SELECT ${KEY_COLS} FROM api_keys k LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id WHERE k.id = $1`, [id])).rows[0];
      return { row, principalType, principalId, clientKind, openWrite, basis, preview };
    }).catch((e: unknown) => {
      if (fp && (e as { code?: string })?.code === "23505") throw conflict(FINGERPRINT_TAKEN_TEXT, { field: "key_sha256" });
      throw e;
    });
    await adminAudit(c, "key_issue", { key_id: id, kind, principal: out.principalId, client_label: b.client_label ?? null, client_kind: out.clientKind, basis: out.basis, preview: out.preview,
                                       open_write: out.openWrite.openWrite, ...(out.openWrite.basis ? { open_write_basis: out.openWrite.basis, set_by: setBy(c.get("caller")) } : {}),
                                       ...(out.principalType === "person" ? { author: out.principalId } : {}), ...(fp ? { by_fingerprint: true } : {}) });
    if (oboService) await alertHigh("obo_key_registered", `Key registered for the on-behalf-of service ${oboService.name}`, { service: oboService.id, key: id });
    if (fp) return c.json({ key: out.row, secret: null, registered_by_fingerprint: true }, 201);
    return c.json({ key: out.row, secret: key.plain }, 201);
  });

  r.patch("/keys/:id", async (c) => {
    const id = uuidParam(c);
    const b = jsonObjectBody(await c.req.json().catch(() => { throw invalid("The request body is not JSON"); }), "KeyPatch");
    rejectUnknownFields(b, ["net_cidrs", "paused_until", "open_write", "open_write_basis"]);
    const openWrite = keyPatchOpenWrite(b);
    const hasNet = b.net_cidrs !== undefined, unpause = b.paused_until === null;
    if (!hasNet && !unpause && !openWrite) throw invalid("Provide net_cidrs (an array of CIDR ranges or null), paused_until: null or open_write");
    if (b?.paused_until !== undefined && b.paused_until !== null) throw invalid("paused_until accepts only null to end the pause. To disable the key manually, revoke it");
    const cidrs = hasNet ? await keyCidrs(b.net_cidrs) : null;
    const pre = (await ctl.query(
      `SELECT k.kind, k.key_prefix, k.open_write, s.obo_allowed AS service_obo FROM api_keys k LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id
        WHERE k.auth_method = 'api_key' AND k.id = $1 AND k.instance_id = $2 AND k.revoked_at IS NULL`, [id, app.instanceId])).rows[0];
    if (!pre) throw notFound();
    if ((hasNet && pre.service_obo === true) || (openWrite?.openWrite === true && pre.open_write !== true)) {
      const ap = await approval(c, "obo_key_net_or_open_write",
        () => hasNet && pre.service_obo === true ? `Change the allowed addresses for “on behalf of” service key ${pre.key_prefix}…${cidrs?.length ? ` to ${cidrs.slice(0, 3).join(", ")}` : ""}` : `Allow writes to open records for key ${pre.key_prefix}…`, id);
      if (ap) return ap;
    }
    const res = await tx(ctl, async (q) => {
      const cur = (await q.query(
        `SELECT k.kind, k.principal_type, k.principal_id, k.open_write, s.obo_allowed AS service_obo FROM api_keys k LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id
         WHERE k.auth_method = 'api_key' AND k.id = $1 AND k.instance_id = $2 AND k.revoked_at IS NULL FOR UPDATE OF k`, [id, app.instanceId])).rows[0];
      if (!cur) return null;
      if (openWrite && cur.kind !== "extended") throw invalid("open_write: only an extended key (extended) may be allowed to write open records", { field: "open_write" });
      if (hasNet && (cur.kind === "extended" || cur.service_obo === true) && !isNetBound(cidrs))
        throw invalid(`net_cidrs: specify addresses or networks for the ${cur.kind === "extended" ? "extended key" : "“on behalf of” service key"}. You cannot remove the address restriction or use an “entire internet” network (/0)`, { field: "net_cidrs" });
      const flag = openWrite !== null && cur.open_write !== openWrite.openWrite;
      await q.query(
        `UPDATE api_keys SET net_cidrs = CASE WHEN $2 THEN $3::cidr[] ELSE net_cidrs END, paused_until = CASE WHEN $4 THEN NULL ELSE paused_until END,
                             open_write = CASE WHEN $5 THEN $6 ELSE open_write END WHERE id = $1`, [id, hasNet, cidrs, unpause, flag, openWrite?.openWrite ?? false]);
      return { flag, person: cur.principal_type === "person" ? cur.principal_id as string : null };
    });
    if (!res) throw notFound();
    const row = (await ctl.query(`SELECT ${KEY_COLS} FROM api_keys k LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id WHERE k.id = $1`, [id])).rows[0];
    if (hasNet || unpause || res.flag)
      await adminAudit(c, "key_update", { key_id: id, ...(hasNet ? { net_cidrs: cidrs } : {}), ...(unpause ? { unpaused: true } : {}),
                                          ...(res.flag ? { open_write: openWrite!.openWrite, ...(openWrite!.basis ? { open_write_basis: openWrite!.basis } : {}), set_by: setBy(c.get("caller")) } : {}),
                                          ...(res.person ? { author: res.person } : {}) });
    return c.json(row);
  });

  r.delete("/keys/:id", async (c) => {
    const id = uuidParam(c);
    // Commit the revocation and cancellation together in the control database.
    const { rows: [revoked] } = await ctl.query<{ person_id: string | null; correction_plans: string[] }>(
      `WITH revoked AS (
         UPDATE api_keys SET revoked_at = now()
         WHERE auth_method = 'api_key' AND id = $1 AND instance_id = $2 AND revoked_at IS NULL
         RETURNING id, CASE WHEN principal_type = 'person' THEN principal_id END AS person_id
       ), cancelled AS (
         UPDATE action_plans p SET status = 'cancelled' FROM revoked k
         WHERE p.key_id = k.id AND p.instance_id = $2 AND p.status = 'pending'
         RETURNING p.id, p.op
       )
       SELECT person_id, ARRAY(SELECT id FROM cancelled WHERE op = 'correct_bulk') AS correction_plans FROM revoked`, [id, app.instanceId]);
    if (!revoked) throw notFound();
    if (revoked.person_id && revoked.correction_plans.length > 0) {
      for (const cls of ["open", "closed"] as const) {
        try {
          await app.db.recordsForWrite(cls, "system").query(
            "UPDATE record_corrections SET status = 'cancelled', text = NULL, fields = NULL, quote = NULL WHERE by_person = $1 AND status = 'planned' AND plan_id = ANY($2::uuid[])",
            [revoked.person_id, revoked.correction_plans]);
        } catch (error) {
          log.warn("planned_cancel_failed", { class: cls, plans: revoked.correction_plans.length, error: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    await adminAudit(c, "key_revoke", { key_id: id });
    return c.body(null, 204);
  });

  r.post("/test-sessions", async (c) => {
    if (!testSessionsOn(app)) throw new HttpReject(403, "forbidden", "The access.test_sessions test hook is off. Test sessions are unavailable");
    const b = await c.req.json().catch(() => ({}));
    const login = typeof b?.login === "string" ? b.login.trim().toLowerCase() : "";
    if (!login) throw invalid("login: the test person’s login");
    const p = (await ctl.query(
      `SELECT p.id, p.active, p.attrs, EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active) AS ad
       FROM people p WHERE p.login = $1 AND p.instance_id = $2`, [login, app.instanceId])).rows[0];
    if (!p) throw notFound();
    if (!p.active || p.attrs?.test !== true || p.attrs?.demo === true || p.ad)
      throw new HttpReject(403, "forbidden", "Test sessions require an active test person (attrs.test = true) who has no AD link and is not a demo persona");
    const ip = c.get("caller").ip;
    const s = await createSession(app, p.id, "test", { ip, userAgent: c.req.header("user-agent") ?? null, ttlSec: TEST_SESSION_TTL_SEC, authTime: "now" });
    await adminAudit(c, "test_session", { session_id: s.id, login, person: p.id, expires_at: s.expires_at });
    return c.json({ token: s.token, session: { id: s.id, expires_at: s.expires_at, source: s.source }, ip }, 201);
  });

  const ORPHAN_SQL = "s.kind <> 'personal' AND s.archived_at IS NULL AND s.org_unit_id IS NULL AND p.id IS NOT NULL AND NOT p.active";
  const SPACE_SQL = `SELECT s.id, s.slug, s.kind, s.name, s.description, p.login AS owner, p.display_name AS owner_name, s.default_class, s.created_at, s.archived_at,
                            (SELECT code FROM org_units u WHERE u.id = s.org_unit_id) AS org_unit,
                            (SELECT count(*)::int FROM space_members_effective m WHERE m.space_id = s.id) AS members_count,
                            (SELECT count(*)::int FROM record_locations l WHERE l.space_id = s.id AND NOT l.deleted) AS records_count,
                            (SELECT cb.login FROM people cb WHERE cb.id = s.created_by) AS created_by, s.created_via,
                            (SELECT ab.login FROM people ab WHERE ab.id = s.archived_by) AS archived_by,
                            (SELECT count(*)::int FROM space_groups g WHERE g.space_id = s.id) AS groups_count
                     FROM spaces s LEFT JOIN people p ON p.id = s.owner_id AND ${OWNER_IN_FORCE_SQL}`;
  r.get("/spaces", async (c) => {
    const { limit, offset } = page(c);
    const order = c.req.query("sort") === "created" ? "s.created_at DESC, s.id DESC" : "s.kind, s.slug";
    const owner = c.req.query("owner");
    if (owner !== undefined && owner !== "" && owner !== "inactive") throw invalid("owner: use inactive for spaces without an active owner");
    const status = c.req.query("status") || "active";
    if (!["active", "archived", "all"].includes(status)) throw invalid("status: active (default), archived or all");
    const archived = owner === "inactive" || status === "all" ? "" : status === "archived" ? " AND s.archived_at IS NOT NULL" : " AND s.archived_at IS NULL";
    const kind = c.req.query("kind") || null;
    const exclude = c.req.query("exclude");
    if (exclude !== undefined && exclude !== "" && exclude !== "personal") throw invalid("exclude: use personal to exclude personal spaces");
    const q = (c.req.query("q") ?? "").replace(/\s+/g, " ").trim();
    if (q && (q.length < 2 || q.length > 100)) throw invalid("q: 2 to 100 characters");
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const extra = `${exclude === "personal" ? " AND s.kind <> 'personal'" : ""}${like ? ` AND (s.slug ILIKE $5 ESCAPE '\\' OR s.name ILIKE $5 ESCAPE '\\' OR p.login ILIKE $5 ESCAPE '\\' OR p.display_name ILIKE $5 ESCAPE '\\')` : ""}`;
    const { rows } = await ctl.query(
      `${SPACE_SQL} WHERE s.instance_id = $1 AND ($2::text IS NULL OR s.kind = $2)${owner === "inactive" ? ` AND ${ORPHAN_SQL}` : archived}${extra} ORDER BY ${order} LIMIT $3 OFFSET $4`,
      [app.instanceId, kind, limit + 1, offset, ...(like ? [like] : [])]);
    const totals = (await ctl.query(
      `SELECT count(*) FILTER (WHERE s.archived_at IS NULL)::int AS active, count(*) FILTER (WHERE s.archived_at IS NOT NULL)::int AS archived
       FROM spaces s LEFT JOIN people p ON p.id = s.owner_id WHERE s.instance_id = $1 AND ($2::text IS NULL OR s.kind = $2)${extra.replaceAll("$5", "$3")}`,
      [app.instanceId, kind, ...(like ? [like] : [])])).rows[0];
    return c.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(offset + limit) : null, totals });
  });

  r.post("/spaces", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!["team", "org", "project"].includes(b?.kind) || !b?.name || !b?.owner) throw invalid("Provide kind (team | project | org), name and owner");
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) throw invalid("name: a name of 1 to 120 characters");
    if (b.description !== undefined && b.description !== null && (typeof b.description !== "string" || b.description.length > 2000)) throw invalid("description: a string up to 2000 characters");
    const cls = b.default_class ?? (b.kind === "team" ? "closed" : "open");
    if (cls !== "open" && cls !== "closed") throw invalid("default_class: open | closed");
    const owner = (await ctl.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2 AND active", [String(b.owner).toLowerCase(), app.instanceId])).rows[0];
    if (!owner) throw invalid("The owner was not found in the org table");
    const slug = b.slug ?? slugify(b.name, b.kind === "project" ? "project" : "team");
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw invalid("slug: use Latin letters, digits and hyphens");
    if ((await ctl.query("SELECT 1 FROM spaces WHERE slug = $1", [slug])).rowCount) throw invalid("This slug is already in use");
    if (b.kind === "org" && (await ctl.query("SELECT 1 FROM spaces WHERE kind = 'org' AND instance_id = $1", [app.instanceId])).rowCount)
      throw invalid("Company knowledge (org) already exists. Each installation has one such space");
    const name = b.name.trim(), description = typeof b.description === "string" ? b.description.trim() || null : null;
    await checkSpaceMeta(app, c.get("caller"), { name, description, slug });
    const id = newId();
    const members = await tx(ctl, async (q) => {
      if (!(await insertSpace(q, { id, kind: b.kind, name, description, owner_id: owner.id, instance_id: app.instanceId, default_class: cls, created_via: "admin" }, [slug])))
        throw invalid("This slug is already in use");
      if (b.kind === "project" && !await ensureProjectEntity(q, { id, slug, name, instance_id: app.instanceId }, { update: true }))
        throw invalid("A project entity already uses this slug. Choose another one");
      await q.query("INSERT INTO space_members (space_id, person_id, role) VALUES ($1,$2,'owner')", [id, owner.id]);
      let n = 0;
      for (const login of new Set<string>((b.members ?? []).map((l: string) => l.toLowerCase()))) {
        const p = (await q.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2 AND active", [login, app.instanceId])).rows[0];
        if (p && p.id !== owner.id) n += (await q.query("INSERT INTO space_members (space_id, person_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [id, p.id])).rowCount ?? 0;
      }
      return n;
    });
    await adminAudit(c, "space_create", { space: id, slug, kind: b.kind, class: cls, via: "admin", members });
    return c.json((await ctl.query(`${SPACE_SQL} WHERE s.id = $1`, [id])).rows[0], 201);
  });

  const spaceBySlug = async (slug: string, o: { archived?: "narrow" } = {}) => {
    const s = (await ctl.query(`SELECT id, slug, kind, name, description, owner_id, org_unit_id, archived_at FROM spaces WHERE slug = $1 AND instance_id = $2${o.archived === "narrow" ? "" : " AND archived_at IS NULL"}`,
                               [slug, app.instanceId])).rows[0];
    if (!s) throw notFound();
    if (s.kind === "personal") throw invalid("Only the owner can administer a personal space");
    return s as { id: string; slug: string; kind: string; name: string; description: string | null; owner_id: string | null; org_unit_id: string | null; archived_at: Date | null };
  };
  const activePerson = async (login: string, db: Pick<pg.Pool, "query"> = ctl) => {
    const p = (await db.query("SELECT id, login FROM people WHERE login = $1 AND instance_id = $2 AND active", [login.trim().toLowerCase(), app.instanceId])).rows[0];
    if (!p) throw invalid(`${login}: person not found or inactive`);
    return p as { id: string; login: string };
  };

  r.get("/spaces/:slug", async (c) => {
    const s = (await ctl.query(
      `SELECT s.id, s.slug, s.kind, s.name, s.description, s.default_class, s.created_at, s.created_via, s.archived_at,
              (SELECT code FROM org_units u WHERE u.id = s.org_unit_id) AS org_unit,
              (SELECT ab.login FROM people ab WHERE ab.id = s.archived_by) AS archived_by,
              p.login AS owner_login, p.display_name AS owner_name, cb.login AS created_by,
              (SELECT count(*)::int FROM record_locations l WHERE l.space_id = s.id AND NOT l.deleted) AS records_count
       FROM spaces s LEFT JOIN people p ON p.id = s.owner_id AND ${OWNER_IN_FORCE_SQL} LEFT JOIN people cb ON cb.id = s.created_by WHERE s.slug = $1 AND s.instance_id = $2`, [c.req.param("slug"), app.instanceId])).rows[0];
    if (!s) throw notFound();
    const members = (await ctl.query(
      `SELECT p.login, p.display_name, m.role, m.source, m.grant_id, m.expires_at, a.login AS added_by, a.display_name AS added_by_name,
              COALESCE((SELECT array_agg(DISTINCT g.display_name ORDER BY g.display_name) FROM space_groups g
                        JOIN directory_group_members d ON d.group_key = g.group_key AND d.instance_id = $2 AND d.person_id = m.person_id
                        WHERE g.space_id = m.space_id), '{}') AS groups
       FROM space_members m JOIN people p ON p.id = m.person_id LEFT JOIN people a ON a.id = m.added_by
       WHERE m.space_id = $1 ORDER BY (m.role = 'owner') DESC, p.login`, [s.id, app.instanceId])).rows;
    return c.json({
      slug: s.slug, title: s.name, kind: s.kind, default_class: s.default_class, description: s.description ?? null, org_unit: s.org_unit ?? null,
      owner: s.owner_login ? { login: s.owner_login, display_name: s.owner_name } : null,
      created_by: s.created_by ?? null, created_via: s.created_via ?? null, created_at: new Date(s.created_at).toISOString(),
      archived_at: s.archived_at ? new Date(s.archived_at).toISOString() : null, archived_by: s.archived_by ?? null, records_count: s.records_count,
      members: members.map((m) => ({ login: m.login, display_name: m.display_name, role: m.role, source: m.source, grant_id: m.grant_id,
                                     expires_at: m.expires_at ? new Date(m.expires_at).toISOString() : null, added_by: m.added_by ?? null,
                                     ...(m.added_by ? { added_by_name: m.added_by_name ?? null } : {}), groups: m.groups ?? [] })),
      groups: await spaceGroupsOf(app, s.id),
    });
  });

  r.delete("/spaces/:slug", async (c) => {
    const wr = c.req.query("with_records");
    if (wr !== undefined && wr !== "" && wr !== "true" && wr !== "false") throw invalid("with_records: true or false");
    const withRecords = wr === "true";
    const s = (await ctl.query("SELECT id, slug, kind, archived_at, org_unit_id FROM spaces WHERE slug = $1 AND instance_id = $2", [c.req.param("slug"), app.instanceId])).rows[0];
    if (!s || s.archived_at) throw notFound();
    if (s.kind === "org") return c.json({ code: "invalid_argument", message: "Company knowledge (org) cannot be archived. Each installation has only one such space" }, 409);
    if (s.kind === "personal") return c.json({ code: "invalid_argument", message: "A personal space is archived only when the person is deactivated in the org table" }, 409);
    const live = await liveRecords(ctl, s.id);
    if (live && !withRecords)
      throw notEmpty(`This space has ${live} live records. Archive it with the records (with_records=true: read-only and excluded from search by default), or have the owners delete them first (memory_delete)`, { records: live });
    if (live && s.org_unit_id)
      return c.json({ code: "invalid_argument", message: "A department space with records cannot be archived because it is managed by the org table" }, 409);
    const ch = await tx(ctl, (q) => setArchived(q, app.instanceId, s.id, true, null));
    if (!ch) throw notFound();
    await adminAudit(c, "space_archive", { space: s.id, slug: s.slug, via: "admin", records: live, ...(withRecords ? { with_records: true } : {}),
                                           ...(ch.removed.length ? { members_removed: ch.removed.length, ...peopleOf({ added: [], removed: ch.removed }) } : {}) });
    return c.body(null, 204);
  });

  r.post("/spaces/:slug/unarchive", async (c) => {
    const s = (await ctl.query("SELECT id, slug, kind, name, archived_at FROM spaces WHERE slug = $1 AND instance_id = $2", [c.req.param("slug"), app.instanceId])).rows[0];
    if (!s) throw notFound();
    if (s.kind === "personal") return c.json({ code: "invalid_argument", message: "To restore a personal space, reactivate the person in the org table or their profile" }, 409);
    const notArchived = () => c.json({ code: "invalid_argument", message: `Space ${s.slug} is not archived` }, 409);
    if (!s.archived_at) return notArchived();
    const out = await tx(ctl, async (q) => {
      const ch = await setArchived(q, app.instanceId, s.id, false, null);
      return ch ? { ch, records: await liveRecords(q, s.id) } : null;
    });
    if (!out) return notArchived();
    await adminAudit(c, "space_unarchive", { space: s.id, slug: s.slug, via: "admin", records: out.records, members_added: out.ch.added.length, members_removed: out.ch.removed.length,
                                             ...peopleOf(out.ch) });
    syncAfterUnarchive(app, { id: s.id, slug: s.slug } as Parameters<typeof syncAfterUnarchive>[1], c.get("caller"));
    return c.body(null, 204);
  });

  r.put("/spaces/:slug", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("The request body must be an object with owner_login, name, description, kind");
    const extra = Object.keys(b).filter((k) => !["owner_login", "name", "description", "kind"].includes(k));
    if (extra.length) throw invalid(`Unexpected fields: ${extra.join(", ")}`);
    if (!Object.keys(b).length) throw invalid("Provide at least one field: owner_login, name, description or kind");
    const s = await spaceBySlug(c.req.param("slug"));
    if (b.owner_login !== undefined && typeof b.owner_login !== "string") throw invalid("owner_login must be a login (e-mail address)");
    if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120)) throw invalid("name: a name of 1 to 120 characters");
    if (b.description !== undefined && b.description !== null && (typeof b.description !== "string" || b.description.length > 2000)) throw invalid("description: a string up to 2000 characters");
    const changed: { name?: string; description?: string | null } = {};
    if (b.name !== undefined && b.name.trim() !== s.name) changed.name = b.name.trim();
    if (b.description !== undefined && ((typeof b.description === "string" ? b.description.trim() : "") || null) !== s.description)
      changed.description = (typeof b.description === "string" ? b.description.trim() : "") || null;
    if (Object.keys(changed).length && s.org_unit_id) throw invalid("The org table sets the department space name and description");
    if (b.kind !== undefined && (b.kind !== "project" || (s.kind !== "team" && s.kind !== "project") || s.org_unit_id))
      throw invalid("kind: use project to convert a team space without a department to a project space");
    const toProject = b.kind === "project" && s.kind === "team";
    const owner = typeof b.owner_login === "string" ? await activePerson(b.owner_login) : null;
    if (owner && owner.id !== s.owner_id) {
      const ap = await approval(c, "owner_change", () => `Change the owner of space ${s.slug} to ${owner.login}`, owner.id);
      if (ap) return ap;
    }
    if (Object.keys(changed).length || toProject) await checkSpaceMeta(app, c.get("caller"), { ...metaAfterUpdate(s, changed), ...(toProject ? { slug: s.slug } : {}) }, s.id);
    let projectEntity: string | null = null;
    await tx(ctl, async (q) => {
      if (owner) await setSpaceOwner(q, s, owner.id);
      if (Object.keys(changed).length || toProject)
        {
          const updated = (await q.query("UPDATE spaces SET name = COALESCE($2, name), description = CASE WHEN $3 THEN $4 ELSE description END, kind = CASE WHEN $5 THEN 'project' ELSE kind END WHERE id = $1 RETURNING id, slug, name, kind",
            [s.id, changed.name ?? null, "description" in changed, changed.description ?? null, toProject])).rows[0];
          if (updated.kind === "project") {
            projectEntity = await ensureProjectEntity(q, { ...updated, instance_id: app.instanceId }, { update: true });
            if (toProject && !projectEntity) throw invalid("A project entity already uses this slug. Choose another one");
          }
        }
    });
    const tags = toProject && projectEntity ? await tagSpaceRecords(app, s.id, projectEntity) : null;
    if (owner) await adminAudit(c, "space_owner_set", { space: s.id, owner: owner.id, source: "admin" });
    const fields = [...Object.keys(changed), ...(toProject ? ["kind"] : [])];
    if (fields.length) await adminAudit(c, "space_update", { space: s.id, slug: s.slug, fields, via: "admin", ...(tags ? { tagged: tags.tagged, tagging_deferred: tags.deferred } : {}) });
    return c.json((await ctl.query(`${SPACE_SQL} WHERE s.id = $1`, [s.id])).rows[0]);
  });

  r.put("/spaces/:slug/members", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    const s = await spaceBySlug(c.req.param("slug"), { archived: "narrow" });
    const add: Array<{ login: string; role?: string }> = Array.isArray(b?.add) ? b.add : [], remove: string[] = Array.isArray(b?.remove) ? b.remove.map(String) : [];
    if (s.archived_at && add.length) throw archivedManageDenied(s);
    if (add.length && c.get("breakglassNarrowOnly") === true) return c.json(BREAKGLASS_ONLY, 403);
    if (add.length && (s.kind === "team" || s.kind === "project")) {
      const addLogins = add.map((m) => String(m?.login ?? "").trim().toLowerCase());
      const single = addLogins.length === 1 ? await personByLogin(app, addLogins[0]!) : null;
      const ap = await approval(c, "members_add_shared", () => `Add to space ${s.slug}: ${addLogins.slice(0, 5).join(", ")}${add.length > 5 ? ` and ${add.length - 5} more` : ""}`, single?.id ?? s.id);
      if (ap) return ap;
      const signer = approverOf(c);
      if (signer && addLogins.includes(signer.trim().toLowerCase())) return c.json(APPROVER_IS_SUBJECT, 403);
    }
    let added = 0, removed = 0, kept = 0;
    await tx(ctl, async (q) => {
      if (remove.length) await lockReconcile(q, app.instanceId);
      const ownerOfRecord = (id: string) => id === s.owner_id && !s.org_unit_id;
      for (const m of add) {
        const role = m?.role ?? "member";
        if (!["member", "reader"].includes(role)) throw invalid("role: member | reader");
        const p = await activePerson(String(m?.login ?? ""), q);
        if (ownerOfRecord(p.id)) continue;
        const res = await q.query(`INSERT INTO space_members (space_id, person_id, role, source) VALUES ($1,$2,$3,'manual')
                                   ON CONFLICT (space_id, person_id) DO UPDATE SET role = EXCLUDED.role, source = 'manual', grant_id = NULL, expires_at = NULL
                                     WHERE $4::boolean OR space_members.role <> 'owner' OR space_members.source = 'manual'
                                   RETURNING (xmax = 0) AS inserted`, [s.id, p.id, role, !s.org_unit_id]);
        if (res.rows[0]?.inserted) added++;
      }
      const gone: string[] = [];
      for (const login of remove) {
        const p = (await q.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [login.trim().toLowerCase(), app.instanceId])).rows[0];
        if (!p || ownerOfRecord(p.id)) continue;
        if ((await q.query("DELETE FROM space_members WHERE space_id = $1 AND person_id = $2 AND role <> 'owner' AND source = 'manual'", [s.id, p.id])).rowCount) gone.push(p.id);
      }
      if (gone.length) {
        await reconcileAccess(q, app.instanceId, false);
        kept = (await q.query("SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND person_id = ANY($2::uuid[])", [s.id, gone])).rows[0].n as number;
        removed = gone.length - kept;
      }
    });
    await adminAudit(c, "space_members_update", { space: s.id, added, removed, ...(kept ? { kept_derived: kept } : {}) });
    return c.json({ space: s.slug, added, removed });
  });

  r.delete("/spaces/:slug/groups/:id", async (c) => {
    const s = await spaceBySlug(c.req.param("slug"), { archived: "narrow" });
    return c.json(await unbindSpaceGroup(app, c.get("caller"), s, c.req.param("id"), "admin"));
  });
  r.get("/group-sync", async (c) => c.json(await groupSyncState(app)));
  r.post("/group-sync", async (c) => c.json(await syncGroups(app, { trigger: "admin", caller: c.get("caller") })));

  const STAGE_STATUSES = ["pending", "running", "failed"];
  const RETRY_STAGE_NAMES = ["converted", "indexed", "summary", "events", "entities", "described"];
  const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
  r.get("/unprocessed", async (c) => {
    const limit = intParam(c.req.query("limit"), 100, 1, 500);
    const cur = decodeKeyset(c.req.query("cursor"));
    const status = parseEventTypes(c.req.query("status"));
    if (status?.some((s) => !STAGE_STATUSES.includes(s))) throw invalid(`status: ${STAGE_STATUSES.join(" | ")} (separate multiple values with commas)`);
    const cls = c.req.query("class");
    if (cls && !["open", "closed"].includes(cls)) throw invalid("class: open | closed");
    const olderThan = c.req.query("older_than");
    if (olderThan && Number.isNaN(Date.parse(olderThan))) throw invalid("older_than: a date");
    const stage = c.req.query("stage") || null, ownerLogin = c.req.query("owner")?.trim().toLowerCase() || null, spaceSlug = c.req.query("space")?.trim().toLowerCase() || null;
    const errorContains = c.req.query("error_contains")?.trim() || null;
    const errorCode = c.req.query("error_code")?.trim() || null, terminalQ = c.req.query("terminal");
    if (stage && ![...RETRY_STAGE_NAMES, "moved"].includes(stage)) throw invalid(`stage: ${[...RETRY_STAGE_NAMES, "moved"].join(" | ")}`);
    if (errorContains && errorContains.length > 200) throw invalid("error_contains: a string up to 200 characters");
    if (errorCode !== null && (errorCode.length > 60 || /[:\s]/.test(errorCode))) throw invalid("error_code: a reason code up to 60 characters without a colon");
    if (terminalQ !== undefined && terminalQ !== "" && terminalQ !== "true" && terminalQ !== "false") throw invalid("terminal: true or false");
    const terminal = terminalQ === "true" ? true : terminalQ === "false" ? false : null;
    const ownerId = ownerLogin ? (await ctl.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [ownerLogin, app.instanceId])).rows[0]?.id ?? ZERO_UUID : null;
    const spaceId = spaceSlug ? (await ctl.query("SELECT id FROM spaces WHERE slug = $1 AND instance_id = $2", [spaceSlug, app.instanceId])).rows[0]?.id ?? ZERO_UUID : null;
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    const found: Array<{ row: any; cls: "open" | "closed" }> = [], counts: Record<string, number> = {};
    const reasons = new Map<string, { stage: string; code: string; terminal: boolean; count: number }>();
    let failedTerminal = 0;
    for (const k of ["open", "closed"] as const) {
      if (cls && cls !== k) continue;
      const db = app.db.records(k, sys);
      for (const x of (await db.query("SELECT s.stage || ':' || s.status AS k, count(*)::int AS n FROM record_stages s JOIN records_live r ON r.id = s.record_id WHERE s.status IN ('pending','running','failed') GROUP BY 1")).rows) counts[x.k] = (counts[x.k] ?? 0) + x.n;
      for (const x of (await db.query(
        `SELECT s.stage::text AS stage, split_part(COALESCE(s.last_error, ''), ':', 1) AS code, s.terminal, count(*)::int AS n
           FROM record_stages s JOIN records_live r ON r.id = s.record_id WHERE s.status = 'failed' GROUP BY 1, 2, 3`)).rows) {
        const key = `${x.stage}|${x.code}|${x.terminal}`, prev = reasons.get(key);
        reasons.set(key, { stage: x.stage, code: x.code, terminal: x.terminal === true, count: (prev?.count ?? 0) + x.n });
        if (x.terminal === true) failedTerminal += x.n;
      }
      const { rows } = await db.query(
        `SELECT r.id, r.type, r.space_id, r.owner_id, r.occurred_at, r.ingested_at, ${keysetAtSql("r.ingested_at")} AS at_key FROM records_live r
         WHERE EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.status = ANY($1::stage_status[])
                         AND ($6::text IS NULL OR s.stage::text = $6) AND ($7::text IS NULL OR s.last_error ILIKE '%' || $7 || '%' ESCAPE '\\')
                         AND ($10::text IS NULL OR split_part(COALESCE(s.last_error, ''), ':', 1) = $10) AND ($11::boolean IS NULL OR s.terminal = $11))
           AND ($2::timestamptz IS NULL OR r.ingested_at < $2)
           AND ($3::timestamptz IS NULL OR (r.ingested_at, r.id) > ($3::timestamptz, $4::uuid))
           AND ($8::uuid IS NULL OR r.owner_id = $8) AND ($9::uuid IS NULL OR r.space_id = $9)
         ORDER BY r.ingested_at, r.id LIMIT $5`, [status ?? STAGE_STATUSES, olderThan ?? null, cur?.at ?? null, cur?.id ?? null, limit + 1,
                                                  stage, errorContains ? errorContains.replace(/[\\%_]/g, (m) => `\\${m}`) : null, ownerId, spaceId,
                                                  errorCode, terminal]);
      for (const row of rows) found.push({ row, cls: k });
    }
    found.sort((a, b) => keysetCompare(a.row, b.row));
    const pageRows = found.slice(0, limit);
    const items: any[] = [];
    for (const { row: x, cls: k } of pageRows) {
      const meta = (await ctl.query("SELECT (SELECT slug FROM spaces WHERE id = $1) AS slug, (SELECT login FROM people WHERE id = $2) AS owner", [x.space_id, x.owner_id])).rows[0];
      items.push({ id: x.id, path: recordPath(meta.slug ?? "unknown", x.type, x.occurred_at, x.id), type: x.type, class: k, owner: meta.owner ?? "", space: meta.slug,
                   ingested_at: new Date(x.ingested_at).toISOString(), stages: await stagesOf(app.db.records(k, sys), x.id, { extended: true }) });
    }
    const last = pageRows[pageRows.length - 1];
    const waitingConverter = await waitingConverterGroup(app, (cls as "open" | "closed" | undefined) ?? null);
    return c.json({ counts, items, next_cursor: found.length > limit && last ? encodeKeyset(last.row.at_key, last.row.id) : null,
                    reasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code)), failed_terminal: failedTerminal,
                    waiting_converter: waitingConverter });
  });

  r.get("/lookup", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) throw invalid("q: record id, /spaces/… path, a person’s login or name, space slug or name, or key prefix");
    if (q.length > 200) throw invalid("q: up to 200 characters");
    const LIMIT = 20;
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    const locCols = "l.record_id AS id, l.class, l.space_id, l.type, l.owner_id, l.created_at";
    let locs: any[] = [];
    if (isUuidParam(q)) {
      locs = (await ctl.query(`SELECT ${locCols} FROM record_locations l WHERE l.record_id = $1 AND NOT l.deleted`, [q])).rows;
    } else if (q.startsWith("/spaces/")) {
      const seg = q.split("/").filter(Boolean).slice(1);                 // [slug, type?, yyyy?, mm?, id?]
      const tail = seg[seg.length - 1];
      if (seg.length > 1 && tail && isUuidParam(tail)) {
        locs = (await ctl.query(`SELECT ${locCols} FROM record_locations l WHERE l.record_id = $1 AND NOT l.deleted`, [tail])).rows;
      } else if (seg[0]) {
        locs = (await ctl.query(
          `SELECT ${locCols} FROM record_locations l JOIN spaces sp ON sp.id = l.space_id
           WHERE sp.slug = $1 AND sp.instance_id = $2 AND ($3::text IS NULL OR l.type = $3) AND NOT l.deleted
           ORDER BY l.created_at DESC NULLS LAST, l.record_id DESC LIMIT $4`, [seg[0], app.instanceId, seg[1] ?? null, LIMIT])).rows;
      }
    }
    const meta = new Map<string, { occurred_at: Date; done: number; total: number; failed: number }>();
    for (const k of ["open", "closed"] as const) {
      const ids = locs.filter((l) => l.class === k).map((l) => l.id);
      if (!ids.length) continue;
      const { rows } = await app.db.records(k, sys).query(
        `SELECT r.id, r.occurred_at, count(st.*) FILTER (WHERE st.status IN ('done','skipped'))::int AS done,
                count(st.*)::int AS total, count(st.*) FILTER (WHERE st.status = 'failed')::int AS failed
         FROM records_live r LEFT JOIN record_stages st ON st.record_id = r.id WHERE r.id = ANY($1::uuid[]) GROUP BY r.id, r.occurred_at`, [ids]);
      for (const x of rows) meta.set(x.id, { occurred_at: x.occurred_at, done: x.done, total: x.total, failed: x.failed });
    }
    const names = new Map<string, { slug?: string; login?: string }>();
    const spaceIds = [...new Set(locs.map((l) => l.space_id))], ownerIds = [...new Set(locs.map((l) => l.owner_id))];
    if (spaceIds.length) for (const x of (await ctl.query("SELECT id, slug FROM spaces WHERE id = ANY($1)", [spaceIds])).rows) names.set(x.id, { slug: x.slug });
    if (ownerIds.length) for (const x of (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1)", [ownerIds])).rows) names.set(x.id, { login: x.login });
    const records = locs.slice(0, LIMIT).map((l) => {
      const slug = names.get(l.space_id)?.slug ?? "unknown", m = meta.get(l.id);
      return {
        id: l.id, path: m ? recordPath(slug, l.type, m.occurred_at, l.id) : `/spaces/${slug}/${l.type}/${l.id}`,
        type: l.type, class: l.class, space: slug, owner: names.get(l.owner_id)?.login ?? "",
        created_at: l.created_at ? new Date(l.created_at).toISOString() : null,
        stages: m ? { done: m.done, total: m.total, failed: m.failed } : null,
      };
    });
    const people = (await ctl.query(
      `SELECT login, display_name, active FROM people WHERE instance_id = $1 AND (login ILIKE '%' || $2 || '%' OR display_name ILIKE '%' || $2 || '%')
       ORDER BY login LIMIT $3`, [app.instanceId, q, LIMIT])).rows;
    const spaces = (await ctl.query(
      `SELECT s.slug, s.name AS title, s.kind, p.login AS owner FROM spaces s LEFT JOIN people p ON p.id = s.owner_id AND ${OWNER_IN_FORCE_SQL}
       WHERE s.instance_id = $1 AND (s.slug ILIKE '%' || $2 || '%' OR s.name ILIKE '%' || $2 || '%') ORDER BY s.slug LIMIT $3`, [app.instanceId, q, LIMIT])).rows;
    const keys = (await ctl.query(
      `SELECT k.id, k.key_prefix AS prefix, k.kind, k.principal_type, COALESCE(p.login, sv.name) AS principal, k.client_label, k.client_kind, k.expires_at, k.revoked_at
       FROM api_keys k LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id
                       LEFT JOIN services sv ON k.principal_type = 'service' AND sv.id = k.principal_id
       WHERE k.auth_method = 'api_key' AND k.instance_id = $1 AND k.key_prefix ILIKE '%' || $2 || '%' ORDER BY k.created_at DESC LIMIT $3`, [app.instanceId, q, LIMIT])).rows;
    return c.json({
      records, people,
      spaces: spaces.map((x) => ({ slug: x.slug, title: x.title, kind: x.kind, owner: x.owner ?? null })),
      keys: keys.map((x) => ({ id: x.id, prefix: x.prefix, kind: x.kind, principal_type: x.principal_type, principal: x.principal ?? null,
                               client_label: x.client_label, client_kind: x.client_kind ?? null, expires_at: x.expires_at ? new Date(x.expires_at).toISOString() : null,
                               revoked_at: x.revoked_at ? new Date(x.revoked_at).toISOString() : null })),
    });
  });

  r.post("/stages/retry", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const STAGES = ["converted", "indexed", "summary", "events", "entities", "described"];
    if (b.stage === "moved") throw invalid("stage moved represents a class move (class_moves). It has no record_stages row to retry", { stages: STAGES });
    if (b.stage !== undefined && !STAGES.includes(b.stage)) throw invalid(`stage: ${STAGES.join(" | ")}`);
    if (b.class !== undefined && !["open", "closed"].includes(b.class)) throw invalid("class: open | closed");
    if (b.record_ids !== undefined && !(Array.isArray(b.record_ids) && b.record_ids.length <= 1000 && b.record_ids.every((x: unknown) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x)))) throw invalid("record_ids: an array of up to 1000 UUIDs");
    if (b.failed_since !== undefined && Number.isNaN(new Date(b.failed_since).getTime())) throw invalid("failed_since: a date");
    if (b.error_contains !== undefined && (typeof b.error_contains !== "string" || b.error_contains.length > 200)) throw invalid("error_contains: a string up to 200 characters");
    if (b.include_waiting !== undefined && typeof b.include_waiting !== "boolean") throw invalid("include_waiting: true or false");
    if (b.now !== undefined && typeof b.now !== "boolean") throw invalid("now: true or false");
    if (b.skip_terminal !== undefined && typeof b.skip_terminal !== "boolean") throw invalid("skip_terminal: true or false");
    if (b.now === true && !(Array.isArray(b.record_ids) && b.record_ids.length >= 1 && b.record_ids.length <= 20)) throw invalid("You can run up to 20 individual records immediately");
    const withWaiting = b.include_waiting === true, now = b.now === true, skipTerminal = b.skip_terminal === true;
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    const args = [b.record_ids ?? null, b.stage ?? null, b.failed_since ?? null, b.error_contains ?? null];
    const filter = `($1::uuid[] IS NULL OR s.record_id = ANY($1::uuid[])) AND ($2::text IS NULL OR s.stage = $2::stage_name)
           AND ($3::timestamptz IS NULL OR s.updated_at >= $3) AND ($4::text IS NULL OR s.last_error ILIKE '%' || $4 || '%')`;
    const clear = "status = 'pending', terminal = false, last_error = NULL, retry_at = NULL, first_busy_at = NULL, busy_retries = 0, slow_retries = 0, updated_at = now()";
    let reset = 0, waiting = 0, kicked = 0, waitingConverter = 0, convPending = 0; const records = new Set<string>();
    const convWaiting = withWaiting && (b.stage === "converted" || (b.stage === undefined && Array.isArray(b.record_ids)));
    for (const k of ["open", "closed"] as const) {
      if (b.class && b.class !== k) continue;
      const db = app.db.records(k, sys);
      const failed = (await db.query(
        `UPDATE record_stages s SET attempts = 0, ${clear}
         FROM records_live r WHERE r.id = s.record_id AND s.status = 'failed' AND COALESCE(s.last_error, '') NOT LIKE 'llm_too_slow:%' AND ${filter}${skipTerminal ? " AND NOT s.terminal" : ""}
         RETURNING s.record_id`, args)).rows;
      const waited = withWaiting ? (await db.query(
        `UPDATE record_stages s SET attempts = CASE WHEN s.status = 'failed' THEN 0 ELSE s.attempts END, ${clear}
         FROM records_live r WHERE r.id = s.record_id AND s.stage = ANY($5::stage_name[])
           AND ((s.status = 'pending' AND (s.busy_retries > 0 OR s.slow_retries > 0 OR s.retry_at IS NOT NULL OR COALESCE(s.last_error, '') LIKE 'model_%'))
                OR (s.status = 'failed' AND COALESCE(s.last_error, '') LIKE 'llm_too_slow:%'))
           AND ${filter}
         RETURNING s.record_id`, [...args, [...LLM_STAGES]])).rows : [];
      const convWoken = convWaiting
        ? await wakeConverterWaiting(db, { sql: filter, args }, { running: true, ...(Array.isArray(b.record_ids) ? {} : { limit: WAKE_AFTER_ACTION_MAX - convPending }) })
        : { pending: [], running: [] };
      convPending += convWoken.pending.length;
      reset += failed.length; waiting += waited.length; waitingConverter += convWoken.pending.length + convWoken.running.length;
      const ids = [...new Set([...failed.map((x) => x.record_id as string), ...waited.map((x) => x.record_id as string), ...convWoken.pending])];
      if (!ids.length) continue;
      const raised = new Set(now ? (await db.query(
        `UPDATE records SET attrs = (attrs - 'deferred_reason' - 'deferred_to_night_at') || jsonb_build_object('process_now_at', now())
          WHERE id = ANY($1::uuid[]) AND type = 'transcript' RETURNING id`, [ids])).rows.map((x) => x.id as string) : []);
      const lanes = new Map((await db.query("SELECT id, attrs ? 'process_now_at' AS now FROM records WHERE id = ANY($1::uuid[])", [ids])).rows.map((x) => [x.id as string, x.now === true]));
      const hadFailed = new Set(failed.map((x) => x.record_id as string));
      for (const id of ids) {
        records.add(id);
        const lane = raised.has(id) || lanes.get(id) || hadFailed.has(id) ? "now" : "night";
        try { await app.queue.kick({ instance: app.instanceId, class: k, record_id: id, lane }); kicked++; }
        catch (e) { log.warn("stage_retry_kick_failed", { record_id: id, error: (e as Error).message.slice(0, 120) }); }
      }
    }
    await adminAudit(c, "stage_retry", { reset, waiting, records: records.size, kicked, include_waiting: withWaiting, now, ...(skipTerminal ? { skip_terminal: true } : {}),
                                         ...(convWaiting ? { waiting_converter: waitingConverter } : {}),
                                         filter: { stage: b.stage ?? null, class: b.class ?? null, failed_since: b.failed_since ?? null, error_contains: b.error_contains ?? null, record_ids: b.record_ids?.length ?? null } });
    return c.json({ reset, waiting, records: records.size, kicked, ...(convWaiting ? { waiting_converter: waitingConverter } : {}) });
  });

  r.get("/people/:login/access", async (c) => {
    const login = decodeURIComponent(c.req.param("login")).trim().toLowerCase();
    const p = (await ctl.query("SELECT id, login, display_name, department, role, active, attrs, updated_at FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0];
    if (!p) throw notFound();
    const spaces = [...(await readableSpaces(app, { person: p } as unknown as Caller, { archived: true })).values()].sort((a, b) => a.slug.localeCompare(b.slug));
    const grants = (await ctl.query(
      `SELECT g.id, g.role_code, r.name, r.memory_effect, g.actions, g.scope_kind, g.scope_ref, g.basis_source, g.basis_ref, g.approved_by, g.valid_from, g.valid_to
       FROM role_grants g JOIN roles r ON r.code = g.role_code WHERE g.person_id = $1 AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now()) ORDER BY g.created_at`, [p.id])).rows;
    const keys = (await ctl.query("SELECT id, key_prefix, kind, tier, client_label, client_kind, basis, preview, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE auth_method = 'api_key' AND principal_type = 'person' AND principal_id = $1 ORDER BY created_at DESC LIMIT 100", [p.id])).rows;
    const effective = keys.filter((k) => !k.revoked_at && (!k.expires_at || new Date(k.expires_at) > new Date()));
    const closedVia = effective.filter((k) => k.kind === "extended")
      .map((k) => ({ key_id: k.id, basis: k.basis ?? null, expires_at: k.expires_at ? new Date(k.expires_at).toISOString() : null }));
    const classesReadable = !p.active ? [] : closedVia.length ? ["open", "closed"] : ["open"];
    const records = (await ctl.query(
      `SELECT (SELECT slug FROM spaces WHERE id = l.space_id) AS space, l.type, l.class, count(*)::int AS n
       FROM record_locations l WHERE l.owner_id = $1 AND NOT l.deleted GROUP BY l.space_id, l.type, l.class ORDER BY 1, 2, 3`, [p.id])).rows;
    const org_units = (await ctl.query("SELECT u.code, u.name, pu.relation, pu.source FROM person_org_units pu JOIN org_units u ON u.id = pu.org_unit_id WHERE pu.person_id = $1 ORDER BY u.code", [p.id])).rows;
    const owned = (await ctl.query(
      `SELECT s.slug, s.name, s.kind FROM spaces s JOIN people p ON p.id = s.owner_id
       WHERE s.owner_id = $1 AND s.instance_id = $2 AND s.kind <> 'personal' AND s.archived_at IS NULL AND ${OWNER_IN_FORCE_SQL} ORDER BY s.slug LIMIT 100`, [p.id, app.instanceId])).rows;
    const oauthConnections = (await ctl.query(
      `SELECT count(*)::int AS n FROM oauth_connections c JOIN api_keys k ON k.id = c.id
       WHERE c.person_id = $1 AND c.instance_id = $2 AND k.auth_method = 'oauth' AND k.revoked_at IS NULL AND k.expires_at > now()`, [p.id, app.instanceId])).rows[0]?.n ?? 0;
    const policy = custodyPolicy(app.settings);
    const holds = (await ctl.query(
      `SELECT d.login, d.display_name, s.archived_at FROM personal_custody c JOIN people d ON d.id = c.person_id LEFT JOIN spaces s ON s.id = c.space_id
        WHERE c.instance_id = $1 AND c.custodian_id = $2 AND NOT d.active ORDER BY d.display_name, d.login LIMIT 100`, [app.instanceId, p.id])).rows;
    const ofPerson = p.active ? null : await personCustody(ctl, app.instanceId, p.id, policy,
                                                           [app.db.records("open", { classes: ["open", "closed"], tier: "system" }), app.db.records("closed", { classes: ["open", "closed"], tier: "system" })]);
    if (ofPerson) ofPerson.closed_opened = await custodyClosedOpened(app, p.id);
    const custody = {
      of_person: ofPerson,
      holds: holds.map((x) => ({ login: x.login as string, display_name: (x.display_name ?? null) as string | null, since: isoOrNull(x.archived_at) })),
      policy: { personal: policy.personal, meetings: policy.meetings, after_days: policy.afterDays, retention_days: policy.retentionDays },
    };
    return c.json({
      person: { login: p.login, display_name: p.display_name, department: p.department, role: p.role, active: p.active, demo: p.attrs?.demo === true, updated_at: new Date(p.updated_at).toISOString() },
      classes_readable: classesReadable,
      closed_via: closedVia,
      spaces: spaces.map((s) => ({ slug: s.slug, kind: s.kind, name: s.name, role: s.role, via: s.via, default_class: s.default_class, grant_id: s.grant_id, expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null,
                                   ...(s.archived_at ? { archived: true } : {}) })),
      owned_spaces: owned.map((s) => ({ slug: s.slug as string, name: s.name as string, kind: s.kind as string })),
      org_units, grants, keys, records,
      oauth_connections: Number(oauthConnections),
      custody,
    });
  });

  r.put("/people/:login/custodian", async (c) => {
    const login = decodeURIComponent(c.req.param("login")).trim().toLowerCase();
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    if (!b || typeof b !== "object" || Array.isArray(b) || !("custodian" in b) || Object.keys(b).some((k) => k !== "custodian" && k !== "reason")
        || (b.custodian !== null && (typeof b.custodian !== "string" || !b.custodian.trim() || b.custodian.length > 254))
        || (b.reason !== undefined && b.reason !== null && (typeof b.reason !== "string" || b.reason.length > 1000)))
      throw invalid("Request body: {\"custodian\": custodian login or null (return to the default rule), \"reason\": reason}");
    const op = await operatorOf(app, c);
    const operator = op.person ?? (op.unknown ? null : await operatorPerson(app, undefined));
    const approver = await personByLogin(app, approverOf(c));
    const policy = custodyPolicy(app.settings);
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    const out = await tx(ctl, async (q) => {
      await lockCustody(q, app.instanceId);
      const set = await setCustodian(q, app.instanceId, policy, { personLogin: login, custodianLogin: b.custodian === null ? null : String(b.custodian).trim().toLowerCase(),
                                                                  reason: b.reason ?? null, actorLabel: setBy(c.get("caller")), operatorId: operator?.id ?? null,
                                                                  operatorUnknown: op.unknown })
        .catch((e: unknown) => {
          if (e instanceof CustodyRefusal && e.reason === "custodianOperator" && operator) throw custodianIsOperator(e.message, operator.login);
          throw e;
        });
      const person = (await q.query("SELECT id FROM people WHERE login = $1 AND instance_id = $2", [login, app.instanceId])).rows[0]!.id as string;
      const ch = set.change;
      if (operator && ch?.to === operator.id) throw custodianIsOperator(CUSTODY_TEXTS.custodianOperator, operator.login);
      if (approver && ch?.to === approver.id)
        throw custodianIsOperator("Choose a custodian other than the person who signed the assignment", approver.login);
      if (ch?.from && ch.to && ch.from !== ch.to) await custodyOffLetter(q, policy, ch, setBy(c.get("caller")));
      return { set, person, view: await personCustody(q, app.instanceId, person, policy, [app.db.records("open", sys), app.db.records("closed", sys)]) };
    });
    if (out.view) out.view.closed_opened = await custodyClosedOpened(app, out.person);
    const ch = out.set.change;
    if (ch) {
      await audit(app, c.get("caller"), { event_type: "admin", space_id: ch.space,
        details: { op: "custody_set", person: ch.person, custodian: ch.to, previous: ch.from, reason_given: !!out.view?.reason, ...(b.custodian === null ? { to_rule: true } : {}),
                   ...(out.set.reasonChanged ? { reason_changed: true } : {}) } });
      await app.queue.wake("dismissed_retention");
    }
    return c.json(out.view);
  });

  r.get("/audit", async (c) => c.json(await adminAuditPage(app, c.req.query())));

  r.post("/logout", async (c) => {
    const sessionId = c.get("caller").admin?.sessionId;
    if (sessionId) {
      await revokeAdminSessions(app, { sessionId }, "logout");
      await adminAudit(c, "admin_logout", { scope: "session" });
      return c.body(null, 204);
    }
    const label = c.get("caller").clientLabel ?? "";
    if (!label.startsWith("admin:")) throw invalid("Sign out using an admin panel session. A system key has no session to sign out of");
    const login = label.slice("admin:".length);
    const res = await ctl.query("UPDATE admin_users SET sessions_revoked_at = now() WHERE login = $1", [login]);
    if (!res.rowCount) throw notFound();
    await adminAudit(c, "admin_logout", { login });
    return c.body(null, 204);
  });

  async function openCheckStats(hours: number, limit: number) {
    const db = app.db.auditRead();
    const WHERE = `instance_id = $1 AND event_type IN ('write','processing') AND details->>'op' = 'open_check_refused' AND at > now() - make_interval(hours => $2)`;
    const [total, kinds, vias, top] = await Promise.all([
      db.query(`SELECT count(*)::int AS n FROM audit_events WHERE ${WHERE}`, [app.instanceId, hours]),
      db.query(`SELECT k, count(*)::int AS n FROM audit_events,
                  LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(details->'kinds') = 'array' AND jsonb_array_length(details->'kinds') > 0 THEN details->'kinds'
                                                         WHEN details ? 'unchecked' THEN '["unchecked"]'::jsonb ELSE '[]'::jsonb END) AS k
                WHERE ${WHERE} GROUP BY k`, [app.instanceId, hours]),
      db.query(`SELECT COALESCE(details->>'via', '?') AS via, count(*)::int AS n FROM audit_events WHERE ${WHERE} GROUP BY 1`, [app.instanceId, hours]),
      limit > 0
        ? db.query(`SELECT at, details->>'via' AS via, details->'kinds' AS kinds, details->'rules' AS rules, details->>'unchecked' AS unchecked, space_id,
                           COALESCE(on_behalf_of, principal_id) AS person, record_ids
                    FROM audit_events WHERE ${WHERE} ORDER BY at DESC LIMIT $3`, [app.instanceId, hours, limit])
        : Promise.resolve({ rows: [] as any[] }),
    ]);
    const by_kind: Record<string, number> = Object.fromEntries(kinds.rows.map((x) => [x.k, x.n]));
    const by_via: Record<string, number> = Object.fromEntries(vias.rows.map((x) => [x.via, x.n]));
    const FB = `instance_id = $1 AND event_type IN ('write','processing') AND details->>'op' = 'open_check_fallback' AND at > now() - make_interval(hours => $2)`;
    const [fbTotal, fbKinds, fbVias] = await Promise.all([
      db.query(`SELECT count(*)::int AS n FROM audit_events WHERE ${FB}`, [app.instanceId, hours]),
      db.query(`SELECT k, count(*)::int AS n FROM audit_events, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(details->'kinds') = 'array' THEN details->'kinds' ELSE '[]'::jsonb END) AS k
                WHERE ${FB} GROUP BY k`, [app.instanceId, hours]),
      db.query(`SELECT COALESCE(details->>'check_via', details->>'via', '?') AS via, count(*)::int AS n FROM audit_events WHERE ${FB} GROUP BY 1`, [app.instanceId, hours]),
    ]);
    const fallback = { total: fbTotal.rows[0]?.n ?? 0, by_kind: Object.fromEntries(fbKinds.rows.map((x) => [x.k, x.n])) as Record<string, number>,
                       by_via: Object.fromEntries(fbVias.rows.map((x) => [x.via, x.n])) as Record<string, number> };
    const rows = top.rows;
    const spaceIds = [...new Set(rows.map((x) => x.space_id).filter(Boolean))], peopleIds = [...new Set(rows.map((x) => x.person).filter(Boolean))];
    const slugs = new Map((spaceIds.length ? (await ctl.query("SELECT id, slug FROM spaces WHERE id = ANY($1::uuid[])", [spaceIds])).rows : []).map((r) => [r.id as string, r.slug as string]));
    const logins = new Map((peopleIds.length ? (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [peopleIds])).rows : []).map((r) => [r.id as string, r.login as string]));
    return { refused: total.rows[0]?.n ?? 0, by_kind, by_via, fallback,
      items: rows.map((x) => ({ at: new Date(x.at).toISOString(), via: x.via, kinds: Array.isArray(x.kinds) ? x.kinds : [], rules: Array.isArray(x.rules) ? x.rules : [],
                               ...(x.unchecked ? { unchecked: x.unchecked } : {}),
                               space: x.space_id ? slugs.get(x.space_id) ?? null : null, by: x.person ? logins.get(x.person) ?? null : null, record_ids: x.record_ids ?? [] })) };
  }

  r.get("/open-check", async (c) => {
    await app.settings.load(true);
    const cfg = openCheckSettings(app.settings);
    // a built-in rule is active when its pack is on and it is not switched off
    const states = new Map(builtinRuleStates(cfg).map((x) => [x.name, x.active]));
    const stats = await openCheckStats(24, 0);
    return c.json({
      enabled: cfg.enabled,
      rules: [...BUILTIN_OPEN_CHECK_RULES.map((x) => ({ name: x.name, kind: x.kind, reason: x.reason, pattern: x.pattern, builtin: true, active: states.get(x.name) === true })),
              ...(Array.isArray(cfg.extra_rules) ? cfg.extra_rules : []).map((x) => ({ name: x.name, kind: x.kind, reason: x.reason, pattern: x.pattern, builtin: false,
                                                                                        active: extraRuleRunsAs(x, cfg.extra_rules) !== null }))],
      disabled_rules: cfg.disabled_rules, extra_rules: cfg.extra_rules, nda_customers: cfg.nda_customers,
      timeout_sec: cfg.timeout_sec,
      refused_24h: { total: stats.refused, by_kind: stats.by_kind },
      runner: openCheckRunnerState(),
    });
  });

  r.post("/open-check/test", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (typeof b?.text !== "string" || !b.text.length || b.text.length > 200_000) throw invalid("text: a string of 1 to 200,000 characters");
    await app.settings.load(true);
    const enabled = openCheckSettings(app.settings).enabled;
    try { return c.json({ enabled, findings: await openFindings(app, [{ field: "text", value: b.text }], { force: true }) }); }
    catch (e) { if (e instanceof OpenCheckTimeout) return c.json({ enabled, findings: [], ...openCheckTestRefusal(e) }); throw e; }
  });

  async function spacesReport(hours: number) {
    const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
    const NEW = "s.instance_id = $1 AND s.kind <> 'personal' AND s.archived_at IS NULL AND s.created_at > now() - make_interval(hours => $2)";
    const byVia = (await ctl.query(
      `SELECT COALESCE(s.created_via, 'unknown') AS via, count(*)::int AS n, count(*) FILTER (WHERE s.default_class = 'open')::int AS open
       FROM spaces s WHERE ${NEW} GROUP BY 1`, [app.instanceId, hours])).rows;
    const fresh = (await ctl.query(
      `SELECT s.slug, s.name, s.kind, s.default_class, p.login AS owner, cb.login AS created_by, s.created_via, s.created_at,
              (SELECT count(*)::int FROM space_members_effective m WHERE m.space_id = s.id) AS members_count,
              (SELECT count(*)::int FROM space_groups g WHERE g.space_id = s.id) AS groups_count
       FROM spaces s LEFT JOIN people p ON p.id = s.owner_id LEFT JOIN people cb ON cb.id = s.created_by
       WHERE ${NEW} ORDER BY s.created_at DESC, s.id DESC LIMIT 100`, [app.instanceId, hours])).rows;
    const binds = (await ctl.query(
      `SELECT g.created_at, s.slug, g.display_name, g.role, a.login AS by_login, g.members_matched, count(*) OVER ()::int AS total
       FROM space_groups g JOIN spaces s ON s.id = g.space_id AND s.instance_id = $1 LEFT JOIN people a ON a.id = g.added_by
       WHERE g.created_at > now() - make_interval(hours => $2) ORDER BY g.created_at DESC, g.id DESC LIMIT 100`, [app.instanceId, hours])).rows;
    const orphans = (await ctl.query(
      `SELECT s.slug, s.name, s.kind, p.login AS owner, count(*) OVER ()::int AS total FROM spaces s JOIN people p ON p.id = s.owner_id
       WHERE s.instance_id = $1 AND ${ORPHAN_SQL} ORDER BY p.updated_at DESC, s.slug LIMIT 100`, [app.instanceId])).rows;
    return {
      new_spaces: { count: byVia.reduce((n, x) => n + x.n, 0), open: byVia.reduce((n, x) => n + x.open, 0), by_via: Object.fromEntries(byVia.map((x) => [x.via, x.n])),
                    items: fresh.map((x) => ({ slug: x.slug, name: x.name, kind: x.kind, default_class: x.default_class, owner: x.owner ?? null, created_by: x.created_by ?? null,
                                               created_via: x.created_via ?? null, created_at: iso(x.created_at), members_count: x.members_count, groups_count: x.groups_count })) },
      group_binds: { count: binds[0]?.total ?? 0,
                     items: binds.map((x) => ({ at: iso(x.created_at), slug: x.slug, group: x.display_name, role: x.role, by: x.by_login ?? null, members_matched: x.members_matched ?? null })) },
      group_sync: await groupSyncState(app),
      spaces_without_owner: { count: orphans[0]?.total ?? 0, items: orphans.map((x) => ({ slug: x.slug, name: x.name, kind: x.kind, owner: x.owner })) },
      department_spaces_without_head: await departmentSpacesWithoutHead(ctl, app.instanceId),
      space_meta_findings: await spaceMetaFindings(),
      space_class_changes: await spaceClassChanges(hours),
    };
  }

  async function spaceClassChanges(hours: number) {
    try {
      const { rows } = await app.db.auditRead().query(
        `SELECT at, principal_id, space_id, details->>'slug' AS slug, details->>'from' AS from_class, details->>'to' AS to_class, count(*) OVER ()::int AS total
         FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND details->>'op' = 'space_class_change' AND at > now() - make_interval(hours => $2)
         ORDER BY at DESC, id DESC LIMIT 100`, [app.instanceId, hours]);
      const ids = [...new Set(rows.flatMap((x) => [x.principal_id, x.space_id]).filter(Boolean))];
      const names = new Map<string, { login?: string; name?: string; slug?: string }>();
      if (ids.length) {
        for (const p of (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [ids])).rows) names.set(p.id, { login: p.login });
        for (const sp of (await ctl.query("SELECT id, slug, name FROM spaces WHERE id = ANY($1::uuid[])", [ids])).rows) names.set(sp.id, { slug: sp.slug, name: sp.name });
      }
      return { count: rows[0]?.total ?? 0,
               items: rows.map((x) => ({ at: new Date(x.at).toISOString(), slug: names.get(x.space_id)?.slug ?? x.slug ?? null, name: names.get(x.space_id)?.name ?? null,
                                         from: x.from_class, to: x.to_class, by: names.get(x.principal_id)?.login ?? null })) };
    } catch (e) {
      log.warn("report_space_class_changes_failed", { error: (e as Error).message.slice(0, 160) });
      return { count: 0, items: [] as unknown[], unavailable: true };
    }
  }

  async function spaceMetaFindings() {
    await app.settings.load(true).catch(() => undefined);
    if (!openCheckSettings(app.settings).enabled) return { checked: 0, count: 0, items: [] as unknown[] };
    const { rows } = await ctl.query(
      `SELECT slug, name, description, readme, kind, default_class FROM spaces WHERE instance_id = $1 AND archived_at IS NULL AND kind <> 'personal' AND org_unit_id IS NULL
       ORDER BY created_at DESC, id DESC`, [app.instanceId]);
    const started = Date.now(), items: Array<{ slug: string; kind: string; default_class: string; findings: Array<{ field: string; rule: string; kind: string }> }> = [];
    let checked = 0, unchecked = false;
    for (const s of rows) {
      if (Date.now() - started > 5_000) { unchecked = true; break; }
      let found;
      try { found = await openFindings(app, spaceMetaTexts(s), { owner: "report", as: SPACE_META_FIELDS }); }
      catch { unchecked = true; break; }
      checked++;
      if (!found.length) continue;
      const uniq = new Map(found.map((f) => [`${f.field}\u0000${f.rule}`, { field: f.field, rule: f.rule, kind: f.kind }]));
      items.push({ slug: s.slug, kind: s.kind, default_class: s.default_class, findings: [...uniq.values()] });
    }
    return { checked, count: items.length, ...(unchecked ? { unchecked: true } : {}), items: items.slice(0, 100) };
  }

  async function clientMismatchReport(hours: number) {
    const { rows } = await app.db.auditRead().query(
      `SELECT key_id, name, source, version, ua, n, last_at FROM (
         SELECT key_id, name, (array_agg(source ORDER BY last_at DESC))[1] AS source, (array_agg(version ORDER BY last_at DESC))[1] AS version,
                (array_agg(ua ORDER BY last_at DESC))[1] AS ua, sum(n)::int AS n, max(last_at) AS last_at,
                row_number() OVER (PARTITION BY key_id ORDER BY sum(n) DESC, max(last_at) DESC) AS rn
         FROM (
           SELECT key_id::text AS key_id, details->'client'->>'name' AS name, details->'client'->>'source' AS source,
                  max(details->'client'->>'version') AS version, max(details->'client'->>'ua') AS ua, count(*) AS n, max(at) AS last_at
           FROM audit_events
           WHERE instance_id = $1 AND at > now() - make_interval(hours => $2) AND principal_type = 'person' AND key_id IS NOT NULL
             AND details ? 'client' AND NOT details ? 'preview' AND NOT details ? 'session' AND NOT details ? 'upload_ticket'
             AND COALESCE(details->>'tool', '') <> 'memory_me'
           GROUP BY 1, 2, 3) g
         WHERE name IS NOT NULL
         GROUP BY key_id, name) t
       WHERE rn <= 20`, [app.instanceId, hours]);
    const ids = [...new Set(rows.map((x) => x.key_id as string))];
    const keys = new Map<string, ClientKeyRow>(ids.length ? (await ctl.query(
      `SELECT k.id::text AS id, k.key_prefix, k.client_kind, p.login FROM api_keys k LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id
       WHERE k.id = ANY($1::uuid[]) AND k.instance_id = $2`, [ids, app.instanceId])).rows.map((k) => [k.id as string, { key_prefix: k.key_prefix ?? null, client_kind: k.client_kind ?? null, login: k.login ?? null }]) : []);
    return buildClientMismatch(rows as ClientSeenRow[], keys);
  }

  r.get("/report", async (c) => {
    const hours = Math.min(24 * 14, Math.max(1, Number(c.req.query("hours") ?? 24)));
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    const by: Record<string, { accepted: number; processed: number; failed: number; queued: number }> = {};
    const verifier = { input: 0, exact: 0, fuzzy: 0, quote_not_found: 0, duplicate: 0, over_limit: 0, kept: 0, suppressed_by_correction: 0, transcripts: 0 };
    const durations: Record<string, { n: number; p50_sec: number | null; p95_sec: number | null }> = {};
    const samples: Record<string, number[]> = {};
    for (const k of ["open", "closed"] as const) {
      const db = app.db.records(k, sys);
      for (const x of (await db.query(
        `SELECT r.type, count(*)::int AS accepted,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.status NOT IN ('done','skipped')))::int AS processed,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.status = 'failed'))::int AS failed,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.status IN ('pending','running')))::int AS queued
         FROM records_live r WHERE r.source_kind <> 'pipeline' AND r.ingested_at > now() - make_interval(hours => $1) GROUP BY r.type`, [hours])).rows) {
        const t = (by[x.type] ??= { accepted: 0, processed: 0, failed: 0, queued: 0 });
        t.accepted += x.accepted; t.processed += x.processed; t.failed += x.failed; t.queued += x.queued;
      }
      for (const x of (await db.query("SELECT attrs->'extraction' AS e FROM records_live WHERE type = 'transcript' AND attrs ? 'extraction' AND ingested_at > now() - make_interval(hours => $1)", [hours])).rows) {
        verifier.transcripts++;
        for (const f of ["input", "exact", "fuzzy", "quote_not_found", "duplicate", "over_limit", "kept", "suppressed_by_correction"] as const) verifier[f] += Number(x.e?.[f] ?? 0);
      }
      const d = await db.query("SELECT stage, duration_ms FROM record_stages WHERE duration_ms IS NOT NULL AND updated_at > now() - make_interval(hours => $1)", [hours]).catch(() => ({ rows: [] as Array<{ stage: string; duration_ms: number }> }));
      for (const x of d.rows) (samples[x.stage] ??= []).push(Number(x.duration_ms) / 1000);
    }
    for (const [stage, xs] of Object.entries(samples)) {
      xs.sort((a, b) => a - b);
      const q = (p: number) => xs.length ? Number(xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!.toFixed(1)) : null;
      durations[stage] = { n: xs.length, p50_sec: q(0.5), p95_sec: q(0.95) };
    }
    const total = Object.values(by).reduce((a, t) => ({ accepted: a.accepted + t.accepted, processed: a.processed + t.processed }), { accepted: 0, processed: 0 });
    const wide = (await ctl.query(
      `SELECT g.id, g.role_code AS role, p.login AS person, g.scope_kind, g.created_at FROM role_grants g JOIN people p ON p.id = g.person_id
       WHERE g.instance_id = $1 AND g.created_at > now() - interval '24 hours' AND ${WIDE_SQL} ORDER BY g.created_at DESC LIMIT 200`, [app.instanceId])).rows;
    const denials: Record<string, number> = {};
    for (const x of (await app.db.auditRead().query(
      `SELECT details->>'reason' AS reason, count(*)::int AS n FROM audit_events
       WHERE instance_id = $1 AND event_type = 'auth_failure' AND at > now() - make_interval(hours => $2) AND details->>'reason' LIKE 'obo\\_%' GROUP BY 1`, [app.instanceId, hours])).rows) denials[x.reason] = x.n;
    const paused = (await ctl.query(
      `SELECT k.id, k.key_prefix, COALESCE(p.login, s.name) AS principal, k.paused_until FROM api_keys k
       LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id LEFT JOIN services s ON k.principal_type = 'service' AND s.id = k.principal_id
       WHERE k.instance_id = $1 AND k.revoked_at IS NULL AND k.paused_until > now() ORDER BY k.paused_until DESC LIMIT 200`, [app.instanceId])).rows;
    const unbound = (await ctl.query(
      `SELECT k.id, k.key_prefix, s.name AS service, host(k.last_used_ip) AS last_used_ip, k.last_used_at FROM api_keys k JOIN services s ON s.id = k.principal_id
       WHERE k.instance_id = $1 AND k.principal_type = 'service' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND s.active AND s.obo_allowed
         AND ${KEY_UNBOUND_SQL}
       ORDER BY s.name, k.created_at LIMIT 200`, [app.instanceId])).rows;
    const iso = (d: unknown) => d ? new Date(d as string).toISOString() : null;
    const REFUSED = `(m.accepted_rules IS NOT NULL OR m.text_only) AND (m.error LIKE 'open_check%' OR m.error LIKE 'never_open:%')`;
    const mv = (await ctl.query(
      `SELECT count(*) FILTER (WHERE m.status = 'failed' AND NOT (${REFUSED}) AND m.finished_at > now() - make_interval(hours => $2))::int AS failed,
              count(*) FILTER (WHERE m.status IN ('pending','copying','verifying'))::int AS in_progress,
              count(*) FILTER (WHERE m.accepted_rules IS NOT NULL AND m.confirmation = 'agent_relayed' AND m.status = 'done' AND m.finished_at > now() - make_interval(hours => $2))::int AS agent_relayed,
              count(*) FILTER (WHERE ${DESPITE_MOVE_SQL} AND m.status = 'done' AND m.finished_at > now() - make_interval(hours => $2))::int AS human_workplace,
              count(*) FILTER (WHERE m.status = 'failed' AND ${REFUSED} AND m.finished_at > now() - make_interval(hours => $2))::int AS by_word_refused
       FROM class_moves m JOIN people p ON p.id = m.requested_by AND p.instance_id = $1`, [app.instanceId, hours])).rows[0];
    const reconcile = (await ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'class_reconcile'", [app.instanceId])).rows[0]?.value ?? {};
    const projectTags = (await ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'project_tags'", [app.instanceId])).rows[0]?.value ?? null;
    const testLeftovers = (await ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'test_leftovers'", [app.instanceId])).rows[0]?.value ?? null;
    const { promotions, returns } = await movesReport(app, hours);
    const includeTest = c.req.query("include_test") === "true", current = c.req.query("current") === "true" && testHooksEnabled();
    const section = async <T,>(name: string, f: () => Promise<T>): Promise<T | null> => {
      try { return await f(); } catch (e) { log.warn("report_section_failed", { section: name, error: (e as Error).name }); return null; }
    };
    const search_quality = await section("search_quality", () => searchQualitySummary(app, includeTest, current));
    const rollout = await section("rollout", () => rolloutReport(app, includeTest, current));
    const manualTime = await manualTimeSection(app, c.req.query(MANUAL_TIME_PARAM), section);
    const dismissed = await dismissedReport(app, c.get("caller").principalType === "system");
    const night_cap = await section("night_cap", () => nightCapReport(app));
    return c.json({ window_hours: hours, search_quality, rollout, night_cap, backups: await section("backups", () => backupsReport(app)), ...manualTime, generated_at: new Date().toISOString(), by_type: by, promotions, returns, project_tags: projectTags, test_leftovers: testLeftovers, test_purge: await testPurgeReport(app),
                    class_moves: { failed: mv.failed, in_progress: mv.in_progress, reconcile,
                                   by_word: { agent_relayed: mv.agent_relayed, human_workplace: mv.human_workplace, refused: mv.by_word_refused,
                                              despite: await despiteReport(app, hours) } },
                    obo: { denials, paused_keys: paused.map((k) => ({ id: k.id, key_prefix: k.key_prefix, principal: k.principal, paused_until: iso(k.paused_until) })),
                           unbound_obo_keys: unbound.map((k) => ({ id: k.id, key_prefix: k.key_prefix, service: k.service, last_used_ip: k.last_used_ip, last_used_at: iso(k.last_used_at) })),
                           ...(await legacyKeyCounts(app)) }, processed_share: total.accepted ? Number((total.processed / total.accepted).toFixed(3)) : null,
                    verifier: { ...verifier, quote_verified_share: verifier.input ? Number(((verifier.exact + verifier.fuzzy) / verifier.input).toFixed(3)) : null }, durations,
                    open_check: await openCheckStats(hours, 50), ...(await spacesReport(hours)), client_mismatch: await clientMismatchReport(hours),
                    extended_open: await extendedOpenReport(app, hours),
                    org_review: await orgReviewReport(app, hours),
                    wide_grants_24h: { count: wide.length, items: wide.map((g) => ({ id: g.id, role: g.role, person: g.person, scope_kind: g.scope_kind, created_at: new Date(g.created_at).toISOString() })) },
                    dismissed });
  });


  r.get("/search-quality", async (c) => {
    const w = c.req.query("weeks") ?? "12";
    if (!["4", "12", "26"].includes(w)) throw invalid("weeks: 4, 12 or 26");
    return c.json(await searchQuality(app, { weeks: Number(w), includeTest: c.req.query("include_test") === "true", current: c.req.query("current") === "true" && testHooksEnabled(),
                                             texts: emptyQueryTextsAllowed(c.get("caller"), app.settings) }));
  });

  r.post("/maintenance/search-outcomes", async (c) => {
    const body = testHooksEnabled() ? await c.req.json().catch(() => ({})) : {};
    const data: { settle_sec?: number; since?: string; current_week?: boolean } = {};
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (b.settle_sec !== undefined) {
        if (!Number.isInteger(b.settle_sec) || (b.settle_sec as number) < 0 || (b.settle_sec as number) > 900) throw invalid("settle_sec: an integer from 0–900");
        data.settle_sec = b.settle_sec as number;
      }
      if (b.since !== undefined) {
        if (typeof b.since !== "string" || Number.isNaN(Date.parse(b.since))) throw invalid("since: ISO 8601 date and time");
        data.since = new Date(b.since).toISOString();
      }
      if (b.current_week === true) data.current_week = true;
    }
    const running = await outcomesRunning(app).catch(() => false);
    const queued = await app.queue.wake("search_outcomes", data);
    await adminAudit(c, "search_outcomes_now", { queued, ...(running ? { running: true } : {}), ...(Object.keys(data).length ? { hook: true } : {}) });
    return c.json({ queued, running }, 202);
  });

  r.get("/internal/search-outcomes/:id", async (c) => {
    const row = await outcomeRow(app, uuidParam(c));
    if (!row) throw notFound();
    return c.json(row);
  });

  r.get("/internal/closed-access", (c) => c.json({ reads: app.db.closedAcquired, writes: app.db.closedWrites, by_key_kind: app.db.closedByKeyKind }));

  r.post("/internal/links", async (c) => {
    try { return c.json(await createLinkTestHook(app, c.get("caller"), await c.req.json().catch(() => null)), 201); }
    catch (e) {
      await adminAudit(c, "link_test_create", { result: "denied", code: e instanceof MemoryError ? e.code : "internal" });
      throw e;
    }
  });
  r.get("/internal/link-copies/:id", async (c) => c.json(await linkCopies(app, uuidParam(c))));

  r.get("/internal/record-copies/:id", async (c) => {
    const id = uuidParam(c);
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    const loc = (await ctl.query("SELECT class, deleted, open_check FROM record_locations WHERE record_id = $1", [id])).rows[0] ?? null;
    const copies: Record<string, { rows: number; hidden: number; deleted: number; event_key: string | null }> = {};
    for (const k of ["open", "closed"] as const)
      copies[k] = (await app.db.records(k, sys).query(
        `SELECT count(*)::int AS rows, count(*) FILTER (WHERE (to_jsonb(r) ->> 'hidden_at') IS NOT NULL)::int AS hidden, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted,
                (array_agg(event_key) FILTER (WHERE event_key IS NOT NULL))[1] AS event_key
         FROM records r WHERE id = $1`, [id])).rows[0];
    const moves = (await ctl.query("SELECT id, status, error, from_class, to_class, via, accepted_rules, confirmation, requested_at, finished_at FROM class_moves WHERE record_id = $1 ORDER BY requested_at", [id])).rows;
    const tombstones: Record<string, string | null> = {};
    for (const k of ["open", "closed"] as const)
      tombstones[k] = (await app.db.records(k, sys).query("SELECT reason FROM record_tombstones WHERE id = $1", [id])).rows[0]?.reason ?? null;
    let originalKey: string | null = null;
    for (const k of ["open", "closed"] as const)
      originalKey ??= (await app.db.records(k, sys).query("SELECT original_key FROM record_content WHERE record_id = $1", [id])).rows[0]?.original_key ?? null;
    const originals: Record<string, boolean | null> = { open: null, closed: null };
    if (originalKey) for (const k of ["open", "closed"] as const) originals[k] = await app.storage.has(k, originalKey);
    const linkInfo = linksTestHookOn(app) ? { links: (await ctl.query(
      "SELECT id FROM record_links WHERE src_id = $1 OR dst_id = $1 ORDER BY id", [id])).rows.map(r => r.id as string) } : {};
    return c.json({ locator: loc, copies, moves, tombstones, originals, ...linkInfo });
  });

  const MOVE_STATUSES = ["pending", "copying", "verifying", "done", "failed"];
  const moveRow = (m: any) => ({ id: m.id, record_id: m.record_id, status: m.status, error: m.error, from_class: m.from_class, to_class: m.to_class, via: m.via ?? "person",
                                 accepted_rules: m.accepted_rules ?? null, confirmation: m.confirmation ?? null,
                                 text_only: m.text_only === true, accepted_scope: m.accepted_scope ?? null,
                                 requested_at: new Date(m.requested_at).toISOString(), finished_at: m.finished_at ? new Date(m.finished_at).toISOString() : null });
  r.get("/class-moves", async (c) => {
    const { limit, offset } = page(c);
    const st = parseEventTypes(c.req.query("status"));
    if (st?.some((x) => !MOVE_STATUSES.includes(x))) throw invalid(`status: ${MOVE_STATUSES.join(" | ")} (separate multiple values with commas)`);
    const latest = c.req.query("latest");
    if (latest !== undefined && latest !== "" && latest !== "true" && latest !== "false") throw invalid("latest: true or false");
    const from = latest === "true"
      ? `(SELECT DISTINCT ON (m0.record_id) m0.* FROM class_moves m0 JOIN people p0 ON p0.id = m0.requested_by AND p0.instance_id = $1
           ORDER BY m0.record_id, m0.requested_at DESC, m0.id DESC) m`
      : "class_moves m";
    const { rows } = await ctl.query(
      `SELECT m.*, count(*) OVER ()::int AS total FROM ${from} JOIN people p ON p.id = m.requested_by AND p.instance_id = $1
       WHERE ($2::text[] IS NULL OR m.status = ANY($2)) ORDER BY m.requested_at DESC, m.id LIMIT $3 OFFSET $4`, [app.instanceId, st, limit + 1, offset]);
    return c.json({ items: rows.slice(0, limit).map(moveRow), next_cursor: rows.length > limit ? String(offset + limit) : null, total: rows[0]?.total ?? (offset ? null : 0) });
  });
  r.post("/class-moves/:id/retry", async (c) => {
    const id = uuidParam(c);
    const mv = (await ctl.query("SELECT m.* FROM class_moves m JOIN people p ON p.id = m.requested_by AND p.instance_id = $2 WHERE m.id = $1", [id, app.instanceId])).rows[0];
    if (!mv) throw notFound();
    const last = (await ctl.query("SELECT id, status FROM class_moves WHERE record_id = $1 ORDER BY requested_at DESC LIMIT 1", [mv.record_id])).rows[0];
    if (last.id !== mv.id) throw new MemoryError("in_progress", "The record already has a newer move. This move does not need a retry", { retry_after: 5, details: { move_id: last.id, status: last.status } });
    if (mv.status !== "failed") throw invalid(`You can retry only a failed move. This move is ${mv.status}`);
    if (String(mv.error ?? "").startsWith("never_open:")) throw invalid("The “never open” rule prevents opening the record. Retrying will give the same result");
    if (String(mv.error ?? "").startsWith("record_deleted")) throw invalid("The record was deleted. There is nothing to move");
    if (String(mv.error ?? "").startsWith("parent_other_class")) throw invalid("This record is part of another record and moves with it. Move the source record");
    if (mv.confirmation === "agent_relayed") throw invalid("An administrator cannot retry a move confirmed by a person through an agent. The person must confirm again with memory_open or select “Make available to agents” in the workspace");
    if (mv.confirmation === "human_workplace" && (mv.accepted_rules || mv.text_only === true)
        && (!mv.accepted_print || /^(open_check|never_open:)/.test(String(mv.error ?? ""))))
      throw invalid("Only the author can retry showing a record despite a finding. The author must consent again in the workspace", { reason: "consent_needed" });
    if (mv.from_class === "closed" && mv.to_class === "open") {
      const ap = await approval(c, "closed_to_open", () => `Retry opening the record (move ${id})`, mv.record_id);
      if (ap) return ap;
    }
    const moveId = newId();
    await ctl.query(`INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via, accepted_rules, confirmation, accepted_print, accepted_aud, accepted_space_id, accepted_scope, text_only)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                    [moveId, mv.record_id, mv.from_class, mv.to_class, mv.requested_by, mv.via ?? "person", mv.accepted_rules ?? null, mv.confirmation ?? null,
                     mv.accepted_print ?? null, mv.accepted_aud ?? null, mv.accepted_space_id ?? null, mv.accepted_scope ?? null, mv.text_only === true]);
    await app.queue.kick({ instance: app.instanceId, class: mv.from_class, record_id: mv.record_id, lane: "now" });
    await adminAudit(c, "class_move_retry", { move_id: id, new_move_id: moveId, record_id: mv.record_id });
    return c.json({ move_id: moveId, record_id: mv.record_id }, 202);
  });
  r.post("/maintenance/reconcile", async (c) => {
    const queued = await app.queue.wake("reconcile");
    await adminAudit(c, "reconcile_now", { queued });
    return c.json({ queued }, 202);
  });

  registerLdapAdmin(r, app, adminAudit, (c) => remoteAddr(c));
  registerLocalAccountsAdmin(r, app, adminAudit);
  registerLocalAccountsManage(r, app, adminAudit);
  registerOidcAdmin(r, app, adminAudit);
  registerEdgeAdmin(r, app, adminAudit);
  registerMailAdmin(r, app, adminAudit);
  registerStatusAdmin(r, app);
  // "Agent sign-in": mode and readiness of the built-in sign-in, the registry, DCR clients page by page;
  // revocation of a DCR client
  registerAgentAuthAdmin(r, app, adminAudit);
  registerLlmGateRoutes(r, app, adminAudit);
  registerModelsAdmin(r, app, adminAudit);
  registerConverterAdmin(r, app, adminAudit, resetHealthCache);
  registerDeletionAdmin(r, app, adminAudit);
  registerOrgReviewAdmin(r, app, adminAudit);
  registerDespiteAdmin(r, app, adminAudit);
  registerOpenRecheckAdmin(r, app, adminAudit);
  registerEdgeExportAdmin(r, app, adminAudit);
  registerOperatorAdmin(r, app, adminAudit);
  registerConnectorsAdmin(r, app, adminAudit);                  // connectors: kinds, connectors, secrets, runs and item states

  r.post("/integrations/converter/check", async (c) => {
    await app.settings.load(true);
    const url = app.settings.str("integrations.converter_url");
    if (!url) throw invalid("The document converter is not configured. Set integrations.converter_url");
    const started = Date.now();
    const cfg = converterConfig(app.settings);
    let body: { ok: boolean; url: string; user?: string; roles?: string[]; missing_roles?: string[]; latency_ms?: number; error?: string };
    if (!cfg) {
      body = { ok: false, url, error: `settings missing: ${converterMissing(app.settings).join(", ")}` };
    } else {
      try {
        const client = new ConverterClient({ ...cfg, requestTimeoutMs: Math.min(cfg.requestTimeoutMs, 10_000) });
        await client.login();
        const who = await client.whoami();
        const missing = ConverterClient.missingRoles(who);
        body = { ok: missing.length === 0, url, user: who?.username ?? undefined, roles: who?.roles ?? [], ...(missing.length ? { missing_roles: missing } : {}), latency_ms: Date.now() - started };
      } catch (e) {
        const kind = e instanceof ConverterError ? e.kind : "http";
        body = { ok: false, url, latency_ms: Date.now() - started, error: `${kind}: ${(e as Error).message}`.slice(0, 300) };
      }
    }
    await adminAudit(c, "converter_check", { ok: body.ok, url, roles: body.roles ?? null, missing_roles: body.missing_roles ?? null, latency_ms: body.latency_ms ?? null, error: body.error ?? null });
    return c.json(body);
  });

  r.get("/settings", async (c) => { await app.settings.load(true); return c.json({ items: annotateSettings(app.settings.listMasked(), app), missing_required: app.settings.missingRequired(), undecryptable: app.settings.undecryptable() }); });
  r.put("/settings", async (c) => {
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
    const items: Array<{ category: Category; key: string; value?: unknown; confirm_clear?: unknown }> = Array.isArray(b?.items) ? b.items : [b];
    for (const it of items) {
      if (!it || typeof it.category !== "string" || typeof it.key !== "string") throw invalid("Setting object: category, key, value");
      if (!Object.hasOwn(it, "value")) throw invalid(`${it.category}.${it.key}: value is required (use null to explicitly clear it)`);
      const path = `${it.category}.${it.key}`;
      if (it.value === null && SETTINGS_RESET_TO_DEFAULT.has(path)) {
        const value = app.settings.meta("admin.sso_login_enabled").defaultValue;
        if (typeof value !== "boolean") throw invalid(`${path}: the registry default must be a boolean`);
        it.value = value;
      }
    }
    const dup = [...new Set(items.map((i) => `${i.category}.${i.key}`).filter((k, n, all) => all.indexOf(k) !== n))];
    if (dup.length) throw invalid(`The batch contains a duplicate setting ${dup.join(", ")}. Nothing was saved`);
    const changes = items.map((it) => ({ category: it.category, key: it.key, value: it.value ?? null }));
    const checkedMode = effectiveMode(app.settings);
    const g = await checkSettings(c, changes, app);
    if (g.ok === "approval") return g.response;
    if (g.ok === false) return c.json({ code: g.code, message: g.message, details: g.details ?? { keys: g.keys } }, g.status);
    let savedAudit: (() => Promise<void>) | undefined;
    const save = async (q: pg.PoolClient, settings: Settings) => {
      const txMode = await securityModeInTx(app, q);
      if (checkedMode === "basic" && txMode === "advanced" && !g.approvalId) return c.json(SECURITY_MODE_CHANGED, 409);
      await settings.load(true);
      const ldapItems = items.filter((i) => i.category === "ldap");
      if (ldapItems.length) {
        const next = new Map(ldapItems.map((i) => [`ldap.${i.key}`, i.value ?? null]));
        const after = ldapConfig({ get: <T,>(path: string, def: T): T => (next.has(path) ? ((next.get(path) ?? def) as T) : settings.get<T>(path, def)) });
        const problems = ldapProblems(after);
        const before = ldapConfig(settings);
        if (before.bind_password && !next.has("ldap.bind_password") && anchorMoved(LDAP_ANCHORS, before, after)) problems.push({ key: "bind_password", message: LDAP_SECRET_REENTRY });
        if (problems.length) throw invalid(`“Sign-in and LDAP” settings were not saved: ${problems.map((x) => `${x.key} — ${x.message}`).join("; ")}`, { problems });
      }
      const oidcItems = items.filter((i) => i.category === "oidc");
      const oidcBefore = oidcConfig(settings);
      let oidcAfter: OidcConfig | null = null;
      if (oidcItems.length) {
        const next = new Map(oidcItems.map((i) => [`oidc.${i.key}`, i.value ?? null]));
        oidcAfter = oidcConfig({ get: <T,>(path: string, def: T): T => (next.has(path) ? ((next.get(path) ?? def) as T) : settings.get<T>(path, def)) });
        const problems = oidcProblems(oidcAfter);
        const anchorMoved = oidcDiscoveryUrl(oidcAfter.issuer) !== oidcDiscoveryUrl(oidcBefore.issuer) || oidcAfter.client_id !== oidcBefore.client_id
          || pemText(oidcAfter.ca_cert) !== pemText(oidcBefore.ca_cert);
        if (anchorMoved && oidcBefore.client_secret && !next.has("oidc.client_secret")) problems.push({ key: "client_secret", message: OIDC_SECRET_REENTRY });
        if (problems.length) throw invalid(`“Single sign-on (OpenID Connect)” settings were not saved: ${problems.map((x) => `${x.key} — ${x.message}`).join("; ")}`, { problems });
      }
      const oauthItems = items.filter((i) => i.category === "oauth");
      const oauthNext = new Map(oauthItems.map((i) => [`oauth.${i.key}`, i.value ?? null]));
      const nextOAuth = oauthConfig({ get: <T,>(path: string, def: T): T => oauthNext.has(path) ? (oauthNext.get(path) ?? def) as T : settings.get<T>(path, def) });
      if (oauthItems.length) {
        const problems = oauthProblems(nextOAuth);
        if (problems.length) throw invalid(`“Agent OAuth” settings were not saved: ${problems.map((x) => `${x.key} — ${x.message}`).join("; ")}`, { problems });
      }
      const smtpItems = items.filter((i) => i.category === "smtp");
      if (smtpItems.length) {
        const next = new Map(smtpItems.map((i) => [`smtp.${i.key}`, i.value ?? null]));
        const after = smtpConfig({ get: <T,>(path: string, def: T): T => (next.has(path) ? ((next.get(path) ?? def) as T) : settings.get<T>(path, def)) });
        const problems = smtpProblems(after);
        const before = smtpConfig(settings);
        if (before.password && !next.has("smtp.password") && anchorMoved(SMTP_ANCHORS, before, after)) problems.push({ key: "password", message: SMTP_SECRET_REENTRY });
        if (problems.length) throw invalid(`“Mail (SMTP)” settings were not saved: ${problems.map((x) => `${x.key} — ${x.message}`).join("; ")}`, { problems });
      }
      const ocItems = items.filter((i) => i.category === "open_check");
      const ocProblems = ocItems.flatMap((i) => openCheckSettingProblems(i.key, i.value ?? null).map((m) => `open_check.${i.key}: ${m}`));
      if (ocProblems.length) throw invalid(`“Open check” settings were not saved: ${ocProblems.join("; ")}`);
      const embValues = items.filter((i) => i.category === "retrieval" && i.key === "embeddings_model").map((i) => i.value ?? null);
      if (embValues.length) {
        const problem = await embeddingsModelProblem(app, settings.str("retrieval.embeddings_model"), embValues, q);
        if (problem) throw invalid(`${problem}: nothing was saved`, { problems: [{ key: "retrieval.embeddings_model", message: problem }] });
      }
      // the connection of the current search model is frozen while it has vectors: another model goes
      // into the next-model connection and gets vectors of its own; a new key or a moved server is still accepted
      const slotItems = items.filter((i) => i.category === "models" && embeddingsConnectionField(`models.${i.key}`) !== null);
      if (slotItems.length) {
        const problem = await embeddingsSlotProblem(app, settings, slotItems, q);
        if (problem) throw invalid(`${problem.message} Nothing was saved.`, { problems: [problem] });
      }
      const known = new Set(settings.listMasked().map((x) => `${x.category}.${x.key}`));
      const unknown = items.filter((i) => !known.has(`${i.category}.${i.key}`)).map((i) => `${i.category}.${i.key}`);
      if (unknown.length) throw invalid(`Unknown setting ${unknown.join(", ")}. Nothing was saved`);
      for (const it of items) {
        try { settings.validate(it.category, it.key, it.value ?? null, oauthItems.length ? nextOAuth : undefined); }
        catch (e) { if (e instanceof SettingsTypeError) throw invalid(`${e.message}: nothing was saved`); throw e; }
      }
      const clearedRequired = requiredClears(settings, items);
      const unconfirmed = clearedRequired.filter((p) => items.find((i) => `${i.category}.${i.key}` === p)?.confirm_clear !== true);
      if (unconfirmed.length) throw invalid(`${unconfirmed.join(", ")} is required. Clearing it makes memory unavailable to all employees and their agents. To clear it, pass confirm_clear: true. Nothing was saved`,
                                            { problems: unconfirmed.map((key) => ({ key, message: "required setting: pass confirm_clear: true to clear it" })) });
      await settings.assertBatch(items, { db: q, instanceId: app.instanceId });
      const contour = await contourCheck(c, app, changes, { settings, q, mode: txMode });
      if (contour && contour.ok === false) return c.json({ code: contour.code, message: contour.message, details: contour.details ?? { keys: contour.keys } }, contour.status);
      const cloudItems = items.filter((i) => `${i.category}.${i.key}` === CLOUD_AGENT_BASE_SETTING);
      const cloudItem = cloudItems[cloudItems.length - 1];
      // built-in agent sign-in: agent_auth.* and the addresses it is built from — judged on the future state.
      // An unready builtin cannot be enabled (addresses not HTTPS, no apps, no [AS] tables, no routes); external and off can.
      // The cloud agents' address is compared with oauth.resource_url only while the external identity provider signs agents in (external)
      const agentFuture = agentAuthStepNeeded(items.map((i) => `${i.category}.${i.key}`)) ? futureSettings(settings, items) : null;
      if (agentFuture && agentAuthMode(agentFuture) === "builtin") {
        const problems = agentAuthProblems(agentFuture, await agentAuthFacts(app, q));
        if (problems.length) throw invalid(`Settings were not saved because built-in agent sign-in is not ready: ${problems.map((p) => `${p}: ${AGENT_AUTH_PROBLEM_TEXT[p]}`).join(" ")}`.slice(0, 900),
                                           { problems: problems.map((p) => ({ key: "agent_auth.mode", code: p, message: AGENT_AUTH_PROBLEM_TEXT[p] })) });
      }
      if ((oauthItems.length || cloudItem) && agentAuthMode(agentFuture ?? settings) === "external") {
        const mismatch = cloudOAuthMismatch(cloudItem ? cloudItem.value ?? "" : settings.get<unknown>(CLOUD_AGENT_BASE_SETTING, ""), nextOAuth);
        if (mismatch) throw invalid(`Settings were not saved: ${mismatch}`, { problems: [{ key: "resource_url", message: mismatch }] });
      }
      if (txMode === "basic") notePreMail(changes, await transportPreMail(app, settings, changes, actorOf(c)));
      const keycloakRevoked = oauthItems.some((i) => ["issuer", "resource_url", "allowed_clients"].includes(i.key)) ? await revokeOAuthOutsidePolicy(app, nextOAuth, q) : 0;
      // the common step of built-in sign-in — before the write, under the exclusive policy lock (locks below): a mode change
      // revokes the connections of the former mode, the builtin policy those it no longer allows; transactions and codes go
      const agentStep = agentFuture ? await applyAgentAuthPolicy(app, q, agentFuture, { before: settings, reason: "settings" }) : null;
      const oauthRevoked = keycloakRevoked + (agentStep ? agentStep.keycloak + agentStep.builtin : 0);
      const ssoIndex = items.findIndex((it) => it.category === "admin" && it.key === "sso_login_enabled");
      const ssoBefore = ssoIndex < 0 ? undefined : await rememberSsoLoginState(q, app.instanceId, undefined, ssoLoginDefault(app));
      const before = items.map((it) => settings.get<unknown>(`${it.category}.${it.key}`, null));
      if (ssoBefore) before[ssoIndex] = ssoBefore.enabled;
      const updatedBy = (c.get("caller") as Caller | undefined)?.admin?.personId ?? null;
      try { await settings.setMany(changes, { updatedBy, approvalId: g.approvalId ?? null, futureOAuth: oauthItems.length ? nextOAuth : undefined }); }
      catch (e) { if (e instanceof SettingsTypeError) throw invalid(e.message); throw e; }
      const changeEvents = items.map((it, n) => settingAuditDetails(app, `${it.category}.${it.key}`, before[n], it.value ?? null,
        { secret: settings.meta(`${it.category}.${it.key}`).secret, wouldRequireApproval: g.wouldRequireApproval === true }));
      const ssoChange: SsoChange | undefined = ssoIndex < 0 ? undefined : { id: newId(), before: before[ssoIndex], after: settings.get<unknown>("admin.sso_login_enabled", false), who: actorOf(c) };
      if (ssoChange) ssoChange.state = await rememberSsoLoginState(q, app.instanceId, ssoChange, ssoLoginDefault(app));
      const sessionApp = { ...app, db: { ...app.db, control: q } } as unknown as App;
      const urls = items.filter((i) => /_url$/.test(i.key)).map((i) => ({ key: `${i.category}.${i.key}`, value: String(i.value ?? "").slice(0, 200) }));
      const ldapTargets = ldapItems.filter((i) => ["servers", "port", "tls_mode", "tls_server_name", "insecure_ack"].includes(i.key)).map((i) => ({ key: `ldap.${i.key}`, value: JSON.stringify(i.value ?? null).slice(0, 300) }));
      const { ldap: ended, oidc: oidcEnded } = await endIdentitySessions(sessionApp, items);
      const oidcTargets: Array<Record<string, unknown>> = oidcItems.filter((i) => OIDC_AUDIT_KEYS.has(i.key)).map((i) => ({ key: `oidc.${i.key}`, value: JSON.stringify(i.value ?? null).slice(0, 300) }));
      for (const i of oidcItems) if (i.key === "ca_cert") oidcTargets.push({ key: "oidc.ca_cert", certificates: caCertificates(i.value) });
      const oidcSwitch = oidcAfter && oidcAfter.enabled !== oidcBefore.enabled ? { op: oidcAfter.enabled ? "oidc_enabled" : "oidc_disabled", issuer: oidcAfter.issuer.slice(0, 300), client_id: oidcAfter.client_id.slice(0, 255) } : null;
      const smtpTargets = smtpItems.filter((i) => ["host", "port", "security", "insecure_ack", "username", "from_address", "enabled"].includes(i.key)).map((i) => ({ key: `smtp.${i.key}`, value: JSON.stringify(i.value ?? null).slice(0, 300) }));
      const ocTargets = ocItems.filter((i) => ["enabled", "disabled_rules", "packs", "timeout_sec"].includes(i.key)).map((i) => ({ key: `open_check.${i.key}`, value: JSON.stringify(i.value ?? null).slice(0, 300) }));
      savedAudit = async () => {
        await adminAudit(c, "settings_update", { ...(oauthRevoked ? { oauth_connections_revoked: oauthRevoked } : {}), keys: items.map((i) => `${i.category}.${i.key}`), ...(clearedRequired.length ? { cleared_required: clearedRequired } : {}), ...(urls.length ? { urls } : {}), ...(ldapTargets.length ? { ldap_targets: ldapTargets } : {}),
                                                 ...(oidcTargets.length ? { oidc_targets: oidcTargets } : {}), ...(smtpTargets.length ? { smtp_targets: smtpTargets } : {}), ...(ocTargets.length ? { open_check_targets: ocTargets } : {}), ...(ended ? { ldap_sessions_ended: ended } : {}), ...(oidcEnded ? { oidc_sessions_ended: oidcEnded } : {}) });
        if (oidcSwitch) { const { op, ...details } = oidcSwitch; await adminAudit(c, op, details); }
        for (const ev of changeEvents) { const { op, ...details } = ev;
          if (ssoChange && details.key === "admin.sso_login_enabled") await audit(app, c.get("caller"), { id: ssoChange.id, event_type: "admin", details: { op, ...details } });
          else await adminAudit(c, String(op), details);
        }
        await settingsSaved(app, changes, actorOf(c), ssoChange);
      };
      return c.json({ updated: items.length, missing_required: settings.missingRequired(), ...(ended ? { ldap_sessions_ended: ended } : {}), ...(oidcEnded ? { oidc_sessions_ended: oidcEnded } : {}), ...(oauthRevoked ? { oauth_connections_revoked: oauthRevoked } : {}) });
    };
    const locks = [...(items.some((i) => i.category === "oauth" || `${i.category}.${i.key}` === CLOUD_AGENT_BASE_SETTING) || agentAuthStepNeeded(items.map((i) => `${i.category}.${i.key}`)) ? [oauthPolicyLock(app)] : []),
                   ...(items.some((i) => i.category === "ldap" || i.category === "oidc") ? [loginPolicyLock(app)] : []), externalContourLock(app)];
    const response = await withSettingsTx(app, locks, save);
    settingsWriteSettled(items);
    await llmSettingsSaved(app, items).catch((e) => log.warn("llm_settings_reaction_failed", { error: (e as Error).message.slice(0, 160) }));
    if (savedAudit) await savedAudit();
    return response;
  });

  return r;
}

export async function embeddingsModelProblem(app: Pick<App, "db" | "instanceId">, current: string | null, next: unknown | unknown[],
                                             control: Pick<pg.PoolClient, "query"> = app.db.control): Promise<string | null> {
  const nexts = Array.isArray(next) ? next : [next];
  for (const v of nexts) { const p = embeddingsModelValueProblem(v); if (p) return p; }
  // a candidate or retained row of an earlier version (profile NULL) is served with this same setting; while it
  // keeps vectors of its remembered model, another value would put vectors of two models under its id
  // a kept row without a remembered model (its vectors predate the remembering, or came from the backfill) is
  // held too while it has vectors: they are of the model the setting names now (the only one it was ever served with)
  const kept = (await control.query(
    `SELECT e.id, m.value ->> 'model' AS model FROM embedders e LEFT JOIN maintenance_state m ON m.instance_id = $1 AND m.key = 'embedder_alias:' || e.id
      WHERE e.profile IS NULL AND e.closed_at IS NULL AND NOT e.active ORDER BY e.id`, [app.instanceId])).rows as { id: string; model: string | null }[];
  for (const k of kept) {
    let model = k.model;
    if (!model && current) {
      const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
      for (const cls of ["open", "closed"] as const)
        if ((await app.db.records(cls, sys).query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [k.id])).rows[0]?.ok === true) { model = current; break; }
    }
    if (model && nexts.some((v) => v !== model))
      return `retrieval.embeddings_model: the kept embedder ${k.id} holds vectors of ${model}; only ${model} can be saved until that embedder is closed`;
  }
  const activeRow = (await control.query("SELECT id, connection_slot FROM embedders WHERE active")).rows[0] as { id: string; connection_slot: "a" | "b" | null } | undefined;
  const active = activeRow?.id;
  if (!active) return null;
  const row = (await control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, `embedder_alias:${active}`])).rows[0];
  const remembered = typeof row?.value?.model === "string" ? row.value.model as string : null;
  const allowed = remembered ?? current;
  if (!allowed || nexts.every((v) => v === allowed)) return null;
  let hasVectors = remembered !== null;
  if (!hasVectors) {
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    for (const cls of ["open", "closed"] as const)
      hasVectors ||= (await app.db.records(cls, sys).query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [active])).rows[0]?.ok === true;
  }
  for (const v of nexts) { const p = embeddingsModelChangeProblem({ next: v, current, remembered, hasVectors, embedder: active, activeSlot: activeRow?.connection_slot ?? null }); if (p) return p; }
  return null;
}

/**
 * May this settings save change the embeddings connections? The rule is embeddingsSlotChangeProblem
 * (shared); here — the active row, the settings after the save and whether the active row has vectors in either records
 * database (asked only when the save would otherwise be refused). control — the connection of the save transaction.
 */
export async function embeddingsSlotProblem(app: Pick<App, "db">, settings: Pick<Settings, "get" | "str">, items: ReadonlyArray<{ key: string; value?: unknown }>,
                                            control: Pick<pg.PoolClient, "query"> = app.db.control): Promise<{ key: string; message: string } | null> {
  const active = (await control.query("SELECT id, dims, profile, connection_slot, query_instruction, max_tokens FROM embedders WHERE active")).rows[0] ?? null;
  if (!active) return null;
  const next = new Map<string, unknown>(items.map((i) => [`models.${i.key}`, i.value ?? null]));
  const after = {
    get: <T,>(path: string, fallback: T): T => (next.has(path) ? ((next.get(path) ?? fallback) as T) : settings.get<T>(path, fallback)),
    str: (path: string): string | null => { if (!next.has(path)) return settings.str(path); const v = next.get(path); return typeof v === "string" ? v : null; },
  };
  const problem = embeddingsSlotChangeProblem({ active, hasVectors: true, before: settings, after });
  if (!problem) return null;
  const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
  for (const cls of ["open", "closed"] as const)
    if ((await app.db.records(cls, sys).query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [active.id])).rows[0]?.ok === true) return problem;
  return null;
}

export { EMBEDDINGS_MODEL_SWITCH_DENIED as EMBEDDER_SWITCH_DENIED } from "@memory/shared";

const remoteAddr = (c: Context): string => { try { return (getConnInfo(c).remote.address ?? "?").replace(/^::ffff:/, ""); } catch { return "?"; } };

const AUTH_BODY_MAX = 64 * 1024;
export const ADMIN_LOGIN_MAX = 200, ADMIN_PASSWORD_MAX = 1024;
const CREDENTIALS_TOO_LONG = `The login can be up to ${ADMIN_LOGIN_MAX} characters and the password up to ${ADMIN_PASSWORD_MAX}`;
const credentialsTooLong = (login: unknown, password: unknown): boolean =>
  (typeof login === "string" && login.length > ADMIN_LOGIN_MAX) || (typeof password === "string" && password.length > ADMIN_PASSWORD_MAX);

/**
 * One-time install code: only someone with access to the server can create the first
 * administrator, and the "whoever opens the panel first" window stays closed even after the admin_users row is deleted.
 * Which code a client must present — first-run-code.ts: the supplied code (MEMORY_FIRST_RUN_CODE set by the deployment, or the
 * file `first-run-code` written by setup) in every profile; otherwise a generated one in `internet` and `internal-http`;
 * in `development` no code only for a request without any forwarding sign from a loopback, private or unknown socket (the
 * developer installation's bootstrap and a browser straight to the gateway); behind any proxy, the panel included, the code.
 */
const firstRunCodeFor = (ip: string, signs: readonly string[]): RequiredFirstRunCode => requiredFirstRunCode(ip, signs);

/** Refusal text of a wrong code: the environment-supplied path (the VM) keeps its text byte for byte; file and generated — English. */
const FIRST_RUN_CODE_ENV_HINT = "Enter the correct installation code. It is stored on the server in ~/memory/.env (the MEMORY_FIRST_RUN_CODE line)";
const firstRunCodeHint = (source: RequiredFirstRunCode["source"]): string =>
  source === "file" || source === "generated" ? firstRunCodeRefusal(source) : FIRST_RUN_CODE_ENV_HINT;

/**
 * At the start of the gateway (index.ts): in `internet` and `internal-http` without a supplied code, the generated code
 * is printed once while no administrator exists. The database did not answer — printed anyway: the operator needs it more
 * than the log needs one line less.
 */
export async function announceFirstRunCode(app: App): Promise<void> {
  let open = true;
  try { const st = await firstRunState(app.db.control, app.instanceId); open = !st.adminUsers && !st.memoryAdmin; }
  catch { /* unknown state: treat the first-run as open */ }
  announceGeneratedFirstRunCode(open);
}

function firstRunCodeOk(given: unknown, want: string): boolean {
  const h = (x: string) => createHash("sha256").update(x, "utf8").digest();
  return typeof given === "string" && timingSafeEqual(h(given.trim()), h(want));
}

export const firstRunFailures = new LoginFailures();

async function firstRunClient(app: App, c: Context): Promise<{ ip: string; via: string | null; signs: string[] }> {
  // the forwarding signs of the request, by header name, whoever sent them (re-): in `development` any
  // sign asks for the code — a header may only add the requirement, never remove it
  const signs = forwardingSigns(Object.keys(c.req.header()));
  if (currentListener()?.kind === "admin") return { ip: (await adminClientIp(app, c)) ?? "?", via: null, signs };
  const sock = remoteAddr(c);
  const hinted = !!(c.req.header("x-memory-client-peer") || c.req.header("x-memory-client-ip"));
  if (!hinted || sock === "?" || !(await fromWorkplace(app, sock).catch(() => false))) return { ip: sock, via: null, signs };
  return { ip: (await workplaceClientAddress(app, (n) => c.req.header(n), sock)) ?? sock, via: sock, signs };
}

export function firstRunRoutes(app: App): Hono {
  const r = new Hono();
  const small = bodyLimit({ maxSize: AUTH_BODY_MAX, onError: (c) => c.json({ code: "too_large", message: "The request body exceeds the size limit" }, 413) });
  r.use("/api/v1/first-run", small);
  r.use("/api/v1/admin-login", small);
  r.use("/api/v1/admin-auth/totp/reset", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  r.use("/api/v1/admin-auth/totp/reset", small);
  setLocalTotpSetupAvailable(true);
  r.get("/api/v1/first-run", async (c) => {
    const st = await firstRunState(app.db.control, app.instanceId);
    const { ip, signs } = await firstRunClient(app, c);
    return c.json({ needed: !st.adminUsers && !st.memoryAdmin, first_admin_needed: !st.memoryAdmin, code_required: firstRunCodeRequired(ip, signs) });
  });
  r.post("/api/v1/first-run", async (c) => {
    const b = await c.req.json().catch(() => null);
    const { ip, via, signs } = await firstRunClient(app, c);
    const where = via ? { via_workplace: via } : {};
    const byPerson = !!b && typeof b === "object" && Object.hasOwn(b, "person");
    if (byPerson && !localCommandCall(c)) {
      await audit(app, null, { event_type: "auth_failure", details: { reason: "first_admin_not_local" }, ip: remoteAddr(c) === "?" ? null : remoteAddr(c) });
      return c.json(NOT_FOUND_BODY, 404);
    }
    const required = firstRunCodeFor(ip, signs);
    const want = required.code;
    if (want) {
      const wait = firstRunFailures.retryAfter("first-run", ip);
      if (wait > 0) { c.header("Retry-After", String(wait)); return c.json({ code: "rate_limited", message: "Too many failed attempts", retry_after: wait }, 429); }
      if (!firstRunCodeOk(b?.code, want)) {
        firstRunFailures.record("first-run", ip);
        await audit(app, null, { event_type: "auth_failure", details: { reason: "first_run_code", ...where }, ip: ip === "?" ? null : ip });
        return c.json({ code: "first_run_code_invalid", message: firstRunCodeHint(required.source) }, 403);
      }
    }
    if (byPerson) {
      if (!want) return c.json({ code: "forbidden", message: "Assigning the first administrator to a person’s profile requires the installation code (MEMORY_FIRST_RUN_CODE). This installation has no code" }, 403);
      const res = await firstAdminByPerson(app, b.person);
      if ("refusal" in res) return c.json(res.refusal, res.status);
      await audit(app, null, { event_type: "admin", details: { op: "first_admin", person: res.person.id, login: res.person.login, grant_id: res.grantId, ...where }, ip: ip === "?" ? null : ip });
      await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "admin_role_changed",
        summary: `Assigned ${res.person.login} as the first memory administrator (first-admin command with the installation code)`, details: { role: "memory_admin", person: res.person.id, action: "granted" } });
      firstRunFailures.clear("first-run", ip);
      return c.json({ person: res.person.login, role: "memory_admin", grant_id: res.grantId }, 201);
    }
    if (typeof b?.login !== "string" || typeof b?.password !== "string" || b.password.length < 12) return c.json({ code: "invalid_argument", message: "Provide login and password (at least 12 characters)" }, 400);
    if (credentialsTooLong(b.login.trim(), b.password)) return c.json({ code: "invalid_argument", message: CREDENTIALS_TOO_LONG }, 400);
    const login = b.login.trim().toLowerCase();
    if (!login || login.length > ADMIN_LOGIN_MAX) return c.json({ code: "invalid_argument", message: `The login must be 1 to ${ADMIN_LOGIN_MAX} characters` }, 400);
    const withKey = app.settings.get<boolean>("admin.system_key_admin", true) !== false;
    const out = await tx(app.db.control, async (q) => {
      await q.query("LOCK TABLE admin_users IN EXCLUSIVE MODE");
      const st = await firstRunState(q, app.instanceId);
      if (st.adminUsers || st.memoryAdmin) return null;
      await q.query("INSERT INTO admin_users (login, password_hash, instance_id) VALUES ($1,$2,$3)", [login, hashAdminPassword(b.password), app.instanceId]);
      if (!withKey) return { key: null };
      const key = generateApiKey("system");
      await q.query("INSERT INTO api_keys (id, key_prefix, key_hash, principal_type, principal_id, kind, tier, instance_id, client_label) VALUES ($1,$2,$3,'system',NULL,'system','T0',$4,'first-run')", [newId(), key.prefix, key.hash, app.instanceId]);
      return { key: key.plain };
    });
    if (!out) return c.json({ code: "forbidden", message: "The first administrator already exists" }, 403);
    await app.settings.load(true);
    if (!app.settings.str("access.link_signing_key")) await app.settings.set("access", "link_signing_key", randomBytes(32).toString("base64url"), null);
    await audit(app, null, { event_type: "admin", details: { op: "first_run", login: b.login.trim().toLowerCase().slice(0, 200), code_checked: want !== "", system_key: out.key !== null, ...where }, ip: ip === "?" ? null : ip });
    if (want) firstRunFailures.clear("first-run", ip);
    if (out.key === null) return c.json({ login, note: "The system key was not created because admin.system_key_admin is off. Sign in through the admin panel" }, 201);
    return c.json({ system_key: out.key, note: "The system key is shown only once" }, 201);
  });
  r.post("/api/v1/admin-login", async (c) => {
    const raw = String(app.settings.get<string>("admin.local_login", "open"));
    const mode = raw === "breakglass" || raw === "off" ? raw : "open";
    if (mode === "off") return c.json(LOCAL_LOGIN_CLOSED, 404);
    const tokenKind = adminLoginTokenKind();
    let window: { id: string; end: Date } | null = null;
    if (mode === "breakglass") {
      const st: { open: boolean; window?: string; expires_at?: string } = tokenKind === "mem_as_" ? await breakglassStateForLogin(app) : { open: false };
      if (!st.open || !st.window || !st.expires_at) return c.json(LOCAL_LOGIN_CLOSED, 404);
      window = { id: st.window, end: new Date(st.expires_at) };
    }
    const b = await c.req.json().catch(() => null);
    if (credentialsTooLong(b?.login, b?.password)) return c.json({ code: "invalid_argument", message: CREDENTIALS_TOO_LONG }, 400);
    // the form of the second factor is checked before the attempt and scrypt (the value — only after the password)
    if (!otpShapeOk(b?.otp)) return c.json({ code: "invalid_argument", reason: "otp_invalid", message: OTP_SHAPE_TEXT }, 400);
    const login = String(b?.login ?? "").trim().toLowerCase().slice(0, 200), sock = remoteAddr(c);
    const onAdmin = currentListener()?.kind === "admin";
    const ip = onAdmin ? (await adminClientIp(app, c)) ?? sock
      : (await fromWorkplace(app, sock)) ? (await workplaceClientAddress(app, (n) => c.req.header(n), sock)) ?? sock : sock;
    const slot = loginFailures.reserve(login, ip);
    if ("wait" in slot) {
      c.header("Retry-After", String(slot.wait));
      return c.json({ code: "rate_limited", message: slot.inFlight ? "A sign-in is already being checked. Try again in a few seconds" : "Too many failed sign-in attempts", retry_after: slot.wait,
                     ...(slot.inFlight ? { reason: "in_flight" } : {}) }, 429);
    }
    let u: { login: string; password_hash: string } | undefined, ok = false;
    let factor: FactorCheck = { ok: true, factor: null };
    let signedIn: LocalLoginIssue | undefined, auditDown = false, auditHold = 0;
    try {
      u = (await app.db.control.query("SELECT login, password_hash FROM admin_users WHERE login = $1 AND disabled_at IS NULL", [login])).rows[0];
      ok = u ? await verifyAdminPasswordAsync(String(b?.password ?? ""), u.password_hash) : await verifyAdminPasswordAsync(String(b?.password ?? ""), null);
      if (!u || !ok) loginFailures.record(login, ip);
      // the strict admin_login event goes to the audit database, which no transaction of the factor can span; an
      // audit database that does not answer refuses here, BEFORE a code is checked or spent (a later failure of the write
      // itself — auditUnavailable). The probe uses the reader pool (bounded wait; the writer pool only appends).: a
      // strict write that failed here a moment ago holds sign-ins before the factor too — a journal that reads but does not
      // write (a full disk) passes the probe and would otherwise take one code per attempt
      else if ((auditHold = auditWriteHoldLeft(app)) > 0 || !(await auditAnswers(app))) auditDown = true;
      else {
        // the code is checked inside the reserved attempt, so parallel guesses stay within the per-address bound;
        // a wrong code or a locked factor is a failed attempt, recorded before the slot is released
        // the session is issued by onVerified, which runs only after the factor transaction COMMITTED (see
        // checkLocalSecondFactor); a failure before that, or inside issuance, is `unavailable` and nothing is signed
        // a legacy token is signed with the database clock and verified with this one — refuse a skew first
        factor = await checkLocalSecondFactor(app, u.login, b?.otp, { maxSkewMs: tokenKind === "mem_adm_" ? SESSION_CLOCK_SKEW_SEC * 1000 : undefined, onVerified: async (sf, at) => {
          signedIn = await issueLocalLogin(app, c, { login: u!.login, ip, window, tokenKind, secondFactor: sf ?? undefined, nowMs: at.nowMs });
          return signedIn.revoke ? { revoke: signedIn.revoke } : undefined;
        } }).catch((): FactorCheck => ({ ok: false, why: "unavailable" }));
        if (!factor.ok && (factor.why === "bad_code" || factor.why === "locked")) loginFailures.record(login, ip);
      }
    } finally {
      slot.release();
    }
    if (!u || !ok) {
      await audit(app, null, { event_type: "auth_failure", details: { reason: "admin_login", login }, ip });
      return c.json({ code: "unauthorized", message: "Incorrect login or password" }, 401);
    }
    if (auditDown) {
      log.error("admin_login_audit_unavailable", { login: u.login, spent: null, held_sec: auditHold });
      // a non-strict event — the journal's outbox carries it to the journal once it is back
      void audit(app, null, { event_type: "auth_failure", ip, details: { reason: "admin_login_otp", login: u.login, why: "audit_unavailable", spent: null,
                                                                       ...(auditHold > 0 ? { held_sec: auditHold } : {}) } });
      if (auditHold > 0) {
        c.header("Retry-After", String(auditHold));
        return c.json({ code: "internal", reason: "audit_unavailable", spent: null, retry_after: auditHold,
                        message: `The audit journal refused the record of a sign-in moments ago, so sign-in is paused for up to ${AUDIT_WRITE_HOLD_SEC} seconds to keep your codes. Your code was not used: try again in ${auditHold} seconds` }, 503);
      }
      return c.json({ code: "internal", reason: "audit_unavailable", spent: null,
                      message: "The audit journal is unavailable, so sign-in is not possible right now. Your code was not used: try again once the journal is back" }, 503);
    }
    if (!factor.ok) return secondFactorRefusal(app, c, u.login, ip, factor);
    if (!signedIn) return c.json({ code: "internal", reason: "factor_unavailable", message: "The second factor cannot be checked right now; try again later" }, 503);
    // alerts after the outcome, on the pool, outside every transaction of the attempt: their failure only logs
    if (signedIn.alert) await raiseAlert({ control: app.db.control, audit: app.db.audit }, signedIn.alert);
    if (signedIn.alert && !signedIn.secondFactor) await noteFactorlessLogin(app, u.login).catch(() => undefined);
    return signedIn.response;
  });
  r.post("/api/v1/admin-auth/totp/reset", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!localCommandCall(c)) {
      await audit(app, null, { event_type: "auth_failure", details: { reason: "local_totp_reset_not_local" }, ip: remoteAddr(c) === "?" ? null : remoteAddr(c) });
      return c.json(NOT_FOUND_BODY, 404);
    }
    const want = suppliedFirstRunCode()?.code;
    if (!want) return c.json({ code: "forbidden", message: "A supplied install code is required for console recovery" }, 403);
    const b = await c.req.json().catch(() => null), ip = remoteAddr(c);
    const slot = firstRunFailures.reserve("first-run", ip);
    if ("wait" in slot) { c.header("Retry-After", String(slot.wait)); return c.json({ code: "rate_limited", message: "Too many install-code attempts", retry_after: slot.wait }, 429); }
    try {
      if (!firstRunCodeOk(b?.code, want)) {
        firstRunFailures.record("first-run", ip);
        await audit(app, null, { event_type: "auth_failure", details: { reason: "first_run_code" }, ip: ip === "?" ? null : ip });
        return c.json({ code: "first_run_code_invalid", message: "The install code is incorrect" }, 403);
      }
      if (!localTotpBody(b, ["code", "login", "remove"]) || typeof b.login !== "string" || !b.login.trim() || b.login.trim().length > 200 || (b.remove !== undefined && typeof b.remove !== "boolean"))
        return c.json({ code: "invalid_argument", message: "Send login, install code and an optional boolean remove" }, 400);
      const login = b.login.trim().toLowerCase();
      const out = await resetLocalTotp(app, login, { remove: b.remove === true, beforeWrite: async control => {
        const revoked = await revokeLocalSessions(app, login, { control });
        await audit(app, null, { event_type: "admin", details: { op: "local_totp_reset", login, removed: b.remove === true, revoked }, ip: ip === "?" ? null : ip }, { strict: true });
      } });
      if ("error" in out) {
        if (out.error === "not_found") return c.json(NOT_FOUND_BODY, 404);
        return c.json({ code: "conflict", reason: "required", message: "A second factor is required by the installation policy" }, 409);
      }
      firstRunFailures.clear("first-run", ip);
      if ("removed" in out) return c.json(out);
      return c.json({ login: out.login, otpauth_uri: out.otpauth_uri, secret_text: out.secret_text, recovery_codes: out.recovery_codes });
    } catch { return c.json({ code: "internal", reason: "factor_unavailable", message: "The second factor is unavailable; try again later" }, 503); }
    finally { slot.release(); }
  });
  return r;
}

/**
 * A sign-in's answer and the alert to raise once the answer is settled. alert is set only when a session was issued;
 * the caller raises it after the per-login lock is released, on the pool.
 */
interface LocalLoginIssue { response: Response; secondFactor?: SessionFactor; alert?: AlertInput; revoke?: () => Promise<unknown> }

/**
 * Issue the session of a verified sign-in. Runs only after the factor transaction committed and while the per-login lock is
 * still held (checkLocalSecondFactor): a console reset waits for it and then revokes what it issued. It has no transaction
 * client: no write here can abort or outlive the factor transaction.
 */
async function issueLocalLogin(app: App, c: Context, o: { login: string; ip: string; window: { id: string; end: Date } | null; tokenKind: "mem_as_" | "mem_adm_"; secondFactor?: SessionFactor; nowMs: number }): Promise<LocalLoginIssue> {
  loginFailures.clear(o.login, o.ip);
  const sf = o.secondFactor;
  if (o.tokenKind === "mem_as_") return localAdminSession(app, c, { ...o, secondFactor: sf });
  try {
    await audit(app, null, { event_type: "admin", ip: o.ip, details: { op: "admin_login", login: o.login, admin_role: "memory_admin", admin_auth: "local", session_kind: "legacy",
                                                                ...(sf ? { second_factor: sf } : {}) } },
                { strict: true });
  } catch {
    return { response: await auditUnavailable(app, c, o.login, o.ip, sf, "legacy") };
  }
  // issued at the database clock read under the lock — the clock of the reset's cutoff (sessions_revoked_at); revoke
  // (a lost lock): a signed token cannot be withdrawn alone, so the login's cutoff moves past it (revokeLocalSessions)
  return { response: c.json({ session: signSession(app, o.login, o.nowMs, sf), expires_in: SESSION_TTL_SEC }), ...(sf ? { secondFactor: sf } : {}),
           revoke: () => revokeLocalSessions(app, o.login),
           alert: { instanceId: app.instanceId, level: "medium", code: "admin_login",
                    summary: `Administrator ${o.login} signed in (admin@local, legacy session type)`, details: { admin_role: "memory_admin", admin_auth: "local", session_kind: "legacy" } } };
}

/**
 * The strict admin_login event failed after the factor transaction committed: no session stands, and the code is
 * spent — the audit database is outside that transaction (no transaction spans two databases), so the spend cannot wait for
 * the event. The answer says so plainly, with the recovery codes left, so the administrator does not spend them all on
 * retries; the pre-check before the factor (audit pool answering) refuses an outage without spending anything.
 */
async function auditUnavailable(app: App, c: Context, login: string, ip: string, sf: SessionFactor | undefined, session: string): Promise<Response> {
  auditWriteFailedAt.set(app, Date.now());                 // hold the next sign-ins before the factor for a while
  const left = sf === "recovery"
    ? await app.db.control.query("SELECT cardinality(recovery_hashes) AS n FROM admin_totp WHERE login = $1 AND instance_id = $2", [login, app.instanceId])
        .then((r) => { const n = Number(r.rows[0]?.n); return Number.isInteger(n) ? n : null; }, () => null)
    : null;
  log.error("admin_login_audit_failed", { login, session, spent: sf ?? null, ...(left === null ? {} : { recovery_codes_left: left }) });
  // the spend leaves a trace once the journal is back — a non-strict event goes to the outbox when the journal refuses
  void audit(app, null, { event_type: "auth_failure", ip, details: { reason: "admin_login_otp", login, why: "audit_unavailable", spent: sf ?? null,
                                                                 ...(left === null ? {} : { recovery_codes_left: left }) } });
  const message = sf === "recovery"
    ? `The audit journal is unavailable, so the sign-in was not completed. Your recovery code was accepted and is now used up${left === null ? "" : ` (${left} left)`}: wait until the journal is back before trying again`
    : sf === "totp" ? "The audit journal is unavailable, so the sign-in was not completed. Your code was accepted and is now used: wait until the journal is back, then sign in with the next code from your authenticator app"
    : "The audit journal is unavailable, so the sign-in was not completed. Try again once the journal is back";
  return c.json({ code: "internal", reason: "audit_unavailable", spent: sf ?? null, ...(left === null ? {} : { recovery_codes_left: left }), message }, 503);
}

/**
 * after a strict admin_login write failed, this process refuses local sign-ins BEFORE the factor for
 * AUDIT_WRITE_HOLD_SEC — a journal that answers reads but refuses writes (a full disk, the writer role) passes the probe, and
 * without the hold every attempt would spend one more code. 60 s: an administrator retrying by hand is refused without
 * spending, a passing fault blocks sign-in for at most a minute. It ends by itself; in-process, per app.
 */
const AUDIT_WRITE_HOLD_SEC = 60;
const auditWriteFailedAt = new WeakMap<App, number>();
function auditWriteHoldLeft(app: App): number {
  const at = auditWriteFailedAt.get(app);
  if (at === undefined) return 0;
  const left = Math.ceil((at + AUDIT_WRITE_HOLD_SEC * 1000 - Date.now()) / 1000);
  if (left > 0) return left;
  auditWriteFailedAt.delete(app);
  return 0;
}

/** Time limit of the audit probe before the factor. */
export const AUDIT_PROBE_MS = 2_000;
/** Does the audit database answer? Its own time limit; a synchronous throw of the pool is a no, not an escape. */
async function auditAnswers(app: App): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), AUDIT_PROBE_MS); });
    return await Promise.race([app.db.auditRead().query("SELECT 1").then(() => true, () => false), limit]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Answer to a malformed `otp` of the sign-in. */
const OTP_SHAPE_TEXT = "otp: six digits from the authenticator app or a recovery code, at most 64 characters";

/**
 * Sign-in refused by the second factor, after a correct password: existing top-level codes with a reason.
 * otp_required — no event, no counter (the code is simply asked); the others — auth_failure admin_login_otp with the reason.
 */
async function secondFactorRefusal(app: App, c: Context, login: string, ip: string, f: Extract<FactorCheck, { ok: false }>): Promise<Response> {
  if (f.why === "otp_required")
    return c.json({ code: "unauthorized", reason: "otp_required", message: "Enter the code from your authenticator app or a recovery code" }, 401);
  await audit(app, null, { event_type: "auth_failure", ip, details: { reason: "admin_login_otp", login, why: f.why,
    // interrupted: the code was used up although no session stands — the panel's journal says so
    ...(f.why === "interrupted" ? { spent: f.spent, repeat_with_fresh_code: f.spent !== null } : {}),
    ...(f.why === "clock_skew" ? { skew_sec: f.skewSec } : {}) } });
  switch (f.why) {
    case "bad_code":
      return c.json({ code: "unauthorized", reason: "bad_code", message: "The code is wrong or was already used. Check the time on the phone", server_time: new Date().toISOString() }, 401);
    case "locked": {
      const wait = Math.max(1, f.retryAfter ?? 900);
      c.header("Retry-After", String(wait));
      return c.json({ code: "rate_limited", reason: "factor_locked", message: "Too many wrong codes: the second factor is locked for a while", retry_after: wait }, 429);
    }
    case "busy": {
      // another sign-in of this account or a change of its factor holds the lock; nothing was checked or spent
      const wait = Math.max(1, f.retryAfter ?? 5);
      c.header("Retry-After", String(wait));
      return c.json({ code: "rate_limited", reason: "factor_busy", retry_after: wait,
                      message: "Another sign-in or a change of this account's second factor is in progress. Try again in a few seconds" }, 429);
    }
    case "interrupted":
      // the code was accepted and used up, then the sign-in could not be finished safely: no session stands
      return c.json({ code: "internal", reason: "sign_in_interrupted",
                      message: f.spent === "recovery" ? "The sign-in was interrupted after your recovery code was accepted. That code is now used up: sign in again with another recovery code"
                        : f.spent === "totp" ? "The sign-in was interrupted after your code was accepted. That code is now used: sign in again with the next code from your authenticator app"
                        : "The sign-in was interrupted. Sign in again" }, 503);
    case "clock_skew":
      // refused inside the factor transaction before anything was checked or spent
      return c.json({ code: "internal", reason: "clock_skew", skew_sec: f.skewSec,
                      message: `The database clock and this server's clock differ by ${Math.abs(f.skewSec)} seconds (at most ${SESSION_CLOCK_SKEW_SEC} allowed, either way), so a session could not be used. Nothing was used: ask the operator to fix the time synchronization` }, 503);
    case "enrollment_required":
      return c.json({ code: "forbidden", reason: "totp_enrollment_required",
                      message: "A second factor is required for this account, but none is set up. Reset it with tools/admin/local-totp-reset.mjs on the server" }, 403);
    default:
      return c.json({ code: "internal", reason: "factor_unavailable", message: "The second factor cannot be checked right now; try again later" }, 503);
  }
}

const BREAKGLASS_CLOSED_TTL_MS = 1_000;
const breakglassClosedAt = new WeakMap<App, number>();
async function breakglassStateForLogin(app: App): Promise<{ open: boolean; window?: string; expires_at?: string }> {
  const seen = breakglassClosedAt.get(app);
  if (seen !== undefined && Date.now() - seen < BREAKGLASS_CLOSED_TTL_MS) return { open: false };
  const st = await breakglassState(app).catch(() => ({ open: false }));
  if (st.open) breakglassClosedAt.delete(app); else breakglassClosedAt.set(app, Date.now());
  return st;
}

const LOCAL_LOGIN_CLOSED = { code: "not_found", message: "The record, path or space was not found or is not available" } as const;

export function localCommandCall(c: Context): boolean {
  if (forwardingSigns(Object.keys(c.req.header())).length) return false;
  if (directAdminCall(c)) return true;
  if (currentListener()?.unix) return false;
  const a = remoteAddr(c);
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

async function localAdminSession(app: App, c: Context, o: { login: string; ip: string; window: { id: string; end: Date } | null; secondFactor?: SessionFactor }): Promise<LocalLoginIssue> {
  const method = o.window ? "local_breakglass" : "local";
  const sf = o.secondFactor;   // admin_sessions.second_factor and the event field only when a factor was used
  const { token, row } = await createAdminSession(app, { localLogin: o.login, role: "memory_admin", authMethod: method, ip: o.ip, breakglassWindowId: o.window?.id ?? null,
                                                         ...(sf ? { secondFactor: sf } : {}) });
  try {
    await audit(app, null, { event_type: "admin", ip: o.ip, details: { op: "admin_login", admin_session: row.id, admin_person: row.person_id, admin_role: "memory_admin",
                                                                     admin_auth: method, login: o.login, ...(sf ? { second_factor: sf } : {}) } }, { strict: true });
  } catch {
    await revokeAdminSessions(app, { sessionId: row.id }, "logout");
    return { response: await auditUnavailable(app, c, o.login, o.ip, sf, row.id) };
  }
  log.info("admin_login", { login: o.login, session: row.id, auth: method });
  const end = o.window && o.window.end.getTime() < new Date(row.expires_at).getTime() ? o.window.end : new Date(row.expires_at);
  return { response: c.json({ session: token, expires_in: Math.max(1, Math.floor((end.getTime() - Date.now()) / 1000)), expires_at: end.toISOString() }),
           ...(sf ? { secondFactor: sf } : {}), revoke: () => revokeAdminSessions(app, { sessionId: row.id }, "logout"),
           alert: { instanceId: app.instanceId, level: "medium", code: "admin_login",
                    summary: `Administrator ${o.login} signed in (${o.window ? "admin@local, emergency access" : "admin@local"})`,
                    details: { admin_person: row.person_id, admin_session: row.id, admin_role: "memory_admin", admin_auth: method }, dedupeKey: `admin_login:${row.id}` } };
}

async function firstRunState(q: Pick<pg.Pool, "query">, instanceId: string): Promise<{ adminUsers: boolean; memoryAdmin: boolean }> {
  const r = await q.query(
    `SELECT EXISTS (SELECT 1 FROM admin_users) AS admin_users,
            EXISTS (SELECT 1 FROM role_grants g JOIN people p ON p.id = g.person_id AND p.active
                     WHERE g.instance_id = $1 AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL AND g.valid_from <= now()
                       AND (g.valid_to IS NULL OR g.valid_to > now())) AS memory_admin`, [instanceId]);
  return { adminUsers: r.rows[0]?.admin_users === true, memoryAdmin: r.rows[0]?.memory_admin === true };
}

async function firstAdminByPerson(app: App, raw: unknown): Promise<{ person: { id: string; login: string }; grantId: string } | { status: 400 | 403; refusal: { code: string; message: string } }> {
  const login = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!login || login.length > ADMIN_LOGIN_MAX) return { status: 400, refusal: { code: "invalid_argument", message: "person: the profile’s login (e-mail address), up to 200 characters" } };
  return tx(app.db.control, async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-first-admin', 0))");
    if ((await firstRunState(q, app.instanceId)).memoryAdmin)
      return { status: 403 as const, refusal: { code: "forbidden", message: "A memory administrator is already assigned. Assign additional administrators in the admin panel with a second signature" } };
    const p = (await q.query(
      `SELECT p.id, p.login FROM people p
        WHERE p.login = $1 AND p.instance_id = $2 AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'
          AND EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active AND i.verified)`, [login, app.instanceId])).rows[0] as
      { id: string; login: string } | undefined;
    if (!p) return { status: 400 as const, refusal: { code: "invalid_argument", message: `${login}: no active profile has a verified directory link. The person must first sign in to the workspace through the directory` } };
    const id = newId();
    await q.query(
      `INSERT INTO role_grants (id, person_id, role_code, actions, scope_kind, basis_source, basis_ref, approved_by, approved_at, instance_id)
       VALUES ($1, $2, 'memory_admin', '{view}', 'company', 'manual', 'first-admin', 'installation_code', now(), $3)`, [id, p.id, app.instanceId]);
    await reconcileAccess(q, app.instanceId, false);
    return { person: p, grantId: id };
  });
}
