import { commitOrThrow } from "./db.ts";   // a COMMIT answered with ROLLBACK is an error
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import type { Env } from "./db.ts";
import { pgTls } from "./pg-tls.ts";
import { passwordFor } from "./secrets.ts";
import { log } from "./log.ts";
import { PlatformError } from "./platform-error.ts";
import { breakerAfter, emptyBreaker, ensureGateRows, evalPermission, LLM_GATE_DEFAULTS, leaseLive, activeHolds, readGateState, readProcessingSetting,
         type BreakerState, type GateBlock, type GateTiming, type OutcomeKind } from "./llm-state.ts";

export type { CallKind, GateBlock } from "./llm-state.ts";
export const LLM_LOCK_NS = 0x6d656d6c;       // «meml», int4 > 0
export const LLM_LOCK_KEY = 0;

export interface SlotMeta { purpose: string; stage?: string; lane?: string; record_id?: string }

export interface LlmSlot {
  readonly held: boolean;
  readonly signal: AbortSignal;
  readonly owner: string;
  beforeCall(info: { maxTokens: number }): Promise<void>;
  afterCall(kind: OutcomeKind, o?: { tail?: boolean; minPauseMs?: number }): Promise<void>;
  annotate?(meta: Omit<SlotMeta, "purpose">): Promise<void>;
}

export interface BreakerChange { from: BreakerState["reason"]; to: BreakerState["reason"]; until: string | null; streak: number; kind: OutcomeKind }

export interface LlmGateOptions {
  instanceId: string;
  connect: (applicationName: string) => pg.Client;
  settings: { get<T>(path: string, fallback: T): T };
  requireFloor: boolean;
  stub: boolean;
  /** Built-in synthetic candidate probes only: the saved model's breaker must not prevent testing a fix.
   * Holds, the floor, dirty tails and the advisory lock still apply. Defaults to false. */
  bypassBreaker?: boolean;
  purpose: string;
  now?: () => Date;
  onBreakerChange?: (e: BreakerChange) => void;
  pingMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAME_MAX = 63;

export function gateBlockText(b: GateBlock): string {
  const t = b.until ? ` until ${b.until.toISOString().slice(11, 19)} UTC` : "";
  switch (b.kind) {
    case "hold": return `model requests are paused${t}`;
    case "floor": return "the check queue has not granted permission (it is not our turn)";
    case "breaker": return `the model is busy — paused${t}`;
    case "dirty": return `the model may still be processing an interrupted request — waiting${t}`;
    default: return "a request to the model is already in progress";
  }
}

export class LlmGate {
  private client: pg.Client | null = null;
  private appName = "";
  private dead = true;
  private acquired = false;
  private current: { slot: LlmSlot; ctl: AbortController; released: boolean } | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private cache: { at: number; block: GateBlock | null } | null = null;
  private readonly now: () => Date;

  constructor(private readonly o: LlmGateOptions) { this.now = o.now ?? (() => new Date()); }

  private timing(): GateTiming {
    return { timeoutSec: Number(this.o.settings.get("models.timeout_sec", 300)),
             afterAbortHoldSec: Number(this.o.settings.get("processing.llm_gate", LLM_GATE_DEFAULTS).after_abort_hold_sec ?? LLM_GATE_DEFAULTS.after_abort_hold_sec) };
  }

  private async conn(): Promise<pg.Client> {
    if (this.client && !this.dead) return this.client;
    const name = `memory-llm:${this.o.instanceId}:${this.o.purpose}:${hostname().slice(0, 16)}:${process.pid}:${randomBytes(3).toString("hex")}`.slice(0, NAME_MAX);
    const c = this.o.connect(name);
    const lost = (why: string) => {
      if (c !== this.client) return;
      this.dead = true;
      if (this.current && !this.current.released) {
        log.warn("llm_gate_lost", { why });
        this.current.ctl.abort(new PlatformError("gate_lost", "the model lock connection was lost. The stage will resume later"));
      }
    };
    c.on("error", (e: Error) => lost(e.message.slice(0, 120)));
    c.on("end", () => lost("end"));
    await c.connect();
    this.client = c; this.appName = name; this.dead = false;
    return c;
  }

  private drop(): void {
    const c = this.client;
    this.dead = true; this.client = null;
    if (c) void c.end().catch(() => undefined);
  }

  async init(): Promise<void> { await ensureGateRows(await this.conn(), this.o.instanceId); }

  async precheck(): Promise<GateBlock | null> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < 2000) return this.cache.block;
    const st = await readGateState(await this.conn(), this.o.instanceId);
    const block = evalPermission(st, st.dbNow, { requireFloor: this.o.requireFloor, stub: this.o.stub, bypassBreaker: this.o.bypassBreaker }, this.timing());
    this.cache = { at: t, block };
    return block;
  }

  async tryAcquire(meta: SlotMeta): Promise<{ slot: LlmSlot } | { blocked: GateBlock }> {
    if (this.acquired) return { blocked: { kind: "slot_busy", until: null } };
    this.acquired = true;
    let c: pg.Client;
    try {
      c = await this.conn();
      const got = (await c.query("SELECT pg_try_advisory_lock($1::int, $2::int) AS ok", [LLM_LOCK_NS, LLM_LOCK_KEY])).rows[0].ok === true;
      if (!got) { this.acquired = false; log.debug("llm_slot_blocked", { kind: "slot_busy" }); return { blocked: { kind: "slot_busy", until: null } }; }
    } catch (e) { this.acquired = false; this.drop(); throw e; }
    try {
      const st = await readGateState(c, this.o.instanceId);
      const block = evalPermission(st, st.dbNow, { requireFloor: this.o.requireFloor, stub: this.o.stub, bypassBreaker: this.o.bypassBreaker }, this.timing());
      if (block) {
        await c.query("SELECT pg_advisory_unlock($1::int, $2::int)", [LLM_LOCK_NS, LLM_LOCK_KEY]);
        this.acquired = false;
        this.cache = { at: this.now().getTime(), block };
        log.debug("llm_slot_blocked", { kind: block.kind, until: block.until?.toISOString() ?? null });
        return { blocked: block };
      }
      await c.query(
        `INSERT INTO maintenance_state (instance_id, key, value) VALUES ($1, 'llm_slot', jsonb_build_object('owner', $2::text, 'pid', $3::int, 'purpose', $4::text,
                'stage', $5::text, 'lane', $6::text, 'record_id', $7::text, 'acquired_at', now(), 'call_started_at', NULL, 'released_at', NULL, 'dirty_until', NULL))
         ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [this.o.instanceId, this.appName, process.pid, meta.purpose, meta.stage ?? null, meta.lane ?? null, meta.record_id ?? null]);
    } catch (e) {
      await c.query("SELECT pg_advisory_unlock($1::int, $2::int)", [LLM_LOCK_NS, LLM_LOCK_KEY]).catch(() => this.drop());
      this.acquired = false;
      throw e;
    }
    const ctl = new AbortController();
    const entry: { slot: LlmSlot; ctl: AbortController; released: boolean } = { slot: null as unknown as LlmSlot, ctl, released: false };
    entry.slot = this.makeSlot(entry, this.appName, meta.record_id ?? null);
    this.current = entry;
    this.cache = null;
    const pingMs = this.o.pingMs ?? 15_000;
    this.ping = setInterval(() => {
      if (this.dead || !this.client) return;
      const cl = this.client;
      const timer = new Promise((_r, rej) => setTimeout(() => rej(new Error("the lock connection did not respond to a ping within 5 s")), 5000));
      void Promise.race([cl.query("SELECT 1"), timer]).catch((e: Error) => {
        if (cl !== this.client) return;
        this.dead = true;
        if (this.current && !this.current.released) { log.warn("llm_gate_lost", { why: e.message.slice(0, 120) }); this.current.ctl.abort(new PlatformError("gate_lost", "the model lock connection was lost. The stage will resume later")); }
        this.drop();
      });
    }, pingMs);
    log.debug("llm_slot_acquired", { purpose: meta.purpose, stage: meta.stage ?? null, lane: meta.lane ?? null });
    return { slot: entry.slot };
  }

  private makeSlot(entry: { ctl: AbortController; released: boolean }, owner: string, initialRecord: string | null): LlmSlot {
    const gate = this;
    const started = Date.now();
    let callStarted = false;
    let recordId = initialRecord;
    const slot: LlmSlot & { heldMs: () => number } = {
      get held() { return !entry.released; },
      signal: entry.ctl.signal,
      owner,
      heldMs: () => Date.now() - started,
      async beforeCall({ maxTokens }) {
        if (entry.ctl.signal.aborted) throw entry.ctl.signal.reason;
        if (entry.released) throw new PlatformError("gate", "the model slot has already been released");
        const c = gate.client;
        if (!c || gate.dead || gate.appName !== owner) throw new PlatformError("gate_lost", "the model lock connection was lost. The stage will resume later");
        if (gate.o.requireFloor && !gate.o.stub) {
          const st = await readGateState(c, gate.o.instanceId);
          if (activeHolds(st.holds, st.dbNow).length || !leaseLive(st.lease, st.dbNow))
            throw new PlatformError("aborted", "permission to use the model was revoked. The stage will resume later");
        }
        const r = await c.query(
          `UPDATE maintenance_state SET value = value || jsonb_build_object('call_started_at', now(), 'max_tokens', $3::int), updated_at = now()
            WHERE instance_id = $1 AND key = 'llm_slot' AND value->>'owner' = $2 RETURNING 1`, [gate.o.instanceId, owner, Math.max(0, Math.floor(maxTokens))]);
        if (!r.rowCount) throw new PlatformError("gate_lost", "another process holds the model slot. The stage will resume later");
        callStarted = true;
      },
      async afterCall(kind, x) {
        const c = gate.client;
        if (!c || gate.dead || gate.appName !== owner) return;
        let change: BreakerChange | null = null;
        try {
          await c.query("BEGIN");
          const cfg = await readProcessingSetting(c, gate.o.instanceId, "llm_gate", LLM_GATE_DEFAULTS);
          await c.query(
            `UPDATE maintenance_state SET value = value || CASE WHEN $3::boolean
                   THEN jsonb_build_object('dirty_until', now() + make_interval(secs => $4::int), 'call_started_at', NULL)
                   ELSE jsonb_build_object('call_started_at', NULL) END, updated_at = now()
              WHERE instance_id = $1 AND key = 'llm_slot' AND value->>'owner' = $2`, [gate.o.instanceId, owner, x?.tail === true && callStarted, cfg.after_abort_hold_sec]);
          if (kind !== "aborted" && kind !== "error" && kind !== "blocked") {
            const r = (await c.query("SELECT value, now() AS db_now FROM maintenance_state WHERE instance_id = $1 AND key = 'llm_breaker' FOR UPDATE", [gate.o.instanceId])).rows[0];
            const prev: BreakerState = { ...emptyBreaker(), ...(r?.value ?? {}) };
            const next = breakerAfter(kind, prev, cfg, new Date(r?.db_now ?? Date.now()), recordId, { minPauseMs: x?.minPauseMs });
            await c.query("UPDATE maintenance_state SET value = $2::jsonb, updated_at = now() WHERE instance_id = $1 AND key = 'llm_breaker'", [gate.o.instanceId, JSON.stringify(next)]);
            if (prev.reason !== next.reason && (prev.reason === null || next.reason === null))
              change = { from: prev.reason, to: next.reason, until: next.open_until, streak: next.reason === "slow" ? next.slow_streak : next.busy_streak, kind };
          }
          await commitOrThrow(c);
          callStarted = false;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => undefined);
          log.warn("llm_slot_after_call_failed", { error: (e as Error).message.slice(0, 160) });
          return;
        }
        if (change) {
          if (change.to) log.warn("llm_breaker_opened", { reason: change.to, until: change.until, streak: change.streak });
          else log.info("llm_breaker_closed", { was: change.from });
          try { gate.o.onBreakerChange?.(change); } catch { }
        }
      },
      async annotate(meta) {
        recordId = meta.record_id ?? null;
        const c = gate.client;
        if (!c || gate.dead || gate.appName !== owner) return;
        await c.query(
          `UPDATE maintenance_state SET value = value || jsonb_build_object('stage', $3::text, 'lane', $4::text, 'record_id', $5::text), updated_at = now()
            WHERE instance_id = $1 AND key = 'llm_slot' AND value->>'owner' = $2`, [gate.o.instanceId, owner, meta.stage ?? null, meta.lane ?? null, meta.record_id ?? null]).catch(() => undefined);
      },
    };
    return slot;
  }

  abort(reason: PlatformError = new PlatformError("aborted", "interrupted by a restart. Resuming now")): void {
    if (this.current && !this.current.released) this.current.ctl.abort(reason);
  }

  get holding(): boolean { return this.acquired; }

  async release(slot: LlmSlot): Promise<void> {
    const cur = this.current;
    if (!cur || cur.slot !== slot || cur.released) return;
    cur.released = true;
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
    const c = this.client;
    try {
      if (c && !this.dead) {
        await c.query(`UPDATE maintenance_state SET value = value || jsonb_build_object('released_at', now()), updated_at = now()
                        WHERE instance_id = $1 AND key = 'llm_slot' AND value->>'owner' = $2`, [this.o.instanceId, slot.owner]);
        await c.query("SELECT pg_advisory_unlock($1::int, $2::int)", [LLM_LOCK_NS, LLM_LOCK_KEY]);
      }
    } catch (e) {
      log.warn("llm_slot_release_failed", { error: (e as Error).message.slice(0, 160) });
      this.drop();
    } finally {
      log.info("llm_slot_released", { held_ms: (slot as LlmSlot & { heldMs?: () => number }).heldMs?.() ?? null });
      this.current = null;
      this.acquired = false;
    }
  }

  async run<T>(meta: SlotMeta, fn: (slot: LlmSlot) => Promise<T>, o: { waitMaxMs?: number; onWait?: (b: GateBlock) => void } = {}): Promise<T> {
    const started = Date.now();
    for (;;) {
      const r = await this.tryAcquire(meta);
      if ("slot" in r) {
        try { return await fn(r.slot); } finally { await this.release(r.slot); }
      }
      o.onWait?.(r.blocked);
      if (o.waitMaxMs !== undefined && Date.now() - started >= o.waitMaxMs) throw new PlatformError("gate", `the model was still busy after ${Math.round(o.waitMaxMs / 1000)} s: ${gateBlockText(r.blocked)}`);
      const until = r.blocked.until ? r.blocked.until.getTime() - this.now().getTime() : 0;
      const base = r.blocked.kind === "slot_busy" ? 200 : Math.max(50, Math.min(5000, until > 0 ? until : 1000));
      await sleep(Math.round(base * (0.8 + Math.random() * 0.4)));
    }
  }

  async close(): Promise<void> {
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
    const c = this.client;
    this.client = null; this.dead = true;
    if (c) await c.end().catch(() => undefined);
  }
}

export function gateConnect(env: Pick<Env, "pgHost" | "pgPort" | "appSecret" | "pgAppPassword">): (applicationName: string) => pg.Client {
  return (applicationName) => {
    const client = new pg.Client({ host: env.pgHost, port: env.pgPort, database: "memory_control", user: "memory_worker",
      password: passwordFor(env, "memory_worker"), application_name: applicationName, keepAlive: true, ssl: (env as Partial<Env>).pgTls ?? pgTls() });
    let reported = false;
    client.on("error", (e) => {
      if (reported) return;
      reported = true;
      log.warn("pg_client_error", { database: "memory_control", application: applicationName, sqlstate: (e as { code?: string }).code ?? null });
    });
    return client;
  };
}

export function waitReporter(print: (line: string) => void, everyMs = 30_000): (b: GateBlock) => void {
  let last = 0;
  return (b) => { const t = Date.now(); if (t - last >= everyMs) { last = t; print(`waiting for the model: ${gateBlockText(b)}`); } };
}
