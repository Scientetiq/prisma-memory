const WINDOW_MS = 15 * 60_000;
export const IN_FLIGHT_RETRY_SEC = 5;
export const ADDRESS_IN_FLIGHT_MAX = 50;
export const HISTORY_MAX = 100;

export type WindowCount = "window" | "run";
export type WindowLimit = readonly [key: string, limit: number, inFlightCap?: number, count?: WindowCount];
export type WindowRefusal = { wait: number; inFlight: false } | { wait: number; inFlight: true; key: string };

export class FailureWindow {
  private readonly hits = new Map<string, number[]>();
  private readonly pending = new Map<string, number>();
  private swept = 0;
  private readonly retainMs: number;
  constructor(private readonly windowMs = WINDOW_MS, retainMs = windowMs) { this.retainMs = Math.max(retainMs, windowMs); }
  private kept(key: string, now: number): readonly number[] {
    const xs = this.hits.get(key);
    if (!xs) return [];
    if (now - xs[xs.length - 1]! > this.retainMs) { this.hits.delete(key); return []; }
    return xs;
  }
  private live(key: string, now: number, windowMs: number, count: WindowCount = "window"): readonly number[] {
    const xs = this.kept(key, now);
    if (count === "window") return xs.filter((t) => now - t < windowMs);
    let i = xs.length;
    if (!i || now - xs[i - 1]! > windowMs) return [];
    while (i > 1 && xs[i - 1]! - xs[i - 2]! <= windowMs) i--;
    return xs.slice(i - 1);
  }
  private span(windowMs: number): number { return Math.min(Math.max(windowMs, 0), this.retainMs); }
  retryAfter(limits: readonly WindowLimit[], now = Date.now(), windowMs = this.windowMs): number {
    const w = this.span(windowMs);
    let wait = 0;
    for (const [key, limit, , count] of limits) {
      const xs = this.live(key, now, w, count);
      if (!(limit > 0 && xs.length >= limit)) continue;
      const left = count === "run" ? xs[xs.length - 1]! + w - now : xs[xs.length - limit]! + w - now;
      wait = Math.max(wait, count === "run" ? Math.floor(left / 1000) + 1 : Math.ceil(left / 1000));
    }
    return wait;
  }
  reserve(limits: readonly WindowLimit[], now = Date.now(), windowMs = this.windowMs): WindowRefusal | { release: () => void } {
    const w = this.span(windowMs);
    const wait = this.retryAfter(limits, now, w);
    if (wait > 0) return { wait, inFlight: false };
    const busy = limits.find(([key, limit, cap, count]) => limit > 0 && this.live(key, now, w, count).length + (this.pending.get(key) ?? 0) >= Math.max(limit, cap ?? limit));
    if (busy) return { wait: IN_FLIGHT_RETRY_SEC, inFlight: true, key: busy[0] };
    const keys = limits.map(([key]) => key);
    for (const k of keys) this.pending.set(k, (this.pending.get(k) ?? 0) + 1);
    let done = false;
    return { release: () => {
      if (done) return;
      done = true;
      for (const k of keys) { const n = (this.pending.get(k) ?? 1) - 1; if (n > 0) this.pending.set(k, n); else this.pending.delete(k); }
    } };
  }
  record(keys: string[], now = Date.now()): void {
    if (this.hits.size > 50_000 && now - this.swept > 10_000) { this.swept = now; for (const k of [...this.hits.keys()]) this.kept(k, now); }
    for (const k of keys) this.hits.set(k, [...this.kept(k, now), now].sort((a, b) => a - b).slice(-HISTORY_MAX));
  }
  snapshot(prefix: string, now = Date.now()): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const k of [...this.hits.keys()]) {
      if (!k.startsWith(prefix)) continue;
      const xs = this.kept(k, now);
      if (xs.length) out[k] = [...xs];
    }
    return out;
  }
  restore(entries: Readonly<Record<string, readonly number[]>>, now = Date.now()): number {
    let n = 0;
    for (const [k, raw] of Object.entries(entries)) {
      const xs = raw.filter((t) => Number.isFinite(t)).map((t) => Math.min(t, now));
      if (!xs.length || now - Math.max(...xs) > this.retainMs) continue;
      this.hits.set(k, [...this.kept(k, now), ...xs].sort((a, b) => a - b).slice(-HISTORY_MAX));
      n++;
    }
    return n;
  }
  get size(): number { return this.hits.size; }
  inFlight(key: string): number { return this.pending.get(key) ?? 0; }
  clear(keys: string[]): void { for (const k of keys) this.hits.delete(k); }
}
