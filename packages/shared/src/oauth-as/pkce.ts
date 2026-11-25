// OAuth authorization-server module of the gateway: PKCE. Same behaviour as the edge's module; a parity test pins it
//
// PKCE (RFC 7636): S256 only. The plain method and a request without code_challenge are refused already at
// /oauth/authorize; code_verifier is 43–128 characters of [A-Za-z0-9-._~]; it is compared with code_challenge in constant time.
import { createHash, timingSafeEqual } from "node:crypto";

export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** code_challenge of method S256: base64url SHA-256, exactly 43 characters. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** BASE64URL(SHA256(ASCII(code_verifier))). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Method and challenge of an authorization request are acceptable: method exactly S256 (no method means plain, RFC 7636 §4.3). */
export function challengeOk(challenge: string | undefined, method: string | undefined): challenge is string {
  return method === "S256" && typeof challenge === "string" && CHALLENGE_RE.test(challenge);
}

/** The verifier has a valid shape (checked before the code is spent). */
export function verifierOk(verifier: string | undefined): verifier is string {
  return typeof verifier === "string" && VERIFIER_RE.test(verifier);
}

/** The verifier matches the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!verifierOk(verifier) || !CHALLENGE_RE.test(challenge)) return false;
  const a = Buffer.from(s256(verifier), "ascii");
  const b = Buffer.from(challenge, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hash of a challenge (base64url SHA-256 of the code_challenge text), as the edge stores it. */
export function challengeHash(challenge: string): string {
  return createHash("sha256").update(challenge, "ascii").digest("base64url");
}
