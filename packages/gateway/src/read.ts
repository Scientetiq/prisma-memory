// memory_read: the whole record up to the token limit, then the table of contents and ranges (pages, time, section, anchor).
import { openByWordCaller } from "./owner.ts";
import { estimateTokens, foreignHiddenText, invalid, MemoryError, notFound, openCheckAdvice, openCheckWhy, parseOpenCheckFallback, parsePath, recordPath, showAnywayPath } from "@memory/shared";
import { buildToc, originOf, readPart, readText, type McpTexts, type Range, type ReadPart, type ReadView } from "@memory/mcp-core";
import { textsOf } from "./mcp-texts.ts";
import type { App, Caller } from "./context.ts";
import { loadReadable, resolveSpace, spaceArchived, type RecordRow, type SpaceAccess } from "./access.ts";
import { derivedVisible } from "./visibility.ts";
import { publicConsent } from "./meetings.ts";
import { confidenceOf, conversionView, entityReadable, ownHiddenRecord, ownOpenAccepted, ownOpenCheck, stagesOf, type StageView } from "./records.ts";
import { extendedWriteView } from "./extended-open.ts";
import { signedOriginalUrl } from "./originals.ts";
import { audit, auditRead, auditShownClosed, type AuditEvent } from "./audit.ts";
import { derivationFor, derivationLine, derivationOut, DERIVATION_SOURCES_OP } from "./derivation.ts";
import { workplaceUrl } from "./workplace.ts";
import { searchLink } from "./search-link.ts";
import { confirmedOf, dropHeldDerived, orgSpace, orgUnitsOf, reviewView } from "./org-hold.ts";
import { correctionLine, correctionMeta, correctionPeople } from "./corrections.ts";
import { entityRefOf, formatOfMime, isProfilePath, orgReviewEnabled, type DataClass } from "@memory/shared";
import { profileReadNote, profileRecordForPath } from "./profile.ts";

// table of contents, ranges, continued reading and the answer text — pure logic in @memory/mcp-core (shared with the edge;
// unit tests without a database)
export { buildToc, headingOf, sliceRange, type Range, type TocEntry } from "@memory/mcp-core";

export async function resolveRecordId(app: App, caller: Caller, a: { id?: string; path?: string }, spaces?: Map<string, SpaceAccess>): Promise<{ id: string; slug?: string; type?: string }> {
  if (a.id) return { id: a.id };
  if (!a.path) throw invalid("Give an id or a path");
  // /me/profile — the current version of one's own profile: off, no profile, or a service "on behalf of" — not_found
  if (isProfilePath(a.path)) return { id: await profileRecordForPath(app, caller, spaces) };
  let path = a.path;
  for (const alias of ["me", "org"]) if (path === `/${alias}` || path.startsWith(`/${alias}/`)) {
    const s = await resolveSpace(app, caller, alias, spaces);
    if (!s) throw notFound();
    path = `/spaces/${s.slug}${path.slice(alias.length + 1)}`;
  }
  const p = parsePath(path);
  if (!p || p.kind !== "record") throw notFound();
  return { id: p.id, slug: p.slug, type: p.type };
}

/**
 * A line for the agent about document conversion: metadata.conversion has the state, but the answer text did not —
 * an agent reading an unconverted document as plain text (resources/read, memory_read) got empty content and could
 * tell the person the document is empty. The reason — in plain words for an employee, without converter codes; the advice — what
 * to do. Empty — the document is converted and has text (or there was no converter: markdown, text).
 */
const CONVERSION_FAILED_WHY: Record<string, [why: string, advice: string]> = {
  converter_no_text: ["no text was found in the file. It appears to be a scan or photos of pages", "upload a PDF with text you can select and copy"],
  converter_too_large: ["the file exceeds the document converter’s size limit", "split the file into parts and upload them"],
  converter_rejected: ["the converter refused to process the file", "upload it in another format, such as PDF"],
  converter_run_gone: ["the conversion job was lost", "upload the file again"],
  open_check_fallback_failed: ["move to closed access after the check failed", "the memory administrator can retry the move"],
  // conversion queue, step 1: final refusals by the converter code
  converter_encrypted: ["the file is password-protected", "ask the author to remove the password and upload the file again"],
  converter_malformed: ["the file is damaged", "ask the author to save a new copy and upload it again"],
  converter_unsupported: ["the converter does not support this format", "upload the file in another format, such as PDF"],
  converter_gave_up: ["the converter could not process the document", "ask the author to upload the file in another format or contact the memory administrator"],
  original_changed: ["the file in storage changed", "upload it again"],
  original_missing: ["the original file was not saved", "upload the file again"],
};
/**
 * A failure after which a retry may help (the conversion queue): the converter failed, the run was stopped, gave no
 * result, the wrong answer. No text yet; to process again — the author's "Process now" (memory_process_now — only at
 * the person's request) or the administrator's "Retry".
 */
const CONVERSION_RETRY_WHY: Record<string, string> = {
  converter_fail_retryable: "the converter could not process the file", converter_cancelled: "processing was stopped by the converter",
  converter_stuck: "the converter did not start processing the document", converter_deadline: "the converter missed the deadline",
  converter_doc_error: "the converter is not returning results for this document", converter_result_missing: "the converter did not return the completed result",
  converter_copies_limit: "the converter repeatedly lost the upload", converter_unexpected: "the converter returned an unexpected response",
  converter_http: "the converter returned an error", converter_network: "the converter did not respond", converter_patience: "the converter took too long to respond",
};
/**
 * A no-findings refusal of the "can it open to agents" check — by why the text was not checked (attrs.conversion.unchecked,
 * written by convert.ts): a scan without text is not fixed by uploading again — a file with text is needed; out of time or
 * busy — later; did not run — later too. Otherwise — the common advice.
 */
const OPEN_CHECK_UNCHECKED_WHY: Record<string, [why: string, advice: string]> = {
  empty_text: ["no text was found in the file. It appears to be a scan or photos of pages and cannot be checked", "upload a PDF with text you can select and copy, or upload the file to a closed team space"],
  timeout: ["the open check timed out", "upload the file again later or upload it to a closed team space"],
  busy: ["the open check timed out", "upload the file again later or upload it to a closed team space"],
  check_failed: ["the open check failed", "upload the file again later or upload it to a closed team space"],
  original_too_large: ["the file is too large to check in full", "upload it to a closed team space"],
};
/** "1 document", "3 documents", "5 documents". */
const documentsWord = (n: number): string => (n === 1 ? "document" : "documents");
/** An office document (not PDF and not text) — the "PDF whose text can be selected" advice does not fit it. */
const officeOriginal = (mime: string | null | undefined): boolean => { const f = formatOfMime(mime); return f !== null && f !== "pdf" && f !== "csv"; };
const textAdvice = (mime: string | null | undefined, advice: string): string =>
  officeOriginal(mime) ? advice.replace(/\b([Uu])pload a PDF with text you can select and copy/u, "$1pload a file that contains text, not only images") : advice;

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * `o.stages` — the record's stages (queue position); `o.mime` — the original's type (an office document gets advice without
 * "PDF"); `o.fileHidden` — the file is not given to this key (`original.url` empty): with `agent_file: false` — a "file only
 * for people", so that an agent reading text does not promise the person a file.
 */
export function conversionNote(attrs: Record<string, any> | null | undefined, hasText: boolean,
                               o: { stages?: readonly Pick<StageView, "stage" | "status" | "last_error">[] | null; mime?: string | null; fileHidden?: boolean; cls?: DataClass | null } = {}): string {
  const c = conversionView(attrs, o.stages, o.cls);
  if (!c) return "";
  if (c.status === "pending") {
    // the phase in plain words: no "being recognized" and no times — the converter state does not tell them apart
    const pos = typeof c.position === "number" ? c.position : null;
    const detail = c.phase === "at_converter" ? "the document converter has it"
      : c.phase === "uploading" ? "it is being sent to the document converter"
      : c.phase === "retry_later" ? "the converter will try processing it again shortly"
      : pos === 0 ? "it is next in the document converter’s queue"
      : pos !== null ? `it is in the document converter’s queue with ${pos} ${documentsWord(pos)} ahead of it` : "";
    return detail ? `The document is still being processed, so no text is available yet: ${detail}. Read it later. There’s no need to upload it again.`
      : "The document is still being processed, so no text is available yet. Read it later.";
  }
  if (c.status === "done") {
    if (attrs?.conversion?.extraction_state === "unavailable" && !hasText)
      return `No text was found in the document. It appears to be a scan or photos of pages, so searching for words in the document won’t find it. ${officeOriginal(o.mime) ? "Upload a file that contains text as well as any images." : "Upload a PDF with text you can select and copy."}`;
    // the text is accepted, but the file itself is not given to agents: images, comments and PDF attachments, an office file
    return c.agent_file === false && o.fileHidden && hasText ? "The document text passed the check and is available to agents. The file itself is available only to people in the workspace." : "";
  }
  const kind = String(c.error_kind ?? "");
  if (CONVERSION_RETRY_WHY[kind])
    return `The document could not be processed yet (${CONVERSION_RETRY_WHY[kind]}). No text is available. The author can process it again with “Process now” (use memory_process_now only at the author’s request), or the memory administrator can.`;
  const unchecked = attrs?.conversion?.unchecked;
  const [why, advice] = kind === "open_check"
    ? unchecked
      ? OPEN_CHECK_UNCHECKED_WHY[String(unchecked)] ?? ["the open check did not complete", "upload the file again later or upload it to a closed team space"]
      : ["the text contains content that cannot be shown to agents", "upload the document to a closed team space"]
    : CONVERSION_FAILED_WHY[kind] ?? (kind.startsWith("converter_") ? ["the document converter did not respond or is unavailable", "upload the file again later"] : ["", "upload the file again"]);
  return `The document could not be processed${why ? ` (${why})` : ""}, so no text will be available. ${capitalize(textAdvice(o.mime, advice))}.`;
}

/**
 * Fallback of limits.read_default_tokens when the installation has no row: 8,000 estimated tokens, the seed value of
 * a fresh installation. An installation that existed keeps its stored row (24,000 before 0.27.0).
 */
export const READ_DEFAULT_TOKENS_FALLBACK = 8000;
/**
 * The budget of one memory_read in estimated tokens: `max_tokens` of the call, else the instance setting
 * limits.read_default_tokens; held to limits.read_max_tokens and at least 1. Since 0.27.0 the input schema gives max_tokens
 * no default, so over MCP the setting applies (before, the validator filled in 24,000 and the setting never did). The setting
 * is at least 1,000, the schema minimum of max_tokens: a value stored before its range check (0, 0.5) would otherwise give
 * reads of one character.
 */
export function readMaxTokens(app: App, maxTokens: number | undefined): number {
  const own = maxTokens ?? Math.max(1000, app.settings.get("limits.read_default_tokens", READ_DEFAULT_TOKENS_FALLBACK));
  return Math.min(app.settings.get("limits.read_max_tokens", 64000), Math.max(1, own));
}

/** `search_id` — from a memory_search answer, if its finding or its continuation is read: only for the log, not the answer. */
// `texts` — the words of this answer, read once: the MCP server passes the catalogue it took with the
// tool texts, so a change of locale.mcp_language during the call cannot give one answer in two languages
// `include` is read by the MCP shaping of the structured answer (mcp-shape.ts), not here: this function returns every
// field to REST, the workplace and MCP alike
export async function readRecord(app: App, caller: Caller, a: { id?: string; path?: string; range?: Range; max_tokens?: number; search_id?: string; include?: readonly string[] },
                                 texts: McpTexts = textsOf(app)) {
  const maxTokens = readMaxTokens(app, a.max_tokens);
  const target = await resolveRecordId(app, caller, a);
  // one's own closed record by a key without the closed class: a locator instead of "no record".
  // Checked before the control database locator read; for one's own closed record the stages come from the closed database
  // (see ownHiddenRecord). For all other cases it returns null and the path is the usual one.
  const hidden = await ownHiddenRecord(app, caller, target.id);
  if (hidden) {
    if (target.slug && (target.slug !== hidden.space || target.type !== hidden.type)) throw notFound();
    await audit(app, caller, { event_type: "list", class: "closed", record_ids: [hidden.id], details: { op: "hidden_locator", tool: "memory_read" } });
    // closed by the open check (personal open): the reason without the match, and advice. One that opens by word
    // (`open_check.by_word`) — a question to the person "show it to agents?" and memory_open on their explicit answer;
    // a secret, NDA, own rule — "remove and write again". No "open in the workplace" link: its button would refuse on that finding
    // outside own personal (`foreign` view): no reasons or positions — only that it is hidden and only the author can show it
    // in the workplace, with a link to the "Make available to agents" panel
    if (hidden.open_check && !hidden.open_check.kinds) {
      const url = workplaceUrl(app, showAnywayPath(hidden.id));
      return { result: { ...hidden, ...(url ? { workplace_url: url } : {}) }, text: foreignHiddenText(hidden.path, hidden.open_check.at, { id: hidden.id, url }) };
    }
    if (hidden.open_check) {
      const mark = parseOpenCheckFallback(hidden.open_check)!;
      return { result: hidden,
               text: `${hidden.path} · closed by the open check ${hidden.open_check.at?.slice(0, 10) ?? ""}: ${openCheckWhy(mark)}. The title and the text are not given to this key, and agents do not see it. ${openCheckAdvice(mark, { tool: openByWordCaller(caller), byWord: hidden.open_check.by_word })}. To delete it: memory_delete.` };
    }
    // only a person in the workplace can show it to agents ("Show to agents"): the agent gets a link for the person
    const url = workplaceUrl(app, `/records/${hidden.id}`);
    return { result: { ...hidden, ...(url ? { workplace_url: url } : {}) },
             text: `${hidden.path} · people only: the title and the text are not given to this key. Only a person in the workspace can show the record to agents: ${url ?? "the “My records” section"}. To delete it: memory_delete.` };
  }
  // the search link: after the hidden-record check (a locator has none) and alongside the record load; it does not throw
  // and waits for the log no longer than its own timeout — the answer does not depend on it
  const link = searchLink(app, caller, a.search_id, target.id);
  const { rec, db, spaces } = await loadReadable(app, caller, target.id);
  const slug = spaces.get(rec.space_id)?.slug ?? (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [rec.space_id])).rows[0]?.slug ?? "unknown";
  if (target.slug && (target.slug !== slug || target.type !== rec.type)) throw notFound();   // the path must match the record: otherwise it is id enumeration

  const content = (await db.query("SELECT text, original_key, original_mime, original_bytes, pages, duration_sec FROM record_content WHERE record_id = $1", [rec.id])).rows[0];
  const full: string = content?.text ?? "";
  // the read event of this record: both for the answer and for a refusal with paths of same-named sections
  const readEvent = async (extra: Record<string, unknown> = {}): Promise<AuditEvent> => ({
    event_type: caller.keyKind === "extended" && rec.class === "closed" ? "extended_key_use" : "read",   // vis-ok: the log by key kind
    class: rec.class, record_ids: [rec.id], space_id: rec.space_id, details: { tool: "memory_read", ranged: Boolean(a.range), ...extra, ...(await link) } });
  // the part up to the limit and the exact continuation: next_range — the same range and the offset right after the given part
  let part: ReadPart;
  try {
    part = readPart(full, rec.type, a.range, maxTokens, texts, "estimated");
  } catch (e) {
    // same-named sections: the error holds heading paths (up to 20), that is, record text. Closed is not given out without a read
    // record (audit.ts, auditRead): the op section_candidates event goes before the answer, a log failure is an internal error
    // without paths. Other range refusals (no page, a bad offset) do not reveal the record — as before
    if (e instanceof MemoryError && Array.isArray((e.extra.details as { candidates?: unknown } | undefined)?.candidates))
      await auditRead(app, caller, await readEvent({ op: "section_candidates" }));
    throw e;
  }
  const body = part.content, truncated = part.truncated, nextRange: Range | null = part.next_range;

  const [ents, ppl, stages, derived, basis] = await Promise.all([
    db.query("SELECT entity_id, role FROM record_entities WHERE record_id = $1 ORDER BY (role = 'space'), role", [rec.id]),
    db.query("SELECT person_id FROM record_people WHERE record_id = $1", [rec.id]),
    stagesOf(db, rec.id),
    // names of derived records — only those readable by id and not held "Wrong" in org (to an agent not of the author)
    derivedVisible(db, caller, rec, spaces).then((d) => dropHeldDerived(app, caller, rec, d)),
    // "Based on": an agent's retelling — the kind and sources the reader sees itself (at most 5, no count of hidden ones)
    derivationFor(app, caller, [{ id: rec.id, cls: rec.class, attrs: rec.attrs }], { spaces }).then((m) => m.get(rec.id) ?? null),
  ]);
  const entityRows: any[] = [];
  if (ents.rowCount) for (const e of (await app.db.control.query("SELECT id, kind, external_system, external_id, display_name, attrs FROM entities WHERE id = ANY($1)", [ents.rows.map((e) => e.entity_id)])).rows)
    if (await entityReadable(app, caller, e, { archived: "read" })) entityRows.push(e);
  // who corrected and confirmed (attrs.correction) — by the same query as the owner and the record's people
  const peopleRows = (await app.db.control.query("SELECT id, login FROM people WHERE id = ANY($1)", [[rec.owner_id, ...ppl.rows.map((p) => p.person_id), ...correctionPeople(rec.attrs)]])).rows;
  const login = new Map<string, string>(peopleRows.map((p) => [p.id, p.login]));
  // a corrected record: owner — the owner of the source record, the corrector — in correction (role and login)
  const correction = correctionMeta(rec.attrs, (id) => login.get(id));
  const openCheck = await ownOpenCheck(app, caller, rec);
  const openAccepted = await ownOpenAccepted(app, caller, rec, openCheck);
  // the record's home is in an archive: reading is allowed, writing, moving, opening — not; the agent tells the person
  const archived = await spaceArchived(app, rec.space_id, spaces);
  // "Company common knowledge": "confirmed" — by the review row; the header line — without the source
  // space ("will return to the author"); a held one is read by id only by the author and people in the workplace
  const org = await orgSpace(app);
  const unit = org && rec.space_id === org.id ? (await orgUnitsOf(app.db.control, db, [rec.id])).get(rec.id) : undefined;
  const review = unit && (orgReviewEnabled(app.settings) || unit.held_at) ? unit : undefined;
  const reviewLine = ((): string => {
    const v = reviewView(review);
    if (v === "disputed") return "\nMarked “Wrong, not for everyone”. AI agents cannot find this record until a “Company knowledge” curator makes a decision.";
    if (v === "unreviewed") return `\nPending approval by “Company knowledge” curators${review!.return_after ? `: the record will return to its author if it is not approved by ${new Date(review!.return_after).toISOString().slice(0, 10)}` : ""}.`;
    return "";
  })();
  const refOf = (e: any): string => entityRefOf(e);   // the form calls accept: person:, project:, ext:

  const metadata = {
    id: rec.id, path: recordPath(slug, rec.type, rec.occurred_at, rec.id), type: rec.type, event_kind: rec.event_kind, title: rec.title ?? "", summary_line: rec.summary_line,
    space: slug, class: rec.class, audience: rec.audience, owner: login.get(rec.owner_id) ?? "", source_kind: rec.source_kind, source_ref: rec.source_ref,
    parent_id: rec.parent_id, locator: rec.locator && Object.keys(rec.locator).length ? rec.locator : null, method: rec.method,
    origin: originOf(rec.method), confirmed: review ? confirmedOf(review, rec.confirmed_at) : rec.confirmed_at !== null, confidence: confidenceOf(rec),
    // "Company common knowledge" under review: the kind and the return term (only for an unheld, unconfirmed one)
    ...((): Record<string, unknown> => {
      const v = reviewView(review);
      return v ? { org_review: { state: v, return_after: v === "unreviewed" && review!.return_after ? new Date(review!.return_after).toISOString() : null } } : {};
    })(),
    occurred_at: new Date(rec.occurred_at).toISOString(), ingested_at: new Date(rec.ingested_at).toISOString(), domain_tags: rec.domain_tags ?? [],
    entities: entityRows.map((e) => ({ ref: refOf(e), display_name: e.display_name, role: ents.rows.find((x) => x.entity_id === e.id)?.role ?? "mentioned" })),
    people: ppl.rows.map((p) => login.get(p.person_id)).filter((x): x is string => Boolean(x)),
    token_count: rec.token_count ?? estimateTokens(full), version: rec.version, is_current: rec.is_current,
    ...(content?.original_key ? { original: { mime: content.original_mime, bytes: Number(content.original_bytes ?? 0), pages: content.pages ?? null, duration_sec: content.duration_sec ?? null, url: await signedOriginalUrl(app, caller, rec.id, rec.class) } } : {}),
    stages,
    // a converter document: the agent must see the text is machine-made and not certified (certified: false); since 0.17.0 —
    // the waiting phase, the queue position (by the `converted` stage) and whether the file itself is given to agents
    ...((): Record<string, unknown> => { const c = conversionView(rec.attrs, stages, rec.class); return c ? { conversion: c } : {}; })(),
    // the source outranks the owner: a record promoted into a team space whose source limited it to its own reader list
    access: { restricted_by_source: rec.attrs?.access?.restricted_by_source === true },
    // a meeting: who, when and by which channel confirmed the participants' consent; the key — only in the log
    ...(rec.type === "transcript" && rec.attrs?.consent ? { consent: publicConsent(rec.attrs.consent) } : {}),
    // closed by the open check (personal open): the reason — only to the author and only for a closed one;
    // the workplace shows it on the record page. The source is the locator, as for the hidden view, the list and process_now: its
    // mark is reset by a move into open, and attrs are only history (open → close does not bring the reason back)
    ...(openCheck ? { open_check: openCheck } : {}),
    // the record was already opened by word and closed: no mark, the agent will not open it again — the workplace
    // shows the author "Make available to agents" (the panel with a new consent in any area)
    ...(openAccepted ? { open_check_accepted: openAccepted } : {}),
    ...(archived ? { space_archived: true as const } : {}),
    // written by an agent with extended access by the administrator's permission: what and when, the key — in the log
    ...((): Record<string, unknown> => { const x = extendedWriteView(rec.attrs); return x ? { extended_write: x } : {}; })(),
    ...(correction ? { correction } : {}),
  };
  // names of a retelling's closed sources are a showing of closed: an event before the answer; log refused — no answer
  if (basis) await auditShownClosed(app, caller, basis.closed, DERIVATION_SOURCES_OP);
  await auditRead(app, caller, await readEvent());
  const result = {
    content: body, metadata, toc: buildToc(full, rec.type), truncated, next_range: nextRange,
    derived: derived.map((d) => ({ id: d.id, type: d.type, event_kind: d.event_kind, title: d.title ?? "" })),
    ...(basis ? { derivation: derivationOut(basis.mark) } : {}),
  };
  // document conversion not finished or failed — as a line, not only in metadata.conversion
  const conv = conversionNote(rec.attrs, full.trim().length > 0, { stages, mime: content?.original_mime ?? null, cls: rec.class,
                                                                  fileHidden: Boolean(metadata.original) && !metadata.original?.url });
  // the work profile: a stale "Now in progress" — a line, as in memory_me; the date — the server's words, no section text
  const profileNote = profileReadNote(app, rec);
  // the "Based on" line — after the header: the intro, paths and dates — the server's words, source names — in the data block
  const text = readRecordText(metadata, part, { id: rec.id, search_id: a.search_id, max_tokens: a.max_tokens }, {
    profile: profileNote, derivation: basis ? derivationLine(basis.mark, texts) : "", correction: correction ? correctionLine(correction) : "",
    archivedSlug: archived ? slug : "", review: reviewLine, conversion: conv }, texts);
  return { result, text };
}

/** Record fields the memory_read text shows: the header and the name (`extended_write` — by the key's presence). */
export interface ReadTextMeta {
  path: string; type: string; event_kind?: string | null; occurred_at: string; origin: string; confirmed: boolean; class: string; title: string;
  extended_write?: unknown;
}
/**
 * Gateway lines between the header and the record text — in this order: profile, "Based on", correction, archive (the space
 * slug), the "Company common knowledge" state (`review` — with a line break at the start or empty), document conversion.
 */
export interface ReadTextNotes { profile: string; derivation: string; correction: string; archivedSlug: string; review: string; conversion: string }

/**
 * View and gateway lines for the memory_read text (@memory/mcp-core readText). Gateway lines in ReadTextNotes order; archive —
 * in gateway words by slug; `review` comes with a line break at the start (or empty) — not needed in the line.
 */
export function readTextArgs(metadata: ReadTextMeta, part: ReadPart, call: { id: string; search_id?: string; max_tokens?: number }, notes: ReadTextNotes): [ReadView, string[]] {
  const view: ReadView = {
    path: metadata.path, type: metadata.type, event_kind: metadata.event_kind ?? null, occurred_at: metadata.occurred_at, origin: metadata.origin,
    confirmed: metadata.confirmed, class: metadata.class, title: metadata.title, extended_write: "extended_write" in metadata, part, call,
  };
  return [view, [notes.profile, notes.derivation, notes.correction, notes.archivedSlug ? `Space ${notes.archivedSlug} is archived and read-only.` : "",
                 notes.review.replace(/^\n/, ""), notes.conversion]];
}

/**
 * The memory_read answer text (pinned by golden files): @memory/mcp-core readText — header, continuation,
 * gateway lines, the record in the data block, sections further down the text.
 */
export function readRecordText(metadata: ReadTextMeta, part: ReadPart, call: { id: string; search_id?: string; max_tokens?: number }, notes: ReadTextNotes, texts: McpTexts): string {
  return readText(...readTextArgs(metadata, part, call, notes), texts);
}
