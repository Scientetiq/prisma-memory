import { createHash } from "node:crypto";
import { AUTHCHECK_READINESS_EDGE_KEYS, AUTHCHECK_SETTINGS_UNREAD, effectiveMode, EXTERNAL_FLAGS, externalGate, gateWarnings, HEARTBEAT_FRESH_SEC, LDAP_PLAIN_RISK_TEXT, log,
         parseCaCerts, profileDigest, profileWeakenings, readinessDigestSql, readinessRowsSql, settingsPolicy, SMTP_TRANSPORT_FIELDS, smtpConfig, smtpTransportDigest,
         type ExternalFlag, type GateFacts, type GateFailure, type GateWarning, type HeartbeatFact, type SecurityMode, type Settings } from "@memory/shared";
import type { App } from "../context.ts";
import { processTopology } from "./listeners.ts";

export const ALERT_MAIL_FRESH_DAYS = 7;

export async function lastAlertMailDelivered(app: Pick<App, "db" | "instanceId">, o: { highOnly?: boolean; transportFp?: string | null } = {}): Promise<Date | null> {
  const high = o.highOnly !== false;
  if (o.transportFp === null) return null;
  const byFp = typeof o.transportFp === "string";
  const r = await app.db.control.query(
    `SELECT max(sent_at) AS at FROM mail_outbox WHERE instance_id = $1 AND kind = 'alert' AND status = 'sent'
        AND (NOT $2::boolean OR dedupe_key LIKE 'alert:%' OR dedupe_key LIKE 'alert\\_catchup:%')${byFp ? " AND transport_fp = $3" : ""}`,
    byFp ? [app.instanceId, high, o.transportFp] : [app.instanceId, high])
    .catch((e: unknown) => { log.warn("external_gate_alerts_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); return { rows: [] as Array<{ at: Date | null }> }; });
  const at = (r.rows[0] as { at?: Date | null } | undefined)?.at ?? null;
  return at ? new Date(at) : null;
}

const missingRelation = (e: unknown): boolean => (e as { code?: string })?.code === "42P01";

export type SettingGet = (path: string) => unknown;
export interface GateFactsOptions { get?: SettingGet }

export function alertTransportFp(app: Pick<App, "appSecret" | "settings">, get?: SettingGet): string | null {
  if (typeof app.appSecret !== "string" || !app.appSecret) return null;
  const view = get ? { get: <T>(k: string, fb: T): T => { const v = get(k); return (v === null || v === undefined ? fb : v) as T; } } : app.settings;
  return smtpTransportDigest(app.appSecret, smtpConfig(view));
}

export function adminListenerUnix(): boolean {
  try {
    const t = processTopology();
    const admin = t.admin ?? [];
    return t.adminSeparate && admin.length > 0 && admin.every((a) => a.type === "unix");
  } catch {
    return false;
  }
}

async function realFacts(app: App, o: GateFactsOptions = {}): Promise<GateFacts> {
  const ctl = app.db.control;
  const heartbeats: Record<string, HeartbeatFact> = {};
  const hb = await ctl.query(
    `SELECT service, run_mode, detail, at >= now() - make_interval(secs => $2::int) AS fresh, greatest(0, extract(epoch FROM now() - at))::float8 AS age_sec
       FROM service_heartbeats WHERE instance_id = $1`,
    [app.instanceId, HEARTBEAT_FRESH_SEC]).catch((e: unknown) => { if (missingRelation(e)) return { rows: [] }; throw e; });
  for (const r of hb.rows as Array<{ service: string; run_mode: string; detail: Record<string, unknown> | null; fresh: boolean; age_sec: number | string | null }>) {
    const age = Number(r.age_sec);
    heartbeats[r.service] = { run_mode: r.run_mode, fresh: r.fresh === true, detail: r.detail ?? {}, age_sec: Number.isFinite(age) ? age : HEARTBEAT_FRESH_SEC };
  }
  const st = await ctl.query("SELECT reconcile_result FROM edge_export_status WHERE one").catch((e: unknown) => { if (missingRelation(e)) return { rows: [] }; throw e; });
  const reconcile = (st.rows[0]?.reconcile_result as Record<string, unknown> | null | undefined) ?? null;
  const delivered = await lastAlertMailDelivered(app, { transportFp: alertTransportFp(app, o.get) });
  const transport = await lastTransportChange(app);
  const alertMailOk = transport !== TRANSPORT_UNREAD && !!delivered && Date.now() - delivered.getTime() <= ALERT_MAIL_FRESH_DAYS * 86_400_000
    && (!transport || delivered.getTime() > transport.getTime());
  const e5 = await ctl.query("SELECT 1 FROM security_attestations WHERE instance_id = $1 AND kind = 'e5_hostile_bridge' LIMIT 1", [app.instanceId])
    .then((r) => (r.rowCount ?? 0) > 0, () => false);
  const an = await ctl.query("SELECT max(serial)::int AS s FROM anchors_applied WHERE instance_id = $1 AND kind = 'edge'", [app.instanceId])
    .catch((e: unknown) => { if (missingRelation(e)) return { rows: [] }; throw e; });
  const serial = an.rows[0]?.s;
  return { heartbeats, reconcile, alertMailOk, adminListenerUnix: adminListenerUnix(), edgeAnchorsSerial: typeof serial === "number" ? serial : null, e5HostileBridge: e5,
           authcheckSettingsDigest: await authcheckSettingsDigest(app) };
}

export async function authcheckSettingsDigest(app: Pick<App, "db" | "instanceId">): Promise<string | null | typeof AUTHCHECK_SETTINGS_UNREAD> {
  const r = await app.db.control.query(
    `SELECT ${readinessDigestSql("s")} AS digest FROM settings s WHERE s.instance_id = $1 AND ${readinessRowsSql("s", "$2")}`,
    [app.instanceId, AUTHCHECK_READINESS_EDGE_KEYS]).catch(() => null);
  if (!r) return AUTHCHECK_SETTINGS_UNREAD;
  const digest = (r.rows[0] as { digest?: string | null } | undefined)?.digest ?? null;
  return typeof digest === "string" ? digest : AUTHCHECK_SETTINGS_UNREAD;
}

const TRANSPORT_KEYS: string[] = [...SMTP_TRANSPORT_FIELDS];

export const TRANSPORT_UNREAD = "unread" as const;

export async function lastTransportChange(app: Pick<App, "db" | "instanceId">): Promise<Date | null | typeof TRANSPORT_UNREAD> {
  const r = await app.db.control.query(
    "SELECT max(updated_at) AS at FROM settings WHERE instance_id = $1 AND category = 'smtp' AND key = ANY($2::text[])",
    [app.instanceId, TRANSPORT_KEYS]).catch(() => null);
  if (!r) return TRANSPORT_UNREAD;
  const at = (r.rows[0] as { at?: Date | null } | undefined)?.at ?? null;
  return at ? new Date(at) : null;
}

let facts: (app: App, o?: GateFactsOptions) => Promise<GateFacts> = realFacts;
export function setGateFactsForTests(f: ((app: App, o?: GateFactsOptions) => Promise<GateFacts>) | null): void { facts = f ?? realFacts; }

export const gateFacts = (app: App, o: GateFactsOptions = {}): Promise<GateFacts> => facts(app, o);

export interface UnconfirmedKey {
  key: string; flag: ExternalFlag; digest: string;
  secret: boolean;
  value: unknown;
  seed: unknown;
  set?: boolean;
  risk?: string;
}

export function profileRisk(path: string, v: unknown): string | undefined {
  return path === "ldap.tls_mode" && v === "none" ? LDAP_PLAIN_RISK_TEXT : undefined;
}

const PEM_KEY = /\.ca_cert$/;

export function profileShown(path: string, v: unknown, secret: boolean): unknown {
  if (secret) return null;
  if (!PEM_KEY.test(path) || typeof v !== "string" || !v.trim()) return v ?? null;
  try {
    const certs = parseCaCerts(v);
    const shown = certs.slice(0, 10).map((x) => `${x.subject.replace(/\n/g, ", ").slice(0, 200)} (SHA-256 ${x.fingerprint256})`);
    return `certificates: ${certs.length}; ${shown.join("; ")}${certs.length > 10 ? "; …" : ""}`;
  } catch {
    return `could not be parsed as PEM. SHA-256 of the text: ${createHash("sha256").update(v).digest("hex")}`;
  }
}

const secretSet = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

export async function unconfirmedProfile(app: Pick<App, "db" | "instanceId" | "settings" | "appSecret">, flags: readonly ExternalFlag[], future: (p: string) => unknown,
                                         s: Pick<Settings, "meta"> = app.settings, q: Pick<App["db"]["control"], "query"> = app.db.control): Promise<UnconfirmedKey[]> {
  const all = Object.keys(settingsPolicy().keys);
  const weak = new Map<string, ExternalFlag>();
  for (const flag of flags)
    for (const w of profileWeakenings(flag, all, future, (p) => s.meta(p).defaultValue, (p) => !s.meta(p).exists))
      if (!weak.has(w.key)) weak.set(w.key, flag);
  if (!weak.size) return [];
  const keys = [...weak.keys()];
  const rows = await q.query(
    `SELECT DISTINCT ON (a.subject) a.subject, encode(a.value_sha256, 'hex') AS sha FROM security_attestations a
       LEFT JOIN settings s ON s.instance_id = a.instance_id AND s.category || '.' || s.key = a.subject
      WHERE a.instance_id = $1 AND a.kind = 'profile_weakening' AND a.subject = ANY($2::text[])
        AND (s.updated_at IS NULL OR a.attested_at >= s.updated_at)
      ORDER BY a.subject, a.attested_at DESC`, [app.instanceId, keys])
    .then((r) => r.rows as Array<{ subject: string; sha: string | null }>).catch(() => [] as Array<{ subject: string; sha: string | null }>);
  const ok = new Map(rows.map((r) => [r.subject, r.sha]));
  return keys.map((key): UnconfirmedKey => {
    const meta = s.meta(key), v = future(key);
    const risk = meta.secret ? undefined : profileRisk(key, v);
    return { key, flag: weak.get(key)!, digest: profileDigest(app.appSecret, key, v, meta.secret), secret: meta.secret,
             value: profileShown(key, v, meta.secret), seed: profileShown(key, meta.defaultValue, meta.secret), ...(meta.secret ? { set: secretSet(v) } : {}),
             ...(risk ? { risk } : {}) };
  }).filter((u) => ok.get(u.key) !== u.digest);
}

export interface ProfileChange {
  changed_at: string | null;
  changed_by: string | null;
  changed_by_human: boolean | null;
}

const AUTH_WORDS: Readonly<Record<string, string>> = {
  sso: "personal session through the identity provider", sso_webauthn: "personal session through the identity provider", sso_breakglass: "emergency access", local_breakglass: "emergency access",
  local: "admin@local sign-in", tool: "tool session", system_key: "system key", legacy_session: "legacy admin panel session", auditor_key: "auditor key",
};
export const PROFILE_CHANGE_DAYS = 400;
const CHANGE_SKEW_MS = 120_000;

export async function profileChanges(app: Pick<App, "db" | "instanceId">, keys: readonly string[]): Promise<Map<string, ProfileChange>> {
  const out = new Map<string, ProfileChange>();
  if (!keys.length) return out;
  const rows = (await app.db.control.query(
    "SELECT category || '.' || key AS path, updated_at FROM settings WHERE instance_id = $1 AND category || '.' || key = ANY($2::text[])", [app.instanceId, [...keys]])
    .catch(() => ({ rows: [] }))).rows as Array<{ path: string; updated_at: Date | null }>;
  const updated = new Map(rows.map((r) => [r.path, r.updated_at ? new Date(r.updated_at) : null]));
  let events: Array<{ key: string; at: Date; principal_type: string | null; auth: string | null; person: string | null }> = [];
  try {
    events = (await app.db.auditRead().query(
      `SELECT DISTINCT ON (details->>'key') details->>'key' AS key, at, principal_type, details->>'admin_auth' AS auth, details->>'admin_person' AS person
         FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND details->>'op' = 'setting_change' AND details->>'key' = ANY($2::text[])
          AND at > now() - make_interval(days => $3::int)
        ORDER BY details->>'key', at DESC`, [app.instanceId, [...keys], PROFILE_CHANGE_DAYS])).rows;
  } catch (e) { log.warn("profile_changes_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); }
  const ids = [...new Set(events.map((e) => e.person).filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))];
  const logins = new Map(ids.length ? ((await app.db.control.query("SELECT id::text AS id, login FROM people WHERE instance_id = $1 AND id = ANY($2::uuid[])", [app.instanceId, ids])
    .catch(() => ({ rows: [] }))).rows as Array<{ id: string; login: string }>).map((r) => [r.id, r.login]) : []);
  const byKey = new Map(events.map((e) => [e.key, e]));
  for (const key of keys) {
    const ev = byKey.get(key), up = updated.get(key) ?? null;
    if (ev && (!up || new Date(ev.at).getTime() >= up.getTime() - CHANGE_SKEW_MS)) {
      const login = ev.person ? logins.get(ev.person) ?? null : null;
      const how = ev.auth ? AUTH_WORDS[ev.auth] ?? ev.auth : ev.principal_type === "person" ? "workspace" : "service or command line";
      out.set(key, { changed_at: new Date(ev.at).toISOString(), changed_by: login ? `${login} — ${how}` : how,
                     changed_by_human: ev.auth === "sso" || ev.auth === "sso_webauthn" });
    } else out.set(key, { changed_at: up ? up.toISOString() : null, changed_by: null, changed_by_human: null });
  }
  return out;
}

export type ProfileItem = UnconfirmedKey & ProfileChange;

export function reportedLdapChannel(f: Pick<GateFacts, "heartbeats">): unknown {
  const ac = f.heartbeats["memory-authcheck"];
  return ac?.fresh ? ac.detail?.ldap_channel : undefined;
}

export async function gateReport(app: App, getter?: SettingGet, mode: SecurityMode = effectiveMode(app.settings)):
  Promise<Array<{ flag: ExternalFlag; open: boolean; failed: GateFailure[]; warnings: GateWarning[]; profile: ProfileItem[] }>> {
  const get: SettingGet = getter ?? ((p) => app.settings.effective(p));
  const f = await gateFacts(app, getter ? { get: getter } : {});
  const reported = reportedLdapChannel(f);
  const rows: Array<{ flag: ExternalFlag; open: boolean; failed: GateFailure[]; warnings: GateWarning[]; profile: UnconfirmedKey[] }> = [];
  for (const flag of EXTERNAL_FLAGS)
    rows.push({ flag, open: app.settings.get<unknown>(flag, false) === true, failed: externalGate(get, f, flag, mode), warnings: gateWarnings(get, flag, mode, reported),
                profile: await unconfirmedProfile(app, [flag], get).catch(() => []) });
  const changes = await profileChanges(app, [...new Set(rows.flatMap((r) => r.profile.map((u) => u.key)))]).catch(() => new Map<string, ProfileChange>());
  const none: ProfileChange = { changed_at: null, changed_by: null, changed_by_human: null };
  return rows.map((r) => ({ ...r, profile: r.profile.map((u) => ({ ...u, ...(changes.get(u.key) ?? none) })) }));
}
