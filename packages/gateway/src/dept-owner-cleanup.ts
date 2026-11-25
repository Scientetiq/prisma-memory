// One-time clean-up of traces of "a head added themselves as a member" in the space of their own department.
// Before the fix, adding oneself as a member turned the head's derived owner row (owner/org)
// into a manual one (owner/manual): reconciliation skips manual rows, so the owner rights stayed after a change
// of head: trashing colleagues' records, inviting people. Those who are still the head are set right by
// 05-access-model.sql (the row is derived again). Here the rest: a manual owner row from self-adding looks in the database like
// an administrator's assignment (PUT /admin/spaces/:slug); only the audit log, kept in another database, tells them apart; the
// schema SQL cannot read it. So the clean-up is in the gateway, once at start (a mark in maintenance_state).
//
// Lowered to member (role = member, the membership stays manual, as adding a member promises) is only a manual owner
// row in a department space whose holder is not now the active head of that department, when the log
// has their adding themselves to this space (memory_space_add_member, details.person is the caller, also
// through a service on their behalf) and no owner assignment by an administrator (space_owner_set): an administrator's choice is
// not overridden. Events older than the log retention are gone: such rows stay (visible in the space membership on the panel).
// The log is unavailable: no mark is set, the clean-up repeats at the next start; a repeat changes nothing.
// Audit archive: once older months were dropped, the absence of an assignment by an administrator (space_owner_set)
// can no longer be proven — it may be in the archive. Then nobody is demoted (the row stays, as for events older than the
// retention above), the mark is set with the count of rows left (skipped_archived).
import { auditArchivedBefore, log } from "@memory/shared";
import type { App } from "./context.ts";
import { audit } from "./audit.ts";

const MARK = "dept_self_owner_cleanup";

/** Owner row in a department space of someone who is not now the active head of that department. */
const NOT_HEAD_SQL = `NOT EXISTS (SELECT 1 FROM person_org_units h JOIN people hp ON hp.id = h.person_id AND hp.active
                                  WHERE h.org_unit_id = s.org_unit_id AND h.person_id = m.person_id AND h.relation = 'head')`;

export interface DeptSelfOwnerCleanup { checked: number; demoted: Array<{ space_id: string; person_id: string }>; skipped_archived?: number }

/** null: the clean-up already ran (a mark in maintenance_state). A database or log error is an exception, no mark. */
export async function demoteSelfAddedDeptOwners(app: App): Promise<DeptSelfOwnerCleanup | null> {
  const ctl = app.db.control;
  if ((await ctl.query("SELECT 1 FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, MARK])).rowCount) return null;
  const candidates = (await ctl.query(
    `SELECT m.space_id::text AS space_id, m.person_id::text AS person_id FROM space_members m JOIN spaces s ON s.id = m.space_id
     WHERE s.instance_id = $1 AND s.org_unit_id IS NOT NULL AND m.role = 'owner' AND m.source = 'manual' AND ${NOT_HEAD_SQL}`, [app.instanceId])).rows as Array<{ space_id: string; person_id: string }>;
  const demoted: DeptSelfOwnerCleanup["demoted"] = [];
  const archived = candidates.length ? await auditArchivedBefore(app.db.auditRead()) : null;
  if (candidates.length && !archived) {
    const spaces = [...new Set(candidates.map((x) => x.space_id))], people = [...new Set(candidates.map((x) => x.person_id))];
    const journal = app.db.auditRead();
    const key = (x: { space_id: string; person_id: string }) => `${x.space_id}:${x.person_id}`;
    const selfAdded = new Set((await journal.query(
      `SELECT DISTINCT space_id::text AS space_id, COALESCE(on_behalf_of, principal_id)::text AS person_id FROM audit_events
       WHERE instance_id = $1 AND event_type = 'admin' AND space_id = ANY($2::uuid[])
         AND (principal_id = ANY($3::uuid[]) OR on_behalf_of = ANY($3::uuid[]))
         AND details->>'tool' = 'memory_space_add_member' AND details->>'person' = COALESCE(on_behalf_of, principal_id)::text`,
      [app.instanceId, spaces, people])).rows.map(key));
    const assigned = new Set((await journal.query(
      `SELECT DISTINCT details->>'space' AS space_id, details->>'owner' AS person_id FROM audit_events
       WHERE instance_id = $1 AND event_type = 'admin' AND details->>'op' = 'space_owner_set'
         AND details->>'space' = ANY($2::text[]) AND details->>'owner' = ANY($3::text[])`,
      [app.instanceId, spaces, people])).rows.map(key));
    for (const x of candidates) {
      if (!selfAdded.has(key(x)) || assigned.has(key(x))) continue;
      const r = await ctl.query(
        `UPDATE space_members m SET role = 'member' FROM spaces s
         WHERE s.id = m.space_id AND m.space_id = $1 AND m.person_id = $2 AND m.role = 'owner' AND m.source = 'manual' AND ${NOT_HEAD_SQL}`, [x.space_id, x.person_id]);
      if (!r.rowCount) continue;
      demoted.push(x);
      await audit(app, null, { event_type: "admin", space_id: x.space_id, details: { op: "dept_self_owner_demoted", person: x.person_id } });
    }
  }
  const out = { checked: candidates.length, demoted, ...(archived ? { skipped_archived: candidates.length } : {}) };
  await ctl.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [app.instanceId, MARK, JSON.stringify({ checked: out.checked, demoted: demoted.length, ...(archived ? { skipped_archived: candidates.length } : {}) })]);
  log.info("dept_self_owner_cleanup", { checked: out.checked, demoted: demoted.length, ...(archived ? { skipped_archived: candidates.length } : {}) });
  return out;
}
