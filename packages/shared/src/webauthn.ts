import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";

export type WebAuthnCode =
  | "cbor_invalid" | "auth_data_invalid" | "client_data_invalid" | "response_invalid" | "type_mismatch" | "challenge_mismatch"
  | "origin_mismatch" | "cross_origin" | "rp_id_mismatch" | "user_not_present" | "user_not_verified" | "no_credential_data"
  | "key_unsupported" | "attestation_invalid" | "credential_mismatch" | "user_handle_mismatch" | "signature_invalid" | "counter_rollback";

export class WebAuthnError extends Error {
  constructor(readonly code: WebAuthnCode, message: string) { super(message); this.name = "WebAuthnError"; }
}
const fail = (code: WebAuthnCode, message: string): never => { throw new WebAuthnError(code, message); };

function guarded<T>(code: WebAuthnCode, run: () => T): T {
  try { return run(); } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError(code, `could not parse the data: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------- base64url
const B64URL = /^[A-Za-z0-9_-]*$/;
export function b64urlDecode(s: unknown): Buffer | null {
  if (typeof s !== "string" || !B64URL.test(s) || s.length % 4 === 1) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}
export const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export type CborValue = number | string | Buffer | boolean | null | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

export const CBOR_MAX_BYTES = 4096;
export const CBOR_MAX_DEPTH = 8;
export interface CborLimits { maxBytes?: number; maxDepth?: number }

const utf8 = new TextDecoder("utf-8", { fatal: true });

class CborReader {
  constructor(private readonly b: Buffer, public pos: number, private readonly maxDepth: number) {}
  private need(n: number): void { if (n < 0 || this.pos + n > this.b.length) fail("cbor_invalid", "CBOR data is truncated"); }
  private arg(ai: number): number {
    if (ai < 24) return ai;
    const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0;
    if (!width) return fail("cbor_invalid", ai === 31 ? "indefinite length is not accepted" : "reserved additional argument");
    this.need(width);
    let v: number;
    if (width === 8) {
      const big = this.b.readBigUInt64BE(this.pos);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail("cbor_invalid", "integer exceeds 2^53");
      v = Number(big);
    } else v = this.b.readUIntBE(this.pos, width);
    this.pos += width;
    return v;
  }
  read(depth: number): CborValue {
    this.need(1);
    const head = this.b[this.pos++]!;
    const major = head >> 5, ai = head & 0x1f;
    switch (major) {
      case 0: return this.arg(ai);
      case 1: return -1 - this.arg(ai);
      case 2: case 3: {
        const n = this.arg(ai);
        this.need(n);
        const bytes = this.b.subarray(this.pos, this.pos + n);
        this.pos += n;
        if (major === 2) return Buffer.from(bytes);
        try { return utf8.decode(bytes); } catch { return fail("cbor_invalid", "string is not UTF-8"); }
      }
      case 4: case 5: {
        if (depth + 1 > this.maxDepth) fail("cbor_invalid", `nesting exceeds ${this.maxDepth}`);
        const n = this.arg(ai);
        if (n * (major === 5 ? 2 : 1) > this.b.length - this.pos) fail("cbor_invalid", "length exceeds the remaining data");
        if (major === 4) {
          const out: CborValue[] = [];
          for (let i = 0; i < n; i++) out.push(this.read(depth + 1));
          return out;
        }
        const m: CborMap = new Map();
        for (let i = 0; i < n; i++) {
          const k = this.read(depth + 1);
          if (typeof k !== "number" && typeof k !== "string") fail("cbor_invalid", "map key must be a number or string");
          if (m.has(k as number | string)) fail("cbor_invalid", "duplicate map key");
          m.set(k as number | string, this.read(depth + 1));
        }
        return m;
      }
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        return fail("cbor_invalid", "simple values and floating-point numbers are not accepted");
      default:
        return fail("cbor_invalid", "CBOR tags are not accepted");
    }
  }
}

function asBuffer(input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array)) fail("cbor_invalid", "expected bytes");
  return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function cborDecodeFirst(input: Uint8Array, offset = 0, o: CborLimits = {}): { value: CborValue; end: number } {
  return guarded("cbor_invalid", () => {
    const b = asBuffer(input);
    if (b.length > (o.maxBytes ?? CBOR_MAX_BYTES)) fail("cbor_invalid", `CBOR data exceeds ${o.maxBytes ?? CBOR_MAX_BYTES} bytes`);
    const r = new CborReader(b, offset, o.maxDepth ?? CBOR_MAX_DEPTH);
    const value = r.read(0);
    return { value, end: r.pos };
  });
}

export function cborDecode(input: Uint8Array, o: CborLimits = {}): CborValue {
  const { value, end } = cborDecodeFirst(input, 0, o);
  if (end !== input.length) fail("cbor_invalid", "extra bytes after the CBOR value");
  return value;
}

const isMap = (v: unknown): v is CborMap => v instanceof Map;

// ---------------------------------------------------------------- authenticatorData (W3C §6.1)
export interface AuthenticatorFlags { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean }
export interface AttestedCredential { aaguid: Buffer; credentialId: Buffer; publicKey: CborMap }
export interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: AuthenticatorFlags;
  signCount: number;
  attested: AttestedCredential | null;
  extensions: CborMap | null;
}

export const CREDENTIAL_ID_MAX = 1023;

export function parseAuthenticatorData(input: Uint8Array): AuthenticatorData {
  return guarded("auth_data_invalid", () => {
    const b = asBuffer(input);
    if (b.length < 37) fail("auth_data_invalid", "authenticatorData is shorter than 37 bytes");
    if (b.length > CBOR_MAX_BYTES) fail("auth_data_invalid", `authenticatorData exceeds ${CBOR_MAX_BYTES} bytes`);
    const f = b[32]!;
    const flags: AuthenticatorFlags = { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10), at: !!(f & 0x40), ed: !!(f & 0x80) };
    if (flags.bs && !flags.be) fail("auth_data_invalid", "BS flag is set without BE");
    const signCount = b.readUInt32BE(33);
    let pos = 37, attested: AttestedCredential | null = null, extensions: CborMap | null = null;
    if (flags.at) {
      if (b.length < pos + 18) fail("auth_data_invalid", "key data is missing with the AT flag set");
      const aaguid = Buffer.from(b.subarray(pos, pos + 16));
      const idLen = b.readUInt16BE(pos + 16);
      pos += 18;
      if (idLen < 1 || idLen > CREDENTIAL_ID_MAX || b.length < pos + idLen) fail("auth_data_invalid", "invalid credential ID length");
      const credentialId = Buffer.from(b.subarray(pos, pos + idLen));
      pos += idLen;
      const key = cborDecodeFirst(b, pos);
      if (!isMap(key.value)) fail("auth_data_invalid", "COSE key is not a map");
      pos = key.end;
      attested = { aaguid, credentialId, publicKey: key.value as CborMap };
    }
    if (flags.ed) {
      const ext = cborDecodeFirst(b, pos);
      if (!isMap(ext.value)) fail("auth_data_invalid", "extensions are not a map");
      pos = ext.end;
      extensions = ext.value as CborMap;
    }
    if (pos !== b.length) fail("auth_data_invalid", "extra bytes in authenticatorData");
    return { rpIdHash: Buffer.from(b.subarray(0, 32)), flags, signCount, attested, extensions };
  });
}

export type CoseAlg = -7 | -8 | -257;
export const COSE_ALGS: readonly CoseAlg[] = [-7, -8, -257];
export interface CredentialPublicKey { alg: CoseAlg; key: KeyObject; spki: Buffer }

const bytesOf = (m: CborMap, k: number, len?: number): Buffer => {
  const v = m.get(k);
  if (!Buffer.isBuffer(v) || (len !== undefined && v.length !== len)) fail("key_unsupported", `COSE key parameter ${k}`);
  return v as Buffer;
};

export function coseToPublicKey(cose: CborMap): CredentialPublicKey {
  return guarded("key_unsupported", () => {
    const kty = cose.get(1), alg = cose.get(3);
    if (cose.has(-4)) fail("key_unsupported", "COSE key contains a private component");
    let key: KeyObject;
    if (alg === -7) {
      if (kty !== 2 || cose.get(-1) !== 1) fail("key_unsupported", "ES256: requires kty 2 and curve P-256");
      key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64url(bytesOf(cose, -2, 32)), y: b64url(bytesOf(cose, -3, 32)) } });
    } else if (alg === -8) {
      if (kty !== 1 || cose.get(-1) !== 6) fail("key_unsupported", "EdDSA: requires kty 1 and curve Ed25519");
      key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: b64url(bytesOf(cose, -2, 32)) } });
    } else if (alg === -257) {
      if (kty !== 3) fail("key_unsupported", "RS256: requires kty 3");
      key = createPublicKey({ format: "jwk", key: { kty: "RSA", n: b64url(bytesOf(cose, -1)), e: b64url(bytesOf(cose, -2)) } });
    } else return fail("key_unsupported", `COSE algorithm ${String(alg).slice(0, 12)} is not accepted`);
    return { alg: alg as CoseAlg, key: checkedKey(key, alg as CoseAlg), spki: key.export({ type: "spki", format: "der" }) };
  });
}

function checkedKey(key: KeyObject, alg: CoseAlg): KeyObject {
  const t = key.asymmetricKeyType, d = key.asymmetricKeyDetails ?? {};
  const okType = alg === -7 ? t === "ec" && d.namedCurve === "prime256v1"
    : alg === -8 ? t === "ed25519"
      : t === "rsa" && typeof d.modulusLength === "number" && d.modulusLength >= 2048;
  if (!okType) fail("key_unsupported", `key does not match algorithm ${alg}`);
  return key;
}

export function publicKeyFromSpki(spki: Uint8Array, alg: number): KeyObject {
  return guarded("key_unsupported", () => {
    if (!COSE_ALGS.includes(alg as CoseAlg)) fail("key_unsupported", `algorithm ${alg} is not accepted`);
    return checkedKey(createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" }), alg as CoseAlg);
  });
}

export const publicKeySha256 = (spki: Uint8Array): string => createHash("sha256").update(spki).digest("hex");

// ---------------------------------------------------------------- clientDataJSON (W3C §5.8.1)
export interface ClientData { type: string; challenge: Buffer; origin: string; crossOrigin: boolean; topOrigin: string | null }

export function parseClientData(input: Uint8Array): ClientData {
  return guarded("client_data_invalid", () => {
    const b = asBuffer(input);
    if (b.length > CBOR_MAX_BYTES) fail("client_data_invalid", `clientDataJSON exceeds ${CBOR_MAX_BYTES} bytes`);
    let j: unknown;
    try { j = JSON.parse(utf8.decode(b)); } catch { return fail("client_data_invalid", "clientDataJSON is not UTF-8 JSON"); }
    if (!j || typeof j !== "object" || Array.isArray(j)) fail("client_data_invalid", "clientDataJSON is not an object");
    const o = j as Record<string, unknown>;
    if (typeof o.type !== "string" || typeof o.origin !== "string") fail("client_data_invalid", "type or origin is missing");
    const challenge = b64urlDecode(o.challenge);
    if (!challenge || !challenge.length) fail("client_data_invalid", "challenge is not base64url");
    if (o.crossOrigin !== undefined && typeof o.crossOrigin !== "boolean") fail("client_data_invalid", "crossOrigin must be true/false");
    if (o.topOrigin !== undefined && typeof o.topOrigin !== "string") fail("client_data_invalid", "topOrigin is not a string");
    return { type: o.type as string, challenge: challenge!, origin: o.origin as string, crossOrigin: o.crossOrigin === true,
             topOrigin: typeof o.topOrigin === "string" ? o.topOrigin : null };
  });
}

const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

function checkClientData(cd: ClientData, type: "webauthn.create" | "webauthn.get", challenge: Buffer, origins: readonly string[]): void {
  if (cd.type !== type) fail("type_mismatch", `type ${cd.type.slice(0, 40)} was provided instead of ${type}`);
  if (!sameBytes(cd.challenge, challenge)) fail("challenge_mismatch", "challenge does not match the one issued");
  if (!origins.includes(cd.origin)) fail("origin_mismatch", "origin is not in admin.webauthn_origins");
  if (cd.crossOrigin || cd.topOrigin !== null) fail("cross_origin", "credential was requested from a cross-origin frame");
}

function checkAuthData(ad: AuthenticatorData, rpId: string, requireUv: boolean): void {
  if (!sameBytes(ad.rpIdHash, sha256(rpId))) fail("rp_id_mismatch", "rpIdHash does not match admin.webauthn_rp_id");
  if (!ad.flags.up) fail("user_not_present", "UP flag is missing");
  if (requireUv && !ad.flags.uv) fail("user_not_verified", "UV flag is missing with admin.webauthn_uv = required");
}

interface CredentialJson { id: Buffer; response: Record<string, unknown> }

function credentialJson(raw: unknown): CredentialJson {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("response_invalid", "credential response is not an object");
  const c = raw as Record<string, unknown>;
  if (c.type !== "public-key") fail("response_invalid", "type is not public-key");
  const id = b64urlDecode(c.id), rawId = c.rawId === undefined ? id : b64urlDecode(c.rawId);
  if (!id || !id.length || id.length > CREDENTIAL_ID_MAX || !rawId || !id.equals(rawId)) fail("response_invalid", "invalid credential id and rawId");
  if (!c.response || typeof c.response !== "object" || Array.isArray(c.response)) fail("response_invalid", "response is missing");
  return { id: id!, response: c.response as Record<string, unknown> };
}
const field = (r: Record<string, unknown>, k: string): Buffer => {
  const v = b64urlDecode(r[k]);
  if (!v || !v.length) fail("response_invalid", `response.${k} is not base64url`);
  return v!;
};

export function credentialIdOf(raw: unknown): Buffer | null {
  try { return credentialJson(raw).id; } catch { return null; }
}

export const TRANSPORTS = ["usb", "nfc", "ble", "smart-card", "hybrid", "internal"] as const;
const transportsOf = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && (TRANSPORTS as readonly string[]).includes(x)))] : [];

export type UserVerification = "required" | "preferred";
export interface CredentialDescriptor { id: Buffer; transports?: readonly string[] }
const descriptor = (d: CredentialDescriptor) => ({ type: "public-key" as const, id: b64url(d.id), ...(d.transports?.length ? { transports: [...d.transports] } : {}) });

export interface CreationOptionsInput {
  rpId: string; rpName: string; user: { id: Buffer; name: string; displayName: string }; challenge: Buffer;
  exclude: readonly CredentialDescriptor[]; userVerification: UserVerification; timeoutMs?: number;
  attestation?: "none" | "direct";
}
export function registrationOptions(i: CreationOptionsInput) {
  return {
    rp: { id: i.rpId, name: i.rpName },
    user: { id: b64url(i.user.id), name: i.user.name, displayName: i.user.displayName },
    challenge: b64url(i.challenge),
    pubKeyCredParams: COSE_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
    timeout: i.timeoutMs ?? 120_000,
    excludeCredentials: i.exclude.map(descriptor),
    authenticatorSelection: { residentKey: "discouraged" as const, requireResidentKey: false, userVerification: i.userVerification },
    attestation: i.attestation ?? ("none" as const),
  };
}

export interface RequestOptionsInput { rpId: string; challenge: Buffer; allow: readonly CredentialDescriptor[]; userVerification: UserVerification; timeoutMs?: number }
export function assertionOptions(i: RequestOptionsInput) {
  return { challenge: b64url(i.challenge), rpId: i.rpId, allowCredentials: i.allow.map(descriptor), userVerification: i.userVerification, timeout: i.timeoutMs ?? 120_000 };
}

export const newChallenge = (): Buffer => randomBytes(32);

export interface RegistrationCheck {
  credential: unknown; challenge: Buffer; origins: readonly string[]; rpId: string; requireUv: boolean;
}
export interface VerifiedRegistration {
  credentialId: Buffer; publicKey: Buffer; alg: CoseAlg; signCount: number; aaguid: Buffer;
  backupEligible: boolean; backupState: boolean; uv: boolean; transports: string[]; fmt: string;
}

export function verifyRegistration(c: RegistrationCheck): VerifiedRegistration {
  return guarded("response_invalid", () => {
    const cred = credentialJson(c.credential);
    const cd = parseClientData(field(cred.response, "clientDataJSON"));
    checkClientData(cd, "webauthn.create", c.challenge, c.origins);
    const att = cborDecode(field(cred.response, "attestationObject"));
    if (!isMap(att)) return fail("attestation_invalid", "attestationObject is not a map");
    const fmt = att.get("fmt"), stmt = att.get("attStmt"), authData = att.get("authData");
    if (typeof fmt !== "string" || !fmt || fmt.length > 32 || !isMap(stmt) || !Buffer.isBuffer(authData)) fail("attestation_invalid", "fmt, attStmt or authData is missing");
    if (fmt === "none" && (stmt as CborMap).size !== 0) fail("attestation_invalid", "none attestation has a nonempty attStmt");
    const ad = parseAuthenticatorData(authData as Buffer);
    checkAuthData(ad, c.rpId, c.requireUv);
    if (!ad.flags.at || !ad.attested) fail("no_credential_data", "credential data is missing (AT flag)");
    const a = ad.attested!;
    if (!a.credentialId.equals(cred.id)) fail("credential_mismatch", "credential ID in authData did not match the response");
    const key = coseToPublicKey(a.publicKey);
    return { credentialId: a.credentialId, publicKey: key.spki, alg: key.alg, signCount: ad.signCount, aaguid: a.aaguid,
             backupEligible: ad.flags.be, backupState: ad.flags.bs, uv: ad.flags.uv, transports: transportsOf(cred.response.transports), fmt: fmt as string };
  });
}

export interface StoredCredential { credentialId: Buffer; publicKey: Buffer; alg: number; signCount: number; userHandle?: Buffer | null }
export interface AssertionCheck { credential: unknown; challenge: Buffer; origins: readonly string[]; rpId: string; requireUv: boolean; stored: StoredCredential }
export interface VerifiedAssertion { signCount: number; uv: boolean; backupState: boolean }

export function counterOk(stored: number, received: number): boolean {
  return (stored === 0 && received === 0) || received > stored;
}

export function verifyAssertion(c: AssertionCheck): VerifiedAssertion {
  return guarded("response_invalid", () => {
    const cred = credentialJson(c.credential);
    if (!cred.id.equals(c.stored.credentialId)) fail("credential_mismatch", "response used a different credential");
    const clientDataJSON = field(cred.response, "clientDataJSON");
    const cd = parseClientData(clientDataJSON);
    checkClientData(cd, "webauthn.get", c.challenge, c.origins);
    const authData = field(cred.response, "authenticatorData");
    const ad = parseAuthenticatorData(authData);
    if (ad.flags.at) fail("auth_data_invalid", "AT flag was set during sign-in");
    checkAuthData(ad, c.rpId, c.requireUv);
    const uh = cred.response.userHandle;
    if (uh !== undefined && uh !== null && uh !== "") {
      const got = b64urlDecode(uh);
      if (!got || !c.stored.userHandle || !got.equals(c.stored.userHandle)) fail("user_handle_mismatch", "userHandle belongs to a different person");
    }
    const sig = field(cred.response, "signature");
    const key = publicKeyFromSpki(c.stored.publicKey, c.stored.alg);
    const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
    let ok = false;
    try {
      ok = c.stored.alg === -8 ? cryptoVerify(null, signed, key, sig)
        : c.stored.alg === -7 ? cryptoVerify("sha256", signed, { key, dsaEncoding: "der" }, sig)
          : cryptoVerify("sha256", signed, key, sig);
    } catch { ok = false; }
    if (!ok) fail("signature_invalid", "signature does not match the key");
    if (!counterOk(c.stored.signCount, ad.signCount)) fail("counter_rollback", "signature counter did not increase");
    return { signCount: ad.signCount, uv: ad.flags.uv, backupState: ad.flags.bs };
  });
}

export class ChallengeStore<T> {
  private items = new Map<string, { value: T; at: number }>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly max = 10_000) {}
  put(value: T, now = Date.now()): string {
    for (const [k, v] of this.items) {
      if (now - v.at >= this.ttlMs || this.items.size >= this.max) this.items.delete(k);
      else break;
    }
    const tx = randomBytes(32).toString("base64url");
    this.items.set(tx, { value, at: now });
    return tx;
  }
  take(tx: unknown, now = Date.now()): T | null {
    if (typeof tx !== "string" || tx.length > 128) return null;
    const v = this.items.get(tx);
    if (!v) return null;
    this.items.delete(tx);
    return now - v.at < this.ttlMs ? v.value : null;
  }
  get size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
