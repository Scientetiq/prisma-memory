import type pg from "pg";
import { enqueueMail, MAIL_RE, smtpConfig } from "./smtp.ts";
import { digestConfigOf, digestSlot, digestText, reviewQueueLimit, type DigestCounts } from "./org-review.ts";

type Q = Pick<pg.Pool, "query">;
interface SettingsLike { get<T>(path: string, fallback: T): T }

export const ORG_QUEUE_WHERE = `r.instance_id = $1 AND r.state IN ('unreviewed','confirmed','community','exempt')
   AND (r.state = 'unreviewed' OR r.held_at IS NOT NULL OR r.disputed_at IS NOT NULL OR (r.extended AND r.state = 'community')
        OR (r.extended AND r.state = 'exempt' AND r.exempt_kind IN ('public_profile','space_guide') AND r.decided_at IS NULL))`;

export const ORG_QUEUE_COUNTS_SQL = `
  SELECT count(*)::int AS waiting,
         count(*) FILTER (WHERE r.entered_at > now() - interval '7 days')::int AS new_week,
         count(*) FILTER (WHERE r.held_at IS NOT NULL)::int AS held,
         count(*) FILTER (WHERE r.state = 'unreviewed' AND r.held_at IS NULL AND r.return_after <= now() + interval '7 days')::int AS due_week,
         min(r.entered_at) AS oldest
    FROM org_reviews r
    JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted
    JOIN spaces o ON o.id = l.space_id AND o.kind = 'org' AND o.instance_id = $1
   WHERE ${ORG_QUEUE_WHERE}`;

export const ORG_CURATORS_SQL = `
  SELECT p.id, p.login, p.display_name, COALESCE(p.attrs->>'test', '') = 'true' AS test
    FROM spaces o JOIN people p ON p.instance_id = o.instance_id AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'
   WHERE o.kind = 'org' AND o.instance_id = $1 AND o.archived_at IS NULL
     AND ($2::boolean OR COALESCE(p.attrs->>'test', '') <> 'true')
     AND (o.owner_id = p.id OR EXISTS (SELECT 1 FROM space_members_effective m WHERE m.space_id = o.id AND m.person_id = p.id AND m.role = 'owner'))
   ORDER BY p.login`;

export interface OrgQueueCounts { waiting: number; new_week: number; held: number; due_week: number; oldest: Date | null }
export const orgQueueCounts = async (q: Q, instanceId: string): Promise<OrgQueueCounts> =>
  (await q.query(ORG_QUEUE_COUNTS_SQL, [instanceId])).rows[0] ?? { waiting: 0, new_week: 0, held: 0, due_week: 0, oldest: null };

export interface Curator { id: string; login: string; display_name: string | null; test: boolean }
export const orgCurators = async (q: Q, instanceId: string, withTest: boolean): Promise<Curator[]> =>
  (await q.query(ORG_CURATORS_SQL, [instanceId, withTest])).rows;

export type DigestSkip = "smtp_disabled" | "digest_disabled" | "outside_window" | "nothing_to_review" | "no_curators";
export interface DigestRun {
  week: string;
  manual: boolean;
  queued: number;
  recipients: number;
  no_address: number;
  waiting: number;
  held: number;
  skipped?: DigestSkip;
}

export async function orgDigest(q: Q, instanceId: string, settings: SettingsLike,
                                o: { now?: Date; manual?: boolean; createdBy?: string | null; workplaceUrl?: string | null } = {}): Promise<DigestRun> {
  const now = o.now ?? new Date(), manual = o.manual === true;
  const cfg = digestConfigOf(settings);
  const slot = digestSlot(now, cfg);
  const week = manual ? now.toISOString().slice(0, 13) : slot.week;
  const out: DigestRun = { week, manual, queued: 0, recipients: 0, no_address: 0, waiting: 0, held: 0 };
  if (!smtpConfig(settings).enabled) return { ...out, skipped: "smtp_disabled" };
  if (!manual && !cfg.enabled) return { ...out, skipped: "digest_disabled" };
  if (!manual && !slot.inWindow) return { ...out, skipped: "outside_window" };
  const c = await orgQueueCounts(q, instanceId);
  out.waiting = c.waiting; out.held = c.held;
  if (!c.waiting) return { ...out, skipped: "nothing_to_review" };
  const curators = await orgCurators(q, instanceId, manual);
  const to = curators.filter((p) => MAIL_RE.test(p.login));
  out.recipients = to.length; out.no_address = curators.length - to.length;
  if (!to.length) return { ...out, skipped: "no_curators" };
  const base = o.workplaceUrl ?? (String(settings.get<string>("access.workplace_url", "") ?? "").trim() || null);
  const counts: DigestCounts = { waiting: c.waiting, newWeek: c.new_week, held: c.held, dueWeek: c.due_week, oldest: c.oldest,
                                 limit: reviewQueueLimit(settings.get<unknown>("access.org_review_queue_limit", 20)) };
  const { subject, text } = digestText(counts, base, cfg.tz);
  for (const p of to) {
    const r = await enqueueMail(q, instanceId, { kind: "curator_digest", to: p.login, subject, text, createdBy: o.createdBy ?? null,
                                                 dedupeKey: `curator_digest:${manual ? "manual:" : ""}${week}:${p.id}` });
    if (r.created) out.queued++;
  }
  return out;
}
