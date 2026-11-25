import { auditShipTargetProblems, LockConnectionLost, log, newId, raiseAlert, tx, watchLock } from "@memory/shared";
import type pg from "pg";
import { auditWorker, type DbCtx } from "../ctx.ts";
import { chainLines, ZERO_HASH, type ShipEvent, type ShipLine } from "../audit-ship/line.ts";
import { AT_TEXT, pendingAgeSec, readAfter, type ShipCursor } from "../audit-ship/reader.ts";
import { fileSink } from "../audit-ship/file-sink.ts";
import { syslogTlsSink, type SyslogTarget } from "../audit-ship/syslog-tls-sink.ts";
import { ShipSinkError, type ShipSink, type ShipSinkKind } from "../audit-ship/sink.ts";

export const SHIP_FAILED_ALERT_MIN = 30;
export const SHIP_LAG_ALERT_SEC = 600;
export const SHIP_MAX_BATCHES = 20;
export const SHIP_BACKOFF_MAX_MS = 300_000;

const clamp = (v: unknown, min: number, max: number, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

export type ShipConfig =
  | { mode: "off" }
  | { mode: ShipSinkKind; problem: "target_invalid"; detail: string }
  | { mode: ShipSinkKind; problem?: undefined; target: { file_dir: string } | SyslogTarget; batch: number; intervalSec: number; lagSec: number };

export function shipConfig(s: DbCtx["settings"]): ShipConfig {
  const m = s.get<unknown>("observability.audit_ship_mode", "off");
  if (m !== "file" && m !== "syslog_tls") return { mode: "off" };
  const target = s.get<unknown>("observability.audit_ship_target", {});
  const problems = auditShipTargetProblems(target);
  const t = (target ?? {}) as Record<string, unknown>;
  if (problems.length) return { mode: m, problem: "target_invalid", detail: problems.join("; ") };
  if (m === "file" && typeof t.file_dir !== "string") return { mode: m, problem: "target_invalid", detail: "file mode requires file_dir" };
  if (m === "syslog_tls" && (typeof t.host !== "string" || typeof t.port !== "number")) return { mode: m, problem: "target_invalid", detail: "syslog_tls mode requires host and port" };
  if (m === "syslog_tls" && (typeof t.ca_cert !== "string" || !t.ca_cert.includes("BEGIN CERTIFICATE")))
    return { mode: m, problem: "target_invalid", detail: "syslog_tls mode requires the receiver’s ca_cert (PEM). It does not use the default CA list" };
  return {
    mode: m, target: m === "file" ? { file_dir: t.file_dir as string } : (t as unknown as SyslogTarget),
    batch: clamp(s.get("observability.audit_ship_batch", 500), 50, 5000, 500),
    intervalSec: clamp(s.get("observability.audit_ship_interval_sec", 10), 5, 300, 10),
    lagSec: clamp(s.get("observability.audit_ship_lag_sec", 120), 30, 900, 120),
  };
}

let cached: { key: string; sink: ShipSink } | null = null;
export function sinkFor(cfg: Extract<ShipConfig, { target: unknown }>): ShipSink {
  const key = JSON.stringify([cfg.mode, cfg.target]);
  if (cached?.key === key) return cached.sink;
  if (cached) void cached.sink.close().catch(() => undefined);
  const sink = cfg.mode === "file" ? fileSink((cfg.target as { file_dir: string }).file_dir) : syslogTlsSink(cfg.target as SyslogTarget);
  cached = { key, sink };
  return sink;
}
export async function closeShipSink(): Promise<void> {
  const c = cached;
  cached = null;
  await c?.sink.close().catch(() => undefined);
}

export interface ShipHistory {
  requestedAt: Date | null; perHour: number; cursor: ShipCursor; hourAt: Date | null; hourSent: number; sent: number; doneAt: Date | null;
}
export interface ShipState {
  cursor: ShipCursor; seq: number; hash: string; lastOkAt: Date | null; lastErrorAt: Date | null; reconciledDay: string | null;
  start: ShipCursor | null;
  history: ShipHistory;
}

export const HISTORY_PER_HOUR_DEFAULT = 2000;
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

type Q = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export async function loadShipState(q: Q, instanceId: string, sink: ShipSinkKind): Promise<ShipState> {
  await q.query("INSERT INTO audit_ship_state (instance_id, sink) VALUES ($1, $2) ON CONFLICT DO NOTHING", [instanceId, sink]);
  const r = (await q.query(
    `SELECT ${AT_TEXT("cursor_at")} AS cursor_at, cursor_id::text AS cursor_id, seq, encode(chain_hash, 'hex') AS hash, last_ok_at, last_error_at,
            to_char(reconciled_day, 'YYYY-MM-DD') AS reconciled_day, ${AT_TEXT("start_at")} AS start_at, start_id::text AS start_id,
            history_requested_at, history_per_hour, ${AT_TEXT("history_cursor_at")} AS history_cursor_at, history_cursor_id::text AS history_cursor_id,
            history_hour_at, history_hour_sent, history_sent, history_done_at
       FROM audit_ship_state WHERE instance_id = $1 AND sink = $2`, [instanceId, sink])).rows[0];
  return {
    cursor: { at: r.cursor_at ?? null, id: r.cursor_id ?? null }, seq: Number(r.seq ?? 0), hash: r.hash ?? ZERO_HASH,
    lastOkAt: r.last_ok_at ?? null, lastErrorAt: r.last_error_at ?? null, reconciledDay: r.reconciled_day ?? null,
    start: r.start_at && r.start_id ? { at: r.start_at, id: r.start_id } : null,
    history: {
      requestedAt: r.history_requested_at ?? null, perHour: Number(r.history_per_hour ?? HISTORY_PER_HOUR_DEFAULT),
      cursor: { at: r.history_cursor_at ?? null, id: r.history_cursor_id ?? null }, hourAt: r.history_hour_at ?? null,
      hourSent: Number(r.history_hour_sent ?? 0), sent: Number(r.history_sent ?? 0), doneAt: r.history_done_at ?? null,
    },
  };
}

export async function startAtEnd(ctx: DbCtx, sink: ShipSinkKind, st: ShipState): Promise<ShipState> {
  if (st.start) return st;
  const legacy = !!st.cursor.at || st.seq > 0;
  const id = newId();
  await ctx.db.audit.query("INSERT INTO audit_events (id, instance_id, event_type, principal_type, details) VALUES ($1, $2, 'admin', 'system', $3)",
    [id, ctx.instanceId, JSON.stringify({ op: "audit_ship_start", reason: legacy ? "reanchor" : "first_enable", sink })]);
  const at = (await ctx.db.auditRead().query(`SELECT ${AT_TEXT()} AS at FROM audit_events WHERE id = $1 AND instance_id = $2`, [id, ctx.instanceId])).rows[0]?.at as string | undefined;
  if (!at) throw new Error("audit_ship_start: could not read the start event");
  await ctx.db.control.query(
    `UPDATE audit_ship_state SET start_at = $3::timestamptz, start_id = $4::uuid, cursor_at = $3::timestamptz - interval '1 microsecond', cursor_id = $5::uuid,
            history_cursor_at = CASE WHEN $6 THEN cursor_at ELSE history_cursor_at END, history_cursor_id = CASE WHEN $6 THEN cursor_id ELSE history_cursor_id END,
            reconciled_day = coalesce(reconciled_day, (($3::timestamptz AT TIME ZONE 'UTC')::date - 1))
      WHERE instance_id = $1 AND sink = $2 AND start_at IS NULL`, [ctx.instanceId, sink, at, id, MAX_UUID, legacy]);
  log.info("audit_ship_start", { sink, at, reason: legacy ? "reanchor" : "first_enable" });
  return loadShipState(ctx.db.control, ctx.instanceId, sink);
}

export async function commitShipped(control: pg.Pool, instanceId: string, sink: ShipSinkKind, lines: readonly ShipLine[], seq: number, hash: string, cursor: ShipCursor | null,
                                    history?: HistoryStep): Promise<void> {
  await tx(control, async (q) => {
    await q.query(
      `UPDATE audit_ship_state SET seq = $3, chain_hash = decode($4, 'hex'), last_ok_at = now(), last_error_code = NULL, last_error_at = NULL
              ${cursor ? ", cursor_at = $5::timestamptz, cursor_id = $6::uuid" : ""}
        WHERE instance_id = $1 AND sink = $2`, cursor ? [instanceId, sink, seq, hash, cursor.at, cursor.id] : [instanceId, sink, seq, hash]);
    if (history) await q.query(
      `UPDATE audit_ship_state SET history_cursor_at = $3::timestamptz, history_cursor_id = $4::uuid, history_sent = history_sent + $5,
              history_hour_at = $6, history_hour_sent = $7 WHERE instance_id = $1 AND sink = $2`,
      [instanceId, sink, history.cursor.at, history.cursor.id, lines.length, history.hourAt, history.hourSent]);
    for (let i = 0; i < lines.length; i += 1000) {
      const part = lines.slice(i, i + 1000);
      await q.query(
        `INSERT INTO audit_ship_sent (instance_id, sink, day, id, seq)
         SELECT $1, $2, x.day::date, x.id::uuid, x.seq FROM unnest($3::text[], $4::text[], $5::bigint[]) AS x(day, id, seq)
         ON CONFLICT DO NOTHING`,
        [instanceId, sink, part.map((l) => l.at.slice(0, 10)), part.map((l) => l.id), part.map((l) => l.seq)]);
    }
  });
}

export interface HistoryStep { cursor: ShipCursor; hourAt: Date; hourSent: number }

export async function shipEvents(ctx: DbCtx, sink: ShipSink, st: ShipState, events: readonly ShipEvent[], moveCursor: boolean,
                                 history?: Omit<HistoryStep, "cursor">): Promise<ShipState> {
  if (!events.length) return st;
  const { lines, seq, hash } = chainLines(events, st.seq, st.hash);
  await sink.write(lines);
  const last = events[events.length - 1]!;
  const cursor = moveCursor ? { at: last.at, id: last.id } : null;
  const step = history ? { ...history, cursor: { at: last.at, id: last.id } } : undefined;
  await commitShipped(ctx.db.control, ctx.instanceId, sink.kind, lines, seq, hash, cursor, step);
  return { ...st, seq, hash, ...(cursor ? { cursor } : {}), lastOkAt: new Date(), lastErrorAt: null,
           ...(step ? { history: { ...st.history, cursor: step.cursor, hourAt: step.hourAt, hourSent: step.hourSent, sent: st.history.sent + events.length } } : {}) };
}

export async function shipHistory(ctx: DbCtx, sink: ShipSink, st: ShipState, batch: number, now = new Date()): Promise<{ st: ShipState; shipped: number }> {
  const h = st.history;
  if (!st.start || !h.requestedAt || h.doneAt) return { st, shipped: 0 };
  const fresh = !h.hourAt || now.getTime() - new Date(h.hourAt).getTime() >= 3_600_000;
  const hourAt = fresh ? now : new Date(h.hourAt!), used = fresh ? 0 : h.hourSent;
  const want = Math.min(batch, Math.max(0, h.perHour - used));
  if (want <= 0) return { st, shipped: 0 };
  const events = await readAfter(ctx.db.auditRead(), ctx.instanceId, h.cursor, { lagSec: 0, batch: want, before: st.start.at });
  let next = st;
  if (events.length) next = await shipEvents(ctx, sink, st, events, false, { hourAt, hourSent: used + events.length });
  if (events.length < want) {
    const done = (await ctx.db.control.query(
      `UPDATE audit_ship_state SET history_done_at = now() WHERE instance_id = $1 AND sink = $2 AND history_done_at IS NULL RETURNING history_sent`,
      [ctx.instanceId, sink.kind])).rows[0] as { history_sent: string | number } | undefined;
    if (done) await auditWorker(ctx, { event_type: "admin", details: { op: "audit_ship_history_done", sink: sink.kind, sent: Number(done.history_sent) } });
    next = { ...next, history: { ...next.history, doneAt: new Date() } };
  }
  return { st: next, shipped: events.length };
}

export async function noteShipFailure(ctx: DbCtx, sink: ShipSinkKind, code: string): Promise<void> {
  await ctx.db.control.query("INSERT INTO audit_ship_state (instance_id, sink) VALUES ($1, $2) ON CONFLICT DO NOTHING", [ctx.instanceId, sink]);
  const r = (await ctx.db.control.query(
    `UPDATE audit_ship_state SET last_error_code = $3, last_error_at = coalesce(last_error_at, now())
      WHERE instance_id = $1 AND sink = $2
      RETURNING last_error_at, extract(epoch FROM now() - coalesce(last_error_at, now()))::int AS failing_sec`, [ctx.instanceId, sink, code])).rows[0];
  const since = new Date(r.last_error_at).toISOString();
  if (Number(r.failing_sec) >= SHIP_FAILED_ALERT_MIN * 60)
    await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
      instanceId: ctx.instanceId, level: "high", code: "audit_ship_failed",
      summary: `The audit log has not been sent for ${Math.round(Number(r.failing_sec) / 60)} min. Receiver ${sink}, code ${code}`,
      details: { sink, error_code: code, since }, dedupeKey: `audit_ship_failed:${sink}:${since}`,
    });
}

export async function spoolHold(ctx: DbCtx): Promise<string | null> {
  const minAt = async (sql: string): Promise<string | null> => {
    try {
      const r = await ctx.db.control.query(sql, [ctx.instanceId]);
      return (r.rows[0]?.at as string | null) ?? null;
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return null;
      throw e;
    }
  };
  const spool = await minAt(`SELECT ${AT_TEXT("min(at)")} AS at FROM audit_spool WHERE instance_id = $1 AND rejected_at IS NULL`);
  // an outbox row whose replay time is fixed lands in the journal with that time — the cursor waits before it
  const outbox = await minAt(`SELECT ${AT_TEXT("min(replay_at)")} AS at FROM audit_outbox WHERE instance_id = $1 AND rejected_at IS NULL AND replay_at IS NOT NULL`);
  return spool && outbox ? (outbox < spool ? outbox : spool) : spool ?? outbox;
}

export async function withShipLock<T>(ctx: DbCtx, fn: (alive: () => Promise<void>) => Promise<T>): Promise<T | null> {
  const lock = await ctx.db.control.connect();
  let clean = false;
  try {
    const ok = (await lock.query("SELECT pg_try_advisory_lock(hashtext('audit_ship:' || $1)) AS ok", [ctx.instanceId])).rows[0]?.ok === true;
    if (!ok) { clean = true; return null; }
    const watch = watchLock(lock);
    try { return await fn(watch.alive); }
    finally {
      try {
        if (!watch.lost()) await lock.query("SELECT pg_advisory_unlock(hashtext('audit_ship:' || $1))", [ctx.instanceId]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "audit_ship" });
        }
      } finally { watch.done(); }
    }
  } finally { lock.release(!clean); }
}

export interface ShipPassResult { mode: string; shipped: number; seq?: number; skipped?: string; error?: string; lag_sec?: number | null; history_shipped?: number; started?: boolean }

export async function auditShipPass(ctx: DbCtx, o: { sink?: ShipSink; maxBatches?: number } = {}): Promise<ShipPassResult> {
  const cfg = shipConfig(ctx.settings);
  if (cfg.mode === "off") return { mode: "off", shipped: 0, skipped: "off" };
  const out = await withShipLock(ctx, async (alive): Promise<ShipPassResult> => {
    if (cfg.problem) {
      log.warn("audit_ship_target_invalid", { sink: cfg.mode });
      await noteShipFailure(ctx, cfg.mode, cfg.problem);
      return { mode: cfg.mode, shipped: 0, error: cfg.problem };
    }
    const sink = o.sink ?? sinkFor(cfg);
    let st = await loadShipState(ctx.db.control, ctx.instanceId, cfg.mode);
    const started = !st.start;
    if (started) st = await startAtEnd(ctx, cfg.mode, st);
    let shipped = 0, historyShipped = 0;
    try {
      for (let i = 0; i < (o.maxBatches ?? SHIP_MAX_BATCHES); i++) {
        const before = await spoolHold(ctx);
        const events = await readAfter(ctx.db.auditRead(), ctx.instanceId, st.cursor, { lagSec: cfg.lagSec, batch: cfg.batch, before });
        if (!events.length) break;
        await alive();
        st = await shipEvents(ctx, sink, st, events, true);
        shipped += events.length;
        if (events.length < cfg.batch) break;
      }
      await alive();
      const h = await shipHistory(ctx, sink, st, cfg.batch);
      st = h.st;
      historyShipped = h.shipped;
    } catch (e) {
      if (e instanceof LockConnectionLost) throw e;
      const code = e instanceof ShipSinkError ? e.code : "internal";
      log.warn("audit_ship_failed", { sink: cfg.mode, code, error: ((e as Error)?.message ?? "").slice(0, 200) });
      await noteShipFailure(ctx, cfg.mode, code);
      return { mode: cfg.mode, shipped, error: code };
    }
    if (!shipped && !historyShipped) await ctx.db.control.query(
      "UPDATE audit_ship_state SET last_ok_at = now(), last_error_code = NULL, last_error_at = NULL WHERE instance_id = $1 AND sink = $2", [ctx.instanceId, cfg.mode]);
    const lag = await pendingAgeSec(ctx.db.auditRead(), ctx.instanceId, st.cursor, cfg.lagSec);
    if (lag !== null && lag > SHIP_LAG_ALERT_SEC)
      await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
        instanceId: ctx.instanceId, level: "medium", code: "audit_ship_lag",
        summary: `Audit log delivery is ${Math.round(lag / 60)} min behind. Receiver ${cfg.mode}`,
        details: { sink: cfg.mode, lag_sec: lag }, dedupeKey: `audit_ship_lag:${cfg.mode}:${new Date().toISOString().slice(0, 13)}`,
      });
    if (shipped || historyShipped) log.info("audit_ship", { sink: cfg.mode, shipped, history: historyShipped, seq: st.seq });
    return { mode: cfg.mode, shipped, seq: st.seq, lag_sec: lag, ...(historyShipped ? { history_shipped: historyShipped } : {}), ...(started ? { started } : {}) };
  });
  return out ?? { mode: cfg.mode, shipped: 0, skipped: "busy" };
}
