// Who and what is «named directly» in a record: the collection of a person or client is the records where they are
// named, not all records of meetings they attended. Code only, no model; an unlinked one is normal.
// - A person — by full name: all words of display_name in a row, any order («John Smith», «Smith John»). One word and
//   inflected forms are not linked — the full-name rule: an inflected name is not guessed.
// - A company, deal, project — by registry name or alias in a row (quotes, a legal form at the start do not matter), 4+ chars;
//   a one-word name — only when written as a proper name (in quotes or capitalized not at a sentence start).
// - A meeting's derived record — also by the meeting's resolver cache: a company or deal the meeting found by another
//   name (in the CRM «Shelving supply Alpha-Test», in the event «the shelving deal») is linked to the derived one whose
//   mentions hold that text of the same kind.
// Where it applies: the entities stage — a check that a person from the model's mentions is named in the record (else
// the surname may come from the attendee list), and links of meeting derivatives (summary, events) by their mentions;
// the named_links pass — notes and events of people and agents by text, and a one-off recount of processed meetings.
// Attendance — the participant role on the transcript (attrs.participants); the access list (record_people) stays.
import type { PoolClient } from "pg";
import { commitOrThrow, log, openCheckSettings, projectEntityReadable, runOpenCheck, txOn, type DataClass } from "@memory/shared";
import { recordsDb, type DbCtx } from "../ctx.ts";
import { registryIndex } from "./entity-index.ts";

// Legal forms dropped from a name: English ones at the end, Russian ones (data for Russian names) at the start.
const LEGAL_EN = /,?\s+(?:llc|inc|ltd|limited|corp|corporation|gmbh|plc)\.?$/u;
const LEGAL = /^(ооо|оао|зао|пао|ао|ип|нко|гк)\s+/u;
/** Name normalization: NFKC, case, Cyrillic yo→ye, no quotes or legal form. */
export const normName = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[«»"'“”„`]/g, "").replace(/\s+/g, " ").trim().replace(LEGAL, "").replace(LEGAL_EN, "").trim();

const WORD = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
/** Text words: case and yo do not matter, a hyphen inside a word stays («Alpha-Test» is one word). */
export const wordsOf = (s: string): string[] => s.normalize("NFKC").toLowerCase().replace(/ё/g, "е").match(WORD) ?? [];
/** Name or title words after normalization (no quotes or legal form). */
export const nameWords = (name: string): string[] => wordsOf(normName(name));
/** Shorter — not linked: one short word would match anything. */
export const MIN_NAME_CHARS = 4;
const sortedKey = (ws: readonly string[]): string => [...ws].sort().join(" ");

const UPPER = /\p{Lu}/u;
/**
 * A word written as a proper name: in quotes («Service»), capitalized not at a sentence or line start,
 * or capitalized inside (ACME, Alpha-Test). A one-word name needs it: «Service», «Support», «Audit» are common
 * words too, and without such a mark the named_links pass would link the entity to each record with the word.
 */
function properAt(src: string, start: number, raw: string): boolean {
  if (/[«"“„'`]$/u.test(src.slice(Math.max(0, start - 1), start))) return true;
  const chars = [...raw];
  if (chars.slice(1).some((c) => UPPER.test(c))) return true;
  if (!UPPER.test(chars[0] ?? "")) return false;
  const head = src.slice(src.lastIndexOf("\n", start - 1) + 1, start);
  if (/^[\s\-–—*•>#\d.)]*$/u.test(head)) return false;                     // line start, list item, heading
  return !/[.!?…]$/u.test(head.trimEnd());                                  // sentence start
}

/** Names and titles in record text: a person by full name in any order, the rest by the title in a row. */
export class TextNames {
  private readonly ws: string[];
  private readonly set: Set<string>;
  /** Word i is written as a proper name (properAt): only so a one-word title is linked. */
  private readonly proper: boolean[];
  constructor(text: string) {
    const src = text.normalize("NFKC");
    this.ws = []; this.proper = [];
    for (const m of src.matchAll(WORD)) { this.ws.push(m[0].toLowerCase().replace(/ё/g, "е")); this.proper.push(properAt(src, m.index ?? 0, m[0])); }
    this.set = new Set(this.ws);
  }

  /** A person's full name: all words of display_name in a row, any order; one word — no (the full-name rule). */
  person(name: string): boolean {
    const want = nameWords(name);
    if (want.length < 2 || !want.every((w) => this.set.has(w))) return false;
    const key = sortedKey(want), n = want.length, first = new Set(want);
    for (let i = 0; i + n <= this.ws.length; i++) if (first.has(this.ws[i]!) && sortedKey(this.ws.slice(i, i + n)) === key) return true;
    return false;
  }

  /**
   * A title in a row and in the same order (company, deal, project); shorter than MIN_NAME_CHARS — no. A one-word title —
   * only where the word is written as a proper name (properAt): «the audit is done» is not linked to project «Audit».
   */
  phrase(name: string): boolean {
    const want = nameWords(name);
    if (!want.length || want.join(" ").length < MIN_NAME_CHARS || !want.every((w) => this.set.has(w))) return false;
    for (let i = 0; i + want.length <= this.ws.length; i++)
      if (want.every((w, k) => this.ws[i + k] === w) && (want.length > 1 || this.proper[i])) return true;
    return false;
  }

  /** Keys of all windows of 2–4 words (words in alphabetical order): full-name candidates without scanning the org table. */
  personKeys(): Set<string> {
    const out = new Set<string>();
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= this.ws.length; i++) out.add(sortedKey(this.ws.slice(i, i + n)));
    return out;
  }

  /** Runs of 1–6 words: registry title candidates without scanning the whole registry; one word — as a proper name. */
  phrases(): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < this.ws.length; i++) if (this.proper[i]) out.add(this.ws[i]!);
    for (let n = 2; n <= 6; n++) for (let i = 0; i + n <= this.ws.length; i++) out.add(this.ws.slice(i, i + n).join(" "));
    return out;
  }
}

const words = (s: string): string[] => s.split(" ").filter(Boolean).sort();
/**
 * A person by mention: only a login or a full name — all words of display_name, the order
 * «First Last» / «Last First» does not matter. One word («John», «Smith») or a partial name is not linked: «John Doe»
 * in a record does not become the employee «John Smith» by the shared first name. Inflections are not guessed — they
 * stay an unlinked mention: safer than mixing up two relatives' surname forms. `name` is already normName. The caller
 * links only on a single match; several — ambiguous, none — not_found (normal, not an error).
 */
export function matchPerson<P extends { login: string; norm: string }>(people: readonly P[], name: string): P[] {
  const want = words(name);
  return people.filter((p) => {
    if (p.login === name) return true;
    if (want.length < 2) return false;
    const have = words(p.norm);
    return have.length === want.length && have.every((w, i) => w === want[i]);
  });
}

/** A person's full-name key (words in alphabetical order); a one-word name — null: it cannot link. */
export const personKey = (displayName: string): string | null => { const w = nameWords(displayName); return w.length >= 2 ? sortedKey(w) : null; };
/** An entity title key (words in a row); under MIN_NAME_CHARS — null. */
export const phraseKey = (name: string): string | null => { const w = nameWords(name).join(" "); return w.length >= MIN_NAME_CHARS ? w : null; };

/** A registry entity (or a person: entities.id = people.id) with names to find in text. */
export interface NamedEntity { id: string; kind: string; display_name: string; attrs?: Record<string, unknown> | null }
const namesOf = (e: NamedEntity): string[] => [e.display_name, ...(Array.isArray(e.attrs?.aliases) ? (e.attrs!.aliases as unknown[]).map(String) : [])];

/** Mentions of a derived record: texts of attrs.mentions and (for an event) attrs.actors — what the model named in it. */
export function ownMentions(attrs: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(attrs?.mentions) ? attrs!.mentions as unknown[] : []) {
    const t = typeof m === "string" ? m : typeof (m as { text?: unknown })?.text === "string" ? (m as { text: string }).text : "";
    if (t.trim()) out.push(t);
  }
  for (const a of Array.isArray(attrs?.actors) ? attrs!.actors as unknown[] : []) if (typeof a === "string" && a.trim()) out.push(a);
  return out;
}

/** A mention with kind, as the entities stage resolver sees it: no kind — other. */
export interface KindMention { text: string; kind: string }
/**
 * Mentions of a derived record with kind — only attrs.mentions (what the model named in it); performers (actors) are
 * people, not here. Kind as in the entities resolver (`m.kind ?? "other"`).
 */
export function ownMentionItems(attrs: Record<string, unknown> | null | undefined): KindMention[] {
  const out: KindMention[] = [];
  for (const m of Array.isArray(attrs?.mentions) ? attrs!.mentions as unknown[] : []) {
    const text = typeof m === "string" ? m : typeof (m as { text?: unknown })?.text === "string" ? (m as { text: string }).text : "";
    const kind = typeof (m as { kind?: unknown })?.kind === "string" ? (m as { kind: string }).kind : "other";
    if (text.trim()) out.push({ text, kind });
  }
  return out;
}

/**
 * The resolver cache of a meeting: `attrs.entity_linking.resolved` — by which mention text the
 * entities stage found a company, a deal or a project (the registry, or exactly one hit of an external lookup). It holds
 * no people.
 */
export interface ResolvedMention { text: string; kind: string; entity_id: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cache from meeting attrs: not an array or broken items (no text or kind, id not a uuid, kind person) skipped. */
export function resolvedOf(raw: unknown): ResolvedMention[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is ResolvedMention => !!r && typeof r === "object"
    && typeof (r as ResolvedMention).text === "string" && (r as ResolvedMention).text.trim() !== ""
    && typeof (r as ResolvedMention).kind === "string" && (r as ResolvedMention).kind !== "person"
    && typeof (r as ResolvedMention).entity_id === "string" && UUID.test((r as ResolvedMention).entity_id))
    .map((r) => ({ text: r.text, kind: r.kind, entity_id: r.entity_id }));
}
/** Resolver key — kind and normalized text, the same as the entities stage uses when parsing meeting mentions. */
const resolverKey = (kind: string, text: string): string => `${kind}:${normName(text)}`;
/**
 * Entities the meeting found by the same mentions that a derived record names: the kind and the normalised text match
 * (the same resolver, its cache — no new external lookups). A deal called "the shelving deal" is linked with the event
 * that calls it so, although the CRM names it "Shelving supply for Acme"; the neighbouring event without the mention is
 * not.
 */
export function resolvedIn(cache: readonly ResolvedMention[], mentions: readonly KindMention[]): string[] {
  const said = new Set(mentions.map((m) => resolverKey(m.kind, m.text)).filter((k) => !k.endsWith(":")));
  return [...new Set(cache.filter((r) => said.has(resolverKey(r.kind, r.text))).map((r) => r.entity_id))];
}

/**
 * Whether the entity is named in the record: in its text or its own mentions. A person — by full name (a text window or
 * a mention with the same words), the rest — by title or alias in a row.
 */
export function namedIn(e: NamedEntity, text: TextNames, mentions: readonly string[]): boolean {
  if (e.kind === "person") {
    const keys = new Set(mentions.map(personKey).filter((k): k is string => k !== null));
    return namesOf(e).some((n) => text.person(n) || (personKey(n) !== null && keys.has(personKey(n)!)));
  }
  const said = new Set(mentions.map(phraseKey).filter((k): k is string => k !== null));
  return namesOf(e).some((n) => text.phrase(n) || (phraseKey(n) !== null && said.has(phraseKey(n)!)));
}

/**
 * A meeting's derived records — by their own mentions: a summary or event gets a link
 * `mentioned` to what memory marked on the meeting (meeting links except attendance and project tag — they passed
 * the full-name rule, the open class check and project rights) if named in the derived record itself. So «John Smith»'s collection
 * shows his tasks, not others' tasks of the same meeting. Earlier such links are replaced (a stage repeat and a recount
 * leave no extra ones). No model; one meeting entities stage — one call.
 * An event corrected by a person (memory_correct extraction_error, «Replace the performer in all decisions») is also
 * a meeting derivative (source_kind correction): the link — by the new version's text and the performers set by hand;
 * the model's mentions (attrs.mentions of the old version) no longer count — else the old performer would stay linked.
 * A company, deal or project the meeting found under another name — also by the meeting's resolver cache
 * (`attrs.entity_linking.resolved`, resolvedIn): a derived record's mention of the same kind and text by which the
 * meeting found the entity. Only what is linked to the meeting now is taken (except people): project rights and the open
 * class check are the meeting's; a stale cache row links nothing. An event corrected by a person has no model
 * mentions; no cache applies to it.
 */
export async function linkMeetingChildren(ctx: DbCtx, cls: DataClass, parentId: string): Promise<{ children: number; links: number }> {
  const db = recordsDb(ctx, cls);
  const kids = (await db.query(
    `SELECT r.id, r.title, r.attrs, r.source_kind, c.text FROM records r LEFT JOIN record_content c ON c.record_id = r.id
     WHERE r.parent_id = $1 AND r.source_kind IN ('pipeline','correction') AND r.type IN ('summary','event') AND r.is_current AND r.deleted_at IS NULL`, [parentId])).rows;
  if (!kids.length) return { children: 0, links: 0 };
  const ids = (await db.query("SELECT DISTINCT entity_id FROM record_entities WHERE record_id = $1 AND role NOT IN ('participant','space')", [parentId])).rows.map((r) => r.entity_id as string);
  const ents: NamedEntity[] = ids.length ? (await ctx.db.control.query(
    `SELECT id, kind, display_name, attrs FROM entities WHERE id = ANY($1::uuid[])
     UNION ALL SELECT p.id, 'person', p.display_name, '{}'::jsonb FROM people p WHERE p.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = p.id)`, [ids])).rows : [];
  const linkedThings = new Set(ents.filter((e) => e.kind !== "person").map((e) => e.id));
  const cache = linkedThings.size
    ? resolvedOf((await db.query("SELECT attrs->'entity_linking'->'resolved' AS resolved FROM records WHERE id = $1", [parentId])).rows[0]?.resolved).filter((r) => linkedThings.has(r.entity_id))
    : [];
  let links = 0;
  for (const k of kids) {
    const fixed = k.source_kind === "correction";
    const text = new TextNames(`${k.title ?? ""}\n${k.text ?? ""}`), said = ownMentions(fixed ? { actors: k.attrs?.actors } : k.attrs);
    const byCache = cache.length && !fixed ? resolvedIn(cache, ownMentionItems(k.attrs)) : [];
    const want = [...new Set([...ents.filter((e) => namedIn(e, text, said)).map((e) => e.id), ...byCache])];
    await db.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'mentioned' AND method = 'extracted_by_model' AND entity_id <> ALL($2::uuid[])", [k.id, want]);
    if (want.length) links += (await db.query(
      "INSERT INTO record_entities (record_id, entity_id, role, method, confidence) SELECT $1, e, 'mentioned', 'extracted_by_model', 0.8 FROM unnest($2::uuid[]) e ON CONFLICT DO NOTHING", [k.id, want])).rowCount ?? 0;
  }
  return { children: kids.length, links };
}

/**
 * Taking part in a meeting — the `participant` role on the transcript: people from attrs.participants (logins
 * of recognized attendees). The link is set if missing; only an attendee change at the gateway (participants.ts) drops it —
 * logins in attrs may go stale after a login change, the person id in the link does not. Access lists stay untouched.
 */
export async function syncParticipants(ctx: DbCtx, cls: DataClass, rec: { id: string; type: string; attrs?: Record<string, any> | null }): Promise<number> {
  if (rec.type !== "transcript") return 0;
  const logins = (Array.isArray(rec.attrs?.participants) ? rec.attrs!.participants as unknown[] : []).map((l) => String(l).toLowerCase()).filter(Boolean);
  if (!logins.length) return 0;
  const people = (await ctx.db.control.query("SELECT id FROM people WHERE instance_id = $1 AND lower(login) = ANY($2::text[])", [ctx.instanceId, logins])).rows.map((r) => r.id as string);
  if (!people.length) return 0;
  await personEntities(ctx, people);
  return (await recordsDb(ctx, cls).query(
    "INSERT INTO record_entities (record_id, entity_id, role, method, confidence) SELECT $1, p, 'participant', 'stated_by_human', 1.0 FROM unnest($2::uuid[]) p ON CONFLICT DO NOTHING",
    [rec.id, people])).rowCount ?? 0;
}

/** A person's registry row (entities.id = people.id) — memory_read shows the link by it; lazy, as in the gateway. */
export async function personEntities(ctx: DbCtx, ids: string[]): Promise<void> {
  if (ids.length) await ctx.db.control.query(
    `INSERT INTO entities (id, kind, external_system, external_id, display_name, instance_id)
     SELECT id, 'person', 'people', login, display_name, instance_id FROM people WHERE id = ANY($1::uuid[]) ON CONFLICT DO NOTHING`, [ids]);
}

/** Open class check of an entity name: a client name from the NDA list next to an open record is not shown to agents. */
export async function openNameRefused(ctx: DbCtx, cls: DataClass, ...names: string[]): Promise<boolean> {
  if (cls !== "open") return false;
  const s = openCheckSettings(ctx.settings);
  if (!s.enabled) return false;
  return (await runOpenCheck(s, [{ field: "entities", value: [...new Set(names.filter(Boolean))].join("\n") }])).length > 0;
}

// ---------------------------------------------------------------- named_links pass

/**
 * Version of the name-link rule: a change — recount from the start (a one-off pass with no model). 2 — a one-word title
 * only as a proper name, documents recounted, meeting events corrected by a person.
 */
export const NAMED_LINKS_VERSION = 2;
const STATE_KEY = "named_links";
const BATCH = 500, BATCHES_PER_RUN = 4;
/**
 * Cursor margin by arrival time: records.ingested_at is the transaction start. A record whose transaction began before
 * the batch read and committed after it gets a time below the saved cursor and never enters the pass. Only records
 * older than the margin are taken — the cursor does not overtake the uncommitted.
 */
const SETTLE = "interval '2 minutes'";
const NOTE_FENCE_TIMEOUTS = "SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '2s'";

interface Cursor { at: string; id: string }
type Recompute = Partial<Record<DataClass, string | "done">>;
interface NamedState { version?: number; notes?: Partial<Record<DataClass, Cursor>>; meetings?: Recompute; documents?: Recompute }
export interface NamedPassResult {
  notes: number; note_links: number; notes_deferred: number; corrections: number; meetings: number; participants: number; dropped: number; children: number; child_links: number;
  documents: number; doc_dropped: number; failed: number; recompute_done: boolean;
}

/** Org table people by full-name key; a name shared by two is ambiguous and not linked. */
type PeopleIndex = { byKey: Map<string, Array<{ id: string; display_name: string }>>; all: Array<{ id: string; login: string; display_name: string; norm: string }> };

async function loadPeople(ctx: DbCtx): Promise<PeopleIndex> {
  const rows = (await ctx.db.control.query(
    "SELECT id, login, display_name FROM people WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') <> 'true'", [ctx.instanceId])).rows as Array<{ id: string; login: string; display_name: string }>;
  const byKey = new Map<string, Array<{ id: string; display_name: string }>>();
  for (const p of rows) { const k = personKey(p.display_name); if (k) byKey.set(k, [...(byKey.get(k) ?? []), { id: p.id, display_name: p.display_name }]); }
  return { byKey, all: rows.map((p) => ({ ...p, norm: normName(p.display_name) })) };
}

/** The entity registry (not people) by title and aliases; one title for two entities is ambiguous. */
async function loadRegistry(ctx: DbCtx): Promise<Map<string, NamedEntity[]>> {
  const rows = (await registryIndex(ctx.db.control, ctx.instanceId)).rows() as unknown as NamedEntity[];   // the shared index
  const out = new Map<string, NamedEntity[]>();
  for (const e of rows) for (const n of namesOf(e)) {
    const k = phraseKey(n);
    if (k && !(out.get(k) ?? []).some((x) => x.id === e.id)) out.set(k, [...(out.get(k) ?? []), e]);
  }
  return out;
}

/**
 * A note or event of a person or agent (memory_remember, not model derivatives): links to people named by full name,
 * and to companies, deals, projects named in a row. An ambiguous name is not linked; a project — only one readable
 * by the record's author (as at the entities stage); an open record — only a name past the open class check. A check
 * with no answer (queue full, stream down) — the name is not linked (as a refusal), logged; the pass goes on. Older
 * links of this pass are replaced; a person's stated entities (stated_by_human) stay.
 */
async function linkNote(ctx: DbCtx, cls: DataClass, note: { id: string; title: string | null; text: string | null; owner_id: string }, people: PeopleIndex,
                        registry: Map<string, NamedEntity[]>, projectAccess: Map<string, boolean>): Promise<number | null> {
  const text = new TextNames(`${note.title ?? ""}\n${note.text ?? ""}`);
  const want: Array<{ id: string; name: string; person: boolean; phrase?: string }> = [];
  for (const k of text.personKeys()) { const hit = people.byKey.get(k); if (hit?.length === 1) want.push({ id: hit[0]!.id, name: hit[0]!.display_name, person: true }); }
  for (const k of text.phrases()) {
    const hit = registry.get(k);
    if (hit?.length !== 1) continue;
    const e = hit[0]!, space = e.attrs?.space_id;
    if (cls !== "open" && typeof space === "string") {
      const key = `${note.owner_id}:${space}`;
      if (!projectAccess.has(key)) projectAccess.set(key, await projectEntityReadable(ctx.db.control, note.owner_id, space));
      if (!projectAccess.get(key)) continue;
    }
    want.push({ id: e.id, name: e.display_name, person: false, phrase: k });
  }
  const entityIds = want.filter((w) => !w.person).map((w) => w.id);
  const fenced = cls === "open" && entityIds.length > 0;
  const current = async (q: Pick<PoolClient, "query">, lock: boolean): Promise<typeof want> => {
    const sql = "SELECT id, kind, display_name, attrs FROM entities WHERE id = ANY($1::uuid[]) AND instance_id = $2";
    // Match the connector upsert's order within a source. FOR SHARE also blocks ordinary name and attribute updates.
    const order = ' ORDER BY kind COLLATE "C", external_id COLLATE "C", id FOR SHARE';
    const { rows } = await q.query<NamedEntity>(lock ? sql + order : sql, [entityIds, ctx.instanceId]);
    const byId = new Map(rows.map((e) => [e.id, e]));
    const eligible: typeof want = [];
    const readable = new Map<string, boolean>();
    for (const w of want) {
      if (w.person) { eligible.push(w); continue; }
      const e = byId.get(w.id);
      if (!e || e.kind === "person" || !namesOf(e).some((n) => phraseKey(n) === w.phrase)) continue;
      const space = e.attrs?.space_id;
      if (typeof space === "string") {
        if (!readable.has(space)) readable.set(space, await projectEntityReadable(q, note.owner_id, space));
        if (!readable.get(space)) continue;
      }
      eligible.push({ ...w, name: e.display_name });
    }
    return eligible;
  };
  const proposed = fenced ? await current(ctx.db.control, false) : want;
  const checked = new Map<string, { name: string; allowed: boolean }>();
  for (const w of new Map(proposed.map((x) => [x.id, x])).values()) {
    let allowed = false;
    try { allowed = !(await openNameRefused(ctx, cls, w.name)); }
    catch (e) { log.warn("named_links_open_check_failed", { record_id: note.id, error: String((e as Error)?.message ?? e).slice(0, 160) }); }
    checked.set(w.id, { name: w.name, allowed });
  }
  await personEntities(ctx, proposed.filter((w) => w.person && checked.get(w.id)?.allowed).map((w) => w.id));
  const replaceLinks = async (q: Pick<PoolClient, "query">, ids: string[]): Promise<number> => {
    await q.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'mentioned' AND method = 'source_document' AND entity_id <> ALL($2::uuid[])", [note.id, ids]);
    return ids.length ? (await q.query(
      `INSERT INTO record_entities (record_id, entity_id, role, method, confidence, locator)
       SELECT $1, e, 'mentioned', 'source_document', 0.8, '{"via":"named"}'::jsonb FROM unnest($2::uuid[]) e ON CONFLICT DO NOTHING`, [note.id, ids])).rowCount ?? 0 : 0;
  };
  const db = recordsDb(ctx, cls);
  const allowedIds = (ids: Iterable<string>): string[] => [...new Set(ids)].filter((id) => checked.get(id)?.allowed);
  if (!fenced) return replaceLinks(db, allowedIds(checked.keys()));

  // repeat the eligibility check and confirm the checked names under share locks held through the records commit.
  // The open checks, person writes and pool waits all finish before taking those locks.
  const writer = await db.connect();
  let writerFailed = false;
  try {
    const guard = await ctx.db.controlLocks().connect();
    let defer = false;
    let guardFailed = false;
    const onContention = (e: unknown): never => {
      const code = (e as { code?: unknown })?.code;
      defer = code === "55P03" || code === "40P01";
      throw e;
    };
    try {
      await guard.query("BEGIN");
      await guard.query(NOTE_FENCE_TIMEOUTS);
      const eligible = await current(guard, true).catch(onContention);
      let linked: number | null = null;
      if (eligible.every((w) => checked.get(w.id)?.name === w.name)) {
        const ids = allowedIds(eligible.map((w) => w.id));
        linked = await txOn(writer, async (q) => {
          await q.query(NOTE_FENCE_TIMEOUTS);
          return replaceLinks(q, ids).catch(onContention);
        }).catch((e: unknown) => { writerFailed = true; throw e; });
      }
      await commitOrThrow(guard);
      return linked;
    } catch (e) {
      guardFailed = true;
      try { await guard.query("ROLLBACK"); } catch { /* Preserve the original error and discard the client. */ }
      if (defer) return null;
      throw e;
    } finally {
      guard.release(guardFailed);
    }
  } finally {
    writer.release(writerFailed);
  }
}

/**
 * People links of a meeting or document by the full-name rule after the fact: the model's `mentioned` link to a person stays only
 * if the model's mentions (attrs.pipeline_mentions: summary, events, document description) hold their full name
 * (a single match in the org table) and that name is in the record's own text. Before, one word («John») linked
 * the record to the only employee with that word. Sets no new links; the text is read only if there is something to check.
 */
async function prunePersonLinks(ctx: DbCtx, cls: DataClass, id: string, people: PeopleIndex): Promise<number> {
  const db = recordsDb(ctx, cls);
  const linked = (await db.query("SELECT entity_id FROM record_entities WHERE record_id = $1 AND role = 'mentioned' AND method = 'extracted_by_model'", [id])).rows.map((r) => r.entity_id as string);
  const persons = people.all.filter((p) => linked.includes(p.id));
  if (!persons.length) return 0;
  const rec = (await db.query("SELECT r.title, r.attrs, c.text FROM records r LEFT JOIN record_content c ON c.record_id = r.id WHERE r.id = $1", [id])).rows[0];
  if (!rec) return 0;
  const text = new TextNames(`${rec.title ?? ""}\n${rec.text ?? ""}`), pm = (rec.attrs?.pipeline_mentions ?? {}) as Record<string, Array<{ text?: string; kind?: string }>>;
  const valid = new Set<string>();
  for (const m of [...(pm.summary ?? []), ...(pm.events ?? []), ...(pm.describe ?? [])]) {
    if (m.kind !== "person" || !m.text) continue;
    const hit = matchPerson(people.all, normName(m.text));
    if (hit.length === 1 && text.person(hit[0]!.display_name)) valid.add(hit[0]!.id);
  }
  const drop = persons.filter((p) => !valid.has(p.id)).map((p) => p.id);
  return drop.length ? (await db.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'mentioned' AND method = 'extracted_by_model' AND entity_id = ANY($2::uuid[])", [id, drop])).rowCount ?? 0 : 0;
}

let running: Promise<NamedPassResult> | null = null;

/**
 * The name-link pass, every 10 minutes and at worker start, no model:
 * 1) notes and events of people and agents that came after the last pass (a cursor by arrival time, with margin
 *    SETTLE) — links by name; a meeting event corrected by a person (memory_correct) — the derivatives' links recount
 *    (the gateway does not copy model links to the new version);
 * 2) until the recount of the current rule version (NAMED_LINKS_VERSION) is done — processed meetings (attendance by
 *    participant role, people links by the full-name rule, summary and event links by their own mentions) and documents (people
 *    links by the full-name rule).
 * Per pass — at most BATCHES_PER_RUN batches of BATCH records of each kind in each database; the rest — next pass.
 * The state is written after each batch; a failure of one kind (database, open class check) does not stop the others —
 * it repeats from its own cursor next pass. New meetings are linked by the entities stage. Rights and access do not
 * change: only the links for collections do.
 */
export function namedLinksPass(ctx: DbCtx): Promise<NamedPassResult> {
  running ??= runPass(ctx).finally(() => { running = null; });
  return running;
}

async function runPass(ctx: DbCtx): Promise<NamedPassResult> {
  const out: NamedPassResult = { notes: 0, note_links: 0, notes_deferred: 0, corrections: 0, meetings: 0, participants: 0, dropped: 0, children: 0, child_links: 0,
                                 documents: 0, doc_dropped: 0, failed: 0, recompute_done: true };
  const saved = ((await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, STATE_KEY])).rows[0]?.value ?? {}) as NamedState;
  const state: Required<Pick<NamedState, "notes" | "meetings" | "documents">> & NamedState = saved.version === NAMED_LINKS_VERSION
    ? { ...saved, notes: { ...saved.notes }, meetings: { ...saved.meetings }, documents: { ...saved.documents } }
    : { version: NAMED_LINKS_VERSION, notes: {}, meetings: {}, documents: {} };
  // the state — after each batch: a failure mid-pass keeps the advanced cursor
  const save = async (): Promise<void> => { await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, STATE_KEY, JSON.stringify({ ...state, last: { ...out, at: new Date().toISOString() } })]); };
  // each record kind of a database apart: a failure of one (database, open class check) stops no others
  const phase = async (cls: DataClass, what: string, run: () => Promise<void>): Promise<void> => {
    try { await run(); }
    catch (e) { out.failed++; log.warn("named_links_failed", { class: cls, phase: what, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    await save().catch((e: unknown) => log.warn("named_links_state_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) }));
  };
  const people = await loadPeople(ctx), registry = await loadRegistry(ctx), projectAccess = new Map<string, boolean>();
  for (const cls of ["open", "closed"] as const) {
    const db = recordsDb(ctx, cls);
    await phase(cls, "notes", async () => {
      const relinked = new Set<string>();        // «Replace the performer in all decisions»: many versions of a meeting
      for (let b = 0; b < BATCHES_PER_RUN; b++) {
        const cur = state.notes[cls];
        const rows = (await db.query(
          `SELECT r.id, r.title, r.owner_id, r.parent_id, r.source_kind, to_char(r.ingested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, c.text
           FROM records r LEFT JOIN record_content c ON c.record_id = r.id
           WHERE r.is_current AND r.deleted_at IS NULL AND r.ingested_at < now() - ${SETTLE}
             AND ((r.type IN ('note','event') AND r.source_kind <> 'pipeline' AND r.parent_id IS NULL)
                  OR (r.type = 'event' AND r.source_kind = 'correction' AND r.parent_id IS NOT NULL))
             AND ($1::timestamptz IS NULL OR (r.ingested_at, r.id) > ($1::timestamptz, $2::uuid))
           ORDER BY r.ingested_at, r.id LIMIT ${BATCH}`, [cur?.at ?? null, cur?.id ?? null])).rows;
        for (const n of rows) {
          if (n.parent_id) {                       // a meeting event corrected by a person: the meeting's derived links anew
            if (!relinked.has(n.parent_id)) { relinked.add(n.parent_id); const k = await linkMeetingChildren(ctx, cls, n.parent_id); out.child_links += k.links; }
            out.corrections++;
          } else {
            const linked = await linkNote(ctx, cls, n, people, registry, projectAccess);
            if (linked === null) {
              out.notes_deferred++;
              log.warn("named_note_deferred", { class: cls, record_id: n.id });
              return;   // Leave this note and the rest of the batch for the next pass.
            }
            out.note_links += linked;
            out.notes++;
          }
          state.notes[cls] = { at: n.at as string, id: n.id as string };
        }
        await save();
        if (rows.length < BATCH) break;
      }
    });
    // recount of the processed with no model — once per rule version; the cursor — by record id
    const recompute = async (what: "meetings" | "documents", type: string, one: (id: string, attrs: Record<string, any> | null) => Promise<void>) => {
      for (let b = 0; b < BATCHES_PER_RUN && state[what][cls] !== "done"; b++) {
        const after = state[what][cls] ?? null;
        const rows = (await db.query(
          `SELECT r.id, r.type, r.attrs FROM records r WHERE r.type = $2::record_type AND r.is_current AND r.deleted_at IS NULL AND ($1::uuid IS NULL OR r.id > $1::uuid)
           ORDER BY r.id LIMIT ${BATCH}`, [after, type])).rows;
        for (const r of rows) { await one(r.id, r.attrs); state[what][cls] = r.id; }
        if (rows.length < BATCH) state[what][cls] = "done";
        await save();
      }
    };
    await phase(cls, "meetings", () => recompute("meetings", "transcript", async (id, attrs) => {
      out.participants += await syncParticipants(ctx, cls, { id, type: "transcript", attrs });
      out.dropped += await prunePersonLinks(ctx, cls, id, people);
      const k = await linkMeetingChildren(ctx, cls, id);
      out.children += k.children; out.child_links += k.links; out.meetings++;
    }));
    // documents: model links to a person by one word («John» → John Smith) are removed by the full-name rule (mentions
    // of the describe stage, document text); the pass sets documents no new links
    await phase(cls, "documents", () => recompute("documents", "document", async (id) => {
      out.doc_dropped += await prunePersonLinks(ctx, cls, id, people); out.documents++;
    }));
    if (state.meetings[cls] !== "done" || state.documents[cls] !== "done") out.recompute_done = false;
  }
  if (out.notes || out.notes_deferred || out.corrections || out.meetings || out.documents || out.failed) log.info("named_links", { ...out });
  return out;
}
