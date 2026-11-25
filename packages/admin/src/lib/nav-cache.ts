import { createHash } from "node:crypto";
import type { Me, MyNavSummary } from "./types";

export const NAV_TTL_MS = 30_000;
export const NAV_STALE_MS = 5 * 60_000;
export const PROFILE_KEEP_MS = 24 * 3_600_000;
const MAX_ENTRIES = 5_000;

export const sessionTag = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

interface Entry<T> { at: number; data: T; fresh: boolean }

export class SessionMemo<T> {
  private readonly map = new Map<string, Entry<T>>();
  private readonly gens = new Map<string, number>();
  constructor(private readonly ttl: number, private readonly keep: number) {}
  generation(key: string): number {
    return this.gens.get(sessionTag(key)) ?? 0;
  }
  fresh(key: string, now = Date.now()): T | null {
    const e = this.map.get(sessionTag(key));
    return e && e.fresh && now - e.at < this.ttl ? e.data : null;
  }
  last(key: string, now = Date.now()): T | null {
    const e = this.map.get(sessionTag(key));
    return e && now - e.at < this.keep ? e.data : null;
  }
  put(key: string, data: T, now = Date.now(), fresh = true): void {
    const tag = sessionTag(key);
    const prev = this.map.get(tag);
    const at = fresh || !prev || now - prev.at >= this.keep ? now : prev.at;
    this.map.delete(tag);
    this.map.set(tag, { at, data, fresh });
    if (this.map.size > MAX_ENTRIES) {
      for (const [k, e] of this.map) if (now - e.at >= this.keep) this.map.delete(k);
      for (const k of this.map.keys()) { if (this.map.size <= MAX_ENTRIES) break; this.map.delete(k); }
    }
    if (this.gens.size > MAX_ENTRIES) this.gens.clear();
  }
  invalidate(key: string): void {
    const tag = sessionTag(key);
    this.gens.set(tag, (this.gens.get(tag) ?? 0) + 1);
    const e = this.map.get(tag);
    if (e) e.fresh = false;
  }
  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); this.gens.clear(); }
}

export type Settle<T> = (data: T, last: T | null) => { data: T; fresh: boolean };

export async function cachedFetch<T>(memo: SessionMemo<T>, key: string, load: () => Promise<{ ok: true; data: T } | { ok: false }>,
  now: () => number = Date.now, settle?: Settle<T>): Promise<{ data: T | null; stale: boolean }> {
  const hit = memo.fresh(key, now());
  if (hit) return { data: hit, stale: false };
  const gen = memo.generation(key);
  const r = await load();
  if (r.ok) {
    const s = settle ? settle(r.data, memo.last(key, now())) : { data: r.data, fresh: true };
    if (memo.generation(key) === gen) memo.put(key, s.data, now(), s.fresh);
    else if (memo.last(key, now()) === null) memo.put(key, s.data, now(), false);
    return { data: s.data, stale: !s.fresh };
  }
  const last = memo.last(key, now());
  return { data: last, stale: last !== null };
}

export const settleNav: Settle<MyNavSummary> = (data, last) => {
  const missing = data.incomplete ?? [];
  if (!missing.length) return { data, fresh: true };
  const out = { ...data } as Record<string, unknown>;
  if (last) for (const part of missing) if (part in last) out[part] = (last as unknown as Record<string, unknown>)[part];
  return { data: out as unknown as MyNavSummary, fresh: false };
};

export interface ShellUser { name: string; sub: string }
export const shellUser = (me: Pick<Me, "person">): ShellUser => {
  const p = me.person;
  return { name: p.display_name || p.login, sub: p.role || p.department || p.login };
};

export const navMemo = new SessionMemo<MyNavSummary>(NAV_TTL_MS, NAV_STALE_MS);
export const profileMemo = new SessionMemo<ShellUser>(PROFILE_KEEP_MS, PROFILE_KEEP_MS);

export const invalidateNav = (key: string): void => navMemo.invalidate(key);

const READ_TOOLS = new Set(["memory_me", "memory_search", "memory_list", "memory_read"]);
export const toolChanges = (name: string): boolean => !READ_TOOLS.has(name);
export const methodChanges = (method: string | undefined): boolean => Boolean(method) && !/^(GET|HEAD)$/i.test(method!);
