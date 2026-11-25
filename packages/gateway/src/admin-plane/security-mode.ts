import { Hono, type Context } from "hono";
import { ADVANCED_SET_VALUES, advancedTargets, canonicalJson, currentAnchors, DEVICE_BOUND_SQL, DOWNGRADE_DELAY_DEFAULT_H, DOWNGRADE_REASON_MIN, effectiveMode, enqueueMail, isHumanSession, log, MAIL_RE,
         modeOf, profileDigest, raiseAlert, ROLES_NOT_SPLIT, ROLES_NOT_SPLIT_TEXT, rolesSplitRefusal, SECURITY_MODE_SETTING,
         securityModeDisplayName, securityModeFloor, stricterMode, tx, type SecurityMode } from "@memory/shared";
import type pg from "pg";
import type { AdminCaller, App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { isUuidParam } from "../paging.ts";
import { HUMAN_SESSION_REQUIRED } from "./approvals.ts";
import { adminDb } from "./db.ts";
import { advancedReadiness, bridgeHostLocal, bridgeSubjectHost, READINESS_FAILED, settingsBeforeAgain, type ReadinessCheck } from "./readiness.ts";
import { ROLE_FORBIDDEN, STEPUP_REQUIRED } from "./responses.ts";
import { freshUv } from "./session.ts";
import { settingAuditDetails } from "./settings-guard.ts";

type Env = { Variables: { caller: Caller } };
type Row = Record<string, unknown>;

export const SM_ERRORS = {
  same: (to: SecurityMode) => ({ code: "security_mode_same", message: `The mode is already ${to}` }),
  pending: { code: "downgrade_pending_exists", message: "A request to return to basic already exists. Sign or cancel it" },
  notReady: { code: "downgrade_not_ready", message: "Cannot execute the return yet: another administrator must sign and the delay must end" },
  notFound: { code: "not_found", message: "Not found" },
  state: { code: "approval_state", message: "Request already signed, cancelled or executed" },
  self: { code: "approval_self", message: "You cannot sign your own request: another person is needed" },
  retireMissing: { code: "retire_missing", message: "The last applied internal anchors are not a “retirement document”. Apply a retirement document signed by 2 of 3 signers (anchors reload)" },
  retireStale: { code: "retire_stale", message: "The retirement document was applied before this request, so it was not signed for this request. Use a new retirement document with a higher serial number" },
  retireUsed: { code: "retire_used", message: "This leaving document has already signed another request: a new document with a higher number is needed" },
  floor: { code: "floor_advanced", message: "The internal anchors set the floor of the advanced mode: first a document signed by 2 of 3 with the floor basic, or a «leaving document»" },
  retireNotNeeded: { code: "retire_not_needed", message: "There is another memory administrator with a key: that person signs the request; a leaving document only when there is no second one" },
  retireUnverified: { code: "retire_unverified", message: "The retirement document in the database differs from the one whose signatures the gateway verified. Reload the anchors (memory-admin-cli anchors reload) and try again" },
  retireUnconfirmed: { code: "retire_unverified", message: "The workers have yet to verify the retirement document’s signatures. Restart the workers so they reload the anchors, then try again in a minute" },
  anchorsUnverified: { code: "anchors_unverified", message: "The database has newer internal anchors than the gateway verified. Reload the anchors (memory-admin-cli anchors reload) and try again" },
  anchorsDisabled: { code: "anchors_unverified", message: "The anchors-disabled marker removed the internal anchors. The gateway did not verify the signatures of the anchors in the database. Retire the anchors with a retirement document signed by 2 of 3 signers (memory-admin-cli anchors draft --retire) and try again" },
  rolesNotSplit: (why: string = ROLES_NOT_SPLIT_TEXT) => ({ code: "conflict", reason: ROLES_NOT_SPLIT,
    message: `${why.replace(/^roles_not_split: /, "")}. Nothing is written: the mode stays basic, system keys and sessions are not revoked` }),
} as const;

const reloadAfterChange = (app: App): Promise<void> =>
  app.settings.load(true).catch((e: unknown) => log.warn("security_mode_settings_reload_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }));
const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
const pgMessage = (e: unknown): string => String((e as { message?: string })?.message ?? "");
const pgCode = (e: unknown): string => String((e as { code?: string })?.code ?? "");

function humanAdmin(app: App, c: Context<Env>, o: { fresh: boolean | "if_keys"; hasKeys?: boolean }): AdminCaller | Response {
  const a = c.get("caller")?.admin;
  if (!a || a.role !== "memory_admin") return c.json(ROLE_FORBIDDEN, 403);
  if (!isHumanSession(a)) return c.json(HUMAN_SESSION_REQUIRED, 403);
  const needUv = o.fresh === true || (o.fresh === "if_keys" && o.hasKeys === true);
  if (needUv && !freshUv(app, a.uvAt)) return c.json(STEPUP_REQUIRED, 403);
  return a;
}

function pendingView(p: Row): Record<string, unknown> {
  const signed = !!p.approved_by || (p.approved_anchors_serial !== null && p.approved_anchors_serial !== undefined);
  const state = p.executed_at ? "executed" : p.cancelled_at ? "cancelled" : !signed ? "waiting_signature"
    : new Date(p.not_before as string).getTime() > Date.now() ? "waiting_delay" : "ready";
  return { id: p.id, requested_by: (p.requested_login as string | null) ?? null, requested_at: iso(p.requested_at), reason: p.reason, not_before: iso(p.not_before),
           approved_by: (p.approved_login as string | null) ?? null, approved_at: iso(p.approved_at),
           approved_anchors_serial: p.approved_anchors_serial === null || p.approved_anchors_serial === undefined ? null : Number(p.approved_anchors_serial), state };
}

const pendingSigned = (p: Row): boolean => !!p.approved_by || (p.approved_anchors_serial !== null && p.approved_anchors_serial !== undefined);

const PENDING_SQL = `SELECT p.*, rq.login AS requested_login, ap.login AS approved_login FROM security_mode_pending p
                       LEFT JOIN people rq ON rq.id = p.requested_by LEFT JOIN people ap ON ap.id = p.approved_by`;

export async function securityModeState(app: App): Promise<Record<string, unknown>> {
  const db = adminDb(app);
  await app.settings.load(true);
  const setting = modeOf(app.settings.rawValue(SECURITY_MODE_SETTING) ?? null);
  const open = (await db.query(`${PENDING_SQL} WHERE p.instance_id = $1 AND p.cancelled_at IS NULL AND p.executed_at IS NULL ORDER BY p.requested_at DESC LIMIT 1`,
    [app.instanceId])).rows[0] as Row | undefined;
  const changes = (await db.query(
    `SELECT c.at, c.from_mode, c.to_mode, p.login, c.reason, c.keys_revoked, c.sessions_revoked FROM security_mode_changes c LEFT JOIN people p ON p.id = c.by_person
      WHERE c.instance_id = $1 ORDER BY c.seq DESC LIMIT 20`, [app.instanceId])).rows as Row[];
  const retirePossible = open ? (await db.query(
    `SELECT count(DISTINCT g.person_id)::int AS n FROM role_grants g JOIN people p ON p.id = g.person_id AND p.active
      WHERE g.instance_id = $1 AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now())
        AND g.person_id IS DISTINCT FROM $2::uuid
        AND EXISTS (SELECT 1 FROM admin_webauthn_credentials w WHERE w.person_id = g.person_id AND w.instance_id = $1 AND w.disabled_at IS NULL AND w.${DEVICE_BOUND_SQL})`,
    [app.instanceId, open.requested_by ?? null])).rows[0]?.n === 0 : false;
  const mode = effectiveMode(app.settings);
  return {
    mode, display_name: securityModeDisplayName(mode), setting, floor: securityModeFloor(), retire_possible: retirePossible,
    downgrade_delay_hours: Number(app.settings.get<number>("security.downgrade_delay_hours", DOWNGRADE_DELAY_DEFAULT_H)) || DOWNGRADE_DELAY_DEFAULT_H,
    pending: open ? pendingView(open) : null,
    changes: changes.map((x) => ({ at: iso(x.at), from: x.from_mode, to: x.to_mode, by: (x.login as string | null) ?? null, reason: (x.reason as string | null) ?? null,
                                   keys_revoked: Number(x.keys_revoked ?? 0), sessions_revoked: Number(x.sessions_revoked ?? 0) })),
  };
}

const flagValues = (get: (p: string) => unknown): Record<string, unknown> =>
  Object.fromEntries(ADVANCED_SET_VALUES.map((v) => [`${v.category}.${v.key}`, get(`${v.category}.${v.key}`) ?? null]));

export const SECURITY_MODE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('security_mode'), hashtext($1))";

export async function dbSecurityMode(app: App, q: Pick<pg.Pool, "query"> = adminDb(app)): Promise<SecurityMode> {
  const m = (await q.query("SELECT security_mode($1) AS m", [app.instanceId])).rows[0]?.m;
  return stricterMode(modeOf(m ?? null), securityModeFloor());
}

export async function anchorsUnverified(app: App): Promise<boolean> {
  const db = adminDb(app);
  const top = (await db.query(
    "SELECT serial, encode(sha256, 'hex') AS sha FROM anchors_applied WHERE instance_id = $1 AND kind = 'inner' ORDER BY serial DESC LIMIT 1", [app.instanceId])).rows[0] as
    { serial: string | number; sha: string } | undefined;
  if (!top) return false;
  const cur = currentAnchors();
  if (typeof cur.serial !== "number") return true;
  if (typeof cur.sha256 !== "string") {
    if (!(cur.retired === true && Number(top.serial) === cur.serial)) return true;
    const has = (await db.query("SELECT to_regclass('anchors_inner_confirmations') IS NOT NULL AS ok")).rows[0]?.ok === true;
    if (!has) return false;
    const ok = await db.query(
      `SELECT 1 FROM anchors_inner_confirmations k JOIN anchors_applied a ON a.instance_id = k.instance_id AND a.kind = 'inner' AND a.serial = k.serial
                AND a.sha256 = k.sha256 AND a.applied_at = k.row_applied_at
        WHERE k.instance_id = $1 AND k.serial = $2 AND k.retire_target = 'basic'`, [app.instanceId, cur.serial]);
    return (ok.rowCount ?? ok.rows.length) === 0;
  }
  return Number(top.serial) !== cur.serial || top.sha !== cur.sha256.toLowerCase();
}

class ReadinessChangedUnderLock extends Error {
  constructor(readonly failed: ReadinessCheck[]) { super("readiness_changed_under_lock"); }
}

export async function enableAdvanced(app: App, c: Context<Env>): Promise<Response> {
  const a = humanAdmin(app, c, { fresh: true });
  if (a instanceof Response) return a;
  const caller = c.get("caller");
  const b = await c.req.json().catch(() => ({})) as { reason?: unknown };
  const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 500) : "Enable advanced";
  if (app.settings.securityModeSetting() === "advanced") return c.json(SM_ERRORS.same("advanced"), 409);
  const ready = await advancedReadiness(app, caller);
  const failed = ready.before.filter((x) => x.status !== "ok").map((x) => ({ ...x, status: "fail" as const }));
  if (failed.length) return c.json(READINESS_FAILED(failed), 409);
  const closed = rolesSplitRefusal();
  if (closed) return c.json(SM_ERRORS.rolesNotSplit(closed), 409);

  let out: { change: string; keys: number; sessions: number; before: Record<string, unknown>; after: Record<string, unknown> };
  try {
    out = await tx(adminDb(app), async (q) => {
      await q.query(SECURITY_MODE_LOCK_SQL, [app.instanceId]);
      const settings = app.settings.withDatabase(q);
      await settings.load(true);
      await q.query("SAVEPOINT readiness_again");
      const again = await settingsBeforeAgain((p) => settings.effective(p), q, app.instanceId);
      await q.query("ROLLBACK TO SAVEPOINT readiness_again");
      await q.query("RELEASE SAVEPOINT readiness_again");
      if (again.length) throw new ReadinessChangedUnderLock(again);
      const before = flagValues((p) => settings.effective(p));
      const targets = advancedTargets((p) => settings.effective(p));
      const after = { ...before, ...Object.fromEntries(targets.map((v) => [`${v.category}.${v.key}`, v.value])) };
      const write = targets.filter((v) => canonicalJson(before[`${v.category}.${v.key}`] ?? null) !== canonicalJson(v.value ?? null));
      if (write.length) await settings.setMany(write, { updatedBy: a.personId });
      const keys = (await q.query("UPDATE api_keys SET revoked_at = now() WHERE instance_id = $1 AND principal_type = 'system' AND revoked_at IS NULL RETURNING id",
        [app.instanceId])).rowCount ?? 0;
      const sessions = (await q.query(
        "UPDATE admin_sessions SET revoked_at = now(), revoked_reason = 'security_mode' WHERE instance_id = $1 AND revoked_at IS NULL AND id <> $2 RETURNING id",
        [app.instanceId, a.sessionId])).rowCount ?? 0;
      await q.query("UPDATE admin_users SET sessions_revoked_at = now() WHERE instance_id = $1", [app.instanceId]);
      const change = (await q.query(
        "SELECT security_mode_set($1, 'advanced', $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 0) AS id",
        [app.instanceId, a.personId, a.sessionId, reason, JSON.stringify(before), JSON.stringify(after), keys, sessions])).rows[0]!.id as string;
      return { change, keys, sessions, before, after };
    });
  } catch (e) {
    if (e instanceof ReadinessChangedUnderLock) return c.json(READINESS_FAILED(e.failed.map((x) => ({ ...x, status: "fail" as const }))), 409);
    if (pgMessage(e).startsWith("security_mode_same")) return c.json(SM_ERRORS.same("advanced"), 409);
    if (pgMessage(e).startsWith(ROLES_NOT_SPLIT)) return c.json(SM_ERRORS.rolesNotSplit(pgMessage(e).slice(0, 600)), 409);
    if (pgCode(e) === "42501") return c.json(ROLE_FORBIDDEN, 403);
    throw e;
  } finally {
    await reloadAfterChange(app);
  }
  const { before, after } = out;
  for (const [path, v] of Object.entries(after))
    if (canonicalJson(before[path] ?? null) !== canonicalJson(v ?? null)) await audit(app, caller, { event_type: "admin", details: settingAuditDetails(app, path, before[path] ?? null, v) });
  await audit(app, caller, { event_type: "admin", details: { op: "security_mode", from: "basic", to: "advanced", change: out.change, keys_revoked: out.keys,
                                                              sessions_revoked: out.sessions, flags_before: before, flags_after: after } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "security_mode_enabled",
    summary: `Enabled advanced mode (${a.login}). System keys revoked: ${out.keys}, sessions revoked: ${out.sessions}`.slice(0, 300),
    details: { keys_revoked: out.keys, sessions_revoked: out.sessions, admin_login: a.login } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "strict_mode_enabled",
    summary: `Strict administration mode enabled (advanced, ${a.login})`.slice(0, 300),
    details: { admin_person: a.personId, admin_login: a.login, synonym_of: "security_mode_enabled" } });
  return c.json({ mode: "advanced", change: out.change, keys_revoked: out.keys, sessions_revoked: out.sessions });
}

async function hasKeys(app: App, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const r = await adminDb(app).query("SELECT 1 FROM admin_webauthn_credentials WHERE person_id = $1 AND instance_id = $2 AND disabled_at IS NULL LIMIT 1", [personId, app.instanceId]);
  return (r.rowCount ?? 0) > 0;
}

async function cancelApprovalsIn(q: pg.PoolClient, app: App): Promise<number> {
  const r = await q.query(
    "UPDATE admin_approvals SET cancelled_at = now(), body_enc = NULL WHERE instance_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL AND decision IS DISTINCT FROM 'rejected' RETURNING id",
    [app.instanceId]);
  return r.rowCount ?? 0;
}

export const ATTESTATION_KINDS: readonly string[] = ["profile_weakening", "device_binding", "it_instructions", "gitlab_protected", "human_signer", "docker_user_filter",
  "machine_keys_destroyed", "host_hardened",
  "bridge_vm", "edge_proxy_dedicated", "release_signers_human", "e5_hostile_bridge"];

const IF_KEYS_KINDS: ReadonlySet<string> = new Set(["profile_weakening", "e5_hostile_bridge"]);

export function signerFingerprint(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/^sha256:/, "").replace(/:/g, "");
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

export async function attestationSubjects(app: App, kind: string, raw: readonly string[]): Promise<{ subjects: string[] } | { error: string }> {
  if (kind === "device_binding") {
    const logins = raw.map((x) => x.toLowerCase());
    const rows = (await adminDb(app).query(
      `SELECT lower(p.login) AS login, p.id::text AS id FROM people p
        WHERE p.instance_id = $1 AND p.active AND lower(p.login) = ANY($2::text[])
          AND EXISTS (SELECT 1 FROM role_grants g WHERE g.person_id = p.id AND g.instance_id = $1 AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL
                        AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()))`, [app.instanceId, logins])).rows as Array<{ login: string; id: string }>;
    const byLogin = new Map(rows.map((r) => [r.login, r.id]));
    const unknown = raw.filter((x) => !byLogin.has(x.toLowerCase()));
    if (unknown.length) return { error: `Not a memory administrator: ${unknown.slice(0, 5).join(", ")}. Confirm key binding using the administrator’s login` };
    return { subjects: [...new Set(logins.map((l) => byLogin.get(l)!))] };
  }
  if (kind === "human_signer") {
    const bad = raw.filter((x) => !signerFingerprint(x));
    if (bad.length) return { error: "Identify a human signer by their key’s sha256 fingerprint: 64 hexadecimal characters (optionally prefixed with “sha256:”)" };
    return { subjects: [...new Set(raw.map((x) => signerFingerprint(x)!))] };
  }
  if (kind === "profile_weakening") {
    const unknown = raw.filter((k) => !app.settings.meta(k).exists);
    if (unknown.length) return { error: `Unknown setting: ${unknown.slice(0, 5).join(", ")}` };
    return { subjects: [...new Set(raw)] };
  }
  if (kind === "bridge_vm") {
    const hosts = raw.map((x) => bridgeSubjectHost(x));
    if (hosts.some((h) => !h)) return { error: "Use the bridge VM host from edge.bridge_url (name or address, optionally https://…:8445)" };
    const local = hosts.filter((h) => bridgeHostLocal(h!));
    if (local.length) return { error: `This is the host of the current VM. Use the bridge VM host: ${local.slice(0, 3).join(", ")}` };
    return { subjects: [...new Set(hosts as string[])] };
  }
  return { subjects: [...new Set(raw)] };
}

export async function mailAdminsDowngrade(app: App, pendingId: string, by: string, notBefore: string | null): Promise<number> {
  if (app.settings.get<unknown>("smtp.enabled", false) !== true) return 0;
  const already = new Set((app.settings.get<unknown>("admin.alert_recipients", []) as unknown[]).map((x) => String(x).trim().toLowerCase()));
  const rows = (await adminDb(app).query(
    `SELECT DISTINCT lower(p.login) AS login FROM people p JOIN role_grants g ON g.person_id = p.id AND g.instance_id = p.instance_id
      WHERE p.instance_id = $1 AND p.active AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now())`,
    [app.instanceId])).rows as Array<{ login: string }>;
  const subject = "{product}: request to return the security mode to basic";
  const text = [`Administrator ${by} requested a return from advanced to basic security mode.`,
                `The request can be executed only after ${notBefore ? `${notBefore.slice(0, 16).replace("T", " ")} UTC` : "the end of the delay"} and after another administrator signs it.`,
                "If you do not know about this request, cancel it in the admin panel (section “Security mode”) or with the command security-mode cancel-downgrade."].join("\n\n");
  let n = 0;
  for (const { login } of rows) {
    if (!MAIL_RE.test(login) || already.has(login)) continue;
    const r = await enqueueMail(app.db.control, app.instanceId, { to: login, subject, text, kind: "alert", dedupeKey: `security_mode_downgrade:${pendingId}:${login}`, createdBy: "gateway:security_mode" });
    if (r.created) n++;
  }
  return n;
}

export function securityModeRoutes(app: App): Hono {
  const r = new Hono<Env>();
  r.get("/api/v1/admin/security-mode", async (c) => c.json(await securityModeState(app)));
  r.post("/api/v1/admin/security-mode", (c) => enableAdvanced(app, c));
  r.post("/api/v1/admin/strict-mode", (c) => enableAdvanced(app, c));

  r.post("/api/v1/admin/security-mode/downgrade", async (c) => {
    const a = humanAdmin(app, c, { fresh: true });
    if (a instanceof Response) return a;
    const b = await c.req.json().catch(() => ({})) as { reason?: unknown };
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    const reasonLength = [...reason].length;
    if (reasonLength < DOWNGRADE_REASON_MIN || reasonLength > 500)
      return c.json({ code: "invalid_argument", message: `The reason for returning must be ${DOWNGRADE_REASON_MIN} to 500 characters` }, 400);
    if (await dbSecurityMode(app) !== "advanced") return c.json(SM_ERRORS.same("basic"), 409);
    let id: string;
    try {
      id = (await adminDb(app).query("SELECT id FROM security_mode_request_downgrade($1, $2, $3, $4)", [app.instanceId, a.personId, a.sessionId, reason])).rows[0]!.id as string;
    } catch (e) {
      if (pgCode(e) === "23505") return c.json(SM_ERRORS.pending, 409);
      if (pgMessage(e).startsWith("security_mode_not_advanced")) return c.json(SM_ERRORS.same("basic"), 409);
      if (pgCode(e) === "42501") return c.json(ROLE_FORBIDDEN, 403);
      throw e;
    }
    const row = (await adminDb(app).query(`${PENDING_SQL} WHERE p.id = $1`, [id])).rows[0] as Row;
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "security_mode_downgrade_request", pending: id, not_before: iso(row.not_before) } });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "security_mode_downgrade_requested",
      summary: `Request to return to basic by ${a.login}. Execute at or after ${iso(row.not_before)?.slice(0, 16).replace("T", " ")} UTC, once another administrator signs it`.slice(0, 300),
      details: { pending: id, admin_login: a.login } });
    await mailAdminsDowngrade(app, id, a.login, iso(row.not_before)).catch((e: unknown) => log.warn("security_mode_downgrade_mail_failed", { error: pgMessage(e).slice(0, 160) }));
    return c.json(pendingView(row), 201);
  });

  r.post("/api/v1/admin/security-mode/downgrade/:id/approve", async (c) => {
    const a = humanAdmin(app, c, { fresh: true });
    if (a instanceof Response) return a;
    const id = c.req.param("id");
    if (!isUuidParam(id)) return c.json(SM_ERRORS.notFound, 404);
    const row = (await adminDb(app).query(`${PENDING_SQL} WHERE p.id = $1 AND p.instance_id = $2`, [id, app.instanceId])).rows[0] as Row | undefined;
    if (!row) return c.json(SM_ERRORS.notFound, 404);
    if (row.requested_by === a.personId) return c.json(SM_ERRORS.self, 409);
    let signed = false;
    try { signed = (await adminDb(app).query("SELECT security_mode_approve_downgrade($1, $2, $3, $4) AS ok", [app.instanceId, id, a.personId, a.sessionId])).rows[0]?.ok === true; }
    catch (e) { if (pgCode(e) === "42501") return c.json(ROLE_FORBIDDEN, 403); throw e; }
    if (!signed) return c.json(SM_ERRORS.state, 409);
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "security_mode_downgrade_approve", pending: id } });
    return c.json(pendingView((await adminDb(app).query(`${PENDING_SQL} WHERE p.id = $1`, [id])).rows[0] as Row));
  });

  r.post("/api/v1/admin/security-mode/downgrade/:id/approve-retire", async (c) => {
    const a = humanAdmin(app, c, { fresh: true });
    if (a instanceof Response) return a;
    const id = c.req.param("id");
    if (!isUuidParam(id)) return c.json(SM_ERRORS.notFound, 404);
    const row = (await adminDb(app).query(`${PENDING_SQL} WHERE p.id = $1 AND p.instance_id = $2`, [id, app.instanceId])).rows[0] as Row | undefined;
    if (!row) return c.json(SM_ERRORS.notFound, 404);
    const verified = currentAnchors();
    const vSerial = verified.retired === true && typeof verified.serial === "number" ? verified.serial : null;
    const vSha = vSerial !== null && typeof verified.sha256 === "string" ? verified.sha256 : null;
    let serial: number | null = null;
    try {
      const v = (await adminDb(app).query("SELECT security_mode_approve_downgrade_retire($1, $2, $3, $4, $5, $6) AS s",
        [app.instanceId, id, a.personId, a.sessionId, vSerial, vSha])).rows[0]?.s;
      serial = v === null || v === undefined ? null : Number(v);
    } catch (e) {
      const m = pgMessage(e);
      if (pgCode(e) === "42501") return c.json(ROLE_FORBIDDEN, 403);
      if (m.startsWith("retire_not_needed")) return c.json(SM_ERRORS.retireNotNeeded, 409);
      if (m.startsWith("retire_unverified")) return c.json(SM_ERRORS.retireUnverified, 409);
      if (m.startsWith("retire_unconfirmed")) return c.json(SM_ERRORS.retireUnconfirmed, 409);
      if (m.startsWith("retire_missing")) return c.json(SM_ERRORS.retireMissing, 409);
      if (m.startsWith("retire_stale")) return c.json(SM_ERRORS.retireStale, 409);
      if (m.startsWith("retire_used") || pgCode(e) === "23505") return c.json(SM_ERRORS.retireUsed, 409);
      throw e;
    }
    if (serial === null) return c.json(SM_ERRORS.state, 409);
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "security_mode_downgrade_approve", pending: id, via: "retire", anchors_serial: serial } });
    return c.json(pendingView((await adminDb(app).query(`${PENDING_SQL} WHERE p.id = $1`, [id])).rows[0] as Row));
  });

  r.post("/api/v1/admin/security-mode/downgrade/:id/cancel", async (c) => {
    const a = c.get("caller")?.admin;
    if (!a || a.role !== "memory_admin" || !a.personId) return c.json(ROLE_FORBIDDEN, 403);
    const id = c.req.param("id");
    if (!isUuidParam(id)) return c.json(SM_ERRORS.notFound, 404);
    let n = 0;
    try { n = Number((await adminDb(app).query("SELECT security_mode_cancel_downgrade($1, $2, $3, 'admin') AS n", [app.instanceId, id, a.personId])).rows[0]?.n ?? 0); }
    catch (e) { if (pgCode(e) === "42501") return c.json(ROLE_FORBIDDEN, 403); throw e; }
    if (n) {
      await audit(app, c.get("caller"), { event_type: "admin", details: { op: "security_mode_downgrade_cancel", pending: id, via: "admin" } });
      await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "medium", code: "security_mode_downgrade_cancelled",
        summary: `Canceled the request to return to basic (${a.login})`, details: { pending: id, admin_login: a.login } });
    }
    return c.json({ cancelled: n });
  });

  r.post("/api/v1/admin/security-mode/downgrade/:id/execute", async (c) => {
    const a = humanAdmin(app, c, { fresh: true });
    if (a instanceof Response) return a;
    const id = c.req.param("id");
    if (!isUuidParam(id)) return c.json(SM_ERRORS.notFound, 404);
    const row = (await adminDb(app).query(`${PENDING_SQL} WHERE p.id = $1 AND p.instance_id = $2`, [id, app.instanceId])).rows[0] as Row | undefined;
    if (!row) return c.json(SM_ERRORS.notFound, 404);
    if (row.requested_by !== a.personId && row.approved_by !== a.personId) return c.json(ROLE_FORBIDDEN, 403);
    if (row.cancelled_at || row.executed_at) return c.json(SM_ERRORS.state, 409);
    if (!pendingSigned(row) || new Date(row.not_before as string).getTime() > Date.now()) return c.json(SM_ERRORS.notReady, 409);
    const unverified = await anchorsUnverified(app);
    if (unverified) return c.json((currentAnchors() as { reason?: string }).reason === "disabled" ? SM_ERRORS.anchorsDisabled : SM_ERRORS.anchorsUnverified, 409);
    if (securityModeFloor() === "advanced") return c.json(SM_ERRORS.floor, 409);
    const nowValues = flagValues((p) => app.settings.rawValue(p) ?? app.settings.meta(p).defaultValue);
    let out: { change: string; restored: string[]; values: Record<string, unknown>; approvals: number };
    try {
      out = await tx(adminDb(app), async (q) => {
        await q.query(SECURITY_MODE_LOCK_SQL, [app.instanceId]);
        const approvals = await cancelApprovalsIn(q, app);
        const last = (await q.query("SELECT flags_before FROM security_mode_changes WHERE instance_id = $1 AND to_mode = 'advanced' ORDER BY seq DESC LIMIT 1",
          [app.instanceId])).rows[0]?.flags_before as Record<string, unknown> | undefined ?? {};
        const restore = ADVANCED_SET_VALUES.map((v) => `${v.category}.${v.key}`).filter((k) => Object.hasOwn(last, k) && canonicalJson(last[k] ?? null) !== canonicalJson(nowValues[k] ?? null));
        const settings = app.settings.withDatabase(q);
        await settings.load(true);
        if (restore.length)
          await settings.setMany(restore.map((k) => { const [category, key] = [k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1)]; return { category: category as "admin", key, value: last[k] ?? null }; }),
                                 { updatedBy: a.personId });
        await q.query("SELECT set_config('memory.approval_id', $1, true)", [id]);
        const values = Object.fromEntries(restore.map((k) => [k, last[k] ?? null]));
        const change = (await q.query("SELECT security_mode_set($1, 'basic', $2, $3, $4, $5::jsonb, $6::jsonb, 0, 0, $7) AS id",
          [app.instanceId, a.personId, a.sessionId, String(row.reason).slice(0, 500), JSON.stringify(nowValues),
           JSON.stringify({ ...nowValues, ...values }), approvals])).rows[0]!.id as string;
        return { change, restored: restore, values, approvals };
      });
    } catch (e) {
      if (pgMessage(e).startsWith("security_mode_unsigned")) return c.json(SM_ERRORS.notReady, 409);
      if (pgMessage(e).startsWith("security_mode_same")) return c.json(SM_ERRORS.same("basic"), 409);
      if (pgMessage(e).startsWith("floor_advanced")) return c.json(SM_ERRORS.floor, 409);
      throw e;
    } finally {
      await reloadAfterChange(app);
    }
    const caller = c.get("caller");
    for (const k of out.restored)
      await audit(app, caller, { event_type: "admin", details: settingAuditDetails(app, k, nowValues[k] ?? null, out.values[k] ?? null) });
    await audit(app, caller, { event_type: "admin", details: { op: "security_mode", from: "advanced", to: "basic", change: out.change, pending: id,
                                                                flags_restored: out.restored, approvals_cancelled: out.approvals, cancelled_reason: "mode_changed" } });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "security_mode_disabled",
      summary: `Returned the mode to basic (${a.login}). Second-signature requests canceled: ${out.approvals}`.slice(0, 300),
      details: { pending: id, approvals_cancelled: out.approvals, admin_login: a.login } });
    return c.json({ mode: "basic", change: out.change, flags_restored: out.restored, approvals_cancelled: out.approvals });
  });

  r.post("/api/v1/admin/security-attestations", async (c) => {
    const pre = c.get("caller")?.admin;
    const b = await c.req.json().catch(() => null) as { kind?: unknown; subjects?: unknown; note?: unknown; digests?: unknown } | null;
    const ifKeys = typeof b?.kind === "string" && IF_KEYS_KINDS.has(b.kind);
    const a = humanAdmin(app, c, ifKeys ? { fresh: "if_keys", hasKeys: await hasKeys(app, pre?.personId ?? null) } : { fresh: true });
    if (a instanceof Response) return a;
    if (!b || typeof b.kind !== "string" || !ATTESTATION_KINDS.includes(b.kind) || !Array.isArray(b.subjects) || !b.subjects.length || b.subjects.length > 50
        || !b.subjects.every((x) => typeof x === "string" && x.trim().length >= 1 && x.length <= 300) || (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 300))
        || (b.digests !== undefined && (typeof b.digests !== "object" || b.digests === null || Array.isArray(b.digests))))
      return c.json({ code: "invalid_argument", message: "Confirmation: kind from the list, subjects with 1–50 strings of up to 300 characters each, note up to 300 characters, and digests mapping each key to its fingerprint" }, 400);
    const kind = b.kind;
    const resolved = await attestationSubjects(app, kind, (b.subjects as string[]).map((x) => x.trim()));
    if ("error" in resolved) return c.json({ code: "invalid_argument", message: resolved.error }, 400);
    const subjects = resolved.subjects;
    let shas = new Map<string, string>();
    if (kind === "profile_weakening") {
      const seen = (b.digests ?? {}) as Record<string, unknown>;
      const blind = subjects.filter((k) => !Object.hasOwn(seen, k) || typeof seen[k] !== "string" || !/^[0-9a-fA-F]{64}$/.test(seen[k] as string));
      if (blind.length) return c.json({ code: "invalid_argument", message: `Confirm the value shown. A fingerprint is missing for ${blind.slice(0, 5).join(", ")}. Use the confirmation button in “Readiness” to see and confirm the value`,
                                        details: { keys: blind } }, 400);
      await app.settings.load(true);
      shas = new Map(subjects.map((k) => [k, profileDigest(app.appSecret, k, app.settings.effective(k), app.settings.meta(k).secret)]));
      const stale = subjects.filter((k) => Object.hasOwn(seen, k) && String(seen[k]).toLowerCase() !== shas.get(k));
      if (stale.length) return c.json({ code: "attestation_stale", message: `The value changed since you saw it: ${stale.slice(0, 5).join(", ")}. Refresh the page and confirm again`,
                                        details: { keys: stale } }, 409);
    }
    let n = 0;
    try {
      await tx(adminDb(app), async (q) => {
        for (const subject of subjects) {
          const sha = shas.has(subject) ? Buffer.from(shas.get(subject)!, "hex") : null;
          await q.query("SELECT security_attest($1, $2, $3, $4, $5, $6, $7)", [app.instanceId, kind, subject, sha, a.personId, a.sessionId, typeof b.note === "string" ? b.note : null]);
          n++;
        }
      });
    } catch (e) { if (pgCode(e) === "42501") return c.json(ROLE_FORBIDDEN, 403); throw e; }
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "security_attest", kind, count: n, ...(kind === "profile_weakening" ? { keys: subjects.slice(0, 50) } : {}) } });
    return c.json({ attested: n, subjects }, 201);
  });

  r.get("/api/v1/admin/admins", async (c) => {
    const db = adminDb(app);
    const rows = (await db.query(
      `SELECT p.id AS person_id, p.login, p.display_name, g.role_code AS role, g.valid_from AS granted_at,
              (SELECT count(*)::int FROM admin_webauthn_credentials w WHERE w.person_id = p.id AND w.instance_id = $1 AND w.disabled_at IS NULL) AS keys,
              (SELECT count(*)::int FROM admin_webauthn_credentials w WHERE w.person_id = p.id AND w.instance_id = $1 AND w.disabled_at IS NULL AND w.backup_eligible IS FALSE) AS keys_bound,
              s.created_at AS last_login_at, s.auth_method AS last_login_method
         FROM role_grants g JOIN people p ON p.id = g.person_id AND p.instance_id = g.instance_id
         LEFT JOIN LATERAL (SELECT created_at, auth_method FROM admin_sessions x WHERE x.person_id = p.id AND x.instance_id = $1 AND x.parent_session_id IS NULL
                             ORDER BY created_at DESC LIMIT 1) s ON true
        WHERE g.instance_id = $1 AND g.role_code IN ('memory_admin', 'security_auditor') AND g.revoked_at IS NULL
          AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()) AND p.active
        ORDER BY g.role_code, p.login LIMIT 200`, [app.instanceId])).rows as Row[];
    const local = (await db.query(
      "SELECT login, last_login_at FROM admin_users WHERE instance_id = $1 AND disabled_at IS NULL ORDER BY login LIMIT 50", [app.instanceId]).catch((e: unknown) => {
      log.warn("admins_local_failed", { error: pgMessage(e).slice(0, 160) }); return { rows: [] as Row[] }; })).rows as Row[];
    return c.json({
      items: rows.map((x) => ({ person_id: x.person_id, login: x.login, display_name: x.display_name, role: x.role, granted_at: iso(x.granted_at), keys: Number(x.keys ?? 0),
                                keys_bound: Number(x.keys_bound ?? 0), last_login_at: iso(x.last_login_at), last_login_method: (x.last_login_method as string | null) ?? null })),
      local_admins: local.map((x) => ({ login: x.login, last_login_at: iso(x.last_login_at) })),
    });
  });
  return r as unknown as Hono;
}
