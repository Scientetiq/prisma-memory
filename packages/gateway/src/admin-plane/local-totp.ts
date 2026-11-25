// Second factor of the local administrator (admin@local and other admin_users logins): one TOTP factor per login in
// admin_totp, ten one-time recovery codes, a lock after five wrong codes, the fact of the factor on the session, the
// "Readiness" item local_admin_factor and the daily alert local_admin_no_factor. Logic only — the routes live elsewhere.
//
// Every query goes through the gateway's own pool (app.db.control): the default install has no admin listener and no
// memory_admin_plane pool, and its sign-in must still ask for the code.
//   - The secret is encrypted with the settings keyring (the protection of ldap.bind_password): {kid, ct, iv}, and the
//     plaintext names the login — a row copied to another login does not open (it fails as "factor unavailable").
//   - Recovery codes: 10 × 16 base32 characters (80 bits), shown XXXX-XXXX-XXXX-XXXX once; stored as SHA-256 of the login and
//     the code, removed by the UPDATE that accepts them.
//   - A code is checked under the row lock (SELECT … FOR UPDATE): a replayed step, a recovery code used twice in parallel
//     and 30 parallel sign-ins with one valid code give one success. A failure is committed (never thrown): the counter
//     survives the refusal.
//   - Nothing here logs or returns a secret, a code or a hash except the enrolment / reset answers that show them once.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { normalizeHumanCode, newTotpSecret, otpauthUri, qrSvg, secretText, TOTP_CODE_INPUT_MAX, totpCodeDigits, totpVerify } from "@memory/shared/factor";
import { decryptWithKey, encryptWithKey, log, raiseAlert, settingsKeyring, tx, txOn, type SettingsKeyring } from "@memory/shared";
import type { App } from "../context.ts";
import { lockPoolTimeout } from "../control-lock.ts";
import type { SessionFactor } from "../session.ts";
import type { ReadinessCheck } from "./readiness.ts";

/** A pending enrolment is confirmed within this time or not at all. */
export const LOCAL_TOTP_PENDING_MS = 10 * 60_000;
/** Wrong codes in a row that lock the factor, and for how long. */
export const LOCAL_TOTP_MAX_BAD = 5;
export const LOCAL_TOTP_LOCK_SEC = 15 * 60;
/** Recovery codes per factor and base32 characters per code (80 bits). */
export const LOCAL_TOTP_RECOVERY_CODES = 10;
export const LOCAL_TOTP_RECOVERY_CHARS = 16;
/** Name shown in the authenticator app. */
export const LOCAL_TOTP_ISSUER = "Prisma Memory";
/** At most this many logins are named in the "Readiness" detail. */
const NAMED_MAX = 5;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** What a sign-in sent as `otp`: nothing, six digits, a recovery code, or something of neither form. */
export type OtpForm = { kind: "none" } | { kind: "totp"; digits: string } | { kind: "recovery"; code: string } | { kind: "bad" };

/**
 * Form of `otp`. Absent, null and "" — none. A string of at most TOTP_CODE_INPUT_MAX characters: six digits after removing
 * whitespace (totpCodeDigits) — a TOTP code; 16 base32 characters after normalizeHumanCode (case, spaces and dashes ignored,
 * 0/1/8 read as O/I/B) — a recovery code. Anything else (a number, an array, a longer string, another form) — bad.
 */
export function otpForm(otp: unknown): OtpForm {
  if (otp === undefined || otp === null || otp === "") return { kind: "none" };
  if (typeof otp !== "string" || otp.length > TOTP_CODE_INPUT_MAX) return { kind: "bad" };
  const digits = totpCodeDigits(otp);
  if (digits) return { kind: "totp", digits };
  const code = normalizeHumanCode(otp);
  if (new RegExp(`^[A-Z2-7]{${LOCAL_TOTP_RECOVERY_CHARS}}$`).test(code)) return { kind: "recovery", code };
  return { kind: "bad" };
}

/** Is `otp` acceptable as a sign-in field at all (checked before the password, so a malformed one costs no scrypt). */
export const otpShapeOk = (otp: unknown): boolean => otpForm(otp).kind !== "bad";

/**
 * Result of the second-factor step of a sign-in. retryAfter — seconds, with `locked` and `busy`. `busy`: the
 * per-login lock or a connection of the lock pool was not free within the wait limit — nothing was checked or spent, the
 * client retries. `interrupted`: the proof was COMMITTED (spent — a recovery code is used up, a TOTP step is
 * taken) but the sign-in could not be finished under the lock, so no session stands; the user signs in again with a fresh code.
 * `clock_skew`: the database clock and this process's clock differ by more than the caller allows — refused
 * inside the factor transaction BEFORE anything is checked or spent (skewSec — the measured difference, database minus here).
 */
export type FactorCheck =
  | { ok: true; factor: SessionFactor | null }
  | { ok: false; why: "otp_required" | "bad_code" | "locked" | "enrollment_required" | "unavailable" | "busy"; retryAfter?: number }
  | { ok: false; why: "interrupted"; spent: SessionFactor | null }
  | { ok: false; why: "clock_skew"; skewSec: number };

/** How long a sign-in waits for the per-login lock and for a connection of the lock pool. */
export const LOCAL_TOTP_LOCK_WAIT_MS = 5_000;
/** Retry-After of a `busy` refusal, seconds. */
export const LOCAL_TOTP_BUSY_RETRY_SEC = 5;

/** The sign-in lock was not free in time (lock_timeout, 55P03) or the lock pool had no connection: `busy`. */
class LocalTotpBusy extends Error {}
/** The database clock is too far from this process's clock: thrown before the factor transaction writes. */
class LocalTotpClockSkew extends Error { constructor(readonly skewSec: number) { super("local_totp: clock skew"); } }

/** What issuance hands back: how to take the issued session back if the lock turns out lost. */
export interface LocalTotpIssued { revoke: () => Promise<unknown> }

/**
 * Can a local administrator set up a factor in this build at all? The enrolment routes and the console reset
 * switch it on when they are mounted. Until then nothing here nags —
 * a warning nobody can clear is noise: the "Readiness" item is ok with a plain note, the health key and the daily alert stay
 * silent, and admin.local_totp_required cannot be saved (the item is warn while it is on), so no account is locked out with
 * no way to enrol. One process — one value; tests switch it per file.
 */
let setupAvailable = false;
export const localTotpSetupAvailable = (): boolean => setupAvailable;
export function setLocalTotpSetupAvailable(on: boolean): void { setupAvailable = on; }

/** Is a second factor required of every local administrator (admin.local_totp_required). */
export const localTotpRequired = (app: Pick<App, "settings">): boolean => app.settings.get<boolean>("admin.local_totp_required", false) === true;

// ------------------------------------------------------------------------------------------------ secret and codes

const keyrings = new WeakMap<object, SettingsKeyring>();
/** The settings keyring of this process (files settings-key-<n>, or app-v1 from the application secret), read once. */
function keyringOf(app: Pick<App, "appSecret">): SettingsKeyring {
  let k = keyrings.get(app);
  if (!k) { k = settingsKeyring({ appSecret: app.appSecret }); keyrings.set(app, k); }
  return k;
}

interface SecretEnc { kid: string; ct: string; iv: string }

function sealSecret(app: Pick<App, "appSecret">, login: string, secret: Buffer): SecretEnc {
  const { kid, key } = keyringOf(app).current;
  return { kid, ...encryptWithKey(key, { login, secret: secret.toString("base64") }) };
}

/** The secret of a row, or an exception: unknown key, broken ciphertext, a row of another login. */
function openSecret(app: Pick<App, "appSecret">, login: string, enc: unknown): Buffer {
  const e = enc as Partial<SecretEnc> | null;
  if (!e || typeof e.kid !== "string" || typeof e.ct !== "string" || typeof e.iv !== "string") throw new Error("local_totp: malformed secret_enc");
  const key = keyringOf(app).byKid(e.kid);
  if (!key) throw new Error("local_totp: unknown key id");
  const v = decryptWithKey(key, { ct: e.ct, iv: e.iv }) as { login?: unknown; secret?: unknown } | null;
  if (!v || v.login !== login || typeof v.secret !== "string") throw new Error("local_totp: secret of another login");
  return Buffer.from(v.secret, "base64");
}

/** Hash of a normalized recovery code of a login: lowercase hex SHA-256 (the login is part of it — codes do not travel). */
export function recoveryHash(login: string, code: string): string {
  return createHash("sha256").update(`memory-local-recovery\n${login}\n${code}`, "utf8").digest("hex");
}

/** A new recovery code: 16 base32 characters, each from one random byte (256 is a multiple of 32 — no bias). */
function newRecoveryCode(): string {
  const b = randomBytes(LOCAL_TOTP_RECOVERY_CHARS);
  let s = "";
  for (const x of b) s += B32[x & 31];
  b.fill(0);
  return s.replace(/(.{4})(?=.)/g, "$1-");
}

/** Ten new codes (shown once) and their hashes (stored). */
function newRecoveryCodes(login: string): { codes: string[]; hashes: string[] } {
  const set = new Set<string>();
  while (set.size < LOCAL_TOTP_RECOVERY_CODES) set.add(newRecoveryCode());
  const codes = [...set];
  return { codes, hashes: codes.map((c) => recoveryHash(login, normalizeHumanCode(c))) };
}

/** The account label in the authenticator app: the login (a colon separates the label, so it is replaced). */
const accountLabel = (login: string): string => login.replace(/:/g, "-") || "admin";

function shownSecret(login: string, secret: Buffer): { otpauth_uri: string; secret_text: string; qr_svg: string } {
  const uri = otpauthUri({ issuer: LOCAL_TOTP_ISSUER, account: accountLabel(login), secret });
  return { otpauth_uri: uri, secret_text: secretText(secret), qr_svg: qrSvg(uri) };
}

// ------------------------------------------------------------------------------------------------ sign-in

const localTotpLockKey = (app: App, login: string): string => `local-totp:${app.instanceId}:${login}`;

/** Serialize every factor change (enrolment, confirmation, removal, console reset) and the standalone check on one key. */
async function withLocalTotpLock<T>(app: App, login: string, run: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  return tx(app.db.control, async q => {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [localTotpLockKey(app, login)]);
    return run(q);
  });
}

/**
 * The same key as a session-level lock on one dedicated connection, for the sign-in: it outlives the COMMIT of the
 * factor transaction, so the session is issued after the proof is committed and still before any factor change can run — a
 * console reset waits here and then revokes the session that was just issued. Session-level and transaction-level advisory
 * locks on one key conflict with each other.
 *   - the connection comes from the control LOCK pool (CONTROL_LOCK_POOL), never from the main control pool, and both
 *     the wait for that connection (the pool's connect timeout) and the wait for the lock (SET LOCAL lock_timeout inside a
 *     short transaction; a session-level lock survives its COMMIT) are bounded — beyond them the sign-in is `busy`. A holder
 *     whose issuance stalls therefore pins at most one lock-pool connection, and the waiters behind it give up in seconds.
 *   - `released` says whether pg_advisory_unlock found the lock still held on a live connection. false — the lock was
 *     lost while held (the connection dropped and the server freed it), so a factor change may have run meanwhile; the
 *     connection is then destroyed, never returned to the pool.
 */
async function withLocalTotpHeld<T>(app: App, login: string, run: (c: pg.PoolClient) => Promise<T>): Promise<{ value: T; released: boolean }> {
  let c: pg.PoolClient;
  try { c = await app.db.controlLocks().connect(); } catch (e) { if (lockPoolTimeout(e)) throw new LocalTotpBusy(); throw e; }
  const key = localTotpLockKey(app, login);
  try {
    await txOn(c, async q => {
      await q.query(`SET LOCAL lock_timeout = '${LOCAL_TOTP_LOCK_WAIT_MS}ms'`);
      await q.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    });
  } catch (e) {
    c.release(e instanceof Error ? e : new Error(String(e)));      // whatever state it is in, this connection is not reused
    if ((e as { code?: string })?.code === "55P03") throw new LocalTotpBusy();
    throw e;
  }
  const unlock = async (): Promise<boolean> => {
    try {
      const r = await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok", [key]);
      if (r.rows?.[0]?.ok === true) { c.release(); return true; }
      c.release(new Error("local_totp: the sign-in lock was no longer held"));
    } catch (e) {
      c.release(e instanceof Error ? e : new Error(String(e)));
    }
    return false;
  };
  let value: T;
  try {
    value = await run(c);
  } catch (e) {
    await unlock();
    throw e;
  }
  return { value, released: await unlock() };
}

/**
 * Second-factor step of a sign-in, after a correct password and before any session (admin.ts, POST /api/v1/admin-login).
 *   - no active factor: admin.local_totp_required → enrollment_required; otherwise ok without a factor (a sent otp is
 *     ignored). Standalone checks use one SELECT; sign-in holds the same transaction lock through session issuance;
 *   - otherwise one transaction with the login and active row locked (SELECT … FOR UPDATE — the replay and race guard):
 *     locked (locked_until in the future) → locked, even with a right code; no otp → otp_required, counters untouched;
 *     six digits → TOTP with the replay guard of last_step; a recovery code → its hash removed by the same UPDATE;
 *     a wrong code → bad_codes + 1 (1 when an earlier lock has run out), the fifth sets locked_until — committed.
 * Keyring, decryption or database error → unavailable: the caller refuses the sign-in (no password-only fallback).
 *
 * onVerified (the sign-in) issues the session. INVARIANT: it runs only after the factor transaction — the spent
 * recovery code or TOTP step, the cleared counters, last_login_at — is COMMITTED (txOn throws when the server answers COMMIT
 * with ROLLBACK), and only after a live query on the lock connection has confirmed that this backend still holds the
 * advisory lock; it gets no transaction client, so nothing it writes can share, abort or outlive that transaction. It
 * receives `nowMs` — the DATABASE clock read on the lock connection: a legacy token is signed with it, so the reset's
 * cutoff (also clock_timestamp()) and the token's issue time come from one clock. If the lock is found released at the end,
 * the issued session is revoked (the returned revoke) and the sign-in is `interrupted`.
 * Failure before the COMMIT → `unavailable` (or `busy`), nothing spent; failure after it → `interrupted`, the proof is spent
 * and no session stands.
 */
export async function checkLocalSecondFactor(app: App, login: string, otp: unknown, o: { nowMs?: number; maxSkewMs?: number; onVerified?: (factor: SessionFactor | null, at: { nowMs: number }) => Promise<LocalTotpIssued | void> } = {}): Promise<FactorCheck> {
  const form = otpForm(otp);
  if (form.kind === "bad") return { ok: false, why: "bad_code" };
  try {
    // Standalone checks retain the cheap no-factor path. A login holds the lock through issuance even without a factor.
    const issue = o.onVerified;
    if (!issue) {
      const has = await app.db.control.query("SELECT 1 FROM admin_totp WHERE login = $1 AND instance_id = $2 AND status = 'active'", [login, app.instanceId]);
      if (!has.rows?.length) return localTotpRequired(app) ? { ok: false, why: "enrollment_required" } : { ok: true, factor: null };
      return await withLocalTotpLock(app, login, q => checkLockedFactor(app, q, login, form, o.nowMs ?? Date.now()));
    }
    let committed = undefined as SessionFactor | null | undefined;   // set once the proof is COMMITTED (undefined — not yet)
    let issued = undefined as LocalTotpIssued | undefined;
    try {
      const held = await withLocalTotpHeld(app, login, async c => {
        const checked = await txOn(c, async q => {
          // a session signed with the database clock must be accepted by this process's clock — a skew beyond
          // the caller's bound refuses here, before the factor row is read or a code spent (the transaction rolls back)
          if (o.maxSkewMs !== undefined) {
            const db = Number((await q.query("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms")).rows?.[0]?.now_ms);
            if (!Number.isFinite(db)) throw new Error("local_totp: no database clock");
            if (Math.abs(db - Date.now()) > o.maxSkewMs) throw new LocalTotpClockSkew(Math.round((db - Date.now()) / 1000));
          }
          const r = await checkLockedFactor(app, q, login, form, o.nowMs ?? Date.now());
          if (r.ok) await q.query("UPDATE admin_users SET last_login_at = now() WHERE login = $1", [login]);
          return r;
        });
        // committed: a recovery code is spent for good before a session exists; a refusal's counter is committed too
        if (!checked.ok) return checked;
        committed = checked.factor;
        const live = (await c.query(
          `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms,
                  EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid() AND objsubid = 1
                            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)) AS held`, [localTotpLockKey(app, login)])).rows?.[0] as
          { now_ms?: unknown; held?: unknown } | undefined;
        if (live?.held !== true || !Number.isFinite(Number(live.now_ms))) throw new Error("local_totp: the sign-in lock is not held before issuance");
        issued = (await issue(checked.factor, { nowMs: Number(live.now_ms) })) ?? undefined;
        return checked;
      });
      if (held.value.ok && !held.released) {
        // the lock was gone at the end — a factor change may have run while the session was being issued: take it back
        if (issued) await issued.revoke().catch((e: unknown) => log.error("local_totp_revoke_failed", { login, error: ((e as Error)?.message ?? String(e)).slice(0, 120) }));
        throw new Error("local_totp: the sign-in lock was lost during issuance");
      }
      return held.value;
    } catch (e) {
      if (committed === undefined) throw e;
      log.error("local_totp_sign_in_interrupted", { login, spent: committed, error: ((e as Error)?.message ?? String(e)).slice(0, 120) });
      return { ok: false, why: "interrupted", spent: committed };
    }
  } catch (e) {
    if (e instanceof LocalTotpBusy) return { ok: false, why: "busy", retryAfter: LOCAL_TOTP_BUSY_RETRY_SEC };
    if (e instanceof LocalTotpClockSkew) { log.error("local_totp_clock_skew", { login, skew_sec: e.skewSec }); return { ok: false, why: "clock_skew", skewSec: e.skewSec }; }
    log.error("local_totp_unavailable", { login, error: ((e as Error)?.message ?? String(e)).slice(0, 120) });
    return { ok: false, why: "unavailable" };
  }
}

async function checkLockedFactor(app: App, q: pg.PoolClient, login: string, form: OtpForm, nowMs: number): Promise<FactorCheck> {
  const none = (): FactorCheck => localTotpRequired(app) ? { ok: false, why: "enrollment_required" } : { ok: true, factor: null };
  const row = (await q.query(
    `SELECT secret_enc, last_step, bad_codes, (locked_until IS NOT NULL) AS was_locked, (locked_until IS NOT NULL AND locked_until > now()) AS locked,
            GREATEST(1, ceil(extract(epoch FROM locked_until - now())))::int AS wait
       FROM admin_totp WHERE login = $1 AND instance_id = $2 AND status = 'active' FOR UPDATE`, [login, app.instanceId])).rows[0] as
    { secret_enc: unknown; last_step: string | number | null; bad_codes: number; was_locked: boolean; locked: boolean; wait: number | null } | undefined;
  if (!row) return none();                                   // removed between the two reads
  if (row.locked) return { ok: false, why: "locked", retryAfter: row.wait ?? LOCAL_TOTP_LOCK_SEC };
  if (form.kind === "none") return { ok: false, why: "otp_required" };
  if (form.kind === "totp") {
    const secret = openSecret(app, login, row.secret_enc);
    const v = totpVerify(secret, form.digits, nowMs, row.last_step === null ? null : Number(row.last_step));
    secret.fill(0);
    if (v.ok) {
      await q.query("UPDATE admin_totp SET last_step = $2, bad_codes = 0, locked_until = NULL WHERE login = $1", [login, v.step]);
      return { ok: true, factor: "totp" };
    }
  } else if (form.kind === "recovery") {
    const used = await q.query(
      `UPDATE admin_totp SET recovery_hashes = array_remove(recovery_hashes, $2), bad_codes = 0, locked_until = NULL
        WHERE login = $1 AND $2 = ANY (recovery_hashes)`, [login, recoveryHash(login, form.code)]);
    if (used.rowCount === 1) return { ok: true, factor: "recovery" };
  }
  // a wrong code: a new series after a lock that has run out, else one more; the fifth locks (this attempt is bad_code)
  const n = row.was_locked ? 1 : Number(row.bad_codes) + 1;
  await q.query(
    `UPDATE admin_totp SET bad_codes = $2, locked_until = CASE WHEN $2 >= ${LOCAL_TOTP_MAX_BAD} THEN now() + interval '${LOCAL_TOTP_LOCK_SEC} seconds' END
      WHERE login = $1`, [login, n]);
  return { ok: false, why: "bad_code" };
}

// ------------------------------------------------------------------------------------------------ enrolment

/**
 * Start an enrolment: a new secret in a pending row (10 minutes; a pending one is replaced). An active factor — refused.
 * A row of another instance_id is no factor here (the sign-in and the coverage do not see it) and is replaced too, but only
 * when the login is an account of this instance (admin_users.instance_id): a gateway of another instance never replaces a
 * factor or an enrolment of an account that is not its own (the answer is then already_enrolled, nothing is written).
 */
export async function enrollLocalTotp(app: App, login: string): Promise<{ otpauth_uri: string; secret_text: string; qr_svg: string; expires_at: string } | { error: "already_enrolled" }> {
  const secret = newTotpSecret();
  try {
    const enc = sealSecret(app, login, secret);
    const r = await withLocalTotpLock(app, login, q => q.query(
      `INSERT INTO admin_totp (login, instance_id, secret_enc, status, pending_expires_at)
       VALUES ($1, $2, $3::jsonb, 'pending', now() + $4 * interval '1 millisecond')
       ON CONFLICT (login) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, instance_id = EXCLUDED.instance_id, status = 'pending',
              pending_expires_at = EXCLUDED.pending_expires_at, last_step = NULL, activated_at = NULL, recovery_hashes = '{}',
              bad_codes = 0, locked_until = NULL
        WHERE EXISTS (SELECT 1 FROM admin_users u WHERE u.login = EXCLUDED.login AND u.instance_id = EXCLUDED.instance_id)
          AND (admin_totp.status = 'pending' OR admin_totp.instance_id <> EXCLUDED.instance_id)
       RETURNING pending_expires_at`, [login, app.instanceId, JSON.stringify(enc), LOCAL_TOTP_PENDING_MS]));
    if (!r.rowCount) return { error: "already_enrolled" };
    return { ...shownSecret(login, secret), expires_at: new Date(r.rows[0].pending_expires_at).toISOString() };
  } finally {
    secret.fill(0);
  }
}

/**
 * Confirm a pending enrolment with the first code: the factor becomes active (that step is its last_step), ten recovery codes
 * are issued and returned once. No pending row, or it expired — code_expired; a wrong code counts, and the fifth wrong one
 * drops the pending row (enrolment starts over).
 */
export async function confirmLocalTotp(app: App, login: string, code: unknown, o: { nowMs?: number; beforeWrite?: (q: pg.PoolClient) => Promise<void> } = {}): Promise<{ recovery_codes: string[] } | { error: "bad_code" | "code_expired" }> {
  const digits = totpCodeDigits(code);
  const nowMs = o.nowMs ?? Date.now();
  return withLocalTotpLock(app, login, async (q) => {
    const row = (await q.query(
      `SELECT secret_enc, bad_codes FROM admin_totp
        WHERE login = $1 AND instance_id = $2 AND status = 'pending' AND pending_expires_at > now() FOR UPDATE`, [login, app.instanceId])).rows[0] as
      { secret_enc: unknown; bad_codes: number } | undefined;
    if (!row) return { error: "code_expired" as const };
    const secret = openSecret(app, login, row.secret_enc);
    const v = digits ? totpVerify(secret, digits, nowMs, null) : { ok: false as const };
    secret.fill(0);
    if (!v.ok) {
      const n = Number(row.bad_codes) + 1;
      if (n >= LOCAL_TOTP_MAX_BAD) await q.query("DELETE FROM admin_totp WHERE login = $1 AND status = 'pending'", [login]);
      else await q.query("UPDATE admin_totp SET bad_codes = $2 WHERE login = $1", [login, n]);
      return { error: "bad_code" as const };
    }
    const { codes, hashes } = newRecoveryCodes(login);
    await o.beforeWrite?.(q);
    const u = await q.query(
      `UPDATE admin_totp SET status = 'active', last_step = $2, activated_at = now(), recovery_hashes = $3::text[], pending_expires_at = NULL,
              bad_codes = 0, locked_until = NULL
        WHERE login = $1 AND status = 'pending' AND pending_expires_at > now()`, [login, v.step, hashes]);
    if (u.rowCount !== 1) return { error: "code_expired" as const };
    return { recovery_codes: codes };
  });
}

/**
 * Remove one's own factor with a code (TOTP or recovery), through the same locked check as the sign-in. Refused while
 * admin.local_totp_required is on (checked first).
 */
export async function disableLocalTotp(app: App, login: string, code: unknown, o: { beforeWrite?: (q: pg.PoolClient) => Promise<void> } = {}): Promise<{ disabled: true } | { error: "required" | "not_enrolled" | "bad_code" | "locked" | "unavailable"; retryAfter?: number }> {
  if (localTotpRequired(app)) return { error: "required" };
  const form = otpForm(code);
  if (form.kind === "none" || form.kind === "bad") return { error: "bad_code" };
  return withLocalTotpLock(app, login, async q => {
    const st = await checkLockedFactor(app, q, login, form, Date.now());
    if (!st.ok) return st.why === "locked" ? { error: "locked" as const, ...(st.retryAfter ? { retryAfter: st.retryAfter } : {}) }
      : st.why === "unavailable" ? { error: "unavailable" as const } : st.why === "enrollment_required" ? { error: "not_enrolled" as const } : { error: "bad_code" as const };
    if (st.factor === null) return { error: "not_enrolled" as const };
    await o.beforeWrite?.(q);
    await q.query("DELETE FROM admin_totp WHERE login = $1 AND instance_id = $2", [login, app.instanceId]);
    return { disabled: true as const };
  });
}

/**
 * Console reset for a lost phone (the route checks that the call comes from the machine itself and the install code).
 * Reset replaces, it does not remove: a new secret and new recovery codes, the factor active at once (counters cleared,
 * last_step NULL) — so admin.local_totp_required can never lock the installation out. remove: true deletes the factor and
 * is refused while that setting is on. Unknown or disabled login — not_found.
 */
export async function resetLocalTotp(app: App, login: string, o: { remove?: boolean; beforeWrite?: (q: pg.PoolClient) => Promise<void> } = {}): Promise<
  { login: string; otpauth_uri: string; secret_text: string; qr_svg: string; recovery_codes: string[] } | { login: string; removed: true } | { error: "not_found" | "required" }> {
  return withLocalTotpLock(app, login, async q => {
    const u = await q.query("SELECT 1 FROM admin_users WHERE login = $1 AND instance_id = $2 AND disabled_at IS NULL", [login, app.instanceId]);
    if (!u.rowCount) return { error: "not_found" };
    if (o.remove) {
      if (localTotpRequired(app)) return { error: "required" };
      await o.beforeWrite?.(q);
      await q.query("DELETE FROM admin_totp WHERE login = $1", [login]);
      return { login, removed: true };
    }
    const secret = newTotpSecret();
    try {
      const { codes, hashes } = newRecoveryCodes(login);
      const shown = shownSecret(login, secret);
      const sealed = sealSecret(app, login, secret);
      await o.beforeWrite?.(q);
      await q.query(
        `INSERT INTO admin_totp (login, instance_id, secret_enc, status, activated_at, recovery_hashes)
         VALUES ($1, $2, $3::jsonb, 'active', now(), $4::text[])
         ON CONFLICT (login) DO UPDATE SET instance_id = EXCLUDED.instance_id, secret_enc = EXCLUDED.secret_enc, status = 'active',
                activated_at = now(), recovery_hashes = EXCLUDED.recovery_hashes, last_step = NULL, pending_expires_at = NULL,
                bad_codes = 0, locked_until = NULL`, [login, app.instanceId, JSON.stringify(sealed), hashes]);
      return { login, ...shown, recovery_codes: codes };
    } finally {
      secret.fill(0);
    }
  });
}

/** State of one's own factor (no secret): enrolled — active, pending — an enrolment waits for its first code. */
export async function localTotpStatus(app: App, login: string): Promise<{ enrolled: boolean; pending: boolean; required: boolean; recovery_left: number; activated_at: string | null }> {
  const r = (await app.db.control.query(
    `SELECT status, cardinality(recovery_hashes)::int AS left, activated_at, (pending_expires_at > now()) AS live
       FROM admin_totp WHERE login = $1 AND instance_id = $2`, [login, app.instanceId])).rows[0] as
    { status: string; left: number; activated_at: Date | null; live: boolean | null } | undefined;
  const enrolled = r?.status === "active";
  return { enrolled, pending: r?.status === "pending" && r.live === true, required: localTotpRequired(app),
           recovery_left: enrolled ? Math.max(0, Math.min(LOCAL_TOTP_RECOVERY_CODES, Number(r!.left))) : 0,
           activated_at: enrolled && r!.activated_at ? new Date(r!.activated_at).toISOString() : null };
}

// ------------------------------------------------------------------------------------------------ coverage, Readiness, alert

/** Enabled local administrators and those of them without an active factor of their own instance (logins in order). */
export async function localFactorCoverage(q: Pick<pg.Pool, "query">, instanceId: string): Promise<{ admins: number; without: string[] }> {
  const r = await q.query(
    `SELECT u.login, EXISTS (SELECT 1 FROM admin_totp t WHERE t.login = u.login AND t.instance_id = u.instance_id AND t.status = 'active') AS covered
       FROM admin_users u WHERE u.instance_id = $1 AND u.disabled_at IS NULL ORDER BY u.login`, [instanceId]);
  const rows = ((r.rows ?? []) as Array<{ login?: unknown; covered?: unknown }>).filter((x) => typeof x.login === "string") as Array<{ login: string; covered: unknown }>;
  return { admins: rows.length, without: rows.filter((x) => x.covered !== true).map((x) => x.login) };
}

/** Settings the "Readiness" item reads (the caller passes them by literal key: the settings registry records each read). */
export interface LocalFactorView { "admin.local_login": unknown; "admin.system_key_admin": unknown; "admin.local_totp_required": unknown }

/**
 * "Readiness" item local_admin_factor (pure). ok — local sign-in is off, there is no enabled local administrator, or each
 * has an active factor; warn — someone has none (named, at most five), or the coverage could not be read (cov = null).
 * The status follows the coverage only (the guard of admin.local_totp_required needs it in ok); while
 * admin.system_key_admin is not false the detail says that the system key still opens the admin API without a factor.
 * While no way to set up a factor exists (localTotpSetupAvailable): ok with a plain note (with local sign-in off — the
 * "sign-in is off" item, there is no password sign-in to speak of), or warn while
 * admin.local_totp_required is on — whatever the coverage, so the guard never lets it be saved then.
 * Never fail: the item is no precondition of the strict mode.
 */
export function localAdminFactorCheck(cov: { admins: number; without: string[] } | null, v: LocalFactorView, setup = localTotpSetupAvailable()): ReadinessCheck {
  const id = "local_admin_factor";
  const systemKey = v["admin.system_key_admin"] !== false
    ? " The system key still opens the admin API without a second factor while admin.system_key_admin is on." : "";
  if (!setup) {
    if (v["admin.local_totp_required"] === true)
      return { id, status: "warn", title: "A second factor is required, but local administrators cannot set one up in this version",
               detail: `An account without a factor cannot sign in with its password: turn admin.local_totp_required off.${systemKey}` };
    if (v["admin.local_login"] === "off") return { id, status: "ok", title: "Local administrator sign-in is off", detail: `No password sign-in to protect.${systemKey}` };
    return { id, status: "ok", title: "Local administrators cannot set up a second factor in this version", detail: `For a local administrator a password alone signs in.${systemKey}` };
  }
  if (v["admin.local_login"] === "off") return { id, status: "ok", title: "Local administrator sign-in is off", detail: `No password sign-in to protect.${systemKey}` };
  if (cov === null) return { id, status: "warn", title: "Second factor of local administrators could not be checked", detail: `The table of factors is not readable.${systemKey}` };
  if (cov.admins === 0) return { id, status: "ok", title: "No local administrator account", detail: `Nothing to protect yet.${systemKey}` };
  if (!cov.without.length) return { id, status: "ok", title: "Every local administrator has a second factor", detail: `Accounts: ${cov.admins}.${systemKey}` };
  const named = cov.without.slice(0, NAMED_MAX).join(", ") + (cov.without.length > NAMED_MAX ? ` and ${cov.without.length - NAMED_MAX} more` : "");
  return { id, status: "warn", title: `Local administrator without a second factor: ${cov.without.length} of ${cov.admins}`,
           detail: `${named}: a password alone signs in. Each of these accounts should set up an authenticator app as its second factor in the panel, page "Two-step sign-in" (/admin/factor-local).${systemKey}` };
}

/**
 * Health key local_admin_factor: ok with level warn while an enabled local administrator has no active factor and local
 * sign-in is not off; null (no key) otherwise, also when the coverage cannot be read and while no way to set up a factor
 * exists. It never changes the status.
 */
export async function localFactorHealth(app: App): Promise<{ ok: true; level: "warn"; detail: string } | null> {
  if (!localTotpSetupAvailable()) return null;
  if (app.settings.get<unknown>("admin.local_login", "open") === "off") return null;
  const cov = await localFactorCoverage(app.db.control, app.instanceId).catch(() => null);
  if (!cov || !cov.without.length) return null;
  return { ok: true, level: "warn", detail: `local administrators without a second factor: ${cov.without.length} of ${cov.admins}` };
}

/** A sign-in without a factor: medium alert local_admin_no_factor, once per login and UTC day (only once a factor can be set up). */
export async function noteFactorlessLogin(app: App, login: string, now = new Date()): Promise<void> {
  if (!localTotpSetupAvailable()) return;
  const day = now.toISOString().slice(0, 10);
  // on the pool, after the sign-in's outcome: never on a transaction client
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "medium", code: "local_admin_no_factor",
    summary: `Local administrator ${login} signed in with a password only: no second factor is set up`.slice(0, 300),
    details: { login }, dedupeKey: `local_admin_no_factor:${login}:${day}` });
}
