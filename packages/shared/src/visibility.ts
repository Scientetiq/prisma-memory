import type { DataClass } from "./db.ts";

export type ClassGate = "all" | "own" | "none";

export type AuthorRule = "legacy" | "always";
export const AUTHOR_RULES: readonly AuthorRule[] = ["legacy", "always"];

export type ArchiveMode = "include" | "exclude";
export interface ArchiveFilter { mode: ArchiveMode; spaceIds: readonly string[] }
export const ARCHIVE_INCLUDE: ArchiveFilter = Object.freeze({ mode: "include" as const, spaceIds: Object.freeze([]) as readonly string[] });

export interface Principal { id: string; spaces: readonly string[] }

export interface VisibilitySpec {
  principals: readonly Principal[];
  asker: string | null;
  gate: Readonly<Record<DataClass, ClassGate>>;
  owner: AuthorRule;
  scope?: readonly string[] | null;
  archive?: ArchiveFilter | null;
}

export interface RowFacts {
  id: string; owner_id: string; audience: "space" | "people"; space_id: string; class: DataClass;
  listed: readonly string[];
  placed: readonly string[];
}

export type Bind = (value: unknown) => string;

export function binder(args: unknown[]): Bind {
  return (value: unknown): string => {
    if (value === null || value === undefined) throw new Error("visibility: a condition parameter cannot be NULL");
    if (Array.isArray(value) && value.some((x) => x === null || x === undefined)) throw new Error("visibility: NULL in a condition parameter array");
    args.push(Array.isArray(value) ? [...value] : value);
    return `$${args.length}`;
  };
}

function reader(v: VisibilitySpec): Principal | null {
  if (v.principals.length > 1) throw new Error("visibility: the audience form supports multiple readers, but it is not enabled here");
  return v.principals[0] ?? null;
}

function excludedOf(v: VisibilitySpec, p: Principal | null): readonly string[] | null {
  const a = v.archive;
  if (!a || a.mode !== "exclude" || !a.spaceIds.length) return null;
  if (p) { const A = new Set(a.spaceIds); if (p.spaces.some((s) => A.has(s))) throw new Error("visibility: exclude mode includes an archived space among the readable spaces (S ∩ A ≠ ∅)"); }
  return a.spaceIds;
}

export function gateAllows(g: ClassGate, ownerId: string, asker: string | null): boolean {
  return g === "all" || (g === "own" && asker !== null && ownerId === asker);
}

export function visibleRow(v: VisibilitySpec, r: RowFacts): boolean {
  const p = reader(v);
  if (!p) return false;
  const A = excludedOf(v, p);
  if (!gateAllows(v.gate[r.class], r.owner_id, v.asker)) return false;
  const S = new Set(p.spaces), inSpace = r.audience === "space";
  const homeLive = !A || !A.includes(r.space_id);
  const person = (inSpace && S.has(r.space_id))
    || (homeLive && ((r.owner_id === p.id && (v.owner === "always" || r.audience === "people")) || r.listed.includes(p.id)))
    || (inSpace && r.placed.some((s) => S.has(s)));
  if (!person) return false;
  if (v.scope !== null && v.scope !== undefined) {
    const F = new Set(v.scope);
    if (!(F.has(r.space_id) || (inSpace && r.placed.some((s) => F.has(s))))) return false;
  }
  return true;
}

function scopeSql(F: string, a: string): string {
  return `(${a}.space_id = ANY(${F}::uuid[]) OR (${a}.audience = 'space' AND EXISTS (SELECT 1 FROM record_placements pl2 WHERE pl2.record_id = ${a}.id AND pl2.space_id = ANY(${F}::uuid[]))))`;
}

export function visibleSql(v: VisibilitySpec, cls: DataClass, bind: Bind, alias = "r"): string | null {
  const g = v.gate[cls];
  if (g === "none") return null;
  const p = reader(v);
  const A = excludedOf(v, p);
  if (!p || (g === "own" && v.asker === null) || (v.scope && !v.scope.length)) return "FALSE";
  const a = alias, S = bind(p.spaces), me = bind(p.id);
  const owner = v.owner === "always" ? `${a}.owner_id = ${me}::uuid` : `(${a}.audience = 'people' AND ${a}.owner_id = ${me}::uuid)`;
  const listed = `EXISTS (SELECT 1 FROM record_people rp WHERE rp.record_id = ${a}.id AND rp.person_id = ${me}::uuid)`;
  const personal = A ? `(${a}.space_id <> ALL(${bind(A)}::uuid[]) AND (${owner} OR ${listed}))` : `${owner} OR ${listed}`;
  let sql = `((${a}.audience = 'space' AND ${a}.space_id = ANY(${S}::uuid[]))`
    + ` OR ${personal}`
    + ` OR (${a}.audience = 'space' AND EXISTS (SELECT 1 FROM record_placements pl WHERE pl.record_id = ${a}.id AND pl.space_id = ANY(${S}::uuid[]))))`;
  if (g === "own") sql += ` AND ${a}.owner_id = ${bind(v.asker)}::uuid`;
  if (v.scope) sql += ` AND ${scopeSql(bind(v.scope), a)}`;
  return `(${sql})`;
}

export function directQuery(v: VisibilitySpec, cls: DataClass, bind: Bind): string | null {
  if (v.gate[cls] === "none") return null;
  const p = reader(v);
  const A = excludedOf(v, p);
  if (!p || (v.scope && !v.scope.length)) return "SELECT NULL::uuid AS id WHERE FALSE";
  const me = bind(p.id);
  const inF = (v.scope ? ` AND r.space_id = ANY(${bind(v.scope)}::uuid[])` : "") + (A ? ` AND r.space_id <> ALL(${bind(A)}::uuid[])` : "");
  const listed = `SELECT rp.record_id AS id FROM record_people rp JOIN records_live r ON r.id = rp.record_id WHERE rp.person_id = ${me}::uuid${inF}`;
  if (v.owner === "always") return listed;
  return `${listed} UNION SELECT r.id FROM records_live r WHERE r.owner_id = ${me}::uuid AND r.audience = 'people'${inF}`;
}

export interface PrefilterOwner { id: string; scope: readonly string[] | null; exclude?: readonly string[] | null }

export function prefilterOwner(v: VisibilitySpec, cls: DataClass): PrefilterOwner | null {
  if (v.owner !== "always" || v.gate[cls] === "none") return null;
  const p = reader(v);
  const A = excludedOf(v, p);
  if (!p || (v.scope && !v.scope.length)) return null;
  return { id: p.id, scope: v.scope ?? null, exclude: A };
}

export interface PrefilterGrants { spaceIds: readonly string[]; placed: readonly string[]; direct: readonly string[]; owner?: PrefilterOwner | null }

export function prefilterSql(g: PrefilterGrants, bind: Bind, t: "c" | "r"): string {
  const rid = t === "c" ? "c.record_id" : "r.id";
  let own = "";
  if (g.owner) {
    const me = bind(g.owner.id), F = g.owner.scope, A = g.owner.exclude?.length ? g.owner.exclude : null;
    const inF = (a: string) => (F ? ` AND ${a}.space_id = ANY(${bind(F)}::uuid[])` : "") + (A ? ` AND ${a}.space_id <> ALL(${bind(A)}::uuid[])` : "");
    own = t === "r"
      ? ` OR (r.owner_id = ${me}::uuid${inF("r")})`
      : ` OR EXISTS (SELECT 1 FROM records o WHERE o.id = c.record_id AND o.owner_id = ${me}::uuid AND o.deleted_at IS NULL${inF("o")})`;
  }
  return `((${t}.audience = 'space' AND (${t}.space_id = ANY(${bind(g.spaceIds)}::uuid[]) OR ${rid} = ANY(${bind(g.placed)}::uuid[]))) OR ${rid} = ANY(${bind(g.direct)}::uuid[])${own})`;
}

export function gateSql(v: Pick<VisibilitySpec, "gate" | "asker">, cls: DataClass, bind: Bind, alias = "r"): string | null {
  const g = v.gate[cls];
  if (g === "none") return null;
  if (g === "all") return "";
  return v.asker === null ? " AND FALSE" : ` AND ${alias}.owner_id = ${bind(v.asker)}::uuid`;
}
