// Byte helpers of @memory/wire: concat, integers as bytes (I2OSP), base64url, uuid ↔ 16 bytes.
// The package is a leaf: only node:crypto and Buffer, no input or output.
import { timingSafeEqual } from "node:crypto";

/** Concatenates byte arrays. */
export function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
}

/** I2OSP (RFC 8017): non-negative integer → n bytes, big-endian. */
export function i2osp(value: number | bigint, n: number): Buffer {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError("i2osp: negative number");
  const out = Buffer.alloc(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`i2osp: the number does not fit in ${n} bytes`);
  return out;
}

/** UTF-8 of a string. */
export const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

/** base64url without «=» (RFC 4648 §5). */
export const b64u = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64url");

const B64U = /^[A-Za-z0-9_-]*$/;
/** Strict base64url parse: base64url alphabet only, no «=», exact length in bytes (if given). */
export function fromB64u(s: string, bytes?: number): Buffer | null {
  if (typeof s !== "string" || !B64U.test(s) || s.length % 4 === 1) return null;
  const b = Buffer.from(s, "base64url");
  if (b.toString("base64url") !== s) return null; // non-canonical trailing bits
  if (bytes !== undefined && b.length !== bytes) return null;
  return b;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** uuid in canonical form (lower-case hex) → 16 bytes; otherwise null. */
export function uuidBytes(id: string): Buffer | null {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

/** Constant-time comparison; a different length means "not equal". */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Wipes a key in memory (the best one can do in JS). */
export function wipe(b: Uint8Array | null | undefined): void {
  if (b) b.fill(0);
}
