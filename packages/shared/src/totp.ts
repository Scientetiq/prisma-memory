import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
/** Shortest secret totpVerify computes with: 128 bits, the floor of RFC 4226 §4. Shorter keys are refused. */
export const TOTP_MIN_SECRET_BYTES = 16;
/** Longest raw code input looked at, in UTF-16 units; longer input is refused before any work (bounds the whitespace scan). */
export const TOTP_CODE_INPUT_MAX = 64;

/**
 * The six digits of a code typed from an authenticator app, or null. Every whitespace is removed (apps show "123 456");
 * the result must be exactly six ASCII digits, and the raw input at most TOTP_CODE_INPUT_MAX characters. Never throws.
 * The one code form for every caller: totpVerify, the confirmation route of the gateway, the administrator's sign-in.
 */
export function totpCodeDigits(input: unknown): string | null {
  if (typeof input !== "string" || input.length > TOTP_CODE_INPUT_MAX) return null;
  const c = input.replace(/\s+/g, "");
  return /^[0-9]{6}$/.test(c) ? c : null;
}

export function totpStep(nowMs: number, period: number = TOTP_PERIOD): number {
  return Math.floor(nowMs / 1000 / period);
}

export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("hotp: counter must be an integer ≥ 0");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new RangeError("hotp: number of digits must be 6–8");
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export type TotpResult = { ok: true; step: number } | { ok: false };

export function totpVerify(secret: Uint8Array, code: string, nowMs: number, lastStep: number | null): TotpResult {
  const c = totpCodeDigits(code);
  if (c === null) return { ok: false };
  if (!(secret instanceof Uint8Array) || secret.length < TOTP_MIN_SECRET_BYTES) return { ok: false };
  const given = Buffer.from(c, "ascii");
  const step = totpStep(nowMs);
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(step + 1)) return { ok: false };
  let found = -1;
  for (const s of [step - 1, step, step + 1]) {
    if (s < 0) continue;
    const same = timingSafeEqual(Buffer.from(hotp(secret, s), "ascii"), given);
    const fresh = lastStep === null || s > lastStep;
    if (same && fresh && found < 0) found = s;
  }
  return found >= 0 ? { ok: true, step: found } : { ok: false };
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}
