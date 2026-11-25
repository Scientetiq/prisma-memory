import { createHash } from "node:crypto";

export interface QueryCacheConfig { size: number; ttl_sec: number }
const positive = (n: number): number => Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** Process-local LRU. Keys contain the embedder id, its vector source (address, model, space, generation — embedder.ts vectorSource) and an NFC query digest; no query text is retained. */
export class QueryVectorCache {
  private readonly entries = new Map<string, { at: number; vector: Float32Array }>();
  constructor(private readonly now: () => number = Date.now) {}

  private key(embedder: string, source: string, query: string): string {
    return JSON.stringify([embedder, source, createHash("sha256").update(query.normalize("NFC")).digest("hex")]);
  }
  private trim(cfg: QueryCacheConfig): boolean {
    const size = positive(cfg.size), ttl = positive(cfg.ttl_sec) * 1000;
    for (const [key, entry] of this.entries) if (!size || !ttl || this.now() - entry.at >= ttl) this.entries.delete(key);
    while (this.entries.size > size) this.entries.delete(this.entries.keys().next().value!);
    return size > 0 && ttl > 0;
  }
  get(embedder: string, source: string, query: string, cfg: QueryCacheConfig): Float32Array | null {
    if (!this.trim(cfg)) return null;
    const key = this.key(embedder, source, query), entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.vector.slice();
  }
  set(embedder: string, source: string, query: string, vector: readonly number[], cfg: QueryCacheConfig): void {
    if (!this.trim(cfg)) return;
    const key = this.key(embedder, source, query);
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), vector: Float32Array.from(vector) });
    this.trim(cfg);
  }
}

// A process can host several application contexts (including tests); their model registries are independent.
const caches = new WeakMap<object, QueryVectorCache>();
export function queryVectorCache(owner: object): QueryVectorCache {
  let cache = caches.get(owner);
  if (!cache) { cache = new QueryVectorCache(); caches.set(owner, cache); }
  return cache;
}
