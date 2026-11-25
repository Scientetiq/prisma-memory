import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { addressBytes, PREAUTH_DEFAULTS, type PreauthLimits } from "@memory/shared";
import type { App } from "./context.ts";
import type { Channel, RequestChannel } from "./channel.ts";

const WINDOW_MS = 60_000;
export const MAX_ENTRIES = 50_000;
const MAX_FAILURE_ENTRIES = 50_000;
export const GOOD_TTL_MS = 15 * 60_000;
const GOOD_PER_ADDRESS = 32;
const GOOD_ADDRESSES = 10_000;

export type PreAuthScope = "address" | "proxy" | "global" | "failures";
export interface PreAuth {
  admit(rc: RequestChannel, opts: { exempt: boolean; hasCredential: boolean; credential?: string | null }):
    { ok: true } | { ok: false; retryAfter: number; scope: PreAuthScope };
  noteFailure(rc: Pick<RequestChannel, "ip" | "viaProxy" | "lostClient">, o?: { countAddress?: boolean }): { audit: boolean; throttledEvent: boolean; count: number };
  noteSuccess(rc: Pick<RequestChannel, "ip" | "viaProxy" | "lostClient">, credential: string | null | undefined): void;
}

export function preauthLimits(app: Pick<App, "settings">): PreauthLimits {
  const v = app.settings.get<Partial<PreauthLimits>>("limits.preauth", PREAUTH_DEFAULTS);
  const out = { ...PREAUTH_DEFAULTS };
  for (const k of Object.keys(PREAUTH_DEFAULTS) as Array<keyof PreauthLimits>) {
    const x = v && typeof v === "object" ? v[k] : undefined;
    if (typeof x === "number" && Number.isInteger(x) && x >= 0) out[k] = x;
  }
  return out;
}

export function addressKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const b = addressBytes(ip);
  if (!b) return ip;
  const hex = (i: number) => ((b[i]! << 8) | b[i + 1]!).toString(16);
  return `${hex(0)}:${hex(2)}:${hex(4)}:${hex(6)}::/64`;
}

/**
 * The network of an address for shares per network (built-in agent sign-in): IPv4 /24, IPv6 /48 — many
 * addresses of one network must not fill a limit meant for all (the bucket oauth_authorize_net, TX_NET_CAP of sign-in
 * transactions). An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is the IPv4 network: otherwise every such client would share
 * one /48. Not an IP — the input as is.
 */
export function netPrefix(ip: string): string {
  const b = addressBytes(ip);
  if (!b) return ip;
  if (isIP(ip) === 4) return `${b[0]}.${b[1]}.${b[2]}.0/24`;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return `${b[12]}.${b[13]}.${b[14]}.0/24`;
  const hex = (i: number) => ((b[i]! << 8) | b[i + 1]!).toString(16);
  return `${hex(0)}:${hex(2)}:${hex(4)}::/48`;
}

interface Window { start: number; n: number }

class Windows {
  private readonly map = new Map<string, Window>();
  constructor(private readonly max: number) {}
  get(key: string, now: number): Window | null {
    const w = this.map.get(key);
    return w && now - w.start < WINDOW_MS ? w : null;
  }
  open(key: string, now: number): Window {
    const w = this.get(key, now);
    if (w) return w;
    const fresh = { start: now, n: 0 };
    this.map.delete(key);
    this.map.set(key, fresh);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return fresh;
  }
}

class PreAuthCounters implements PreAuth {
  private readonly addresses = new Windows(MAX_ENTRIES);
  private readonly failures = new Windows(MAX_FAILURE_ENTRIES);
  /** Journal-only windows of failures that must not lock the address (noteFailure with countAddress: false). */
  private readonly quiet = new Windows(MAX_FAILURE_ENTRIES);
  private readonly globals = new Map<Channel, Window>();
  private readonly good = new Map<string, Map<string, number>>();
  private readonly salt = randomBytes(16);
  constructor(private readonly app: Pick<App, "settings">, private readonly now: () => number = () => Date.now()) {}

  private retryAfter(w: Window, now: number): number { return Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000)); }
  private print(credential: string): string { return createHash("sha256").update(this.salt).update(credential).digest("base64url").slice(0, 22); }

  private knownGood(addr: string, credential: string | null | undefined, now: number): boolean {
    if (!credential) return false;
    const at = this.good.get(addr)?.get(this.print(credential));
    return at !== undefined && at > now;
  }

  admit(rc: RequestChannel, opts: { exempt: boolean; hasCredential: boolean; credential?: string | null }): { ok: true } | { ok: false; retryAfter: number; scope: PreAuthScope } {
    if (opts.exempt) return { ok: true };
    const cfg = preauthLimits(this.app), now = this.now();
    const addr = rc.ip ? addressKey(rc.ip) : null;
    const shared = rc.viaProxy || rc.lostClient === true;
    if (opts.hasCredential && addr && !shared && cfg.auth_failures_per_minute > 0) {
      const f = this.failures.get(addr, now);
      if (f && f.n > cfg.auth_failures_per_minute && !this.knownGood(addr, opts.credential, now))
        return { ok: false, retryAfter: this.retryAfter(f, now), scope: "failures" };
    }
    if (rc.ip) {
      const [key, limit, scope] = shared ? [`p:${rc.ip}`, cfg.proxy_per_minute, "proxy" as const] : [`a:${addr}`, cfg.per_address_per_minute, "address" as const];
      if (limit > 0) {
        const w = this.addresses.open(key, now);
        if (w.n >= limit) return { ok: false, retryAfter: this.retryAfter(w, now), scope };
        w.n++;
      }
    }
    if (cfg.global_per_minute > 0) {
      let g = this.globals.get(rc.channel);
      if (!g || now - g.start >= WINDOW_MS) { g = { start: now, n: 0 }; this.globals.set(rc.channel, g); }
      if (g.n >= cfg.global_per_minute) return { ok: false, retryAfter: this.retryAfter(g, now), scope: "global" };
      g.n++;
    }
    return { ok: true };
  }

  noteFailure(rc: Pick<RequestChannel, "ip" | "viaProxy" | "lostClient">, o: { countAddress?: boolean } = {}): { audit: boolean; throttledEvent: boolean; count: number } {
    const limit = preauthLimits(this.app).auth_failures_per_minute;
    if (!rc.ip || limit <= 0) return { audit: true, throttledEvent: false, count: 0 };
    // a shared address (a proxy's own, or a lost client's — repair) is never locked by its failures, so they
    // must not lock it for the requests that are not shared either (another name through the same socket): journal only
    const shared = rc.viaProxy || rc.lostClient === true;
    const w = (o.countAddress === false || shared ? this.quiet : this.failures).open(addressKey(rc.ip), this.now());
    w.n++;
    if (w.n <= limit) return { audit: true, throttledEvent: false, count: w.n };
    return { audit: false, throttledEvent: w.n === limit + 1, count: w.n };
  }

  noteSuccess(rc: Pick<RequestChannel, "ip" | "viaProxy" | "lostClient">, credential: string | null | undefined): void {
    if (!rc.ip || rc.viaProxy || rc.lostClient === true || !credential) return;
    const addr = addressKey(rc.ip), now = this.now();
    let prints = this.good.get(addr);
    if (prints) this.good.delete(addr);
    else prints = new Map();
    for (const [p, until] of prints) if (until <= now) prints.delete(p);
    const p = this.print(credential);
    prints.delete(p);
    prints.set(p, now + GOOD_TTL_MS);
    while (prints.size > GOOD_PER_ADDRESS) prints.delete(prints.keys().next().value!);
    this.good.set(addr, prints);
    while (this.good.size > GOOD_ADDRESSES) this.good.delete(this.good.keys().next().value!);
  }
}

const counters = new WeakMap<object, PreAuth>();
export function preauthFor(app: App): PreAuth {
  let p = counters.get(app);
  if (!p) { p = new PreAuthCounters(app); counters.set(app, p); }
  return p;
}
