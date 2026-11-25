// HPKE (RFC 9180), base mode, on node:crypto (no third-party @hpke/* packages).
// The suite in use: KEM DHKEM(X25519, HKDF-SHA256) 0x0020, KDF HKDF-SHA256 0x0001, AEAD AES-256-GCM 0x0002.
// AES-128-GCM 0x0001 is kept only to check the core against the RFC 9180 A.1 vectors (same KEM and KDF); login requests
// always use the suite 0x0020/0x0001/0x0002: the suite choice is not sent over the network, nothing to downgrade.
// Correctness is shown by the RFC 9180 vectors for both suites (unit tests).
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  KeyObject,
  randomBytes,
} from "node:crypto";
import { concat, equalBytes, i2osp, utf8, wipe } from "./bytes.ts";

export const KEM_DHKEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;
export type AeadId = typeof AEAD_AES_128_GCM | typeof AEAD_AES_256_GCM;

/** Lengths of the suite (RFC 9180 §7.1, §7.2, §7.3). */
export const N_SECRET = 32;
export const N_ENC = 32;
export const N_PK = 32;
export const N_SK = 32;
const N_H = 32;
const N_N = 12;
const N_T = 16;
const MODE_BASE = 0x00;
/** Limit of the context message counter: 2^(8·Nn) − 1. */
const SEQ_MAX = (1n << BigInt(8 * N_N)) - 1n;

export class HpkeError extends Error {
  constructor(readonly code: "hpke_bad_key" | "hpke_dh_zero" | "hpke_open_failed" | "hpke_seq_overflow" | "hpke_bad_length" | "hpke_wrong_role" | "hpke_destroyed") {
    super(code);
    this.name = "HpkeError";
  }
}

const aeadParams = (aead: AeadId) =>
  aead === AEAD_AES_256_GCM ? { cipher: "aes-256-gcm" as const, nk: 32 } : aead === AEAD_AES_128_GCM ? { cipher: "aes-128-gcm" as const, nk: 16 } : (() => { throw new HpkeError("hpke_bad_key"); })();

const HPKE_V1 = utf8("HPKE-v1");
const EMPTY = Buffer.alloc(0);
const ZERO_DH = Buffer.alloc(N_SECRET);
const KEM_SUITE_ID = concat(utf8("KEM"), i2osp(KEM_DHKEM_X25519_HKDF_SHA256, 2));
const hpkeSuiteId = (aead: AeadId) =>
  concat(utf8("HPKE"), i2osp(KEM_DHKEM_X25519_HKDF_SHA256, 2), i2osp(KDF_HKDF_SHA256, 2), i2osp(aead, 2));

// ---------------------------------------------------------------- HKDF-SHA256 (RFC 5869) and labelled versions (RFC 9180)

/** HKDF-Extract: an empty salt is an HMAC key of zero length (equal to HashLen zeros, RFC 5869 §2.2). */
function extract(salt: Uint8Array, ikm: Uint8Array): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

function expand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  if (!Number.isInteger(length) || length < 0 || length > 255 * N_H) throw new HpkeError("hpke_bad_length");
  const out: Buffer[] = [];
  let t: Buffer = EMPTY;
  for (let i = 1, have = 0; have < length; i++) {
    t = createHmac("sha256", prk).update(t).update(info).update(Buffer.of(i)).digest();
    out.push(t);
    have += t.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(salt, concat(HPKE_V1, suite, utf8(label), ikm));

const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) => {
  if (length > 0xffff) throw new HpkeError("hpke_bad_length");
  return expand(prk, concat(i2osp(length, 2), HPKE_V1, suite, utf8(label), info), length);
};

// ---------------------------------------------------------------- X25519 (RFC 7748) in DER wrappers for node:crypto

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

/** X25519 private key from 32 raw bytes (as in the RFC 9180 vectors; the operation itself clamps the bits). */
export function x25519PrivateKey(sk: Uint8Array): KeyObject {
  if (sk.length !== N_SK) throw new HpkeError("hpke_bad_key");
  return createPrivateKey({ key: concat(PKCS8_X25519, sk), format: "der", type: "pkcs8" });
}

/** X25519 public key from 32 raw bytes. */
export function x25519PublicKey(pk: Uint8Array): KeyObject {
  if (pk.length !== N_PK) throw new HpkeError("hpke_bad_key");
  return createPublicKey({ key: concat(SPKI_X25519, pk), format: "der", type: "spki" });
}

/** The 32 raw bytes of an X25519 public key (SerializePublicKey). */
export function x25519PublicBytes(key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== "x25519") throw new HpkeError("hpke_bad_key");
  const pub = key.type === "private" ? createPublicKey(key) : key;
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.from(der.subarray(der.length - N_PK));
}

function asPrivate(sk: KeyObject | Uint8Array): KeyObject {
  if (sk instanceof KeyObject) {
    if (sk.type !== "private" || sk.asymmetricKeyType !== "x25519") throw new HpkeError("hpke_bad_key");
    return sk;
  }
  return x25519PrivateKey(sk);
}

function asPublic(pk: KeyObject | Uint8Array): KeyObject {
  if (pk instanceof KeyObject) {
    if (pk.type !== "public" || pk.asymmetricKeyType !== "x25519") throw new HpkeError("hpke_bad_key");
    return pk;
  }
  return x25519PublicKey(pk);
}

/** DH with a check of an all-zero result (RFC 9180 §7.1.4: a small-order point is an error). */
function dh(sk: KeyObject, pk: KeyObject): Buffer {
  let z: Buffer;
  try {
    z = diffieHellman({ privateKey: sk, publicKey: pk });
  } catch {
    throw new HpkeError("hpke_dh_zero");
  }
  if (equalBytes(z, ZERO_DH)) throw new HpkeError("hpke_dh_zero");
  return z;
}

// ---------------------------------------------------------------- DHKEM

export interface X25519KeyPair {
  /** the private key, 32 raw bytes; keep it secret */
  sk: Buffer;
  pk: Buffer;
}

/** DeriveKeyPair: an X25519 pair from ikm (at least 32 bytes). */
export function deriveKeyPair(ikm: Uint8Array): X25519KeyPair {
  if (ikm.length < N_SK) throw new HpkeError("hpke_bad_length");
  const dkpPrk = labeledExtract(KEM_SUITE_ID, EMPTY, "dkp_prk", ikm);
  const sk = labeledExpand(KEM_SUITE_ID, dkpPrk, "sk", EMPTY, N_SK);
  wipe(dkpPrk);
  return { sk, pk: x25519PublicBytes(x25519PrivateKey(sk)) };
}

/** GenerateKeyPair: DeriveKeyPair of 32 random bytes. */
export function generateKeyPair(random: (n: number) => Uint8Array = randomBytes): X25519KeyPair {
  const ikm = Buffer.from(random(N_SK));
  try {
    return deriveKeyPair(ikm);
  } finally {
    wipe(ikm);
  }
}

function extractAndExpand(dhValue: Uint8Array, kemContext: Uint8Array): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, "eae_prk", dhValue);
  const shared = labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, N_SECRET);
  wipe(eaePrk);
  return shared;
}

function encap(pkR: KeyObject, ikmE: Uint8Array | undefined, random: (n: number) => Uint8Array): { shared: Buffer; enc: Buffer } {
  const eph = ikmE ? deriveKeyPair(ikmE) : generateKeyPair(random);
  const z = dh(x25519PrivateKey(eph.sk), pkR);
  wipe(eph.sk);
  const enc = eph.pk;
  const shared = extractAndExpand(z, concat(enc, x25519PublicBytes(pkR)));
  wipe(z);
  return { shared, enc };
}

function decap(enc: Uint8Array, skR: KeyObject): Buffer {
  if (enc.length !== N_ENC) throw new HpkeError("hpke_bad_length");
  const z = dh(skR, x25519PublicKey(enc));
  const shared = extractAndExpand(z, concat(enc, x25519PublicBytes(skR)));
  wipe(z);
  return shared;
}

// ---------------------------------------------------------------- key schedule and context

type Role = "sender" | "recipient";

/** HPKE encryption context: Seal only for the sender, Open only for the recipient, Export for both. */
export class HpkeContext {
  #key: Buffer;
  #baseNonce: Buffer;
  #exporterSecret: Buffer;
  #seq = 0n;
  /** After destroy() the keys are zeros: Seal, Open and Export must refuse, not run on a zero key. */
  #destroyed = false;
  readonly #cipher: "aes-128-gcm" | "aes-256-gcm";
  readonly #suite: Buffer;
  readonly role: Role;

  constructor(role: Role, aead: AeadId, shared: Buffer, info: Uint8Array) {
    const { cipher, nk } = aeadParams(aead);
    this.role = role;
    this.#cipher = cipher;
    this.#suite = hpkeSuiteId(aead);
    const pskIdHash = labeledExtract(this.#suite, EMPTY, "psk_id_hash", EMPTY);
    const infoHash = labeledExtract(this.#suite, EMPTY, "info_hash", info);
    const ctx = concat(Buffer.of(MODE_BASE), pskIdHash, infoHash);
    const secret = labeledExtract(this.#suite, shared, "secret", EMPTY);
    this.#key = labeledExpand(this.#suite, secret, "key", ctx, nk);
    this.#baseNonce = labeledExpand(this.#suite, secret, "base_nonce", ctx, N_N);
    this.#exporterSecret = labeledExpand(this.#suite, secret, "exp", ctx, N_H);
    wipe(secret);
  }

  #alive(): void {
    if (this.#destroyed) throw new HpkeError("hpke_destroyed");
  }

  #nonce(): Buffer {
    if (this.#seq >= SEQ_MAX) throw new HpkeError("hpke_seq_overflow");
    const seq = i2osp(this.#seq, N_N);
    for (let i = 0; i < N_N; i++) seq[i]! ^= this.#baseNonce[i]!;
    return seq;
  }

  #increment(): void {
    this.#seq += 1n;
  }

  /** Seal(aad, pt) → ct ‖ tag (16 bytes). */
  seal(aad: Uint8Array, pt: Uint8Array): Buffer {
    this.#alive();
    if (this.role !== "sender") throw new HpkeError("hpke_wrong_role");
    const c = createCipheriv(this.#cipher, this.#key, this.#nonce(), { authTagLength: N_T });
    c.setAAD(aad);
    const ct = concat(c.update(pt), c.final(), c.getAuthTag());
    this.#increment();
    return ct;
  }

  /** Open(aad, ct ‖ tag) → pt; any error is hpke_open_failed, the counter does not move. */
  open(aad: Uint8Array, ct: Uint8Array): Buffer {
    this.#alive();
    if (this.role !== "recipient") throw new HpkeError("hpke_wrong_role");
    if (ct.length < N_T) throw new HpkeError("hpke_open_failed");
    const d = createDecipheriv(this.#cipher, this.#key, this.#nonce(), { authTagLength: N_T });
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - N_T));
    let pt: Buffer;
    try {
      pt = concat(d.update(ct.subarray(0, ct.length - N_T)), d.final());
    } catch {
      throw new HpkeError("hpke_open_failed");
    }
    this.#increment();
    return pt;
  }

  /** Export(exporter_context, L). */
  export(exporterContext: Uint8Array, length: number): Buffer {
    this.#alive();
    return labeledExpand(this.#suite, this.#exporterSecret, "sec", exporterContext, length);
  }

  /** Wipes the context keys; after that Seal, Open and Export refuse with hpke_destroyed. */
  destroy(): void {
    this.#destroyed = true;
    wipe(this.#key);
    wipe(this.#baseNonce);
    wipe(this.#exporterSecret);
    this.#seq = SEQ_MAX;
  }
}

export interface SetupOptions {
  /** AEAD of the suite; AES-256-GCM by default */
  aead?: AeadId;
  /** For vectors only: ikm of the sender's one-time key (DeriveKeyPair). Never set in production. */
  ikmE?: Uint8Array;
  /** Randomness source for the one-time key; crypto.randomBytes by default */
  random?: (n: number) => Uint8Array;
}

/** SetupBaseS: enc and the sender context. */
export function setupBaseS(pkR: KeyObject | Uint8Array, info: Uint8Array, o: SetupOptions = {}): { enc: Buffer; ctx: HpkeContext } {
  const { shared, enc } = encap(asPublic(pkR), o.ikmE, o.random ?? randomBytes);
  const ctx = new HpkeContext("sender", o.aead ?? AEAD_AES_256_GCM, shared, info);
  wipe(shared);
  return { enc, ctx };
}

/** SetupBaseR: the recipient context from enc and its own private key. */
export function setupBaseR(enc: Uint8Array, skR: KeyObject | Uint8Array, info: Uint8Array, o: Pick<SetupOptions, "aead"> = {}): HpkeContext {
  const shared = decap(enc, asPrivate(skR));
  const ctx = new HpkeContext("recipient", o.aead ?? AEAD_AES_256_GCM, shared, info);
  wipe(shared);
  return ctx;
}
