// Link visibility only through the visibility builder, by id. External rights to create or decide come later.
import { binder, detailsFor, insertLink, invalid, LINK_METHODS, LINK_RELATIONS, linkRowsFor, MemoryError, notFound, SCOPE_SYSTEM,
  visibleSql, type DataClass, type LinkActor, type LinkDetails, type LinkRelation, type LinkRow, type LinkStatus } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { visibilityFor } from "./access.ts";
import { audit, auditRead } from "./audit.ts";
import { guardOpen } from "./open-check.ts";
import { requireHuman } from "./workplace.ts";
import { isUuidParam } from "./paging.ts";
import { rejectUnknownFields } from "./key-kind.ts";

export const linksTestHookOn = (app: Pick<App, "settings">): boolean => app.settings.get<unknown>("processing.links_test_hook", false) === true;
export interface VisibleLink extends Pick<LinkRow, "id" | "src_id" | "dst_id" | "relation" | "status" | "method" | "confidence"> {
  created_at: string; decided_at: string | null; details: LinkDetails | null;
}
/** The check also holds for future direct callers, regardless of the HTTP requireOp. */
export function requireLinksRead(caller: Caller): void {
  if (caller.principalType === "system" || (caller.allowedOps && !caller.allowedOps.has("read")) ||
      (caller.principalType === "service" && caller.onBehalfOf && !caller.service?.obo_read))
    throw new MemoryError("forbidden", "This key does not allow the read operation");
}
export function linkStatuses(raw?: string): LinkStatus[] {
  const statuses = raw === undefined ? ["active", "confirmed"] : [...new Set(raw.split(",").map(v => v.trim()).filter(Boolean))];
  const allowed = ["active", "confirmed", "proposed"];
  if (!statuses.length || statuses.some(s => !allowed.includes(s))) throw invalid(`status: ${allowed.join(" | ")}`);
  return statuses as LinkStatus[];
}

/** The strict log is inside the function: no future caller can hand out closed details without an audit. */
export async function linksVisibleTo(app: App, caller: Caller, recordIds: string[], o: {
  statuses?: readonly LinkStatus[]; relations?: readonly LinkRelation[]; currentOnly?: boolean; withDetails?: boolean;
} = {}): Promise<{ links: VisibleLink[]; auditIds: string[] }> {
  requireLinksRead(caller);
  const { spec } = await visibilityFor(app, caller, { byId: true });
  const visible = new Map<string, { id: string; owner_id: string; class: DataClass }>();
  const kept: LinkRow[] = [];
  const batchSize = 500;
  let afterId: string | undefined;
  for (;;) {
    const batch = await linkRowsFor(app.db.control, recordIds, { statuses: o.statuses ?? ["active", "confirmed"], relations: o.relations, limit: batchSize, afterId });
    const rows = batch.filter(r => r.status !== "proposed" || r.created_by === caller.person?.id);
    const pageVisible = new Map<string, { id: string; owner_id: string; class: DataClass }>();
    for (const cls of ["open", "closed"] as const) {
      const args: unknown[] = [], bind = binder(args), visibility = visibleSql(spec, cls, bind);
      if (visibility === null) continue;                       // even the pool of an unreachable class is not queried
      const ids = [...new Set(rows.flatMap(r => [r.src_class === cls ? r.src_id : null, r.dst_class === cls ? r.dst_id : null]).filter((id): id is string => !!id))];
      if (!ids.length) continue;
      const found = (await app.db.records(cls, caller.scope).query<{ id: string; owner_id: string; class: DataClass }>(
        `SELECT r.id, r.owner_id, r.class FROM records r WHERE r.id = ANY(${bind(ids)}::uuid[])
           AND r.deleted_at IS NULL AND r.hidden_at IS NULL ${o.currentOnly ? "AND r.is_current" : ""} AND ${visibility}`, args)).rows;
      for (const r of found) pageVisible.set(r.id, r);
    }
    for (const r of rows) if (pageVisible.get(r.src_id)?.class === r.src_class && pageVisible.get(r.dst_id)?.class === r.dst_class) {
      kept.push(r);
      visible.set(r.src_id, pageVisible.get(r.src_id)!); visible.set(r.dst_id, pageVisible.get(r.dst_id)!);
    }
    // Neither foreign proposals nor hidden ends cause an overflow or report the number of invisible links.
    if (kept.length > 2000) throw invalid("Too many visible links for one request", { field: "record_ids", reason: "limit" });
    if (batch.length < batchSize) break;
    afterId = batch.at(-1)!.id;
  }
  const details = new Map<string, LinkDetails>();
  if (o.withDetails !== false) for (const cls of ["open", "closed"] as const) {
    const gate = spec.gate[cls];
    if (gate === "none") continue;
    const allowed = kept.filter(r => r.detail_class === cls && (gate === "all" ||
      [r.src_id, r.dst_id].some(id => visible.get(id)?.class === cls && visible.get(id)?.owner_id === caller.person?.id)));
    if (!allowed.length) continue;
    for (const [id, detail] of await detailsFor(app.db.records(cls, caller.scope), allowed.map(r => r.id))) {
      const row = allowed.find(r => r.id === id)!;
      // The own gate passes no foreign human rationale to T2; quotes only of already visible own closed ends.
      details.set(id, gate === "own" && row.created_by !== caller.person?.id && row.method !== "extracted_by_model" ? { ...detail, rationale: null } : detail);
    }
  }
  const links: VisibleLink[] = kept.map(r => ({ id: r.id, src_id: r.src_id, dst_id: r.dst_id, relation: r.relation, status: r.status, method: r.method,
    confidence: r.confidence, created_at: new Date(r.created_at).toISOString(), decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    details: details.get(r.id) ?? null }));
  const auditIds = [...new Set(kept.flatMap(r => r.src_class === "closed" || r.dst_class === "closed" || (r.detail_class === "closed" && details.has(r.id)) ? [r.src_id, r.dst_id] : []))];
  const closed = auditIds.length > 0;
  await auditRead(app, caller, {
    event_type: caller.keyKind === "extended" && closed ? "extended_key_use" : "read", // vis-ok: audit by key kind; visibility comes from the builder
    class: closed ? "closed" : "open", record_ids: [...new Set(kept.flatMap(r => [r.src_id, r.dst_id]))],
    details: { op: "links", links: links.length, with_details: details.size },
  });
  return { links, auditIds };
}

/** Only an active test person of one's own instance, without AD and not a demo: the refusal does not tell the reasons apart. */
async function testPerson(app: App, where: "id" | "login", value: string): Promise<string> {
  const p = (await app.db.control.query(
    `SELECT p.id, p.active, p.attrs, EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active) AS ad
     FROM people p WHERE p.${where} = $1 AND p.instance_id = $2`, [value, app.instanceId])).rows[0];
  if (!p || !p.active || p.attrs?.test !== true || p.attrs?.demo === true || p.ad) throw notFound();
  return p.id;
}

/** The administrator does not read content: this isolated path works only on test people's data. */
export async function createLinkTestHook(app: App, caller: Caller, raw: unknown) {
  if (!linksTestHookOn(app)) throw new MemoryError("forbidden", "The processing.links_test_hook test hook is off. Links cannot be created through this path");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("Expected a link object");
  const b = raw as Record<string, unknown>;
  rejectUnknownFields(b, ["src_id", "dst_id", "relation", "status", "method", "confidence", "src_quote", "dst_quote", "rationale", "decided_by_login"]);
  if (typeof b.src_id !== "string" || typeof b.dst_id !== "string" || !isUuidParam(b.src_id) || !isUuidParam(b.dst_id)) throw notFound();
  const srcId = b.src_id as string, dstId = b.dst_id as string;
  // The limit precedes reading the text and checking quotes: quote_not_found must not become an oracle of real records.
  const locs = (await app.db.control.query<{ record_id: string; owner_id: string }>(
    `SELECT l.record_id, l.owner_id FROM record_locations l JOIN spaces s ON s.id = l.space_id
     WHERE l.record_id = ANY($1::uuid[]) AND s.instance_id = $2`, [[srcId, dstId], app.instanceId])).rows;
  if (!locs.some(r => r.record_id === srcId) || !locs.some(r => r.record_id === dstId)) throw notFound();
  for (const loc of locs) await testPerson(app, "id", loc.owner_id);
  let decided: string | null = null;
  if (b.decided_by_login !== undefined) {
    if (typeof b.decided_by_login !== "string" || !b.decided_by_login.trim()) throw notFound();
    decided = await testPerson(app, "login", b.decided_by_login.trim().toLowerCase());
  }
  if (!(LINK_METHODS as readonly unknown[]).includes(b.method)) throw invalid("method: unknown link method", { field: "method", reason: "method" });
  if (!(LINK_RELATIONS as readonly unknown[]).includes(b.relation)) throw invalid("relation: unknown link type", { field: "relation", reason: "relation" });
  if (!["proposed", "active", "confirmed"].includes(String(b.status)) || (b.status === "confirmed" && !decided))
    throw invalid("status: confirmed requires decided_by_login for a test account", { field: "status", reason: "status" });
  if (b.status === "confirmed" && b.method !== "stated_by_human") throw invalid("status: confirmed can only be set by a person", { field: "status", reason: "status" });
  const person = decided ?? locs.find(r => r.record_id === srcId)!.owner_id;
  const actor: LinkActor = b.method === "extracted_by_model" ? { kind: "system" } : { kind: b.method === "stated_by_human" ? "human" : "agent", personId: person };
  if (actor.kind === "human") {
    // The only test exception: only an already checked test-person, not a real person on behalf of the administrator.
    await requireHuman(app, { ...caller, keyKind: "session", principalType: "person", person: { id: person } as Caller["person"], onBehalfOf: false, preview: false }, "Confirm a link");
  }
  const out = await insertLink({ control: app.db.control, records: cls => app.db.records(cls, SCOPE_SYSTEM), actor,
    quoteThreshold: app.settings.get("processing.events", { fuzzy_threshold: 0.9 }).fuzzy_threshold, mayApply: () => true,
    openCheck: async texts => { await guardOpen(app, caller, { via: "link", texts }); return "pass"; },
  }, { srcId, dstId, relation: b.relation as LinkRelation, status: b.status as "proposed" | "active" | "confirmed",
    confidence: b.confidence as number | undefined, processor: actor.kind === "system" ? { job: "links_test_hook" } : null,
    srcQuote: b.src_quote as string | undefined, dstQuote: b.dst_quote as string | undefined, rationale: b.rationale as string | undefined });
  await audit(app, caller, { event_type: "admin", record_ids: [srcId, dstId], details: { op: "link_test_create", link_id: out.id, relation: b.relation, status: out.status,
    method: b.method, detail_class: out.detailClass, created: out.created } });
  return { id: out.id, detail_class: out.detailClass, created: out.created, status: out.status };
}

/** A white box without quotes and without graph edges. */
export async function linkCopies(app: App, id: string) {
  if (!linksTestHookOn(app)) throw notFound();
  const row = (await app.db.control.query(
    `SELECT l.status, l.method, l.src_class, l.dst_class, l.detail_class, l.src_key, l.dst_key,
            sa.instance_id AS src_instance, sb.instance_id AS dst_instance, a.owner_id AS src_owner, b.owner_id AS dst_owner FROM record_links l
     LEFT JOIN record_locations a ON a.record_id = l.src_id LEFT JOIN spaces sa ON sa.id = a.space_id
     LEFT JOIN record_locations b ON b.record_id = l.dst_id LEFT JOIN spaces sb ON sb.id = b.space_id
     WHERE l.id = $1`, [id])).rows[0];
  if (row && (row.src_instance !== app.instanceId || row.dst_instance !== app.instanceId)) throw notFound();
  if (row) { await testPerson(app, "id", row.src_owner); await testPerson(app, "id", row.dst_owner); }
  const link = row ? { status: row.status, method: row.method, src_class: row.src_class, dst_class: row.dst_class, detail_class: row.detail_class,
    src_key: row.src_key, dst_key: row.dst_key } : null;
  const details = { open: false, closed: false };
  for (const cls of ["open", "closed"] as const)
    details[cls] = !!(await app.db.records(cls, SCOPE_SYSTEM).query("SELECT 1 FROM record_link_details WHERE link_id = $1", [id])).rowCount;
  return { link, details };
}
