// Parsing limit/cursor for REST and the admin API. Pure functions — the unit tests check them too.
// Garbage in the parameters answers invalid_argument, not "Internal error": before, NaN went straight into LIMIT.
import { invalid } from "@memory/shared";
import { decodeKeyset } from "@memory/mcp-core";

// The "time + id" cursor of MCP answers and the uuid check are in @memory/mcp-core (shared with the edge)
export { decodeKeyset, encodeKeyset, isUuidParam } from "@memory/mcp-core";

/** An integer from the query string with bounds; empty — the default, garbage or out of bounds — 400. */
export function intParam(raw: string | undefined | null, def: number, min: number, max: number, name = "limit"): number {
  if (raw === undefined || raw === null || raw === "") return def;
  if (!/^-?\d+$/.test(raw.trim())) throw invalid(`${name}: an integer from ${min} to ${max}`);
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${name}: an integer from ${min} to ${max}`);
  return n;
}

/** The offset cursor of the admin API (`/admin/people`, `/admin/keys`, …): a non-negative integer. */
export function offsetCursor(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  if (!/^\d+$/.test(raw.trim())) throw invalid("cursor: the opaque string from the previous response (next_cursor)");
  return Number(raw.trim());
}

/** The old journal cursor — an ISO time (`toISOString()` of the last row); other date kinds were never given here. */
const LEGACY_AUDIT_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The panel journal cursor (`/admin/audit`): "time with microseconds + id" (encodeKeyset), as other lists have. "My
 * actions" (`/me/audit`) has its own cursor without the event id — decodeMyAuditCursor below.
 * The old time cursor still lives in open tabs and bookmarks — it is accepted as before
 * (`id: null`, the filter `at < cursor`), and the next page already gets the new cursor. Garbage — 400, not 500 on ::timestamptz.
 */
export function decodeAuditCursor(raw: string | undefined | null): { at: string; id: string | null } | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (LEGACY_AUDIT_CURSOR.test(raw) && !Number.isNaN(Date.parse(raw))) return { at: raw, id: null };
  return decodeKeyset(raw);
}

/** A journal period bound (`from`, `to` of "My actions"): an ISO date or time; garbage — 400, not 500 on ::timestamptz. */
export function timeParam(raw: string | undefined | null, name: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(Date.parse(raw))) throw invalid(`${name}: an ISO 8601 date or time`);
  return raw;
}

/**
 * A timestamp for the "time + id" cursor — as text from SQL with microseconds, as Postgres stores it. Through Date it lost
 * microseconds: `(ts, id) > ($at, $id)` picked the page's last row again (with limit=1 the output stood still, with
 * 100 the bound was duplicated), and when descending `<` silently skipped neighbours within the same millisecond.
 * The format is the same ISO with "Z", so millisecond cursors already given parse as before. Independent of the session TimeZone.
 */
export const keysetAtSql = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The ascending "time + id" order when merging selections from different bases — by the keysetAtSql text (fixed width, so
 * the row order matches the time order) and by id, as Postgres compares uuid. `getTime()` cut the microseconds.
 */
export const keysetCompare = (a: { at_key: string; id: string }, b: { at_key: string; id: string }): number =>
  a.at_key < b.at_key ? -1 : a.at_key > b.at_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The "My actions" cursor (`GET /me/audit`): the time of the page's last row as keysetAtSql text (microseconds
 * as in the base) and how many rows with exactly this time are already shown. The next page — `at <= time … OFFSET shown` with
 * the "time, id" order descending: events of the same millisecond and of one time (a batch in one transaction) do not drop out.
 * The event id is not put into the cursor: for search it is search_id, and "My actions" does not reveal it. The old
 * cursor — an ISO time from the row's `at` — is accepted as before (`at <`). The panel journal (decodeAuditCursor above) pages
 * by the pair (time, id): the administrator sees event ids anyway.
 */
export type MyAuditCursor = { before: string } | { at: string; skip: number };

export const encodeMyAuditCursor = (atKey: string, skip: number): string => Buffer.from(`${atKey}|${skip}`).toString("base64url");

export function decodeMyAuditCursor(raw: string | undefined | null): MyAuditCursor | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const bad = () => invalid("cursor: the opaque string from the previous response (next_cursor)");
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) { if (Number.isNaN(Date.parse(raw))) throw bad(); return { before: raw }; }
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const [at, skip] = parts;
  if (parts.length !== 2 || !at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) || Number.isNaN(Date.parse(at)) || !skip || !/^\d{1,9}$/.test(skip)) throw bad();
  return { at, skip: Number(skip) };
}

/**
 * The next page cursor by the time keys (keysetAtSql) of the given rows in order: how many rows with the last time are
 * shown on this page, plus those shown before if the old cursor stood at the same time (the whole page is one time).
 */
export function nextMyAuditCursor(keys: readonly string[], prev: MyAuditCursor | null): string | null {
  if (!keys.length) return null;
  const last = keys[keys.length - 1]!;
  let same = 0;
  for (let i = keys.length - 1; i >= 0 && keys[i] === last; i--) same++;
  return encodeMyAuditCursor(last, (prev && "at" in prev && prev.at === last ? prev.skip : 0) + same);
}
