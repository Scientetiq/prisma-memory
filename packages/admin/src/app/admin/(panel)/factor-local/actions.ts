"use server";
// "Two-step sign-in" of the local administrator: start the set-up (password again), confirm it with the first
// code (recovery codes come back once), turn the factor off (a code or a recovery code). Only the local administrator's
// own session: any other session gets a refusal here and the gateway is not called; the gateway checks it again and
// decides everything else (fresh password, codes, "required", locks). The secret (QR and key as text) and the recovery
// codes are returned to the form once and are kept nowhere — not in a cookie, not in the page.
// A 401 about the typed password or code (`reason`) keeps the session; any other 401 means the session is over — to the
// sign-in page, as every panel call does.
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { failState, okState, type ActionResult } from "@/lib/action-state";
import { call, GatewayError } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { clientHeaders } from "@/lib/workplace-login";
import { isLocalSession, qrImageSrc, refusalText, STATUS_PATH, TEXT, typedRefusal } from "./view";

/** Result of a step of the set-up: the pending factor (QR and key) or the recovery codes — once. */
export interface LocalFactorState extends ActionResult {
  pending?: { qrSrc: string; secretText: string; expiresAt: string };
  codes?: string[];
  /** The gateway signed this session out together with the others (the legacy panel token): the next step is sign-in. */
  signedOut?: boolean;
  /** Login of the account the codes belong to — the file name and its first line. */
  login?: string;
}
export type LocalFactorFlow = LocalFactorState | null;

type Extra = Partial<Omit<LocalFactorState, "ok" | "message" | "at">>;
const fail = (message: string, extra: Extra = {}): LocalFactorState => failState(message, extra);
const ok = (message: string, extra: Extra = {}): LocalFactorState => okState(message, extra);

/** Code as the app shows it ("123 456") or a recovery code with dashes — whitespace is the gateway's to drop too. */
const codeField = (fd: FormData): string => String(fd.get("code") ?? "").trim();
const CODE_MAX = 64;
const PASSWORD_MAX = 1024;

type Sent = { status: number; data: Record<string, unknown>; login: string };

/** A call of the own-session routes; not the local administrator — a refusal without a call; session over — to sign-in. */
async function send(path: string, body: Record<string, unknown>, withClient = false): Promise<Sent | LocalFactorState> {
  const s = await requireSession();
  if (!isLocalSession(s)) return fail(TEXT.notLocal);
  let r;
  try {
    r = await call(`${STATUS_PATH}${path}`, { method: "POST", body, token: s.token, timeoutMs: 30_000, ...(withClient ? { headers: clientHeaders(await headers()) } : {}) });
  } catch (e) {
    if (e instanceof GatewayError) return fail(e.message);
    throw e;
  }
  const data = (r.data ?? {}) as Record<string, unknown>;
  if (r.status === 401 && !typedRefusal(r.status, data)) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  return { status: r.status, data, login: s.login };
}
const isSent = (r: Sent | LocalFactorState): r is Sent => "status" in r && "data" in r;

export async function enrollLocalFactorAction(_prev: LocalFactorFlow, fd: FormData): Promise<LocalFactorState> {
  const password = String(fd.get("password") ?? "");
  if (!password) return fail(TEXT.noPassword);
  if (password.length > PASSWORD_MAX) return fail(refusalText(401, { reason: "bad_password" }));
  // the password is checked again by the gateway and counted in the sign-in limits of this address
  const r = await send("/enroll", { password }, true);
  if (!isSent(r)) return r;
  const d = r.data;
  if (r.status !== 200 && r.status !== 201) return fail(refusalText(r.status, d));
  if (typeof d.qr_svg !== "string" || typeof d.secret_text !== "string" || !d.secret_text || typeof d.expires_at !== "string")
    return fail(TEXT.failed(r.status));
  return ok(TEXT.scan, { pending: { qrSrc: qrImageSrc(d.qr_svg), secretText: d.secret_text, expiresAt: d.expires_at } });
}

export async function confirmLocalFactorAction(_prev: LocalFactorFlow, fd: FormData): Promise<LocalFactorState> {
  const code = codeField(fd);
  if (!code) return fail(TEXT.noCode);
  if (code.length > CODE_MAX) return fail(refusalText(400, { reason: "bad_code" }));
  const r = await send("/confirm", { code });
  if (!isSent(r)) return r;
  const d = r.data;
  if (r.status !== 200) return fail(refusalText(r.status, d));
  const codes = Array.isArray(d.recovery_codes) ? d.recovery_codes.filter((c): c is string => typeof c === "string" && c.length > 0 && c.length <= 64) : [];
  if (!codes.length) return fail(TEXT.failed(r.status));
  // the page is not refreshed here: the codes would vanish before they are saved — "Done" under them refreshes it
  const signedOut = d.signed_out === true;
  return ok(TEXT.done, { codes, signedOut, login: r.login, lines: [signedOut ? TEXT.signedOut : TEXT.otherSignedOut] });
}

export async function disableLocalFactorAction(_prev: LocalFactorFlow, fd: FormData): Promise<LocalFactorState> {
  const code = codeField(fd);
  if (!code) return fail(TEXT.noCode);
  if (code.length > CODE_MAX) return fail(refusalText(401, { reason: "bad_code" }));
  const r = await send("/disable", { code });
  if (!isSent(r)) return r;
  if (r.status !== 200 || r.data.disabled !== true) return fail(refusalText(r.status, r.data));
  refresh();
  return ok(TEXT.disabled);
}
