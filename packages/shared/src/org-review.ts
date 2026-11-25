import { instanceLocale } from "@memory/i18n/context";
import { renderMail } from "./mail-render.ts";
import { isSpaceGuideRow } from "./space-guide.ts";
import { fallbackTz, instanceTz } from "./zoned-time.ts";

export const ORG_REVIEW_STATES = ["unreviewed", "confirmed", "community", "exempt", "returned", "deleted", "left", "superseded"] as const;
export type OrgReviewState = (typeof ORG_REVIEW_STATES)[number];
export const ACTIVE_REVIEW_STATES: readonly OrgReviewState[] = ["unreviewed", "confirmed", "community", "exempt"];
export type EnteredVia = "promote" | "write" | "version" | "legacy" | "public_profile" | "space_guide";
export type ExemptKind = "public_profile" | "space_guide" | "org_card";
export type DecidedVia = "curator" | "community" | "auto" | "author" | "self" | "system";
export type OrgReviewView = "unreviewed" | "confirmed" | "community" | "disputed";

export function parseReviewDays(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}
const intIn = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : dflt;
export const reviewQueueLimit = (v: unknown): number => intIn(v, 1, 50, 20);
export const communityTeams = (v: unknown): number => intIn(v, 2, 10, 2);
export function unreviewedFactor(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0.1 && v <= 1 ? v : 0.8;
}

interface SettingsLike { get<T>(path: string, fallback: T): T }
export const orgReviewEnabled = (s: SettingsLike): boolean => s.get<unknown>("access.org_review_enabled", true) !== false;
export const reviewDays = (s: SettingsLike): number => parseReviewDays(s.get<unknown>("access.org_review_days", 30));

export function exemptKindOf(e: { via: EnteredVia; type?: string | null; sourceKind?: string | null; sourceRef?: string | null }): ExemptKind | null {
  if (e.sourceKind === "pipeline" && e.type === "profile" && typeof e.sourceRef === "string" && e.sourceRef.startsWith("people:")) return "org_card";
  if (e.via === "public_profile" && e.type === "profile") return "public_profile";
  if (e.via === "space_guide" && e.type === "note") return "space_guide";
  if (isSpaceGuideRow({ type: e.type ?? null, source_kind: e.sourceKind ?? null, source_ref: e.sourceRef ?? null })) return "space_guide";
  return null;
}

export function communityReached(marks: ReadonlyArray<{ person_id: string; kind: string; team_id: string | null }>, authorId: string, threshold: number): { reached: boolean; teams: number } {
  const teams = new Set(marks.filter((m) => m.kind === "useful" && m.person_id !== authorId && m.team_id).map((m) => m.team_id as string));
  return { reached: teams.size >= threshold, teams: teams.size };
}

export type ReviewAction = "confirm" | "community" | "return" | "delete" | "leave" | "supersede" | "reenter";
const TRANSITIONS: Record<ReviewAction, { from: readonly OrgReviewState[]; to: OrgReviewState | null }> = {
  confirm: { from: ["unreviewed", "community", "confirmed"], to: "confirmed" },
  community: { from: ["unreviewed"], to: "community" },
  return: { from: ["unreviewed", "confirmed", "community"], to: "returned" },
  delete: { from: ["unreviewed", "confirmed", "community"], to: "deleted" },
  leave: { from: ["unreviewed", "confirmed", "community"], to: "left" },
  supersede: { from: ["unreviewed", "confirmed", "community", "exempt"], to: "superseded" },
  reenter: { from: ["left", "returned", "deleted", "superseded"], to: null },
};
export function reviewTransition(from: OrgReviewState, action: ReviewAction): OrgReviewState | null {
  const t = TRANSITIONS[action];
  if (!t.from.includes(from)) throw new Error(`transition ${from} → ${action} is not allowed`);
  return t.to;
}

export const RETURN_TARGET_SQL = `
  SELECT r.record_id, l.owner_id, p.active AS author_active,
         COALESCE(fs.id, ps.id) AS target
    FROM org_reviews r
    JOIN record_locations l ON l.record_id = r.record_id
    JOIN people p ON p.id = l.owner_id
    LEFT JOIN spaces fs ON fs.id = r.from_space_id AND fs.instance_id = $2 AND fs.archived_at IS NULL AND fs.kind <> 'org'
         AND ((fs.kind = 'personal' AND fs.owner_id = p.id AND p.active)
              OR (fs.kind IN ('team','project') AND (NOT p.active OR fs.owner_id = p.id
                  OR EXISTS (SELECT 1 FROM space_members_effective m WHERE m.space_id = fs.id AND m.person_id = p.id))))
    LEFT JOIN spaces ps ON ps.kind = 'personal' AND ps.owner_id = p.id AND ps.instance_id = $2 AND ps.archived_at IS NULL AND p.active
   WHERE r.record_id = ANY($1::uuid[]) AND r.instance_id = $2`;

const DUE_BASE = `
  SELECT r.record_id, r.return_after::text AS after_key FROM org_reviews r
    JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted
    JOIN spaces o ON o.id = l.space_id AND o.kind = 'org'
   WHERE r.instance_id = $1 AND r.state = 'unreviewed' AND r.held_at IS NULL AND r.return_after <= now()`;
export const DUE_RETURNS_SQL = `${DUE_BASE}
   ORDER BY r.return_after, r.record_id LIMIT $2`;
export const DUE_RETURNS_AFTER_SQL = `${DUE_BASE} AND (r.return_after, r.record_id) > ($3::timestamptz, $4::uuid)
   ORDER BY r.return_after, r.record_id LIMIT $2`;

export const ORG_ACTIVE_UNITS_SQL = `
  SELECT r.record_id, l.class FROM org_reviews r
    JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted
    JOIN spaces o ON o.id = l.space_id AND o.kind = 'org'
   WHERE r.instance_id = $1 AND r.state IN ('unreviewed','confirmed','community')
   ORDER BY r.record_id`;
export const NARROWED_OF_SQL = "SELECT id FROM records WHERE id = ANY($1::uuid[]) AND audience = 'people' AND deleted_at IS NULL ORDER BY id";

interface QueryLike { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export async function carryOrgReview(q: QueryLike, prevId: string, nextId: string, o: { nextOutsideOrg?: boolean } = {}): Promise<OrgReviewState | null> {
  const prev = (await q.query(
    `SELECT r.state, (s.kind = 'org' AND NOT l.deleted) AS in_org FROM org_reviews r
       LEFT JOIN record_locations l ON l.record_id = r.record_id LEFT JOIN spaces s ON s.id = l.space_id
      WHERE r.record_id = $1 FOR UPDATE OF r`, [prevId])).rows[0] as { state: OrgReviewState; in_org: boolean | null } | undefined;
  if (!prev || prev.state === "superseded") return null;
  if (o.nextOutsideOrg && prev.in_org === true && (prev.state === "unreviewed" || prev.state === "confirmed" || prev.state === "community")) {
    const left = await q.query(
      `INSERT INTO org_reviews (record_id, instance_id, state, cycle, entered_at, entered_via, entered_by, entered_human, extended, from_space_id, from_audience,
                                exempt_kind, return_after, held_at, held_by, disputed_at, decided_at, decided_by, decided_via, returned_to, returns, supersedes_id)
       SELECT $2, instance_id, 'left', cycle, entered_at, entered_via, entered_by, entered_human, extended, from_space_id, from_audience,
              exempt_kind, return_after, held_at, held_by, disputed_at, now(), NULL, 'system', NULL, returns, $1
         FROM org_reviews WHERE record_id = $1
       ON CONFLICT (record_id) DO NOTHING`, [prevId, nextId]);
    return left.rowCount ? prev.state : null;
  }
  const ins = await q.query(
    `INSERT INTO org_reviews (record_id, instance_id, state, cycle, entered_at, entered_via, entered_by, entered_human, extended, from_space_id, from_audience,
                              exempt_kind, return_after, held_at, held_by, disputed_at, decided_at, decided_by, decided_via, returned_to, returns, supersedes_id)
     SELECT $2, instance_id, state, cycle, entered_at, entered_via, entered_by, entered_human, extended, from_space_id, from_audience,
            exempt_kind, return_after, held_at, held_by, disputed_at, decided_at, decided_by, decided_via, returned_to, returns, $1
       FROM org_reviews WHERE record_id = $1
     ON CONFLICT (record_id) DO NOTHING`, [prevId, nextId]);
  if (!ins.rowCount) return null;
  await q.query("UPDATE org_reviews SET state = 'superseded' WHERE record_id = $1", [prevId]);
  await q.query("UPDATE org_review_marks SET record_id = $2 WHERE record_id = $1 AND kind = 'wrong'", [prevId, nextId]);
  return prev.state;
}

export async function undoCarryOrgReview(q: QueryLike, prevId: string, nextId: string, prevState: OrgReviewState): Promise<void> {
  await q.query("UPDATE org_review_marks SET record_id = $1 WHERE record_id = $2 AND kind = 'wrong'", [prevId, nextId]);
  await q.query("UPDATE org_reviews SET state = $2 WHERE record_id = $1 AND state = 'superseded'", [prevId, prevState]);
}

export interface DigestConfig { enabled: boolean; weekday: number; time: string; tz: string }
/** tz UTC: the stored setting has no tz since and follows the installation (digestConfigOf). */
export const DEFAULT_DIGEST: DigestConfig = { enabled: true, weekday: 1, time: "09:00", tz: "UTC" };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const tzOk = (tz: string): boolean => { try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; } };

export function digestConfig(v: unknown, zone: string = fallbackTz()): DigestConfig {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_DIGEST.enabled,
    weekday: intIn(o.weekday, 1, 7, DEFAULT_DIGEST.weekday),
    time: typeof o.time === "string" && TIME_RE.test(o.time) ? o.time : DEFAULT_DIGEST.time,
    tz: typeof o.tz === "string" && tzOk(o.tz) ? o.tz : zone,
  };
}

/** The curators' digest — the one reader of access.org_review_digest: without its own tz it follows locale.timezone. */
export function digestConfigOf(settings: { get<T>(path: string, fallback: T): T }): DigestConfig {
  return digestConfig(settings.get<unknown>("access.org_review_digest", null), instanceTz(settings));
}

function wallAsUtc(at: Date, tz: string): { ms: number; isoDow: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const ms = Date.UTC(Number(g("year")), Number(g("month")) - 1, Number(g("day")), Number(g("hour")), Number(g("minute")), Number(g("second")));
  return { ms, isoDow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday")) + 1 };
}

export function isoWeek(wallMs: number): string {
  const d = new Date(wallMs);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const DIGEST_WINDOW_HOURS = 48;

export function digestSlot(now: Date, cfg: Pick<DigestConfig, "weekday" | "time" | "tz">): { week: string; start: Date; inWindow: boolean } {
  const local = wallAsUtc(now, cfg.tz);
  const offset = local.ms - Math.floor(now.getTime() / 1000) * 1000;
  const [hh, mm] = cfg.time.split(":").map(Number) as [number, number];
  const day = new Date(local.ms);
  let slotWall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - ((local.isoDow - cfg.weekday + 7) % 7), hh, mm);
  if (slotWall > local.ms) slotWall -= 7 * 86_400_000;
  const guess = new Date(slotWall - offset);
  const start = new Date(slotWall - (wallAsUtc(guess, cfg.tz).ms - Math.floor(guess.getTime() / 1000) * 1000));
  const inWindow = now.getTime() >= start.getTime() && now.getTime() < start.getTime() + DIGEST_WINDOW_HOURS * 3_600_000;
  return { week: isoWeek(slotWall), start, inWindow };
}

export interface DigestCounts { waiting: number; newWeek: number; held: number; dueWeek: number; oldest: Date | string | null; limit: number }

/**
 * Mail to a curator (template digest.curator, messages/mail-digest.ts), in the instance language: numbers and a link
 * only — no titles, no record text (mails carry links, not content). Without the workspace address
 * (`access.workplace_url` is empty) — no link, words about where to look. `tz` — the zone of the day in "waiting
 * since" (the digest passes its own zone; UTC when absent).
 */
export function digestText(c: DigestCounts, workplaceUrl: string | null, tz?: string): { subject: string; text: string } {
  return renderMail("digest.curator", instanceLocale(), { counts: c, workplaceUrl, ...(tz ? { tz } : {}) });
}

export function orgReviewSettingProblems(path: string, value: unknown): string[] {
  if (value === null) return [];
  const int = (min: number, max: number) => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? [] : [`integer from ${min} to ${max}`]);
  switch (path) {
    case "access.org_review_days": return int(1, 365);
    case "access.org_review_queue_limit": return int(1, 50);
    case "access.org_review_community_teams": return int(2, 10);
    case "search.org_unreviewed_factor": return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 1 ? [] : ["number from 0.1 to 1 (1 disables it)"];
    case "access.org_review_digest": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return ["object {enabled, weekday, time, tz}"];
      const o = value as Record<string, unknown>, out: string[] = [];
      const extra = Object.keys(o).filter((k) => !["enabled", "weekday", "time", "tz"].includes(k));
      if (extra.length) out.push(`unexpected fields: ${extra.join(", ")}`);
      if ("enabled" in o && typeof o.enabled !== "boolean") out.push("enabled must be true or false");
      if ("weekday" in o && !(typeof o.weekday === "number" && Number.isInteger(o.weekday) && o.weekday >= 1 && o.weekday <= 7)) out.push("weekday must be an integer from 1 (Monday) to 7 (Sunday)");
      if ("time" in o && !(typeof o.time === "string" && TIME_RE.test(o.time))) out.push("time must be HH:MM, for example 09:00");
      if ("tz" in o && !(typeof o.tz === "string" && tzOk(o.tz))) out.push("tz must be an IANA time zone name, for example UTC or Area/City");
      return out;
    }
    default: return [];
  }
}
