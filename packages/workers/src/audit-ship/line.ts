// A line of the external journal by contracts/admin/audit-ship-line.schema.json. From an audit_events event only the
// service fields go: query_text, titles, texts and the rest of details never leave — details is cut to the allow list
// of the schema (SHIP_DETAIL_KEYS), values to its types and lengths, the rest dropped. Lines form a chain:
// h = sha256(prev ‖ canonical line without h) — keys sorted, no spaces; prev: the previous line's h, for the first —
// 64 zeros. A change to any line breaks the check of it and all after (verifyChain).
import { createHash } from "node:crypto";

/** details keys that go out (the allow list of the line schema). */
// by_kind and exception: details of op alert_ack
export const SHIP_DETAIL_KEYS = ["op", "reason", "code", "admin_person", "admin_session", "admin_role", "admin_auth", "key", "approval", "level", "by_kind", "exception"] as const;
type DetailKey = (typeof SHIP_DETAIL_KEYS)[number];
/** Length limit of a details string value by the schema; enums apart. */
const DETAIL_MAX: Record<Exclude<DetailKey, "admin_role" | "level" | "by_kind" | "exception">, number> = {
  op: 64, reason: 64, code: 64, admin_person: 64, admin_session: 64, admin_auth: 32, key: 128, approval: 64,
};
const DETAIL_ENUM: Partial<Record<DetailKey, readonly string[]>> = {
  admin_role: ["memory_admin", "security_auditor"],
  level: ["high", "medium", "page", "metric", "info"],
  by_kind: ["person", "admin_local", "system"],
  exception: ["no_admin_listener", "sso_login_disabled"],
};

/** h of a sink's first line. */
export const ZERO_HASH = "0".repeat(64);
/** Sender: the inner side's journal. The edge and the bridge write their own. */
export const SHIP_SOURCE = "gateway";

/** A journal event as reader.ts returns it: time is ISO with microseconds, details already cut to the allow list. */
export interface ShipEvent {
  id: string;
  at: string;
  event_type: string;
  principal_type: string | null;
  principal_id: string | null;
  service_id: string | null;
  on_behalf_of: string | null;
  key_id: string | null;
  tier: string | null;
  class: string | null;
  result_count: number | null;
  records: number | null;
  details: Record<string, unknown> | null;
}

export interface ShipLine {
  v: 1; seq: number; prev: string; h: string; id: string; at: string; source: string; event_type: string;
  principal_type: "person" | "service" | "system"; principal_id: string | null; service_id: string | null; on_behalf_of: string | null;
  key_id: string | null; tier: string | null; class: "open" | "closed" | null; result_count: number | null; records: number | null;
  details: Partial<Record<DetailKey, string>>;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** details by the allow list: only known keys, strings within the schema, enum values from the schema. */
export function shipDetails(d: Record<string, unknown> | null | undefined): Partial<Record<DetailKey, string>> {
  const out: Partial<Record<DetailKey, string>> = {};
  if (!d || typeof d !== "object") return out;
  for (const k of SHIP_DETAIL_KEYS) {
    const v = d[k];
    if (typeof v !== "string") continue;
    const allowed = DETAIL_ENUM[k];
    if (allowed ? allowed.includes(v) : v.length <= DETAIL_MAX[k as keyof typeof DETAIL_MAX]) out[k] = v;
  }
  return out;
}

/** Line fields without number and chain. No principal_type (sign-in refused before the key) — system: principal unknown. */
export function shipFields(e: ShipEvent): Omit<ShipLine, "v" | "seq" | "prev" | "h"> {
  const pt = e.principal_type === "person" || e.principal_type === "service" ? e.principal_type : "system";
  return {
    id: e.id, at: e.at, source: SHIP_SOURCE, event_type: String(e.event_type).slice(0, 64), principal_type: pt,
    principal_id: str(e.principal_id, 64), service_id: str(e.service_id, 64), on_behalf_of: str(e.on_behalf_of, 64), key_id: str(e.key_id, 64),
    tier: str(e.tier, 16), class: e.class === "open" || e.class === "closed" ? e.class : null,
    result_count: nonNeg(e.result_count), records: nonNeg(e.records), details: shipDetails(e.details),
  };
}

function sortDeep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortDeep);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sortDeep((x as Record<string, unknown>)[k])]));
  return x;
}
/** Canonical line: object keys sorted at every level, no spaces. */
export const canonical = (x: unknown): string => JSON.stringify(sortDeep(x));

/** Line h: sha256(prev ‖ canonical line without h), hex. */
export function lineHash(line: Omit<ShipLine, "h"> | ShipLine): string {
  const { h: _h, ...rest } = line as ShipLine;
  return createHash("sha256").update(rest.prev + canonical(rest), "utf8").digest("hex");
}

/** Line chain: numbers from seq + 1, prev the previous h (first: prevHash). Returns lines and the last h. */
export function chainLines(events: readonly ShipEvent[], seq: number, prevHash: string): { lines: ShipLine[]; seq: number; hash: string } {
  const lines: ShipLine[] = [];
  let prev = prevHash, n = seq;
  for (const e of events) {
    n += 1;
    const base = { v: 1 as const, seq: n, prev, ...shipFields(e) };
    const h = lineHash(base);
    lines.push({ ...base, h });
    prev = h;
  }
  return { lines, seq: n, hash: prev };
}

/** JSONL line and syslog MSG: the canonical form (the same key order as the hash). */
export const lineText = (l: ShipLine): string => canonical(l);

/**
 * Chain check: the first line where it breaks (h mismatch, prev not the previous h, or seq not growing
 * by 1), or -1: the chain is whole. start: prev of the first line (sink start — ZERO_HASH).
 */
export function verifyChain(lines: readonly ShipLine[], start = ZERO_HASH): number {
  let prev = start;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.prev !== prev || lineHash(l) !== l.h || (i > 0 && l.seq !== lines[i - 1]!.seq + 1)) return i;
    prev = l.h;
  }
  return -1;
}
