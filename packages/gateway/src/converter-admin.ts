import type { Context, Hono } from "hono";
import type pg from "pg";
import { capsChanged, capsChangedEvent, classifyConverterError, ConverterClient, converterConfig, converterContract, converterHealth, converterHolds, converterMissing, converterPrincipal,
         converterSettingsFingerprint, converterWaitKind, converterWindowOf, CONVERTER_PRINCIPAL_CHANGED, CONVERTER_RESUME_STALLED_IGNORE_MS, CONVERTER_WAIT_FAIL_HOURS,
         CONVERTER_WAIT_KINDS, CONVERTER_WAIT_WARN_HOURS, effectiveWindow, fallbackTz, instanceTz, GATE_ALERT_AFTER_HOURS, gateAfterProbe, gateAfterResume, gateWithCaps, invalid, log, principalAcked, principalHold,
         readConverterGate, SettingsTypeError, stalledPreconditions, STALLED_AFTER_MS, updateConverterGate, type ConverterGateState, type ConverterHolds,
         type ConverterWaitKind, type InFlightRun, type WindowBlock } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { withSettingsTx } from "./login-policy.ts";
import { withAuditRead } from "./report-search-quality.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
type Cls = "open" | "closed";
const CLASSES: readonly Cls[] = ["open", "closed"];
const SYS = { classes: ["open", "closed"] as const, tier: "system" as const };

/** Time of day for the texts, in the installation's zone: «14:30». */
const hhmm = (at: string | Date, tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
const ms = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);

export const CONVERTER_WAIT_KIND_TITLES: Readonly<Record<ConverterWaitKind, string>> = {
  queue: "queued",
  at_converter: "at the converter",
  doc_error: "the converter has not returned the result for this document yet",
  unavailable: "converter unavailable",
  config: "the converter denied access to the memory’s account",
  hold: "paused by an administrator",
  ocr_rerun: "retrying recognition",
  shaky: "the converter is intermittent",
  storage: "storage unavailable",
  other: "other",
};

export function converterGateText(o: { configured: boolean; gate: ConverterGateState; holds: ConverterHolds; block: WindowBlock | null }, tz: string = fallbackTz()): string {
  const g = o.gate;
  if (!o.configured) return "The converter is not configured. In “Settings”, under integrations, provide its address, account and password. PDF documents are accepted and wait in the queue.";
  if (g.state !== "closed" && g.reason === "config") {
    if (g.why === CONVERTER_PRINCIPAL_CHANGED)
      return "The converter account changed. The new account cannot see documents sent by the old one, so new copies are not created. If the change was intentional, select “Account changed intentionally” and choose “Check connection” to resend the documents.";
    if (g.why === "not_configured") return "The converter is not configured. Enter its address, account and password in “Settings” and choose “Check connection”.";
    return "The converter denied access to the memory’s account. Check the login and password in “Settings” and choose “Check connection”. Documents are waiting.";
  }
  if (g.state !== "closed" && g.reason === "locked")
    return `The converter temporarily locked the memory’s account after failed sign-ins${g.open_until ? ` — sign-ins are blocked until ${hhmm(g.open_until, tz)}` : ""}. Documents are waiting.`;
  if (g.state === "half_open") return "The converter was not responding. We are checking whether it responds now. Documents are waiting and will resume automatically.";
  if (g.state === "open")
    return `The converter has not responded${g.opened_at ? ` since ${hhmm(g.opened_at, tz)}` : ""}. Documents are waiting and will resume automatically${g.open_until ? `; next check at ${hhmm(g.open_until, tz)}` : ""}.`;
  if (o.holds === "all") return "An administrator paused all conversion. Select “Resume” to continue.";
  if (o.holds === "new") return "An administrator paused new documents. Documents already sent to the converter will finish processing. Select “Resume” to lift the pause.";
  if (o.block === "mismatch")
    return "New documents are paused because the converter returned unexpected responses several times in a row. It may have been updated. Documents already sent will finish processing. Check the converter and select “Resume”.";
  if (o.block === "stalled")
    return "New documents are paused because the converter has returned no results for more than 3 hours. Select “Resume” to lift the pause for 3 hours.";
  if (g.recovering) return "Running again. The converter is responding and will receive documents one at a time until the first is ready.";
  return "Running.";
}

export type ConverterLevel = "ok" | "warn" | "fail";
export interface ConverterCheckInput {
  configured: boolean; gate: ConverterGateState; holds: ConverterHolds;
  stalled: boolean; suspect: number; waiting: number; oldest_since: string | null;
}

export function converterCheck(v: ConverterCheckInput, now: Date, tz: string = fallbackTz()): { ok: boolean; level: ConverterLevel; detail: string } {
  const out = (level: ConverterLevel, detail: string) => ({ ok: level !== "fail", level, detail });
  const g = v.gate, t = now.getTime();
  const ageH = v.oldest_since ? Math.max(0, t - ms(v.oldest_since)) / 3600_000 : 0;
  const waitTail = v.waiting ? `; waiting: ${v.waiting}` : "";
  if (!v.configured && !v.waiting) return out("ok", "the document converter is not configured");
  if (g.state !== "closed" && g.reason === "config")
    return out("fail", g.why === CONVERTER_PRINCIPAL_CHANGED ? `the converter account changed and needs administrator confirmation (“Processing”, “Check connection”)${waitTail}`
                                                             : `the converter denied access to the memory’s account. Check the settings and select “Check connection”${waitTail}`);
  if (g.state !== "closed" && g.reason === "locked") return out("fail", `the converter locked the memory’s account${g.open_until ? ` until ${hhmm(g.open_until, tz)}` : ""}${waitTail}`);
  if (g.new_block === "mismatch") return out("fail", `new documents are on hold because the converter returned an unexpected response. Check it and select “Resume”${waitTail}`);
  const unavailable = g.state !== "closed" && g.reason === "unavailable";
  const downH = unavailable && g.opened_at ? Math.max(0, t - ms(g.opened_at)) / 3600_000 : 0;
  if (unavailable && downH >= GATE_ALERT_AFTER_HOURS) return out("fail", `the converter has been unresponsive for more than ${GATE_ALERT_AFTER_HOURS} hours (since ${hhmm(g.opened_at!, tz)})${waitTail}`);
  if (ageH >= CONVERTER_WAIT_FAIL_HOURS) return out("fail", `a document has been waiting for the converter for more than a day${waitTail}`);
  if (!v.configured) return out("warn", `the document converter is not configured${waitTail}`);
  if (unavailable) return out("warn", `the converter has been unresponsive${g.opened_at ? ` since ${hhmm(g.opened_at, tz)}` : ""}. Documents are waiting${waitTail}`);
  if (ageH >= CONVERTER_WAIT_WARN_HOURS) return out("warn", `a document has been waiting for the converter for more than ${CONVERTER_WAIT_WARN_HOURS} hours${waitTail}`);
  if (v.stalled) return out("warn", `the converter has returned no results for more than ${STALLED_AFTER_MS / 3600_000} hours${waitTail}`);
  if (v.suspect) return out("warn", `documents accepted by the converter but waiting too long to start: ${v.suspect}${waitTail}`);
  if (v.holds) return out("ok", `${v.holds === "all" ? "an administrator paused conversion" : "an administrator paused new documents"}${waitTail}`);
  return out("ok", v.waiting ? `running; waiting: ${v.waiting}` : "running");
}

const TS = (f: string): string => `CASE WHEN r.attrs->'conversion'->>'${f}' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (r.attrs->'conversion'->>'${f}')::timestamptz END`;
const SINCE = `CASE WHEN jsonb_typeof(r.attrs->'conversion') = 'object' AND COALESCE(r.attrs->'conversion'->>'status', '') NOT IN ('failed', 'done')
                    THEN COALESCE(${TS("submitted_at")}, ${TS("waiting_since")}, s.updated_at) ELSE s.updated_at END`;
const waitWhy = (a: string): string => `CASE WHEN COALESCE(${a}.last_error, '') LIKE 'converter_wait:%' THEN btrim(split_part(substr(${a}.last_error, 16), ':', 1)) ELSE '' END`;
const WAIT_WHY = waitWhy("s");
const IN_WINDOW = "(r.attrs->'conversion' ? 'phase' AND r.attrs->'conversion'->>'phase' IN ('uploading','submitted'))";

export interface ConverterQueueStats {
  waiting: number; in_flight: number; suspect: number; oldest_since: string | null;
  by_kind: Array<{ kind: ConverterWaitKind; count: number }>;
  stale_runs: InFlightRun[];
}

export async function converterQueueStats(app: Pick<App, "db">): Promise<ConverterQueueStats> {
  const st: ConverterQueueStats = { waiting: 0, in_flight: 0, suspect: 0, oldest_since: null, by_kind: [], stale_runs: [] };
  const kinds = new Map<ConverterWaitKind, number>();
  let oldest = Infinity;
  for (const cls of CLASSES) {
    const db = app.db.records(cls, SYS);
    for (const x of (await db.query(
      `SELECT s.status::text AS status, ${WAIT_WHY} AS why, count(*)::int AS n, min(${SINCE}) AS oldest
         FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
        WHERE s.status IN ('pending','running') GROUP BY 1, 2`)).rows) {
      const kind: ConverterWaitKind = x.status === "running" ? "at_converter" : x.why ? converterWaitKind(`converter_wait:${x.why}`) ?? "other" : "queue";
      kinds.set(kind, (kinds.get(kind) ?? 0) + x.n);
      st.waiting += x.n;
      if (x.oldest) oldest = Math.min(oldest, new Date(x.oldest).getTime());
    }
    const f = (await db.query(
      `SELECT count(*) FILTER (WHERE NOT suspect)::int AS in_flight, count(*) FILTER (WHERE suspect)::int AS suspect
         FROM (SELECT COALESCE(r.attrs->'conversion'->>'suspect_since', '') <> '' AS suspect
                 FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
                WHERE (s.status IN ('pending','running') OR (s.status = 'failed' AND NOT s.terminal AND s.retry_at IS NOT NULL)) AND ${IN_WINDOW}) x`)).rows[0];
    st.in_flight += Number(f?.in_flight ?? 0); st.suspect += Number(f?.suspect ?? 0);
    for (const r of (await db.query(
      `SELECT r.attrs->'conversion'->>'dc_status' AS dc_status, r.attrs->'conversion'->>'run_started_at' AS run_started_at,
              r.attrs->'conversion'->>'suspect_since' AS suspect_since
         FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
        WHERE s.status IN ('pending','running','failed') AND (r.attrs->'conversion' ? 'phase' AND r.attrs->'conversion'->>'phase' IN ('submitted'))
          AND r.attrs->'conversion'->>'run_started_at' ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND (r.attrs->'conversion'->>'run_started_at')::timestamptz < now() - make_interval(secs => $1)
        LIMIT 50`, [STALLED_AFTER_MS / 1000])).rows)
      st.stale_runs.push({ dc_status: r.dc_status ?? null, run_started_at: r.run_started_at ?? null, suspect_since: r.suspect_since ?? null });
  }
  st.oldest_since = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
  st.by_kind = CONVERTER_WAIT_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, count: kinds.get(kind)! }));
  return st;
}

export interface ConverterRecent {
  id: string; class: Cls; type: string; stage_status: string; terminal: boolean; code: string | null; wait: ConverterWaitKind | null;
  conv_status: string | null; phase: string | null; dc_status: string | null; since: string | null; updated_at: string; reruns: number; new_runs: number;
}

export async function converterRecent(app: Pick<App, "db">, limit = 20): Promise<ConverterRecent[]> {
  const all: ConverterRecent[] = [];
  for (const cls of CLASSES) {
    const { rows } = await app.db.records(cls, SYS).query(
      `SELECT r.id, r.type, s.status::text AS stage_status, s.terminal, s.updated_at, NULLIF(split_part(COALESCE(s.last_error, ''), ':', 1), '') AS code, ${WAIT_WHY} AS why,
              c->>'status' AS conv_status, c->>'phase' AS phase, c->>'dc_status' AS dc_status, ${SINCE} AS since,
              CASE WHEN c->>'reruns' ~ '^\\d+$' THEN (c->>'reruns')::int ELSE 0 END AS reruns,
              CASE WHEN jsonb_typeof(c->'prior_runs') = 'array' THEN jsonb_array_length(c->'prior_runs') ELSE 0 END AS new_runs
         FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
        CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(r.attrs->'conversion') = 'object' THEN r.attrs->'conversion' ELSE '{}'::jsonb END AS c) cv
        ORDER BY s.updated_at DESC, r.id LIMIT $1`, [limit]);
    for (const x of rows) all.push({
      id: x.id, class: cls, type: x.type, stage_status: x.stage_status, terminal: x.terminal === true, code: x.code ?? null,
      wait: x.why ? converterWaitKind(`converter_wait:${x.why}`) : null, conv_status: x.conv_status ?? null, phase: x.phase ?? null,
      dc_status: x.dc_status ?? null, since: x.since ? new Date(x.since).toISOString() : null, updated_at: new Date(x.updated_at).toISOString(),
      reruns: Number(x.reruns ?? 0), new_runs: Number(x.new_runs ?? 0),
    });
  }
  return all.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)).slice(0, limit);
}

export const ORPHAN_RUNS_DAYS = 365;
export const ORPHAN_RUNS_SCAN = 5000;

async function converterRefsInUse(app: Pick<App, "db">, docs: readonly string[], runs: readonly string[]): Promise<{ docs: Set<string>; runs: Set<string> }> {
  const used = { docs: new Set<string>(), runs: new Set<string>() };
  if (!docs.length && !runs.length) return used;
  const want = { docs: new Set(docs), runs: new Set(runs) };
  for (const cls of CLASSES) {
    for (const x of (await app.db.records(cls, SYS).query(
      `SELECT attrs->'conversion'->>'document_id' AS d, attrs->'conversion'->>'run_id' AS r, attrs->'conversion'->'lost_document_ids' AS lost
         FROM records WHERE jsonb_typeof(attrs->'conversion') = 'object'
          AND NOT (COALESCE(attrs->'conversion'->>'status', '') = 'failed' AND COALESCE(attrs->'conversion'->>'error_kind', '') = 'open_check')
          AND (attrs->'conversion'->>'document_id' = ANY($1::text[]) OR attrs->'conversion'->>'run_id' = ANY($2::text[])
               OR (jsonb_typeof(attrs->'conversion'->'lost_document_ids') = 'array' AND attrs->'conversion'->'lost_document_ids' ?| $1::text[]))`, [[...docs], [...runs]])).rows) {
      if (x.d && want.docs.has(x.d)) used.docs.add(x.d);
      if (x.r && want.runs.has(x.r)) used.runs.add(x.r);
      if (Array.isArray(x.lost)) for (const l of x.lost) if (typeof l === "string" && want.docs.has(l)) used.docs.add(l);
    }
  }
  return used;
}

export async function converterJournal(app: App): Promise<{ uploads_30d: { count: number; bytes: number } | null; orphan_runs: { count: number; days: number; items: Array<Record<string, unknown>> } | null }> {
  type Orphan = { at: string; record_id: string | null; run_id: string | null; document_id: string | null; why: string | null };
  let read: { uploads: { count: number; bytes: number }; events: Orphan[] };
  try {
    read = await withAuditRead(app, async (q: pg.PoolClient) => {
      const u = (await q.query(
        `SELECT count(*)::int AS n, COALESCE(sum(CASE WHEN details->>'bytes' ~ '^\\d{1,15}$' THEN (details->>'bytes')::bigint END), 0)::bigint AS bytes
           FROM audit_events WHERE event_type = 'processing' AND at > now() - interval '30 days' AND instance_id = $1
            AND details->>'job' = 'conversion' AND details->>'op' = 'uploaded'`, [app.instanceId])).rows[0];
      const events = (await q.query(
        `SELECT at, record_ids[1] AS record_id, details->>'run_id' AS run_id, details->>'document_id' AS document_id, details->>'why' AS why
           FROM audit_events WHERE event_type = 'processing' AND at > now() - make_interval(days => $2) AND instance_id = $1
            AND details->>'job' = 'conversion' AND details->>'op' = 'orphan_run' ORDER BY at DESC LIMIT $3`, [app.instanceId, ORPHAN_RUNS_DAYS, ORPHAN_RUNS_SCAN])).rows;
      return { uploads: { count: Number(u?.n ?? 0), bytes: Number(u?.bytes ?? 0) },
               events: events.map((x) => ({ at: new Date(x.at).toISOString(), record_id: x.record_id ?? null, run_id: x.run_id ?? null, document_id: x.document_id ?? null, why: x.why ?? null })) };
    });
  } catch (e) {
    log.warn("converter_journal_unreadable", { error: (e as Error).message.slice(0, 160) });
    return { uploads_30d: null, orphan_runs: null };
  }
  const latest = new Map<string, Orphan>();
  for (const x of read.events) {
    const key = x.document_id ? `d:${x.document_id}` : x.run_id ? `r:${x.run_id}` : null;
    if (key && !latest.has(key)) latest.set(key, x);
  }
  const cands = [...latest.values()];
  try {
    const used = await converterRefsInUse(app, [...new Set(cands.map((x) => x.document_id).filter((x): x is string => !!x))],
                                          [...new Set(cands.map((x) => x.run_id).filter((x): x is string => !!x))]);
    const free = cands.filter((x) => !(x.document_id && used.docs.has(x.document_id)) && !(x.run_id && used.runs.has(x.run_id)));
    return { uploads_30d: read.uploads, orphan_runs: { count: free.length, days: ORPHAN_RUNS_DAYS, items: free.slice(0, 20) } };
  } catch (e) {
    log.warn("converter_orphans_unchecked", { error: (e as Error).message.slice(0, 160) });
    return { uploads_30d: read.uploads, orphan_runs: null };
  }
}

export interface ConverterView {
  checked_at: string;
  configured: boolean; missing: string[];
  gate: {
    state: ConverterGateState["state"]; reason: ConverterGateState["reason"]; why: string | null; text: string;
    opened_at: string | null; open_until: string | null; streak: number; last_ok_at: string | null; last_result_at: string | null; health_ok_at: string | null;
    recovering: boolean; new_block: "mismatch" | null; mismatch_code: string | null; stalled_ignore_until: string | null;
    principal_known: boolean; principal_hold: boolean; principal_acked: boolean;
  };
  holds: ConverterHolds;
  caps: ConverterGateState["caps"];
  window: { k: number; k_eff: number; block: WindowBlock | null; in_flight: number; suspect: number; stalled: boolean };
  queue: { waiting: number; oldest_since: string | null; by_kind: Array<{ kind: ConverterWaitKind; title: string; count: number }> };
  recent: ConverterRecent[];
  uploads_30d: { count: number; bytes: number } | null;
  orphan_runs: { count: number; days: number; items: Array<Record<string, unknown>> } | null;
  health: { ok: boolean; level: ConverterLevel; detail: string };
  dc?: { health: { ok: boolean; status: number | null }; contract: { ok: boolean; status: number | null; version: string | null; fast_lane: boolean } } | null;
}

async function converterBasics(app: Pick<App, "db" | "instanceId" | "settings">) {
  const [{ gate, dbNow }, q] = await Promise.all([readConverterGate(app.db.control, app.instanceId), converterQueueStats(app)]);
  const holds = converterHolds(app.settings.get<unknown>("processing.converter_holds", null));
  const cfg = converterConfig(app.settings);
  const pre = stalledPreconditions(q.stale_runs, gate, dbNow);
  return { gate, dbNow, q, holds, cfg, pre };
}

export async function converterView(app: App, o: { live?: boolean } = {}): Promise<ConverterView> {
  const { gate, dbNow, q, holds, cfg, pre } = await converterBasics(app);
  const stalled = pre && holds === null && gate.new_block !== "mismatch" && cfg ? (await converterHealth(cfg)).ok : false;
  const k = converterWindowOf(app.settings);
  const w = effectiveWindow({ k, gate, holds, stalled });
  const [recent, journal] = await Promise.all([converterRecent(app), converterJournal(app)]);
  const live = o.live && cfg ? await Promise.all([converterHealth(cfg, { force: true }), converterContract(cfg, { force: true })]) : null;
  return {
    checked_at: dbNow.toISOString(),
    configured: cfg !== null, missing: cfg ? [] : converterMissing(app.settings),
    gate: {
      state: gate.state, reason: gate.reason, why: gate.why, text: converterGateText({ configured: cfg !== null, gate, holds, block: w.block }, instanceTz(app.settings)),
      opened_at: gate.opened_at, open_until: gate.open_until, streak: gate.streak, last_ok_at: gate.last_ok_at, last_result_at: gate.last_result_at, health_ok_at: gate.health_ok_at,
      recovering: gate.recovering, new_block: gate.new_block, mismatch_code: gate.mismatch?.code ?? null, stalled_ignore_until: gate.stalled_ignore_until,
      principal_known: Boolean(gate.principal), principal_hold: principalHold(gate), principal_acked: principalAcked(gate),
    },
    holds, caps: gate.caps,
    window: { k, k_eff: w.k, block: w.block, in_flight: q.in_flight, suspect: q.suspect, stalled },
    queue: { waiting: q.waiting, oldest_since: q.oldest_since, by_kind: q.by_kind.map((x) => ({ ...x, title: CONVERTER_WAIT_KIND_TITLES[x.kind] })) },
    recent, ...journal,
    health: converterCheck({ configured: cfg !== null, gate, holds, stalled: pre, suspect: q.suspect, waiting: q.waiting, oldest_since: q.oldest_since }, dbNow, instanceTz(app.settings)),
    ...(o.live ? { dc: live ? { health: { ok: live[0].ok, status: live[0].status },
                                contract: { ok: live[1].ok, status: live[1].status, version: live[1].version, fast_lane: live[1].fast_lane } } : null } : {}),
  };
}

export async function converterHealthCheck(app: Pick<App, "db" | "instanceId" | "settings">): Promise<{ ok: boolean; level: ConverterLevel; detail: string }> {
  const { gate, dbNow, q, holds, cfg, pre } = await converterBasics(app);
  return converterCheck({ configured: cfg !== null, gate, holds, stalled: pre, suspect: q.suspect, waiting: q.waiting, oldest_since: q.oldest_since }, dbNow, instanceTz(app.settings));
}

export interface WaitingConverterGroup { total: number; oldest_since: string | null; kinds: Array<{ kind: ConverterWaitKind; title: string; count: number; codes: string[] }> }

export async function waitingConverterGroup(app: Pick<App, "db">, cls: Cls | null = null): Promise<WaitingConverterGroup> {
  const kinds = new Map<ConverterWaitKind, { count: number; codes: Set<string> }>();
  let total = 0, oldest = Infinity;
  for (const k of CLASSES) {
    if (cls && cls !== k) continue;
    for (const x of (await app.db.records(k, SYS).query(
      `SELECT ${WAIT_WHY} AS why, count(*)::int AS n, min(${SINCE}) AS oldest
         FROM records_live r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'converted'
        WHERE s.status = 'pending' AND COALESCE(s.last_error, '') LIKE 'converter_wait:%' GROUP BY 1`)).rows) {
      const kind = converterWaitKind(`converter_wait:${x.why}`) ?? "other";
      const slot = kinds.get(kind) ?? { count: 0, codes: new Set<string>() };
      slot.count += x.n; if (x.why) slot.codes.add(x.why);
      kinds.set(kind, slot);
      total += x.n;
      if (x.oldest) oldest = Math.min(oldest, new Date(x.oldest).getTime());
    }
  }
  return { total, oldest_since: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
           kinds: CONVERTER_WAIT_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, title: CONVERTER_WAIT_KIND_TITLES[kind], count: kinds.get(kind)!.count, codes: [...kinds.get(kind)!.codes].sort() })) };
}

export async function wakeConverterWaiting(db: Pick<pg.Pool, "query">, filter: { sql: string; args: unknown[] }, o: { running?: boolean; limit?: number; waitingOnly?: boolean } = {}): Promise<{ pending: string[]; running: string[] }> {
  const cond = `s.stage = 'converted' AND s.status = 'pending'
        AND (COALESCE(s.last_error, '') LIKE 'converter_wait:%'${o.waitingOnly ? "" : " OR s.retry_at IS NOT NULL OR s.busy_retries > 0"})`;
  const capped = o.limit !== undefined;
  const pick = capped ? ` AND s.record_id IN (SELECT s.record_id FROM record_stages s JOIN records_live r ON r.id = s.record_id WHERE ${cond} AND ${filter.sql}
                                               ORDER BY s.updated_at, s.record_id LIMIT $${filter.args.length + 1})` : "";
  const pending = capped && o.limit! <= 0 ? [] : [...new Set((await db.query(
    `UPDATE record_stages s SET retry_at = NULL, updated_at = now()
       FROM records_live r WHERE r.id = s.record_id AND ${cond}
        AND ${filter.sql}${pick}
     RETURNING s.record_id`, capped ? [...filter.args, o.limit] : filter.args)).rows.map((x) => x.record_id as string))];
  const running = o.running ? (await db.query(
    `SELECT s.record_id FROM record_stages s JOIN records_live r ON r.id = s.record_id
      WHERE s.stage = 'converted' AND s.status = 'running' AND ${filter.sql}`, filter.args)).rows.map((x) => x.record_id as string).filter((id) => !pending.includes(id)) : [];
  const ids = [...pending, ...running];
  if (ids.length) await db.query("UPDATE records SET attrs = attrs || jsonb_build_object('wake_requested_at', now()) WHERE id = ANY($1::uuid[])", [ids]);
  return { pending, running };
}

async function kickWoken(app: App, cls: Cls, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const db = app.db.records(cls, SYS);
  const lanes = new Map((await db.query("SELECT id, attrs ? 'process_now_at' AS now FROM records WHERE id = ANY($1::uuid[])", [ids])).rows.map((x) => [x.id as string, x.now === true]));
  let kicked = 0;
  for (const id of ids) {
    try { await app.queue.kick({ instance: app.instanceId, class: cls, record_id: id, lane: lanes.get(id) ? "now" : "night" }); kicked++; }
    catch (e) { log.warn("converter_wake_kick_failed", { record_id: id, error: (e as Error).message.slice(0, 120) }); }
  }
  return kicked;
}

export const WAKE_AFTER_ACTION_MAX = 200;

export async function wakeByReason(app: App, whys: readonly string[]): Promise<{ woken: number; kicked: number }> {
  let woken = 0, kicked = 0;
  for (const cls of CLASSES) {
    const left = WAKE_AFTER_ACTION_MAX - woken;
    if (left <= 0) break;
    const r = await wakeConverterWaiting(app.db.records(cls, SYS), {
      sql: `s.record_id IN (SELECT s2.record_id FROM record_stages s2 WHERE s2.stage = 'converted' AND s2.status = 'pending' AND ${waitWhy("s2")} = ANY($1::text[])
                             ORDER BY s2.updated_at LIMIT $2)`, args: [[...whys], left] });
    woken += r.pending.length;
    kicked += await kickWoken(app, cls, r.pending);
  }
  return { woken, kicked };
}

export async function checkConverterNow(app: App, o: { recordId?: string | null; limit?: number } = {}): Promise<{ woken: number; kicked: number; left: number }> {
  const limit = o.limit ?? WAKE_AFTER_ACTION_MAX;
  let woken = 0, kicked = 0;
  for (const cls of CLASSES) {
    const db = app.db.records(cls, SYS);
    const r = o.recordId
      ? await wakeConverterWaiting(db, { sql: "s.record_id = $1::uuid", args: [o.recordId] }, { running: true })
      : await wakeConverterWaiting(db, { sql: "TRUE", args: [] }, { limit: limit - woken, waitingOnly: true });
    woken += r.pending.length + r.running.length;
    kicked += await kickWoken(app, cls, r.pending);
  }
  let left = 0;
  if (!o.recordId && woken >= limit)
    for (const cls of CLASSES)
      left += Number((await app.db.records(cls, SYS).query(
        `SELECT count(*)::int AS n FROM record_stages s JOIN records_live r ON r.id = s.record_id
          WHERE s.stage = 'converted' AND s.status = 'pending' AND COALESCE(s.last_error, '') LIKE 'converter_wait:%' AND s.retry_at IS NOT NULL`)).rows[0]?.n ?? 0);
  return { woken, kicked, left };
}

const PROBE_TEXT = {
  not_configured: "The converter is not configured. Enter its address, account and password in “Settings”.",
  unavailable: "The converter is not responding. The connection check without sign-in failed. Documents are waiting and will resume automatically when it responds.",
  rejected: "The converter denied access to the memory’s account. Check the login and password in “Settings”.",
  locked: "The converter temporarily locked the memory’s account after failed sign-ins. Try again later.",
  failed: "The connection check failed. The converter returned an unexpected response.",
  needs_confirm: "Sign-in succeeded, but the converter account changed and cannot see documents sent by the previous account. If the change was intentional, select “Account changed intentionally” and check again to resend the documents.",
  ok: "The connection works.",
} as const;
type ProbeOutcome = keyof typeof PROBE_TEXT;

async function jsonBody(c: Context<any>): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  let b: unknown;
  try { b = JSON.parse(raw); } catch { throw invalid("The request body is not JSON"); }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("The request body must be a JSON object");
  return b as Record<string, unknown>;
}

const conversionEvent = (app: App, caller: Caller, details: Record<string, unknown>) =>
  audit(app, caller, { event_type: "processing", details: { job: "conversion", by: "admin", ...details } });

async function setHolds(app: App, value: ConverterHolds): Promise<ConverterHolds> {
  const before = converterHolds(app.settings.get<unknown>("processing.converter_holds", null));
  if (before === value) return before;
  await withSettingsTx(app, [], async (_q, settings) => {
    try { if (!(await settings.set("processing", "converter_holds", value, null))) throw invalid("The database does not contain processing.converter_holds"); }
    catch (e) { if (e instanceof SettingsTypeError) throw invalid(e.message); throw e; }
  });
  return before;
}

export function registerConverterAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit, onChange: () => void = () => undefined): void {
  r.get("/converter", async (c) => {
    const live = c.req.query("live");
    if (live !== undefined && live !== "" && live !== "0" && live !== "1") throw invalid("live: 0 or 1");
    await app.settings.load();
    return c.json(await converterView(app, { live: live === "1" }));
  });

  r.post("/converter/hold", async (c) => {
    const b = await jsonBody(c);
    if (b.scope !== "new" && b.scope !== "all") throw invalid("scope: new (new documents wait, and sent documents finish) or all (all processing stops)");
    const before = await setHolds(app, b.scope);
    onChange();
    if (before !== b.scope) await adminAudit(c, "converter_hold", { scope: b.scope, previous: before });
    return c.json({ holds: b.scope, previous: before });
  });

  r.post("/converter/resume", async (c) => {
    const previous = await setHolds(app, null);
    const g = await updateConverterGate(app.db.control, app.instanceId, (cur, now) => ({ value: gateAfterResume(cur, now, CONVERTER_RESUME_STALLED_IGNORE_MS), out: null }));
    const woke = await wakeByReason(app, ["hold", "hold_new", "mismatch", "stalled"]);
    onChange();
    await adminAudit(c, "converter_resume", { holds_cleared: previous, new_block_cleared: g.before.new_block, mismatch_code: g.before.mismatch?.code ?? null,
                                              stalled_ignore_until: g.after.stalled_ignore_until, woken: woke.woken });
    return c.json({ holds: null, previous_holds: previous, new_block_cleared: g.before.new_block, stalled_ignore_until: g.after.stalled_ignore_until, woken: woke.woken });
  });

  r.post("/converter/check-now", async (c) => {
    const b = await jsonBody(c);
    if (b.record_id !== undefined && !(typeof b.record_id === "string" && /^[0-9a-fA-F-]{36}$/.test(b.record_id))) throw invalid("record_id: record UUID");
    const recordId = typeof b.record_id === "string" ? b.record_id.toLowerCase() : null;
    const out = await checkConverterNow(app, { recordId });
    await adminAudit(c, "converter_check_now", { woken: out.woken, kicked: out.kicked, left: out.left, one_record: recordId !== null });
    return c.json(out);
  });

  r.post("/converter/probe", async (c) => {
    const b = await jsonBody(c);
    if (b.confirm_new_principal !== undefined && typeof b.confirm_new_principal !== "boolean") throw invalid("confirm_new_principal: true or false");
    const confirm = b.confirm_new_principal === true;
    await app.settings.load(true);
    const url = app.settings.str("integrations.converter_url");
    if (!url) throw invalid("The document converter is not configured. Set integrations.converter_url");
    const cfg = converterConfig(app.settings);
    const started = Date.now();
    const done = async (outcome: ProbeOutcome, extra: Record<string, unknown> = {}, auditExtra: Record<string, unknown> = {}) => {
      onChange();
      await adminAudit(c, "converter_probe", { outcome, confirm, latency_ms: Date.now() - started, ...auditExtra });
      const view = await converterView(app);
      return c.json({ ok: outcome === "ok" && !(extra.missing_roles as string[] | undefined)?.length, outcome, text: PROBE_TEXT[outcome], latency_ms: Date.now() - started, ...extra, gate: view.gate, caps: view.caps });
    };
    if (!cfg) return done("not_configured", { missing: converterMissing(app.settings) });
    const [health, contract] = await Promise.all([converterHealth(cfg, { force: true }), converterContract(cfg, { force: true })]);
    const dc = { health: { ok: health.ok, status: health.status }, contract: { ok: contract.ok, status: contract.status, version: contract.version, fast_lane: contract.fast_lane } };
    if (!health.ok) return done("unavailable", dc, { health_status: health.status, contract_ok: contract.ok });
    const client = new ConverterClient({ ...cfg, requestTimeoutMs: Math.min(cfg.requestTimeoutMs, 10_000) });
    let principal: string | null = null, missing: string[] = [];
    try {
      const user = await client.login();
      principal = client.principal ?? converterPrincipal(user?.user_id);
      missing = ConverterClient.missingRoles(user ?? { roles: [] });
    } catch (e) {
      const k = classifyConverterError(e);
      const outcome: ProbeOutcome = k.cls === "config" ? "rejected" : k.cls === "locked" ? "locked" : k.cls === "unavailable" ? "unavailable" : "failed";
      log.info("converter_probe_failed", { outcome, code: k.code });
      return done(outcome, dc, { code: k.code, contract_ok: contract.ok });
    }
    const settingsFp = converterSettingsFingerprint(cfg);
    const g = await updateConverterGate(app.db.control, app.instanceId, (cur, now) => {
      const p = gateAfterProbe(cur, now, { principal, settingsFp, confirm });
      return { value: contract.ok ? gateWithCaps(p.state, now, contract) : p.state, out: p };
    });
    const caller = c.get("caller") as Caller;
    if (g.before.state !== "closed" && g.after.state === "closed")
      await conversionEvent(app, caller, { op: "gate_close", reason: g.before.reason, why: g.before.why });
    if (g.out.confirmed) await conversionEvent(app, caller, { op: "principal_changed", confirmed: true });
    if (contract.ok && capsChanged(g.before.caps, contract)) await conversionEvent(app, caller, capsChangedEvent(g.before.caps, contract));
    const woke = g.before.state !== "closed" && g.after.state === "closed" ? await wakeByReason(app, ["config", "locked", "unavailable", "throttled"]) : { woken: 0, kicked: 0 };
    return done(g.out.outcome, { ...dc, principal_changed: g.out.principalChanged, confirmed: g.out.confirmed, woken: woke.woken, ...(missing.length ? { missing_roles: missing } : {}) },
                { principal_changed: g.out.principalChanged, confirmed: g.out.confirmed, gate_closed: g.before.state !== "closed" && g.after.state === "closed",
                  contract_ok: contract.ok, ...(missing.length ? { missing_roles: missing } : {}), woken: woke.woken });
  });
}
