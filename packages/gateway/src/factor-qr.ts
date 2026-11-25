// QR for the code app: an otpauth:// address from the answer of the sign-in check service → an inline SVG
// (@memory/shared/factor, one path, no scripts, links or styles). The address carries a secret, so the person gets it only
// as an image in the setup answer (Cache-Control: no-store) and never enters the log or a cache.
import { OTPAUTH_URI_MAX, qrSvg } from "@memory/shared/factor";

/** An address outside the contract (not otpauth://totp/ or over the limit) — null: the gateway does not show such an answer. */
export function factorQrSvg(otpauthUri: unknown): string | null {
  if (typeof otpauthUri !== "string" || otpauthUri.length > OTPAUTH_URI_MAX || !otpauthUri.startsWith("otpauth://totp/")) return null;
  return qrSvg(otpauthUri);
}
