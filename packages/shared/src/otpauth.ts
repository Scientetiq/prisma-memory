import { base32Encode } from "./base32.ts";
import { TOTP_DIGITS, TOTP_MIN_SECRET_BYTES, TOTP_PERIOD } from "./totp.ts";

export interface OtpauthInput {
  issuer: string;
  account: string;
  secret: Uint8Array;
}

export function otpauthUri({ issuer, account, secret }: OtpauthInput): string {
  const { iss, acc } = checked({ issuer, account, secret });
  return build(iss, acc, secret, true);
}

function checked({ issuer, account, secret }: OtpauthInput): { iss: string; acc: string } {
  const iss = issuer.trim(), acc = account.trim();
  if (!iss || iss.includes(":")) throw new TypeError("otpauth: the name must be nonempty and contain no colon");
  if (!acc || acc.includes(":")) throw new TypeError("otpauth: the account must be nonempty and contain no colon");
  if (secret.length < TOTP_MIN_SECRET_BYTES) throw new TypeError("otpauth: secret shorter than 128 bits");
  return { iss, acc };
}

function build(iss: string, acc: string, secret: Uint8Array, issuerInLabel: boolean): string {
  const label = issuerInLabel ? `${encodeURIComponent(iss)}:${encodeURIComponent(acc)}` : encodeURIComponent(acc);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(iss)}`
    + `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

export const OTPAUTH_URI_MAX = 512;

export function otpauthUriWithin(input: OtpauthInput, max: number = OTPAUTH_URI_MAX): { uri: string; shortened: boolean; issuerChars: number } {
  const { iss, acc } = checked(input);
  const full = build(iss, acc, input.secret, true);
  const chars = Array.from(iss);
  if (full.length <= max) return { uri: full, shortened: false, issuerChars: chars.length };
  for (let n = chars.length; n >= 1; n--) {
    const cut = chars.slice(0, n).join("").trim();
    if (!cut) continue;
    const uri = build(cut, acc, input.secret, false);
    if (uri.length <= max) return { uri, shortened: true, issuerChars: Array.from(cut).length };
  }
  throw new RangeError(`otpauth: the URI exceeds ${max} characters even with a short name (the account is long)`);
}

export function secretText(secret: Uint8Array): string {
  return base32Encode(secret).replace(/(.{4})(?=.)/g, "$1 ");
}
