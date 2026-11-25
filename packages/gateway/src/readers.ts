import { notFound, type DataClass } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { loadReadable, spacesOfMany, type SpaceAccess, type SpaceKind } from "./access.ts";
import { orgSpace, orgUnitsOf } from "./org-hold.ts";
import { isUuidParam } from "./paging.ts";
import { spaceMembersRead } from "./visibility.ts";
import { requireHuman } from "./workplace.ts";

export const PEOPLE_MAX = 30;

export interface ReaderSpace {
  name: string | null;
  kind: SpaceKind;
  members: number | null;
}

export interface ReadersView {
  class: DataClass;
  audience: "space" | "people";
  home: ReaderSpace;
  people: Array<{ login: string; display_name: string | null; owner?: true }>;
  people_more: number;
  meeting: boolean;
  pending: number;
  placements: ReaderSpace[];
  owner_in_spaces: boolean;
  agents: "readers" | "none" | "held";
  owner_extended?: true;
  copied_from: { login: string; display_name: string | null; at: string | null } | null;
}

async function copiedFrom(app: App, attrs: Record<string, any> | null | undefined): Promise<ReadersView["copied_from"]> {
  const c = attrs?.copied_from;
  if (!c || typeof c !== "object" || !isUuidParam(c.person)) return null;
  const p = (await app.db.control.query("SELECT login, display_name FROM people WHERE id = $1 AND instance_id = $2", [c.person, app.instanceId])).rows[0];
  if (!p) return null;
  const at = typeof c.at === "string" && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : null;
  return { login: p.login, display_name: p.display_name ?? null, at };
}

type Q = { query: (sql: string, v?: unknown[]) => Promise<{ rows: any[] }> };

async function spacesInfo(app: App, ids: readonly string[], readable: ReadonlyMap<string, SpaceAccess>): Promise<Map<string, ReaderSpace>> {
  const out = new Map<string, ReaderSpace>();
  if (!ids.length) return out;
  const { rows } = await app.db.control.query(
    `SELECT s.id, s.kind, (SELECT count(DISTINCT m.person_id) FROM space_members_effective m WHERE m.space_id = s.id)::int AS members
     FROM spaces s WHERE s.id = ANY($1::uuid[]) AND s.instance_id = $2`, [[...new Set(ids)], app.instanceId]);
  for (const r of rows) {
    const kind = r.kind as SpaceKind;
    out.set(r.id, { name: readable.get(r.id)?.name ?? null, kind, members: kind === "org" ? null : kind === "personal" ? 1 : (r.members as number) });
  }
  return out;
}

async function meetingOf(db: Q, rec: { type: string; parent_id: string | null; attrs: Record<string, any> }): Promise<{ meeting: boolean; pending: number }> {
  const count = (list: unknown): number => (Array.isArray(list) ? list.length : 0);
  if (rec.type === "transcript") return { meeting: true, pending: count(rec.attrs?.participants_pending) };
  if (!rec.parent_id) return { meeting: false, pending: 0 };
  const parent = (await db.query("SELECT type, attrs FROM records WHERE id = $1 AND deleted_at IS NULL", [rec.parent_id])).rows[0];
  return parent?.type === "transcript" ? { meeting: true, pending: count(parent.attrs?.participants_pending) } : { meeting: false, pending: 0 };
}

export async function recordReaders(app: App, caller: Caller, id: string): Promise<ReadersView> {
  await requireHuman(app, caller, "Who can see the record", { path: `/records/${id}`, section: "Record" });
  if (!isUuidParam(id)) throw notFound();
  const { rec, db, spaces } = await loadReadable(app, caller, id);
  const inSpace = spaceMembersRead(rec);
  const placedIds = inSpace
    ? (await db.query("SELECT space_id FROM record_placements WHERE record_id = $1", [rec.id])).rows.map((r) => r.space_id as string).filter((s) => s !== rec.space_id)
    : [];
  const info = await spacesInfo(app, [rec.space_id, ...placedIds], spaces);
  const listed = (await db.query("SELECT person_id FROM record_people WHERE record_id = $1", [rec.id])).rows.map((r) => r.person_id as string);
  const people = (await app.db.control.query(
    "SELECT id, login, display_name FROM people WHERE id = ANY($1::uuid[]) AND instance_id = $2 AND active", [[...new Set([rec.owner_id, ...listed])], app.instanceId])).rows as
    Array<{ id: string; login: string; display_name: string | null }>;
  const byName = (a: { login: string; display_name: string | null }, b: { login: string; display_name: string | null }) =>
    (a.display_name ?? a.login).localeCompare(b.display_name ?? b.login, "ru") || a.login.localeCompare(b.login);
  const me = caller.person?.id ?? null;
  const ordered = [...people.filter((p) => p.id === rec.owner_id), ...people.filter((p) => p.id === me && p.id !== rec.owner_id),
    ...people.filter((p) => p.id !== rec.owner_id && p.id !== me).sort(byName)];
  const ownerInSpaces = inSpace && ((await spacesOfMany(app, [rec.owner_id], [rec.space_id, ...placedIds])).get(rec.owner_id)?.size ?? 0) > 0;
  const org = await orgSpace(app);
  const held = !!org && rec.space_id === org.id && !!(await orgUnitsOf(app.db.control, db, [rec.id])).get(rec.id)?.held_at;
  const isOwner = rec.owner_id === caller.person?.id;
  const extended = isOwner && rec.class === "closed" && ((await app.db.control.query(
    `SELECT 1 FROM api_keys WHERE principal_type = 'person' AND principal_id = $1 AND kind = 'extended' AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [rec.owner_id])).rowCount ?? 0) > 0;
  return {
    class: rec.class, audience: rec.audience,
    home: info.get(rec.space_id) ?? { name: null, kind: "personal", members: null },
    people: ordered.slice(0, PEOPLE_MAX).map((p) => ({ login: p.login, display_name: p.display_name ?? null, ...(p.id === rec.owner_id ? { owner: true as const } : {}) })),
    people_more: Math.max(0, ordered.length - PEOPLE_MAX),
    ...(await meetingOf(db, rec)),
    placements: placedIds.map((s) => info.get(s)).filter((x): x is ReaderSpace => !!x),
    owner_in_spaces: ownerInSpaces,
    agents: rec.class === "closed" ? "none" : held ? "held" : "readers",
    ...(extended ? { owner_extended: true as const } : {}),
    copied_from: isOwner ? await copiedFrom(app, rec.attrs) : null,
  };
}
