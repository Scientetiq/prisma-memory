// The program the MCP client named itself: whom it is written for, where it comes from, and the initialize cache of earlier
// revisions. Order of sources: clientInfo in the request's _meta (revision 2026-07-28, an optional field) → clientInfo from
// the initialize of an earlier revision, kept by the pair (key, first User-Agent token) → the first User-Agent token (set by
// auth.ts). This is information only: rights and the record class do not depend on what was sent.
import { clientFromInfo, sanitizeRevision, uaString, uaToken, type ClaimedClient } from "@memory/shared";
import type { Caller } from "./context.ts";

export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
/** The gateway does not read an initialize larger than this: clientInfo fits with room, a large body is not cloned. */
export const INIT_BODY_MAX = 4096;

/**
 * Whom a sent program is written for: a person's key and a service key. A workplace session (User-Agent of the workplace servers,
 * clientInfo `memory-workspace` of the workplace itself), the system key, a panel session and a preview key (issued
 * by the panel to a demo persona) are not; for a download link (callerForKey) the gateway sets no program at all.
 */
export const claimEligible = (c: Pick<Caller, "keyKind" | "principalType" | "preview">): boolean =>
  c.keyKind !== "session" && c.principalType !== "system" && !c.preview;

/** What the request headers tell of the client: the User-Agent token (cache key; empty — no header) and the MCP revision. */
export function requestClaim(h: Headers): { uaName: string; ua?: string; rev?: string } {
  const t = uaToken(h.get("user-agent"));
  const rev = sanitizeRevision(h.get("mcp-protocol-version"));
  return { uaName: t?.name ?? "", ...(t ? { ua: uaString(t)! } : {}), ...(rev ? { rev } : {}) };
}

/** The request's program: clientInfo from _meta, otherwise the fallback (from initialize or User-Agent) as is. */
export function pickClient(meta: unknown, fallback: ClaimedClient | undefined, req: { ua?: string; rev?: string }): ClaimedClient | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return fallback;
  const m = meta as Record<string, unknown>;
  return clientFromInfo(m[CLIENT_INFO_META_KEY], "meta", { ua: req.ua, rev: req.rev ?? sanitizeRevision(m[PROTOCOL_VERSION_META_KEY]) }) ?? fallback;
}

/**
 * The initialize body is read only if 0 < Content-Length ≤ 4096 (chunked — no Content-Length — is not) and the header
 * Mcp-Method is absent or equals initialize: a test client sets Mcp-Method on any revision.
 */
export function initializeReadable(h: Headers): boolean {
  const len = Number(h.get("content-length") ?? NaN);
  if (!Number.isInteger(len) || len <= 0 || len > INIT_BODY_MAX) return false;
  const m = h.get("mcp-method")?.trim();
  return !m || m === "initialize";
}

/**
 * Cache of clientInfo from initialize of earlier revisions (without sessions initialize is a separate HTTP request, and the SDK
 * answers it itself): the key is (API key, first User-Agent token). The term slides — 24 hours from the last access:
 * a client may send initialize once per connection, and a long session (an app server in an IDE) keeps the program past a day.
 * At most 8 User-Agent tokens per key (the oldest of the same key is evicted) and 2000 entries in all (the oldest is evicted):
 * one key's holder cannot evict other keys' entries by a stream of initialize calls with other User-Agents. In process memory:
 * after a gateway restart it is a miss, and the program comes from User-Agent. This is information, not state. Two clients
 * of an earlier revision with one key and the same User-Agent cannot be told apart — a heuristic.
 */
export class InitSeen {
  private readonly map = new Map<string, { at: number; keyId: string; info: { name: string; version?: string } }>();
  /** Entries of each API key in eviction order (oldest first). */
  private readonly byKey = new Map<string, Set<string>>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly perKey: number;
  private readonly now: () => number;
  constructor(o: { ttlMs?: number; max?: number; perKey?: number; now?: () => number } = {}) {
    this.ttlMs = o.ttlMs ?? 24 * 3_600_000; this.max = o.max ?? 2000; this.perKey = o.perKey ?? 8; this.now = o.now ?? Date.now;
  }
  get size(): number { return this.map.size; }
  /** To the end of both eviction queues: the shared one and the key's own. */
  private touch(k: string, e: { at: number; keyId: string; info: { name: string; version?: string } }): void {
    this.map.delete(k);
    this.map.set(k, e);
    let own = this.byKey.get(e.keyId);
    if (!own) this.byKey.set(e.keyId, (own = new Set()));
    own.delete(k);
    own.add(k);
  }
  private drop(k: string): void {
    const e = this.map.get(k);
    if (!e) return;
    this.map.delete(k);
    const own = this.byKey.get(e.keyId);
    own?.delete(k);
    if (own && !own.size) this.byKey.delete(e.keyId);
  }
  remember(keyId: string, uaName: string, info: { name: string; version?: string }): void {
    this.touch(`${keyId}|${uaName}`, { at: this.now(), keyId, info: { ...info } });
    const own = this.byKey.get(keyId)!;
    while (own.size > this.perKey) this.drop(own.values().next().value!);
    while (this.map.size > this.max) this.drop(this.map.keys().next().value!);
  }
  recall(keyId: string, uaName: string): { name: string; version?: string } | undefined {
    const k = `${keyId}|${uaName}`, e = this.map.get(k), now = this.now();
    if (!e) return undefined;
    if (now - e.at >= this.ttlMs) { this.drop(k); return undefined; }
    e.at = now;                                                     // sliding term: a hit extends the entry
    this.touch(k, e);
    return { ...e.info };
  }
}
