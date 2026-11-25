// Format of the sealed login check request and answer (the login-check contract): the part shared by the edge
// and memory-authcheck: byte layout, AAD, checks of plaintext fields. Only the edge seals a request
// (login-edge.ts), only memory-authcheck opens it (login-inner.ts); the bridge sees the request as an opaque blob.
//
// Refinements of the contract that this file fixes (test vectors pin them):
//   - id in AAD: the 16 bytes of the uuid of the login.checks row (canonical form: lower-case hex with dashes);
//   - answer AAD = id(16) ‖ UTF-8(tx_id) ‖ nonce(16 raw bytes, base64url layout from the request); tx_id is only
//     [A-Za-z0-9_-], so the join is unambiguous (the ends have fixed length);
//   - plaintext: JSON in the contract field order, an unknown field is a refusal (contract first, then the field);
//   - 1e: pt = skid(uint16 BE) ‖ sig(64) ‖ json, sig = Ed25519(sk, "memory-authcheck request sig v1" ‖ aad ‖ enc ‖ json);
//     password and authorize fields are strict (the login-check contract); request ≤ 4096 bytes, answer ≤ 2048;
//   - 1f: the sign-in step right after kind; kind code only with step: code, login and code, no fields of other kinds;
//     a ticket of password only with step: password_ticket, and then required (the login-check contract).
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { concat, fromB64u, i2osp, utf8 } from "./bytes.ts";
import { isNormalizedLogin, LOGIN_MAX } from "./login.ts";
import { LOGIN_KINDS, MFA_LEVELS, type LoginKindId, type LoginKindName, type MfaLevel } from "./login-kinds.ts";

export const LOGIN_CHECK_VERSION = 0x01;
/** HPKE info of the request */
export const REQUEST_INFO = utf8("memory-authcheck request v1");
/** Export label for the answer key */
export const RESPONSE_EXPORT_LABEL = utf8("memory-authcheck response v1");
export const RESPONSE_KEY_BYTES = 32;
const ENC_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Limit of a sealed request (column login.checks.blob, the bridge gives 413): password ≤ 1024 bytes plus fields. */
export const MAX_REQUEST_BLOB_BYTES = 4096;
/** Limit of a sealed answer (column login.checks.answer). */
export const MAX_ANSWER_BLOB_BYTES = 2048;
/** Request signature by the edge-auth key: the label before aad ‖ enc ‖ json. */
export const REQUEST_SIG_LABEL = utf8("memory-authcheck request sig v1");
export const SIG_BYTES = 64;
const SKID_BYTES = 2;
/** The edge cuts the form password at this limit; inside, over 256 characters is fail without AD binding (authcheck). */
export const SECRET_MAX_BYTES = 1024;
/** Freshness window of a request at memory-authcheck (the login-check contract, the section on terms and check order). */
export const REQUEST_MAX_AGE_MS = 30_000;
export const REQUEST_MAX_FUTURE_MS = 5_000;

export type LoginWireErrorCode =
  | "login_kind" // kind not in the registry or not equal to the plaintext
  | "login_id" // id is not a uuid
  | "login_key" // the public key from the anchors is broken
  | "login_no_key" // no valid authcheck key in the anchors or no edge-auth signing key
  | "login_unknown_kid" // the request is not for our key
  | "login_blob" // blob layout
  | "login_open_failed" // did not decrypt (changed id, kind, kid or content)
  | "login_signature" // no edge-auth signature, unknown or expired skid, wrong signature (step 2a)
  | "login_payload"; // plaintext off the contract

export class LoginWireError extends Error {
  constructor(readonly code: LoginWireErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "LoginWireError";
  }
}

// ---------------------------------------------------------------- plaintext

/** Request fields by the contract (the order is the serialisation order). */
export const REQUEST_FIELDS = ["v", "kind", "step", "login", "secret", "purpose", "tx_id", "ticket", "session", "client_id", "resource", "challenge_hash", "ip", "ts", "nonce", "device", "host"] as const;
export const PURPOSES = ["login", "account"] as const;
export type LoginPurpose = (typeof PURPOSES)[number];
/** 1f: sign-in step (the login-check contract). No field for password means step password (edge 1e). */
export const STEPS = ["password", "code", "password_ticket", "password_unenrolled"] as const;
export type LoginStep = (typeof STEPS)[number];
/** 1f: the steps of each kind; kinds not in the list have no step field. */
const KIND_STEPS: Partial<Record<LoginKindName, readonly LoginStep[]>> = {
  code: ["code"],
  password: ["password", "password_ticket", "password_unenrolled"],
};

export interface LoginRequestPayload {
  v: 1;
  kind: LoginKindName;
  /** 1f: sign-in step; required for code and equal to code */
  step?: LoginStep;
  /** normalised (normalizeLogin) */
  login?: string;
  secret?: string;
  /** 1e: login is a sign-in with program connection; account is the page of one's connections (person_id only) */
  purpose?: LoginPurpose;
  tx_id: string;
  ticket?: string;
  session?: string;
  client_id: string;
  resource?: string;
  challenge_hash?: string;
  ip: string;
  /** ms, edge clock */
  ts: number;
  /** 16 bytes base64url */
  nonce: string;
  device?: string;
  host: string;
}

export const ANSWER_FIELDS = ["v", "verdict", "person_id", "session", "grant_id", "ticket", "mfa_level", "next", "retry_after_ms", "retry_scope"] as const;
export const VERDICTS = ["ok", "fail", "retry"] as const;
/** 1f: login means a new sign-in with a code is needed (a session without a factor while the mode requires one). */
export const NEXT_STEPS = ["code", "password", "consent", "login"] as const;
/** 1e: one retries only this request; all asks to treat the check as unhealthy for retry_after_ms (a pause and so on). */
export const RETRY_SCOPES = ["one", "all"] as const;

export interface LoginAnswerPayload {
  v: 1;
  verdict: (typeof VERDICTS)[number];
  person_id?: string;
  session?: { secret: string; expires_at: string; mfa_level: MfaLevel; auth_time: string };
  grant_id?: string;
  ticket?: string;
  mfa_level?: MfaLevel;
  next?: (typeof NEXT_STEPS)[number];
  retry_after_ms?: number;
  retry_scope?: (typeof RETRY_SCOPES)[number];
}

const TX_ID = /^[A-Za-z0-9_-]{16,128}$/;
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE = /^[\x21-\x7e]{1,512}$/; // tickets, sessions, device: printable ASCII without a space
const HOST = /^(\[[0-9a-f:]{2,39}\]|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(:\d{1,5})?$/;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A field refusal. field is only a name of the contract or a constant: key names of the decrypted text never go here
 * (the sender picks them, and an error message may reach the log). */
const bad = (field: string): never => {
  throw new LoginWireError("login_payload", field);
};
/** An unknown field: one constant, without a key name from the plaintext. */
const UNKNOWN_FIELD = "unknown_field";
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (o: Record<string, unknown>, k: string, ok: (s: string) => boolean, required: boolean) => {
  if (!(k in o)) return required ? bad(k) : undefined;
  const v = o[k];
  if (typeof v !== "string" || !ok(v)) bad(k);
};
const isoTime = (s: string) => ISO_DT.test(s) && !Number.isNaN(Date.parse(s));
/** 32 bytes base64url, 43 characters: the sign-in session secret, the code_challenge hash. */
const b64u32 = (s: string) => fromB64u(s, 32) !== null;

/** Fields of kinds 1e and 1f (the login-check contract; ping in, liveness signal): required and forbidden. Kinds of
 * other stages follow the general P0 rules. */
const KIND_FIELDS: Partial<Record<LoginKindName, { required: readonly string[]; forbidden: readonly string[] }>> = {
  password: { required: ["login", "secret", "purpose"], forbidden: ["session", "resource", "challenge_hash"] },
  authorize: { required: ["session", "resource", "challenge_hash"], forbidden: ["login", "secret", "purpose", "ticket"] },
  // 1f: the code is asked before the password: the request carries login and code; no ticket yet, no session or consent
  code: { required: ["step", "login", "secret"], forbidden: ["ticket", "session", "resource", "challenge_hash", "purpose"] },
  // edge liveness signal: only the common fields, no people, no secrets
  ping: { required: [], forbidden: ["step", "login", "secret", "purpose", "ticket", "session", "resource", "challenge_hash", "device"] },
};

export function kindName(id: number): LoginKindName {
  const k = LOGIN_KINDS.find((x) => x.id === id);
  if (!k) throw new LoginWireError("login_kind", String(id));
  return k.name;
}

export function kindId(kind: LoginKindName | number): LoginKindId {
  const k = LOGIN_KINDS.find((x) => x.name === kind || x.id === kind);
  if (!k) throw new LoginWireError("login_kind", String(kind));
  return k.id;
}

/** Check of the request plaintext: contract fields and types, the kind equals the row kind. */
export function validateRequestPayload(x: unknown, expectedKind: LoginKindName): LoginRequestPayload {
  if (!isObj(x)) bad("payload");
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(REQUEST_FIELDS as readonly string[]).includes(k)) bad(UNKNOWN_FIELD);
  if (o.v !== 1) bad("v");
  if (o.kind !== expectedKind) throw new LoginWireError("login_kind", "line kind ≠ kind in the request");
  const rules = KIND_FIELDS[expectedKind];
  for (const k of rules?.required ?? []) if (!(k in o)) bad(k);
  for (const k of rules?.forbidden ?? []) if (k in o) bad(k);
  if ("purpose" in o && expectedKind !== "password") bad("purpose");
  // 1f: a step only for its kinds and from their list; a password ticket only with password_ticket, and then required
  if ("step" in o && !(typeof o.step === "string" && (KIND_STEPS[expectedKind] as readonly string[] | undefined)?.includes(o.step))) bad("step");
  if (expectedKind === "password" && (o.step === "password_ticket") !== ("ticket" in o)) bad("ticket");
  str(o, "login", (s) => s.length <= LOGIN_MAX && isNormalizedLogin(s), false);
  str(o, "secret", (s) => s.length >= 1 && Buffer.byteLength(s, "utf8") <= SECRET_MAX_BYTES, false);
  str(o, "purpose", (s) => (PURPOSES as readonly string[]).includes(s), false);
  str(o, "tx_id", (s) => TX_ID.test(s), true);
  str(o, "ticket", (s) => OPAQUE.test(s), false);
  str(o, "session", (s) => (expectedKind === "authorize" ? b64u32(s) : OPAQUE.test(s)), false);
  str(o, "client_id", (s) => CLIENT_ID.test(s), true);
  str(o, "resource", (s) => s.length <= 2048 && s.startsWith("https://") && !CONTROL.test(s) && !/\s/.test(s), false);
  str(o, "challenge_hash", b64u32, false);
  str(o, "ip", (s) => IP.test(s), true);
  if (!Number.isSafeInteger(o.ts) || (o.ts as number) < 0) bad("ts");
  str(o, "nonce", (s) => fromB64u(s, 16) !== null, true);
  str(o, "device", (s) => OPAQUE.test(s), false);
  str(o, "host", (s) => s.length <= 260 && HOST.test(s), true);
  return o as unknown as LoginRequestPayload;
}

/** Check of the answer plaintext. */
export function validateAnswerPayload(x: unknown): LoginAnswerPayload {
  if (!isObj(x)) bad("payload");
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(ANSWER_FIELDS as readonly string[]).includes(k)) bad(UNKNOWN_FIELD);
  if (o.v !== 1) bad("v");
  if (!(VERDICTS as readonly unknown[]).includes(o.verdict)) bad("verdict");
  str(o, "person_id", (s) => UUID.test(s), false);
  if ("session" in o) {
    const s = o.session;
    if (!isObj(s)) bad("session");
    const so = s as Record<string, unknown>;
    for (const k of Object.keys(so)) if (!["secret", "expires_at", "mfa_level", "auth_time"].includes(k)) bad(`session.${UNKNOWN_FIELD}`);
    str(so, "secret", b64u32, true);
    str(so, "expires_at", isoTime, true);
    str(so, "mfa_level", (v) => (MFA_LEVELS as readonly string[]).includes(v), true);
    str(so, "auth_time", isoTime, true);
  }
  str(o, "grant_id", (s) => fromB64u(s, 16) !== null, false);
  str(o, "ticket", (s) => OPAQUE.test(s), false);
  str(o, "mfa_level", (s) => (MFA_LEVELS as readonly string[]).includes(s), false);
  str(o, "next", (s) => (NEXT_STEPS as readonly string[]).includes(s), false);
  if ("retry_after_ms" in o && (!Number.isSafeInteger(o.retry_after_ms) || (o.retry_after_ms as number) < 0 || (o.retry_after_ms as number) > 600_000)) bad("retry_after_ms");
  str(o, "retry_scope", (s) => (RETRY_SCOPES as readonly string[]).includes(s), false);
  // 1e: person_id, session and permission only with ok (else a refusal for a known login would show the person enabled
  // outside access); a pause only with retry and fail; the retry scope only with retry, and "all" only with a delay
  if (o.verdict !== "ok" && ("person_id" in o || "session" in o || "grant_id" in o)) bad("verdict");
  if (o.verdict === "ok" && "retry_after_ms" in o) bad("retry_after_ms");
  if (o.verdict !== "retry" && "retry_scope" in o) bad("retry_scope");
  if (o.retry_scope === "all" && !((o.retry_after_ms as number) >= 1)) bad("retry_after_ms");
  return o as unknown as LoginAnswerPayload;
}

/**
 * Hash of a one-time sign-in secret as the inner database stores it (the login-check contract, on secret hashes): SHA-256 of the
 * ASCII bytes of the base64url text, not of the decoded bytes. grant_id (22 characters) → edge_grants.grant_hash and
 * oauth_connections.grant_hash (edge_accept_connection computes the same); the sign-in session secret (43 characters) →
 * login_sessions.secret_hash. One function for memory-authcheck and the checks: if the forms differed, the receiver
 * would refuse every edge connection as one without a sign-in.
 */
export function loginSecretHash(b64uText: string): Buffer {
  if (typeof b64uText !== "string" || !/^(?:[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/.test(b64uText)) throw new LoginWireError("login_payload", "sign-in secret");
  return createHash("sha256").update(b64uText, "ascii").digest();
}

/** Strict JSON parse: UTF-8 only. */
export function parsePayloadJson(pt: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
  } catch {
    throw new LoginWireError("login_payload", "not UTF-8 JSON");
  }
}

/** Serialisation in the contract field order (the vectors depend on the order). */
export function serializeOrdered(o: Record<string, unknown>, order: readonly string[]): Buffer {
  const out: Record<string, unknown> = {};
  for (const k of order) if (o[k] !== undefined) out[k] = o[k];
  return utf8(JSON.stringify(out));
}

/** Request freshness by the memory-authcheck clock: null in the window, else the reason (retry, edge-clock alarm). */
export function requestAgeProblem(ts: number, now: number): "too_old" | "from_future" | null {
  if (now - ts > REQUEST_MAX_AGE_MS) return "too_old";
  if (ts - now > REQUEST_MAX_FUTURE_MS) return "from_future";
  return null;
}

// ---------------------------------------------------------------- byte layout

/** Request AAD: v ‖ kid(uint16 BE) ‖ id(16) ‖ kind(1). */
export function requestAad(kid: number, id: Uint8Array, kind: LoginKindId): Buffer {
  return concat(Buffer.of(LOGIN_CHECK_VERSION), i2osp(kid, 2), id, Buffer.of(kind));
}

/** Request blob: v ‖ kid ‖ enc(32) ‖ ct. */
export function encodeRequestBlob(kid: number, enc: Uint8Array, ct: Uint8Array): Buffer {
  if (enc.length !== ENC_BYTES) throw new LoginWireError("login_blob", "enc");
  const blob = concat(Buffer.of(LOGIN_CHECK_VERSION), i2osp(kid, 2), enc, ct);
  if (blob.length > MAX_REQUEST_BLOB_BYTES) throw new LoginWireError("login_blob", "size");
  return blob;
}

export function parseRequestBlob(blob: Uint8Array): { kid: number; enc: Buffer; ct: Buffer } {
  const b = Buffer.from(blob);
  if (b.length < 1 + 2 + ENC_BYTES + TAG_BYTES || b.length > MAX_REQUEST_BLOB_BYTES) throw new LoginWireError("login_blob", "size");
  if (b[0] !== LOGIN_CHECK_VERSION) throw new LoginWireError("login_blob", "version");
  const kid = b.readUInt16BE(1);
  if (kid === 0) throw new LoginWireError("login_blob", "kid");
  return { kid, enc: b.subarray(3, 3 + ENC_BYTES), ct: b.subarray(3 + ENC_BYTES) };
}

/** Answer AAD: id(16) ‖ UTF-8(tx_id) ‖ nonce(16). */
export function answerAad(id: Uint8Array, txId: string, nonce: Uint8Array): Buffer {
  if (!TX_ID.test(txId) || nonce.length !== 16 || id.length !== 16) throw new LoginWireError("login_payload", "aad");
  return concat(id, utf8(txId), nonce);
}

export function encodeAnswerBlob(iv: Uint8Array, ct: Uint8Array): Buffer {
  if (iv.length !== IV_BYTES) throw new LoginWireError("login_blob", "iv");
  const blob = concat(Buffer.of(LOGIN_CHECK_VERSION), iv, ct);
  if (blob.length > MAX_ANSWER_BLOB_BYTES) throw new LoginWireError("login_blob", "size");
  return blob;
}

export function parseAnswerBlob(blob: Uint8Array): { iv: Buffer; ct: Buffer } {
  const b = Buffer.from(blob);
  if (b.length < 1 + IV_BYTES + TAG_BYTES || b.length > MAX_ANSWER_BLOB_BYTES) throw new LoginWireError("login_blob", "size");
  if (b[0] !== LOGIN_CHECK_VERSION) throw new LoginWireError("login_blob", "version");
  return { iv: b.subarray(1, 1 + IV_BYTES), ct: b.subarray(1 + IV_BYTES) };
}

/** Signed bytes of a request: label ‖ aad ‖ enc ‖ json. */
export function signatureInput(aad: Uint8Array, enc: Uint8Array, json: Uint8Array): Buffer {
  if (enc.length !== ENC_BYTES) throw new LoginWireError("login_blob", "enc");
  return concat(REQUEST_SIG_LABEL, aad, enc, json);
}

/** Request plaintext of 1e: skid(uint16 BE) ‖ sig(64) ‖ json. */
export function encodeSignedPlaintext(skid: number, sig: Uint8Array, json: Uint8Array): Buffer {
  if (!Number.isInteger(skid) || skid < 1 || skid > 0xffff) throw new LoginWireError("login_key", "skid");
  if (sig.length !== SIG_BYTES) throw new LoginWireError("login_signature", "signature length");
  return concat(i2osp(skid, SKID_BYTES), sig, json);
}

/** Parse of the 1e plaintext. Shorter than skid ‖ sig ‖ «{}» means no signature (sealed without edge-auth). */
export function parseSignedPlaintext(pt: Uint8Array): { skid: number; sig: Buffer; json: Buffer } {
  const b = Buffer.from(pt.buffer, pt.byteOffset, pt.byteLength);
  if (b.length < SKID_BYTES + SIG_BYTES + 2) throw new LoginWireError("login_signature", "layout");
  const skid = b.readUInt16BE(0);
  if (skid === 0) throw new LoginWireError("login_signature", "skid");
  return { skid, sig: b.subarray(SKID_BYTES, SKID_BYTES + SIG_BYTES), json: b.subarray(SKID_BYTES + SIG_BYTES) };
}

/** AES-256-GCM of the answer: ct ‖ tag. */
export function answerSeal(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array): Buffer {
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(aad);
  return concat(c.update(pt), c.final(), c.getAuthTag());
}

export function answerOpen(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array): Buffer {
  if (ct.length < TAG_BYTES) throw new LoginWireError("login_open_failed");
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
    return concat(d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final());
  } catch {
    throw new LoginWireError("login_open_failed");
  }
}
