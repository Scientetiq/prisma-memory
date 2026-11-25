// Signed link: base64url(JSON of the payload) + "." + HMAC-SHA256 base64url. The same format as
// the internal link to an original (packages/shared/src/crypto.ts signLink/verifyLink): edge and gateway read the
// same links; a parity test keeps them equal. Expiry exp (Unix seconds) is required:
// a link without it would never expire. Leaf: only node:crypto.
import { createHmac, timingSafeEqual } from "node:crypto";

/** The signing key is a string (as inside, from settings) or bytes (the edge's k_link from anchors). */
export type LinkKey = string | Uint8Array;

/**
 * Smallest key length in bytes (a string counts in UTF-8). An empty or short key (k_link file not read, an empty
 * setting) would give a signature anyone can forge: signing with it throws, verifying always gives null.
 */
export const LINK_KEY_MIN_BYTES = 32;

const keyBytes = (k: LinkKey): number => (typeof k === "string" ? Buffer.byteLength(k, "utf8") : k instanceof Uint8Array ? k.byteLength : 0);
/** The key fits for signing links: a string or bytes of at least LINK_KEY_MIN_BYTES. */
export const linkKeyOk = (k: unknown): k is LinkKey =>
  (typeof k === "string" || k instanceof Uint8Array) && keyBytes(k as LinkKey) >= LINK_KEY_MIN_BYTES;

/** Signs the payload; field order is kept (JSON.stringify). A short key throws. */
export function signLink(signingKey: LinkKey, payload: Record<string, unknown>): string {
  if (!linkKeyOk(signingKey)) throw new Error(`signLink: the signing key is shorter than ${LINK_KEY_MIN_BYTES} bytes`);
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", signingKey).update(body).digest("base64url")}`;
}

/**
 * Checks signature and expiry: valid signature and exp not in the past give the payload, else null. Checked before
 * JSON parsing and in constant time; a broken body with a valid signature (foreign format) is null too, no throw.
 * A key shorter than LINK_KEY_MIN_BYTES always gives null (anyone could forge a link under an empty key).
 */
export function verifyLink<T = Record<string, unknown>>(signingKey: LinkKey, signed: string, nowMs: number = Date.now()): T | null {
  if (!linkKeyOk(signingKey)) return null;
  if (typeof signed !== "string") return null;
  const [body, mac, extra] = signed.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac("sha256", signingKey).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp < nowMs / 1000) return null;
  return payload as T;
}
