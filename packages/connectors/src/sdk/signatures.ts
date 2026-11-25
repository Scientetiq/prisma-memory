// Signatures of inbound webhooks: the Standard Webhooks scheme and the bearer push token.
// Pure functions over node:crypto, no I/O: the gateway's hooks route reads the secrets and the headers and calls these.
//
// Standard Webhooks: the signature is `v1,` + base64 of HMAC-SHA256 under the secret's key over
// `<webhook-id>.<webhook-timestamp>.<raw body>`. The secret is `whsec_` + standard base64 of the key (the prefix is
// optional); like the official libraries, the key is always the base64-decoded bytes, never the UTF-8 bytes of the
// text. A header may carry several space-separated signatures (a sender that rotates its secret signs with both): the
// first ten entries are examined, entries of another version or of another length are ignored, and every candidate key
// is compared with every counted entry in constant time, with no early exit.
//
// Push token (bearer mode, off by default): `pmc_` + base64url of 32 random bytes; it proves who sends, not that the
// body is authentic, so it claims no timestamp window and no event id.
//
// Results and errors carry codes only — never a secret, a key, a signature or a part of the body.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isStrictBase64 } from "./items.ts";
import type { SignatureSchemeId } from "./types.ts";

/** Name of the webhook signing secret in connector_secrets (the framework's secret, not a manifest secret). */
export const WEBHOOK_SIGNING_SECRET = "webhook";
/** Name of the bearer push token in connector_secrets (bearer mode). */
export const PUSH_TOKEN_SECRET = "push_token";
/** Signatures of one `webhook-signature` header that are examined; later ones are ignored. */
export const WEBHOOK_MAX_SIGNATURES = 10;
/** Longest `webhook-signature` header accepted (contract `connectors` 1.0.0). */
export const WEBHOOK_SIGNATURE_HEADER_MAX = 1024;
/** Shape of a push token. */
export const PUSH_TOKEN = /^pmc_[A-Za-z0-9_-]{32,128}$/;

const SECRET_PREFIX = "whsec_";
const KEY_MIN_BYTES = 24;
const KEY_MAX_BYTES = 64;
const MAC_BYTES = 32;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;
/** Characters the contract refuses in header values. */
const CTL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Codes of refused hooks requests (the reason of the auth_failure audit event; never shown to the sender). */
export const WEBHOOK_REFUSAL_CODES = [
  "headers_missing", "headers_invalid", "timestamp_out_of_window", "secret_invalid", "signature_mismatch",
  "secret_missing", "secret_unreadable", "push_token", "push_disabled",
] as const;
export type WebhookRefusalCode = (typeof WEBHOOK_REFUSAL_CODES)[number];
export type WebhookVerifyCode = Extract<WebhookRefusalCode, "headers_missing" | "headers_invalid" | "timestamp_out_of_window" | "secret_invalid" | "signature_mismatch">;

/** What a signature scheme proves beyond the body: replay protection relies only on what is signed. */
export const SCHEME_GUARANTEES: Record<SignatureSchemeId, { signed_timestamp: boolean; signed_event_id: boolean }> = {
  standard_webhooks: { signed_timestamp: true, signed_event_id: true },
  // the body alone is signed (vendor schemes): no time window, the event key comes from the body
  hmac_sha256_hex_body: { signed_timestamp: false, signed_event_id: false },
};

/** A new webhook signing secret: `whsec_` + standard base64 of 32 random bytes. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64");
}

/** A new push token: `pmc_` + base64url of 32 random bytes. */
export function generatePushToken(): string {
  return "pmc_" + randomBytes(32).toString("base64url");
}

/** The HMAC key of a webhook secret (one optional `whsec_`, strict padded base64, 24–64 bytes), or null. */
export function webhookSecretKey(secret: unknown): Buffer | null {
  if (typeof secret !== "string") return null;
  const b64 = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (b64.length > 128 || !isStrictBase64(b64)) return null;
  const key = Buffer.from(b64, "base64");
  return key.length >= KEY_MIN_BYTES && key.length <= KEY_MAX_BYTES ? key : null;
}

const mac = (key: Buffer, id: string, timestamp: string, body: Uint8Array): Buffer =>
  createHmac("sha256", key).update(`${id}.${timestamp}.`, "utf8").update(body).digest();

/** The `webhook-signature` value of a request (one `v1,` entry). Throws a TypeError without details on a bad secret. */
export function signStandardWebhook(secret: string, id: string, timestampSec: number, body: Uint8Array): string {
  const key = webhookSecretKey(secret);
  if (!key) throw new TypeError("webhook signature: the secret is not a valid webhook secret");
  if (!Number.isSafeInteger(timestampSec) || timestampSec < 0) throw new TypeError("webhook signature: the timestamp is not a whole number of seconds");
  return `v1,${mac(key, id, String(timestampSec), body).toString("base64")}`;
}

export type WebhookVerifyResult = { ok: true; id: string; timestamp: number } | { ok: false; code: WebhookVerifyCode };

export interface WebhookHeaders {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** The receiver's clock, milliseconds since the Unix epoch. */
  nowMs: number;
  /** Allowed difference between the signed timestamp and the receiver's clock, seconds (inclusive). */
  toleranceSec: number;
}

const absent = (v: unknown): boolean => v === null || v === undefined || v === "";

/**
 * The header checks of Standard Webhooks without the body and the HMAC: presence, shape and the timestamp window. The
 * hooks route calls it before it reads the body.
 */
export function checkWebhookHeaders(h: WebhookHeaders): WebhookVerifyResult {
  if (absent(h.id) || absent(h.timestamp) || absent(h.signature)) return { ok: false, code: "headers_missing" };
  const id = h.id as unknown, ts = h.timestamp as unknown, sig = h.signature as unknown;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return { ok: false, code: "headers_invalid" };
  if (typeof ts !== "string" || !TIMESTAMP.test(ts)) return { ok: false, code: "headers_invalid" };
  if (typeof sig !== "string" || sig.length > WEBHOOK_SIGNATURE_HEADER_MAX || CTL.test(sig)) return { ok: false, code: "headers_invalid" };
  const timestamp = Number(ts);
  const now = Math.floor(h.nowMs / 1000);
  if (!Number.isFinite(h.nowMs) || !Number.isFinite(h.toleranceSec) || Math.abs(now - timestamp) > h.toleranceSec) return { ok: false, code: "timestamp_out_of_window" };
  return { ok: true, id, timestamp };
}

/** The counted entries of a signature header: `v1,<strict base64 of exactly 32 bytes>` among the first ten. */
function signatureEntries(header: string): Buffer[] {
  const out: Buffer[] = [];
  for (const entry of header.split(" ").slice(0, WEBHOOK_MAX_SIGNATURES)) {
    if (!entry.startsWith("v1,")) continue;
    const b64 = entry.slice(3);
    if (b64.length !== 44 || !isStrictBase64(b64)) continue;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === MAC_BYTES) out.push(bytes);
  }
  return out;
}

/**
 * Verifies a Standard Webhooks request against the candidate secrets (the current one and, during a rotation, the
 * previous one). `body` is the raw body as received — nothing decoded, trimmed or re-serialised.
 */
export function verifyStandardWebhook(o: WebhookHeaders & { secrets: readonly string[]; body: Uint8Array }): WebhookVerifyResult {
  const head = checkWebhookHeaders(o);
  if (!head.ok) return head;
  const keys = (Array.isArray(o.secrets) ? o.secrets : []).map(webhookSecretKey).filter((k): k is Buffer => k !== null);
  if (keys.length === 0) return { ok: false, code: "secret_invalid" };
  const entries = signatureEntries(o.signature as string);
  const body = o.body instanceof Uint8Array ? o.body : new Uint8Array(0);
  let match = false;
  for (const key of keys) {
    const expected = mac(key, head.id, o.timestamp as string, body);
    // every pair is compared: the time taken does not depend on which entry or which key matched
    for (const entry of entries) if (timingSafeEqual(expected, entry)) match = true;
  }
  return match ? head : { ok: false, code: "signature_mismatch" };
}

const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();

/** True when the presented push token equals one of the candidates; constant-time on SHA-256 digests, all compared. */
export function verifyPushToken(candidates: readonly string[], presented: unknown): boolean {
  if (typeof presented !== "string" || !PUSH_TOKEN.test(presented)) return false;
  const p = digest(presented);
  let match = false;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (typeof c !== "string") continue;
    if (timingSafeEqual(digest(c), p)) match = true;
  }
  return match;
}
