import type pg from "pg";
import {
  AUTHOR_RULES, binder, gateAllows, visibleRow, visibleSql,
  type ArchiveFilter, type AuthorRule, type CallerKind, type ClassGate, type ClassScope, type DataClass, type RowFacts, type VisibilitySpec,
} from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { isExternal } from "./channel.ts";

export function classGate(scope: Pick<ClassScope, "classes">, keyKind: CallerKind): Record<DataClass, ClassGate> {
  const one = (cls: DataClass): ClassGate => !scope.classes.includes(cls) ? "none" : cls === "closed" && keyKind === "extended" ? "own" : "all";
  return { open: one("open"), closed: one("closed") };
}

export const gateOf = (caller: Pick<Caller, "scope" | "keyKind">): Record<DataClass, ClassGate> => classGate(caller.scope, caller.keyKind);

export const classAllowed = (caller: Pick<Caller, "scope" | "keyKind" | "person">, cls: DataClass, ownerId: string): boolean =>
  gateOf(caller)[cls] !== "own" || ownerId === caller.person?.id;

export function hiddenClosedSql(caller: Pick<Caller, "scope" | "keyKind" | "channel">): string | null {
  if (isExternal(caller)) return null;
  const g = gateOf(caller).closed;
  return g === "none" ? "TRUE" : g === "own" ? "l.owner_id <> $me" : null;
}

export function authorRule(app: Pick<App, "settings">): AuthorRule {
  const v = app.settings.get<unknown>("access.author_rule", "legacy");
  return (AUTHOR_RULES as readonly unknown[]).includes(v) ? (v as AuthorRule) : "legacy";
}

export type SpaceSet = ReadonlyMap<string, unknown> | Iterable<string>;
const idsOf = (s: SpaceSet): string[] => (s instanceof Map ? [...s.keys()] : [...(s as Iterable<string>)]);

export function byIdSpec(caller: Pick<Caller, "scope" | "keyKind" | "person">, spaces: SpaceSet): VisibilitySpec {
  const me = caller.person?.id ?? null;
  return { principals: me ? [{ id: me, spaces: idsOf(spaces) }] : [], asker: me, gate: gateOf(caller), owner: "always" };
}

export function listingSpec(app: Pick<App, "settings">, caller: Pick<Caller, "scope" | "keyKind" | "person">, spaces: SpaceSet, scope: readonly string[] | null = null,
                            archive: ArchiveFilter | null = null): VisibilitySpec {
  return { ...byIdSpec(caller, spaces), owner: authorRule(app), scope, archive };
}

type Queryable = Pick<pg.Pool, "query">;
export type VisibleRec = Pick<RowFacts, "id" | "space_id" | "audience" | "owner_id" | "class">;

export async function recordVisible(db: Queryable, caller: Pick<Caller, "scope" | "keyKind" | "person">, rec: VisibleRec, spaces: SpaceSet): Promise<boolean> {
  if (!caller.person) return false;
  const v = byIdSpec(caller, spaces), me = caller.person.id;
  if (!gateAllows(v.gate[rec.class], rec.owner_id, v.asker)) return false;
  const base: RowFacts = { id: rec.id, owner_id: rec.owner_id, audience: rec.audience, space_id: rec.space_id, class: rec.class, listed: [], placed: [] };
  if (visibleRow(v, base)) return true;
  const listed = async (): Promise<string[]> =>
    ((await db.query("SELECT 1 FROM record_people WHERE record_id = $1 AND person_id = $2", [rec.id, me])).rowCount ?? 0) > 0 ? [me] : [];
  if (rec.audience === "people") return visibleRow(v, { ...base, listed: await listed() });
  const placed = (await db.query("SELECT space_id FROM record_placements WHERE record_id = $1", [rec.id])).rows.map((p) => p.space_id as string);
  if (visibleRow(v, { ...base, placed })) return true;
  return visibleRow(v, { ...base, placed, listed: await listed() });
}

export const spaceMembersRead = (rec: Pick<VisibleRec, "audience">): boolean => rec.audience === "space";

export async function factsFor(db: Queryable, ids: readonly string[], personId: string): Promise<Map<string, { listed: string[]; placed: string[] }>> {
  const out = new Map<string, { listed: string[]; placed: string[] }>(ids.map((id) => [id, { listed: [], placed: [] }]));
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT 'p'::text AS k, rp.record_id, NULL::uuid AS space_id FROM record_people rp WHERE rp.record_id = ANY($1::uuid[]) AND rp.person_id = $2
     UNION ALL
     SELECT 'l'::text, pl.record_id, pl.space_id FROM record_placements pl WHERE pl.record_id = ANY($1::uuid[])`, [ids, personId]);
  for (const r of rows) {
    const f = out.get(r.record_id as string);
    if (f) { if (r.k === "p") f.listed.push(personId); else f.placed.push(r.space_id as string); }
  }
  return out;
}

export interface DerivedRow { id: string; type: string; event_kind: string | null; title: string | null }

export async function derivedVisible(db: Queryable, caller: Pick<Caller, "scope" | "keyKind" | "person">, parent: Pick<VisibleRec, "id" | "class">, spaces: SpaceSet): Promise<DerivedRow[]> {
  const args: unknown[] = [], bind = binder(args);
  const visible = visibleSql(byIdSpec(caller, spaces), parent.class, bind);
  if (visible === null) return [];
  return (await db.query(
    `SELECT r.id, r.type, r.event_kind, r.title FROM records r
      WHERE r.parent_id = ${bind(parent.id)} AND r.deleted_at IS NULL AND r.is_current AND r.hidden_at IS NULL AND ${visible}
      ORDER BY r.occurred_at, r.id`, args)).rows;
}

export interface ByIdRow { id: string; space_id: string; type: string; title: string | null; occurred_at: Date | string; owner_id: string; parent_id: string | null }

export async function byIdVisible(db: Queryable, caller: Pick<Caller, "scope" | "keyKind" | "person">, cls: DataClass, ids: readonly string[], spaces: SpaceSet): Promise<ByIdRow[]> {
  if (!ids.length || !caller.person) return [];
  const args: unknown[] = [], bind = binder(args);
  const visible = visibleSql(byIdSpec(caller, spaces), cls, bind);
  if (visible === null) return [];
  return (await db.query(
    `SELECT r.id, r.space_id, r.type, r.title, r.occurred_at, r.owner_id, r.parent_id FROM records r
      WHERE r.id = ANY(${bind([...ids])}::uuid[]) AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND ${visible}`, args)).rows;
}

export interface DerivedEventRow {
  id: string; event_kind: string | null; title: string | null; due: string | null; actors: unknown; actors_role: string | null; time_from: string | null;
}

export async function derivedEventsVisible(db: Queryable, caller: Pick<Caller, "scope" | "keyKind" | "person">, parent: Pick<VisibleRec, "id" | "class">, spaces: SpaceSet): Promise<DerivedEventRow[]> {
  const args: unknown[] = [], bind = binder(args);
  const visible = visibleSql(byIdSpec(caller, spaces), parent.class, bind);
  if (visible === null) return [];
  return (await db.query(
    `SELECT r.id, r.event_kind, r.title, r.attrs->>'due' AS due, r.attrs->'actors' AS actors, r.attrs->>'actors_role' AS actors_role,
            r.locator->>'time_from' AS time_from FROM records r
      WHERE r.parent_id = ${bind(parent.id)} AND r.type = 'event' AND r.deleted_at IS NULL AND r.is_current AND r.hidden_at IS NULL AND ${visible}
      ORDER BY r.occurred_at, r.id`, args)).rows;
}
