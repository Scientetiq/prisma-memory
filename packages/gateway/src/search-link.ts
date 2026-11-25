// The "search → read" link: memory_search gives `search_id` — the id
// of its `search` event in the journal, memory_read takes it as an optional parameter. Here — the check that it is a search
// of the same caller, and the read event fields. The parameter is a hint: the read answer ignores it, no case refuses,
// the read never waits for the journal past LINK_TIMEOUT_MS. Nothing is read by `search_id` — another's output cannot
// be learned by it. The journal is read by its own small pool with timeouts (`auditLink`, shared/db.ts), not by `auditRead`.
import { log } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { auditPrincipal } from "./audit.ts";

/** An explicit search_id older than a day is not linked (a record "inspired" by an old search is no outcome of it). */
export const SEARCH_LINK_MAX_AGE_MS = 24 * 3_600_000;
/** The window around the UUIDv7 time: the gateway (id) and base (`at`) clocks drift (about 1.5 s on a host). */
export const SEARCH_LINK_SKEW_MS = 5 * 60_000;
/** The cap on waiting for the journal per read: past it — `search_link: unverified` (as on any pool error); no waiting. */
export const LINK_TIMEOUT_MS = 300;

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Time (ms) from a UUIDv7 — its first 48 bits — if it is one and within [now − a day, now + 5 min]; else null. */
export function searchIdTime(raw: unknown, now = Date.now()): number | null {
  if (typeof raw !== "string" || !UUID7.test(raw)) return null;
  const ms = parseInt(raw.slice(0, 8) + raw.slice(9, 13), 16);
  return ms >= now - SEARCH_LINK_MAX_AGE_MS && ms <= now + SEARCH_LINK_SKEW_MS ? ms : null;
}

/** Link fields in the `details` of a read event (read / extended_key_use). */
export type SearchLinkDetails =
  | Record<string, never>                                              // no parameter
  | { search_id: string; rank: number | null }                        // own output: the record's place in it (null — not there)
  | { search_id_ignored: true }                                       // not a UUIDv7, over a day old, another's or missing — no id
  | { search_id: string; search_link: "unverified" };                 // the journal is late or down (timeout, connection, sign-in or rights error) — not checked

interface Row { at: Date | string; mine: boolean | null; rank: number | null }

/**
 * The check SQL: the `search` event with this id, the record's rank in it and "mine?" — same key (or workplace session), same
 * principal and the same "on behalf" branch (two branches: `on_behalf_of = $` for a service on behalf of a person, `IS NULL` for
 * others — btree does not serve IS NOT DISTINCT FROM). With the `at` window — partition pruning by the PK (id, at);
 * without the window — a repeat by id over all partitions, only on a miss (a clock drift larger than the window).
 */
export function searchLinkSql(obo: boolean, windowed: boolean): string {
  return `SELECT at, array_position(record_ids, $2::uuid) AS rank,
                 COALESCE(key_id = $3::uuid AND principal_id = $4::uuid AND ${obo ? "on_behalf_of = $5::uuid" : "on_behalf_of IS NULL"}, false) AS mine
            FROM audit_events
           WHERE id = $1::uuid AND event_type = 'search'${windowed ? ` AND at >= $${obo ? 6 : 5} AND at < $${obo ? 7 : 6}` : ""}
           LIMIT 1`;
}

const timeout = <T,>(p: Promise<T>, ms: number): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`the log did not respond within ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
};

/**
 * Link fields for the read event of record `recordId`. Never throws, never waits past `timeoutMs`. Not a UUIDv7 or outside
 * the window — no journal call. Another caller gets nothing by `search_id`: the read answer is the same, and the journal
 * gets only a flag (the passed text itself is not written — another's output cannot be tied to one's own read).
 */
export async function searchLink(app: Pick<App, "db">, caller: Caller, raw: string | undefined, recordId: string,
                                 o: { timeoutMs?: number; now?: number } = {}): Promise<SearchLinkDetails> {
  if (raw === undefined) return {};
  const now = o.now ?? Date.now(), t = searchIdTime(raw, now);
  if (t === null) return { search_id_ignored: true };
  const sid = raw.toLowerCase(), who = auditPrincipal(caller), obo = who.onBehalfOf !== null;
  const base: unknown[] = [sid, recordId, who.keyId, who.principalId, ...(obo ? [who.onBehalfOf] : [])];
  const ms = o.timeoutMs ?? LINK_TIMEOUT_MS, deadline = Date.now() + ms;
  const lookup = async (): Promise<SearchLinkDetails> => {
    const pool = app.db.auditLink();
    let row = (await pool.query(searchLinkSql(obo, true), [...base, new Date(t - SEARCH_LINK_SKEW_MS), new Date(t + SEARCH_LINK_SKEW_MS)])).rows[0] as Row | undefined;
    if (!row) {
      // time ran out during the window wait: the read went unverified — a repeat over all partitions would only load the journal;
      // the same error as the timer's — the outcome does not depend on whether the timer fired
      if (Date.now() >= deadline) throw new Error(`the log did not respond within ${ms} ms`);
      // a miss by PK in the window: no such search, or the gateway and base clocks drifted past the window — then a warning
      // with the drift (NTP may be unsynced on a host), the link still counts
      row = (await pool.query(searchLinkSql(obo, false), base)).rows[0] as Row | undefined;
      if (row) log.warn("search_link_clock_skew", { skew_ms: new Date(row.at).getTime() - t });
    }
    if (!row || row.mine !== true) return { search_id_ignored: true };
    return { search_id: sid, rank: row.rank === null ? null : Number(row.rank) };
  };
  try {
    return await timeout(lookup(), ms);
  } catch (e) {
    // any refusal — timeout, connection, sign-in, pg_hba, rights: the link is unchecked, the id is written as passed (it may be
    // to be another's; on a long failure — for every such read) — the outcomes job checks it offline by the same key
    log.warn("search_link_unavailable", { error: (e as Error).message.slice(0, 200) });
    return { search_id: sid, search_link: "unverified" };
  }
}
