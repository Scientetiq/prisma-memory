// SSHSIG signatures (OpenSSH PROTOCOL.sshsig), ed25519 only, verified on node:crypto.
// A person signs offline: ssh-keygen -Y sign -f <key> -n <namespace> <file> → <file>.sig.
// Checks: wrapper format, version 1, the namespace matches exactly, hash algorithm sha256/sha512, the signing key comes
// from the trusted list (public key bytes compared), an ed25519 signature over «SSHSIG ‖ namespace ‖ reserved ‖ hash ‖ H(message)».
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { concat, equalBytes, utf8 } from "./bytes.ts";

const MAGIC = utf8("SSHSIG");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const KEY_TYPE = "ssh-ed25519";
const HASHES = new Set(["sha256", "sha512"]);
/** A signature of anchors or a skill is a few kilobytes; a larger one is not ours. */
const MAX_ARMORED = 8192;

export class SshSigError extends Error {
  constructor(readonly code: "sshsig_armor" | "sshsig_format" | "sshsig_key_type" | "sshsig_namespace" | "sshsig_hash" | "sshsig_untrusted" | "sshsig_bad_signature" | "sshsig_bad_public_key") {
    super(code);
    this.name = "SshSigError";
  }
}

/** An ed25519 public key in SSH form: blob «string ssh-ed25519 ‖ string pk», fingerprint SHA256:… as ssh-keygen -l. */
export interface SshEd25519Key {
  blob: Buffer;
  /** 32 raw bytes */
  raw: Buffer;
  /** «SHA256:» + base64 without «=» of sha256(blob) */
  fingerprint: string;
  comment: string;
}

// ---------------------------------------------------------------- parsing SSH strings (RFC 4251 §5)

class Reader {
  #off = 0;
  constructor(private readonly buf: Buffer) {}
  u32(): number {
    if (this.#off + 4 > this.buf.length) throw new SshSigError("sshsig_format");
    const v = this.buf.readUInt32BE(this.#off);
    this.#off += 4;
    return v;
  }
  bytes(n: number): Buffer {
    if (n > this.buf.length - this.#off) throw new SshSigError("sshsig_format");
    const b = this.buf.subarray(this.#off, this.#off + n);
    this.#off += n;
    return b;
  }
  string(): Buffer {
    return this.bytes(this.u32());
  }
  done(): boolean {
    return this.#off === this.buf.length;
  }
}

const sshString = (b: Uint8Array): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return concat(len, b);
};

/** An ed25519 public key blob → the key; otherwise an error. */
export function parseEd25519Blob(blob: Buffer, comment = ""): SshEd25519Key {
  const r = new Reader(blob);
  const type = r.string().toString("latin1");
  if (type !== KEY_TYPE) throw new SshSigError("sshsig_key_type");
  const raw = r.string();
  if (raw.length !== 32 || !r.done()) throw new SshSigError("sshsig_bad_public_key");
  return { blob: Buffer.from(blob), raw: Buffer.from(raw), fingerprint: fingerprintOf(blob), comment };
}

/** Fingerprint as ssh-keygen -l -E sha256: «SHA256:» + base64(sha256(blob)) without «=». */
export function fingerprintOf(blob: Uint8Array): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/** A line in authorized_keys / *.pub format: «ssh-ed25519 AAAA… [comment]». */
export function parsePublicKeyLine(line: string): SshEd25519Key {
  const m = /^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(line.trim());
  if (!m) throw new SshSigError("sshsig_bad_public_key");
  if (m[1] !== KEY_TYPE) throw new SshSigError("sshsig_key_type");
  const blob = Buffer.from(m[2]!, "base64");
  if (blob.toString("base64") !== m[2]) throw new SshSigError("sshsig_bad_public_key");
  const key = parseEd25519Blob(blob, (m[3] ?? "").trim());
  return key;
}

/**
 * A trusted keys file (anchor-signers.pub and the like): one ssh-ed25519 line per key; empty lines and «#» are skipped.
 * Any other key type, a repeated key or garbage is an error: the root of trust is never read "as far as possible".
 */
export function parseTrustedKeys(text: string): SshEd25519Key[] {
  const out: SshEd25519Key[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const k = parsePublicKeyLine(line);
    if (out.some((o) => equalBytes(o.blob, k.blob))) throw new SshSigError("sshsig_bad_public_key");
    out.push(k);
  }
  return out;
}

export function ed25519KeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

// ---------------------------------------------------------------- signature

export interface ParsedSshSig {
  publicKey: SshEd25519Key;
  namespace: string;
  reserved: Buffer;
  hashAlgorithm: string;
  signature: Buffer;
}

/** Removes the «-----BEGIN SSH SIGNATURE-----» wrapper: base64 lines between begin and end, nothing else around. */
export function dearmor(text: string): Buffer {
  if (typeof text !== "string" || text.length > MAX_ARMORED) throw new SshSigError("sshsig_armor");
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END || lines.length < 3) throw new SshSigError("sshsig_armor");
  const body = lines.slice(1, -1).join("");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new SshSigError("sshsig_armor");
  const blob = Buffer.from(body, "base64");
  if (blob.toString("base64") !== body) throw new SshSigError("sshsig_armor");
  return blob;
}

/** Parses an SSHSIG signature (wrapped or a bare blob). */
export function parseSshSig(sig: string | Buffer): ParsedSshSig {
  const blob = typeof sig === "string" ? dearmor(sig) : sig;
  const r = new Reader(blob);
  if (!equalBytes(r.bytes(6), MAGIC)) throw new SshSigError("sshsig_format");
  if (r.u32() !== 1) throw new SshSigError("sshsig_format");
  const publicKey = parseEd25519Blob(r.string());
  const namespace = r.string().toString("utf8");
  const reserved = r.string();
  const hashAlgorithm = r.string().toString("latin1");
  const sigBlob = r.string();
  if (!r.done()) throw new SshSigError("sshsig_format");
  const sr = new Reader(sigBlob);
  if (sr.string().toString("latin1") !== KEY_TYPE) throw new SshSigError("sshsig_key_type");
  const signature = sr.string();
  if (signature.length !== 64 || !sr.done()) throw new SshSigError("sshsig_format");
  return { publicKey, namespace, reserved: Buffer.from(reserved), hashAlgorithm, signature: Buffer.from(signature) };
}

/** The data an SSHSIG signature is made over (PROTOCOL.sshsig, «Signed Data»). */
export function sshSigSignedData(namespace: string, reserved: Uint8Array, hashAlgorithm: string, message: Uint8Array): Buffer {
  const h = createHash(hashAlgorithm).update(message).digest();
  return concat(MAGIC, sshString(utf8(namespace)), sshString(reserved), sshString(utf8(hashAlgorithm)), sshString(h));
}

/**
 * Verifies one SSHSIG signature: the namespace is exactly namespace, the key is in trusted, the signature is valid.
 * Returns the signer's key; any failure is an SshSigError with a code (the code may be logged, the signature may not).
 */
export function verifySshSig(message: Uint8Array, signature: string | Buffer, namespace: string, trusted: readonly SshEd25519Key[]): SshEd25519Key {
  if (!namespace) throw new SshSigError("sshsig_namespace");
  const p = parseSshSig(signature);
  if (p.namespace !== namespace) throw new SshSigError("sshsig_namespace");
  if (!HASHES.has(p.hashAlgorithm)) throw new SshSigError("sshsig_hash");
  const signer = trusted.find((t) => equalBytes(t.blob, p.publicKey.blob));
  if (!signer) throw new SshSigError("sshsig_untrusted");
  // PROTOCOL.sshsig: the envelope's reserved string is read and ignored.
  // Signed Data currently has an empty reserved string, regardless of that field.
  const data = sshSigSignedData(p.namespace, Buffer.alloc(0), p.hashAlgorithm, message);
  let ok = false;
  try {
    ok = verify(null, data, ed25519KeyObject(signer.raw), p.signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new SshSigError("sshsig_bad_signature");
  return signer;
}
