// @memory/wire/login-edge: the edge side (edge-auth), signs and seals a login check request, opens the answer.
// The private key of memory-authcheck is not here and cannot be: only the public one of the anchors (authcheck_keys[]).
// The Ed25519 signing key is its own, edge-auth-sign-<skid> of LoadCredential; only edge-auth reads it, via the caller.
// The answer key lives in PendingCheck until the answer (≤ edge.login_check_timeout_sec) and is wiped after opening.
import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { b64u, concat, fromB64u, uuidBytes, wipe } from "./common/bytes.ts";
import { setupBaseS } from "./common/hpke.ts";
import {
  answerAad,
  answerOpen,
  encodeRequestBlob,
  encodeSignedPlaintext,
  kindId,
  LoginWireError,
  parseAnswerBlob,
  parsePayloadJson,
  REQUEST_FIELDS,
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
import type { EdgeAuthSignKey } from "./common/anchors.ts";
import type { LoginKindId, LoginKindName } from "./common/login-kinds.ts";

export { LoginWireError } from "./common/login-check.ts";
export { isNormalizedLogin, normalizeLogin } from "./common/login.ts";
export type { LoginAnswerPayload, LoginRequestPayload } from "./common/login-check.ts";
export type { EdgeAuthSignKey } from "./common/anchors.ts";

/** The authcheck public key from the anchors. */
export interface AuthcheckPublicKey {
  kid: number;
  /** 32 bytes X25519, base64url */
  pub: string;
  not_after?: string;
}

/** Seams for tests and vectors: randomness source and clock. Not set in production. */
export interface WireDeps {
  random?: (n: number) => Uint8Array;
  now?: () => number;
}

/** The edge-auth signing key: the skid number from the anchors (edge_auth_sign_keys[]) and the Ed25519 private key. */
export interface EdgeAuthSigner {
  skid: number;
  key: KeyObject;
}

export interface SealLoginCheckInput {
  key: AuthcheckPublicKey;
  /** the edge-auth signing key: without it the request is not sealed (authcheck does not answer an unsigned one) */
  signer: EdgeAuthSigner;
  /** uuid of the login.checks row (part of AAD) */
  id: string;
  kind: LoginKindName;
  /** request fields without v, kind, ts, nonce: sealLoginCheck sets those */
  fields: Omit<LoginRequestPayload, "v" | "kind" | "ts" | "nonce">;
}

/** A pending request: all that is needed to open the answer. The key is secret and never logged. */
export interface PendingCheck {
  readonly id: string;
  readonly kind: LoginKindId;
  readonly kid: number;
  readonly txId: string;
  readonly nonce: string;
  readonly sentAt: number;
  readonly key: Buffer;
}

export interface SealedRequest {
  /** the login.checks.blob column */
  blob: Buffer;
  /** the login.checks.kind column */
  kind: LoginKindId;
  kid: number;
  pending: PendingCheck;
}

/**
 * The key the edge encrypts to: the largest kid whose not_after is in the future.
 * None gives login_no_key: the login check is impossible, the edge answers with a retry-later message.
 */
export function pickAuthcheckKey<K extends AuthcheckPublicKey>(keys: readonly K[], now: number = Date.now()): K {
  let best: K | undefined;
  for (const k of keys) {
    const until = k.not_after ? Date.parse(k.not_after) : Number.NaN;
    if (!(until > now)) continue;
    if (!best || k.kid > best.kid) best = k;
  }
  if (!best) throw new LoginWireError("login_no_key");
  return best;
}

/**
 * Which key signs (the login-check contract, the section on signing key rotation): the largest skid of the anchors with not_after
 * in the future, with credentials edge-auth-sign-<skid> whose public key matches pub in the anchors. None gives
 * login_no_key: the request is not sealed, the check is closed (the edge answers retry later) instead of signing
 * with a key authcheck will not accept (the hostile-bridge alarm from a typo in a setting).
 */
export function pickEdgeAuthSigner(keys: readonly EdgeAuthSignKey[], signers: readonly EdgeAuthSigner[], now: number = Date.now()): EdgeAuthSigner {
  let best: EdgeAuthSigner | undefined;
  for (const k of keys) {
    if (!(Date.parse(k.not_after) > now)) continue;
    const s = signers.find((x) => x.skid === k.skid);
    if (!s || (best && best.skid > k.skid)) continue;
    let pub: string;
    try {
      pub = ed25519PublicOf(s.key);
    } catch {
      continue;
    }
    if (pub === k.pub) best = s;
  }
  if (!best) throw new LoginWireError("login_no_key", "edge-auth signing key");
  return best;
}

// PKCS#8 DER of an Ed25519 private key: the RFC 8410 prefix before the 32 seed bytes.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * The edge-auth signing private key from the service credentials (LoadCredential=edge-auth-sign-<skid>): PEM PKCS#8,
 * 32 seed bytes or their base64url. The caller reads the file; here it is only parsed.
 */
export function importEd25519SigningKey(input: string | Uint8Array): KeyObject {
  let k: KeyObject;
  try {
    if (typeof input === "string" && input.trim().startsWith("-----BEGIN PRIVATE KEY-----")) {
      k = createPrivateKey({ key: input.trim(), format: "pem" });
    } else {
      const seed = typeof input === "string" ? fromB64u(input.trim(), 32) : input.length === 32 ? Buffer.from(input) : null;
      if (!seed) throw new LoginWireError("login_key", "signing key format");
      const der = concat(ED25519_PKCS8_PREFIX, seed);
      try {
        k = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      } finally {
        wipe(der);
        wipe(seed);
      }
    }
  } catch (e) {
    if (e instanceof LoginWireError) throw e;
    throw new LoginWireError("login_key", "the signing key could not be parsed");
  }
  if (k.asymmetricKeyType !== "ed25519") throw new LoginWireError("login_key", "not Ed25519");
  return k;
}

/** The public key of a signing key: 32 bytes base64url, the edge_auth_sign_keys[].pub string in the anchors. */
export function ed25519PublicOf(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new LoginWireError("login_key", "not Ed25519");
  return jwk.x;
}

/**
 * Signs and seals a request: HPKE base to the authcheck public key, AAD = v ‖ kid ‖ id ‖ kind,
 * pt = skid ‖ Ed25519(sk, "memory-authcheck request sig v1" ‖ aad ‖ enc ‖ json) ‖ json.
 */
export function sealLoginCheck(input: SealLoginCheckInput, deps: WireDeps = {}): SealedRequest {
  const random = deps.random ?? randomBytes;
  const kind = kindId(input.kind);
  const id = uuidBytes(input.id);
  if (!id) throw new LoginWireError("login_id");
  const kid = input.key.kid;
  if (!Number.isInteger(kid) || kid < 1 || kid > 0xffff) throw new LoginWireError("login_key", "kid");
  const pub = fromB64u(input.key.pub, 32);
  if (!pub) throw new LoginWireError("login_key", "pub");
  const skid = input.signer?.skid;
  if (!Number.isInteger(skid) || skid < 1 || skid > 0xffff) throw new LoginWireError("login_key", "skid");
  if (input.signer.key?.asymmetricKeyType !== "ed25519" || input.signer.key.type !== "private") throw new LoginWireError("login_key", "signing key");

  const nonce = b64u(random(16));
  const ts = (deps.now ?? Date.now)();
  const payload = validateRequestPayload({ ...input.fields, v: 1, kind: input.kind, ts, nonce }, input.kind);
  const json = serializeOrdered(payload as unknown as Record<string, unknown>, REQUEST_FIELDS);

  const { enc, ctx } = setupBaseS(pub, REQUEST_INFO, { random });
  const aad = requestAad(kid, id, kind);
  let ct: Buffer;
  let key: Buffer;
  let pt: Buffer | undefined;
  let toSign: Buffer | undefined;
  try {
    toSign = signatureInput(aad, enc, json);
    pt = encodeSignedPlaintext(skid, sign(null, toSign, input.signer.key), json);
    ct = ctx.seal(aad, pt);
    key = ctx.export(RESPONSE_EXPORT_LABEL, RESPONSE_KEY_BYTES);
  } finally {
    ctx.destroy();
    wipe(pt);
    wipe(toSign);
    wipe(json);
  }
  let blob: Buffer;
  try {
    blob = encodeRequestBlob(kid, enc, ct);
  } catch (e) {
    wipe(key);
    throw e;
  }
  const pending: PendingCheck = Object.freeze({ id: input.id, kind, kid, txId: payload.tx_id, nonce, sentAt: ts, key });
  return { blob, kind, kid, pending };
}

/**
 * Opens the authcheck answer to its request. An answer changed by the bridge or for another request: login_open_failed.
 * After a successful open the key of the pending request is wiped: a second answer does not open.
 */
export function openAnswer(pending: PendingCheck, blob: Uint8Array): LoginAnswerPayload {
  const { iv, ct } = parseAnswerBlob(blob);
  const id = uuidBytes(pending.id);
  const nonce = fromB64u(pending.nonce, 16);
  if (!id || !nonce || pending.key.length !== RESPONSE_KEY_BYTES || pending.key.every((b) => b === 0)) throw new LoginWireError("login_open_failed");
  const pt = answerOpen(pending.key, iv, answerAad(id, pending.txId, nonce), ct);
  const answer = validateAnswerPayload(parsePayloadJson(pt));
  wipe(pt);
  wipe(pending.key);
  return answer;
}
