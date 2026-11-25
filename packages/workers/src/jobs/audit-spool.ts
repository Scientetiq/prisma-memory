// Move of the interim journal audit_spool (memory_control) into audit_events (memory_audit) — job audit_spool_drain.
// The external-access services with no right to connect to memory_audit (memory-authcheck, the probe)
// write to audit_spool; every 5 s the worker moves them in batches of 500.
//
// Two databases, no single transaction. So the move repeats without duplicates: the journal event id comes from the
// queue row (48 bits: its at in ms, the rest a hash of instance and row number), same at, and the insert uses
// ON CONFLICT DO NOTHING (the journal's only unique key is the primary (id, at); without naming columns — because
// naming needs SELECT on them; the worker has only INSERT on the journal). A fault between insert and queue delete —
// the next pass re-inserts the same rows in vain and deletes them.
// A row the journal refuses (unknown event type — the value was not added to the enums.json registry with the DDL
// change) is neither lost nor retried forever: it stays in the queue with the mark rejected_at and a refusal code
// (SQLSTATE, lower case); the service log gets one line audit_spool_rejected (row number, event type, service, code; no
// details). The mark is in the DB, not process memory: a restarted worker skips the rejected, and the pass does not
// stick on a batch of rejected ones. A row whose event type is not in the role list (audit_spool_types, code
// not_allowed) is marked alike: the trigger already refuses such inserts; the mark is for a row put past it or before
// a list fix. Putting it back after a registry fix is the schema owner's: UPDATE audit_spool SET rejected_at = NULL, …
// A returned row lands in the journal with its old at — behind the cursor of the outward journal shipping (audit_ship): if
// shipping is on, it will not go out by itself, and the reconcile of its day, if done, shows no mismatch. So on
// return, record the row numbers and their days and reconcile them at the sink by hand.
// Alerts on audit_spool_rejected and audit_spool_backlog (level medium, contracts/edge/audit-codes.json) come from the
// alert core.
import { createHash } from "node:crypto";
import { log } from "@memory/shared";
import type { Ctx } from "../ctx.ts";

export const AUDIT_SPOOL_BATCH = 500;
/** Batches per pass: the rest go in the next pass 5 seconds later. */
export const AUDIT_SPOOL_MAX_BATCHES = 20;
/** Code for a row whose event type is off the role list (audit_spool_types). */
export const NOT_ALLOWED = "not_allowed";

export type SpoolCtx = Pick<Ctx, "instanceId"> & { db: Pick<Ctx["db"], "control" | "audit"> };

export interface SpoolDrain { moved: number; rejected: number; batches: number; skipped?: "busy" }

interface SpoolRow { id: string; instance_id: string; at: string; at_ms: string; source: string; event_type: string; details: Record<string, unknown>; allowed: boolean }

/**
 * Journal event id for a queue row: UUIDv7 form (first 48 bits — milliseconds of at, version 7, variant RFC 4122),
 * the other bits from SHA-256 of audit_spool:<instance>:<number>. One row — always one id.
 */
export function spoolEventId(instanceId: string, spoolId: string, atMs: number): string {
  const b = createHash("sha256").update(`audit_spool:${instanceId}:${spoolId}`).digest().subarray(0, 16);
  const ms = BigInt(Math.max(0, Math.floor(atMs)));
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let running: Promise<SpoolDrain> | null = null;
let missingLogged = false;

/** One move pass. While a previous pass runs in this process, a new one does not start. */
export function auditSpoolDrain(ctx: SpoolCtx): Promise<SpoolDrain> {
  if (running) return Promise.resolve({ moved: 0, rejected: 0, batches: 0, skipped: "busy" });
  running = drain(ctx).finally(() => { running = null; });
  return running;
}

/** For tests: report the missing queue table again. */
export function resetAuditSpoolState(): void { missingLogged = false; }

async function drain(ctx: SpoolCtx): Promise<SpoolDrain> {
  const out: SpoolDrain = { moved: 0, rejected: 0, batches: 0 };
  let full = false;
  for (let n = 0; n < AUDIT_SPOOL_MAX_BATCHES; n++) {
    const { rows } = await ctx.db.control.query(
      `SELECT s.id::text AS id, s.instance_id, to_char(s.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
              floor(extract(epoch FROM s.at) * 1000)::bigint::text AS at_ms, s.source, s.event_type, s.details,
              EXISTS (SELECT 1 FROM audit_spool_types t WHERE t.source = s.source AND t.event_type = s.event_type) AS allowed
         FROM audit_spool s
        WHERE s.instance_id = $1 AND s.rejected_at IS NULL
        ORDER BY s.id
        LIMIT $2`,
      [ctx.instanceId, AUDIT_SPOOL_BATCH]).catch((e: unknown) => {
      // schema without 09-external-access.sql yet (code before schema) — nothing to move; one service log line
      if ((e as { code?: string }).code !== "42P01") throw e;
      if (!missingLogged) { missingLogged = true; log.warn("audit_spool_missing", {}); }
      return { rows: [] };
    });
    const batch = rows as SpoolRow[];
    if (!batch.length) break;
    out.batches++;
    const ok = batch.filter((r) => r.allowed);
    for (const r of batch) if (!r.allowed) await reject(ctx, r, NOT_ALLOWED, out);
    const done = ok.length ? await insertBatch(ctx, ok).then(() => ok.map((r) => r.id), () => insertEach(ctx, ok, out)) : [];
    if (done.length) {
      await ctx.db.control.query("DELETE FROM audit_spool WHERE instance_id = $1 AND id = ANY($2::bigint[])", [ctx.instanceId, done]);
      out.moved += done.length;
    }
    full = batch.length === AUDIT_SPOOL_BATCH;
    if (!full) break;
  }
  // not done in a pass: the queue grows faster than the move (or the move stood long) — one line per pass
  if (full && out.batches === AUDIT_SPOOL_MAX_BATCHES) log.warn("audit_spool_backlog", { batches: out.batches, moved: out.moved });
  if (out.moved || out.rejected) log.info("audit_spool_drained", { moved: out.moved, rejected: out.rejected, batches: out.batches });
  return out;
}

/** Mark journal-refused: the row stays queued and is not taken again; the service log gets no details. */
async function reject(ctx: SpoolCtx, r: SpoolRow, code: string, out: SpoolDrain): Promise<void> {
  await ctx.db.control.query("UPDATE audit_spool SET rejected_at = now(), reject_code = $3 WHERE instance_id = $1 AND id = $2::bigint",
    [ctx.instanceId, r.id, code]);
  out.rejected++;
  log.warn("audit_spool_rejected", { spool_id: r.id, event_type: r.event_type.slice(0, 64), source: r.source.slice(0, 64), error_code: code });
}

const SQL_COLS = "(id, at, instance_id, event_type, principal_type, details)";

function valuesOf(rows: SpoolRow[]): { sql: string; params: unknown[] } {
  const parts: string[] = [], params: unknown[] = [];
  for (const r of rows) {
    const b = params.length;
    parts.push(`($${b + 1}::uuid, $${b + 2}::timestamptz, $${b + 3}, $${b + 4}, 'system', $${b + 5}::jsonb)`);
    params.push(spoolEventId(r.instance_id, r.id, Number(r.at_ms)), r.at, r.instance_id, r.event_type, JSON.stringify({ ...(r.details ?? {}), source: r.source }));
  }
  return { sql: `INSERT INTO audit_events ${SQL_COLS} VALUES ${parts.join(", ")} ON CONFLICT DO NOTHING`, params };
}

async function insertBatch(ctx: SpoolCtx, rows: SpoolRow[]): Promise<void> {
  const { sql, params } = valuesOf(rows);
  await ctx.db.audit.query(sql, params);
}

/** A batch failed — row by row: accepted ones move, rejected ones stay in the queue with the mark rejected_at. */
async function insertEach(ctx: SpoolCtx, rows: SpoolRow[], out: SpoolDrain): Promise<string[]> {
  const done: string[] = [];
  for (const r of rows) {
    try {
      await insertBatch(ctx, [r]);
      done.push(r.id);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "unknown";
      // a journal connection failure is no row fault: the pass stops, the rows stay in the queue
      if (!/^(22|23)[0-9A-Z]{3}$/.test(code)) throw e;
      await reject(ctx, r, code.toLowerCase(), out);
    }
  }
  return done;
}
