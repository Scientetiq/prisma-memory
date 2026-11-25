import type pg from "pg";
import { tx } from "./db.ts";
import { MemoryError } from "./errors.ts";
import { ensureProjectEntity, TAG_TREE_SQL } from "./project-entity.ts";
import { RETURN_TARGET_SQL, type OrgReviewState } from "./org-review.ts";
import { spaceMove } from "./space-move.ts";

export type ReturnBy = "curator" | "author" | "auto" | "system";
export interface OrgReturnArgs {
  recordId: string; instanceId: string;
  actorId: string | null;
  by: ReturnBy;
  final: "returned" | "deleted";
  expect?: readonly OrgReviewState[];
  due?: boolean;
}
export type OrgReturnResult =
  | { status: "done"; cls: "open" | "closed"; toSpaceId: string; toSlug: string; toKind: string; orgSpaceId: string; authorId: string; ids: string[]; derived: number }
  | { status: "busy" } | { status: "gone" }
  | { status: "state"; state: OrgReviewState }
  | { status: "card" }
  | { status: "no_target"; authorActive: boolean; authorId: string; cls: "open" | "closed"; orgSpaceId: string };

const ACTIVE: readonly OrgReviewState[] = ["unreviewed", "confirmed", "community"];

export async function returnFromOrg(control: pg.Pool, recordsFor: (cls: "open" | "closed") => pg.Pool, a: OrgReturnArgs): Promise<OrgReturnResult> {
  return tx(control, async (q) => {
    const ok = (await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${a.recordId}`])).rows[0]?.ok;
    if (!ok) return { status: "busy" } as const;
    const row = (await q.query(
      `SELECT r.state, r.exempt_kind, r.from_audience, r.held_at, (r.return_after IS NOT NULL AND r.return_after <= now()) AS due,
              l.class, l.space_id, l.deleted, l.owner_id, s.kind AS space_kind
         FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id JOIN spaces s ON s.id = l.space_id
        WHERE r.record_id = $1 AND r.instance_id = $2 FOR UPDATE OF r`, [a.recordId, a.instanceId])).rows[0];
    if (!row || row.deleted || row.space_kind !== "org") return { status: "gone" } as const;
    if (row.exempt_kind === "org_card") return { status: "card" } as const;
    if (!(a.expect ?? ACTIVE).includes(row.state)) return { status: "state", state: row.state as OrgReviewState } as const;
    if (a.due && (row.held_at !== null || row.due !== true)) return { status: "state", state: row.state as OrgReviewState } as const;
    const t = (await q.query(RETURN_TARGET_SQL, [[a.recordId], a.instanceId])).rows[0];
    if (!t?.target) return { status: "no_target", authorActive: t?.author_active === true, authorId: row.owner_id as string, cls: row.class, orgSpaceId: row.space_id as string } as const;
    const to = (await q.query("SELECT id, slug, name, kind, instance_id FROM spaces WHERE id = $1", [t.target])).rows[0];
    const projectEntity = to.kind === "project" ? await ensureProjectEntity(q, to, { update: false }) : null;
    const db = recordsFor(row.class);
    let out;
    try {
      out = await spaceMove(q, db, { recordId: a.recordId, cls: row.class, toSpaceId: to.id, actorId: a.actorId, authorId: row.owner_id, op: "return", widen: false, onlyFrom: row.space_id },
        async (c, moved, set) => {
          const ids = moved.map((m) => m.id);
          const trace = new Map((await q.query(
            `SELECT DISTINCT ON (record_id) record_id, from_audience FROM space_moves WHERE record_id = ANY($1::uuid[]) AND to_space_id = $2 ORDER BY record_id, at DESC`,
            [set.map((s) => s.id), row.space_id])).rows.map((r) => [r.record_id as string, r.from_audience as string | null]));
          const parentOf = new Map(set.map((s) => [s.id, s.parent_id]));
          const was = new Map<string, string | null>();
          const audienceOf = (id: string, depth = 0): string | null => {
            if (was.has(id)) return was.get(id)!;
            const p = parentOf.get(id);
            const v = trace.has(id) ? trace.get(id)! : id === a.recordId ? row.from_audience
              : p && parentOf.has(p) && depth < 64 ? audienceOf(p, depth + 1) : null;
            was.set(id, v);
            return v;
          };
          const people = ids.filter((id) => audienceOf(id) === "people");
          if (people.length) {
            await c.query("UPDATE records SET audience = 'people' WHERE id = ANY($1::uuid[])", [people]);
            await c.query("UPDATE chunks SET audience = 'people' WHERE record_id = ANY($1::uuid[])", [people]);
          }
          if (projectEntity) await c.query(TAG_TREE_SQL, [a.recordId, projectEntity]);
          return people.length;
        });
    } catch (e) {
      if (e instanceof MemoryError && e.code === "in_progress") return { status: "busy" } as const;
      throw e;
    }
    if (out.status !== "moved") return { status: "gone" } as const;
    await q.query(
      `UPDATE org_reviews SET state = $2, returned_to = $3, decided_at = now(), decided_by = $4, decided_via = $5, returns = returns + 1
        WHERE record_id = $1`, [a.recordId, a.final, to.id, a.actorId, a.by]);
    const parts = out.moved.map((m) => m.id).filter((id) => id !== a.recordId);
    if (parts.length)
      await q.query(
        `UPDATE org_reviews SET state = $2, returned_to = $3, decided_at = now(), decided_by = $4, decided_via = $5, returns = returns + 1
          WHERE record_id = ANY($1::uuid[]) AND state IN ('unreviewed','confirmed','community')`, [parts, a.final, to.id, a.actorId, a.by]);
    return { status: "done", cls: row.class, toSpaceId: to.id, toSlug: to.slug, toKind: to.kind, orgSpaceId: row.space_id, authorId: row.owner_id,
             ids: out.moved.map((m) => m.id), derived: out.moved.filter((m) => m.id !== a.recordId).length } as const;
  });
}
