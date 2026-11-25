import { converterConfig, converterHealth, converterWindowOf, gateNoteMismatch, log, readConverterGate, readConverterHolds, updateConverterGate, watchLock, type ConverterGateState, type DataClass } from "@memory/shared";
import { auditWorker, recordsDb, type DbCtx } from "./ctx.ts";
import { effectiveWindow, stalledPreconditions, STALLED_AFTER_MS, type InFlightRun, type WindowBlock } from "./conversion-rules.ts";
import { QUEUE_OF, versionFor, type StageJob } from "./stages.ts";

export { CONVERTER_WINDOW_DEFAULT, CONVERTER_WINDOW_MAX } from "@memory/shared";
export const CONVERSION_CANDIDATES_LIMIT = 1000;

export interface ConversionCandidate { cls: DataClass; record_id: string; status: "pending" | "running"; owner_id: string; ingested_at: Date; priority: number; served_at?: Date | null }

export interface ConversionSlots { free: number; candidates: ConversionCandidate[]; inFlight: number; k: number; block: WindowBlock | null }

export type ConversionSlotsFn = (ctx: DbCtx) => Promise<Pick<ConversionSlots, "free" | "candidates"> & Partial<ConversionSlots>>;

export type ScheduleFn = (cls: DataClass, recordId: string) => Promise<void>;

export function conversionEvent(ctx: DbCtx, job: Pick<StageJob, "class" | "record_id"> | null, details: Record<string, unknown>, spaceId?: string | null): Promise<void> {
  return auditWorker(ctx, { event_type: "processing", ...(job ? { class: job.class, record_ids: [job.record_id] } : {}), ...(spaceId ? { space_id: spaceId } : {}),
                            details: { job: "conversion", ...details } });
}

export function converterWindow(ctx: Pick<DbCtx, "settings">): number {
  return converterWindowOf(ctx.settings);
}

export function orderConversionCandidates(list: ConversionCandidate[]): ConversionCandidate[] {
  const byAge = [...list].sort((a, b) => a.ingested_at.getTime() - b.ingested_at.getTime() || a.record_id.localeCompare(b.record_id));
  const seen = new Map<string, number>(), rn = new Map<ConversionCandidate, number>();
  for (const c of byAge) { const n = (seen.get(c.owner_id) ?? 0) + 1; seen.set(c.owner_id, n); rn.set(c, n); }
  const served = (c: ConversionCandidate): number => c.served_at?.getTime() ?? 0;
  return byAge.sort((a, b) => a.priority - b.priority || rn.get(a)! - rn.get(b)! || served(a) - served(b)
                              || a.ingested_at.getTime() - b.ingested_at.getTime() || a.record_id.localeCompare(b.record_id));
}

export function conversionPosition(candidates: readonly ConversionCandidate[], cls: DataClass, recordId: string): number {
  const i = candidates.findIndex((c) => c.cls === cls && c.record_id === recordId);
  return i < 0 ? candidates.length : i;
}

const PHASE = "COALESCE(r.attrs->'conversion'->>'phase', '')";
const phaseIn = (...phases: string[]): string => `(r.attrs->'conversion' ? 'phase' AND r.attrs->'conversion'->>'phase' IN (${phases.map((p) => `'${p}'`).join(",")}))`;
const RERUN_DUE = `(${PHASE} = 'rerun_wait' AND COALESCE(CASE WHEN r.attrs->'conversion'->>'rerun_at' ~ '^\\d{4}-\\d{2}-\\d{2}'
                     THEN (r.attrs->'conversion'->>'rerun_at')::timestamptz END, now()) <= now())`;

export async function conversionInFlight(ctx: DbCtx): Promise<number> {
  let n = 0;
  for (const cls of ["open", "closed"] as DataClass[]) {
    n += Number((await recordsDb(ctx, cls).query(
      `SELECT count(*)::int AS n FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
        WHERE (s.status IN ('pending','running') OR (s.status = 'failed' AND NOT s.terminal AND s.retry_at IS NOT NULL))
          AND ${phaseIn("uploading", "submitted")}
          AND COALESCE(r.attrs->'conversion'->>'suspect_since', '') = ''`)).rows[0]?.n ?? 0);
  }
  return n;
}

const convTs = (field: string): string =>
  `CASE WHEN r.attrs->'conversion'->>'${field}' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (r.attrs->'conversion'->>'${field}')::timestamptz END`;

async function ownersServedAt(ctx: DbCtx, owners: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!owners.length) return out;
  for (const cls of ["open", "closed"] as DataClass[]) {
    const { rows } = await recordsDb(ctx, cls).query(
      `SELECT r.owner_id, max(GREATEST(${convTs("admitted_at")}, ${convTs("submitted_at")})) AS served_at
         FROM records_live r
        WHERE r.owner_id = ANY($1::uuid[]) AND r.type = 'document'
          AND (r.attrs->'conversion' ? 'admitted_at' OR r.attrs->'conversion' ? 'submitted_at')
        GROUP BY r.owner_id`, [owners]);
    for (const r of rows) {
      if (!r.served_at) continue;
      const t = new Date(r.served_at).getTime(), k = String(r.owner_id);
      out.set(k, Math.max(out.get(k) ?? 0, t));
    }
  }
  return out;
}

export async function conversionCandidates(ctx: DbCtx, limit = CONVERSION_CANDIDATES_LIMIT): Promise<ConversionCandidate[]> {
  const all: ConversionCandidate[] = [];
  for (const cls of ["open", "closed"] as DataClass[]) {
    const { rows } = await recordsDb(ctx, cls).query(
      `WITH c AS (
         SELECT r.id, s.status::text AS status, r.owner_id, r.ingested_at,
                CASE WHEN (r.attrs ? 'process_now_at' AND r.attrs->>'process_now_by' IS DISTINCT FROM 'intake') OR ${PHASE} = 'rerun_wait' THEN 0 ELSE 1 END AS priority
           FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
          WHERE s.status IN ('pending','running') AND (${PHASE} = '' OR ${RERUN_DUE}))
       SELECT id, status, owner_id, ingested_at, priority, row_number() OVER (PARTITION BY owner_id ORDER BY ingested_at, id) AS rn
         FROM c ORDER BY priority, rn, ingested_at, id LIMIT $1`, [limit]);
    for (const r of rows) all.push({ cls, record_id: r.id, status: r.status === "running" ? "running" : "pending", owner_id: String(r.owner_id), ingested_at: new Date(r.ingested_at), priority: Number(r.priority) });
  }
  const served = await ownersServedAt(ctx, [...new Set(all.map((c) => c.owner_id))]);
  for (const c of all) { const t = served.get(c.owner_id); c.served_at = t ? new Date(t) : null; }
  return orderConversionCandidates(all).slice(0, limit);
}

async function staleRuns(ctx: DbCtx): Promise<InFlightRun[]> {
  const out: InFlightRun[] = [];
  for (const cls of ["open", "closed"] as DataClass[]) {
    const { rows } = await recordsDb(ctx, cls).query(
      `SELECT r.attrs->'conversion'->>'dc_status' AS dc_status, r.attrs->'conversion'->>'run_started_at' AS run_started_at,
              r.attrs->'conversion'->>'suspect_since' AS suspect_since
         FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
        WHERE s.status IN ('pending','running','failed') AND ${phaseIn("submitted")}
          AND r.attrs->'conversion'->>'run_started_at' ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND (r.attrs->'conversion'->>'run_started_at')::timestamptz < now() - make_interval(secs => $1)
        LIMIT 50`, [STALLED_AFTER_MS / 1000]);
    for (const r of rows) out.push({ dc_status: r.dc_status ?? null, run_started_at: r.run_started_at ?? null, suspect_since: r.suspect_since ?? null });
  }
  return out;
}

export async function conversionStalled(ctx: DbCtx, gate: ConverterGateState, now: Date): Promise<boolean> {
  if (gate.stalled_ignore_until && Date.parse(gate.stalled_ignore_until) > now.getTime()) return false;
  if (gate.last_result_at && now.getTime() - Date.parse(gate.last_result_at) < STALLED_AFTER_MS) return false;
  const runs = await staleRuns(ctx);
  if (!stalledPreconditions(runs, gate, now)) return false;
  const cfg = converterConfig(ctx.settings);
  return cfg ? (await converterHealth(cfg)).ok : false;
}

export const conversionSlots = async (ctx: DbCtx): Promise<ConversionSlots> => {
  const { gate, dbNow } = await readConverterGate(ctx.db.control, ctx.instanceId);
  const holds = await readConverterHolds(ctx.db.control, ctx.instanceId, ctx.settings.get<unknown>("processing.converter_holds", null));
  const stalled = holds === null && gate.new_block !== "mismatch" ? await conversionStalled(ctx, gate, dbNow) : false;
  const w = effectiveWindow({ k: converterWindow(ctx), gate, holds, stalled });
  const [inFlight, candidates] = await Promise.all([conversionInFlight(ctx), conversionCandidates(ctx)]);
  return { free: w.k - inFlight, candidates, inFlight, k: w.k, block: w.block };
};

export interface AdmitResult { admitted: boolean; position: number; free: number; inFlight: number; k: number; block: WindowBlock | null }

const admitLockKey = (instanceId: string): string => `converter_admit:${instanceId}`;

export async function admitConversion(ctx: DbCtx, job: Pick<StageJob, "class" | "record_id">, write: () => Promise<void>): Promise<AdmitResult> {
  const client = await ctx.db.control.connect();
  let clean = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [admitLockKey(ctx.instanceId)]);
    const watch = watchLock(client);
    try {
      const s = await conversionSlots(ctx);
      const position = conversionPosition(s.candidates, job.class, job.record_id);
      const admitted = s.block === null && position < s.free;
      if (admitted) {
        await watch.alive();
        await write();
      }
      return { admitted, position, free: s.free, inFlight: s.inFlight, k: s.k, block: s.block };
    } finally {
      try {
        if (!watch.lost())
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [admitLockKey(ctx.instanceId)]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "converter_admit" });
        }
      } finally { watch.done(); }
    }
  } finally { client.release(!clean); }
}

export async function noteConversionMismatch(ctx: DbCtx, job: Pick<StageJob, "class" | "record_id">, code: string): Promise<{ blocked: boolean; tripped: boolean }> {
  const r = await updateConverterGate(ctx.db.control, ctx.instanceId, (cur, now) => {
    const m = gateNoteMismatch(cur, now, code, job.record_id);
    return { value: m.state, out: m };
  });
  const { tripped, blocked } = r.out;
  log.warn("converter_mismatch", { record_id: job.record_id, code, records: r.after.mismatch?.records.length ?? 0, blocked });
  if (tripped) {
    const others = (r.after.mismatch?.records ?? []).filter((id) => id !== job.record_id);
    for (const cls of ["open", "closed"] as DataClass[]) {
      if (!others.length) break;
      await recordsDb(ctx, cls).query(
        `UPDATE record_stages SET attempts = GREATEST(attempts - 1, 0), updated_at = now()
          WHERE record_id = ANY($1::uuid[]) AND stage = 'converted' AND status IN ('pending','failed') AND NOT terminal AND attempts > 0`, [others])
        .catch((e) => log.warn("converter_mismatch_refund_failed", { class: cls, error: (e as Error).message.slice(0, 120) }));
    }
    log.warn("converter_alert", { reason: "mismatch", code, records: r.after.mismatch?.records.length ?? 0 });
    await conversionEvent(ctx, job, { op: "alert", reason: "mismatch", code, records: r.after.mismatch?.records.length ?? 0 });
  }
  return { blocked, tripped };
}

export async function noteConversionResult(ctx: DbCtx): Promise<void> {
  await updateConverterGate(ctx.db.control, ctx.instanceId, (cur, now) => ({ value: { ...cur, last_result_at: now.toISOString() }, out: null }))
    .catch((e) => log.warn("converter_gate_note_failed", { error: (e as Error).message.slice(0, 120) }));
}

export async function wakeConversionRecord(ctx: DbCtx, schedule: ScheduleFn, cls: DataClass, recordId: string): Promise<"moved" | "scheduled" | "none"> {
  const r = await recordsDb(ctx, cls).query(
    "UPDATE record_stages SET retry_at = NULL WHERE record_id = $1 AND stage = 'converted' AND status = 'pending' RETURNING record_id", [recordId]);
  if (!r.rowCount) return "none";
  const key = `${recordId}:converted:${await versionFor(ctx, "converted")}`;
  const moved = await ctx.db.control.query(
    "UPDATE pgboss.job SET start_after = LEAST(start_after, now()) WHERE name = $1 AND singleton_key = $2 AND state = 'created' RETURNING id",
    [QUEUE_OF.converted, key]);
  if (moved.rowCount) return "moved";
  await schedule(cls, recordId);
  return "scheduled";
}

export async function wakeConversionQueue(ctx: DbCtx, schedule: ScheduleFn, slots: ConversionSlotsFn = conversionSlots): Promise<number> {
  const plan = await slots(ctx);
  if (plan.free <= 0) return 0;
  let woken = 0;
  for (const c of plan.candidates.slice(0, plan.free)) {
    if (c.status !== "pending") continue;
    const how = await wakeConversionRecord(ctx, schedule, c.cls, c.record_id)
      .catch((e) => { log.warn("converter_wake_failed", { record_id: c.record_id, class: c.cls, error: (e as Error).message.slice(0, 120) }); return "none" as const; });
    if (how !== "none") woken++;
  }
  if (woken) log.info("converter_queue_woken", { woken, free: plan.free, candidates: plan.candidates.length });
  return woken;
}
