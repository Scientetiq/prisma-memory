import { entityId, parseEntityKey } from "./ids.ts";

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface ProjectEntitySpace { id: string; slug: string; name: string; instance_id: string }
export const PROJECT_TAG_ROLE = "space";

export function projectEntityId(slug: string): string {
  const key = parseEntityKey(`project:${slug}`);
  if (!key) throw new Error("invalid_project_slug");
  return entityId(key);
}

export async function ensureProjectEntity(q: Queryable, space: ProjectEntitySpace, opts: { update?: boolean } = {}): Promise<string | null> {
  const id = projectEntityId(space.slug);
  const created = await q.query(
    `INSERT INTO entities (id, kind, external_system, external_id, display_name, attrs, instance_id)
     VALUES ($1, 'project', 'memory', $2, $3, jsonb_build_object('space_id', $4::text), $5)
     ON CONFLICT DO NOTHING RETURNING id`, [id, space.slug, space.name, space.id, space.instance_id]);
  if (created.rows.length) return id;
  const own = await q.query(
    `SELECT id FROM entities WHERE id = $1 AND attrs->>'space_id' = $2
       AND kind = 'project' AND external_system = 'memory' AND external_id = $3 AND instance_id = $4`,
    [id, space.id, space.slug, space.instance_id]);
  if (!own.rows.length) return null;
  if (opts.update) await q.query(
    `UPDATE entities SET display_name = $3, updated_at = now()
     WHERE id = $1 AND attrs->>'space_id' = $2 AND display_name IS DISTINCT FROM $3`, [id, space.id, space.name]);
  return id;
}

export async function projectEntityReadable(q: Queryable, personId: string | null | undefined, spaceId: string, o: { archived?: "read" } = {}): Promise<boolean> {
  if (!personId) return false;
  const { rows } = await q.query(
    `SELECT EXISTS (SELECT 1 FROM spaces s JOIN space_members_effective m ON m.space_id = s.id
       WHERE s.id = $2 AND s.kind = 'project' AND (s.archived_at IS NULL OR $3::boolean) AND m.person_id = $1) AS readable`, [personId, spaceId, o.archived === "read"]);
  return rows[0]?.readable === true;
}

export const TAG_TREE_SQL = `WITH RECURSIVE tree AS (
  SELECT id FROM records WHERE id = $1
  UNION ALL SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id
)
INSERT INTO record_entities (record_id, entity_id, role, method, confidence)
SELECT r.id, $2, 'space', 'stated_by_human', 1.0 FROM records r
WHERE r.id IN (SELECT id FROM tree) AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING`;
