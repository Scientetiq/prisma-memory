// Directory search: GET /api/v1/directory/search?q= — whom to add to a meeting, whom to open a record to.
// Who may: the workplace (a person's session) and services with the `directory` operation. A cloud agent's personal key may not:
// it gets candidates only from a meeting upload, otherwise an agent could dump the company directory letter by letter.
// From 2 characters (hints while typing; groups from 3), up to 10 people, fields — full name, login, department, title and in_memory; it finds everyone with access to
// memory: people with an active card — always, and from the directory — those who can sign in (an active
// account in the access group) but have no card yet (in_memory=false: they can be invited to a space after their first
// sign-in). Without the directory or on its failure — memory people only, source=memory. The limit is the bucket
// `directory` in limits.personal_per_minute, the directory answer is reused for limits.directory_cache_sec, each search is
// a `directory` event in the log (the query and the number found, not the people themselves).
// GET /api/v1/directory/groups?q= — a directory group the owner binds to a space: only
// a workplace session (a person picks it), DN and name without members, branch ldap.project_groups_base; same bucket and cache.
import { ldapDirectorySource } from "./identity.ts";
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { invalid, LdapFailure, ldapConfig, log, projectGroupsBase, searchTokens, type DirectoryHit, type LdapConfig } from "@memory/shared";
import { audit } from "./audit.ts";
import { HttpReject } from "./auth.ts";
import type { App, Caller } from "./context.ts";
import { directoryReject, ldapDisabled } from "./space-groups.ts";

export const DIRECTORY_MAX = 10;
const CACHE_MAX = 500;

interface Cached { at: number; items: DirectoryHit[]; truncated: boolean }
const cache = new Map<string, Cached>();
interface CachedGroups { at: number; items: Array<{ dn: string; name: string }>; truncated: boolean }
const groupCache = new Map<string, CachedGroups>();

/** Who asks: a person's session (workplace) or a service with the directory operation; others get 403 with an explanation. */
function requireDirectoryCaller(caller: Caller): void {
  if (caller.keyKind === "session" && caller.principalType === "person" && caller.person && !caller.onBehalfOf) return;
  if (caller.principalType === "service" && caller.allowedOps?.has("directory")) return;
  if (caller.principalType === "service") throw new HttpReject(403, "forbidden", "The directory operation is outside the service’s allow-list");
  if (caller.principalType === "system") throw new HttpReject(403, "forbidden", "The system key is for the admin API only");
  throw new HttpReject(403, "forbidden",
    "Directory search is available in the workspace and to services with the directory operation. A cloud agent only gets candidates when uploading a meeting");
}

/** Fingerprint of the settings the directory answer depends on: a new server, base, groups or attributes resets the cache. */
const configPrint = (cfg: LdapConfig): string =>
  createHash("sha256").update(JSON.stringify([cfg.servers, cfg.port, cfg.base_dn, cfg.login_groups, cfg.nested_groups, cfg.attributes])).digest("hex").slice(0, 16);

/** Hints of whom to invite — from 2 characters (two letters already find a name); directory groups — from 3. */
export const PEOPLE_QUERY_MIN = 2;

const likeEscape = (t: string): string => t.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Query → words and limit: min (people 2, groups 3) to 100 characters, limit 1–10; what — the kind searched, for the refusal. */
function queryOf(c: Context, what: string, min: number): { q: string; tokens: string[]; limit: number } {
  const q = (c.req.query("q") ?? "").replace(/\s+/g, " ").trim();
  if (q.length < min) throw invalid(`Enter at least ${min} characters: ${what}`);
  if (q.length > 100) throw invalid("Enter a query of up to 100 characters");
  const tokens = searchTokens(q);
  if (!tokens.length) throw invalid(`Enter at least ${min} characters: ${what}`);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? DIRECTORY_MAX : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > DIRECTORY_MAX) throw invalid(`limit must be between 1 and ${DIRECTORY_MAX}`);
  return { q, tokens, limit };
}

const cacheTtl = (app: App): number => Math.min(3600, Math.max(0, Number(app.settings.get("limits.directory_cache_sec", 600)) || 0)) * 1000;

/** Memory people: active, not demo personas; each word is in the full name or at the start of the login. */
async function memorySearch(app: App, tokens: string[], limit: number): Promise<{ items: DirectoryHit[]; truncated: boolean }> {
  const params: unknown[] = [app.instanceId, limit + 1];
  const words = tokens.map((t) => {
    params.push(likeEscape(t));
    const i = params.length;
    return `(p.display_name ILIKE '%' || $${i} || '%' ESCAPE '\\' OR p.login ILIKE $${i} || '%' ESCAPE '\\')`;
  }).join(" AND ");
  const { rows } = await app.db.control.query(
    `SELECT p.display_name, p.login, p.department, p.role AS title FROM people p
      WHERE p.instance_id = $1 AND p.active AND COALESCE(p.attrs->>'demo','') <> 'true' AND ${words}
      ORDER BY p.display_name, p.login LIMIT $2`, params);
  const items = (rows as DirectoryHit[]).map((r) => ({ display_name: r.display_name, login: r.login, department: r.department ?? null, title: r.title ?? null }));
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

/** A person in the search result: four fields and in_memory — an active card exists (such a person can be invited at once). */
export type SearchHit = DirectoryHit & { in_memory: boolean };

/**
 * Everyone with access to memory: first people with an active card (they can be invited at once), then from the directory — those
 * who have no card yet. The card of a directory person is matched by login separately: the query words could match in the
 * directory (a short name, another spelling of the full name) and not match in memory.
 */
async function withMemory(app: App, mem: { items: DirectoryHit[]; truncated: boolean }, dir: { items: DirectoryHit[]; truncated: boolean } | null,
                          limit: number): Promise<{ items: SearchHit[]; truncated: boolean }> {
  const seen = new Set(mem.items.map((h) => h.login.toLowerCase()));
  const extra = (dir?.items ?? []).filter((h) => !seen.has(h.login.toLowerCase()));
  const carded = new Set<string>();
  if (extra.length) {
    const { rows } = await app.db.control.query(
      `SELECT lower(login) AS login FROM people WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') <> 'true' AND lower(login) = ANY($2)`,
      [app.instanceId, extra.map((h) => h.login.toLowerCase())]);
    for (const r of rows as Array<{ login: string }>) carded.add(r.login);
  }
  const fromDir = extra.map((h) => ({ ...h, in_memory: carded.has(h.login.toLowerCase()) }));
  const all: SearchHit[] = [...mem.items.map((h) => ({ ...h, in_memory: true })), ...fromDir.filter((h) => h.in_memory), ...fromDir.filter((h) => !h.in_memory)];
  return { items: all.slice(0, limit), truncated: mem.truncated || Boolean(dir?.truncated) || all.length > limit };
}

/**
 * Search in the AD directory with the cache limits.directory_cache_sec: the search route and recognizing meeting participants.
 * Directory off — null; directory failure — an exception (code — ldapErrorCode), the caller decides what replaces it.
 */
export async function lookupDirectory(app: App, tokens: string[], limit: number): Promise<{ items: DirectoryHit[]; truncated: boolean; cached: boolean } | null> {
  const cfg = ldapConfig(app.settings);
  if (!cfg.enabled) return null;
  const ttl = cacheTtl(app);
  const key = `${configPrint(cfg)}|${limit}|${tokens.join(" ").toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && ttl > 0 && Date.now() - hit.at < ttl) return { items: hit.items, truncated: hit.truncated, cached: true };
  const r = await ldapDirectorySource.people.search(cfg, tokens, { limit });
  if (ttl > 0) {
    cache.delete(key); cache.set(key, { at: Date.now(), items: r.items, truncated: r.truncated });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return { items: r.items, truncated: r.truncated, cached: false };
}

/** The directory failure code for the answer and the log; the failure itself goes to the log. */
export function ldapErrorCode(e: unknown): string {
  const code = e instanceof LdapFailure ? e.code : "ldap_failed";
  log.warn("directory_search_ldap_failed", { code, error: String((e as Error)?.message ?? e).slice(0, 300) });
  return code;
}

export function registerDirectory(r: Hono<any>, app: App): void {
  r.get("/api/v1/directory/search", async (c: Context) => {
    const caller: Caller = c.get("caller");
    requireDirectoryCaller(caller);
    const { q, tokens, limit } = queryOf(c, "part of a surname, given name or e-mail address", PEOPLE_QUERY_MIN);
    app.limiter.check(caller, "directory");

    let source: "ldap" | "memory" = "memory", ldapError: string | null = null, cached = false;
    let dir: { items: DirectoryHit[]; truncated: boolean } | null = null;
    try {
      const r = await lookupDirectory(app, tokens, limit);
      if (r) { dir = r; source = "ldap"; cached = r.cached; }
    } catch (e) {
      ldapError = ldapErrorCode(e);
    }
    const found = await withMemory(app, await memorySearch(app, tokens, limit), dir, limit);

    await audit(app, caller, { event_type: "directory", query_text: q, result_count: found.items.length,
                               details: { source, cached, truncated: found.truncated, ...(ldapError ? { ldap_error: ldapError } : {}) } });
    return c.json({ source, items: found.items, truncated: found.truncated, ...(ldapError ? { ldap_error: ldapError } : {}) });
  });

  // A directory group to bind to a space: a person picks it — only a workplace session; a cloud agent's
  // key would dump the company's groups letter by letter. No memory fallback: no directory, no groups (409/503).
  r.get("/api/v1/directory/groups", async (c: Context) => {
    const caller: Caller = c.get("caller");
    if (!(caller.keyKind === "session" && caller.principalType === "person" && caller.person && !caller.onBehalfOf))
      throw new HttpReject(403, "forbidden", "A person must choose a directory group for a space in the workspace. Group search is unavailable to agent keys, services and system keys");
    const { q, tokens, limit } = queryOf(c, "part of a group name", 3);
    app.limiter.check(caller, "directory");
    const cfg = ldapConfig(app.settings);
    if (!cfg.enabled) throw ldapDisabled();
    const ttl = cacheTtl(app);
    const key = `${configPrint(cfg)}|${projectGroupsBase(cfg)}|${limit}|${tokens.join(" ").toLowerCase()}`;
    const hit = groupCache.get(key);
    let found: { items: Array<{ dn: string; name: string }>; truncated: boolean }, cached = false;
    if (hit && ttl > 0 && Date.now() - hit.at < ttl) { found = hit; cached = true; }
    else {
      try { found = await ldapDirectorySource.groups.search(cfg, tokens, { limit }); }
      catch (e) { throw directoryReject(e, "directory_groups"); }
      if (ttl > 0) {
        groupCache.delete(key); groupCache.set(key, { at: Date.now(), ...found });
        while (groupCache.size > CACHE_MAX) groupCache.delete(groupCache.keys().next().value!);
      }
    }
    await audit(app, caller, { event_type: "directory", query_text: q, result_count: found.items.length, details: { kind: "groups", cached, truncated: found.truncated } });
    return c.json({ items: found.items, truncated: found.truncated });
  });
}

/** For tests and directory setting changes: forget the answers. */
export const clearDirectoryCache = (): void => { cache.clear(); groupCache.clear(); };
