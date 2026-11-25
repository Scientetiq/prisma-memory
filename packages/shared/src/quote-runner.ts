import { Worker } from "node:worker_threads";

export const QUOTE_RUNNER_LIMITS = Object.freeze({ timeout_ms: 5_000, parallel: 2, queue: 8, heap_mb: 256 });

export interface QuoteFound { kind: "exact" | "fuzzy"; ratio: number; time_from: number | null; time_to: number | null }

export class QuoteCheckTimeout extends Error {
  constructor(readonly why: "timeout" | "queue_full" | "thread_failed") {
    super(why === "timeout" ? "quote search timed out" : why === "queue_full" ? "quote search queue is full" : "quote search thread did not start");
    this.name = "QuoteCheckTimeout";
  }
}

const WORKER_URL = new URL("./quote-worker.ts", import.meta.url);
let running = 0;
const waiting: Array<() => void> = [];

function slot(deadline: number): Promise<void> {
  if (running < QUOTE_RUNNER_LIMITS.parallel) { running++; return Promise.resolve(); }
  if (waiting.length >= QUOTE_RUNNER_LIMITS.queue) return Promise.reject(new QuoteCheckTimeout("queue_full"));
  return new Promise((resolve, reject) => {
    const go = () => { clearTimeout(timer); running++; resolve(); };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      reject(new QuoteCheckTimeout("timeout"));
    }, Math.max(0, deadline - Date.now()));
    waiting.push(go);
  });
}
function release(): void {
  running--;
  const next = waiting.shift();
  if (next) next();
}

export const quoteRunnerState = (): { running: number; waiting: number } => ({ running, waiting: waiting.length });

export async function findQuoteInThread(transcript: string, quote: string, fuzzyThreshold: number, o: { timeoutMs?: number } = {}): Promise<QuoteFound | null> {
  const deadline = Date.now() + (o.timeoutMs ?? QUOTE_RUNNER_LIMITS.timeout_ms);
  await slot(deadline);
  try {
    return await new Promise<QuoteFound | null>((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(WORKER_URL, { workerData: { transcript, quote, fuzzyThreshold }, resourceLimits: { maxOldGenerationSizeMb: QUOTE_RUNNER_LIMITS.heap_mb } });
      } catch { reject(new QuoteCheckTimeout("thread_failed")); return; }
      let settled = false;
      const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); void w.terminate().catch(() => undefined); };
      const timer = setTimeout(() => done(() => reject(new QuoteCheckTimeout("timeout"))), Math.max(1, deadline - Date.now()));
      w.once("message", (m: { found?: QuoteFound | null; error?: string }) => done(() => {
        if (m && "found" in m) resolve(m.found ?? null);
        else reject(new Error(`quote search: ${m?.error ?? "unknown thread response"}`));
      }));
      w.once("error", () => done(() => reject(new QuoteCheckTimeout("thread_failed"))));
      w.once("exit", () => done(() => reject(new QuoteCheckTimeout("thread_failed"))));
    });
  } finally {
    release();
  }
}
