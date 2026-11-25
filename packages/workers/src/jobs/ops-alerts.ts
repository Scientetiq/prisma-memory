// The 1d alerts job: alert_detectors, every 15 s. One alert core — admin_alerts
// rows come here from the journal and from detectors without their own event; mails are queued by the job
// alert_mail / alert_digest (jobs/alert-digest.ts).
//
// Step 1. Journal feed. audit_alert_feed (13) gives events with details.code after the cursor (arrival order
// received_at, id) — with two cursors: inside events (cursor — the alert_feed_cursor columns) are read first,
// edge events (edge_event; cursor — detectors.edge_cursor) next, with their own budget. A captured edge's event stream
// does not delay urgent reconciler, intake and sign-in check alerts. The feed gives all coded events; the cursor passes
// those that become no alert (info, metric): else each query would reread them from the cursor.
// A code becomes an alert if contracts/edge/audit-codes.json lists it at level page, high or medium, its section is not 1a
// (FEED_SKIP_STAGES: 1a raises its alerts itself via raiseAlert), source not ops-event (the host script writes
// the alert itself), the event type is not admin (raiseAlert echo, admin-plane journal). A code is tied to its source:
// an edge event is raised only if the code's sources include an edge process (edge-mcp, edge-auth, edge-logpump), and
// an inside event only if they include a non-edge process; the rest is counted (rejected), one log line per pass.
// The edge cannot forge canary_trip or service_silent.
// Grouped by (code, subject): subject — person_id, connection_id, service, program or network from detail
// (alertSubject; for an edge event only ids and words, edgeSafeValue, with the prefix «edge:»: edge rows are not
// grouped with rows of inside services); none — «*» («edge:*»). While the alert is open, a repeat adds to count,
// moves last_at; summary and details stay from the first event (one row per pair, admin_alerts_open_subject_idx;
// the worker has no way to update them — it may change only count, last_at, status). Repeats
// of one pair in a batch add up in memory and go in one UPDATE. New subjects of one code — at most
// NEW_SUBJECTS_PER_CODE an hour, edge events of all codes — at most EDGE_NEW_PER_HOUR an hour (counted in the
// detectors' state, not per pass); then into «*»: a captured edge cannot flood the alert table with rows. summary and
// details hold only the code's detail_keys (alertDetail): no links or edge texts reach a mail. Cursors and alerts
// are written in one transaction: a crash mid-pass loses nothing and repeats nothing.
// Step 2. Detectors without an event:
//   - service_silent — heartbeat older than SILENT_AFTER_SEC (memory-authcheck 120 s; export, intake, reconciler and probe
//     300 s); one alert per silence episode; alive again — the alert closes (status closed). Only for services that must
//     run under the current flags (serviceExpected): with the edge contour off, its stopped services are no alert,
//     an open alert about them is closed;
//   - service_silent for edge-logpump — no egress_pump_alive from the edge for over LOGPUMP_SILENT_SEC with
//     the contour on: the edge kernel log parser is blind, edge attempts to reach the network go unseen;
//   - cert_expiring — heartbeat detail.cert_not_after closer than CERT_WARN_DAYS; one alert per cert term, a new
//     certificate — closed; also only for services that must run (subject service:<service>);
//   - cert_expiring for leaves and roots (certStep) — a separate step with the subjects cert:<name>,
//     cert-check:<name> and cert-apply:<name>: 60 and 30 day steps by host facts, with the contour off too;
//   - mfa_mode_weakened / mfa_mode_strengthened — new rows of the second-factor mode journal (mfa_mode_changes), at least
//     MFA_LAG_SEC old: a row with an earlier time that committed later is not skipped by the cursor;
//   - anchors_signers_root_changed — detail.anchors_root_sha256 changed in a service heartbeat (including the rows
//     «edge» and «memory-relay» written by the reconciler): the old fingerprint is from the detectors' state; no key —
//     no alert, and the old fingerprint is kept (a silent edge is not a root change). The repeat key is per change
//     (old, new, heartbeat time), not per new root: a return to a root that already had an alert is again
//     an alert; a second change before «Accepted» repeats the same row (count + 1, last_at; details keep the first pair);
//   - connections_many_new — hourly: a person has more than edge.max_new_connections_alert_day new connections a day
//     from outside (origin edge); the synthetic sign-in account is not counted; one alert or repeat per person a day;
//   - connection_new_network — a live outside connection shows a new /16 network (connection_networks; intake writes it
//     by connection_network_seen); a connection's first network is no alert; a network without a live connection —
//     a mark without an alert; new connection subjects per pass — at most NETWORK_ALERTS_PER_PASS, then «*»;
//     edge.geo_alert_enabled = false — silent. Alerts by country and provider network (connection_new_country, _asn) need
//     a GeoIP database: no reader for it without a new package; with edge.geoip_db_path set — a log line and the same alert
//     by /16.
// Host facts (host_mode_facts; ops events only) are no alert: the time of the last event is kept for the digest; the facts
// are shown by the panel (gateway/src/ops-alerts-admin.ts). The detectors' state is alert_feed_cursor.detectors (12):
// times, fingerprints, ids and the budget count, no people or texts.
// First run (no cursor row) — from the current place of the journal, without history (like the journal export): else
// the first rollout would raise alerts on all events since 13 was applied. The edge cursor starts at the
// inside cursor (there was one feed).
// Alerts hold codes, numbers and ids from the feed's allow list; no record texts, queries or full addresses.
import { instanceLocale } from "@memory/i18n/context";
import { ALERT_LEVELS, alertCodeInfo, alertDetail, alertSubject, anySubject, EDGE_SUBJECT_PREFIX, edgeOrigin, FEED_SKIP_EVENT_TYPES, feedCodes,
         innerOrigin, log, newId, opsCode, tx, type OpsLevel } from "@memory/shared";
import type pg from "pg";
import type { Ctx, DbCtx } from "../ctx.ts";
import { alertDigestPass } from "./alert-digest.ts";

/** Pass interval: «at once» for high means the feed + 15 s of mail. */
export const ALERT_DETECTORS_EVERY_MS = 15_000;
/** Feed events per query (the function gives at most 1000) and queries per pass — for each cursor. */
export const FEED_BATCH = 500;
export const FEED_ROUNDS = 10;
/** New grouping subjects per code per hour; then the code's events go to subject «*». */
export const NEW_SUBJECTS_PER_CODE = 20;
/** New alert rows from edge events (all codes together) per hour; then into «edge:*» of the code. */
export const EDGE_NEW_PER_HOUR = 100;
/** A heartbeat older than this — the service is silent. */
export const SILENT_AFTER_SEC: Readonly<Record<string, number>> = {
  "memory-authcheck": 120, exporter: 300, intake: 300, reconciler: 300, "memory-probe": 300,
};
/** No edge-logpump sign of life (every 5 minutes) for longer — the edge kernel log parser is blind. */
export const LOGPUMP_SILENT_SEC = 900;
export const LOGPUMP_SERVICE = "edge-logpump";
/** edge-logpump sign-of-life code (contracts/edge/audit-codes.json, info). */
export const EGRESS_ALIVE_CODE = "egress_pump_alive";
/** A cert expiring sooner than this — alert. */
export const CERT_WARN_DAYS = 30;
/** The «many new connections» pass — hourly. */
export const MANY_NEW_EVERY_MS = 3_600_000;
/** A second-factor mode row younger than this waits (its transaction may not have committed yet). */
export const MFA_LAG_SEC = 30;
/** New connection subjects of the «new network» alert per pass; then «*». */
export const NETWORK_ALERTS_PER_PASS = 20;
/** The «Digest now» queue (gateway: POST /api/v1/admin/alerts/digest-now). */
export const DIGEST_NOW_QUEUE = "alert_digest";
/** No subject, or grouping overflow. */
export const ANY_SUBJECT = "*";
const DAY_MS = 86_400_000;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
/** Time as text with microseconds (as in Postgres): Date drops them, and the (time, id) cursor would retake the last row. */
const usKey = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const MFA_RANK: Readonly<Record<string, number>> = { off: 0, optional: 1, required: 2 };
const iso = (d: Date | string): string => new Date(d).toISOString();

/** A row of audit_alert_feed. */
export interface FeedRow { id: string; at: Date; received_key: string; event_type: string; code: string; detail: Record<string, unknown> }

/** Feed cursor: arrival time as text with microseconds and the event id. */
export interface Cursor { at: string | null; id: string | null }

/** The hourly budget of new subjects. */
export interface SubjectBudget { hour: string; codes: Record<string, number>; edge: number }

/** The detectors' state (alert_feed_cursor.detectors). */
export interface DetectorState {
  silent?: Record<string, string>;
  cert?: Record<string, string>;
  mfa?: { at: string; id: string };
  roots?: Record<string, string>;
  many_at?: string;
  host_facts_at?: string;
  geoip_warned?: boolean;
  /** edge events cursor (edge_event) */
  edge_cursor?: Cursor;
  budget?: SubjectBudget;
  /** last edge-logpump sign of life (edge time in the journal) */
  logpump_at?: string;
  /** when the edge contour went on (edge-logpump silence counts from then to its first sign of life) */
  contour_at?: string;
  /** certificate terms by name (the cert_expiring step); `@edge` — the confirmation of the edge leaves */
  certs?: Record<string, CertName>;
  /** when the terms step saw the facts, and the host facts' time */
  certs_at?: string;
  certs_facts?: string;
  /** cached «edge was prepared» sign from the journal (an empty state rereads it); certs_scan — how far it looked */
  certs_prepared?: boolean;
  certs_scan?: string;
}

/** Terms step state for one name (short keys — the state limit is 16 KiB). */
export interface CertName {
  /** confirmed term: the running side showed the certificate (for now — the edge leaves, row tls_served) */
  c?: string;
  /** provisional term — the first date by file, while the name has no source of confirmation */
  p?: string;
  /** prepared term by the file seen last (an episode of waiting for confirmation) */
  q?: string;
  /** time of the last confirmation or read date (the «stale» episode) */
  t?: string;
  /** last alert of the step «<term>:<step>» */
  a?: string;
  /** pass since which the name waits undated */
  x?: string;
  /** pass since which the prepared term is unconfirmed */
  w?: string;
  /** stale episode already alerted on */
  s?: string;
  /** unconfirmed episode already alerted on */
  u?: string;
}

export interface DetectorsResult { feed: number; raised: number; grouped: number; rejected: number; detectors: string[]; closed: number; skipped?: string }

type Q = Pick<pg.PoolClient, "query">;

/** Short alert line: the code's title and detail pairs (simple values only), up to 300 chars. detail — already by alertDetail. */
export function feedSummary(code: string, detail: Record<string, unknown>): string {
  const info = alertCodeInfo(code);
  const title = (instanceLocale() === "ru" ? info?.title_ru || info?.title : info?.title) || code;
  const pairs = Object.entries(detail).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}: ${String(v).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 64)}`);
  const s = pairs.length ? `${title} (${pairs.join(", ")})` : title;
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** Alert level of a feed code; not an alert (metric, info, unknown) — null. */
export function feedLevel(code: string): OpsLevel | null {
  const c = opsCode(code);
  return c && ALERT_LEVELS.includes(c.level) ? c.level : null;
}

/** The event code fits its origin: an edge event needs an edge code, an inside event a code of an inside service. */
export function originOk(code: string, eventType: string): boolean {
  return eventType === "edge_event" ? edgeOrigin(code) : innerOrigin(code);
}

/**
 * Grouping in admin_alerts: new row (inserted) or repeat of the open one (count + n, last_at). Returns
 * its id.
 */
export async function groupAlert(q: Q, a: { instanceId: string; code: string; level: string; subject: string; summary: string;
                                            details: Record<string, unknown>; at: Date; n?: number }): Promise<{ id: string; inserted: boolean }> {
  const n = Math.max(1, Math.trunc(a.n ?? 1));
  const r = await q.query(
    `INSERT INTO admin_alerts (id, instance_id, at, level, code, summary, details, subject, count, first_at, last_at)
     VALUES ($1, $2, least($3::timestamptz, now()), $4, $5, $6, $7::jsonb, $8, $9, least($3::timestamptz, now()), least($3::timestamptz, now()))
     ON CONFLICT (instance_id, code, subject) WHERE status = 'open' AND subject IS NOT NULL
     DO UPDATE SET count = admin_alerts.count + EXCLUDED.count, last_at = GREATEST(admin_alerts.last_at, EXCLUDED.last_at)
     RETURNING id::text AS id, (xmax = 0) AS inserted`,
    [newId(), a.instanceId, a.at, a.level, a.code, a.summary.slice(0, 300), JSON.stringify(a.details), a.subject.slice(0, 128), n]);
  return { id: r.rows[0]!.id as string, inserted: r.rows[0]?.inserted === true };
}

/**
 * Detector alert: repeat key (dedupeKey) seen before — nothing (false). If an open alert of the same code and subject
 * exists (last episode not handled), the repeat joins it (count + 1, last_at): a second root change while the first
 * is unaccepted is not lost: the repeat count and last time show it. One key per detector event (change, episode); its
 * uniqueness is the detector's care. A new row echoes into the admin journal (op alert), like raiseAlert: the feed does
 * not raise them. true — new row.
 */
export async function detectorAlert(ctx: DbCtx, q: Q, a: { code: string; level: string; subject: string; summary: string;
                                                         details: Record<string, unknown>; dedupeKey: string }): Promise<boolean> {
  const key = a.dedupeKey.slice(0, 200);
  if ((await q.query("SELECT 1 FROM admin_alerts WHERE instance_id = $1 AND dedupe_key = $2", [ctx.instanceId, key])).rowCount) return false;
  const id = newId();
  const r = await q.query(
    `INSERT INTO admin_alerts (id, instance_id, level, code, summary, details, subject, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (instance_id, code, subject) WHERE status = 'open' AND subject IS NOT NULL
     DO UPDATE SET count = admin_alerts.count + 1, last_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [id, ctx.instanceId, a.level, a.code, a.summary.slice(0, 300), JSON.stringify(a.details), a.subject.slice(0, 128), key]);
  if (!r.rows[0]?.inserted) return false;
  await ctx.db.audit.query(
    `INSERT INTO audit_events (id, instance_id, event_type, principal_type, details) VALUES ($1, $2, 'admin', 'system', $3::jsonb)`,
    [newId(), ctx.instanceId, JSON.stringify({ op: "alert", code: a.code, level: a.level, alert: id })],
  ).catch((e: unknown) => log.error("audit_write_failed", { event_type: "admin", op: "alert", error: ((e as Error)?.message ?? "").slice(0, 200) }));
  log.warn("admin_alert", { code: a.code, alert_level: a.level, alert: id });
  return true;
}

/** Close the open alert of code and subject: the state passed. */
async function closeAlert(q: Q, instanceId: string, code: string, subject: string): Promise<number> {
  return (await q.query("UPDATE admin_alerts SET status = 'closed' WHERE instance_id = $1 AND code = $2 AND subject = $3 AND status = 'open'",
    [instanceId, code, subject])).rowCount ?? 0;
}

/** Cursor row under lock (missing — made at the current journal place). */
async function lockCursor(q: Q, instanceId: string): Promise<Cursor & { state: DetectorState }> {
  await q.query(
    `INSERT INTO alert_feed_cursor (instance_id, after_received_at, after_id) VALUES ($1, now(), $2::uuid) ON CONFLICT (instance_id) DO NOTHING`,
    [instanceId, ZERO_UUID]);
  const r = (await q.query(`SELECT ${usKey("after_received_at")} AS at, after_id::text AS after_id, detectors FROM alert_feed_cursor WHERE instance_id = $1 FOR UPDATE`,
    [instanceId])).rows[0] as { at: string | null; after_id: string | null; detectors: DetectorState | null } | undefined;
  return { at: r?.at ?? null, id: r?.after_id ?? null, state: (r?.detectors && typeof r.detectors === "object" ? r.detectors : {}) as DetectorState };
}

/** Budget of new subjects this hour (a new hour starts at 0). */
function budgetFor(state: DetectorState, now: Date): SubjectBudget {
  const hour = now.toISOString().slice(0, 13);
  if (!state.budget || state.budget.hour !== hour || typeof state.budget.codes !== "object") state.budget = { hour, codes: {}, edge: 0 };
  return state.budget;
}
const roomFor = (b: SubjectBudget, code: string, edge: boolean): boolean =>
  (b.codes[code] ?? 0) < NEW_SUBJECTS_PER_CODE && (!edge || b.edge < EDGE_NEW_PER_HOUR);
const spend = (b: SubjectBudget, code: string, edge: boolean): void => {
  b.codes[code] = (b.codes[code] ?? 0) + 1;
  if (edge) b.edge++;
};

/** A pair's repeat in the batch: the alert row, how much more to add, and the last details (for a new row if the old one got closed). */
interface Pending { id: string; extra: number; lastAt: Date; summary: string; details: Record<string, unknown>; level: string; code: string; subject: string }

/**
 * Step 1 for one cursor: edge — edge events (edge_event), else inside events. Returns the new cursor.
 */
async function feedLane(ctx: DbCtx, q: Q, edgeLane: boolean, cur: Cursor, state: DetectorState, budget: SubjectBudget, out: DetectorsResult): Promise<Cursor> {
  const codes = new Set(feedCodes());
  const groups = new Map<string, Pending>();
  let after = cur;
  for (let round = 0; round < FEED_ROUNDS; round++) {
    const rows = (await ctx.db.audit.query(
      `SELECT id::text AS id, at, ${usKey("received_at")} AS received_key, event_type, code, detail FROM audit_alert_feed($1::timestamptz, $2::uuid, NULL, $3, $4)`,
      [after.at, after.id, FEED_BATCH, edgeLane])).rows as FeedRow[];
    for (const e of rows) {
      out.feed++;
      const edge = e.event_type === "edge_event";
      if (e.code === "host_mode_facts") { if (e.event_type === "ops") state.host_facts_at = iso(e.at); continue; }   // host facts — host script only
      if (e.code === EGRESS_ALIVE_CODE) { if (edge) state.logpump_at = iso(e.at); continue; }
      if (FEED_SKIP_EVENT_TYPES.has(e.event_type) || !codes.has(e.code)) continue;
      if (!originOk(e.code, e.event_type)) { out.rejected++; continue; }
      const level = feedLevel(e.code);
      if (!level) continue;
      const raw = e.detail && typeof e.detail === "object" ? e.detail : {};
      const detail = alertDetail(e.code, raw, edge);
      // a panel alert test — each in its own row: else a second test would join the first and give no mail
      const any = edge ? `${EDGE_SUBJECT_PREFIX}${ANY_SUBJECT}` : ANY_SUBJECT;
      let subject = !edge && e.code.startsWith("ops_test_") ? `test:${e.id}` : (alertSubject(raw, edge) ?? ANY_SUBJECT);
      if (edge && subject !== `test:${e.id}`) subject = `${EDGE_SUBJECT_PREFIX}${subject}`;
      const counted = !anySubject(subject) && !subject.startsWith("test:");
      if (counted && !groups.has(`${e.code}\u0000${subject}`) && !roomFor(budget, e.code, edge)) subject = any;
      const k = `${e.code}\u0000${subject}`;
      const summary = feedSummary(e.code, detail);
      const details = { ...detail, event_type: e.event_type, event: e.id };
      const at = new Date(e.at);
      const g = groups.get(k);
      if (g) {
        g.extra++;
        if (at > g.lastAt) g.lastAt = at;
        g.summary = summary; g.details = details;
        continue;
      }
      const r = await groupAlert(q, { instanceId: ctx.instanceId, code: e.code, level, subject, summary, details, at });
      groups.set(k, { id: r.id, extra: 0, lastAt: at, summary, details, level, code: e.code, subject });
      if (r.inserted) { out.raised++; if (counted && !anySubject(subject)) spend(budget, e.code, edge); } else out.grouped++;
    }
    if (rows.length) { const last = rows[rows.length - 1]!; after = { at: last.received_key, id: last.id }; }
    if (rows.length < FEED_BATCH) break;
  }
  // pair repeats within a pass — one UPDATE per pair; if the row got closed or accepted — a new open one
  for (const g of groups.values()) {
    if (!g.extra) continue;
    const u = await q.query(
      `UPDATE admin_alerts SET count = count + $2, last_at = GREATEST(last_at, least($3::timestamptz, now()))
        WHERE id = $1 AND status = 'open'`, [g.id, g.extra, g.lastAt]);
    if (!u.rowCount) await groupAlert(q, { instanceId: ctx.instanceId, code: g.code, level: g.level, subject: g.subject, summary: g.summary, details: g.details, at: g.lastAt, n: g.extra });
    out.grouped += g.extra;
  }
  return after;
}

/** Flags that decide which contour services must run. */
export interface ContourFlags { login: boolean; contour: boolean; probe: boolean }
export function contourFlags(ctx: DbCtx): ContourFlags {
  const on = (k: string) => ctx.settings.get<unknown>(k, false) === true;
  const login = on("edge.login_enabled");
  return { login, contour: login || on("edge.export_enabled"), probe: on("edge.probe_enabled") || on("edge.synthetic_login_enabled") };
}

/**
 * A service must run under the current flags (dark launch): the sign-in check — with outside sign-in on; export, intake,
 * reconciler, edge and bridge rows — contour on; the probe — probe or synthetic sign-in on; the rest — always.
 */
export function serviceExpected(service: string, f: ContourFlags): boolean {
  switch (service) {
    case "memory-authcheck": return f.login;
    case "exporter": case "intake": case "reconciler": case "edge": case "memory-relay": case LOGPUMP_SERVICE: return f.contour;
    case "memory-probe": return f.probe;
    default: return true;
  }
}

/** service_silent, cert_expiring by heartbeat; anchors_signers_root_changed by root fingerprint. */
async function heartbeatStep(ctx: DbCtx, q: Q, state: DetectorState, out: DetectorsResult, now: Date, f: ContourFlags): Promise<void> {
  const rows = (await q.query(
    `SELECT service, at, extract(epoch FROM now() - at)::int AS age, detail->>'cert_not_after' AS not_after,
            detail->>'anchors_root_sha256' AS root
       FROM service_heartbeats WHERE instance_id = $1`, [ctx.instanceId])).rows as
    Array<{ service: string; at: Date; age: number; not_after: string | null; root: string | null }>;
  const silent = { ...(state.silent ?? {}) }, cert = { ...(state.cert ?? {}) }, roots = { ...(state.roots ?? {}) };
  const stamp = now.toISOString();
  for (const h of rows) {
    const subj = `service:${h.service}`.slice(0, 128);
    const expected = serviceExpected(h.service, f);
    // silence: one key per episode (last heartbeat) and alert time: the contour was turned off and on while the service
    // stays silent — alert again
    const limit = SILENT_AFTER_SEC[h.service];
    if (limit !== undefined) {
      const at = iso(h.at);
      if (expected && Number(h.age) > limit) {
        if (silent[h.service] !== at) {
          silent[h.service] = at;
          if (await detectorAlert(ctx, q, { code: "service_silent", level: "high", subject: subj, dedupeKey: `service_silent:${h.service}:${at}:${stamp}`,
            summary: `Service ${h.service} is unresponsive: last heartbeat ${Math.round(Number(h.age) / 60)} min ago`, details: { service: h.service, ms: Number(h.age) * 1000 } })) {
            out.detectors.push("service_silent");
          }
        }
      } else if (silent[h.service]) {
        delete silent[h.service];
        out.closed += await closeAlert(q, ctx.instanceId, "service_silent", subj);
      }
    }
    // certificate: one key per term and alert time (renewed, then the old one back — alert again)
    const na = h.not_after ? Date.parse(h.not_after) : NaN;
    if (expected && Number.isFinite(na)) {
      const days = Math.floor((na - now.getTime()) / DAY_MS);
      const key = new Date(na).toISOString();
      if (days < CERT_WARN_DAYS) {
        if (cert[h.service] !== key) {
          cert[h.service] = key;
          if (await detectorAlert(ctx, q, { code: "cert_expiring", level: "high", subject: subj, dedupeKey: `cert_expiring:${h.service}:${key}:${stamp}`,
            summary: `Certificate for service ${h.service} expires in ${Math.max(0, days)} days.`, details: { service: h.service, days_left: Math.max(0, days) } })) {
            out.detectors.push("cert_expiring");
          }
        }
      } else if (cert[h.service]) {
        delete cert[h.service];
        out.closed += await closeAlert(q, ctx.instanceId, "cert_expiring", subj);
      }
    } else if (!expected && cert[h.service]) {
      delete cert[h.service];
      out.closed += await closeAlert(q, ctx.instanceId, "cert_expiring", subj);
    }
    // trust root of the anchors: no key — no alert and the old one is kept; the repeat key is per change
    if (h.root && /^[0-9a-f]{64}$/.test(h.root)) {
      const before = roots[h.service];
      roots[h.service] = h.root;
      if (before && before !== h.root
          && await detectorAlert(ctx, q, { code: "anchors_signers_root_changed", level: "high", subject: subj,
            dedupeKey: `anchors_signers_root_changed:${h.service}:${before.slice(0, 16)}:${h.root.slice(0, 16)}:${iso(h.at)}`,
            summary: `The anchor trust root changed for ${h.service}: ${before.slice(0, 12)}… → ${h.root.slice(0, 12)}…`,
            details: { service: h.service, before, after: h.root } }))
        out.detectors.push("anchors_signers_root_changed");
    }
  }
  state.silent = silent; state.cert = cert; state.roots = roots;
}

// ---------------------------------------------------------------- certificate terms

/** Steps: under 60 days left — step 60, under 30 — step 30 (the second mail). */
export const CERT_STEP_DAYS: readonly number[] = [30, 60];
/** An older edge confirmation is stale (reason stale). */
export const CERT_STALE_SEC = 48 * 3600;
/** First-date and prepared-term confirmation wait — one day. */
export const CERT_WAIT_SEC = 24 * 3600;
/** Without new host facts the step checks terms hourly; new facts at once. */
export const CERT_EVERY_MS = 3_600_000;
/** The closed list of names: edge leaves, memory server leaves, roots, the proxy client, bridge clients. */
export const CERT_EDGE_LEAVES = ["edge-mcp", "edge-auth", "edge-pg"] as const;
export const CERT_VM_LEAVES = ["relay", "edge_writer", "edge_logship", "edge_backchannel"] as const;
export const CERT_ROOTS = ["ca_edge_tls", "ca_edge_pg_clients", "ca_bridge"] as const;
export const CERT_BRIDGE_SERVICES = ["memory-exporter", "memory-intake", "memory-reconciler", "memory-authcheck"] as const;
export const CERT_BRIDGE_CLIENTS = "bridge_clients";
const CERT_PROXY = ["proxy_client", "ca_proxy_clients"] as const;
const CERT_EDGE = "@edge";

/** A term fact's value: a date (ISO), the word none, off, unknown; differs — prepared but not applied (tls_served). */
interface CertVal { date?: string; word?: string; differs?: boolean }
export function certValue(raw: string): CertVal {
  let s = raw.trim(), differs = false;
  if (s.endsWith("/differs")) { differs = true; s = s.slice(0, -"/differs".length); }
  if (s === "none" || s === "off" || s === "unknown") return { word: s };
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/.test(s)) {
    const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
    if (Number.isFinite(t)) return { date: new Date(t).toISOString(), differs };
  }
  return { word: "unknown" };
}
/** Host facts «name=value,name=value»; not a string — empty. */
export function certPairs(v: unknown): Map<string, CertVal> {
  const m = new Map<string, CertVal>();
  if (typeof v !== "string") return m;
  for (const part of v.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), certValue(part.slice(i + 1)));
  }
  return m;
}

/** What the step sees for a name in the last facts. */
interface CertObs extends CertVal {
  name: string;
  /** the running side showed the term (edge leaves); else — a file, a provisional term */
  confirmed: boolean;
  /** expected: the edge was prepared (or the proxy client is on) */
  expected: boolean;
  service: string;
  /** time of confirmation or read */
  at: string;
}

/**
 * cert_expiring for all leaves and roots, at 60 and 30 days, also with the contour off.
 * Source: the last ops event host_mode_facts (written by the host mode check): edge_tls_not_after and
 * edge_tls_checked_at (edge leaves as presented, that is, confirmed; «/differs» — prepared but not applied),
 * pki_leaves_not_after, pki_roots_not_after, pki_bridge_clients_not_after, pki_bridge_clients_missing (host files and
 * edge roots, the release helper's tls_roots row). No such fact — not reported: the name is not expected (an
 * old host check gives no daily alerts). Subjects:
 *   - cert:<name> — step 60 or 30 by the confirmed date, before it by the provisional (first date by file; a file with
 *     another term later does not replace it). Repeat key — cert_expiring:<name>:<term>:<step>:<alert time>, repeats
 *     in an episode are muted by the state «<term>:<step>»; step 30 closes the step-60 row and opens a new one (second
 *     mail); a confirmed date beyond 60 days — closed, state cleared; unknown does not clear the date;
 *   - cert-check:edge — edge leaf confirmation over 48 h old or unknown after a date; cert-check:<name> — a host file
 *     vanished; an expected name with no first date 24 h after the first pass expecting it — reason stale too (bridge
 *     clients, cert-check:bridge_clients:<service>, pki_bridge_clients_missing);
 *   - cert-apply:<name> — a prepared term not confirmed in 24 h (reason unconfirmed): edge leaves «/differs», others —
 *     until each side has a source of confirmation, the name always waits for it: on a test installation such
 *     rows are by design, no failure.
 * «Edge was prepared» is from the journal (host_mode_facts with a date in edge_tls_not_after or ca_edge_tls not none):
 * once true it stays; the state keeps only a cache, an empty state rereads it. The proxy client and its root —
 * if the edge said proxy-clients=<term> or a proxy-client.crt copy exists; a fresh (48 h) edge off excludes them.
 */
async function certStep(ctx: DbCtx, q: Q, state: DetectorState, out: DetectorsResult, now: Date): Promise<void> {
  const nowMs = now.getTime();
  const due = state.certs_facts !== state.host_facts_at || !state.certs_at || !(nowMs - Date.parse(state.certs_at) < CERT_EVERY_MS);
  if (!due) return;
  const audit = ctx.db.auditRead();
  const row = (await audit.query(
    `SELECT at, details FROM audit_events WHERE instance_id = $1 AND event_type = 'ops' AND details->>'code' = 'host_mode_facts'
      ORDER BY at DESC, id DESC LIMIT 1`, [ctx.instanceId])).rows[0] as { at: Date; details: Record<string, unknown> | null } | undefined;
  state.certs_at = now.toISOString();
  if (state.host_facts_at) state.certs_facts = state.host_facts_at; else delete state.certs_facts;
  if (!row) return;
  const f = row.details && typeof row.details === "object" ? row.details : {};
  const factsAt = iso(row.at);
  if (state.certs_prepared !== true) {
    const r = await audit.query(
      `SELECT 1 FROM audit_events WHERE instance_id = $1 AND event_type = 'ops' AND details->>'code' = 'host_mode_facts'
          AND ($2::timestamptz IS NULL OR at > $2::timestamptz)
          AND (details->>'edge_tls_not_after' ~ '=[0-9]{4}-'
               OR (details->>'pki_roots_not_after' ~ '(^|,)ca_edge_tls=' AND details->>'pki_roots_not_after' !~ '(^|,)ca_edge_tls=none(,|$)'))
        LIMIT 1`, [ctx.instanceId, state.certs_scan ?? null]);
    if (r.rowCount) { state.certs_prepared = true; delete state.certs_scan; } else state.certs_scan = factsAt;
  }
  const prepared = state.certs_prepared === true;
  const edgeAt = typeof f.edge_tls_checked_at === "string" && Number.isFinite(Date.parse(f.edge_tls_checked_at)) ? iso(f.edge_tls_checked_at) : null;
  const edgeFresh = edgeAt !== null && nowMs - Date.parse(edgeAt) <= CERT_STALE_SEC * 1000;
  const edge = certPairs(f.edge_tls_not_after), leaves = certPairs(f.pki_leaves_not_after), roots = certPairs(f.pki_roots_not_after);
  const obs: CertObs[] = [];
  const has = (k: string) => typeof f[k] === "string";
  if (has("edge_tls_not_after"))
    for (const n of CERT_EDGE_LEAVES) obs.push({ name: n, ...(edge.get(n) ?? { word: "unknown" }), confirmed: true, expected: prepared, service: n, at: edgeAt ?? factsAt });
  if (has("pki_leaves_not_after"))
    for (const n of CERT_VM_LEAVES) obs.push({ name: n, ...(leaves.get(n) ?? { word: "unknown" }), confirmed: false, expected: prepared, service: n, at: factsAt });
  if (has("pki_roots_not_after"))
    for (const n of CERT_ROOTS) obs.push({ name: n, ...(roots.get(n) ?? { word: "unknown" }), confirmed: false, expected: prepared, service: n, at: factsAt });
  // proxy client and its root: a fresh off from the edge excludes both; a copy is a sign of waiting only when
  // the state is unknown
  const pxRoot = roots.get("ca_proxy_clients"), pxLeaf = leaves.get("proxy_client");
  const pxOff = edgeFresh && pxRoot?.word === "off";
  const pxOn = !pxOff && (pxRoot?.date !== undefined || (pxLeaf !== undefined && pxLeaf.word !== "none" && pxLeaf.word !== "off"));
  if (pxOn) {
    obs.push({ name: "proxy_client", ...(pxLeaf ?? { word: "none" }), confirmed: false, expected: true, service: "proxy_client", at: factsAt });
    obs.push({ name: "ca_proxy_clients", ...(pxRoot ?? { word: "unknown" }), confirmed: false, expected: true, service: "ca_proxy_clients", at: factsAt });
  }
  // bridge clients of four services: the term is the earliest known date, the missing ones — per service
  const missing = new Map<string, string>();
  if (typeof f.pki_bridge_clients_missing === "string" && f.pki_bridge_clients_missing !== "-")
    for (const part of f.pki_bridge_clients_missing.split(",")) {
      const [svc, st] = part.trim().split(":");
      if (svc && (CERT_BRIDGE_SERVICES as readonly string[]).includes(svc) && st) missing.set(svc, st);
    }
  if (has("pki_bridge_clients_not_after")) {
    const v = String(f.pki_bridge_clients_not_after), i = v.indexOf("=");
    const svc = i > 0 ? v.slice(0, i) : "";
    const val = certValue(i > 0 ? v.slice(i + 1) : v);
    // no date and a list of missing ones — rows per service, no common row
    obs.push({ name: CERT_BRIDGE_CLIENTS, ...val, confirmed: false, expected: prepared && !(val.date === undefined && missing.size > 0),
               service: (CERT_BRIDGE_SERVICES as readonly string[]).includes(svc) ? svc : CERT_BRIDGE_CLIENTS, at: factsAt });
  }
  for (const [svc, st] of missing)
    obs.push({ name: `${CERT_BRIDGE_CLIENTS}:${svc}`, word: st === "unconfirmed" ? "unconfirmed" : "none", confirmed: false, expected: prepared, service: svc, at: factsAt });

  const certs: Record<string, CertName> = { ...(state.certs ?? {}) };
  const stamp = now.toISOString();
  const raise = async (subject: string, dedupeKey: string, summary: string, details: Record<string, unknown>): Promise<void> => {
    if (await detectorAlert(ctx, q, { code: "cert_expiring", level: "high", subject, dedupeKey, summary, details })) out.detectors.push("cert_expiring");
  };
  const close = async (subject: string): Promise<void> => { out.closed += await closeAlert(q, ctx.instanceId, "cert_expiring", subject); };
  const waited = (since: string | undefined) => since !== undefined && nowMs - Date.parse(since) >= CERT_WAIT_SEC * 1000;
  const seen = new Set<string>();
  for (const ob of obs) {
    seen.add(ob.name);
    const st: CertName = { ...(certs[ob.name] ?? {}) };
    const svcEntry = ob.name.startsWith(`${CERT_BRIDGE_CLIENTS}:`);
    const check = `cert-check:${ob.name}`, apply = `cert-apply:${ob.name}`;
    const label = ob.service !== ob.name && !svcEntry ? `${ob.name} (${ob.service})` : ob.name;
    if (svcEntry && ob.word === "unconfirmed") {
      // the service file is not what the running side showed: a 24 h wait, per service
      if (st.s) { await close(check); delete st.s; }
      delete st.x;
      st.w ??= stamp;
      if (waited(st.w) && st.u !== st.w) {
        st.u = st.w;
        await raise(apply, `cert_expiring:unconfirmed:${ob.name}:${st.w}:${stamp}`,
          `The bridge client certificate for ${ob.service} was updated on disk over a day ago, but the service still presents the old one. Restart the service`,
          { service: ob.service, reason: "unconfirmed" });
      }
    } else if (ob.date) {
      delete st.x;
      if (st.s) { await close(check); delete st.s; }
      if (ob.confirmed) {
        st.c = ob.date; st.t = ob.at; delete st.p; delete st.q;
        if (ob.differs) st.w ??= stamp;
        else if (st.w || st.u) { if (st.u) await close(apply); delete st.w; delete st.u; }
      } else {
        if (!st.c && !st.p) st.p = ob.date;
        st.t = ob.at;
        // the file has no source of confirmation yet: we wait for it from the first pass; another prepared term — a new episode
        if (st.q !== ob.date) { st.q = ob.date; st.w = stamp; }
      }
    } else if (st.c || st.p) {
      // a date before, now none or unknown: the host file is gone or unread (edge leaves — row cert-check:edge below)
      if (!ob.confirmed && st.s !== `t:${st.t}`) {
        st.s = `t:${st.t}`;
        await raise(check, `cert_expiring:stale:${check}:${st.t}:${stamp}`,
          `The expiration date for certificate ${label} can no longer be read (${ob.word ?? "unknown"}). Last known date: ${String(st.c ?? st.p).slice(0, 10)}`,
          { service: ob.service, reason: "stale" });
      }
    } else if (ob.expected && !ob.confirmed) {
      st.x ??= stamp;
      if (waited(st.x) && st.s !== `x:${st.x}`) {
        st.s = `x:${st.x}`;
        const why = ob.name === "ca_edge_pg_clients" ? ": the edge helper has no tls_roots row. IT root access is required" : ob.word === "none" ? ": no file" : "";
        await raise(check, `cert_expiring:stale:${check}:${st.x}:${stamp}`,
          `The expiration date for certificate ${label} has not been read in a day${why}`, { service: ob.service, reason: "stale" });
      }
    } else delete st.x;
    // steps by the confirmed date, before it by the provisional one
    const eff = st.c ?? st.p;
    if (eff && !svcEntry) {
      const days = Math.floor((Date.parse(eff) - nowMs) / DAY_MS);
      const step = CERT_STEP_DAYS.find((d) => days < d) ?? 0;
      const subj = `cert:${ob.name}`;
      if (step) {
        const k = `${eff}:${step}`;
        if (st.a !== k) {
          if (st.a) await close(subj);
          st.a = k;
          const pre = st.c ? "" : " — expiration date from the file, not yet confirmed by the running service";
          await raise(subj, `cert_expiring:${ob.name}:${eff}:${step}:${stamp}`,
            `Certificate ${label} expires in ${Math.max(0, days)} days (level ${step})${pre}`, { service: ob.service, days_left: Math.max(0, days), step });
        }
      } else if (st.a) { await close(subj); delete st.a; }
    }
    // the prepared one unconfirmed for a day
    const pending = ob.date !== undefined && (ob.confirmed ? ob.differs === true : true);
    if (pending && waited(st.w)) {
      const ep = ob.confirmed ? st.w! : st.q!;
      if (st.u !== ep) {
        if (st.u) await close(apply);
        st.u = ep;
        const why = ob.confirmed ? `is presenting the old certificate. The new one was installed over a day ago. Restart the process`
          : `cannot be verified yet: the running service has not reported which certificate it presents`;
        await raise(apply, `cert_expiring:unconfirmed:${ob.name}:${ep}:${stamp}`, `Certificate ${label}: ${why}`, { service: ob.service, reason: "unconfirmed" });
      }
    }
    if (Object.keys(st).length) certs[ob.name] = st; else delete certs[ob.name];
  }
  // edge leaves: confirmation is stale (48 h) or gone after a date — one cert-check:edge row; never seen — after 24 h
  if (has("edge_tls_not_after")) {
    const e: CertName = { ...(certs[CERT_EDGE] ?? {}) };
    const had = CERT_EDGE_LEAVES.some((n) => certs[n]?.c);
    if (had) {
      delete e.x;
      if (!edgeFresh || !CERT_EDGE_LEAVES.every((n) => edge.get(n)?.date)) {
        const ep = `t:${edgeAt ?? "unknown"}`;
        if (e.s !== ep) {
          e.s = ep;
          await raise("cert-check:edge", `cert_expiring:stale:cert-check:edge:${edgeAt ?? "unknown"}:${stamp}`,
            `Edge certificate expiration dates have not been confirmed recently. Last check: ${edgeAt ?? "unknown"}`, { service: "edge", reason: "stale" });
        }
      } else if (e.s) { await close("cert-check:edge"); delete e.s; }
    } else if (prepared) {
      e.x ??= stamp;
      if (waited(e.x) && e.s !== `x:${e.x}`) {
        e.s = `x:${e.x}`;
        await raise("cert-check:edge", `cert_expiring:stale:cert-check:edge:${e.x}:${stamp}`,
          "Edge certificate expiration dates have not been read in the day since edge setup", { service: "edge", reason: "stale" });
      }
    } else delete e.x;
    if (Object.keys(e).length) certs[CERT_EDGE] = e; else delete certs[CERT_EDGE];
  }
  // services gone from the missing list, and the proxy client turned off by a fresh off — their rows are closed
  for (const name of Object.keys(certs)) {
    const gone = (name.startsWith(`${CERT_BRIDGE_CLIENTS}:`) && !seen.has(name)) || (pxOff && (CERT_PROXY as readonly string[]).includes(name));
    if (!gone) continue;
    for (const s of [`cert:${name}`, `cert-check:${name}`, `cert-apply:${name}`]) await close(s);
    delete certs[name];
  }
  state.certs = certs;
}

/**
 * edge-logpump is silent: contour on, no sign of life (egress_pump_alive, every 5 minutes) for longer than
 * LOGPUMP_SILENT_SEC. Before a first sign it counts from when the contour went on. Contour off — the open alert closes.
 */
async function logpumpStep(ctx: DbCtx, q: Q, state: DetectorState, out: DetectorsResult, now: Date, f: ContourFlags): Promise<void> {
  const subj = `service:${LOGPUMP_SERVICE}`;
  const silent = { ...(state.silent ?? {}) };
  if (!serviceExpected(LOGPUMP_SERVICE, f)) {
    delete state.contour_at;
    if (silent[LOGPUMP_SERVICE]) { delete silent[LOGPUMP_SERVICE]; out.closed += await closeAlert(q, ctx.instanceId, "service_silent", subj); }
    state.silent = silent;
    return;
  }
  state.contour_at ??= now.toISOString();
  const alive = state.logpump_at ? Date.parse(state.logpump_at) : NaN;
  const since = Math.max(Date.parse(state.contour_at), Number.isFinite(alive) ? alive : -Infinity);
  const last = new Date(since).toISOString();
  const age = Math.floor((now.getTime() - since) / 1000);
  if (age > LOGPUMP_SILENT_SEC) {
    if (silent[LOGPUMP_SERVICE] !== last) {
      silent[LOGPUMP_SERVICE] = last;
      if (await detectorAlert(ctx, q, { code: "service_silent", level: "high", subject: subj, dedupeKey: `service_silent:${LOGPUMP_SERVICE}:${last}:${now.toISOString()}`,
        summary: `The edge kernel log processor (edge-logpump) has been unresponsive for ${Math.round(age / 60)} min. Outbound network attempts from the edge are not currently visible`,
        details: { service: LOGPUMP_SERVICE, ms: age * 1000 } }))
        out.detectors.push("service_silent");
    }
  } else if (silent[LOGPUMP_SERVICE]) {
    delete silent[LOGPUMP_SERVICE];
    out.closed += await closeAlert(q, ctx.instanceId, "service_silent", subj);
  }
  state.silent = silent;
}

/**
 * New rows of the second-factor mode journal. First run: rows exist — from the last (history is no news); an empty
 * journal — from the start: the first mode change is an alert. Rows younger than MFA_LAG_SEC wait: a row's time is
 * the writer's transaction start, so a row committed after a later one would slip past the cursor.
 */
async function mfaStep(ctx: DbCtx, q: Q, state: DetectorState, out: DetectorsResult): Promise<void> {
  if (!state.mfa) {
    const tail = (await q.query(`SELECT id::text AS id, ${usKey("at")} AS at FROM mfa_mode_changes WHERE instance_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
      [ctx.instanceId])).rows[0] as { id: string; at: string } | undefined;
    state.mfa = tail ? { at: tail.at, id: tail.id } : { at: "1970-01-01T00:00:00.000000Z", id: ZERO_UUID };
    return;
  }
  const rows = (await q.query(
    `SELECT id::text AS id, ${usKey("at")} AS at, from_mode, to_mode FROM mfa_mode_changes
      WHERE instance_id = $1 AND (at, id) > ($2::timestamptz, $3::uuid) AND at < now() - make_interval(secs => $4)
      ORDER BY at, id LIMIT 100`,
    [ctx.instanceId, state.mfa.at, state.mfa.id, MFA_LAG_SEC])).rows as Array<{ id: string; at: string; from_mode: string; to_mode: string }>;
  for (const r of rows) {
    const from = MFA_RANK[r.from_mode] ?? 0, to = MFA_RANK[r.to_mode] ?? 0;
    if (from !== to) {
      const weaker = to < from;
      const code = weaker ? "mfa_mode_weakened" : "mfa_mode_strengthened";
      if (await detectorAlert(ctx, q, { code, level: weaker ? "high" : "medium", subject: `change:${r.id}`, dedupeKey: `${code}:${r.id}`,
        summary: `Second-factor mode for external sign-in: ${r.from_mode} → ${r.to_mode}`, details: { from: r.from_mode, to: r.to_mode } }))
        out.detectors.push(code);
    }
    state.mfa = { at: r.at, id: r.id };
  }
}

/**
 * Hourly: many new outside connections of a person in a day. One alert (or a repeat of the open one) per person a day:
 * a person who already had an alert today (in any state) is not counted that day.
 */
async function manyNewStep(ctx: DbCtx, q: Q, state: DetectorState, out: DetectorsResult, now: Date): Promise<void> {
  if (state.many_at && now.getTime() - Date.parse(state.many_at) < MANY_NEW_EVERY_MS) return;
  state.many_at = now.toISOString();
  const max = Number(ctx.settings.get<unknown>("edge.max_new_connections_alert_day", 5));
  const limit = Number.isFinite(max) ? Math.min(100, Math.max(1, Math.trunc(max))) : 5;
  const synthetic = String(ctx.settings.get<unknown>("edge.synthetic_login_account", "") ?? "").trim().toLowerCase();
  const day = now.toISOString().slice(0, 10);
  const rows = (await q.query(
    `SELECT c.person_id::text AS person_id, count(*)::int AS n
       FROM oauth_connections c JOIN api_keys k ON k.id = c.id
       JOIN people p ON p.id = c.person_id
      WHERE c.instance_id = $1 AND c.origin = 'edge' AND k.created_at > now() - interval '1 day'
        AND ($3 = '' OR (lower(p.login) <> $3 AND split_part(lower(p.login), '@', 1) <> $3))
        AND NOT EXISTS (SELECT 1 FROM admin_alerts a WHERE a.instance_id = $1 AND a.code = 'connections_many_new'
                           AND a.subject = 'person_id:' || c.person_id::text AND a.last_at >= $4::date)
      GROUP BY c.person_id HAVING count(*) > $2
      ORDER BY count(*) DESC LIMIT 200`, [ctx.instanceId, limit, synthetic, day])).rows as Array<{ person_id: string; n: number }>;
  for (const r of rows)
    if (await detectorAlert(ctx, q, { code: "connections_many_new", level: "medium", subject: `person_id:${r.person_id}`, dedupeKey: `connections_many_new:${r.person_id}:${day}`,
      summary: `A person made ${r.n} new external connections in one day (threshold ${limit})`, details: { person_id: r.person_id, count: r.n } }))
      out.detectors.push("connections_many_new");
}

/**
 * New connection networks (/16): connection_networks rows without a handled mark. An alert only for a live connection
 * from outside (in oauth_connections with origin edge, key not revoked); the rest are marked with no alert.
 */
async function networkStep(ctx: DbCtx, q: Q, state: DetectorState, out: DetectorsResult): Promise<void> {
  const geo = ctx.settings.get<unknown>("edge.geo_alert_enabled", true) !== false;
  const geoPath = String(ctx.settings.get<unknown>("edge.geoip_db_path", "") ?? "");
  if (geoPath && !state.geoip_warned) {
    state.geoip_warned = true;
    log.warn("geoip_reader_missing", { problem: "reader_not_built" });   // country and provider network come later; the alert is by /16
  }
  const rows = (await q.query(
    `SELECT n.connection_id::text AS connection_id, host(n.prefix16) || '/' || masklen(n.prefix16) AS prefix, c.person_id::text AS person_id,
            (c.id IS NOT NULL AND k.id IS NOT NULL AND k.revoked_at IS NULL) AS live,
            EXISTS (SELECT 1 FROM connection_networks o WHERE o.connection_id = n.connection_id AND o.prefix16 <> n.prefix16
                       AND (o.alerted_at IS NOT NULL OR o.first_seen < n.first_seen)) AS other
       FROM connection_networks n
       LEFT JOIN oauth_connections c ON c.id = n.connection_id AND c.instance_id = n.instance_id AND c.origin = 'edge'
       LEFT JOIN api_keys k ON k.id = c.id
      WHERE n.instance_id = $1 AND n.alerted_at IS NULL
      ORDER BY n.first_seen LIMIT 500`, [ctx.instanceId])).rows as Array<{ connection_id: string; prefix: string; person_id: string | null; live: boolean; other: boolean }>;
  let fresh = 0;
  for (const r of rows) {
    if (r.other && geo && r.live) {
      const subject = fresh < NETWORK_ALERTS_PER_PASS ? `connection_id:${r.connection_id}` : ANY_SUBJECT;
      if (await detectorAlert(ctx, q, { code: "connection_new_network", level: "medium", subject,
          dedupeKey: `connection_new_network:${r.connection_id}:${r.prefix}`, summary: `External connection came from a new network ${r.prefix}`,
          details: { connection_id: r.connection_id, ...(r.person_id ? { person_id: r.person_id } : {}), ip_prefix: r.prefix } })) {
        out.detectors.push("connection_new_network");
        fresh++;
      }
    }
    await q.query("UPDATE connection_networks SET alerted_at = now() WHERE connection_id = $1 AND prefix16 = $2::cidr AND alerted_at IS NULL", [r.connection_id, r.prefix]);
  }
}

/** «Schema section not applied yet» codes: not logged every 15 seconds. */
const SCHEMA_MISSING = new Set(["42P01", "42703", "42883"]);

/** A detector in a savepoint: a failure undoes only its changes (DB and state) and writes a log line. */
async function detector(q: Q, name: string, state: DetectorState, fn: () => Promise<void>): Promise<void> {
  const before = JSON.stringify(state);
  await q.query("SAVEPOINT alert_detector");
  try {
    await fn();
    await q.query("RELEASE SAVEPOINT alert_detector");
  } catch (e) {
    await q.query("ROLLBACK TO SAVEPOINT alert_detector");
    for (const k of Object.keys(state)) delete (state as Record<string, unknown>)[k];
    Object.assign(state, JSON.parse(before));
    const code = String((e as { code?: string }).code ?? "");
    if (!SCHEMA_MISSING.has(code)) log.warn("alert_detector_failed", { detector: name, error: ((e as Error)?.message ?? "").slice(0, 200) });
  }
}

/** Detectors' state limit (CHECK alert_feed_cursor_detectors_check — 16 KiB), with a margin. */
const STATE_MAX_BYTES = 15_000;

/**
 * State does not fit — the hour's budget count is dropped (no harm: the count starts again). The rest (silence and
 * certificate episodes, root fingerprints, cursors) is kept: without it alerts would rise again every pass. It has no
 * other way to grow — few rows per service and cursors.
 */
export function trimState(state: DetectorState): DetectorState {
  if (state.budget && Buffer.byteLength(JSON.stringify(state)) > STATE_MAX_BYTES) {
    delete state.budget;
    log.warn("alert_detectors_state_trimmed", { part: "budget" });
  }
  return state;
}

/** One pass of the job. now — for tests. */
export async function alertDetectorsPass(ctx: DbCtx, o: { now?: Date } = {}): Promise<DetectorsResult> {
  const now = o.now ?? new Date();
  const out: DetectorsResult = { feed: 0, raised: 0, grouped: 0, rejected: 0, detectors: [], closed: 0 };
  try {
    await tx(ctx.db.control, async (q) => {
      const cur = await lockCursor(q, ctx.instanceId);
      const state = cur.state;
      const budget = budgetFor(state, now);
      const edgeCur: Cursor = state.edge_cursor && typeof state.edge_cursor === "object" ? state.edge_cursor : { at: cur.at, id: cur.id };
      // inside first: a stream of edge events does not delay inside service alerts
      const next = await feedLane(ctx, q, false, cur, state, budget, out);
      state.edge_cursor = await feedLane(ctx, q, true, edgeCur, state, budget, out);
      // detectors — each in its own savepoint: one failing (a column or table of a section not applied yet is missing)
      // does not stop the feed or other detectors
      const f = contourFlags(ctx);
      await detector(q, "heartbeats", state, () => heartbeatStep(ctx, q, state, out, now, f));
      await detector(q, "cert_expiring", state, () => certStep(ctx, q, state, out, now));
      await detector(q, "edge_logpump", state, () => logpumpStep(ctx, q, state, out, now, f));
      await detector(q, "mfa_mode", state, () => mfaStep(ctx, q, state, out));
      await detector(q, "connections_many_new", state, () => manyNewStep(ctx, q, state, out, now));
      await detector(q, "connection_networks", state, () => networkStep(ctx, q, state, out));
      await q.query("UPDATE alert_feed_cursor SET after_received_at = $2::timestamptz, after_id = $3::uuid, detectors = $4::jsonb, updated_at = now() WHERE instance_id = $1",
        [ctx.instanceId, next.at, next.id, JSON.stringify(trimState(state))]);
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    // feed or cursor not applied yet (13, 12) — wait quietly for the schema
    if (code === "42883" || code === "42P01") return { ...out, skipped: "schema" };
    throw e;
  }
  if (out.rejected) log.warn("alert_feed_rejected", { count: out.rejected });   // wrong origin (an edge event with an inside service's code, or the reverse)
  if (out.raised || out.detectors.length || out.closed) log.info("alert_detectors", { feed: out.feed, raised: out.raised, grouped: out.grouped, detectors: out.detectors.length, closed: out.closed });
  return out;
}

/** Days to keep connection networks: rows last seen before it, and revoked ones, are cleaned. */
export const CONNECTION_NETWORKS_KEEP_DAYS = 90;

/** Connection networks cleanup: unseen beyond the term, or the connection (its key) revoked over a day ago. */
export async function connectionNetworksGc(ctx: DbCtx): Promise<number> {
  return (await ctx.db.control.query(
    `DELETE FROM connection_networks n WHERE n.instance_id = $1
        AND (n.last_seen < now() - make_interval(days => $2)
             OR EXISTS (SELECT 1 FROM api_keys k WHERE k.id = n.connection_id AND k.revoked_at < now() - interval '1 day')
             OR NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = n.connection_id) AND n.last_seen < now() - interval '1 day')`,
    [ctx.instanceId, CONNECTION_NETWORKS_KEEP_DAYS])).rowCount ?? 0;
}

/** Periodic job registrar (like every in index.ts). */
export type Every = (ms: number, name: string, fn: () => Promise<unknown>) => unknown;

/** For run-job: alert_detectors — one pass, connection_networks_gc — network cleanup. */
export const OPS_ALERT_JOBS: Record<string, (ctx: DbCtx) => Promise<unknown>> = {
  alert_detectors: (ctx) => alertDetectorsPass(ctx),
  connection_networks_gc: (ctx) => connectionNetworksGc(ctx),
};

/**
 * index.ts calls it once at start: a pass every 15 s (a chain — passes never overlap within a process, between processes —
 * the cursor row lock), network cleanup hourly, the «Digest now» queue (the gateway wakes its alert_digest job).
 * A button digest gets the job id (runKey): a reminder of unhandled alerts goes per press, and a repeat of the same
 * job via the queue won't double it.
 */
export function registerAlertDetectors(ctx: Ctx, every: Every): void {
  let run: Promise<unknown> = Promise.resolve();
  const once = () => (run = run.catch(() => undefined).then(() => alertDetectorsPass(ctx)));
  every(ALERT_DETECTORS_EVERY_MS, "alert_detectors", once);
  every(3_600_000, "connection_networks_gc", () => connectionNetworksGc(ctx));
  void (async () => {
    const cur = await ctx.boss.getQueue(DIGEST_NOW_QUEUE);
    if (cur?.policy !== "stately") {
      if (cur) await ctx.boss.deleteQueue(DIGEST_NOW_QUEUE);
      await ctx.boss.createQueue(DIGEST_NOW_QUEUE, { policy: "stately" });
    }
    await ctx.boss.work(DIGEST_NOW_QUEUE, { batchSize: 1 } as any, async (jobs: unknown) => {
      const id = Array.isArray(jobs) ? String((jobs[0] as { id?: unknown } | undefined)?.id ?? "") : "";
      await alertDigestPass(ctx, { force: true, runKey: /^[0-9a-f-]{1,64}$/i.test(id) ? id : String(Date.now()) });
    });
  })().catch((e: unknown) => log.warn("alert_digest_queue_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
}
