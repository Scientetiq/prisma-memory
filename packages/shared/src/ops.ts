import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_DIR } from "./contracts.ts";
import { newId } from "./ids.ts";
import { log } from "./log.ts";
import { fallbackTz, instanceTz } from "./zoned-time.ts";

export type OpsLevel = "page" | "high" | "medium" | "metric" | "info";

export interface OpsCode {
  code: string;
  source: string;
  level: OpsLevel;
  work_hours_only: boolean;
  detail_keys: string[];
  stage: string;
}

export const FEED_SKIP_STAGES: ReadonlySet<string> = new Set(["1a"]);
export const SELF_RAISING_SOURCES: ReadonlySet<string> = new Set(["ops-event"]);
export const ALERT_LEVELS: readonly OpsLevel[] = ["page", "high", "medium"];
export const FEED_SKIP_EVENT_TYPES: ReadonlySet<string> = new Set(["admin"]);
export const SECURITY_ALERT_CODES: ReadonlySet<string> = new Set([
  "security_mode_enabled", "security_mode_incomplete", "security_admins_short", "security_mode_downgrade_requested",
  "security_mode_downgrade_pending", "security_mode_disabled", "security_mode_floor_mismatch", "strict_mode_enabled",
  "external_gate_refused", "external_weakened", "external_login_ldap_plain", "alert_channel_changed", "system_key_issued",
  "anchors_signers_root_changed", "egress_attempt", "meta_drift",
]);

export const EDGE_SOURCES: ReadonlySet<string> = new Set(["edge-mcp", "edge-auth", "edge-logpump"]);

export function codeSources(code: string): string[] {
  return (opsCode(code)?.source ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
export const edgeOrigin = (code: string): boolean => codeSources(code).some((s) => EDGE_SOURCES.has(s));
export const innerOrigin = (code: string): boolean => codeSources(code).some((s) => !EDGE_SOURCES.has(s));

export function securityAlertCodes(): string[] {
  const out = new Set(SECURITY_ALERT_CODES);
  for (const c of opsCodes().values())
    if ((c.level === "high" || c.level === "page") && (c.code.startsWith("relay_") || codeSources(c.code).includes("edge-logpump"))) out.add(c.code);
  return [...out].sort();
}

let registry: Map<string, OpsCode> | undefined;

export function opsCodes(): ReadonlyMap<string, OpsCode> {
  if (registry) return registry;
  registry = new Map();
  try {
    const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR, "edge", "audit-codes.json"), "utf8")) as
      { sections?: Array<{ "x-stage"?: string; codes?: Array<Record<string, unknown>> }> };
    for (const s of doc.sections ?? []) for (const c of s.codes ?? []) {
      if (typeof c.code !== "string" || typeof c.level !== "string") continue;
      registry.set(c.code, {
        code: c.code, source: typeof c.source === "string" ? c.source : "", level: c.level as OpsLevel,
        work_hours_only: c.work_hours_only === true,
        detail_keys: Array.isArray(c.detail_keys) ? c.detail_keys.filter((k): k is string => typeof k === "string") : [],
        stage: String(s["x-stage"] ?? ""),
      });
    }
  } catch (e) {
    log.warn("audit_codes_unreadable", { error: ((e as Error)?.message ?? String(e)).slice(0, 200) });
  }
  return registry;
}

export const opsCode = (code: string): OpsCode | null => opsCodes().get(code) ?? null;

export function feedCodes(): string[] {
  return [...opsCodes().values()]
    .filter((c) => ALERT_LEVELS.includes(c.level) && !FEED_SKIP_STAGES.has(c.stage) && !SELF_RAISING_SOURCES.has(c.source))
    .map((c) => c.code).sort();
}

export function workHoursCodes(): string[] {
  return [...opsCodes().values()].filter((c) => c.level === "high" && c.work_hours_only).map((c) => c.code).sort();
}

function simple(v: unknown): string | number | boolean | undefined {
  if (typeof v === "string") return v.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 128);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  return undefined;
}

export function opsDetail(code: string, detail: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const keys = opsCode(code)?.detail_keys ?? [];
  const out: Record<string, string | number | boolean> = {};
  for (const k of keys) {
    const v = simple(detail[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

interface Queryable { query: (sql: string, args?: unknown[]) => Promise<{ rowCount: number | null }> }

export async function opsEvent(audit: Queryable, instanceId: string, code: string, detail: Record<string, unknown> = {}): Promise<boolean> {
  if (!opsCode(code)) {
    log.warn("ops_event_unknown_code", { code: code.slice(0, 64) });
    return false;
  }
  await audit.query(`INSERT INTO audit_events (id, instance_id, event_type, principal_type, details) VALUES ($1, $2, 'ops', 'system', $3::jsonb)`,
    [newId(), instanceId, JSON.stringify({ ...opsDetail(code, detail), code })]);
  return true;
}

export const SUBJECT_KEYS = ["person_id", "connection_id", "service", "client_id", "ip_prefix"] as const;

const UUID_V = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CIDR_V = /^[0-9a-f.:]{2,45}\/\d{1,3}$/i;
const WORD_V = /^[a-z0-9_-]{1,64}$/;

export function edgeSafeValue(v: unknown): string | number | boolean | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  return UUID_V.test(v) || CIDR_V.test(v) || WORD_V.test(v) ? v : undefined;
}

export function alertDetail(code: string, detail: Record<string, unknown>, edge = false): Record<string, string | number | boolean> {
  const base = opsDetail(code, detail);
  if (!edge) return base;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(base)) {
    const s = edgeSafeValue(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

export function alertSubject(detail: Record<string, unknown>, edge = false): string | null {
  for (const k of SUBJECT_KEYS) {
    const raw = detail[k];
    const v = edge ? edgeSafeValue(typeof raw === "string" ? raw.trim() : raw) : raw;
    if ((typeof v === "string" && v.trim() !== "") || typeof v === "number") return `${k}:${String(v).trim()}`.slice(0, 128);
  }
  return null;
}

export const EDGE_SUBJECT_PREFIX = "edge:";
export const anySubject = (subject: string | null | undefined): boolean => subject === "*" || subject === `${EDGE_SUBJECT_PREFIX}*`;

export interface WorkHours { fromMin: number; toMin: number; tz: string }
/** The hours of 04-seed.sql; tz UTC — the stored setting has no tz since and follows the installation (workHoursOf). */
export const WORK_HOURS_DEFAULT: WorkHours = { fromMin: 9 * 60, toMin: 19 * 60, tz: "UTC" };

export function parseWorkHours(v: unknown, zone: string = fallbackTz()): WorkHours {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const m = typeof o.weekdays === "string" ? /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(o.weekdays) : null;
  const fromMin = m ? Number(m[1]) * 60 + Number(m[2]) : NaN, toMin = m ? Number(m[3]) * 60 + Number(m[4]) : NaN;
  let tz = typeof o.tz === "string" && o.tz ? o.tz : zone;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); } catch { tz = zone; }
  if (!m || fromMin >= toMin) return { ...WORK_HOURS_DEFAULT, tz };
  return { fromMin, toMin, tz };
}

/** The work hours of alerts — the one reader of admin.alert_work_hours: without its own tz they follow locale.timezone. */
export function workHoursOf(settings: { get<T>(path: string, fallback: T): T }): WorkHours {
  return parseWorkHours(settings.get<unknown>("admin.alert_work_hours", null), instanceTz(settings));
}

function zoned(now: Date, tz: string): { weekday: number; minute: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday")) + 1;
  return { weekday, minute: Number(g("hour")) * 60 + Number(g("minute")) };
}

export function inWorkHours(wh: WorkHours, now = new Date()): boolean {
  const z = zoned(now, wh.tz);
  return z.weekday >= 1 && z.weekday <= 5 && z.minute >= wh.fromMin && z.minute < wh.toMin;
}
