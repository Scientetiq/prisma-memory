// Audit outbox drain: job audit_outbox_drain, every 30 s next to audit_spool_drain. The gateway's audit() and the
// workers' auditWorker() keep an event the journal refused in audit_outbox (memory_control, packages/shared/src/audit-outbox.ts);
// this job moves it to audit_events (memory_audit) with the stored id.
//
// Journal time is the replay time, the true time is in details.occurred_at: audit shipping
// reads the journal by a cursor (at, id) with a lag of 30–900 s, so a row inserted later with an older `at` would never be
// shipped. replay_at is set ONCE per row, by the claim statement that commits before the journal insert; a retry (the journal
// answered the probe and then failed the insert, a crash between insert and delete, two drains at once) inserts the same
// (id, replay_at) again, and the bare ON CONFLICT DO NOTHING (the journal's only unique key is (id, at); naming columns would
// need SELECT, which the worker role lacks) keeps one row. While a row with replay_at waits, audit shipping holds its cursor
// before it (spoolHold in audit-ship.ts).
// A conflict is not proof that the event is in the journal: the gateway role reads replay_at
// from the outbox and may set `at` on its own journal insert, so it can plant a row at (id, replay_at). When the insert's row
// count is short, every row of the batch is checked through the journal reader: a row whose journal row at (id, replay_at) is
// equal to what the drain writes (every event column, details with the marks) is moved; any other row is not deleted — it gets
// a fresh replay_at and is inserted again, and the alert audit_outbox_rejected (error_code journal_conflict) is raised. A second
// conflict in a row rejects it with journal_conflict: kept in the outbox, shipping not held. Rule: an outbox row is deleted only
// after this pass inserted it or the journal holds a row equal to it under the same id.
//
// Only the columns of AUDIT_OUTBOX_COLUMNS are copied; id, at and instance_id come from the outbox row, and `spooled` and
// `occurred_at` are written last into details — a payload cannot name a column, forge the time or the instance. A row the
// journal refuses as data (SQLSTATE class 22 or 23: an unknown event type, a malformed id) or that is malformed in itself
// (including a payload that cannot be serialised, such as one nested too deep for JSON.stringify) is marked rejected_at with
// a code and not taken again. A row refused with another code (54000: an index row too big, a
// trigger's raise, an internal error) is rejected too, but only after a probe shows that the journal takes an ordinary
// insert and a retry of the row fails again — otherwise one such row would end every pass, keep the rows behind it and hold
// the shipping cursor forever. A connection, lock, resource or rollback error (classes 08, 40, 53, 55, 57, 58, or no
// SQLSTATE) is the journal's, not the row's: it ends the pass and leaves the rows for the next one.
// Ambiguous loss: the writer saw an error after the journal had committed its insert (a dropped connection), and spooled the
// event. Before inserting, the drain asks the journal (role memory_audit_reader) which ids of the batch it already holds
// with a time between one hour before the failure and the replay time and with every event column equal to the payload (the
// same id alone is not enough: the gateway role may insert into the journal); those rows are deleted without a second insert.
// If the reader does not answer, the rows are inserted anyway: a duplicate (marked spooled) is better than a stuck queue.
// Logs and alerts carry counts, codes and event types only — never the payload (query texts, filters, addresses).
import { log, newId, raiseAlert, AUDIT_OUTBOX_COLUMNS } from "@memory/shared";
import type { Ctx } from "../ctx.ts";
import { AT_TEXT } from "../audit-ship/reader.ts";

export const AUDIT_OUTBOX_BATCH = 200;
/** Batches per pass: the rest — at the next pass in 30 seconds. */
export const AUDIT_OUTBOX_MAX_BATCHES = 10;
/** One high alert audit_write_failed per this period while events wait or are moved. */
export const AUDIT_WRITE_FAILED_DEDUPE_MS = 1_800_000;

export type OutboxCtx = Pick<Ctx, "instanceId"> & { db: Pick<Ctx["db"], "control" | "audit" | "auditRead"> };

/**
 * moved — inserted by this pass (or found equal at its replay time: a retry of an earlier insert); present — already in the
 * journal (ambiguous loss), deleted without a second insert; conflicts — rows whose (id, replay_at) the journal held with other
 * content: stored under a fresh replay time or, on a second conflict, rejected journal_conflict.
 */
export interface OutboxDrain { moved: number; rejected: number; batches: number; present?: number; conflicts?: number; skipped?: "busy" | "audit_down" | "missing"; error?: string }

interface OutboxRow { id: string; source: string; payload: unknown; occurred_at: string; replay_at: string }

let running: Promise<OutboxDrain> | null = null;
let missingLogged = false;

/** One drain pass. While the previous pass of this process runs, a new one does not start. */
export function auditOutboxDrain(ctx: OutboxCtx, o: { now?: () => number } = {}): Promise<OutboxDrain> {
  if (running) return Promise.resolve({ moved: 0, rejected: 0, batches: 0, skipped: "busy" });
  running = drain(ctx, o.now ?? Date.now).finally(() => { running = null; });
  return running;
}

/** For tests: report the missing table again. */
export function resetAuditOutboxState(): void { missingLogged = false; }

const isMissing = (e: unknown): boolean => (e as { code?: string } | null)?.code === "42P01";

interface Seen { count: number; sources: Set<string>; since: string | null; rejectedType: string | null; rejectCode: string | null; oldestMoved: string | null; conflictType: string | null }

async function drain(ctx: OutboxCtx, now: () => number): Promise<OutboxDrain> {
  const out: OutboxDrain = { moved: 0, rejected: 0, batches: 0 };
  const seen: Seen = { count: 0, sources: new Set(), since: null, rejectedType: null, rejectCode: null, oldestMoved: null, conflictType: null };
  try {
    for (let n = 0; n < AUDIT_OUTBOX_MAX_BATCHES; n++) {
      // the journal must answer before replay_at is fixed: a row is not stamped while the journal is down
      try { await ctx.db.audit.query("SELECT 1"); }
      catch {
        out.skipped = "audit_down";
        await notePending(ctx, seen);
        break;
      }
      let batch: OutboxRow[];
      try { batch = await claim(ctx); }
      catch (e) {
        if (!isMissing(e)) throw e;
        // schema without the [SEC] part of 17 (code before schema): nothing to move; one line per process
        if (!missingLogged) { missingLogged = true; log.warn("audit_outbox_missing", {}); }
        out.skipped = "missing";
        break;
      }
      if (!batch.length) break;
      out.batches++;
      for (const r of batch) { seen.count++; seen.sources.add(r.source); if (!seen.since || r.occurred_at < seen.since) seen.since = r.occurred_at; }
      const held = await alreadyInJournal(ctx, batch);
      if (held.length) {
        await ctx.db.control.query("DELETE FROM audit_outbox WHERE instance_id = $1 AND id = ANY($2::uuid[])", [ctx.instanceId, held.map((r) => r.id)]);
        out.present = (out.present ?? 0) + held.length;
      }
      const good: Array<{ row: OutboxRow; values: unknown[] }> = [];
      for (const r of batch) {
        if (held.includes(r)) continue;
        // No per-row step before the journal insert may throw out of the batch loop: claim() has already committed replay_at
        // for the whole batch, so such a throw would end every pass, keep the rows behind it and hold shipping. rowValues is
        // a function of this row's payload only — an exception from it (JSON.stringify of a details or filters nested
        // thousands of levels deep throws RangeError on Node 22) is the row's, and the row is rejected as malformed.
        let values: unknown[] | null;
        try { values = rowValues(ctx.instanceId, r); } catch { values = null; }
        if (values) good.push({ row: r, values }); else await reject(ctx, r, "bad_payload", out, seen);
      }
      let done: OutboxRow[] = [];
      if (good.length) {
        let n: number | null = null, failed = false;
        try { n = await insertBatch(ctx, good); } catch { failed = true; }
        done = failed ? await insertEach(ctx, good, out, seen) : await settle(ctx, good, n, out, seen);
      }
      if (done.length) await moved(ctx, done, out, seen);
      if (batch.length < AUDIT_OUTBOX_BATCH) break;
    }
  } catch (e) {
    // the journal or the control database failed mid-pass: the rows stay (with their replay_at) for the next pass
    out.error = String((e as { code?: string } | null)?.code ?? "internal");
    log.warn("audit_outbox_drain_failed", { code: out.error, error: ((e as Error)?.message ?? "").slice(0, 200) });
  }
  await report(ctx, out, seen, now);
  return out;
}

/** Fix replay_at once and take up to a batch of pending rows; one autocommit statement, so replay_at is committed first. */
async function claim(ctx: OutboxCtx): Promise<OutboxRow[]> {
  const { rows } = await ctx.db.control.query(
    `UPDATE audit_outbox o SET replay_at = COALESCE(o.replay_at, clock_timestamp())
      WHERE o.id IN (SELECT id FROM audit_outbox WHERE instance_id = $1 AND rejected_at IS NULL ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING o.id::text AS id, o.source, o.payload, ${AT_TEXT("o.occurred_at")} AS occurred_at, ${AT_TEXT("o.replay_at")} AS replay_at`,
    [ctx.instanceId, AUDIT_OUTBOX_BATCH]);
  return (rows as OutboxRow[]).sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id < b.id ? -1 : 1));
}

/** Rows moved: delete them from the outbox and count them for the summary. */
async function moved(ctx: OutboxCtx, done: OutboxRow[], out: OutboxDrain, seen: Seen): Promise<void> {
  await ctx.db.control.query("DELETE FROM audit_outbox WHERE instance_id = $1 AND id = ANY($2::uuid[])", [ctx.instanceId, done.map((r) => r.id)]);
  out.moved += done.length;
  for (const r of done) if (!seen.oldestMoved || r.occurred_at < seen.oldestMoved) seen.oldestMoved = r.occurred_at;
}

/**
 * Rows of the batch the journal already holds under the same id, written before the replay time and not earlier than one
 * hour before the failure, with the same content (sameInJournal: the writer's own insert that committed although the writer
 * saw an error). A row an earlier pass of
 * the drain inserted has at = replay_at and is not among them: the insert conflicts on it, and settle() deletes the outbox row
 * only when that journal row is equal to what the drain writes.
 * The journal reader not answering → none (the insert goes ahead).
 */
async function alreadyInJournal(ctx: OutboxCtx, batch: OutboxRow[]): Promise<OutboxRow[]> {
  if (!batch.length) return [];
  const since = batch.reduce((m, r) => (r.occurred_at < m ? r.occurred_at : m), batch[0]!.occurred_at);
  const until = batch.reduce((m, r) => (r.replay_at > m ? r.replay_at : m), batch[0]!.replay_at);
  let found: Array<{ id: string; at: string }>;
  try {
    found = (await ctx.db.auditRead().query(
      `SELECT id::text AS id, ${AT_TEXT("at")} AS at FROM audit_events
        WHERE instance_id = $1 AND id = ANY($2::uuid[]) AND at >= $3::timestamptz - interval '1 hour' AND at < $4::timestamptz`,
      [ctx.instanceId, batch.map((r) => r.id), since, until])).rows as Array<{ id: string; at: string }>;
  } catch (e) {
    log.warn("audit_outbox_presence_unknown", { code: String((e as { code?: string } | null)?.code ?? "internal"), error: ((e as Error)?.message ?? "").slice(0, 200) });
    return [];
  }
  if (!found.length) return [];
  const byId = new Map<string, string[]>();
  for (const f of found) byId.set(f.id, [...(byId.get(f.id) ?? []), f.at]);
  const held: OutboxRow[] = [];
  for (const r of batch) {
    if (!(byId.get(r.id) ?? []).some((at) => at < r.replay_at)) continue;
    if (await sameInJournal(ctx, r)) held.push(r);
  }
  return held;
}

/**
 * The journal row under this id is the writer's own direct insert: every event column equal to the payload, details without
 * the drain's marks, received by the journal not later than the outbox row was written. The same id alone is not enough — the gateway role reads the outbox and inserts into
 * the journal, so it could plant a row with the id of a waiting event and make the drain delete that event. A row that
 * differs, a payload that is malformed or a reader that does not answer — false: the event is inserted (a second row marked
 * spooled is better than a lost one).
 */
async function sameInJournal(ctx: OutboxCtx, r: OutboxRow): Promise<boolean> {
  let values: unknown[] | null;
  try { values = rowValues(ctx.instanceId, r); } catch { values = null; }
  if (!values || !isPlainObject(r.payload)) return false;
  const d = r.payload.details;
  // the direct write stores the writer's details as they are (audit.ts, ctx.ts): no spooled / occurred_at marks
  values[3 + AUDIT_OUTBOX_COLUMNS.indexOf("details")] = JSON.stringify(isPlainObject(d) ? d : {});
  // received_at is the database's clock at the insert (the gateway role cannot set it). The writer's own insert
  // committed before the writer saw an error, so before the outbox row existed: received_at <= occurred_at. A copy inserted
  // after the event reached the outbox (by a role that read it), or a row without received_at, is not the event
  return journalHolds(ctx, r.id, values.slice(3), "at >= $3::timestamptz - interval '1 hour' AND at < $4::timestamptz AND received_at <= $3::timestamptz",
    [r.occurred_at, r.replay_at]);
}

/**
 * The journal row at (id, replay_at) is the one this drain writes for the row — every event column equal to `values` (the
 * parameters of insertBatch, details with the marks): an earlier insert of this drain or of another drain process. Not equal,
 * or the reader does not answer — false: the outbox row is not deleted on the strength of a conflict.
 */
function equalAtReplay(ctx: OutboxCtx, g: { row: OutboxRow; values: unknown[] }): Promise<boolean> {
  return journalHolds(ctx, g.row.id, g.values.slice(3), "at = $3::timestamptz", [g.row.replay_at]);
}

/** A journal row of this instance under `id`, within `atClause` (parameters $3…), equal to the payload in every event column. */
async function journalHolds(ctx: OutboxCtx, id: string, cols: unknown[], atClause: string, atParams: unknown[]): Promise<boolean> {
  const base = 3 + atParams.length;
  const eq = AUDIT_OUTBOX_COLUMNS.map((col, i) => `${col} IS NOT DISTINCT FROM $${i + base}${COLUMN_CAST[col] ?? ""}`).join(" AND ");
  try {
    const q = await ctx.db.auditRead().query(
      `SELECT 1 FROM audit_events WHERE instance_id = $1 AND id = $2::uuid AND ${atClause} AND ${eq} LIMIT 1`,
      [ctx.instanceId, id, ...atParams, ...cols]);
    return (q.rows?.length ?? 0) > 0;
  } catch (e) {
    log.warn("audit_outbox_presence_unknown", { code: String((e as { code?: string } | null)?.code ?? "internal"), error: ((e as Error)?.message ?? "").slice(0, 200) });
    return false;
  }
}

/**
 * After an insert that went through: which rows may leave the outbox. All of them when the journal took every row; otherwise
 * (a conflict on (id, at)) each row is checked — placed() — and a row that cannot be confirmed is re-stamped and retried.
 * Rows confirmed before a throw are deleted first (the rest stay with their replay_at for the next pass).
 */
async function settle(ctx: OutboxCtx, rows: Array<{ row: OutboxRow; values: unknown[] }>, inserted: number | null, out: OutboxDrain, seen: Seen): Promise<OutboxRow[]> {
  if (inserted === rows.length) return rows.map((g) => g.row);
  const done: OutboxRow[] = [];
  try {
    for (const g of rows) {
      const row = await placed(ctx, g, out, seen);
      if (row) done.push(row);
    }
  } catch (e) {
    if (done.length) await moved(ctx, done, out, seen);
    throw e;
  }
  return done;
}

/**
 * A row whose insert may have hit an existing (id, replay_at): the row to delete (equal at its replay time, or inserted under a
 * fresh replay time), or null (rejected journal_conflict, or gone — another drain deleted it). Never deletes by itself.
 */
async function placed(ctx: OutboxCtx, g: { row: OutboxRow; values: unknown[] }, out: OutboxDrain, seen: Seen): Promise<OutboxRow | null> {
  if (await equalAtReplay(ctx, g)) return g.row;
  out.conflicts = (out.conflicts ?? 0) + 1;
  const type = isPlainObject(g.row.payload) && typeof g.row.payload.event_type === "string" ? g.row.payload.event_type.slice(0, 64) : null;
  seen.conflictType ??= type;
  log.warn("audit_outbox_conflict", { id: g.row.id, event_type: type, source: g.row.source.slice(0, 16) });
  // a fresh replay time, committed before the insert (as in claim): a crash after it repeats the same (id, replay_at)
  const fresh = (await ctx.db.control.query(
    `UPDATE audit_outbox SET replay_at = clock_timestamp() WHERE instance_id = $1 AND id = $2::uuid AND rejected_at IS NULL RETURNING ${AT_TEXT("replay_at")} AS replay_at`,
    [ctx.instanceId, g.row.id])).rows[0] as { replay_at: string } | undefined;
  if (!fresh) return null;
  const row: OutboxRow = { ...g.row, replay_at: fresh.replay_at };
  const again = { row, values: [g.values[0], fresh.replay_at, ...g.values.slice(2)] };
  if ((await insertBatch(ctx, [again])) === 1 || (await equalAtReplay(ctx, again))) return row;
  await reject(ctx, row, "journal_conflict", out, seen);
  return null;
}

/** Journal not answering: how many rows wait, for the alert. */
async function notePending(ctx: OutboxCtx, seen: Seen): Promise<void> {
  try {
    const r = (await ctx.db.control.query(
      `SELECT count(*)::int AS n, ${AT_TEXT("min(occurred_at)")} AS since, coalesce(array_agg(DISTINCT source), '{}') AS sources
         FROM audit_outbox WHERE instance_id = $1 AND rejected_at IS NULL`, [ctx.instanceId])).rows[0] as { n: number; since: string | null; sources: string[] };
    seen.count += r.n;
    for (const s of r.sources) seen.sources.add(s);
    if (r.since && (!seen.since || r.since < seen.since)) seen.since = r.since;
  } catch (e) {
    if (!isMissing(e)) log.warn("audit_outbox_drain_failed", { code: String((e as { code?: string })?.code ?? "internal"), error: ((e as Error)?.message ?? "").slice(0, 200) });
  }
}

const COLUMN_CAST: Record<string, string> = { key_id: "::uuid", principal_id: "::uuid", on_behalf_of: "::uuid", service_id: "::uuid", record_ids: "::uuid[]",
  space_id: "::uuid", filters: "::jsonb", result_count: "::int", details: "::jsonb", ip: "::inet" };
const SQL_COLS = `(id, at, instance_id, ${AUDIT_OUTBOX_COLUMNS.join(", ")})`;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown): boolean => v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Parameters of one journal row (id, at, instance_id and the sixteen columns), or null — the payload is malformed. */
function rowValues(instanceId: string, r: OutboxRow): unknown[] | null {
  const p = r.payload;
  if (!isPlainObject(p) || typeof p.event_type !== "string" || !p.event_type) return null;
  const values: unknown[] = [r.id, r.replay_at, instanceId];
  for (const col of AUDIT_OUTBOX_COLUMNS) {
    const v = p[col];
    if (col === "record_ids") {
      if (v !== undefined && v !== null && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return null;
      values.push(v ?? []);
    } else if (col === "details") {
      if (v !== undefined && v !== null && !isPlainObject(v)) return null;
      // ours last: a payload cannot clear the mark or forge the original time
      values.push(JSON.stringify({ ...(v ?? {}), spooled: true, occurred_at: r.occurred_at }));
    } else if (col === "filters") {
      // any JSON value, as a direct write of audit() takes it (jsonb)
      values.push(v === undefined || v === null ? null : JSON.stringify(v));
    } else {
      if (!isScalar(v)) return null;
      values.push(v ?? null);
    }
  }
  return values;
}

/** The number of rows the journal took (fewer than given: a conflict on (id, at)), or null when the driver does not say. */
async function insertBatch(ctx: OutboxCtx, rows: Array<{ values: unknown[] }>): Promise<number | null> {
  const parts: string[] = [], params: unknown[] = [];
  const casts = ["::uuid", "::timestamptz", "", ...AUDIT_OUTBOX_COLUMNS.map((c) => COLUMN_CAST[c] ?? "")];
  for (const r of rows) {
    const b = params.length;
    parts.push(`(${casts.map((c, i) => `$${b + i + 1}${c}`).join(", ")})`);
    params.push(...r.values);
  }
  const r = await ctx.db.audit.query(`INSERT INTO audit_events ${SQL_COLS} VALUES ${parts.join(", ")} ON CONFLICT DO NOTHING`, params);
  const n = (r as { rowCount?: unknown } | undefined)?.rowCount;
  return typeof n === "number" ? n : null;
}

/** SQLSTATE of a pg error, or null (a dropped connection, a client timeout, a JS error). */
const sqlState = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? c : null;
};
/** The row's data: the journal refuses this row, not every row. */
const DATA_ERROR = /^(22|23)/;
/** The journal's state, not the row's: connection, transaction rollback, resources, lock / object state, operator, system. */
const JOURNAL_ERROR = /^(08|40|53|55|57|58)/;

/**
 * Does the journal take an ordinary insert right now? One statement inserts a known-good row and then divides by zero on the
 * inserted row count, so the statement — and the row — are rolled back. 22012 means the insert itself went through.
 */
async function journalTakesInserts(ctx: OutboxCtx): Promise<boolean> {
  try {
    await ctx.db.audit.query(
      `WITH probe AS (INSERT INTO audit_events (id, instance_id, event_type, principal_type, details)
                      VALUES ($1::uuid, $2, 'admin', 'system', '{"op":"audit_outbox_probe"}'::jsonb) RETURNING 1)
       SELECT 1 / (count(*)::int - 1) FROM probe`, [newId(), ctx.instanceId]);
    return false;
  } catch (e) {
    return sqlState(e) === "22012";
  }
}

/**
 * The batch failed — row by row. A data error rejects the row. Another SQLSTATE outside the journal's own classes: probe the
 * journal once per pass; when it takes inserts, the row is retried once and rejected with its code if it fails again. A
 * journal error, an error without SQLSTATE or a failed probe ends the pass (what moved is kept, the rest stays).
 */
async function insertEach(ctx: OutboxCtx, rows: Array<{ row: OutboxRow; values: unknown[] }>, out: OutboxDrain, seen: Seen): Promise<OutboxRow[]> {
  const done: OutboxRow[] = [];
  let works: boolean | undefined;
  const stop = async (e: unknown): Promise<never> => {
    if (done.length) await moved(ctx, done, out, seen);
    throw e;
  };
  for (const g of rows) {
    let err: unknown, n: number | null = null, ok = false;
    try { n = await insertBatch(ctx, [g]); ok = true; } catch (e) { err = e; }
    if (!ok) {
      let code = sqlState(err);
      if (code && !DATA_ERROR.test(code)) {
        if (JOURNAL_ERROR.test(code)) await stop(err);
        works ??= await journalTakesInserts(ctx);
        if (!works) await stop(err);
        try { n = await insertBatch(ctx, [g]); ok = true; } catch (e) { err = e; }
        if (!ok) {
          code = sqlState(err);
          if (code && JOURNAL_ERROR.test(code)) await stop(err);
        }
      }
      if (!ok) {
        if (!code) await stop(err);
        await reject(ctx, g.row, code!.toLowerCase(), out, seen);
        continue;
      }
    }
    // the insert went through: the row leaves only when it is now in the journal — a short row count is checked
    let row: OutboxRow | null = null;
    try { row = n === 1 ? g.row : await placed(ctx, g, out, seen); } catch (e) { await stop(e); }
    if (row) done.push(row);
  }
  return done;
}

/** Mark a row the journal does not take: kept with a code, not taken again; replay_at cleared so shipping is not held. */
async function reject(ctx: OutboxCtx, r: OutboxRow, code: string, out: OutboxDrain, seen: Seen): Promise<void> {
  await ctx.db.control.query("UPDATE audit_outbox SET rejected_at = now(), reject_code = $3, replay_at = NULL WHERE instance_id = $1 AND id = $2::uuid",
    [ctx.instanceId, r.id, code]);
  out.rejected++;
  const type = isPlainObject(r.payload) && typeof r.payload.event_type === "string" ? r.payload.event_type.slice(0, 64) : null;
  seen.rejectedType ??= type;
  seen.rejectCode ??= code;
  log.warn("audit_outbox_rejected", { id: r.id, event_type: type, source: r.source.slice(0, 16), error_code: code });
}

async function report(ctx: OutboxCtx, out: OutboxDrain, seen: Seen, now: () => number): Promise<void> {
  if (out.moved) {
    // a direct, best-effort insert — not auditWorker: a spooled summary would feed the next pass
    await ctx.db.audit.query("INSERT INTO audit_events (id, instance_id, event_type, principal_type, details) VALUES ($1, $2, 'admin', 'system', $3::jsonb)",
      [newId(), ctx.instanceId, JSON.stringify({ op: "audit_outbox_replayed", count: out.moved, oldest_occurred_at: seen.oldestMoved })])
      .catch((e: unknown) => log.warn("audit_outbox_summary_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) }));
  }
  if (out.moved || out.present) log.info("audit_outbox_drained", { moved: out.moved, present: out.present ?? 0, rejected: out.rejected, batches: out.batches });
  const db = { control: ctx.db.control, audit: ctx.db.audit };
  // rows the log refused are not "moved when the log answers": they have their own alert below
  const waited = seen.count - out.rejected;
  if (waited > 0) {
    const source = [...seen.sources].sort().join(",");
    await raiseAlert(db, { instanceId: ctx.instanceId, level: "high", code: "audit_write_failed",
      summary: `Audit log writes failed: ${waited} event(s) waited in the audit outbox (${source}); they are moved when the log answers`,
      details: { count: waited, source, since: seen.since }, dedupeKey: `audit_write_failed:${Math.floor(now() / AUDIT_WRITE_FAILED_DEDUPE_MS)}` });
  }
  if (out.conflicts) {
    // a security signal: the journal held another row under the id and replay time of a waiting event, or the journal reader
    // could not confirm the row was the drain's own
    await raiseAlert(db, { instanceId: ctx.instanceId, level: "medium", code: "audit_outbox_rejected",
      summary: `The audit log already held a row under the id and replay time of ${out.conflicts} waiting event(s) that could not be confirmed as the event (journal_conflict); the events were not dropped: they were stored under a new time or stay in audit_outbox marked rejected. Check who writes to audit_events`,
      details: { count: out.conflicts, event_type: seen.conflictType, error_code: "journal_conflict" },
      dedupeKey: `audit_outbox_rejected:journal_conflict:${new Date(now()).toISOString().slice(0, 10)}` });
  }
  if (out.rejected) {
    await raiseAlert(db, { instanceId: ctx.instanceId, level: "medium", code: "audit_outbox_rejected",
      summary: `The audit log refused ${out.rejected} event(s) from the audit outbox (${seen.rejectCode}); they stay in audit_outbox marked rejected`,
      details: { count: out.rejected, event_type: seen.rejectedType, error_code: seen.rejectCode },
      dedupeKey: `audit_outbox_rejected:${new Date(now()).toISOString().slice(0, 10)}` });
  }
}
