// Morning report: the key's program and the one the client sent. Information only: the client itself sends the
// program name, the rights and the record class do not depend on it. admin.ts selects the log rows (clientMismatchRows);
// here only the pure assembly of the report by the rule mismatchOf (@memory/shared).
import { clientKindOf, mismatchOf, type ClaimedClient, type ClaimedKind, type ClientKind } from "@memory/shared";

/** A log row: the key, the sent name and its source, how many events in the window. */
export interface ClientSeenRow { key_id: string; name: string; source: string; version: string | null; ua: string | null; n: number; last_at: string | Date }
/** A key from the control database: prefix, program, owner login. */
export interface ClientKeyRow { key_prefix: string | null; client_kind: ClientKind | null; login: string | null }

export interface ClientMismatchItem {
  key_id: string; key_prefix: string | null; person: string | null; key_client_kind: ClientKind | null;
  sent: ClaimedClient; sent_kind: ClaimedKind; severity: "warn" | "info"; events: number; last_at: string;
}
export interface ClientMismatchReport {
  checked_keys: number; count: number; warn: number; info: number;
  unknown: Array<{ name: string; kind: "transport" | null; events: number; keys: number }>; items: ClientMismatchItem[];
}

const ITEMS_MAX = 50, UNKNOWN_MAX = 10;
const SOURCES = new Set(["meta", "initialize", "user_agent"]);

/**
 * Report `client_mismatch`: warn — an unambiguous script on a cloud agent key or without a program; info — the other
 * mismatches (another agent, an agent on a script key, `memory-workspace` from an API key); unrecognised names and transports
 * (node, reqwest …) go to `unknown` (the first 10 by event count). At most 50 rows, warn first, then by event count.
 * A key missing in the control database counts as without a program (cloud), like a key from before programs.
 */
export function buildClientMismatch(rows: ClientSeenRow[], keys: ReadonlyMap<string, ClientKeyRow>): ClientMismatchReport {
  const items: ClientMismatchItem[] = [];
  const unknown = new Map<string, { name: string; kind: "transport" | null; events: number; keys: Set<string>; last: number }>();
  const checked = new Set<string>();
  for (const r of rows) {
    checked.add(r.key_id);
    const sentKind = clientKindOf(r.name);
    const last = new Date(r.last_at);
    if (sentKind === null || sentKind === "transport") {
      const u = unknown.get(r.name) ?? { name: r.name, kind: sentKind, events: 0, keys: new Set<string>(), last: 0 };
      u.events += r.n; u.keys.add(r.key_id); u.last = Math.max(u.last, last.getTime());
      unknown.set(r.name, u);
      continue;
    }
    const key = keys.get(r.key_id);
    const severity = mismatchOf(key?.client_kind ?? null, sentKind, r.name);
    if (!severity) continue;
    const source = SOURCES.has(r.source) ? (r.source as ClaimedClient["source"]) : "user_agent";
    items.push({ key_id: r.key_id, key_prefix: key?.key_prefix ?? null, person: key?.login ?? null, key_client_kind: key?.client_kind ?? null,
                 sent: { name: r.name, ...(r.version ? { version: r.version } : {}), source, ...(r.ua ? { ua: r.ua } : {}) },
                 sent_kind: sentKind, severity, events: r.n, last_at: last.toISOString() });
  }
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1) || b.events - a.events || b.last_at.localeCompare(a.last_at));
  const warn = items.filter((i) => i.severity === "warn").length;
  return {
    checked_keys: checked.size, count: items.length, warn, info: items.length - warn,
    unknown: [...unknown.values()].sort((a, b) => b.events - a.events || b.last - a.last).slice(0, UNKNOWN_MAX)
      .map((u) => ({ name: u.name, kind: u.kind, events: u.events, keys: u.keys.size })),
    items: items.slice(0, ITEMS_MAX),
  };
}
