import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  assertionOptions, b64url, canonicalObjectGuid, ChallengeStore, credentialIdOf, currentAnchors, deviceBoundKey, effectiveMode, log, newChallenge, newId, publicKeySha256, raiseAlert,
  registrationOptions, verifyAssertion, verifyRegistration, WebAuthnError, type AuthMethod, type Settings, type UserVerification,
} from "@memory/shared";
import type { AdminCaller, App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { adminDb } from "./db.ts";
import { STEPUP_REQUIRED } from "./responses.ts";
import { freshUv, stepUp } from "./session.ts";
import { adminNow } from "./test-clock.ts";

export interface WebauthnSettings { rpId: string; origins: string[]; uv: UserVerification; requireUv: boolean; minKeys: number; required: boolean }

export function webauthnSettings(app: { settings: Pick<Settings, "get"> }): WebauthnSettings {
  const rpId = String(app.settings.get<unknown>("admin.webauthn_rp_id", "") ?? "").trim().toLowerCase();
  const raw = app.settings.get<unknown>("admin.webauthn_origins", []);
  const origins = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean) : [];
  const uv: UserVerification = app.settings.get<unknown>("admin.webauthn_uv", "required") === "preferred" ? "preferred" : "required";
  const min = Math.trunc(Number(app.settings.get<unknown>("admin.webauthn_min_keys", 2)));
  return { rpId, origins, uv, requireUv: uv === "required", minKeys: Number.isFinite(min) && min >= 1 ? Math.min(min, 5) : 2,
           required: app.settings.get<unknown>("admin.webauthn_required", false) === true };
}

export function webauthnProblems(w: Pick<WebauthnSettings, "rpId" | "origins">): string[] {
  const out: string[] = [];
  if (!w.rpId) out.push("admin.webauthn_rp_id: the admin panel hostname is unset");
  if (!w.origins.length) out.push("admin.webauthn_origins: no admin panel origins are configured");
  for (const o of w.origins) {
    let host = "";
    try { host = new URL(o).hostname.toLowerCase(); } catch { out.push(`admin.webauthn_origins: “${o.slice(0, 80)}” is not an address`); continue; }
    if (w.rpId && host !== w.rpId && !host.endsWith(`.${w.rpId}`)) out.push(`admin.webauthn_origins: “${o.slice(0, 80)}” is not on the hostname ${w.rpId}`);
  }
  return out;
}

export interface CredentialRow {
  id: string; person_id: string; credential_id: Buffer; public_key: Buffer; alg: number; sign_count: number; user_handle: Buffer;
  transports: string[]; label: string | null; created_at: Date; last_used_at: Date | null; disabled_at: Date | null; backup_eligible: boolean | null;
}
const CRED_COLS = "id, person_id, credential_id, public_key, alg, sign_count, user_handle, transports, label, created_at, last_used_at, disabled_at, backup_eligible";
const rowOf = (x: Record<string, unknown>): CredentialRow => ({ ...(x as unknown as CredentialRow), sign_count: Number(x.sign_count ?? 0), transports: (x.transports as string[] | null) ?? [] });

export async function activeCredentials(app: App, personId: string): Promise<CredentialRow[]> {
  const r = await adminDb(app).query(
    `SELECT ${CRED_COLS} FROM admin_webauthn_credentials WHERE person_id = $1 AND instance_id = $2 AND disabled_at IS NULL ORDER BY created_at`,
    [personId, app.instanceId]);
  return (r.rows as Array<Record<string, unknown>>).map(rowOf);
}

export async function usableCredentials(app: App, personId: string, guid: string | null): Promise<CredentialRow[]> {
  const all = await activeCredentials(app, personId);
  const rows = effectiveMode(app.settings) === "advanced" ? all.filter((r) => deviceBoundKey(r.backup_eligible)) : all;
  const a = currentAnchors();
  const listed = a.inForce ? (a.admin?.webauthn ?? []) : [];
  if (!listed.length) return rows;
  const mine = listed.filter((w) => guid && canonicalObjectGuid(String(w.ldap_id).trim().replace(/^\{|\}$/g, "")) === guid);
  return rows.filter((r) => mine.some((w) => w.credential_id === b64url(r.credential_id) && w.public_key_sha256.toLowerCase() === publicKeySha256(r.public_key)));
}

async function guidOfPerson(app: App, personId: string): Promise<string | null> {
  const r = await adminDb(app).query(
    "SELECT external_id FROM person_identities WHERE person_id = $1 AND system = 'ad' AND active AND verified ORDER BY created_at LIMIT 1", [personId]);
  const x = r.rows[0] as { external_id?: string } | undefined;
  return x?.external_id ? canonicalObjectGuid(String(x.external_id).trim().replace(/^\{|\}$/g, "")) : null;
}

const descriptorsOf = (rows: CredentialRow[]) => rows.map((r) => ({ id: Buffer.from(r.credential_id), transports: r.transports }));

async function disableKey(app: App, id: string, reason: "owner" | "admin" | "clone", by: string | null): Promise<boolean> {
  const r = await adminDb(app).query(
    `UPDATE admin_webauthn_credentials SET disabled_at = $3, disabled_by = $4, disabled_reason = $5
      WHERE id = $1 AND instance_id = $2 AND disabled_at IS NULL RETURNING id`, [id, app.instanceId, adminNow(), by, reason]);
  return (r.rowCount ?? 0) > 0;
}

async function disableClone(app: App, row: CredentialRow, login: string | null): Promise<void> {
  if (!(await disableKey(app, row.id, "clone", null))) return;
  log.warn("webauthn_clone", { login, credential: row.id });
  await audit(app, null, { event_type: "admin", details: { op: "webauthn_remove", credential: row.id, reason: "clone" } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
    instanceId: app.instanceId, level: "high", code: "webauthn_clone",
    summary: `The key for administrator ${login ?? "?"} appears to be a copy. Its signature counter did not increase, so the key was disabled`,
    details: { admin_person: row.person_id, credential: row.id }, dedupeKey: `webauthn_clone:${row.id}` });
}

export type AssertOutcome = { ok: true; row: CredentialRow; uv: boolean } | { ok: false; step: string; code?: string };

export const counterSnapshot = (rows: CredentialRow[]): Map<string, number> => new Map(rows.map((r) => [r.id, r.sign_count]));

export async function checkAssertion(app: App, o: { credential: unknown; challenge: Buffer; rows: CredentialRow[]; login: string | null;
                                                    counters?: ReadonlyMap<string, number> }): Promise<AssertOutcome> {
  const w = webauthnSettings(app);
  const id = credentialIdOf(o.credential);
  const row = id ? o.rows.find((r) => Buffer.from(r.credential_id).equals(id)) : undefined;
  if (!row) return { ok: false, step: "credential" };
  const stored = Math.min(o.counters?.get(row.id) ?? row.sign_count, row.sign_count);
  let v: { signCount: number; uv: boolean };
  try {
    v = verifyAssertion({ credential: o.credential, challenge: o.challenge, origins: w.origins, rpId: w.rpId, requireUv: w.requireUv,
                          stored: { credentialId: Buffer.from(row.credential_id), publicKey: Buffer.from(row.public_key), alg: row.alg, signCount: stored, userHandle: Buffer.from(row.user_handle) } });
  } catch (e) {
    if (!(e instanceof WebAuthnError)) throw e;
    if (e.code === "counter_rollback") await disableClone(app, row, o.login);
    log.info("webauthn_assert_failed", { login: o.login, credential: row.id, code: e.code });
    return { ok: false, step: "verify", code: e.code };
  }
  const u = await adminDb(app).query(
    `UPDATE admin_webauthn_credentials SET sign_count = $3, last_used_at = $4
      WHERE id = $1 AND instance_id = $2 AND disabled_at IS NULL AND (sign_count < $3 OR ($3 = 0 AND sign_count = 0)) RETURNING id`,
    [row.id, app.instanceId, v.signCount, adminNow()]);
  if (!u.rowCount) {
    log.info("webauthn_assert_failed", { login: o.login, credential: row.id, code: "counter_race" });
    return { ok: false, step: "counter", code: "counter_race" };
  }
  return { ok: true, row, uv: v.uv };
}

export async function webauthnRpChangeProblem(app: App, next: unknown): Promise<string | null> {
  const now = webauthnSettings(app).rpId;
  const want = String(next ?? "").trim().toLowerCase();
  if (!now || want === now) return null;
  const r = await adminDb(app).query(
    "SELECT count(*)::int AS n, count(DISTINCT person_id)::int AS people FROM admin_webauthn_credentials WHERE instance_id = $1 AND disabled_at IS NULL",
    [app.instanceId]);
  const n = Number(r.rows[0]?.n ?? 0), people = Number(r.rows[0]?.people ?? 0);
  return n ? `WebAuthn keys for admin panel hostname ${now}: ${n} (people: ${people}). Changing admin.webauthn_rp_id invalidates all these keys, and their `
           + "owners cannot sign in without a key. First turn off admin.webauthn_required and arrange to register new keys. Sign in using emergency access" : null;
}

type Env = { Variables: { caller: Caller } };
type SessionAdmin = AdminCaller & { sessionId: string };

const SESSION_EXPIRED = { code: "session_expired", message: "The administrator session has ended. Sign in again" } as const;
const WEBAUTHN_FAILED = { code: "webauthn_failed", message: "The security key did not confirm the sign-in. Try again" } as const;
const NO_CARD = { code: "conflict", message: "WebAuthn keys belong to a person’s profile, and this admin@local account has no profile" } as const;
const NOT_SSO = { code: "conflict", message: "Sign in with your company account through the identity provider to register and delete your own keys. The admin@local sign-in and tool sessions cannot do this" } as const;
const OWN_KEY_HERE = { code: "conflict", message: "Delete your own key through DELETE /api/v1/admin-auth/webauthn/credentials/{id} (the “WebAuthn keys” page)" } as const;
const SSO_METHODS: ReadonlySet<AdminCaller["authMethod"]> = new Set<AuthMethod>(["sso", "sso_webauthn", "sso_breakglass"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_KEYS_PER_PERSON = 10;

interface SessionChallenge { kind: "register" | "stepup"; sessionId: string; personId: string; challenge: Buffer; userHandle?: Buffer; counters?: Map<string, number> }
export const sessionChallenges = new ChallengeStore<SessionChallenge>(5 * 60_000, 10_000);

const sessionOf = (c: Context<Env>): SessionAdmin | null => {
  const a = c.get("caller")?.admin;
  return a?.sessionId ? (a as SessionAdmin) : null;
};
const bodyOf = async (c: Context<Env>): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
};

export function labelOf(v: unknown): { ok: true; label: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, label: null };
  if (typeof v !== "string") return { ok: false };
  const s = v.trim();
  if (!s) return { ok: true, label: null };
  return s.length <= 60 && !/[\u0000-\u001f\u007f\p{Cf}]/u.test(s) ? { ok: true, label: s } : { ok: false };
}

const credentialView = (r: CredentialRow) => ({
  id: r.id, label: r.label, created_at: new Date(r.created_at).toISOString(), last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  disabled_at: r.disabled_at ? new Date(r.disabled_at).toISOString() : null, transports: r.transports, backup_eligible: r.backup_eligible,
});

const sessionInfo = (c: Context<Env>, a: SessionAdmin, uvAt: Date | null) => {
  const exp = c.get("caller").expiresAt;
  return { session_id: a.sessionId, person_id: a.personId, login: a.login, role: a.role, auth_method: a.authMethod,
           uv_at: uvAt ? uvAt.toISOString() : null, expires_at: exp ? new Date(exp).toISOString() : null, breakglass: a.breakglassWindowId !== null };
};

async function userHandleOf(app: App, personId: string): Promise<Buffer> {
  const r = await adminDb(app).query("SELECT user_handle FROM admin_webauthn_credentials WHERE person_id = $1 AND instance_id = $2 ORDER BY created_at LIMIT 1",
    [personId, app.instanceId]);
  const h = r.rows[0]?.user_handle as Buffer | undefined;
  return h && h.length ? Buffer.from(h) : randomBytes(32);
}

const adminAudit = (app: App, c: Context<Env>, op: string, details: Record<string, unknown>) =>
  audit(app, c.get("caller"), { event_type: "admin", details: { op, ...details } });
const failed = async (app: App, c: Context<Env>, a: SessionAdmin, step: string, code?: string) => {
  await audit(app, c.get("caller"), { event_type: "auth_failure", details: { reason: "webauthn_failed", login: a.login, step, ...(code ? { code } : {}) } });
  return c.json(WEBAUTHN_FAILED, 401);
};

export function webauthnRoutes(app: App): Hono<Env> {
  const r = new Hono<Env>();

  r.post("/api/v1/admin-auth/stepup/options", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    if (!a.personId) return c.json(NO_CARD, 409);
    const w = webauthnSettings(app);
    const problems = webauthnProblems(w);
    if (problems.length) return c.json({ code: "conflict", message: `WebAuthn keys are not configured: ${problems.join("; ")}` }, 409);
    const rows = await usableCredentials(app, a.personId, await guidOfPerson(app, a.personId));
    if (!rows.length) return c.json({ code: "admin_webauthn_missing", message: "No security key is registered; recovery goes through the emergency access" }, 403);
    const challenge = newChallenge();
    const tx = sessionChallenges.put({ kind: "stepup", sessionId: a.sessionId, personId: a.personId, challenge, counters: counterSnapshot(rows) });
    return c.json({ tx, options: assertionOptions({ rpId: w.rpId, challenge, allow: descriptorsOf(rows), userVerification: w.uv }) });
  });

  r.post("/api/v1/admin-auth/stepup/verify", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    const b = await bodyOf(c);
    const p = sessionChallenges.take(b.tx);
    if (!p || p.kind !== "stepup" || p.sessionId !== a.sessionId) return failed(app, c, a, "stepup_tx");
    const rows = await usableCredentials(app, p.personId, await guidOfPerson(app, p.personId));
    const out = await checkAssertion(app, { credential: b.credential, challenge: p.challenge, rows, login: a.login, counters: p.counters });
    if (!out.ok) return failed(app, c, a, `stepup_${out.step}`, out.code);
    const uvAt = await stepUp(app, a.sessionId);
    if (!uvAt) return c.json(SESSION_EXPIRED, 401);
    await adminAudit(app, c, "stepup", { admin_session: a.sessionId });
    return c.json(sessionInfo(c, a, uvAt));
  });

  r.get("/api/v1/admin-auth/webauthn/credentials", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    if (!a.personId) return c.json({ items: [] });
    const q = await adminDb(app).query(
      `SELECT ${CRED_COLS} FROM admin_webauthn_credentials WHERE person_id = $1 AND instance_id = $2
        ORDER BY (disabled_at IS NULL) DESC, created_at DESC LIMIT 50`, [a.personId, app.instanceId]);
    return c.json({ items: (q.rows as Array<Record<string, unknown>>).map(rowOf).map(credentialView) });
  });

  r.post("/api/v1/admin-auth/webauthn/register/options", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    if (!a.personId) return c.json(NO_CARD, 409);
    if (!SSO_METHODS.has(a.authMethod)) return c.json(NOT_SSO, 409);
    const w = webauthnSettings(app);
    const problems = webauthnProblems(w);
    if (problems.length) return c.json({ code: "conflict", message: `WebAuthn keys are not configured: ${problems.join("; ")}` }, 409);
    const rows = await activeCredentials(app, a.personId);
    if (rows.length && !a.breakglassWindowId && !freshUv(app, a.uvAt)) return c.json(STEPUP_REQUIRED, 403);
    if (rows.length >= MAX_KEYS_PER_PERSON) return c.json({ code: "conflict", message: `You already have ${rows.length} keys and cannot register more. Delete a key you no longer need` }, 409);
    const challenge = newChallenge();
    const userHandle = await userHandleOf(app, a.personId);
    const tx = sessionChallenges.put({ kind: "register", sessionId: a.sessionId, personId: a.personId, challenge, userHandle });
    const advanced = effectiveMode(app.settings) === "advanced";
    return c.json({ tx, options: registrationOptions({ rpId: w.rpId, rpName: "Prisma Memory — admin panel", challenge, userVerification: w.uv,
      user: { id: userHandle, name: a.login, displayName: a.login }, exclude: descriptorsOf(rows), attestation: advanced ? "direct" : "none" }) });
  });

  r.post("/api/v1/admin-auth/webauthn/register/verify", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    if (!SSO_METHODS.has(a.authMethod)) return c.json(NOT_SSO, 409);
    const b = await bodyOf(c);
    const label = labelOf(b.label);
    if (!label.ok) return c.json({ code: "invalid_argument", message: "The key label must be a single line of up to 60 characters" }, 400);
    const p = sessionChallenges.take(b.tx);
    if (!p || p.kind !== "register" || p.sessionId !== a.sessionId || p.personId !== a.personId) return failed(app, c, a, "register_tx");
    const existing = await activeCredentials(app, p.personId);
    if (existing.length && !a.breakglassWindowId && !freshUv(app, a.uvAt)) return c.json(STEPUP_REQUIRED, 403);
    const w = webauthnSettings(app);
    let reg: ReturnType<typeof verifyRegistration>;
    try {
      reg = verifyRegistration({ credential: b.credential, challenge: p.challenge, origins: w.origins, rpId: w.rpId, requireUv: w.requireUv });
    } catch (e) {
      if (!(e instanceof WebAuthnError)) throw e;
      log.info("webauthn_register_failed", { login: a.login, code: e.code });
      return failed(app, c, a, "register", e.code);
    }
    if (reg.backupEligible && effectiveMode(app.settings) === "advanced") return failed(app, c, a, "register", "backup_eligible");
    const id = newId();
    try {
      await adminDb(app).query(
        `INSERT INTO admin_webauthn_credentials (id, instance_id, person_id, credential_id, public_key, alg, sign_count, user_handle, transports, aaguid,
                                                 backup_eligible, label, created_at, created_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, app.instanceId, p.personId, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, p.userHandle!, reg.transports, reg.aaguid,
         reg.backupEligible, label.label, adminNow(), a.sessionId]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return c.json({ code: "conflict", message: "This key is already registered" }, 409);
      throw e;
    }
    await adminAudit(app, c, "webauthn_register", { credential: id });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId: app.instanceId, level: a.breakglassWindowId ? "high" : "medium", code: "webauthn_key_added",
      summary: `Administrator ${a.login} registered a WebAuthn key${a.breakglassWindowId ? " during emergency access" : ""}`,
      details: { admin_person: p.personId, credential: id }, dedupeKey: `webauthn_key_added:${id}` });
    const row = (await adminDb(app).query(`SELECT ${CRED_COLS} FROM admin_webauthn_credentials WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
    return c.json(credentialView(rowOf(row)), 201);
  });

  r.delete("/api/v1/admin-auth/webauthn/credentials/:id", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    const id = c.req.param("id");
    if (!a.personId || !UUID_RE.test(id)) return c.json({ code: "not_found", message: "Key not found" }, 404);
    if (!SSO_METHODS.has(a.authMethod)) return c.json(NOT_SSO, 409);
    if (!a.breakglassWindowId && !freshUv(app, a.uvAt)) return c.json(STEPUP_REQUIRED, 403);
    const rows = await activeCredentials(app, a.personId);
    if (!rows.some((x) => x.id === id)) return c.json({ code: "not_found", message: "Key not found" }, 404);
    const w = webauthnSettings(app);
    const usable = await usableCredentials(app, a.personId, await guidOfPerson(app, a.personId));
    if (w.required && usable.some((x) => x.id === id) && usable.length - 1 < w.minKeys)
      return c.json({ code: "conflict", message: `This key cannot be deleted. When a key is required, the administrator must keep at least ${w.minKeys} keys (admin.webauthn_min_keys). Register a replacement first` }, 409);
    if (!(await disableKey(app, id, "owner", a.personId))) return c.json({ code: "not_found", message: "Key not found" }, 404);
    await adminAudit(app, c, "webauthn_remove", { credential: id, reason: "owner" });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId: app.instanceId, level: "high", code: "webauthn_key_removed", summary: `Administrator ${a.login} deleted their WebAuthn key`,
      details: { admin_person: a.personId, credential: id, reason: "owner" }, dedupeKey: `webauthn_key_removed:${id}` });
    return c.body(null, 204);
  });

  r.patch("/api/v1/admin-auth/webauthn/credentials/:id", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(SESSION_EXPIRED, 401);
    const id = c.req.param("id");
    if (!a.personId || !UUID_RE.test(id)) return c.json({ code: "not_found", message: "Key not found" }, 404);
    if (!SSO_METHODS.has(a.authMethod)) return c.json(NOT_SSO, 409);
    const b = await bodyOf(c);
    const extra = Object.keys(b).filter((k) => k !== "label");
    if (!("label" in b) || extra.length) return c.json({ code: "invalid_argument", message: "Request body: {label}, a single-line key label of up to 60 characters, or null" }, 400);
    const label = labelOf(b.label);
    if (!label.ok) return c.json({ code: "invalid_argument", message: "The key label must be a single line of up to 60 characters" }, 400);
    const row = (await adminDb(app).query(
      `UPDATE admin_webauthn_credentials SET label = $4 WHERE id = $1 AND person_id = $2 AND instance_id = $3 AND disabled_at IS NULL RETURNING ${CRED_COLS}`,
      [id.toLowerCase(), a.personId, app.instanceId, label.label])).rows[0] as Record<string, unknown> | undefined;
    if (!row) return c.json({ code: "not_found", message: "Key not found" }, 404);
    await adminAudit(app, c, "webauthn_label", { credential: row.id });
    return c.json(credentialView(rowOf(row)));
  });

  r.get("/api/v1/admin/webauthn/coverage", async (c) => {
    const q = await adminDb(app).query(
      `SELECT p.id AS person_id, p.login, array_agg(DISTINCT g.role_code) AS roles,
              (SELECT count(*)::int FROM admin_webauthn_credentials w WHERE w.person_id = p.id AND w.instance_id = $1 AND w.disabled_at IS NULL) AS active_keys
         FROM role_grants g JOIN people p ON p.id = g.person_id AND p.instance_id = g.instance_id
        WHERE g.instance_id = $1 AND g.role_code IN ('memory_admin', 'security_auditor') AND g.revoked_at IS NULL
          AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()) AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'
        GROUP BY p.id, p.login ORDER BY p.login LIMIT 500`, [app.instanceId]);
    const items = (q.rows as Array<{ person_id: string; login: string; roles: string[]; active_keys: number }>).map((x) => ({
      person_id: x.person_id, login: x.login, role: x.roles.includes("memory_admin") ? "memory_admin" : "security_auditor", active_keys: Number(x.active_keys) }));
    return c.json({ min_keys: webauthnSettings(app).minKeys, items });
  });

  r.delete("/api/v1/admin/webauthn/credentials/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ code: "not_found", message: "Key not found" }, 404);
    const by = c.get("caller").admin;
    if (!by?.breakglassWindowId && !freshUv(app, by?.uvAt ?? null)) return c.json(STEPUP_REQUIRED, 403);
    const row = (await adminDb(app).query("SELECT person_id FROM admin_webauthn_credentials WHERE id = $1 AND instance_id = $2 AND disabled_at IS NULL",
      [id, app.instanceId])).rows[0] as { person_id: string } | undefined;
    if (!row) return c.json({ code: "not_found", message: "Key not found" }, 404);
    if (by?.personId && row.person_id === by.personId) return c.json(OWN_KEY_HERE, 409);
    if (!(await disableKey(app, id, "admin", by?.personId ?? null))) return c.json({ code: "not_found", message: "Key not found" }, 404);
    const left = (await activeCredentials(app, row.person_id)).length;
    const w = webauthnSettings(app);
    await adminAudit(app, c, "webauthn_remove", { credential: id, reason: "admin" });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId: app.instanceId, level: "high", code: "webauthn_key_removed",
      summary: `Administrator ${by?.login ?? "?"} disabled another person’s WebAuthn key. Keys remaining for the owner: ${left}`
        + (w.required && left < w.minKeys ? left ? ` — fewer than ${w.minKeys}. Ask the owner to register a replacement` : " — the owner can sign in only through emergency access" : ""),
      details: { admin_person: row.person_id, credential: id, reason: "admin" }, dedupeKey: `webauthn_key_removed:${id}` });
    return c.body(null, 204);
  });

  return r;
}
