// «Time + id» cursor in MCP answers (next_cursor of memory_list) — shared by gateway and edge (moved from
// gateway/src/paging.ts). Strings and Buffer only, no I/O.
import { invalid } from "./errors.ts";

/** UUID in a path: «not a uuid» is not_found, not a 500 on a type cast in SQL. */
export const isUuidParam = (raw: string | undefined | null): boolean => typeof raw === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw);

/**
 * «Timestamp + id» cursor: an opaque base64url string, a stable order for equal timestamps. The string (a timestamp
 * with microseconds from SQL) is kept as is.
 */
export const encodeKeyset = (at: Date | string, id: string): string =>
  Buffer.from(`${typeof at === "string" ? at : at.toISOString()}|${id}`).toString("base64url");

/**
 * Parse of a «time + id» cursor. The id is checked as a whole uuid (isUuidParam), not as «36 digits and hyphens»: a forged
 * cursor of 36 hyphens reached `::uuid` and gave 500 instead of 400 — in all keyset lists.
 */
export function decodeKeyset(raw: string | undefined | null): { at: string; id: string } | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const badCursor = () => invalid("cursor: the opaque string from the previous response (next_cursor)");
  // 32 bytes for a timestamp with six fractional digits and a numeric offset, 1 for "|",
  // and 36 for a UUID. Those 69 bytes take 92 unpadded base64url characters.
  if (raw.length > 92 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw badCursor();
  const payload = Buffer.from(raw, "base64url");
  if (payload.toString("base64url") !== raw) throw badCursor();
  const fields = payload.toString("utf8").split("|");
  const [at, id] = fields;
  if (fields.length !== 2 || !at || !id || !isUuidParam(id)) throw badCursor();

  // The gateway's due-date list also uses this cursor with a calendar day.
  const dateParts = /^(?!0000)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5])(?::[0-5]\d)?))?$/.exec(at);
  if (!dateParts) throw badCursor();
  const [, year, month, day] = dateParts;
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (calendarDate.getUTCDate() !== Number(day)) throw badCursor();
  return { at, id };
}
