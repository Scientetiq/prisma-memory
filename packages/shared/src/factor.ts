import type { MfaLevel } from "./enums.gen.ts";

export type { MfaLevel } from "./enums.gen.ts";
export * from "./base32.ts";
export * from "./totp.ts";
export * from "./otpauth.ts";
export * from "./qr-encode.ts";
export * from "./qr-svg.ts";
export * from "./security-mails.ts";

export type MfaMode = "off" | "optional" | "required";
export type FactorStyle = "code" | "push";

export interface CheckContext {
  txId: string;
  nowMs: number;
  ipPrefix?: string;
  accountGuid?: string;
  scope?: "edge" | "inside";
  lockWaitMs?: number;
}

export interface FactorProvider {
  readonly kind: "totp" | "radius_otp" | string;
  readonly style: FactorStyle;
  enrolled(personId: string): Promise<boolean>;
  verify(personId: string, input: { code: string }, ctx: CheckContext): Promise<"ok" | "bad" | "unavailable">;
  start?(personId: string, ctx: CheckContext): Promise<{ challengeId: string; numberToMatch?: string }>;
  poll?(challengeId: string): Promise<"pending" | "ok" | "denied" | "expired">;
}

export interface EnrollStart { pendingId: string; otpauthUri: string; secretText: string; expiresAt: string }

export type EnrollConfirmResult =
  | { ok: true; recoveryCodes: string[]; replaced: boolean }
  | { ok: false; reason: "bad_code" | "expired" | "locked" | "unavailable" };

export interface EnrollableProvider extends FactorProvider {
  enrollStart(personId: string, label: string | null, nowMs: number): Promise<EnrollStart>;
  enrollConfirm(personId: string, pendingId: string, code: string, nowMs: number): Promise<EnrollConfirmResult>;
}

export const MFA_LEVEL_RANK: Readonly<Record<MfaLevel, number>> = Object.freeze({
  none: 0, totp: 1, recovery: 1, radius_otp: 1, push: 1, passkey: 1,
});

const MODE_ORDER: readonly MfaMode[] = ["off", "optional", "required"];

export function asMfaMode(v: unknown): MfaMode {
  return typeof v === "string" && (MODE_ORDER as readonly string[]).includes(v) ? (v as MfaMode) : "required";
}

export function strongerMode(a: MfaMode, b: MfaMode): MfaMode {
  return MODE_ORDER.indexOf(asMfaMode(a)) >= MODE_ORDER.indexOf(asMfaMode(b)) ? asMfaMode(a) : asMfaMode(b);
}
