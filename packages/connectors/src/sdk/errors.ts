// The error a connector throws to stop a run with a stable code: `auth_failed`, `rate_limited`, a vendor
// outage, a configuration problem of its own. The runner of the workers stores the code (never a message) in
// connectors.last_error and connector_runs.error and decides by it whether to retry with backoff or to stop the
// connector at once (run-codes.ts). A vendor's Retry-After travels with the error and wins over the runner's backoff.
// Any other error a connector throws is stored as "internal" (or the code of an egress or secret error).
import type { EgressResponse } from "./types.ts";
import { markDeclared } from "../failure.ts";

/** A code: lowercase words, an optional `:detail` part, at most 64 characters. */
const CODE = /^[a-z][a-z0-9_]*(:[a-z0-9_*]+)?$/;
const CODE_MAX = 64;
/** Longest Retry-After the runner honours: one day. */
export const RETRY_AFTER_MAX_SEC = 86_400;

/** Retry-After of a response in seconds (delta-seconds or an HTTP date), clamped to 0 … 86 400; null when absent or bad. */
export function retryAfterSec(res: Pick<EgressResponse, "headers">, now: Date): number | null {
  const raw = res.headers["retry-after"];
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (/^[0-9]+$/.test(v)) return Math.min(Number(v), RETRY_AFTER_MAX_SEC);

  const rfc850 = /^((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day), ([0-9]{2})-([A-Za-z]{3})-([0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/.exec(v);
  const normalized = v.replace(
    /^([A-Za-z]{3}) ([A-Za-z]{3}) ( [0-9]|[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) ([0-9]{4})$/,
    (_, weekday, month, day, time, year) => `${weekday}, ${day.trimStart().padStart(2, "0")} ${month} ${year} ${time} GMT`,
  );
  const parts = rfc850 ?? /^([A-Za-z]{3}), ([0-9]{2}) ([A-Za-z]{3}) ([0-9]{4}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/.exec(normalized);
  if (!parts) return null;
  const [, weekday, day, month, yearText, time] = parts;
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(weekday.slice(0, 3))) return null;

  const monthIndex = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(month.toLowerCase());
  if (monthIndex < 0) return null;
  let year = Number(yearText);
  if (rfc850) {
    const clockYear = now.getUTCFullYear();
    if (!Number.isFinite(clockYear)) return null;
    const cutoffYear = clockYear + 50;
    const monthDayTime = `${String(monthIndex + 1).padStart(2, "0")}-${day}T${time}`;
    year += Math.floor(cutoffYear / 100) * 100;
    if (year > cutoffYear || (year === cutoffYear && monthDayTime > now.toISOString().slice(-19, -5))) year -= 100;
  }

  const dayOfMonth = Number(day);
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, dayOfMonth);
  const [hour, minute, second] = time.split(":").map(Number);
  if (date.getUTCDate() !== dayOfMonth || hour > 23 || minute > 59 || (second > 59 && time !== "23:59:60")) return null;
  const t = date.setUTCHours(hour, minute, second);
  if (!Number.isFinite(t)) return null;
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(0, Math.ceil((t - now.getTime()) / 1000)));
}

export class ConnectorError extends Error {
  /** A stable code; a string that is not of the form of a code becomes "internal". */
  readonly code: string;
  /** Seconds the vendor asked to wait (0 … 86 400), or null. */
  readonly retryAfterSec: number | null;
  constructor(code: string, o: { retryAfterSec?: number | null } = {}) {
    const c = typeof code === "string" && code.length <= CODE_MAX && CODE.test(code) ? code : "internal";
    super(c);
    this.name = "ConnectorError";
    this.code = c;
    const r = o.retryAfterSec;
    this.retryAfterSec = typeof r === "number" && Number.isFinite(r) && r >= 0 ? Math.min(Math.ceil(r), RETRY_AFTER_MAX_SEC) : null;
    // the code this constructor checked is what the core reads later (never the object's own, mutable `code`)
    markDeclared(this, c, this.retryAfterSec);
  }
}

/**
 * The ConnectorError of a vendor HTTP answer, or null for 2xx and 3xx: 401 and 403 → `auth_failed` (a configuration
 * error: retrying cannot fix a refused key), 429 → `rate_limited`, 5xx → `vendor_unavailable` (both with the vendor's
 * Retry-After), 404 → `vendor_not_found`, any other 4xx → `vendor_refused`. The vendor's body is never read.
 */
export function vendorError(res: Pick<EgressResponse, "status" | "headers">, now: Date): ConnectorError | null {
  const s = res.status;
  if (s < 400) return null;
  if (s === 401 || s === 403) return new ConnectorError("auth_failed");
  if (s === 429) return new ConnectorError("rate_limited", { retryAfterSec: retryAfterSec(res, now) });
  if (s >= 500) return new ConnectorError("vendor_unavailable", { retryAfterSec: retryAfterSec(res, now) });
  if (s === 404) return new ConnectorError("vendor_not_found");
  return new ConnectorError("vendor_refused");
}

/** Longest connector name an EntityResolverError carries. */
const RESOLVER_NAME_MAX = 80;

/**
 * A lookup of an external entity failed in a way a retry may fix — the network, a timeout, HTTP 404 or 5xx, a tool error
 *. The entities stage fails and is retried; its `record_stages.last_error` reads
 * `entity_resolver_unavailable: <connector name>: <code>`. Configuration failures (a refused address, an unreadable
 * secret, HTTP 401/403) are not this error: they set the connector to `error` and the stage goes on.
 */
export class EntityResolverError extends Error {
  readonly kind = "entity_resolver_unavailable" as const;
  readonly code: string;
  constructor(connectorName: string, code: string) {
    const flat = typeof connectorName === "string"
      ? connectorName.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/gu, " ").trim() : "";
    const chars = [...flat];
    const name = (chars.length > RESOLVER_NAME_MAX ? chars.slice(0, RESOLVER_NAME_MAX).join("").trimEnd() : flat) || "connector";
    const c = typeof code === "string" && code.length <= CODE_MAX && CODE.test(code) ? code : "internal";
    super(`${name}: ${c}`);
    this.name = "EntityResolverError";
    this.code = c;
  }
}
