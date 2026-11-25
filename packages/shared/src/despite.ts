import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { log } from "./log.ts";
import { isDirectoryCardRow, openCheckTruncated } from "./personal-open.ts";
import { titleRuleRe } from "./record-text.ts";
import { CHAIN_TREE, chainTreeSql } from "./version-chain.ts";

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
interface SettingsLike { get<T>(path: string, fallback: T): T }

export const ACCEPTABLE_RULES = ["phone", "email_near_name", "inn", "passport", "snils", "card", "amount", "contract_number",
  "bank_account", "national_id", "phone_intl", "date_of_birth"] as const;
export const SOLO_ONLY_RULES = ["passport", "snils", "card", "bank_account", "national_id"] as const;
const ACCEPTABLE: ReadonlySet<string> = new Set(ACCEPTABLE_RULES);
const SOLO_ONLY: ReadonlySet<string> = new Set(SOLO_ONLY_RULES);

export type DespiteScope = "solo" | "shared";

export function despiteVerdict(rule: string, scope: DespiteScope): "ok" | "never" {
  if (!ACCEPTABLE.has(rule)) return "never";
  return scope === "shared" && SOLO_ONLY.has(rule) ? "never" : "ok";
}

export const SWEEP_PASSES = ACCEPTABLE_RULES.length + 1;

export async function sweepRules<F extends { rule: string }, U>(first: readonly F[], scope: DespiteScope,
    pass: (accepted: string[]) => Promise<{ findings: readonly F[]; unchecked: U | null }>): Promise<{ never: F[]; more: F[]; unchecked: U | null; complete: boolean }> {
  const found = new Set(first.map((f) => f.rule)), more: F[] = [];
  const never = (fs: readonly F[]) => fs.filter((f) => despiteVerdict(f.rule, scope) === "never");
  let bad = never(first), last: readonly F[] = first;
  for (let passes = 1; !bad.length && openCheckTruncated(last); passes++) {
    if (passes >= SWEEP_PASSES) return { never: [], more, unchecked: null, complete: false };
    const out = await pass([...found].sort());
    if (out.unchecked !== null) return { never: [], more, unchecked: out.unchecked, complete: false };
    const before = found.size;
    for (const f of out.findings) { found.add(f.rule); more.push(f); }
    bad = never(out.findings);
    if (!bad.length && openCheckTruncated(out.findings) && found.size === before) return { never: [], more, unchecked: null, complete: false };
    last = out.findings;
  }
  return { never: bad, more, unchecked: null, complete: true };
}

export function sampleEveryRule<F extends { rule: string }>(first: readonly F[], more: readonly F[], max: number): F[] {
  const have = new Set(first.map((f) => f.rule)), extra: F[] = [];
  for (const f of more) if (!have.has(f.rule)) { have.add(f.rule); extra.push(f); }
  if (!extra.length) return first.slice(0, max);
  return [...first.slice(0, Math.max(0, max - extra.length)), ...extra].slice(0, max);
}

export interface DespiteSettings { enabled: boolean; projects: boolean; scansText: boolean }
const DESPITE_KEYS: Record<keyof DespiteSettings, string> = {
  enabled: "open_check.despite_enabled", projects: "open_check.despite_projects", scansText: "open_check.despite_scans_text",
};

export function despiteSettings(s: SettingsLike): DespiteSettings {
  const read = (k: keyof DespiteSettings): boolean => {
    const v = s.get<unknown>(DESPITE_KEYS[k], true);
    if (typeof v === "boolean") return v;
    log.warn("despite_setting_invalid", { key: DESPITE_KEYS[k] });
    return false;
  };
  return { enabled: read("enabled"), projects: read("projects"), scansText: read("scansText") };
}

export const SHOWN_SHARED_SQL = "m.status = 'done' AND m.to_class = 'open' AND m.confirmation = 'human_workplace' AND m.accepted_scope = 'shared'";
export const SHOWING_SHARED_SQL = "m.status IN ('pending','copying','verifying') AND m.to_class = 'open' AND m.confirmation = 'human_workplace' AND m.accepted_scope = 'shared'";

export async function lastMoveShownShared(q: Queryable, ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return false;
  const { rows } = await q.query(
    `SELECT (${SHOWN_SHARED_SQL}) AS shown FROM (SELECT m0.* FROM class_moves m0 WHERE m0.record_id = ANY($1::uuid[]) AND m0.status <> 'failed'
       ORDER BY m0.requested_at DESC, m0.id DESC LIMIT 1) m`, [[...ids]]);
  return rows[0]?.shown === true;
}

export const CONSENT_TREE_SQL = `${CHAIN_TREE} SELECT r.id, r.parent_id, r.type, r.deleted_at IS NOT NULL AS deleted, r.space_id, r.owner_id, r.audience,
    r.title, encode(sha256(convert_to(c.text, 'UTF8')), 'hex') AS text_sha, r.summary_line, r.source_ref, r.attrs->>'filename' AS filename, r.attrs->'participants_unresolved' AS unresolved,
    encode(r.source_hash, 'hex') AS source_hash, r.attrs->'conversion'->>'status' AS conversion, r.attrs->'conversion'->>'extraction_state' AS extraction,
    r.source_kind, r.domain_tags
  FROM records r LEFT JOIN record_content c ON c.record_id = r.id WHERE r.id IN (SELECT id FROM tree) ORDER BY r.id`;
export const AUDIENCE_TREE_SQL = `${CHAIN_TREE} SELECT r.id, r.space_id, r.owner_id, r.audience FROM records r WHERE r.id IN (SELECT id FROM tree) ORDER BY r.id`;
export const CONSENT_PLACEMENTS_SQL = `${CHAIN_TREE} SELECT record_id, space_id FROM record_placements WHERE record_id IN (SELECT id FROM tree) ORDER BY record_id, space_id`;
export const CONSENT_PEOPLE_SQL = `${CHAIN_TREE} SELECT record_id, person_id FROM record_people WHERE record_id IN (SELECT id FROM tree) ORDER BY record_id, person_id`;
export const CONSENT_ENTITIES_SQL = `${CHAIN_TREE} SELECT DISTINCT entity_id FROM record_entities WHERE record_id IN (SELECT id FROM tree)`;

export interface ConsentRow {
  id: string; parent_id: string | null; type: string; deleted: boolean; space_id: string; owner_id: string; audience: string;
  title: string | null; text_sha: string | null; summary_line: string | null; source_ref: string | null; filename: string | null; unresolved: unknown;
  source_hash: string | null; conversion: string | null; extraction: string | null; source_kind: string; domain_tags: string[] | null;
}
export type AudienceRow = Pick<ConsentRow, "id" | "space_id" | "owner_id" | "audience">;
export interface AudienceRows {
  rows: AudienceRow[];
  placements: Array<{ record_id: string; space_id: string }>;
  people: Array<{ record_id: string; person_id: string }>;
}
export interface ConsentRows {
  rows: ConsentRow[];
  placements: Array<{ record_id: string; space_id: string }>;
  people: Array<{ record_id: string; person_id: string }>;
  entityNames: string[];
}

export async function consentRows(records: Queryable, control: Queryable, rootId: string): Promise<ConsentRows> {
  const rows = (await records.query(CONSENT_TREE_SQL, [rootId])).rows as ConsentRow[];
  const { placements, people } = await readersOf(records, rootId);
  const ents = (await records.query(CONSENT_ENTITIES_SQL, [rootId])).rows.map((r) => String(r.entity_id));
  const names = ents.length ? (await control.query("SELECT display_name FROM entities WHERE id = ANY($1::uuid[])", [ents])).rows.map((r) => r.display_name) : [];
  return { rows, placements, people, entityNames: uniqueSorted(names.filter((n): n is string => typeof n === "string")) };
}

const readersOf = async (records: Queryable, rootId: string): Promise<Pick<AudienceRows, "placements" | "people">> => ({
  placements: (await records.query(CONSENT_PLACEMENTS_SQL, [rootId])).rows.map((r) => ({ record_id: String(r.record_id), space_id: String(r.space_id) })),
  people: (await records.query(CONSENT_PEOPLE_SQL, [rootId])).rows.map((r) => ({ record_id: String(r.record_id), person_id: String(r.person_id) })),
});

export async function audienceRows(records: Queryable, rootId: string): Promise<AudienceRows> {
  const rows = (await records.query(AUDIENCE_TREE_SQL, [rootId])).rows.map((r): AudienceRow => ({ id: String(r.id), space_id: String(r.space_id), owner_id: String(r.owner_id), audience: String(r.audience) }));
  return { rows, ...(await readersOf(records, rootId)) };
}

export function consentScope(c: AudienceRows, root: { spaceId: string; spaceKind: string | null; spaceOwner: string | null }, author: string): DespiteScope {
  const solo = root.spaceKind === "personal" && root.spaceOwner === author
    && c.rows.every((r) => r.space_id === root.spaceId && r.audience === "space")
    && c.placements.every((p) => p.space_id === root.spaceId)
    && c.people.every((p) => p.person_id === author);
  return solo ? "solo" : "shared";
}

export interface DespiteKeys { print: Buffer; token: Buffer }
export function despiteKeys(appSecret: string): DespiteKeys {
  return {
    print: Buffer.from(hkdfSync("sha256", appSecret, "", "memory-despite-print", 32)),
    token: Buffer.from(hkdfSync("sha256", appSecret, "", "memory-despite-token", 32)),
  };
}

export const DESPITE_KEYS_FILE = "despite-keys";

export function parseDespiteKeys(raw: Buffer | string): DespiteKeys {
  let doc: unknown;
  try { doc = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw); } catch { doc = null; }
  const d = doc as { print?: unknown; token?: unknown } | null;
  const key = (v: unknown): Buffer | null => (typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v) ? Buffer.from(v, "base64") : null);
  const print = key(d?.print), token = key(d?.token);
  if (!print || !token || print.length !== 32 || token.length !== 32) throw new Error(`credentials: ${DESPITE_KEYS_FILE} must contain JSON {print, token}, each 32 bytes in base64`);
  return { print, token };
}

export function formatDespiteKeys(k: DespiteKeys): string {
  return JSON.stringify({ print: k.print.toString("base64"), token: k.token.toString("base64") }) + "\n";
}

export function despiteKeysFrom(o: { credential?: Buffer | null; appSecret?: string | null }): DespiteKeys | null {
  if (o.credential) return parseDespiteKeys(o.credential);
  return o.appSecret ? despiteKeys(o.appSecret) : null;
}

const uniqueSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const byId = <T extends { id: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const byPair = (a: [string, string], b: [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const hmac = (key: Buffer, value: unknown): string => createHmac("sha256", key).update(JSON.stringify(value)).digest("base64url");
const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export function contentPrint(key: Buffer, c: { rows: readonly ConsentRow[]; entityNames: readonly string[]; textOnly: boolean }): string {
  const rows = byId(c.rows).map((r) => [r.id, n(r.parent_id), r.type, r.deleted === true,
    createHash("sha256").update(JSON.stringify([n(r.title), n(r.text_sha), n(r.summary_line), n(r.source_ref), n(r.filename), n(r.unresolved), n(r.source_hash), n(r.conversion), n(r.extraction)])).digest("hex")]);
  return hmac(key, ["c1", c.textOnly === true, rows, uniqueSorted(c.entityNames)]);
}

export function audiencePrint(key: Buffer, c: AudienceRows): string {
  const rows = byId(c.rows).map((r) => [r.id, r.space_id, r.owner_id, r.audience]);
  const placements = c.placements.map((p): [string, string] => [p.record_id, p.space_id]).sort(byPair);
  const people = c.people.map((p): [string, string] => [p.record_id, p.person_id]).sort(byPair);
  return hmac(key, ["a1", rows, placements, people]);
}

export const CONSENT_TTL_SEC = 900;
export const CONSENT_MAX_LEN = 4096;

export interface ConsentPayload {
  v: 1; rid: string; pid: string; kid: string; sid: string; aud: string; print: string; rules: string[]; text_only: boolean; scope: DespiteScope; lm: string | null; exp: number;
}

export function consentPayload(p: Omit<ConsentPayload, "v" | "exp" | "rules"> & { rules: readonly string[] }, now = Date.now()): ConsentPayload {
  return { v: 1, rid: p.rid, pid: p.pid, kid: p.kid, sid: p.sid, aud: p.aud, print: p.print, rules: uniqueSorted(p.rules), text_only: p.text_only === true,
           scope: p.scope, lm: p.lm ?? null, exp: Math.floor(now / 1000) + CONSENT_TTL_SEC };
}

export function signConsent(key: Buffer, payload: ConsentPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

export function verifyConsent(key: Buffer, token: unknown, now = Date.now(), expect?: { rid: string; pid: string; kid: string }): { payload: ConsentPayload } | { error: "invalid" | "expired" } {
  if (typeof token !== "string" || !token.length || token.length > CONSENT_MAX_LEN) return { error: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { error: "invalid" };
  const want = createHmac("sha256", key).update(parts[0]).digest();
  const got = Buffer.from(parts[1], "base64url");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: "invalid" };
  let p: Record<string, unknown>;
  try { p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return { error: "invalid" }; }
  if (!p || typeof p !== "object" || Array.isArray(p) || p.v !== 1) return { error: "invalid" };
  if (![p.rid, p.pid, p.kid, p.sid, p.aud, p.print].every(isStr)) return { error: "invalid" };
  if (!Array.isArray(p.rules) || p.rules.length > 64 || !p.rules.every(isStr)) return { error: "invalid" };
  if (typeof p.text_only !== "boolean" || (p.scope !== "solo" && p.scope !== "shared") || !(p.lm === null || isStr(p.lm))) return { error: "invalid" };
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return { error: "invalid" };
  if (expect && (p.rid !== expect.rid || p.pid !== expect.pid || p.kid !== expect.kid)) return { error: "invalid" };
  if (p.exp * 1000 < now) return { error: "expired" };
  return { payload: p as unknown as ConsentPayload };
}

export const MEETING_ORIGIN_LIMITS: Readonly<{ depth: number; nodes: number }> = { depth: 16, nodes: 2000 };

export interface MeetingOriginDb { tree: Queryable; control: Queryable; records: (cls: "open" | "closed") => Queryable }

export const MEETING_KNOWN_SQL = (r: string): string => `(COALESCE(${r}.attrs #>> '{widened_by_human,via}', '') = 'handover'
    OR COALESCE(${r}.attrs ->> 'meeting_origin', '') = 'true'
    OR COALESCE(${r}.attrs #>> '{detached_from,type}', '') = 'transcript'
    OR COALESCE(${r}.attrs #>> '{detached_from,reason}', '') IN ('organizer_transfer', 'organizer_return'))`;

export const DERIVED_LOST_CLASS_CHANGE = "class_change";

export const LINEAGE_LOST_SQL = (r: string): string => `((COALESCE(${r}.attrs ->> 'derived_lost', '') = 'true'
      AND COALESCE(${r}.attrs ->> 'derived_lost_cause', '') <> '${DERIVED_LOST_CLASS_CHANGE}')
    OR (jsonb_typeof(${r}.attrs -> 'derived_pending') = 'array' AND jsonb_array_length(${r}.attrs -> 'derived_pending') > 0))`;

export const MEETING_MARK_SQL = (r: string): string => `(${MEETING_KNOWN_SQL(r)} OR ${LINEAGE_LOST_SQL(r)})`;

const MEETING_SOURCES_SQL = `${chainTreeSql("ANY($1::uuid[])")}, up AS (
    SELECT id, parent_id FROM chain UNION SELECT r.id, r.parent_id FROM records r JOIN up u ON r.id = u.parent_id)
  SELECT r.id, (r.type = 'transcript' OR ${MEETING_MARK_SQL("r")}) AS meeting
    FROM records r WHERE r.id IN (SELECT id FROM up)`;

export async function meetingOrigin(db: MeetingOriginDb, rows: ReadonlyArray<{ id: string; type: string }>, rootId: string,
                                    limits: Readonly<{ depth: number; nodes: number }> = MEETING_ORIGIN_LIMITS): Promise<boolean> {
  if (rows.some((r) => r.type === "transcript")) return true;
  const front = [...new Set([rootId, ...rows.map((r) => r.id)])];
  if ((await db.tree.query(`SELECT 1 FROM records r WHERE r.id = ANY($1::uuid[]) AND ${MEETING_MARK_SQL("r")} LIMIT 1`, [front])).rows.length) return true;
  return followSources(db, front, new Set(front), limits);
}

export async function meetingOriginOfSources(db: Pick<MeetingOriginDb, "control" | "records">, ids: readonly string[],
                                             limits: Readonly<{ depth: number; nodes: number }> = MEETING_ORIGIN_LIMITS): Promise<boolean> {
  const fresh = [...new Set(ids)];
  if (!fresh.length) return false;
  const seen = new Set(fresh);
  const front = await expandSources(db, fresh, seen);
  if (front === true || seen.size > limits.nodes) return true;
  return followSources(db, front, seen, limits);
}

async function expandSources(db: Pick<MeetingOriginDb, "records">, fresh: readonly string[], seen: Set<string>): Promise<string[] | true> {
  const next = [...fresh];
  let missing: readonly string[] = fresh;
  for (let pass = 0; pass < 2 && missing.length; pass++) {
    const found = new Set<string>();
    for (const cls of ["open", "closed"] as const)
      for (const r of (await db.records(cls).query(MEETING_SOURCES_SQL, [missing])).rows as Array<{ id: string; meeting: boolean }>) {
        if (r.meeting === true) return true;
        const id = String(r.id);
        found.add(id);
        if (!seen.has(id)) { seen.add(id); next.push(id); }
      }
    missing = missing.filter((id) => !found.has(id));
  }
  return missing.length ? true : next;
}

async function followSources(db: Pick<MeetingOriginDb, "control" | "records">, start: string[], seen: Set<string>,
                             limits: Readonly<{ depth: number; nodes: number }>): Promise<boolean> {
  let front = start;
  for (let step = 0; front.length; step++) {
    const links = (await db.control.query(
      `SELECT DISTINCT l.dst_id, d.type FROM record_links l JOIN record_locations d ON d.record_id = l.dst_id
        WHERE l.src_id = ANY($1::uuid[]) AND l.relation = 'derived_from' AND l.status IN ('confirmed', 'active')`, [front])).rows as Array<{ dst_id: string; type: string }>;
    if (links.some((l) => l.type === "transcript")) return true;
    const fresh = [...new Set(links.map((l) => String(l.dst_id)))].filter((id) => !seen.has(id));
    if (!fresh.length) return false;
    if (step >= limits.depth) return true;
    for (const id of fresh) seen.add(id);
    const next = await expandSources(db, fresh, seen);
    if (next === true || seen.size > limits.nodes) return true;
    front = next;
  }
  return false;
}

export interface NeverOpenTreeRule { id?: string; kind: string; pattern: string; reason: string }

export function neverOpenFromTree(rules: readonly NeverOpenTreeRule[],
                                  recs: ReadonlyArray<{ type: string; title: string | null; domain_tags: readonly string[] | null; source_kind: string | null; source_ref: string | null }>,
                                  entityKinds: Iterable<string>, spaceSlug: string | null = null): string | null {
  const kinds = new Set(entityKinds);
  for (const rule of rules) {
    if (rule.kind === "space" && spaceSlug !== null && rule.pattern === spaceSlug) return rule.reason;
    for (const r of recs) {
      if (rule.kind === "domain_tag" && (r.domain_tags ?? []).includes(rule.pattern)) return rule.reason;
      if (rule.kind === "pattern" && r.title) {
        let re: RegExp;
        try { re = titleRuleRe(rule.pattern); }
        catch (e) {
          log.warn("never_open_rule_invalid", { rule_id: rule.id ?? null, error: String((e as Error)?.message ?? e).slice(0, 160) });
          return `${rule.reason} (invalid rule pattern, so the record is closed as a precaution)`;
        }
        if (re.test(r.title)) return rule.reason;
      }
      if (rule.kind === "entity_kind" && rule.pattern === "person" && isDirectoryCardRow(r)) return rule.reason;
      if (rule.kind === "entity_kind" && rule.pattern !== "person" && kinds.has(rule.pattern)) return rule.reason;
    }
  }
  return null;
}

export type AuthorRole = "owner" | "member" | "reader";
export interface AuthorRoleOf { role: AuthorRole | null; kind: string | null; archived: boolean }
const RANK: Record<AuthorRole, number> = { reader: 1, member: 2, owner: 3 };

export async function authorRole(control: Queryable, o: { instanceId: string; personId: string; spaceId: string }): Promise<AuthorRoleOf> {
  const r = (await control.query(
    `SELECT s.kind, s.owner_id, s.org_unit_id, s.archived_at IS NOT NULL AS archived, m.role AS m_role, me.active, me.demo
       FROM spaces s
       LEFT JOIN space_members_effective m ON m.space_id = s.id AND m.person_id = $1 AND s.kind <> 'personal'
       CROSS JOIN (SELECT active, COALESCE(attrs->>'demo','') = 'true' AS demo FROM people WHERE id = $1) me
      WHERE s.id = $3 AND s.instance_id = $2`, [o.personId, o.instanceId, o.spaceId])).rows[0];
  if (!r) return { role: null, kind: null, archived: false };
  const archived = r.archived === true;
  const visible = (!archived || r.kind === "team" || r.kind === "project")
    && ((r.kind === "personal" && r.owner_id === o.personId) || (r.kind === "org" && r.active === true && r.demo !== true) || !!r.m_role);
  if (!visible) return { role: null, kind: r.kind, archived };
  let role: AuthorRole = r.kind === "personal" ? "owner" : r.m_role ? (r.m_role as AuthorRole) : "reader";
  if (r.owner_id !== null && r.owner_id === o.personId && r.org_unit_id === null && RANK[role] < RANK.owner) role = "owner";
  return { role, kind: r.kind, archived };
}

export const canWriteRole = (r: AuthorRoleOf): boolean => !r.archived && (r.role === "owner" || r.role === "member");
