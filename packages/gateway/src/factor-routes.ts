// The second factor in the workplace (contract — openapi-ingest.yaml,
// routes /api/v1/me/external/factor*). The person sets it up alone, from inside: only a workplace session of that person
// (requireHuman); the external channel gets 404, the edge has none of these routes. person_id is from the session, not the body.
// The sign-in check service decides over its socket (authcheck-client.ts): login freshness, first-setup check, code budget.
// The gateway gives it the session's authentication time (user_sessions.auth_time), the browser network (office — an address in
// edge.office_networks, decided by officeCandidateAddress; an unknown one — other) and whether a support confirmation no
// older than a day (external_access_confirmations). The confirmation is not spent here, and one already spent by
// turning on outside access does not hinder the setup: else one who turned it on with confirmation could never set up the factor
// outside the office. No confirmation, and the service answered factor_first_confirm_required: the gateway files a request
// to support (the same mechanism: support sees and confirms it on the outside access page) or takes a waiting one no
// older than a day; its id is details.request_id. Outside access need not be turned on for this.
// The secret (QR and the key as text) and the recovery codes are only in the answer, once: Cache-Control: no-store, never logged.
// Refusal texts are in contracts/edge/error-codes.json, the factor section (checked by a unit test).
import type { Context, Hono } from "hono";
import { invalid, newId } from "@memory/shared";
import { totpCodeDigits } from "@memory/shared/factor";
import { authcheckFactor, AuthcheckUnavailable, type AuthcheckFactorAnswer, type AuthcheckFactorPath } from "./authcheck-client.ts";
import { audit } from "./audit.ts";
import type { App, Caller } from "./context.ts";
import { inOfficeNetworks, officeCandidateAddress } from "./external-access.ts";
import { factorQrSvg } from "./factor-qr.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { requireHuman } from "./workplace.ts";

/** Refusal texts of the factor section (contracts/edge/error-codes.json) — one source for the gateway and the tests. */
export const FACTOR_ERRORS = {
  factor_fresh_login_required: { http: 409, text: "To set up the second factor, sign out of the workplace and sign in again: a fresh sign-in is needed" },
  factor_first_confirm_required: { http: 409, text: "The second factor must be set up for the first time from the office network or after support confirms who you are. The request has gone to support: after the confirmation, repeat the setup" },
  proof_required: { http: 409, text: "Confirm the action with a code from the app" },
  bad_code: { http: 400, text: "The code was not accepted. Check the time on the phone and enter a new code" },
  code_expired: { http: 409, text: "The time for the setup is over. Start again" },
  factor_locked: { http: 429, text: "Too many wrong codes. Try again later" },
  factor_unavailable: { http: 503, text: "The second factor is not available now. Try again later" },
  already_enrolled: { http: 409, text: "The second factor is already set up. To change the phone, choose «Replace»" },
} as const;
export type FactorErrorCode = keyof typeof FACTOR_ERRORS;

/** Where to send for a fresh sign-in: the workplace sign-in page, returning to the second factor page. */
export const FACTOR_FRESH_LOGIN_PATH = "/login?fresh=1&next=/external/factor";

const where = { path: "/external/factor", section: "Second factor" };
const PROOF = /^[0-9A-Za-z-]{6,32}$/;
/** A waiting support request is reused for a day — as when turning on outside access (external-access.ts). */
const REQUEST_REUSE_HOURS = 24;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const refuse = (c: Context, code: FactorErrorCode, details?: Record<string, unknown>): Response =>
  c.json({ code, message: FACTOR_ERRORS[code].text, ...(details ? { details } : {}) }, FACTOR_ERRORS[code].http as 400 | 409 | 429 | 503);
const notFound = (c: Context): Response => c.json({ code: "not_found", message: "The employee’s profile is missing or inactive" }, 404);

/** Service refusal → gateway answer; a code outside the factor section (bad_request, internal) — unavailable. */
function fromSocket(c: Context, r: AuthcheckFactorAnswer): Response {
  if (r.status === 404) return notFound(c);
  const code = typeof r.body.code === "string" ? r.body.code : "";
  if (Object.hasOwn(FACTOR_ERRORS, code)) {
    const k = code as FactorErrorCode;
    return k === "factor_fresh_login_required" ? refuse(c, k, { login_path: FACTOR_FRESH_LOGIN_PATH }) : refuse(c, k);
  }
  return refuse(c, "factor_unavailable");
}

/** Request body: empty — {}; otherwise an object with the listed fields only. */
async function body(c: Context, allowed: readonly string[], shape: string): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw invalid(`The body must be a JSON object ${shape}`); }
  const b = jsonObjectBody(v, shape);
  rejectUnknownFields(b, [...allowed]);
  return b;
}

const label = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim() || v.length > 40) throw invalid("label: a phone name from 1 to 40 characters");
  return v.trim();
};
const proof = (v: unknown): { code: string } => {
  const p = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  // spaces as the app shows them (123 456): removed, as for the first-code confirmation
  const code = p && typeof p.code === "string" ? p.code.replace(/\s+/g, "") : "";
  if (!p || Object.keys(p).length !== 1 || !PROOF.test(code)) throw invalid("proof.code: a code from the app (6 digits) or a recovery code");
  return { code };
};

async function sessionAuthTime(app: App, caller: Caller): Promise<string | null> {
  const r = await app.db.control.query<{ auth_time: Date | null }>("SELECT auth_time FROM user_sessions WHERE id = $1", [caller.keyId]);
  const t = r.rows[0]?.auth_time;
  return t ? new Date(t).toISOString() : null;
}

/**
 * Support confirmation for the first setup (no older than 24 h): confirmed and not expired
 * (the term is a day from the confirmation). One spent on turning on outside access also counts, but only the one that turned on
 * the current access (first_enabled_at — the same transaction as used_at): a change of the AD account behind the card resets
 * the first turn-on and voids unused confirmations (externalAdLinkChanged) — then one spent by the former account
 * does not count here either.
 */
async function supportConfirmed(app: App, personId: string): Promise<boolean> {
  const r = await app.db.control.query(
    `SELECT 1 FROM external_access_confirmations x
      WHERE x.person_id = $1 AND x.instance_id = $2 AND x.confirmed_at IS NOT NULL AND x.expires_at > now()
        AND (x.used_at IS NULL OR EXISTS (SELECT 1 FROM external_access e WHERE e.person_id = x.person_id AND e.first_enabled_at = x.used_at))
      LIMIT 1`, [personId, app.instanceId]);
  return r.rows.length > 0;
}

/** A support request for identity confirmation: a waiting one no older than a day is reused, else a new one; returns its id. */
async function supportRequest(app: App, caller: Caller, personId: string, address: string | null): Promise<string> {
  const pending = (await app.db.control.query<{ id: string }>(
    `SELECT id FROM external_access_confirmations WHERE person_id = $1 AND instance_id = $2 AND used_at IS NULL AND confirmed_at IS NULL
        AND requested_at > now() - make_interval(hours => $3) ORDER BY requested_at DESC LIMIT 1`, [personId, app.instanceId, REQUEST_REUSE_HOURS])).rows[0];
  if (pending) return pending.id;
  const id = newId();
  await app.db.control.query("INSERT INTO external_access_confirmations (id, person_id, instance_id, requested_ip) VALUES ($1, $2, $3, $4::inet)",
    [id, personId, app.instanceId, address]);
  await audit(app, caller, { event_type: "external", details: { op: "factor_confirm_requested", request_id: id } });
  return id;
}

/** A socket call; the service did not answer — 503 factor_unavailable (upward — Response). */
async function socket(c: Context, path: AuthcheckFactorPath, b: Record<string, unknown>): Promise<AuthcheckFactorAnswer | Response> {
  try {
    return await authcheckFactor(path, b);
  } catch (e) {
    if (e instanceof AuthcheckUnavailable) return refuse(c, "factor_unavailable");
    throw e;
  }
}

const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

export function registerFactorRoutes(r: Hono<any>, app: App): void {
  const human = async (c: Context, what: string, bucket: "me_keys" | "me_keys_view"): Promise<{ caller: Caller; personId: string }> => {
    const caller = c.get("caller") as Caller;
    await requireHuman(app, caller, what, where);
    app.limiter.check(caller, bucket);
    return { caller, personId: caller.person!.id };
  };

  /** The setting of starting a setup or replacement: sign-in time, browser network, support confirmation. */
  const context = async (c: Context, caller: Caller, personId: string) => {
    const office = officeCandidateAddress(app, (n) => c.req.header(n));
    const [authTime, confirmed] = await Promise.all([sessionAuthTime(app, caller), supportConfirmed(app, personId)]);
    const nets = app.settings.get<unknown[]>("edge.office_networks", []);
    return {
      // no sign-in time — surely not fresh: the service will answer factor_fresh_login_required
      session_auth_time: authTime ?? new Date(0).toISOString(),
      network: inOfficeNetworks(office, Array.isArray(nets) ? nets : []) ? "office" as const : "other" as const,
      support_confirmed: confirmed,
      office,
    };
  };

  r.get("/api/v1/me/external/factor", async (c) => {
    const { personId } = await human(c, "View the second factor", "me_keys_view");
    const s = await socket(c, "/v1/factor/status", { person_id: personId });
    if (s instanceof Response) return s;
    if (s.status !== 200) return fromSocket(c, s);
    const b = s.body;
    if (typeof b.enrolled !== "boolean" || typeof b.recovery_left !== "number") return refuse(c, "factor_unavailable");
    const mode = b.mode === "off" || b.mode === "optional" ? b.mode : "required";
    return c.json({
      mode, enrolled: b.enrolled, label: typeof b.label === "string" ? b.label : null, activated_at: isoOrNull(b.activated_at),
      recovery_left: Math.max(0, Math.min(10, Math.trunc(b.recovery_left))), recovery_low: b.recovery_low === true, locked_until: isoOrNull(b.locked_until),
    });
  });

  /** The answer to starting a setup or replacement: QR (SVG) instead of the otpauth:// address, key as text, term; no-store. */
  const pending = (c: Context, s: AuthcheckFactorAnswer): Response => {
    if (s.status !== 200) return fromSocket(c, s);
    const b = s.body;
    const svg = factorQrSvg(b.otpauth_uri);
    if (!svg || typeof b.pending_id !== "string" || typeof b.secret_text !== "string" || typeof b.expires_at !== "string") return refuse(c, "factor_unavailable");
    return c.json({ pending_id: b.pending_id, qr_svg: svg, secret_text: b.secret_text, expires_at: b.expires_at }, 200, NO_STORE);
  };

  r.post("/api/v1/me/external/factor/enroll", async (c) => {
    const { caller, personId } = await human(c, "Set up second factor", "me_keys");
    const b = await body(c, ["label"], "{label?}");
    const l = label(b.label);
    const { office, ...ctx } = await context(c, caller, personId);
    const s = await socket(c, "/v1/factor/enroll/start", { person_id: personId, ...ctx, ...(l ? { label: l } : {}) });
    if (s instanceof Response) return s;
    // outside the office and without a confirmation — a request to support (outside access need not be on for the factor)
    if (s.status === 409 && s.body.code === "factor_first_confirm_required")
      return refuse(c, "factor_first_confirm_required", { request_id: await supportRequest(app, caller, personId, office) });
    return pending(c, s);
  });

  r.post("/api/v1/me/external/factor/replace", async (c) => {
    const { caller, personId } = await human(c, "Replace the phone used for the second factor", "me_keys");
    const b = await body(c, ["label", "proof"], "{proof, label?}");
    const p = proof(b.proof);
    const l = label(b.label);
    const { office: _office, ...ctx } = await context(c, caller, personId);
    const s = await socket(c, "/v1/factor/replace/start", { person_id: personId, ...ctx, proof: p, ...(l ? { label: l } : {}) });
    return s instanceof Response ? s : pending(c, s);
  });

  r.post("/api/v1/me/external/factor/confirm", async (c) => {
    const { personId } = await human(c, "Confirm the second factor", "me_keys");
    const b = await body(c, ["pending_id", "code"], "{pending_id, code}");
    if (typeof b.pending_id !== "string" || !/^[0-9a-f-]{36}$/i.test(b.pending_id)) throw invalid("pending_id: setup identifier from the “Set up” response");
    // The form totpVerify uses: whitespace removed, six ASCII digits, raw input at most 64 characters.
    const code = totpCodeDigits(b.code);
    if (code === null) throw invalid("code: six digits from the app");
    const s = await socket(c, "/v1/factor/enroll/confirm", { person_id: personId, pending_id: b.pending_id.toLowerCase(), code });
    if (s instanceof Response) return s;
    if (s.status !== 200) return fromSocket(c, s);
    const v = s.body;
    if (v.ok === true && Array.isArray(v.recovery_codes)) return c.json({ recovery_codes: v.recovery_codes }, 200, NO_STORE);
    if (v.ok === false) {
      if (v.reason === "bad_code") return refuse(c, "bad_code");
      if (v.reason === "expired") return refuse(c, "code_expired");
      if (v.reason === "locked") return refuse(c, "factor_locked");
    }
    return refuse(c, "factor_unavailable");
  });

  r.post("/api/v1/me/external/factor/recovery-codes", async (c) => {
    const { caller, personId } = await human(c, "Get new recovery codes", "me_keys");
    const b = await body(c, ["proof"], "{proof}");
    const p = proof(b.proof);
    const authTime = await sessionAuthTime(app, caller);
    const s = await socket(c, "/v1/recovery/issue", { person_id: personId, session_auth_time: authTime ?? new Date(0).toISOString(), proof: p });
    if (s instanceof Response) return s;
    if (s.status !== 200) return fromSocket(c, s);
    if (!Array.isArray(s.body.recovery_codes)) return refuse(c, "factor_unavailable");
    return c.json({ recovery_codes: s.body.recovery_codes }, 200, NO_STORE);
  });
}
