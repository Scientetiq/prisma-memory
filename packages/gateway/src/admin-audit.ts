import { addDays, chainLinkSql, chainMemberSql, clientKindOf, invalid, zonedMidnight } from "@memory/shared";
import type { App } from "./context.ts";
import { parseEventTypes, WORKPLACE_AUTO_SQL, WORKPLACE_SERVICE_SQL } from "./audit.ts";
import { decodeAuditCursor, encodeKeyset, intParam, isUuidParam, keysetAtSql } from "./paging.ts";
import { weeksTz } from "./report-search-quality.ts";

export const AUDIT_OPS = ["login", "ldap_check", "oidc_check", "smtp_test", "settings_update"] as const;

export const LOGIN_THROTTLE_REASONS = ["ldap_login", "oidc_login"] as const;

export const SERVICE_ROW_SQL = `(${WORKPLACE_SERVICE_SQL} OR ${WORKPLACE_AUTO_SQL} OR coalesce(a.event_type = 'read' AND a.details->'tool' = '"memory_me"'::jsonb, false)
  OR (a.event_type = 'rate_limited' AND coalesce(a.details->>'reason', '') NOT IN (${LOGIN_THROTTLE_REASONS.map((r) => `'${r}'`).join(", ")})))`;

export const HIDDEN_COUNT_CAP = 10_000;
const RECORDS_PER_ROW = 5;
const AUDIT_WALK_MAX = 1000;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export function auditBound(raw: string | undefined, name: "from" | "to", tz: string): string | null {
  if (raw === undefined || raw === "") return null;
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const at = Date.parse(`${v}T00:00:00Z`);
    if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== v) throw invalid(`${name}: a YYYY-MM-DD date or ISO 8601 timestamp`);
    return new Date(zonedMidnight(name === "to" ? addDays(v, 1) : v, tz)).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw invalid(`${name}: a YYYY-MM-DD date or ISO 8601 timestamp`);
  return new Date(v).toISOString();
}

export interface AuditQuery {
  limit?: string; cursor?: string; event_type?: string; login?: string; key_id?: string; exclude_service?: string;
  q?: string; person_id?: string; from?: string; to?: string; space?: string; record_id?: string; op?: string; hide_service?: string;
}

export function parseAuditQuery(p: AuditQuery, tz: string) {
  const limit = intParam(p.limit, 50, 1, 200);
  const types = parseEventTypes(p.event_type);
  if (p.key_id && !isUuidParam(p.key_id)) throw invalid("key_id: key identifier (uuid)");
  const flag = (name: string, v: string | undefined): boolean => {
    if (v !== undefined && v !== "" && v !== "true" && v !== "false") throw invalid(`${name}: true or false`);
    return v === "true";
  };
  const excludeService = flag("exclude_service", p.exclude_service), hideService = flag("hide_service", p.hide_service);
  const q = p.q === undefined ? null : p.q.replace(/\s+/g, " ").trim();
  if (q !== null && q !== "" && (q.length < 2 || q.length > 100)) throw invalid("q: name or part of a login, 2 to 100 characters");
  if (p.person_id && !isUuidParam(p.person_id)) throw invalid("person_id: person identifier (uuid)");
  if (p.record_id && !isUuidParam(p.record_id)) throw invalid("record_id: record identifier (uuid)");
  if (p.op && !(AUDIT_OPS as readonly string[]).includes(p.op)) throw invalid(`op: ${AUDIT_OPS.join(" | ")}`);
  const space = p.space ? p.space.trim().toLowerCase() : null;
  if (space !== null && space !== "" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(space)) throw invalid("space: space address (slug)");
  const from = auditBound(p.from, "from", tz), to = auditBound(p.to, "to", tz);
  const toExclusive = Boolean(p.to && /^\d{4}-\d{2}-\d{2}$/.test(p.to.trim()));
  if (from && to && (toExclusive ? from >= to : from > to)) throw invalid("from is later than to. Check the dates");
  const cur = decodeAuditCursor(p.cursor);
  const key = cur?.id ? { at: cur.at, id: cur.id } : null;
  const before = cur && !cur.id ? cur.at : null;
  return { limit, types, login: p.login || null, keyId: p.key_id || null, excludeService, hideService, q: q || null, personId: p.person_id || null,
           recordId: p.record_id || null, op: p.op || null, space: space || null, from, to, toExclusive, key, before };
}

export type ParsedAuditQuery = ReturnType<typeof parseAuditQuery>;

async function describeRecords(app: App, ids: string[]) {
  const out = new Map<string, { id: string; type: string; class: "open" | "closed"; space: string | null; space_name: string | null; owner: string | null; owner_name: string | null;
                                created_at: string | null; deleted: boolean; title?: string | null }>();
  if (!ids.length) return out;
  const { rows } = await app.db.control.query(
    `SELECT l.record_id, l.class, l.type, l.created_at, l.deleted, s.slug, s.name AS space_name, s.kind AS space_kind, p.login, p.display_name
       FROM record_locations l LEFT JOIN spaces s ON s.id = l.space_id LEFT JOIN people p ON p.id = l.owner_id WHERE l.record_id = ANY($1::uuid[])`, [ids]);
  const showPersonal = app.settings.get<boolean>("admin.audit_show_personal_titles", false) === true;
  const personal = new Set(rows.filter((x) => x.space_kind === "personal").map((x) => x.record_id as string));
  for (const x of rows) out.set(x.record_id, { id: x.record_id, type: x.type, class: x.class, space: x.slug ?? null, space_name: x.space_name ?? null, owner: x.login ?? null,
                                               owner_name: x.display_name ?? null, created_at: x.created_at ? new Date(x.created_at).toISOString() : null, deleted: x.deleted === true });
  const open = [...out.values()].filter((r) => r.class === "open" && (showPersonal || !personal.has(r.id))).map((r) => r.id);
  if (open.length) {
    const openOnly = { classes: ["open"] as const, tier: "system" as const };
    // The trace of an open "despite findings" is written on the head of the move (worker); derived rows inherit it up the
    // parent_id line, older versions of a chain (agent note or document) from the newer one. One step: a derived row goes to
    // its parent, a root to its newer version when both are linked by the chain rule (chainLinkSql of shared/version-chain.ts);
    // the path is linear. A row at the step limit that still has a continuation (a parent, or a newer version of a chain — the
    // version itself is not checked: hiding too much is acceptable) means the walk is incomplete: the title is hidden.
    const t = await app.db.records("open", openOnly).query(
      `WITH RECURSIVE up AS (
         SELECT id AS start, parent_id, superseded_by_id, source_kind, attrs ? 'open_check_accepted' AS accepted, 0 AS depth FROM records WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT u.start, r.parent_id, r.superseded_by_id, r.source_kind, r.attrs ? 'open_check_accepted', u.depth + 1
           FROM up u JOIN records r ON r.id = coalesce(u.parent_id, u.superseded_by_id)
          WHERE u.depth < ${AUDIT_WALK_MAX} AND (u.parent_id IS NOT NULL OR ${chainLinkSql("u", "r")}))
       SELECT r.id, r.title,
              coalesce((SELECT bool_or(up.accepted OR (up.depth >= ${AUDIT_WALK_MAX} AND (up.parent_id IS NOT NULL OR (${chainMemberSql("up")} AND up.superseded_by_id IS NOT NULL))))
                          FROM up WHERE up.start = r.id), false) AS hidden
         FROM records r WHERE r.id = ANY($1::uuid[]) AND r.hidden_at IS NULL AND r.deleted_at IS NULL`, [open])
      .catch(() => ({ rows: [] as Array<{ id: string; title: string | null; hidden: boolean }> }));
    for (const x of t.rows) { const r = out.get(x.id); if (r) r.title = x.hidden === true ? null : x.title ?? null; }
  }
  return out;
}

export async function adminAuditPage(app: App, p: AuditQuery) {
  const o = parseAuditQuery(p, weeksTz(app));
  const ctl = app.db.control;
  const who: string[][] = [];
  if (o.login) who.push([(await ctl.query("SELECT id FROM people WHERE login = $1", [o.login.toLowerCase()])).rows[0]?.id ?? ZERO_UUID]);
  if (o.personId) who.push([o.personId]);
  let people: Array<{ id: string; login: string; display_name: string; active: boolean }> | undefined;
  if (o.q) {
    people = (await ctl.query(
      `SELECT id, login, display_name, active FROM people WHERE instance_id = $1 AND (login ILIKE $2 ESCAPE '\\' OR display_name ILIKE $2 ESCAPE '\\')
        ORDER BY active DESC, login LIMIT 50`, [app.instanceId, likePattern(o.q)])).rows;
    if (!people.length) return { items: [], next_cursor: null, people: [], ...(o.hideService ? { hidden_service: 0 } : {}) };
    who.push(people.map((x) => x.id));
  }
  const spaceId = o.space ? (await ctl.query("SELECT id FROM spaces WHERE slug = $1 AND instance_id = $2", [o.space, app.instanceId])).rows[0]?.id ?? ZERO_UUID : null;

  const args: unknown[] = [], where: string[] = [];
  const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
  where.push(`a.instance_id = ${bind(app.instanceId)}`);
  const types = o.op && !o.types ? ["admin"] : o.types;
  if (types) where.push(`a.event_type = ANY(${bind(types)}::text[])`);
  if (o.op) where.push(`a.details->>'op' = ${bind(o.op)}`);
  for (const ids of who) { const b = bind(ids); where.push(`(a.principal_id = ANY(${b}::uuid[]) OR a.on_behalf_of = ANY(${b}::uuid[]))`); }
  if (o.keyId) where.push(`a.key_id = ${bind(o.keyId)}`);
  if (spaceId) where.push(`a.space_id = ${bind(spaceId)}`);
  if (o.recordId) where.push(`a.record_ids @> ARRAY[${bind(o.recordId)}]::uuid[]`);   // GIN audit_events_record_ids_idx
  if (o.from) where.push(`a.at >= ${bind(o.from)}`);
  if (o.to) where.push(`a.at ${o.toExclusive ? "<" : "<="} ${bind(o.to)}`);
  if (o.excludeService) where.push(`NOT ${WORKPLACE_SERVICE_SQL}`);
  const base = [...where];
  if (o.hideService) where.push(`NOT ${SERVICE_ROW_SQL}`);
  const page: string[] = [];
  if (o.before) page.push(`a.at < ${bind(o.before)}`);
  if (o.key) { const at = bind(o.key.at); page.push(`(a.at <= ${at} AND (a.at, a.id) < (${at}, ${bind(o.key.id)}::uuid))`); }
  const cond = [...where, ...page];
  const { rows } = await app.db.auditRead().query(
    `SELECT a.id, a.at, ${keysetAtSql("a.at")} AS at_key, a.event_type, a.key_id, a.principal_type, a.principal_id, a.on_behalf_of, a.service_id, a.tier, a.class,
            a.record_ids, a.space_id, (a.query_text IS NOT NULL) AS has_query_text, a.result_count, a.details, a.client_label,
            (${WORKPLACE_AUTO_SQL}) AS auto, ${SERVICE_ROW_SQL} AS service
       FROM audit_events a ${cond.length ? `WHERE ${cond.join(" AND ")}` : ""}
      ORDER BY a.at DESC, a.id DESC LIMIT ${bind(o.limit + 1)}`, args);
  const shown = rows.slice(0, o.limit);

  let hidden: number | undefined;
  if (o.hideService) {
    const hArgs = args.slice(0, -1), hb = (v: unknown) => { hArgs.push(v); return `$${hArgs.length}`; };
    const span = [...base, SERVICE_ROW_SQL, ...page];
    const last = shown[shown.length - 1];
    if (rows.length > o.limit && last) span.push(`a.at >= ${hb(last.at_key)}`);
    hidden = Number((await app.db.auditRead().query(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM audit_events a WHERE ${span.join(" AND ")} LIMIT ${HIDDEN_COUNT_CAP + 1}) x`, hArgs)).rows[0]?.n ?? 0);
  }

  const ids = [...new Set(shown.flatMap((x) => [x.principal_id, x.on_behalf_of, x.service_id, x.space_id]).filter(Boolean))];
  const names = new Map<string, string>(), fullNames = new Map<string, string>();
  if (ids.length) {
    for (const n of (await ctl.query("SELECT id, login AS n, display_name AS full FROM people WHERE id = ANY($1) UNION ALL SELECT id, name, NULL FROM services WHERE id = ANY($1) UNION ALL SELECT id, slug, NULL FROM spaces WHERE id = ANY($1)", [ids])).rows) {
      names.set(n.id, n.n);
      if (n.full) fullNames.set(n.id, n.full);
    }
  }
  const recs = await describeRecords(app, [...new Set(shown.flatMap((x) => (x.record_ids ?? []).slice(0, RECORDS_PER_ROW)))]);
  const items = shown.map((x) => ({
    id: x.id, at: new Date(x.at).toISOString(), event_type: x.event_type, key_id: x.key_id ?? null,
    actor: names.get(x.service_id ?? x.principal_id) ?? x.principal_type ?? "—",
    on_behalf_of: x.on_behalf_of ? names.get(x.on_behalf_of) ?? null : null, tier: x.tier, class: x.class, space: x.space_id ? names.get(x.space_id) ?? null : null,
    record_ids: x.record_ids, result_count: x.result_count, has_query_text: x.has_query_text, client_label: x.client_label,
    client_kind: typeof x.details?.client?.name === "string" ? clientKindOf(x.details.client.name) : null,
    details: x.details,
    actor_id: x.principal_type === "person" ? x.principal_id ?? null : null,
    actor_name: x.principal_type === "person" && x.principal_id ? fullNames.get(x.principal_id) ?? null : null,
    on_behalf_of_id: x.on_behalf_of ?? null, on_behalf_of_name: x.on_behalf_of ? fullNames.get(x.on_behalf_of) ?? null : null,
    auto: x.auto === true, service: x.service === true,
    records: (x.record_ids ?? []).slice(0, RECORDS_PER_ROW).map((id: string) => recs.get(id) ?? { id, type: null, class: null, space: null, space_name: null, owner: null, owner_name: null, created_at: null, deleted: true }),
  }));
  const last = rows[o.limit - 1];
  return { items, next_cursor: rows.length > o.limit && last ? encodeKeyset(last.at_key, last.id) : null,
           ...(people ? { people } : {}), ...(hidden !== undefined ? { hidden_service: hidden } : {}) };
}
