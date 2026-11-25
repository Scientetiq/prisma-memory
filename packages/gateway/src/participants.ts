// Meeting participants: whom an agent or the transcriber named as a participant — a memory person, a person from
// the AD directory who is not in memory yet, or no one. The order: an exact login or mail → a verified
// person_identities link (`<system>:<id>`, as X-On-Behalf-Of) → a full name among memory people → AD. An inactive person,
// a demo persona and an unverified link are not found. An ambiguous participant — an intake refusal listing up to 5 candidates
// (full name, department, login): the agent asks the person and sends the login; memory does not choose for them.
// "In AD" — access is deferred: the login from the directory lies in the meeting's attrs.participants_pending, and when
// the card appears (a people upload, a sign-in via the directory or the identity provider — each), the person gets the meeting and its parts.
// The directory was not asked (a failure, off, the search limit) — "not found" marked undetermined: a people edit then does not
// erase an earlier waiting one.
import type pg from "pg";
import { invalid, log, tx, type DirectoryHit } from "@memory/shared";
import { audit } from "./audit.ts";
import { archivedTeamSpaces } from "./access.ts";
import { EXTERNAL_ID } from "./auth.ts";
import type { App, Caller } from "./context.ts";
import { ldapErrorCode, lookupDirectory } from "./directory.ts";

export const CANDIDATES_MAX = 5;
/** How many participants of one meeting are looked up in the directory: more — "not found" with a warning (no per-meeting load). */
export const DIRECTORY_LOOKUPS_MAX = 20;
/**
 * How many directory people are viewed for one participant: it was 10 — a namesake could turn out
 * the only match among the first ten. The agent still gets at most CANDIDATES_MAX candidates.
 */
export const DIRECTORY_LIMIT = 50;

export type ParticipantStatus = "resolved" | "in_directory" | "not_found";
export type MatchedBy = "login" | "identity" | "name" | "directory";
export interface Candidate { display_name: string; department: string | null; login: string }
export interface ParticipantResult {
  input: string; status: ParticipantStatus; login?: string; display_name?: string; department?: string | null; matched_by?: MatchedBy;
  /** people.id of the recognized one — only inside the gateway, never given outside */
  personId?: string;
  /**
   * "Not found" only because the directory was not asked: a failure, the directory off, the meeting's search limit.
   * Only inside the gateway: an earlier waiting one with such an input stays waiting (applyParticipants), never given outside.
   */
  undetermined?: boolean;
}
export interface AmbiguousParticipant { input: string; candidates: Candidate[]; truncated: boolean }
export interface Resolution {
  items: ParticipantResult[]; ambiguous: AmbiguousParticipant[]; warnings: string[];
  /** off — the directory was not asked in this recognition: off or did not answer. */
  directory: { lookups: number; found: number; cached: boolean; error: string | null; off: boolean };
}

// ---------------------------------------------------------------- full name
/** Full name words: lower case, yo = ye, dots and signs are separators; a hyphen is part of a word ("Smith-Jones"). */
export function nameWords(s: string): string[] {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}-]+/gu, " ").split(" ").map((w) => w.replace(/^-+|-+$/g, "")).filter(Boolean);
}

export interface NameQuery { full: string[]; initials: string[] }

/**
 * A participant as a full name: at least one full word and at least two in all — "Surname Name", "Surname N.", "N. M. Surname".
 * One word is not a full name: "Smith" in a company is a list, not a person. A login, a mail, `<system>:<id>` are not full names.
 */
export function parseNameQuery(input: string): NameQuery | null {
  if (input.includes("@") || EXTERNAL_ID.test(input)) return null;
  const words = nameWords(input);
  const full = words.filter((w) => w.length > 1), initials = words.filter((w) => w.length === 1 && /\p{L}/u.test(w));
  if (!full.length || full.length + initials.length < 2 || full.length + initials.length !== words.length) return null;
  return { full, initials };
}

/** Each full word is some word of the full name as a whole, each initial is the first letter of another word; any order. */
export function nameMatches(q: NameQuery, displayName: string): boolean {
  const words = nameWords(displayName), used = new Set<number>();
  for (const f of q.full) {
    const i = words.findIndex((w, j) => !used.has(j) && w === f);
    if (i < 0) return false;
    used.add(i);
  }
  for (const c of q.initials) {
    const i = words.findIndex((w, j) => !used.has(j) && w.startsWith(c));
    if (i < 0) return false;
    used.add(i);
  }
  return true;
}

/** A login without the mail domain: "jsmith", not a full address — one word without spaces, not a full name, not a link. */
const loginLike = (input: string): boolean => !input.includes("@") && !/\s/.test(input) && !EXTERNAL_ID.test(input) && /^[\p{L}\p{N}._-]{2,64}$/u.test(input);

// ---------------------------------------------------------------- recognition
export interface PersonHit { id: string; login: string; display_name: string; department: string | null }
const LIVE = "p.instance_id = $1 AND p.active AND COALESCE(p.attrs->>'demo','') <> 'true'";
const likeEscape = (t: string): string => t.replace(/[\\%_]/g, (m) => `\\${m}`);
const candidate = (p: { display_name: string; department: string | null; login: string }): Candidate => ({ display_name: p.display_name, department: p.department ?? null, login: p.login });
const byName = (a: { display_name: string; login: string }, b: { display_name: string; login: string }): number =>
  a.display_name.localeCompare(b.display_name, "ru") || a.login.localeCompare(b.login);

async function byLogin(app: App, login: string): Promise<PersonHit | null> {
  const { rows } = await app.db.control.query(`SELECT p.id, p.login, p.display_name, p.department FROM people p WHERE ${LIVE} AND p.login = $2`, [app.instanceId, login.toLowerCase()]);
  return rows[0] ?? null;
}

async function byLocalPart(app: App, local: string): Promise<PersonHit[]> {
  const { rows } = await app.db.control.query(`SELECT p.id, p.login, p.display_name, p.department FROM people p WHERE ${LIVE} AND split_part(p.login, '@', 1) = $2 ORDER BY p.login LIMIT 20`,
    [app.instanceId, local.toLowerCase()]);
  return rows;
}

async function byIdentity(app: App, system: string, externalId: string): Promise<PersonHit | null> {
  const { rows } = await app.db.control.query(
    `SELECT p.id, p.login, p.display_name, p.department FROM person_identities i JOIN people p ON p.id = i.person_id
      WHERE ${LIVE} AND i.system = $2 AND i.external_id = $3 AND i.verified AND i.active`, [app.instanceId, system, externalId]);
  return rows[0] ?? null;
}

async function byNameQuery(app: App, q: NameQuery): Promise<PersonHit[]> {
  const params: unknown[] = [app.instanceId];
  const words = q.full.map((w) => { params.push(likeEscape(w)); return `translate(lower(p.display_name), 'ё', 'е') LIKE '%' || $${params.length} || '%' ESCAPE '\\'`; }).join(" AND ");
  const { rows } = await app.db.control.query(`SELECT p.id, p.login, p.display_name, p.department FROM people p WHERE ${LIVE} AND ${words} LIMIT 500`, params);
  return (rows as PersonHit[]).filter((p) => nameMatches(q, p.display_name)).sort(byName);
}

/** How many memory people are viewed at once for all names of a meeting (manyInMemory): at the limit no full name is unique. */
export const IN_MEMORY_BATCH_LIMIT = 2000;

/**
 * Memory people by the names from a meeting's transcript and decisions ("they spoke but do not see
 * the meeting"): only unambiguous, without the directory — the whole mail by login, a full name among memory people as
 * at intake. One word ("Anna"), a link, several matches or no one — null: the hint to the organizer does not guess.
 * At once for the whole list: mails — in one query, full names — in one (the name conditions joined by OR, the comparison
 * nameMatches — here); if the full name output hits IN_MEMORY_BATCH_LIMIT, all full names are null (no proof of uniqueness).
 * The answer key is the input as is.
 */
export async function manyInMemory(app: App, inputs: string[]): Promise<Map<string, PersonHit | null>> {
  const out = new Map<string, PersonHit | null>();
  const mails = new Map<string, string>(), names: Array<[string, NameQuery]> = [];
  for (const input of inputs) {
    out.set(input, null);
    const s = input.replace(/\s+/g, " ").trim();
    if (!s || s.length > 200) continue;
    if (s.includes("@")) { if (/^[^\s@]+@[^\s@]+$/.test(s)) mails.set(input, s.toLowerCase()); continue; }
    const q = parseNameQuery(s);
    if (q) names.push([input, q]);
  }
  if (mails.size) {
    const { rows } = await app.db.control.query(`SELECT p.id, p.login, p.display_name, p.department FROM people p WHERE ${LIVE} AND p.login = ANY($2::text[])`,
                                                [app.instanceId, [...new Set(mails.values())]]);
    for (const [input, login] of mails) out.set(input, (rows as PersonHit[]).find((p) => p.login === login) ?? null);
  }
  if (names.length) {
    const params: unknown[] = [app.instanceId];
    const like = (w: string) => { params.push(likeEscape(w)); return `translate(lower(p.display_name), 'ё', 'е') LIKE '%' || $${params.length} || '%' ESCAPE '\\'`; };
    const any = names.map(([, q]) => `(${q.full.map(like).join(" AND ")})`).join(" OR ");
    params.push(IN_MEMORY_BATCH_LIMIT);
    const { rows } = await app.db.control.query(`SELECT p.id, p.login, p.display_name, p.department FROM people p WHERE ${LIVE} AND (${any}) LIMIT $${params.length}`, params);
    if (rows.length >= IN_MEMORY_BATCH_LIMIT) log.warn("in_memory_batch_truncated", { names: names.length });
    else for (const [input, q] of names) {
      const ps = (rows as PersonHit[]).filter((p) => nameMatches(q, p.display_name));
      out.set(input, ps.length === 1 ? ps[0]! : null);
    }
  }
  return out;
}

/** One memory person by name — manyInMemory of one input. */
export async function oneInMemory(app: App, input: string): Promise<PersonHit | null> {
  return (await manyInMemory(app, [input])).get(input) ?? null;
}

/**
 * Recognize participants. Each input gets its own status in the same order; ambiguous ones in a separate list (intake
 * refuses them as a whole). The directory is asked about those not in memory and about namesakes of a single full name or
 * short login match — at most DIRECTORY_LOOKUPS_MAX times per meeting.
 * `pending` — those waiting for this meeting's first sign-in (a people edit in the workplace): named again by the same login, no
 * a card — "in AD" without a directory search (it was already found there at intake).
 */
export async function resolveParticipants(app: App, inputs: string[], o: { pending?: unknown } = {}): Promise<Resolution> {
  const out: Resolution = { items: [], ambiguous: [], warnings: [], directory: { lookups: 0, found: 0, cached: true, error: null, off: false } };
  let capped = false;
  // the workplace sends the whole people list, with those waiting for a first sign-in; a search for each ate the 20-search limit
  // (the last added one hit the limit and was "not found"), and a directory failure marked them unverified
  const waiting = new Map<string, PendingParticipant>((Array.isArray(o.pending) ? o.pending as PendingParticipant[] : [])
    .filter((x) => typeof x?.login === "string" && x.login.includes("@")).map((x) => [x.login.toLowerCase(), x]));
  // the directory was not asked — "not found" marked undetermined; a directory that is off warns the same way as a failed one:
  // the organizer sees "directory unavailable", not "not found", and the meeting's waiting ones are not lost
  const unasked = (input: string): void => void out.items.push({ input, status: "not_found", undetermined: true });
  const directoryOff = (): void => { out.directory.off = true; if (!out.warnings.includes("directory_unavailable")) out.warnings.push("directory_unavailable"); };

  // exact — named by a full mail: an exact match is unique even in an incomplete directory output. The directory was not
  // asked (off, failed, the search limit) — "not found" marked undetermined, with the warning directory_unavailable:
  // a directory that is off could have marked itself earlier at namesakes without a warning — here it is needed
  const fromDirectory = async (input: string, tokens: string[], match: (h: DirectoryHit) => boolean, exact = false): Promise<void> => {
    if (out.directory.off) { directoryOff(); return unasked(input); }
    if (out.directory.lookups >= DIRECTORY_LOOKUPS_MAX) { capped = true; return unasked(input); }
    let found: Awaited<ReturnType<typeof lookupDirectory>>;
    try { found = await lookupDirectory(app, tokens, DIRECTORY_LIMIT); }
    catch (e) { out.directory.error = ldapErrorCode(e); directoryOff(); return unasked(input); }
    if (!found) { directoryOff(); return unasked(input); }
    out.directory.lookups++; out.directory.cached &&= found.cached;
    const hits = found.items.filter(match);
    // a directory person whose card is already in memory: a live one is recognized; an inactive or demo one is not found
    const known = hits.length ? (await app.db.control.query(
      "SELECT p.id, p.login, p.display_name, p.department, p.active AND COALESCE(p.attrs->>'demo','') <> 'true' AS live FROM people p WHERE p.instance_id = $1 AND p.login = ANY($2::text[])",
      [app.instanceId, hits.map((h) => h.login)])).rows : [];
    const card = new Map<string, { id: string; login: string; display_name: string; department: string | null; live: boolean }>(known.map((k) => [k.login, k]));
    const usable = hits.filter((h) => card.get(h.login)?.live !== false).sort(byName);
    out.directory.found += usable.length;
    if (!usable.length) return void out.items.push({ input, status: "not_found" });
    // the directory did not return all (found.truncated): a single match in an incomplete output is not "the" person; the real
    // one could be past the output limit — ambiguous with this candidate and truncated: intake will ask for the mail
    if (usable.length > 1 || (found.truncated && !exact))
      return void out.ambiguous.push({ input, candidates: usable.slice(0, CANDIDATES_MAX).map(candidate), truncated: usable.length > CANDIDATES_MAX || found.truncated });
    const h = usable[0]!, c = card.get(h.login);
    if (c) return void out.items.push({ input, status: "resolved", login: c.login, display_name: c.display_name, department: c.department, matched_by: "directory", personId: c.id });
    out.items.push({ input, status: "in_directory", login: h.login, display_name: h.display_name, department: h.department ?? null, matched_by: "directory" });
  };

  const one = (input: string, p: PersonHit, by: MatchedBy): void =>
    void out.items.push({ input, status: "resolved", login: p.login, display_name: p.display_name, department: p.department, matched_by: by, personId: p.id });
  const many = (input: string, ps: PersonHit[]): void =>
    void out.ambiguous.push({ input, candidates: ps.slice(0, CANDIDATES_MAX).map(candidate), truncated: ps.length > CANDIDATES_MAX });

  // namesakes in the directory: by full name or a short login in memory
  // exactly one person matched — the directory is asked anyway. A namesake who has not signed in yet (or an incomplete directory
  // output) makes the participant ambiguous: candidates are the memory person and namesakes, intake asks for the mail, not giving
  // a closed meeting to an outsider. The directory off (no warning) or unavailable (directory_unavailable) — the memory person
  // is accepted as before: meeting loading does not stop (only in this case).
  // The meeting used DIRECTORY_LOOKUPS_MAX searches — namesakes cannot be checked, and it is not "directory unavailable": the
  // participant is ambiguous with the memory person and truncated, intake asks for the mail (before, it was accepted silently)
  const withNamesakes = async (input: string, p: PersonHit, by: MatchedBy, tokens: string[], match: (h: DirectoryHit) => boolean): Promise<void> => {
    if (out.directory.off) return one(input, p, by);
    if (out.directory.lookups >= DIRECTORY_LOOKUPS_MAX) { capped = true; return void out.ambiguous.push({ input, candidates: [candidate(p)], truncated: true }); }
    let found: Awaited<ReturnType<typeof lookupDirectory>>;
    try { found = await lookupDirectory(app, tokens, DIRECTORY_LIMIT); }
    catch (e) { out.directory.error = ldapErrorCode(e); directoryOff(); return one(input, p, by); }
    // a directory that is off: the memory person is accepted without a warning; the next one who has to be looked up in
    // the directory gets undetermined and a warning (fromDirectory)
    if (!found) { out.directory.off = true; return one(input, p, by); }
    out.directory.lookups++; out.directory.cached &&= found.cached;
    const hits = found.items.filter((h) => match(h) && h.login !== p.login.toLowerCase());
    // a namesake with an inactive card or a demo persona is not found — as in fromDirectory
    const dead = new Set<string>(hits.length ? (await app.db.control.query(
      "SELECT p.login FROM people p WHERE p.instance_id = $1 AND p.login = ANY($2::text[]) AND NOT (p.active AND COALESCE(p.attrs->>'demo','') <> 'true')",
      [app.instanceId, hits.map((h) => h.login)])).rows.map((x) => x.login as string) : []);
    const twins = hits.filter((h) => !dead.has(h.login));
    out.directory.found += twins.length;
    if (!twins.length && !found.truncated) return one(input, p, by);
    const all = [p, ...twins].sort(byName);
    out.ambiguous.push({ input, candidates: all.slice(0, CANDIDATES_MAX).map(candidate), truncated: all.length > CANDIDATES_MAX || found.truncated });
  };

  for (const input of inputs) {
    if (input.includes("@")) {                                               // the login is a mail
      const p = await byLogin(app, input);
      if (p) { one(input, p, "login"); continue; }
      const mail = input.toLowerCase(), w = waiting.get(mail);
      // waits for the first sign-in and there is no card at all (an inactive or demo one is not found, as through the directory)
      if (w && !(await app.db.control.query("SELECT 1 FROM people WHERE instance_id = $1 AND login = $2", [app.instanceId, mail])).rows.length) {
        out.items.push({ input, status: "in_directory", login: mail, ...(w.display_name ? { display_name: w.display_name } : {}), department: null, matched_by: "directory" });
        continue;
      }
      await fromDirectory(input, [mail], (h) => h.login === mail, true);
      continue;
    }
    const ext = EXTERNAL_ID.exec(input);
    if (ext) {                                                               // an account link
      const p = await byIdentity(app, ext[1]!, ext[2]!);
      if (p) one(input, p, "identity"); else out.items.push({ input, status: "not_found" });
      continue;
    }
    const q = parseNameQuery(input);
    if (q) {                                                                 // a full name
      const ps = await byNameQuery(app, q);
      if (ps.length === 1) { await withNamesakes(input, ps[0]!, "name", q.full, (h) => nameMatches(q, h.display_name)); continue; }
      if (ps.length > 1) { many(input, ps); continue; }
      await fromDirectory(input, q.full, (h) => nameMatches(q, h.display_name));
      continue;
    }
    if (loginLike(input)) {                                                  // a login without a domain
      const ps = await byLocalPart(app, input);
      const local = input.toLowerCase();
      // the same short login in another mail domain of the group — a namesake: the directory checks it too
      if (ps.length === 1) { await withNamesakes(input, ps[0]!, "login", [local], (h) => h.login.split("@")[0] === local); continue; }
      if (ps.length > 1) { many(input, ps); continue; }
      await fromDirectory(input, [local], (h) => h.login.split("@")[0] === local);
      continue;
    }
    out.items.push({ input, status: "not_found" });
  }
  if (capped) out.warnings.push("directory_lookups_capped");
  return out;
}

/**
 * An intake refusal for ambiguous participants: the agent asks the person and sends the login (mail). The directory output
 * is incomplete or namesakes went unchecked (truncated) — there could be more candidates than shown: "from the candidate list"
 * would confuse when there is one candidate — the message asks the person for the mail.
 */
export function ambiguousError(amb: AmbiguousParticipant[]): Error {
  const names = amb.map((a) => `«${a.input}»`).join(", ");
  const more = amb.some((a) => a.truncated);
  return invalid(more
    ? `The meeting participants could not be identified uniquely (${names}). Others in the company directory may have the same name as the people shown. Ask the person for the participant’s e-mail address and send it`
    : `The meeting participants could not be identified uniquely (${names}). Ask the person and send the login (e-mail address) from the candidate list`,
                 { participants_ambiguous: amb });
}

/** The intake answer: the status of each participant without internal ids and marks. */
export const publicParticipant = ({ personId: _, undetermined: _u, ...p }: ParticipantResult): Omit<ParticipantResult, "personId" | "undetermined"> => p;

// ---------------------------------------------------------------- deferred access
export interface PendingParticipant { login: string; display_name: string | null; input: string }

/**
 * Meeting participation is a separate role of the transcript links: `participant` for people of
 * the meeting's people list (attrs.participants), not of the access list (record_people: organizer, readers). A person's page
 * shows such meetings in its own folder /people/<login>/meetings. The link is removed when the person is taken off the list.
 */
export async function syncParticipantLinks(q: Pick<pg.PoolClient, "query">, rootId: string, personIds: string[]): Promise<void> {
  await q.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'participant' AND entity_id <> ALL($2::uuid[])", [rootId, personIds]);
  if (personIds.length) await q.query(
    "INSERT INTO record_entities (record_id, entity_id, role, method, confidence) SELECT $1, p, 'participant', 'stated_by_human', 1.0 FROM unnest($2::uuid[]) p ON CONFLICT DO NOTHING",
    [rootId, personIds]);
}

/** The person's registry row (entities.id = people.id) — lazily, as resolveEntities: through it memory_read shows the link. */
export async function personEntities(app: App, personIds: string[]): Promise<void> {
  if (!personIds.length) return;
  await app.db.control.query(
    `INSERT INTO entities (id, kind, external_system, external_id, display_name, instance_id)
     SELECT id, 'person', 'people', login, display_name, instance_id FROM people WHERE id = ANY($1::uuid[]) ON CONFLICT DO NOTHING`, [personIds])
    .catch((e: Error) => log.warn("person_entity_failed", { error: e.message.slice(0, 160) }));
}

/**
 * A card appeared — deferred access to meetings. For each meeting where the login waits in attrs.participants_pending:
 * the person is added to the people of the meeting and all its derivatives (the parent_id tree), the login moves from waiting to
 * the participants, the access list version grows; a journal event `write` (op meeting_participant_joined) — for each meeting.
 * Idempotent: a given login leaves the waiting ones, a repeat does nothing — so it is called at every sign-in,
 * not only when the card is created. A failure does not break the calling action (an upload, a sign-in) and does not hinder
 * other meetings: each in its own transaction, a failure goes to the log, the login of that meeting waits for the next time.
 */
export async function grantPendingMeetings(app: App, people: Array<{ id: string; login: string }>, via: string, caller: Caller | null): Promise<number> {
  const idOf = new Map(people.map((p) => [p.login.toLowerCase(), p.id]));
  if (!idOf.size) return 0;
  let granted = 0;
  for (const cls of ["open", "closed"] as const) {
    let db: ReturnType<App["db"]["recordsForWrite"]>, roots: string[];
    try {
      db = app.db.recordsForWrite(cls, "T0");
      roots = (await db.query(
        `SELECT id FROM records WHERE source_kind = 'transcriber' AND deleted_at IS NULL AND jsonb_typeof(attrs->'participants_pending') = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(attrs->'participants_pending') e WHERE lower(e->>'login') = ANY($1::text[])) ORDER BY id`, [[...idOf.keys()]])).rows.map((r) => r.id as string);
    } catch (e) {
      log.warn("meeting_pending_grant_failed", { class: cls, via, error: (e as Error).message.slice(0, 200) });
      continue;
    }
    for (const root of roots) {
      try {
        const done = await tx(db, async (q) => {
          const rec = (await q.query("SELECT attrs FROM records WHERE id = $1 FOR UPDATE", [root])).rows[0];
          const pending: PendingParticipant[] = Array.isArray(rec?.attrs?.participants_pending) ? rec.attrs.participants_pending : [];
          const joined = pending.filter((x) => idOf.has(String(x.login).toLowerCase()));
          if (!joined.length) return null;
          const ids = [...new Set(joined.map((x) => idOf.get(String(x.login).toLowerCase())!))];
          const tree = (await q.query("WITH RECURSIVE t AS (SELECT id FROM records WHERE id = $1 UNION ALL SELECT r.id FROM records r JOIN t ON r.parent_id = t.id) SELECT id FROM t", [root])).rows.map((x) => x.id as string);
          // a meeting in an archived project or team: the readers only narrow —
          // the login waits on, access will come after the return from the archive (with the next upload or sign-in)
          const homes = (await q.query("SELECT DISTINCT space_id FROM records WHERE id = ANY($1::uuid[])", [tree])).rows.map((x) => x.space_id as string);
          if ((await archivedTeamSpaces(app.db.control, homes)).size) return "archived" as const;
          await q.query("INSERT INTO record_people (record_id, person_id) SELECT t, p FROM unnest($1::uuid[]) t CROSS JOIN unnest($2::uuid[]) p ON CONFLICT DO NOTHING", [tree, ids]);
          await q.query(
            "UPDATE records SET attrs = jsonb_set(jsonb_set(attrs, '{access,acl_version}', to_jsonb(COALESCE((attrs #>> '{access,acl_version}')::int, 1) + 1)), '{access,acl_checked_at}', to_jsonb(now())) WHERE id = ANY($1::uuid[])", [tree]);
          const joinedLogins = joined.map((x) => String(x.login).toLowerCase());
          const participants = [...new Set([...(Array.isArray(rec.attrs.participants) ? rec.attrs.participants : []), ...joinedLogins])];
          await q.query("UPDATE records SET attrs = attrs || jsonb_build_object('participants', $2::jsonb, 'participants_pending', $3::jsonb) WHERE id = $1",
                        [root, JSON.stringify(participants), JSON.stringify(pending.filter((x) => !joinedLogins.includes(String(x.login).toLowerCase())))]);
          // the one who signed in is a meeting participant and in the links; other participants are not touched
          await q.query("INSERT INTO record_entities (record_id, entity_id, role, method, confidence) SELECT $1, p, 'participant', 'stated_by_human', 1.0 FROM unnest($2::uuid[]) p ON CONFLICT DO NOTHING",
                        [root, ids]);
          return { tree, ids };
        });
        if (!done) continue;
        if (done === "archived") { log.info("meeting_pending_grant_archived", { class: cls, via }); continue; }
        await personEntities(app, done.ids);
        granted++;
        await audit(app, caller, { event_type: "write", class: cls, record_ids: done.tree, details: { op: "meeting_participant_joined", via, people: done.ids } });
      } catch (e) {
        log.warn("meeting_pending_grant_failed", { class: cls, via, record: root, error: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return granted;
}
