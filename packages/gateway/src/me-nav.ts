// The workplace menu summary: the counters of "Meetings with me", "Bulk changes", "Record edits" and "Shared knowledge review",
// agent keys and connections whose term runs out, whether agent sign-in through the company account is on, and the work profile
// (the "My profile" item) — in one request.
// Before, the frame asked for them in six or seven requests on every render, and all went to the person's limit: after a quick
// walk through the sections they saw "Too many requests". The numbers come from the same functions as the separate summaries.
// The parts are counted independently: a failure of one gives its default value and its name in incomplete, the rest stay in
// place; so a records-base failure (meetings) keeps the key-term banner. For incomplete parts the workplace takes the last
// known value and does not treat such a summary as fresh.
import type { Hono } from "hono";
import { log, oauthConfig } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { KEY_EXPIRY_WARN_DAYS } from "./key-expiry.ts";
import { meetingsSummary } from "./my-meetings.ts";
import { pendingPlansCount } from "./plans.ts";
import { correctionsSummary } from "./corrections.ts";
import { reviewSummary } from "./org-review-people.ts";
import { requireHuman } from "./workplace.ts";
import { custodyHeldCount } from "./custody.ts";
import { navFocusStale, profileEnabled } from "./profile.ts";

export interface MeNav {
  meetings: { new: number; asked: number };
  plans_pending: number;
  corrections_to_confirm: number;
  /** null — not a curator of "Company shared knowledge": there is no "Shared knowledge review" item. */
  org_review_waiting: number | null;
  /** Own agent keys with KEY_EXPIRY_WARN_DAYS days or less left of their term (no preview and no revoked ones). */
  expiring_keys: Array<{ id: string; client_label: string | null; key_prefix: string; expires_at: string }>;
  /** There is a live agent connection through the account whose term is running out. */
  oauth_expiring: boolean;
  /** Is agent sign-in through the company account on (the oauth.enabled setting): what to offer first. */
  oauth_enabled: boolean;
  /** "Handed to me": for how many departed employees the caller is a keeper with live access; 0 when off. */
  custody: number;
  /** Parts that could not be counted: they hold the default value. Empty — the summary is complete. */
  incomplete: NavPart[];
  /**
   * "My profile": the field is there only when the administrator turned the work profile on (`access.profile_enabled`)
   * — the workplace shows the menu item and a line on "Overview". Off — no field: the answer is byte for byte as before.
   */
  profile_enabled?: true;
  /**
   * The update date of "Working on now" when it is older than `access.profile.focus_fresh_days` (only with the profile
   * on, for the person's own open profile): the line "Update 'Working on now'" on "Overview". Fresh, empty,
   * hidden from agents, not counted — no field.
   */
  profile_focus_stale?: string;
}

const NAV_PARTS = ["meetings", "plans_pending", "corrections_to_confirm", "org_review_waiting", "expiring_keys", "oauth_expiring", "custody"] as const;
export type NavPart = typeof NAV_PARTS[number];

/** No more than this many expiring keys in the answer: a person has no more than limits.personal_keys_max (5) personal keys. */
const KEYS_MAX = 50;

export async function meNav(app: App, caller: Caller): Promise<MeNav> {
  await requireHuman(app, caller, "View the workspace menu summary", { path: "/", section: "Overview" });
  const me = caller.person!.id;
  const failed = new Set<NavPart>();
  /** A summary part: a failure gives the default, the name in incomplete and a log line (no record text — only the message). */
  const part = <T,>(name: NavPart, run: () => Promise<T>, fallback: T): Promise<T> =>
    run().catch((e: unknown) => {
      failed.add(name);
      log.warn("me_nav_part_failed", { part: name, error: ((e as Error)?.message ?? "").slice(0, 200) });
      return fallback;
    });
  const [meetings, plans, corrections, review, keys, oauthSoon, custody] = await Promise.all([
    part("meetings", () => meetingsSummary(app, caller), { new: 0, asked: 0 }),
    part("plans_pending", () => pendingPlansCount(app, caller), 0),
    part("corrections_to_confirm", async () => (await correctionsSummary(app, caller)).to_confirm, 0),
    part("org_review_waiting", async () => { const r = await reviewSummary(app, caller); return r.curator && typeof r.waiting === "number" ? r.waiting : null; }, null),
    part("expiring_keys", async () => (await app.db.control.query(
      `SELECT id, client_label, key_prefix, expires_at FROM api_keys
        WHERE auth_method = 'api_key' AND principal_type = 'person' AND principal_id = $1 AND instance_id = $2 AND revoked_at IS NULL AND preview IS NOT TRUE
          AND expires_at > now() AND expires_at <= now() + make_interval(days => $3)
        ORDER BY expires_at, id LIMIT $4`, [me, app.instanceId, KEY_EXPIRY_WARN_DAYS, KEYS_MAX])).rows
      .map((k) => ({ id: k.id, client_label: k.client_label ?? null, key_prefix: k.key_prefix, expires_at: new Date(k.expires_at).toISOString() })), []),
    // the same condition as GET /me/connections?expiring=true
    part("oauth_expiring", async () => (await app.db.control.query(
      `SELECT EXISTS (SELECT 1 FROM oauth_connections c JOIN api_keys k ON k.id = c.id
        WHERE c.person_id = $1 AND c.instance_id = $2 AND k.revoked_at IS NULL AND k.expires_at > now() AND k.expires_at <= now() + make_interval(days => $3)) AS soon`,
      [me, app.instanceId, KEY_EXPIRY_WARN_DAYS])).rows[0]?.soon === true, false),
    part("custody", () => custodyHeldCount(app, caller), 0),
  ]);
  // as GET /me/connections/config: turning agent sign-in on shows at once; not reread — by the last loaded ones
  await app.settings.load(true).catch((e: unknown) => log.warn("me_nav_settings_reload_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) }));
  // work profile: the menu item and the line "Update 'Working on now'" — only when on; a date failure — no
  // line (it is not in incomplete: the list of parts is closed by the contract), the log holds no text
  const profileOn = profileEnabled(app);
  const focusStaleAt = profileOn ? await navFocusStale(app, caller).catch((e: unknown) => {
    log.warn("me_nav_profile_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) });
    return null;
  }) : null;
  return {
    meetings,
    plans_pending: plans,
    corrections_to_confirm: corrections,
    org_review_waiting: review,
    expiring_keys: keys,
    oauth_expiring: oauthSoon,
    oauth_enabled: oauthConfig(app.settings).enabled === true,
    custody,
    incomplete: NAV_PARTS.filter((p) => failed.has(p)),   // always in the same order
    // like agent sign-in: turning the work profile on shows at once (settings reread above); off — no field
    ...(profileOn ? { profile_enabled: true as const, ...(focusStaleAt ? { profile_focus_stale: focusStaleAt } : {}) } : {}),
  };
}

/** GET /api/v1/me/nav — only a person in the workplace (an agent key and the preview get 403); the limit bucket is nav. */
export function registerMeNav(r: Hono<any>, app: App): void {
  r.get("/api/v1/me/nav", async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "nav");
    return c.json(await meNav(app, caller));
  });
}
