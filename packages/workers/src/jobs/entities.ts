import { externalEntityKey } from "@memory/connectors";
import { ensureProjectEntity, entityId, log, openCheckSettings, parseEntityKey, personId, projectEntityReadable, runOpenCheck, tx, type EntityKey } from "@memory/shared";
import { auditWorker, recordsDb, type Ctx } from "../ctx.ts";
import type { StageJob } from "../stages.ts";
import { loadRecord } from "./common.ts";
import { registryIndex, type RegistryIndex } from "./entity-index.ts";
import type { LookupHit, LookupResult } from "./entity-lookup.ts";
import { linkMeetingChildren, matchPerson, normName, syncParticipants, TextNames, type ResolvedMention } from "./named.ts";

interface Mention { text: string; kind?: string }
export { matchPerson, normName };

/**
 * External lookup of a mention through the connectors of the instance (entity-lookup.ts); "none" when the
 * context has no lookup or nothing can look the kind up.
 */
async function resolveExternal(ctx: Ctx, kind: string, name: string): Promise<LookupResult> {
  if (!ctx.externalLookup) return { status: "none" };
  const o: { signal?: AbortSignal } = ctx.abort ? { signal: ctx.abort } : {};
  return ctx.externalLookup.resolve(kind, name, o);
}

/** The registry key of an external hit: `ext:` form (ids unchanged; entity-key.ts). */
function hitKey(kind: string, h: LookupHit): EntityKey | null {
  const k = externalEntityKey(h.system, kind, h.id);
  return k.ok ? (k.key as unknown as EntityKey) : null;
}

export async function linkEntities(ctx: Ctx, job: StageJob): Promise<"done" | "skipped"> {
  const loaded = await loadRecord(ctx, job.class, job.record_id);
  if (!loaded) return "skipped";
  const { rec, text } = loaded, db = recordsDb(ctx, job.class);
  const pm = (rec.attrs?.pipeline_mentions ?? {}) as Record<string, Mention[]>;
  const seen = new Set<string>(), mentions: Mention[] = [];
  for (const m of [...(pm.summary ?? []), ...(pm.events ?? []), ...(pm.describe ?? [])]) {
    const k = `${m.kind ?? "other"}:${normName(m.text ?? "")}`;
    if (!m.text || seen.has(k)) continue;
    seen.add(k); mentions.push(m);
  }
  const cfg = ctx.settings.get<{ max_lookups_per_record?: number }>("processing.entity_linking", { max_lookups_per_record: 10 });
  const maxLookups = typeof cfg.max_lookups_per_record === "number" ? cfg.max_lookups_per_record : 10;
  const unlinked: Array<{ text: string; kind: string; reason: string }> = [];
  const refused = (kind: string) => unlinked.push({ text: "", kind, reason: "open_check" });
  let lookups = 0, linked = 0;
  const openSettings = job.class === "open" ? openCheckSettings(ctx.settings) : null;
  const refusedKinds = new Set<string>(), refusedRules = new Set<string>();
  const openRefused = async (...names: string[]): Promise<boolean> => {
    if (!openSettings?.enabled) return false;
    const found = await runOpenCheck(openSettings, [{ field: "entities", value: [...new Set(names.filter(Boolean))].join("\n") }]);
    for (const f of found) { refusedKinds.add(f.kind); refusedRules.add(f.rule); }
    return found.length > 0;
  };
  const found = new Map<string, number>();
  const link = async (id: string, confidence: number) => { found.set(id, Math.max(found.get(id) ?? 0, confidence)); };
  const resolved: ResolvedMention[] = [];
  let source: TextNames | null = null, lower: string | null = null;
  const inSource = (p: { login: string; display_name: string }, name: string): boolean =>
    (p.login === name && (lower ??= `${rec.title ?? ""}\n${text}`.normalize("NFKC").toLowerCase()).includes(name))
    || (source ??= new TextNames(`${rec.title ?? ""}\n${text}`)).person(p.display_name);
  let people: Array<{ id: string; login: string; display_name: string; norm: string }> | null = null;
  const loadPeople = async () => people ??= (await ctx.db.control.query("SELECT id, login, display_name FROM people WHERE instance_id = $1 AND active", [ctx.instanceId])).rows
    .map((p) => ({ id: p.id, login: p.login, display_name: p.display_name, norm: normName(p.display_name) }));

  const projectAccess = new Map<string, boolean>();
  const readable = async (entity: { attrs?: Record<string, unknown> }): Promise<boolean> => {
    const spaceId = entity.attrs?.space_id;
    if (typeof spaceId !== "string") return true;
    if (!projectAccess.has(spaceId)) projectAccess.set(spaceId, await projectEntityReadable(ctx.db.control, rec.owner_id, spaceId));
    return projectAccess.get(spaceId)!;
  };

  // the registry index of the worker process (entity-index.ts): no query per mention; it holds no access decision
  let index: RegistryIndex | null = null;
  // on an open record the name the agents will see is read again by id: the index may be up to 60 s old, and a renamed
  // entity must not pass the open-class check under its old name. Null — the entity is gone.
  const currentName = async (e: { id: string; display_name: string }): Promise<string | null> => {
    if (!openSettings?.enabled) return e.display_name;
    const row = (await ctx.db.control.query("SELECT display_name FROM entities WHERE id = $1 AND instance_id = $2", [e.id, ctx.instanceId])).rows[0];
    return row ? (row.display_name as string) : null;
  };
  // a configuration failure of the lookup (connector set to error): the rest of the record's mentions wait, no calls
  let unavailable = false;

  for (const m of mentions) {
    const kind = m.kind ?? "other", name = normName(m.text);
    if (!name) continue;
    if (kind === "person") {
      const hit = matchPerson(await loadPeople(), name);
      if (hit.length === 1 && !inSource(hit[0], name)) { unlinked.push({ text: m.text, kind, reason: "not_in_source" }); continue; }
      if (hit.length === 1 && (await openRefused(hit[0].display_name))) { refused(kind); continue; }
      if (hit.length === 1) {
        await ctx.db.control.query("INSERT INTO entities (id, kind, external_system, external_id, display_name, instance_id) VALUES ($1,'person','people',$2,$3,$4) ON CONFLICT DO NOTHING", [hit[0].id, hit[0].login, hit[0].display_name, ctx.instanceId]);
        await link(hit[0].id, 0.9);
      } else unlinked.push({ text: m.text, kind, reason: hit.length ? "ambiguous" : "not_found" });
      continue;
    }
    const matching = (index ??= await registryIndex(ctx.db.control, ctx.instanceId)).byName(kind, name);
    const reg = [];
    for (const entity of matching) if (kind !== "project" || await readable(entity)) reg.push(entity);
    if (reg.length === 1) {
      const current = await currentName(reg[0]!);
      if (current === null) unlinked.push({ text: m.text, kind, reason: "not_found" });
      else if (await openRefused(current)) refused(kind);
      else { await link(reg[0]!.id, 0.9); resolved.push({ text: m.text, kind, entity_id: reg[0]!.id }); }
      continue;
    }
    if (reg.length > 1) { unlinked.push({ text: m.text, kind, reason: "ambiguous" }); continue; }
    // Read the current worker settings at each call site, so a refresh stops the next mention in an ongoing run.
    // Three states: false — off, true — on, null or no key — not set, the default (on); another type — off.
    const lookupSwitch = ctx.settings.get<{ external_lookup?: unknown }>("processing.entity_linking", { external_lookup: true }).external_lookup;
    const useExternal = lookupSwitch === true || lookupSwitch === null || lookupSwitch === undefined;
    if (useExternal && kind !== "project" && ctx.externalLookup) {
      if (unavailable) { unlinked.push({ text: m.text, kind, reason: "lookup_unavailable" }); continue; }
      if (lookups >= maxLookups) { unlinked.push({ text: m.text, kind, reason: "lookup_limit" }); continue; }
      // a failure a retry may fix throws EntityResolverError before anything is written: earlier links stay
      const r = await resolveExternal(ctx, kind, m.text);
      if (r.status !== "none") {
        lookups++;
        if (r.status === "unavailable") { unavailable = true; unlinked.push({ text: m.text, kind, reason: "lookup_unavailable" }); continue; }
        // exactly one hit over all connectors → an entity with a deterministic id; none or several — a text mention
        const key = r.hits.length === 1 ? hitKey(kind, r.hits[0]!) : null;
        if (r.hits.length !== 1 || !key) { unlinked.push({ text: m.text, kind, reason: r.hits.length > 1 ? "ambiguous" : "not_found" }); continue; }
        const hit = r.hits[0]!, id = entityId(key);
        const stored = (await ctx.db.control.query("SELECT display_name FROM entities WHERE id = $1", [id])).rows[0]?.display_name as string | undefined;
        if (await openRefused(hit.title, stored ?? "")) { refused(kind); continue; }
        await ctx.db.control.query("INSERT INTO entities (id, kind, external_system, external_id, display_name, instance_id) VALUES ($1,$2,$6,$3,$4,$5) ON CONFLICT DO NOTHING",
          [id, key.kind, key.externalId, hit.title, ctx.instanceId, key.externalSystem]);
        await link(id, 0.7);
        resolved.push({ text: m.text, kind, entity_id: id });
        continue;
      }
    }
    unlinked.push({ text: m.text, kind, reason: "not_in_registry" });
  }

  // An explicit project:<slug> links an existing project for any owner of the record, with the readable check;
  // creating a new project in the registry stays with heads of a unit. The link
  // "stated by a person" is written below, in one transaction with the removal of the model's links
  const human: string[] = [];
  const explicit = ((rec.attrs?.mentions ?? []) as Array<{ text: string; reason?: string }>).filter((x) => x.reason === "not_in_registry" && x.text.startsWith("project:"));
  const head = explicit.length > 0 && Boolean((await ctx.db.control.query("SELECT 1 FROM person_org_units WHERE person_id = $1 AND relation = 'head'", [rec.owner_id])).rowCount);
  if (explicit.length) {
    for (const x of explicit) {
      const key = parseEntityKey(x.text);
      if (!key) continue;
      const id = entityId(key);
      let stored = (await ctx.db.control.query("SELECT id, display_name, attrs FROM entities WHERE id = $1", [id])).rows[0];
      if (!stored) {
        const space = (await ctx.db.control.query("SELECT id, slug, name, instance_id FROM spaces WHERE kind = 'project' AND slug = $1 AND instance_id = $2", [key.externalId, ctx.instanceId])).rows[0];
        if (space) {
          if (!(await projectEntityReadable(ctx.db.control, rec.owner_id, space.id))) continue;
          if (!(await ensureProjectEntity(ctx.db.control, space))) continue;
        } else {
          if (!head) continue;
          if (await openRefused(key.externalId)) continue;
          await ctx.db.control.query("INSERT INTO entities (id, kind, external_system, external_id, display_name, instance_id) VALUES ($1,'project','memory',$2,$2,$3) ON CONFLICT DO NOTHING", [id, key.externalId, ctx.instanceId]);
        }
        stored = (await ctx.db.control.query("SELECT id, display_name, attrs FROM entities WHERE id = $1", [id])).rows[0];
      }
      if (!stored || !(await readable(stored)) || (await openRefused(stored.display_name))) continue;
      human.push(id);
    }
  }
  linked = found.size;
  const keepExplicit = ((rec.attrs?.mentions ?? []) as Array<{ text: string; reason?: string }>).filter((x) => x.reason === "not_in_registry");
  let dropped = 0;
  await tx(db, async (c) => {
    dropped = (await c.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'mentioned' AND method = 'extracted_by_model' AND NOT (entity_id = ANY($2::uuid[]))",
                             [rec.id, [...new Set([...found.keys(), ...human])]])).rowCount ?? 0;
    for (const [id, confidence] of found)
      await c.query("INSERT INTO record_entities (record_id, entity_id, role, method, confidence) VALUES ($1,$2,'mentioned','extracted_by_model',$3) ON CONFLICT DO NOTHING", [rec.id, id, confidence]);
    for (const id of human)
      await c.query(`INSERT INTO record_entities (record_id, entity_id, role, method, confidence) VALUES ($1,$2,'mentioned','stated_by_human',1.0)
                     ON CONFLICT (record_id, entity_id, role) DO UPDATE SET method = 'stated_by_human', confidence = 1.0`, [rec.id, id]);
    await c.query("UPDATE records SET attrs = attrs || jsonb_build_object('mentions', $2::jsonb, 'entity_linking', $3::jsonb) WHERE id = $1",
      [rec.id, JSON.stringify([...keepExplicit, ...unlinked]), JSON.stringify({ linked, unlinked: unlinked.length, external_lookups: lookups, version: job.version, resolved })]);
  });
  let children = { children: 0, links: 0 };
  if (rec.type === "transcript") {
    await syncParticipants(ctx, job.class, rec);
    children = await linkMeetingChildren(ctx, job.class, rec.id);
  }
  if (refusedRules.size)
    await auditWorker(ctx, { event_type: "processing", class: "open", record_ids: [rec.id], space_id: rec.space_id,
                             details: { op: "open_check_refused", via: "derive", stage: "entities", kinds: [...refusedKinds], rules: [...refusedRules] } });
  log.info("entities_linked", { record_id: rec.id, linked, unlinked: unlinked.length, dropped, external_lookups: lookups, child_links: children.links });
  return "done";
}

export { personId };
