import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_ROLES, CONTRACTS_DIR, type AdminRole, type RouteClass } from "@memory/shared";

export interface RouteDef {
  id: string;
  method: string;
  path: string;
  class: RouteClass;
  condition?: string;
  roles: AdminRole[];
  breakglass: boolean;
  approvers?: AdminRole[];
  always?: boolean;
  action?: string;
  subject_param?: string;
  note?: string;
}
interface Compiled { def: RouteDef; re: RegExp; statics: number }

export const ADMIN_ROUTES_FILE = join(CONTRACTS_DIR, "admin", "admin-routes.json");

export const ROUTE_CLASSES: readonly RouteClass[] = ["read", "narrow", "ordinary", "second_signature", "conditional", "test_only", "removed", "auth"];
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function routeDefProblems(defs: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const [i, raw] of defs.entries()) {
    const d = (raw ?? {}) as Partial<Record<keyof RouteDef, unknown>>;
    const at = `row ${i}${typeof d.id === "string" ? ` (${d.id})` : ""}`;
    if (typeof d.id !== "string" || !d.id) out.push(`${at}: missing id`);
    if (typeof d.method !== "string" || !METHODS.has(d.method)) out.push(`${at}: method ${String(d.method)}`);
    if (typeof d.path !== "string" || !d.path.startsWith("/")) out.push(`${at}: path ${String(d.path)}`);
    if (!ROUTE_CLASSES.includes(d.class as RouteClass)) out.push(`${at}: unknown class ${String(d.class)}`);
    const roles = d.roles;
    if (!Array.isArray(roles) || roles.some((r) => !ADMIN_ROLES.includes(r as AdminRole)) || (roles.length === 0 && d.class !== "auth"))
      out.push(`${at}: roles ${JSON.stringify(roles)}`);
    if (typeof d.breakglass !== "boolean") out.push(`${at}: breakglass must be true/false`);
    if (d.always !== undefined && typeof d.always !== "boolean") out.push(`${at}: always must be true/false`);
    if (d.action !== undefined && (typeof d.action !== "string" || !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(d.action))) out.push(`${at}: action ${String(d.action)}`);
    if (d.subject_param !== undefined && (typeof d.subject_param !== "string" || typeof d.path !== "string" || !d.path.split("/").includes(`:${d.subject_param}`)))
      out.push(`${at}: subject_param ${String(d.subject_param)} does not exist in the path`);
    if ((d.always !== undefined || d.action !== undefined || d.subject_param !== undefined) && d.class !== "second_signature" && d.class !== "conditional")
      out.push(`${at}: always, action and subject_param are valid only for second_signature and conditional`);
  }
  return out;
}

export const actionOf = (def: Pick<RouteDef, "id"> & { action?: string }): string => def.action ?? def.id;

export function routeParam(template: string, path: string, name: string): string | null {
  const t = template.split("/").filter(Boolean), p = path.split("/").filter(Boolean);
  if (t.length !== p.length) return null;
  if (t.some((segment, index) => !segment.startsWith(":") && segment !== p[index])) return null;
  const i = t.indexOf(`:${name}`);
  if (i < 0) return null;
  try { return decodeURIComponent(p[i]!); } catch { return null; }
}

export function compilePath(path: string): { re: RegExp; statics: number } {
  const segs = path.split("/").filter(Boolean);
  let statics = 0;
  const body = segs.map((s) => {
    if (s.startsWith(":")) return "/[^/]+";
    if (s === "*") return "(?:/.*)?";
    statics++;
    return "/" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return { re: new RegExp(`^${body || "/"}/?$`), statics };
}

function compile(defs: readonly RouteDef[]): Compiled[] {
  return defs.map((def) => ({ def, ...compilePath(def.path) }));
}

let cache: { defs: RouteDef[]; compiled: Compiled[] } | null = null;

export function adminRouteDefs(file = ADMIN_ROUTES_FILE): RouteDef[] {
  if (cache && file === ADMIN_ROUTES_FILE) return cache.defs;
  const doc = JSON.parse(readFileSync(file, "utf8")) as { format?: string; routes?: RouteDef[] };
  if (doc.format !== "memory-admin-routes/1" || !Array.isArray(doc.routes)) throw new Error(`${file}: expected memory-admin-routes/1`);
  const problems = routeDefProblems(doc.routes);
  if (problems.length) throw new Error(`${file}: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` and ${problems.length - 5} more` : ""}`);
  const defs = doc.routes;
  if (file === ADMIN_ROUTES_FILE) cache = { defs, compiled: compile(defs) };
  return defs;
}

export function matchRoute<T extends { method: string }>(list: ReadonlyArray<{ def: T; re: RegExp; statics: number }>, method: string, path: string): T | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  let best: { def: T; statics: number } | null = null;
  for (const x of list) {
    if (x.def.method.toUpperCase() !== m && x.def.method !== "ALL") continue;
    if (!x.re.test(path)) continue;
    if (!best || x.statics > best.statics) best = { def: x.def, statics: x.statics };
  }
  return best?.def ?? null;
}

export function routeOf(method: string, path: string): RouteDef | null {
  if (!cache) adminRouteDefs();
  return matchRoute(cache!.compiled, method, path);
}

export function setRoutesForTests(defs: RouteDef[] | null): void {
  cache = defs ? { defs, compiled: compile(defs) } : null;
}
