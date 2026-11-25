// "Two-step sign-in" of the local administrator (the panel's half): who may open the page, what the
// gateway's state means, how its refusals read, and the small helpers of the set-up flow. Everything is decided by the
// gateway (routes /api/v1/admin/local-totp*: own session of admin@local only, `Cache-Control: no-store`); this
// module only says it in words. A plain module — the page, the actions and the client form all read it. New texts are
// English and marked for the catalog.
import type { Session } from "@/lib/session";

export const STATUS_PATH = "/api/v1/admin/local-totp";

/** State of the factor (GET /api/v1/admin/local-totp). */
export interface LocalTotpStatus {
  enrolled: boolean;
  pending: boolean;
  required: boolean;
  recovery_left: number;
  activated_at: string | null;
}

/** The answer is that state; anything else is not trusted (a gateway of another version, a proxy page). */
export function parseStatus(d: unknown): LocalTotpStatus | null {
  const o = (d ?? null) as Partial<Record<keyof LocalTotpStatus, unknown>> | null;
  if (!o || typeof o.enrolled !== "boolean" || typeof o.required !== "boolean") return null;
  const left = typeof o.recovery_left === "number" && Number.isInteger(o.recovery_left) ? Math.min(10, Math.max(0, o.recovery_left)) : 0;
  return { enrolled: o.enrolled, pending: o.pending === true, required: o.required, recovery_left: left,
           activated_at: typeof o.activated_at === "string" && o.activated_at ? o.activated_at : null };
}

/** Ways a `mem_as_` session can be signed in by (`auth_method`) that belong to the local administrator. */
const LOCAL_METHODS = new Set(["local", "local_breakglass"]);

/**
 * The session is the local administrator's own: the legacy panel token `mem_adm_` (issued only by the admin@local sign-in)
 * or a `mem_as_` session signed in by login and password. A single sign-on administrator, a tool session and a session the
 * gateway did not describe are not — the page shows them a note and calls nothing.
 */
export function isLocalSession(s: Pick<Session, "token" | "authMethod"> | null): boolean {
  if (!s) return false;
  if (s.token.startsWith("mem_adm_")) return true;
  return s.token.startsWith("mem_as_") && LOCAL_METHODS.has(s.authMethod ?? "");
}

/** The browser opened the page over plain HTTP from another machine: the secret would cross the network unencrypted. */
export function plainHttpExposed(protocol: string, hostname: string): boolean {
  const h = hostname.toLowerCase();
  const loopback = h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  return protocol === "http:" && !loopback;
}

/** QR from the gateway as a picture: the SVG goes into a data address of an <img>, never into the page markup. */
export const qrImageSrc = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The secret as text in groups of four — easier to type into the app. */
export const groupedSecret = (s: string): string => s.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");

/** Text of the file with the recovery codes (made in the browser). */
export function codesFileText(login: string, codes: readonly string[], when: Date = new Date()): string {
  return [`Recovery codes of the second factor for ${login}`, `Issued: ${when.toISOString().slice(0, 10)}`,
    "Each code works once, in place of the code from the authenticator app.", "", ...codes, ""].join("\n");
}

export const TEXT = {
  title: /* i18n */ "Two-step sign-in",
  sectionState: /* i18n */ "State",
  sectionSetup: /* i18n */ "Set up",
  sectionOff: /* i18n */ "Turn off",
  sectionLost: /* i18n */ "If the phone is lost",
  loadWhat: /* i18n */ "the state of the second factor",
  turnedOn: /* i18n */ "Turned on",
  lead: /* i18n */ "A code from an authenticator app on your phone, asked at every sign-in of this account after the password. A leaked password alone then does not open the panel.",
  apps: /* i18n */ "Any authenticator app works: Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis, 1Password and others.",
  notLocal: /* i18n */ "This page is for the local administrator account (login and password). You signed in with single sign-on: protect that sign-in with security keys on the WebAuthn page.",
  unavailable: /* i18n */ "Setting up a second factor is not available on this server yet: the memory service does not offer it in this version.",
  stateOn: /* i18n */ "On",
  stateOff: /* i18n */ "Off",
  onText: /* i18n */ "Every sign-in of this account asks for the code from the app after the password.",
  offText: /* i18n */ "Signing in takes only the password now. Set up the second factor below.",
  pendingText: /* i18n */ "A set-up was started and not finished. Start again to get a new QR code: the previous one no longer works.",
  recoveryLeft: /* i18n */ (n: number) => `Recovery codes left: ${n} of 10.`,
  recoveryLow: /* i18n */ "Few recovery codes are left. To get a new set, turn the second factor off and set it up again.",
  requiredSetup: /* i18n */ "A second factor is required for local administrators on this server: set it up below, or the next sign-in of this account is refused.",
  requiredText: /* i18n */ "A second factor is required for local administrators on this server (setting admin.local_totp_required), so it cannot be turned off here.",
  setupHint: /* i18n */ "Enter your password again to start. The QR code and the key are shown once, on this page only.",
  passwordLabel: /* i18n */ "Your password",
  start: /* i18n */ "Set up the second factor",
  starting: /* i18n */ "Preparing…",
  scan: /* i18n */ "Scan the QR code with the authenticator app, then enter the six-digit code it shows.",
  qrAlt: /* i18n */ "QR code for the authenticator app",
  secretHint: /* i18n */ "Cannot scan? Type this key into the app instead:",
  expires: /* i18n */ "The set-up must be confirmed within 10 minutes.",
  codeLabel: /* i18n */ "Code from the app",
  confirm: /* i18n */ "Confirm",
  confirming: /* i18n */ "Checking…",
  restart: /* i18n */ "Start again",
  done: /* i18n */ "The second factor is on",
  codesWarning: /* i18n */ "These are your recovery codes: each one signs you in once if the phone is not at hand. They are not shown again — save them now in a safe place, not in mail.",
  codesSaved: /* i18n */ "I have saved the codes",
  copy: /* i18n */ "Copy",
  copied: /* i18n */ "Copied",
  copyFailed: /* i18n */ "Could not copy — select the codes and copy them by hand",
  download: /* i18n */ "Download .txt",
  finish: /* i18n */ "Done",
  signedOut: /* i18n */ "Your other sessions were signed out. Sign in again with the code from the app.",
  signInAgain: /* i18n */ "Sign in again",
  otherSignedOut: /* i18n */ "Other sessions of this account were signed out.",
  disableHint: /* i18n */ "To turn the second factor off, enter a code from the app or one of the recovery codes.",
  disableLabel: /* i18n */ "Code from the app or a recovery code",
  disable: /* i18n */ "Turn off",
  disabling: /* i18n */ "Turning off…",
  disabled: /* i18n */ "The second factor is off: signing in takes only the password again",
  plainHttp: /* i18n */ "This page is open over plain HTTP: the key of the authenticator app would cross the network unencrypted. Set the second factor up over HTTPS or on the server itself (localhost).",
  lostPhone: /* i18n */ "Lost the phone? Sign in with one of the recovery codes and set the second factor up again. Without the codes, the factor is reset by a command on the server itself.",
  noPassword: /* i18n */ "Enter your password",
  noCode: /* i18n */ "Enter the code",
  failed: /* i18n */ (status: number) => `Not done: the memory service answered ${status}`,
} as const;

/** A refusal of the gateway in words. `reason` first (answers keep the top-level codes and add a `reason`). */
export function refusalText(status: number, d: { code?: unknown; reason?: unknown; message?: unknown; retry_after?: unknown } | null): string {
  const reason = typeof d?.reason === "string" ? d.reason : "";
  switch (reason) {
    case "bad_password": return /* i18n */ "The password is wrong";
    case "bad_code": return /* i18n */ "The code did not work. Check that the time on your phone is right and enter the new code.";
    case "code_expired": return /* i18n */ "The time for the set-up ran out. Start again.";
    case "already_enrolled": return /* i18n */ "The second factor is already on.";
    case "required": return TEXT.requiredText;
    case "factor_locked": return /* i18n */ "Too many wrong codes: the second factor is locked for a while. Try again later.";
    case "factor_unavailable": return /* i18n */ "The second factor cannot be checked right now. Try again later.";
  }
  if (status === 404) return TEXT.unavailable;
  if (status === 429) return /* i18n */ "Too many attempts. Wait a minute and try again.";
  return typeof d?.message === "string" && d.message ? d.message : TEXT.failed(status);
}

/** A 401 that is about what was typed (password or code), not about the session: the session stays, the form says why. */
export const typedRefusal = (status: number, d: { reason?: unknown } | null): boolean =>
  status === 401 && (d?.reason === "bad_password" || d?.reason === "bad_code");
