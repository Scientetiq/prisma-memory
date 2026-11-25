import { Worker } from "node:worker_threads";
import { log } from "./log.ts";
import type { OpenCheckFinding, OpenCheckSettings, OpenCheckText } from "./open-check.ts";

export type OpenCheckTimeoutWhy = "timeout" | "queued" | "queue_full" | "thread_unavailable";

const TIMEOUT_TEXT: Record<OpenCheckTimeoutWhy, (s: number) => string> = {
  timeout: (s) => `open check did not finish within ${s} s`,
  queued: (s) => `open check did not leave the queue within ${s} s. The check server is busy`,
  queue_full: () => "open check: the check queue is full. Request rejected without waiting",
  thread_unavailable: () => "open check: the check thread did not start. Request rejected without a check",
};

export class OpenCheckTimeout extends Error {
  readonly seconds: number;
  readonly why: OpenCheckTimeoutWhy;
  constructor(seconds: number, why: OpenCheckTimeoutWhy = "timeout") {
    super(TIMEOUT_TEXT[why](seconds));
    this.name = "OpenCheckTimeout";
    this.seconds = seconds;
    this.why = why;
  }
}

export const openCheckTimeoutUnchecked = (e: OpenCheckTimeout): "timeout" | "busy" => (e.why === "timeout" ? "timeout" : "busy");

export function openCheckTestRefusal(e: OpenCheckTimeout): { timeout: true } | { busy: true; why: Exclude<OpenCheckTimeoutWhy, "timeout"> } {
  return e.why === "timeout" ? { timeout: true } : { busy: true, why: e.why };
}

export const OPEN_CHECK_RUNNER_LIMITS = {
  short_max_chars: 256 * 1024,
  threads: { short: 1, long: 2, test: 1 },
  queue_max: { short: 64, long: 32, test: 4 },
  long_queue_max_chars: 64 * 1024 * 1024,
  long_parallel_max_chars: 48 * 1024 * 1024,
  retry_after_ms: 5_000,
  start_timeout_ms: 10_000,
  start_timeout_max_ms: 30_000,
  min_start_ms: 250,
  heap_mb: { short: 256, long: 1024, test: 256 },
  idle_release_ms: 30_000,
  long_warm: 1,
  reserve_backfill_share: 1 / 3,
  rate_min_chars: 1_000_000,
  reserve_rate_margin: 1.25,
} as const;

export type OpenCheckLane = "short" | "long" | "test";
interface Thread {
  w: Worker; lane: Lane; ready: boolean;
  job: Job | null;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
}
interface Job {
  id: number; lane: Lane; owner: string; settings: OpenCheckSettings; texts: OpenCheckText[]; force: boolean; seconds: number; chars: number;
  deadline: number;
  thread: Thread | null;
  started: boolean;
  startedAt: number;
  soft: boolean;
  timer: NodeJS.Timeout | null; done: boolean; resolve(f: OpenCheckFinding[]): void; reject(e: Error): void;
}
interface Owner { running: number; starting: number; queued: number; servedAt: number }
interface Lane {
  name: OpenCheckLane; queue: Job[]; queuedChars: number;
  threads: (Thread | null)[];
  owners: Map<string, Owner>; served: number;
  retryAt: number;
  retryTimer: NodeJS.Timeout | null;
  slowStarts: number;
  failing: boolean;
  rate: number;
  restarts: number; timeouts: number; busy: number; lastFailureAt: number; lastBusyLogAt: number;
}

const DEFAULT_TIMEOUT_SEC = 10;
const WORKER_URL = new URL("./open-check-worker.ts", import.meta.url);
const newLane = (name: OpenCheckLane): Lane => ({ name, queue: [], queuedChars: 0, threads: Array(OPEN_CHECK_RUNNER_LIMITS.threads[name]).fill(null),
                                             owners: new Map(), served: 0, retryAt: 0, retryTimer: null, slowStarts: 0, failing: false,
                                             rate: 0, restarts: 0, timeouts: 0, busy: 0, lastFailureAt: 0, lastBusyLogAt: 0 });
const lanes: Record<OpenCheckLane, Lane> = { short: newLane("short"), long: newLane("long"), test: newLane("test") };
let nextId = 1;

const errText = (e: unknown): string => {
  const x = e as { code?: unknown; message?: unknown } | null;
  return ([x?.code, x?.message].filter((v) => typeof v === "string" && v).join(": ") || String(e)).slice(0, 160);
};

function ownerOf(lane: Lane, key: string): Owner {
  let o = lane.owners.get(key);
  if (!o) lane.owners.set(key, (o = { running: 0, starting: 0, queued: 0, servedAt: lane.served - 0.5 }));
  return o;
}

function settle(j: Job, f: (j: Job) => void): void {
  if (j.done) return;
  j.done = true;
  if (j.timer) { clearTimeout(j.timer); j.timer = null; }
  const lane = j.lane, o = ownerOf(lane, j.owner);
  if (j.thread) {
    if (j.thread.job === j) j.thread.job = null;
    j.thread = null;
    if (j.started) o.running--; else o.starting--;
  } else {
    const i = lane.queue.indexOf(j);
    if (i >= 0) { lane.queue.splice(i, 1); lane.queuedChars -= j.chars; o.queued--; }
  }
  if (!o.running && !o.starting && !o.queued) lane.owners.delete(j.owner);
  f(j);
  pump(lane);
}

function requeue(j: Job): void {
  const lane = j.lane, o = ownerOf(lane, j.owner);
  if (j.thread?.job === j) j.thread.job = null;
  j.thread = null;
  if (j.started) { j.started = false; o.running--; } else o.starting--;
  o.queued++;
  lane.queue.unshift(j);
  lane.queuedChars += j.chars;
}

function failStart(lane: Lane, t: Thread | null, e: unknown): void {
  if (t) {
    const i = lane.threads.indexOf(t);
    if (i >= 0) lane.threads[i] = null;
    if (t.startTimer) { clearTimeout(t.startTimer); t.startTimer = null; }
    void t.w.terminate();
  }
  if (!lane.threads.some((x) => x?.ready)) lane.failing = true;
  lane.lastFailureAt = Date.now();
  lane.retryAt = performance.now() + OPEN_CHECK_RUNNER_LIMITS.retry_after_ms;
  log.warn("open_check_thread_unavailable", { lane: lane.name, error: errText(e), retry_after_sec: OPEN_CHECK_RUNNER_LIMITS.retry_after_ms / 1000 });
  if (lane.threads.some((x) => x)) {
    if (t?.job) requeue(t.job);
    pump(lane);
    return;
  }
  const jobs = [...(t?.job ? [t.job] : []), ...lane.queue];
  for (const j of jobs) settle(j, (x) => x.reject(new OpenCheckTimeout(x.seconds, "thread_unavailable")));
}

function lost(lane: Lane, t: Thread, e: unknown): void {
  const i = lane.threads.indexOf(t);
  if (i < 0) return;
  if (!t.ready) { failStart(lane, t, e); return; }
  lane.threads[i] = null;
  lane.restarts++;
  lane.lastFailureAt = Date.now();
  log.warn("open_check_thread_error", { lane: lane.name, error: errText(e) });
  const j = t.job;
  if (j) settle(j, (x) => x.reject(new Error(`open_check: check thread crashed (${errText(e)})`)));
  else pump(lane);
}

function send(t: Thread, j: Job): void {
  try { t.w.postMessage({ id: j.id, settings: j.settings, texts: j.texts, force: j.force }); }
  catch (e) { queueMicrotask(() => settle(j, (x) => x.reject(new Error(`open_check: could not send the job to the thread (${errText(e)})`)))); }
}

function start(t: Thread, j: Job): void {
  if (!j.started) {
    const o = ownerOf(j.lane, j.owner);
    j.started = true;
    j.startedAt = performance.now();
    o.starting--;
    o.running++;
    o.servedAt = ++j.lane.served;
  }
  send(t, j);
}

function noteRate(j: Job): void {
  const ms = performance.now() - j.startedAt;
  if (j.chars < OPEN_CHECK_RUNNER_LIMITS.rate_min_chars || !(ms > 0)) return;
  const lane = j.lane, r = j.chars / ms;
  lane.rate = lane.rate ? (lane.rate + r) / 2 : r;
}

function spawn(lane: Lane, slot: number): Thread | null {
  let w: Worker;
  try { w = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: OPEN_CHECK_RUNNER_LIMITS.heap_mb[lane.name] } }); }
  catch (e) { failStart(lane, null, e); return null; }
  const t: Thread = { w, lane, ready: false, job: null, startTimer: null, idleTimer: null };
  lane.threads[slot] = t;
  const L = OPEN_CHECK_RUNNER_LIMITS;
  const ms = Math.min(L.start_timeout_ms * 2 ** lane.slowStarts, Math.max(L.start_timeout_ms, L.start_timeout_max_ms));
  t.startTimer = setTimeout(() => {
    t.startTimer = null;
    if (!t.ready && lane.threads.includes(t)) {
      lane.slowStarts = Math.min(lane.slowStarts + 1, 8);
      failStart(lane, t, new Error(`thread did not report “ready” within ${ms / 1000} s`));
    }
  }, ms);
  t.startTimer.unref();
  w.unref();
  w.on("message", (m: { ready?: unknown; id?: unknown; findings?: unknown; error?: unknown } | null) => {
    if (!lane.threads.includes(t)) return;
    if (m?.ready === true) {
      if (t.ready) return;
      t.ready = true;
      if (t.startTimer) { clearTimeout(t.startTimer); t.startTimer = null; }
      lane.failing = false;
      lane.retryAt = 0;
      lane.slowStarts = 0;
      if (t.job) start(t, t.job);
      pump(lane);
      return;
    }
    const j = t.job;
    if (!j || m?.id !== j.id) return;
    if (Array.isArray(m.findings)) { const f = m.findings as OpenCheckFinding[]; noteRate(j); settle(j, (x) => x.resolve(f)); return; }
    const why = typeof m.error === "string" && m.error ? m.error : "thread response did not include a list of findings";
    settle(j, (x) => x.reject(new Error(`open_check: ${why}`)));
  });
  w.on("messageerror", (e) => {
    const j = t.job;
    if (lane.threads.includes(t) && t.ready && j) settle(j, (x) => x.reject(new Error(`open_check: could not read the thread response (${errText(e)})`)));
  });
  w.on("error", (e) => lost(lane, t, e));
  w.on("exit", (code) => lost(lane, t, new Error(`thread exited with code ${code}`)));
  return t;
}

const fits = (lane: Lane, j: Job, busy: number): boolean =>
  lane.name !== "long" || busy === 0 || busy + j.chars <= OPEN_CHECK_RUNNER_LIMITS.long_parallel_max_chars;

function pick(lane: Lane, ok: (j: Job) => boolean = () => true): Job | null {
  const first = (can: (j: Job) => boolean): Job | null => {
    let best: Job | null = null, bo: Owner | null = null;
    for (const j of lane.queue) {
      if (!can(j)) continue;
      const o = ownerOf(lane, j.owner);
      if (!bo || o.running < bo.running || (o.running === bo.running && o.servedAt < bo.servedAt)) { best = j; bo = o; }
    }
    return best;
  };
  const r = first(ok);
  if (!r || lane.name !== "long") return r;
  const busy = lane.threads.reduce((n, t) => n + (t?.job ? t.job.chars : 0), 0);
  if (fits(lane, r, busy)) { r.soft = false; return r; }
  const L = OPEN_CHECK_RUNNER_LIMITS, max = L.long_parallel_max_chars, now = performance.now(), ro = ownerOf(lane, r.owner);
  const soft = now - (r.deadline - r.seconds * 1000) < r.seconds * 1000 * L.reserve_backfill_share && !lane.threads.some((t) => t?.job?.soft);
  const peer = (j: Job) => j.owner !== r.owner && ownerOf(lane, j.owner).running <= ro.running;
  const inTime = (j: Job) => !lane.rate || now + L.reserve_rate_margin * (j.chars + r.chars) / lane.rate <= r.deadline;
  const j = first((x) => x !== r && ok(x) && fits(lane, x, busy) && (x.chars + r.chars <= max || (soft && peer(x) && inTime(x))));
  if (j) j.soft = j.chars + r.chars > max;
  return j;
}

function occupy(t: Thread, j: Job): void {
  t.job = j;
  j.thread = t;
  if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
  t.w.ref();
  if (t.ready) start(t, j);
}

function assign(t: Thread, j: Job): void {
  const lane = t.lane, o = ownerOf(lane, j.owner);
  lane.queue.splice(lane.queue.indexOf(j), 1);
  lane.queuedChars -= j.chars;
  o.queued--;
  o.starting++;
  occupy(t, j);
}

function pump(lane: Lane): void {
  for (const t of lane.threads) {
    if (!t?.ready || t.job) continue;
    const from = lane.threads.find((x) => x && !x.ready && x.job);
    if (from) { const k = from.job!; from.job = null; occupy(t, k); continue; }
    const j = pick(lane);
    if (j) assign(t, j);
  }
  for (const t of lane.threads) {
    if (!t || t.ready || t.job) continue;
    const j = pick(lane);
    if (j) assign(t, j);
  }
  const now = performance.now();
  for (let i = 0; i < lane.threads.length && lane.queue.length; i++) {
    if (lane.threads[i]) continue;
    if (now < lane.retryAt) { wakeAfterRetry(lane, now); break; }
    const j = pick(lane, (x) => x.deadline - now >= OPEN_CHECK_RUNNER_LIMITS.min_start_ms);
    if (!j) break;
    const t = spawn(lane, i);
    if (!t) return;
    assign(t, j);
  }
  for (const t of lane.threads) if (t && !t.job) { t.w.unref(); if (lane.name === "long" && t.ready && !t.idleTimer) idle(t); }
}

function wakeAfterRetry(lane: Lane, now: number): void {
  if (lane.retryTimer) return;
  lane.retryTimer = setTimeout(() => { lane.retryTimer = null; pump(lane); }, Math.max(1, Math.ceil(lane.retryAt - now)));
  lane.retryTimer.unref();
}

function idle(t: Thread): void {
  t.idleTimer = setTimeout(() => {
    t.idleTimer = null;
    const lane = t.lane, i = lane.threads.indexOf(t);
    if (i < 0 || t.job) return;
    if (lane.threads.filter((x) => x && x !== t && x.ready).length < OPEN_CHECK_RUNNER_LIMITS.long_warm) return;
    lane.threads[i] = null;
    void t.w.terminate();
  }, OPEN_CHECK_RUNNER_LIMITS.idle_release_ms);
  t.idleTimer.unref();
}

function expire(j: Job): void {
  const lane = j.lane, t = j.thread;
  lane.timeouts++;
  if (t?.ready) {
    const i = lane.threads.indexOf(t);
    if (i >= 0) lane.threads[i] = null;
    lane.restarts++;
    void t.w.terminate();
    settle(j, (x) => x.reject(new OpenCheckTimeout(x.seconds, "timeout")));
  } else settle(j, (x) => x.reject(new OpenCheckTimeout(x.seconds, "queued")));
}

function noteBusy(lane: Lane): void {
  lane.busy++;
  const now = Date.now();
  if (now - lane.lastBusyLogAt >= 10_000) {
    lane.lastBusyLogAt = now;
    log.warn("open_check_queue_full", { lane: lane.name, queued: lane.queue.length, queued_chars: lane.queuedChars, refused_total: lane.busy });
  }
}

function victimsFor(lane: Lane, key: string, chars: number): Job[] | null {
  const L = OPEN_CHECK_RUNNER_LIMITS, victims: Job[] = [];
  let n = lane.queue.length, qc = lane.queuedChars;
  const over = () => n >= L.queue_max[lane.name] || (lane.name === "long" && n > 0 && qc + chars > L.long_queue_max_chars);
  if (!over()) return victims;
  const me = lane.owners.get(key), mine = me ? me.running + me.starting + me.queued : 0;
  const taken = new Map<string, number>();
  while (over()) {
    let top: string | null = null, topLoad = -1;
    for (const [k, o] of lane.owners) {
      const left = o.queued - (taken.get(k) ?? 0);
      if (k === key || left <= 0) continue;
      if (o.running + o.starting + left > topLoad) { top = k; topLoad = o.running + o.starting + left; }
    }
    if (top === null || mine + 2 > topLoad) return null;
    let v: Job | null = null;
    for (let i = lane.queue.length - 1; i >= 0 && !v; i--) { const j = lane.queue[i]!; if (j.owner === top && !victims.includes(j)) v = j; }
    if (!v) return null;
    victims.push(v);
    taken.set(top, (taken.get(top) ?? 0) + 1);
    n--;
    qc -= v.chars;
  }
  return victims;
}

export function runOpenCheck(settings: OpenCheckSettings, texts: OpenCheckText[], opts: { force?: boolean; owner?: string } = {}): Promise<OpenCheckFinding[]> {
  if (!settings.enabled && !opts.force) return Promise.resolve([]);
  const nonEmpty = texts.filter((t) => typeof t.value === "string" && t.value.trim());
  if (!nonEmpty.length) return Promise.resolve([]);
  const raw = Number((settings as { timeout_sec?: unknown }).timeout_sec);
  const seconds = Number.isFinite(raw) && raw >= 1 && raw <= 120 ? raw : DEFAULT_TIMEOUT_SEC;
  const chars = nonEmpty.reduce((n, t) => n + (t.value as string).length, 0);
  const lane = lanes[chars > OPEN_CHECK_RUNNER_LIMITS.short_max_chars ? "long" : opts.force === true ? "test" : "short"];
  const owner = typeof opts.owner === "string" ? opts.owner : "";
  if (performance.now() < lane.retryAt && !lane.threads.some((t) => t)) return Promise.reject(new OpenCheckTimeout(seconds, "thread_unavailable"));
  const victims = victimsFor(lane, owner, chars);
  if (!victims) { noteBusy(lane); return Promise.reject(new OpenCheckTimeout(seconds, "queue_full")); }
  for (const v of victims) { noteBusy(lane); settle(v, (x) => x.reject(new OpenCheckTimeout(x.seconds, "queue_full"))); }
  return new Promise((resolve, reject) => {
    const j: Job = { id: nextId++, lane, owner, settings, texts: nonEmpty, force: opts.force === true, seconds, chars,
                     deadline: performance.now() + seconds * 1000, thread: null, started: false, startedAt: 0, soft: false, timer: null, done: false, resolve, reject };
    j.timer = setTimeout(() => expire(j), seconds * 1000);
    lane.queue.push(j);
    lane.queuedChars += chars;
    ownerOf(lane, owner).queued++;
    pump(lane);
  });
}

export interface OpenCheckLaneState {
  threads: number;
  up: number;
  running: number;
  queued: number;
  failing: boolean;
  retry_in_ms: number;
  restarts: number;
  timeouts: number;
  busy: number;
  last_failure_at: string | null;
}
export interface OpenCheckRunnerState {
  ok: boolean;
  lanes: Record<OpenCheckLane, OpenCheckLaneState>;
  last_failure_at: string | null;
}

const iso = (ms: number): string | null => (ms ? new Date(ms).toISOString() : null);
const laneFailing = (l: Lane): boolean => l.failing && !l.threads.some((t) => t?.ready);
const laneState = (l: Lane): OpenCheckLaneState => ({
  threads: l.threads.length, up: l.threads.filter((t) => t?.ready).length, running: l.threads.filter((t) => t?.job).length,
  queued: l.queue.length, failing: laneFailing(l), retry_in_ms: Math.max(0, Math.ceil(l.retryAt - performance.now())),
  restarts: l.restarts, timeouts: l.timeouts, busy: l.busy, last_failure_at: iso(l.lastFailureAt),
});

export function openCheckRunnerState(): OpenCheckRunnerState {
  const all = Object.values(lanes);
  return {
    ok: !laneFailing(lanes.short) && !laneFailing(lanes.long),
    lanes: { short: laneState(lanes.short), long: laneState(lanes.long), test: laneState(lanes.test) },
    last_failure_at: iso(Math.max(...all.map((l) => l.lastFailureAt))),
  };
}

export function openCheckHealth(s: OpenCheckRunnerState): { ok: boolean; detail: string } {
  const main = (["short", "long"] as const).filter((n) => s.lanes[n].failing);
  const paused = main.filter((n) => s.lanes[n].retry_in_ms > 0), retry = main.filter((n) => s.lanes[n].retry_in_ms === 0);
  const at = (ns: readonly OpenCheckLane[]) => ns.map((n) => `${n} — last failure ${s.lanes[n].last_failure_at}`).join(", ");
  if (main.length) {
    const parts: string[] = [];
    if (paused.length) {
      const sec = Math.ceil(Math.max(...paused.map((n) => s.lanes[n].retry_in_ms)) / 1000);
      parts.push(`open check thread could not start (lanes: ${at(paused)}). Writes to the open class are refused with “check server is busy”. The next write will retry the startup after ${sec} s. Closed writes, reads and search still work`);
    }
    if (retry.length) parts.push(`the check thread failed to start last time. The next write will try again (lanes: ${at(retry)})`);
    return { ok: false, detail: parts.join("; ") };
  }
  const lanesAll = Object.entries(s.lanes);
  const test = s.lanes.test.failing ? "; “Test text” in the admin panel: the thread failed to start last time. The next check will try again (records are unaffected)" : "";
  return { ok: true, detail: `threads running: ${lanesAll.map(([n, l]) => `${n} ${l.up}/${l.threads}`).join(", ")}; queue full: ${lanesAll.reduce((x, [, l]) => x + l.busy, 0)} refused, ${lanesAll.reduce((x, [, l]) => x + l.timeouts, 0)} timed out (since startup)${test}` };
}
