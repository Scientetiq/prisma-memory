// OAuth authorization-server module of the gateway: codes and tokens. Differs from the edge's module: own prefixes
// mem_oac_/mem_oat_/mem_ort_; the prefix is a parameter of newToken, isToken and successor (the edge's successor() is
// fixed to edge_rt_); a parity test pins the rest
//
// Codes and tokens of the built-in authorization server: opaque strings, a prefix and 43 base64url characters (32 random
// bytes). The database keeps only the SHA-256 of the text. The next refresh token is not stored but derived from the
// previous one: rt[n+1] = prefix + base64url(HMAC-SHA256(k_rt, rt[n])), so a replay inside the window gets the same successor.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const CODE_PREFIX = "mem_oac_";
export const ACCESS_PREFIX = "mem_oat_";
export const REFRESH_PREFIX = "mem_ort_";
export type TokenPrefix = typeof CODE_PREFIX | typeof ACCESS_PREFIX | typeof REFRESH_PREFIX;

const BODY = /^[A-Za-z0-9_-]{43}$/;

/** New code or token: prefix and 32 random bytes in base64url. */
export function newToken(prefix: TokenPrefix, random: (n: number) => Uint8Array = randomBytes): string {
  return prefix + Buffer.from(random(32)).toString("base64url");
}

/** The string is a code or token of this kind (prefix and exactly 43 base64url characters). */
export function isToken(prefix: TokenPrefix, s: unknown): s is string {
  return typeof s === "string" && s.length === prefix.length + 43 && s.startsWith(prefix) && BODY.test(s.slice(prefix.length));
}

/** SHA-256 of the text: how codes and tokens are stored. */
export function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** Successor of a refresh token: HMAC-SHA256 with key k_rt over the text of the current token. */
export function successor(rt: string, key: Uint8Array, prefix: TokenPrefix): string {
  return prefix + createHmac("sha256", key).update(rt, "utf8").digest("base64url");
}

/** 32 random bytes in base64url without a prefix: transaction cookie secret, CSRF, transaction id, continuation key. */
export function randomSecret(random: (n: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString("base64url");
}
