// The space's current "How we work" map — metadata only: which version is current, in which database and
// whether it is being moved right now. Apart from space-guide.ts: both the map write and the restore from the trash use this
// (owner.ts), and space-guide.ts itself calls closing from owner.ts — a shared module with no import cycle. No map content here.
// Also here — the switch, the limit and the "who changes the map" rule: they are read by both the map write (space-guide.ts) and
// the edit proposals (space-guide-proposals.ts, corrections.ts), and corrections.ts cannot import space-guide.ts —
// a cycle through write.ts.
import { archivedDenied, GUIDE_ENABLED_SETTING, GUIDE_SETTING, guideLimits, invalid, MemoryError, spaceGuideRef, type DataClass, type GuideLimits } from "@memory/shared";
import type { App } from "./context.ts";
import { withKeyLock } from "./control-lock.ts";

// ---------------------------------------------------------------- switch, limit, who writes
export const GUIDE_DISABLED_TEXT = "The administrator disabled the “How we work” guide";
export const GUIDE_PERSONAL_TEXT = "“How we work” guides are for teams, projects and “Company knowledge”. Personal spaces have no guide";

export const guideEnabled = (app: Pick<App, "settings">): boolean => app.settings.get<unknown>(GUIDE_ENABLED_SETTING, false) === true;

export function requireGuideEnabled(app: Pick<App, "settings">): void {
  if (!guideEnabled(app)) throw new MemoryError("forbidden", GUIDE_DISABLED_TEXT, { details: { reason: "space_guide_disabled" } });
}

export const guideLimitsOf = (app: Pick<App, "settings">): GuideLimits => guideLimits(app.settings.get<unknown>(GUIDE_SETTING, null));

/** The space through the eyes of the "who changes the map" rule: the caller's role (a correction's target may lack it — null). */
export interface GuideSpaceFacts { kind: string; role: string | null; slug: string; archived_at?: Date | string | null }

/**
 * Who changes the space map: the owner — the owner role (the owner, a space_owner assignment, a manager), in
 * "Company common knowledge" — the curator (org_curator gives the owner role) or the org owner. Personal — none. Archive — only
 * reading. A pure check on an already read space; null — allowed. The same rule decides on edit proposals of the
 * map: the one who writes the map decides, not the record's author.
 */
export function guideWriterProblem(s: GuideSpaceFacts): MemoryError | null {
  if (s.kind === "personal") return invalid(GUIDE_PERSONAL_TEXT, { reason: "space_guide_personal" });
  if (s.role !== "owner")
    return new MemoryError("forbidden", s.kind === "org" ? "Company knowledge curators edit the “How we work” guide in “Company knowledge”"
      : `The owner of space ${s.slug} edits the “How we work” guide`, { details: { reason: "not_owner" } });
  if (s.archived_at) return archivedDenied(s.slug, s.archived_at);
  return null;
}

/** The edit queue key of one space's map (a gateway process lock, as for the profile): the map write and its restore. */
export const guideLockKey = (spaceId: string): string => `space_guide:${spaceId}`;

/** A map row in the class database: current and not deleted. `hidden` — hidden by a class move (running or failed). */
export interface GuideRow { id: string; cls: DataClass; version: number; occurred_at: Date; hidden: boolean }

/**
 * The current map. `busy` — the version is not fit as an edit base now: the rows are hidden by a class move (running or failed,
 * until the class reconciler starts it again) or lie in a database other than the locator's (a move's tail). An edit does not
 * take such a map as its base nor go around it — it answers "being moved": otherwise a new version would lie over a map
 * hidden from the person, bypassing its hiding, or a second chain would start next to it.
 */
export interface GuideRef { id: string; cls: DataClass; version: number; occurred_at: Date; busy: boolean }

/**
 * The current map from both databases' rows (a pure function): highest version; on a tie — the locator's database row, then
 * the visible one, then the later one. No locator — the row counts as in its place (as for meetings, meetings.ts currentMeeting).
 */
export function pickGuide(rows: readonly GuideRow[], home: ReadonlyMap<string, DataClass>): GuideRef | null {
  const atHome = (r: GuideRow) => (home.get(r.id) ?? r.cls) === r.cls;
  const best = [...rows].sort((a, b) => b.version - a.version || Number(atHome(b)) - Number(atHome(a)) || Number(a.hidden) - Number(b.hidden)
                                        || b.occurred_at.getTime() - a.occurred_at.getTime())[0];
  return best ? { id: best.id, cls: best.cls, version: best.version, occurred_at: best.occurred_at, busy: best.hidden || !atHome(best) } : null;
}

/**
 * The space's current map — in both classes (so one hidden from agents, closed, is not lost, and a second "current" does not
 * appear next to it): source `space_guide:<id>`, home in the space, the current version, not deleted — and hidden rows too
 * (marked by `busy`). Only metadata (id, version, date, hidden or not) is read by the system context, plus locators — without
 * content; read rights are the caller's.
 */
export async function currentGuideRef(app: App, spaceId: string): Promise<GuideRef | null> {
  const rows: GuideRow[] = [];
  for (const cls of ["open", "closed"] as const) {
    const got = (await app.db.records(cls, { classes: ["open", "closed"], tier: "system" }).query(
      `SELECT id, version, occurred_at, hidden_at IS NOT NULL AS hidden FROM records
        WHERE source_kind = 'agent' AND source_ref = $1 AND space_id = $2 AND type = 'note' AND is_current AND deleted_at IS NULL`, [spaceGuideRef(spaceId), spaceId])).rows;
    for (const r of got) rows.push({ id: r.id, cls, version: Number(r.version), occurred_at: new Date(r.occurred_at), hidden: r.hidden === true });
  }
  if (!rows.length) return null;
  const home = new Map<string, DataClass>((await app.db.control.query("SELECT record_id, class FROM record_locations WHERE record_id = ANY($1::uuid[])",
    [[...new Set(rows.map((r) => r.id))]])).rows.map((x) => [x.record_id as string, x.class as DataClass]));
  return pickGuide(rows, home);
}

export const GUIDE_RESTORE_TEXT = "This space already has a “How we work” guide, and each space can have only one. This guide will stay in the Trash. Move any content you need to the current guide";

/**
 * Restore from trash (owner.ts restoreFromTrash): a package whose current version is a "How we work" map is not restored while
 * another live map of the same space exists ("one current map per
 * space") — `400 space_guide_exists`, else two "current" ones: page and agents would silently go to the old one, and the new
 * one would stay a second note forever. The check and the restore itself — under the space map lock, the same as its
 * write. A package without a map — `fn` as is.
 */
export async function underGuideRestore<T>(app: App, cls: DataClass, batchId: string, fn: () => Promise<T>): Promise<T> {
  const row = (await app.db.recordsForWrite(cls, "system").query(
    `SELECT space_id FROM records WHERE deleted_batch = $1 AND deleted_at IS NOT NULL AND is_current
        AND type = 'note' AND source_kind = 'agent' AND source_ref = 'space_guide:' || space_id::text LIMIT 1`, [batchId])).rows[0] as { space_id: string } | undefined;
  if (!row) return fn();
  return withKeyLock(guideLockKey(row.space_id), async () => {
    if (await currentGuideRef(app, row.space_id)) throw invalid(GUIDE_RESTORE_TEXT, { reason: "space_guide_exists" });
    return fn();
  });
}
