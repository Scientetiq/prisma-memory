import type pg from "pg";
import { type DataClass, tx } from "./db.ts";
import { inProgress, invalid, notFound, openCheckRefused } from "./errors.ts";
import { newId } from "./ids.ts";
import { log } from "./log.ts";
import type { OpenCheckText } from "./open-check.ts";
import { quoteInText } from "./pipeline-text/index.ts";

export const LINK_RELATIONS = ["same", "refines", "replaces", "contradicts", "resolves", "derived_from", "echo_of", "corrects"] as const;
export const EVENT_RELATIONS = ["same", "refines", "replaces", "contradicts", "resolves"] as const;
export const LINK_STATUSES = ["proposed", "active", "confirmed", "rejected", "orphaned"] as const;
export const LINK_METHODS = ["extracted_by_model", "stated_by_human", "inferred_by_agent"] as const;
export type LinkRelation = typeof LINK_RELATIONS[number];
export type LinkStatus = typeof LINK_STATUSES[number];
export type LinkMethod = typeof LINK_METHODS[number];
export type LinkActor = { kind: "human"; personId: string } | { kind: "agent"; personId: string } | { kind: "system" };
export const strictest = (a: DataClass, b: DataClass): DataClass => a === "closed" || b === "closed" ? "closed" : "open";
export const detailClassFor = (src: DataClass, dst: DataClass, prev: DataClass = "open"): DataClass => strictest(strictest(src, dst), prev);
export function transitionAllowed(from: LinkStatus, to: LinkStatus, actor: LinkActor): boolean {
  if (actor.kind === "human") return from !== to && (to === "confirmed" || to === "rejected");
  return actor.kind === "system" && (((from === "proposed" || from === "active") && to === "orphaned") || (from === "orphaned" && to === "active"));
}
export interface LinkRow {
  id: string; src_id: string; dst_id: string; src_class: DataClass; dst_class: DataClass; src_key: string | null; dst_key: string | null;
  relation: LinkRelation; status: LinkStatus; method: LinkMethod; confidence: number | null; detail_class: DataClass; processor: Record<string, unknown> | null;
  created_by: string | null; created_at: Date; updated_at: Date; decided_by: string | null; decided_at: Date | null;
}
export interface LinkDetails { src_quote: string | null; dst_quote: string | null; rationale: string | null }
export interface NewLink {
  srcId: string; dstId: string; relation: LinkRelation; status: "proposed" | "active" | "confirmed";
  confidence?: number | null; processor?: Record<string, unknown> | null; srcQuote?: string | null; dstQuote?: string | null; rationale?: string | null;
}
export interface LinkWriteDeps {
  control: pg.Pool; records: (cls: DataClass) => pg.Pool; actor: LinkActor; quoteThreshold: number;
  openCheck: (texts: OpenCheckText[]) => Promise<"pass" | "refuse" | "drop_rationale">;
  mayApply?: (link: NewLink) => boolean | Promise<boolean>;
}
interface End { id: string; class: DataClass; type: string; event_key: string | null; occurred_at: Date; text: string | null; parent_id: string | null }
interface Loc { record_id: string; class: DataClass; deleted: boolean }
const fail = (field: string, reason: string): never => { throw invalid(`The link was not added: ${field}`, { field, reason }); };
const isOneOf = (v: unknown, all: readonly string[]): boolean => typeof v === "string" && all.includes(v);

export async function insertLink(d: LinkWriteDeps, l: NewLink): Promise<{ id: string; detailClass: DataClass; created: boolean; status: LinkStatus }> {
  if (l.srcId === l.dstId) fail("src_id", "self");
  if (!isOneOf(l.relation, LINK_RELATIONS)) fail("relation", "relation");
  if (!isOneOf(l.status, ["proposed", "active", "confirmed"])) fail("status", "status");
  if (l.status === "confirmed" && d.actor.kind !== "human") fail("status", "status");
  if (l.status === "active" && (!d.mayApply || !(await d.mayApply(l)))) fail("status", "status");
  if (d.actor.kind !== "system" && (l.confidence != null || l.processor != null)) fail("method", "method");
  if (d.actor.kind === "system" && (!l.processor || typeof l.processor !== "object" || Array.isArray(l.processor))) fail("processor", "method");
  if (l.confidence != null && (!Number.isFinite(l.confidence) || l.confidence < 0 || l.confidence > 1)) fail("confidence", "confidence");
  for (const [field, value, max] of [["src_quote", l.srcQuote, 600], ["dst_quote", l.dstQuote, 600], ["rationale", l.rationale, 500]] as const)
    if (value != null && (typeof value !== "string" || !value.length || [...value].length > max)) fail(field, "length");
  const method: LinkMethod = d.actor.kind === "human" ? "stated_by_human" : d.actor.kind === "agent" ? "inferred_by_agent" : "extracted_by_model";
  const person = d.actor.kind === "system" ? null : d.actor.personId;
  const ids = [l.srcId, l.dstId].sort();
  let cleanup: { cls: DataClass; id: string } | null = null;
  try {
    return await tx(d.control, async q => {
      const initial = (await q.query<Loc>("SELECT record_id, class, deleted FROM record_locations WHERE record_id = ANY($1::uuid[])", [ids])).rows;
      if (initial.length !== 2 || initial.some(r => r.deleted)) throw notFound();
      const lockIds = new Set(ids);
      for (const loc of initial) {
        const ancestry = (await d.records(loc.class).query<{ id: string; parent_id: string | null }>(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM records WHERE id = $1
             UNION SELECT r.id, r.parent_id FROM records r JOIN ancestors a ON r.id = a.parent_id
           ) SELECT id, parent_id FROM ancestors`, [loc.record_id])).rows;
        if (!ancestry.some(r => r.id === loc.record_id)) throw notFound();
        for (const a of ancestry) lockIds.add(a.id);
      }
      for (const id of [...lockIds].sort()) {
        const lock = (await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0];
        if (!lock?.ok) throw inProgress();
      }
      if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [[...lockIds]])).rowCount) throw inProgress();
      const locs = (await q.query<Loc>("SELECT record_id, class, deleted FROM record_locations WHERE record_id = ANY($1::uuid[]) ORDER BY record_id FOR SHARE", [ids])).rows;
      if (locs.length !== 2 || locs.some(r => r.deleted)) throw notFound();
      const ends = new Map<string, End>();
      for (const loc of locs) {
        const end = (await d.records(loc.class).query<End>(
          `SELECT r.id, r.class, r.type, r.event_key, r.occurred_at, r.parent_id, c.text FROM records r
           LEFT JOIN record_content c ON c.record_id = r.id WHERE r.id = $1 AND r.deleted_at IS NULL AND r.hidden_at IS NULL`, [loc.record_id])).rows[0];
        if (!end) throw notFound();
        if (end.parent_id && !lockIds.has(end.parent_id)) throw inProgress();
        ends.set(end.id, end);
      }
      const src = ends.get(l.srcId)!, dst = ends.get(l.dstId)!;
      const prev = (await q.query<LinkRow>("SELECT * FROM record_links WHERE src_id = $1 AND dst_id = $2 AND relation = $3", [l.srcId, l.dstId, l.relation])).rows[0];
      if (prev) return { id: prev.id, detailClass: prev.detail_class, created: false, status: prev.status };
      if ((EVENT_RELATIONS as readonly string[]).includes(l.relation) && new Date(src.occurred_at).getTime() < new Date(dst.occurred_at).getTime()) fail("src_id", "direction");
      for (const [field, value, end] of [["src_quote", l.srcQuote, src], ["dst_quote", l.dstQuote, dst]] as const) {
        if (!value) continue;
        const match = quoteInText(end.text ?? "", value, d.quoteThreshold);
        if (!match || (d.actor.kind !== "system" && match.kind !== "exact")) fail(field, "quote_not_found");
      }
      const detailClass = detailClassFor(src.class, dst.class);
      let rationale = l.rationale ?? null;
      if (detailClass === "open" && (l.srcQuote || l.dstQuote || rationale)) {
        const quotes: OpenCheckText[] = [l.srcQuote, l.dstQuote].filter((v): v is string => Boolean(v)).map(value => ({ field: "quote", value }));
        const texts = [...quotes, ...(rationale ? [{ field: "rationale", value: rationale }] : [])];
        let result = await d.openCheck(texts);
        if (result === "drop_rationale" && d.actor.kind === "system") { rationale = null; result = quotes.length ? await d.openCheck(quotes) : "pass"; }
        if (result !== "pass") throw openCheckRefused("The link was not added. The quote or rationale failed the open check",
          "Remove the flagged content from the rationale. The quote must match a passage from the record", { via: "link", findings: [] });
      }
      const id = newId();
      if (l.srcQuote || l.dstQuote || rationale) {
        await d.records(detailClass).query("INSERT INTO record_link_details (link_id, class, src_quote, dst_quote, rationale) VALUES ($1,$2,$3,$4,$5)",
          [id, detailClass, l.srcQuote ?? null, l.dstQuote ?? null, rationale]);
        cleanup = { cls: detailClass, id };
      }
      await q.query(
        `INSERT INTO record_links (id, src_id, dst_id, src_class, dst_class, src_key, dst_key, relation, status, method, confidence, detail_class, processor, created_by, decided_by, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, l.srcId, l.dstId, src.class, dst.class, src.type === "event" ? src.event_key : null, dst.type === "event" ? dst.event_key : null,
          l.relation, l.status, method, l.confidence ?? null, detailClass, l.processor ? JSON.stringify(l.processor) : null, person,
          l.status === "confirmed" ? person : null, l.status === "confirmed" ? new Date() : null]);
      return { id, detailClass, created: true, status: l.status };
    });
  } catch (e) {
    if (cleanup) {
      const saved = cleanup as { cls: DataClass; id: string };
      await d.records(saved.cls).query("DELETE FROM record_link_details WHERE link_id = $1", [saved.id])
        .catch(() => log.warn("link_details_cleanup_failed", { link_id: saved.id }));
    }
    throw e;
  }
}

export const LINK_RETRY_MS = [300, 900] as const;

export async function insertLinkRetrying(d: LinkWriteDeps, l: NewLink, o: {
  insert?: (d: LinkWriteDeps, l: NewLink) => Promise<{ id: string; detailClass: DataClass; created: boolean; status: LinkStatus }>;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<{ id: string; detailClass: DataClass; created: boolean; status: LinkStatus }> {
  const insert = o.insert ?? insertLink, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(d, l);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "in_progress" || attempt >= LINK_RETRY_MS.length) throw e;
      await sleep(LINK_RETRY_MS[attempt]!);
    }
  }
}

export async function linkRowsFor(control: pg.Pool, recordIds: string[], o: { statuses?: readonly LinkStatus[]; relations?: readonly LinkRelation[]; limit?: number; afterId?: string } = {}): Promise<LinkRow[]> {
  if (!recordIds.length) return [];
  const limit = Math.max(1, Math.min(2000, o.limit ?? 500));
  return (await control.query<LinkRow>(
    `SELECT * FROM record_links WHERE (src_id = ANY($1::uuid[]) OR dst_id = ANY($1::uuid[]))
       AND ($2::text[] IS NULL OR status = ANY($2::text[])) AND ($3::text[] IS NULL OR relation = ANY($3::text[]))
       AND ($4::uuid IS NULL OR id > $4::uuid) ORDER BY id LIMIT $5`,
    [recordIds, o.statuses ?? null, o.relations ?? null, o.afterId ?? null, limit])).rows;
}
export async function detailsFor(pool: pg.Pool, linkIds: string[]): Promise<Map<string, LinkDetails>> {
  if (!linkIds.length) return new Map();
  const { rows } = await pool.query<LinkDetails & { link_id: string }>("SELECT link_id, src_quote, dst_quote, rationale FROM record_link_details WHERE link_id = ANY($1::uuid[])", [linkIds]);
  return new Map(rows.map(r => [r.link_id, { src_quote: r.src_quote, dst_quote: r.dst_quote, rationale: r.rationale }]));
}
export async function setLinkStatus(control: pg.Pool, id: string, to: LinkStatus, actor: LinkActor, expect: readonly LinkStatus[]): Promise<LinkRow | null> {
  return tx(control, q => setLinkStatusOn(q, id, to, actor, expect));
}

export async function setLinkStatusOn(q: Pick<pg.PoolClient, "query">, id: string, to: LinkStatus, actor: LinkActor, expect: readonly LinkStatus[]): Promise<LinkRow | null> {
  const row = (await q.query<LinkRow>("SELECT * FROM record_links WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!row || !expect.includes(row.status)) return null;
  if (!transitionAllowed(row.status, to, actor)) fail("status", "status");
  return (await q.query<LinkRow>(
    "UPDATE record_links SET status = $2, decided_by = $4, decided_at = $5, updated_at = now() WHERE id = $1 AND status = ANY($3::text[]) RETURNING *",
    [id, to, expect, actor.kind === "human" ? actor.personId : null, actor.kind === "human" ? new Date() : null])).rows[0] ?? null;
}
export async function linkByKeys(control: pg.Pool, srcKey: string, dstKey: string, relation: LinkRelation): Promise<LinkRow | null> {
  return (await control.query<LinkRow>("SELECT * FROM record_links WHERE src_key = $1 AND dst_key = $2 AND relation = $3 ORDER BY created_at DESC, id LIMIT 1", [srcKey, dstKey, relation])).rows[0] ?? null;
}
