// @memory/wire/login-inner: the memory-authcheck side, opens a login check request and seals the answer.
// Inside only: neither the edge nor the bridge builds this module (the maintainers' isolation checks hold this).
// The check order of authcheck (the login-check contract): parse v and kid → open with AAD → edge-auth signature (step 2a) →
// ts freshness → nonce single use → budgets, AD, factor. Steps 1, 2 and 2a are here (openLoginCheck); freshness is
// requestAgeProblem; nonce and everything after it is memory-authcheck. JSON is not parsed before the signature check.
import { createPrivateKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { fromB64u, uuidBytes, wipe } from "./common/bytes.ts";
import type { EdgeAuthSignKey } from "./common/anchors.ts";
import { HpkeError, setupBaseR, x25519PrivateKey } from "./common/hpke.ts";
import { ed25519KeyObject } from "./common/sshsig.ts";
import {
  ANSWER_FIELDS,
  answerAad,
  answerSeal,
  encodeAnswerBlob,
  kindName,
  LoginWireError,
  parsePayloadJson,
  parseRequestBlob,
  parseSignedPlaintext,
  REQUEST_INFO,
  requestAad,
  RESPONSE_EXPORT_LABEL,
  RESPONSE_KEY_BYTES,
  serializeOrdered,
  signatureInput,
  validateAnswerPayload,
  validateRequestPayload,
  type LoginAnswerPayload,
  type LoginRequestPayload,
} from "./common/login-check.ts";
import type { LoginKindId } from "./common/login-kinds.ts";

export { LoginWireError, requestAgeProblem, REQUEST_MAX_AGE_MS, REQUEST_MAX_FUTURE_MS } from "./common/login-check.ts";
export { isNormalizedLogin, normalizeLogin } from "./common/login.ts";
export type { EdgeAuthSignKey } from "./common/anchors.ts";
export type { LoginAnswerPayload, LoginRequestPayload } from "./common/login-check.ts";

/** The private key by kid; none gives undefined (the request is for another key, so no answer and an alarm). */
export type KeyLookup = (kid: number) => KeyObject | Uint8Array | undefined;

/** A login.checks row as the bridge returns it: id and kind are columns, blob is opaque. */
export interface CheckRow {
  id: string;
  kind: number;
  blob: Uint8Array;
}

/** Everything needed for the answer. The key is secret and never logged; sealAnswer wipes it. */
export interface ReplyContext {
  readonly id: string;
  readonly kind: LoginKindId;
  readonly kid: number;
  readonly txId: string;
  readonly nonce: string;
  readonly key: Buffer;
}

export interface OpenedRequest {
  kid: number;
  /** id of the edge-auth signing key that signed the request */
  skid: number;
  request: LoginRequestPayload;
  reply: ReplyContext;
}

/**
 * The X25519 private key from the service credentials (LoadCredential): PEM PKCS#8, 32 raw bytes or their base64url.
 * The caller reads the file (readCredential of @memory/shared); here it is only parsed.
 */
export function importX25519PrivateKey(input: string | Uint8Array): KeyObject {
  if (typeof input === "string") {
    const s = input.trim();
    if (s.startsWith("-----BEGIN PRIVATE KEY-----")) {
      const k = createPrivateKey({ key: s, format: "pem" });
      if (k.asymmetricKeyType !== "x25519") throw new LoginWireError("login_key", "not X25519");
      return k;
    }
    const raw = fromB64u(s, 32);
    if (!raw) throw new LoginWireError("login_key", "format");
    return x25519PrivateKey(raw);
  }
  if (input.length !== 32) throw new LoginWireError("login_key", "length");
  return x25519PrivateKey(input);
}

/**
 * The signing key by skid from the anchors (edge_auth_sign_keys[]): present, not expired, public key parses. Else
 * login_signature (a request without a login signature: no answer, high alarm request_unsigned).
 */
function signKeyFor(keys: readonly EdgeAuthSignKey[] | undefined, skid: number, now: number): KeyObject {
  const k = (keys ?? []).find((x) => x.skid === skid);
  if (!k) throw new LoginWireError("login_signature", "skid");
  if (!(Date.parse(k.not_after) > now)) throw new LoginWireError("login_signature", "expired");
  const raw = fromB64u(k.pub, 32);
  if (!raw) throw new LoginWireError("login_signature", "key");
  try {
    return ed25519KeyObject(raw);
  } catch {
    throw new LoginWireError("login_signature", "key");
  }
}

/**
 * Opens the request, checks the edge-auth signature (steps 1, 2, 2a of the login-check contract). Unknown kid: login_unknown_kid;
 * a changed id, kind, kid or content: login_open_failed; no signature, a skid not in the anchors or expired, a wrong
 * signature: login_signature (before JSON parsing); a plaintext off the contract or a kind ≠ the row kind:
 * login_payload / login_kind. In all these cases no answer. signKeys is edge_auth_sign_keys of the accepted anchors.
 */
export function openLoginCheck(row: CheckRow, lookup: KeyLookup, signKeys: readonly EdgeAuthSignKey[] | undefined, now: number = Date.now()): OpenedRequest {
  const kind = row.kind as LoginKindId;
  const name = kindName(row.kind);
  const id = uuidBytes(row.id);
  if (!id) throw new LoginWireError("login_id");
  const { kid, enc, ct } = parseRequestBlob(row.blob);
  const sk = lookup(kid);
  if (!sk) throw new LoginWireError("login_unknown_kid", String(kid));

  const aad = requestAad(kid, id, kind);
  let pt: Buffer;
  let key: Buffer;
  try {
    const ctx = setupBaseR(enc, sk, REQUEST_INFO);
    try {
      pt = ctx.open(aad, ct);
      key = ctx.export(RESPONSE_EXPORT_LABEL, RESPONSE_KEY_BYTES);
    } finally {
      ctx.destroy();
    }
  } catch (e) {
    if (e instanceof HpkeError || e instanceof LoginWireError) throw new LoginWireError("login_open_failed");
    throw e;
  }
  let request: LoginRequestPayload;
  let skid: number;
  try {
    // 2a. The edge-auth signature over aad ‖ enc ‖ json, before JSON parsing.
    const signed = parseSignedPlaintext(pt);
    skid = signed.skid;
    const pub = signKeyFor(signKeys, signed.skid, now);
    // The signed bytes hold the password and are wiped right after the check.
    const input = signatureInput(aad, enc, signed.json);
    let ok = false;
    try {
      ok = verify(null, input, pub, signed.sig);
    } catch {
      ok = false;
    } finally {
      wipe(input);
    }
    if (!ok) throw new LoginWireError("login_signature", "sig");
    request = validateRequestPayload(parsePayloadJson(signed.json), name);
  } catch (e) {
    wipe(key);
    throw e;
  } finally {
    wipe(pt);
  }
  const reply: ReplyContext = Object.freeze({ id: row.id, kind, kid, txId: request.tx_id, nonce: request.nonce, key });
  return { kid, skid, request, reply };
}

/** Seals the answer: AES-256-GCM with the Export key, AAD = id ‖ tx_id ‖ nonce. One answer per request; key wiped. */
export function sealAnswer(reply: ReplyContext, answer: Omit<LoginAnswerPayload, "v">, deps: { random?: (n: number) => Uint8Array } = {}): Buffer {
  const id = uuidBytes(reply.id);
  const nonce = fromB64u(reply.nonce, 16);
  if (!id || !nonce || reply.key.length !== RESPONSE_KEY_BYTES || reply.key.every((b) => b === 0)) throw new LoginWireError("login_key", "the response key has already been used");
  const payload = validateAnswerPayload({ ...answer, v: 1 });
  const pt = serializeOrdered(payload as unknown as Record<string, unknown>, ANSWER_FIELDS);
  const iv = Buffer.from((deps.random ?? randomBytes)(12));
  try {
    return encodeAnswerBlob(iv, answerSeal(reply.key, iv, answerAad(id, reply.txId, nonce), pt));
  } finally {
    wipe(pt);
    wipe(reply.key);
  }
}
