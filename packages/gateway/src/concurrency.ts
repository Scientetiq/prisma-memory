// Limits of concurrent heavy work in the gateway process: there is one gateway, the counters are in memory.

/**
 * Slots without a queue: an overall ceiling and one per key (an original download counts for the key given the link). No
 * slot means an immediate refusal: the answer decides who hit the limit ("total" or "key"). Release happens exactly once.
 */
export class Slots {
  private total = 0;
  private readonly per = new Map<string, number>();
  constructor(readonly max: number, readonly perKey: number) {}

  take(key: string | null): { release: () => void } | "total" | "key" {
    if (this.total >= this.max) return "total";
    const k = key ?? "";
    const n = this.per.get(k) ?? 0;
    if (key !== null && n >= this.perKey) return "key";
    this.total += 1; this.per.set(k, n + 1);
    let done = false;
    return { release: () => {
      if (done) return;
      done = true; this.total -= 1;
      const left = (this.per.get(k) ?? 1) - 1;
      if (left > 0) this.per.set(k, left); else this.per.delete(k);
    } };
  }

  get busy(): number { return this.total; }
}

/** The queue is full: the caller answers busy, retry. */
export class QueueFull extends Error { constructor() { super("queue full"); } }

/** A semaphore with a short queue: at most max jobs at once, at most maxWaiting waiting, beyond that QueueFull. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly max: number, readonly maxWaiting: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxWaiting) throw new QueueFull();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active += 1;
    try { return await fn(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active -= 1;          // the slot passes to a waiter without being released
    }
  }

  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }
}
