// The check of a write into the open class: remember, upload, move, open;
// also the space metadata (name, description, slug) on creation and renaming, for open and closed spaces.
// The rules and the check: packages/shared/src/open-check.ts (the worker checks PDF text after the converter with the same code),
// it runs in a separate thread with a timeout (open-check-runner.ts); the full record texts are in open-check-texts.ts.
// A refusal is open_check (422) with reasons and a hint where to write; the match goes neither into the answer nor the journal.
import { acceptedSettings, despiteSettings, joinedTexts, log, MemoryError, OPEN_CHECK_MAX_FINDINGS, OPEN_CHECK_UNCHECKED, openCheckFaultHit, openCheckReasons, openCheckRefused, openCheckSettings,
         openCheckTimeoutUnchecked, openCheckTruncated, openTreeTexts, legacyCharsetOf, legacyScanCharsetsOf, OpenCheckTimeout, ruleOpenableByWord, runOpenCheck, sampleEveryRule, showAnywayPath, showAnywayWhere, strictOpenCheckSettings,
         sweepRules, CONVERTER_FORMAT_KIND, type ConverterFormat, type ConverterFormatKind, type DataClass, type FallbackFinding, type OpenCheckFinding, type OpenCheckSettings, type OpenCheckText, type OpenCheckUnchecked, type OpenTreeTexts, type TreeTextSources } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { canWrite, readableSpaces } from "./access.ts";
import { audit } from "./audit.ts";
import { QueueFull, Semaphore } from "./concurrency.ts";
import { isHumanSession } from "./workplace.ts";

export type OpenVia = "remember" | "upload" | "promote" | "open" | "space" | "open_word" | "link" | "correct" | "handover";

/**
 * Space metadata (via space) is checked under the record's field names: the name and
 * description as title and text (an agent sees them together in memory_me — the join catches "a name in the title, an email
 * in the description"), the slug with spaces for hyphens as the address (source): the case of an NDA-list name does not matter,
 * and "Acme" from the list finds acme-crm (a lowercase slug would never match an entry written "with a capital letter").
 * No transliteration: the administrator adds a client's Latin spelling to the list as a separate line. "About the space"
 * (readme) is like the summary: its own record field, so a finding comes back under its own name, and in the same
 * join "title + summary + text" — an agent reads the description and readme together in memory_list. Findings
 * come back under the space field names.
 */
export const SPACE_META_FIELDS: Readonly<Record<string, string>> = { name: "title", description: "text", readme: "summary", slug: "source" };

/** Texts under other field names (`as`: own → the checked field) and the reverse mapping of findings. */
export function aliasTexts(texts: OpenCheckText[], as: Readonly<Record<string, string>>): { texts: OpenCheckText[]; back: (f: OpenCheckFinding[]) => OpenCheckFinding[] } {
  const rev = new Map(Object.entries(as).map(([k, v]) => [v, k]));
  return { texts: texts.map((t) => ({ ...t, field: as[t.field] ?? t.field })), back: (found) => found.map((f) => ({ ...f, field: rev.get(f.field) ?? f.field })) };
}

/**
 * Findings by record fields with the current panel settings; a disabled check gives []. The timeout is OpenCheckTimeout.
 * The title, summary and text are also checked joined — as the reader sees them.
 * `force` — the panel's "Check text" (its own check lane); `owner` — the caller: the check queue
 * serves callers in turn (checkOwner).
 */
export async function openFindings(app: App, texts: OpenCheckText[], opts: { force?: boolean; owner?: string; as?: Readonly<Record<string, string>>; settings?: OpenCheckSettings } = {}): Promise<OpenCheckFinding[]> {
  const a = opts.as ? aliasTexts(texts, opts.as) : { texts, back: (f: OpenCheckFinding[]) => f };
  const j = joinedTexts(a.texts);
  return a.back(j.map(await runOpenCheck(opts.settings ?? openCheckSettings(app.settings), j.texts, { force: opts.force, owner: opts.owner })));
}

/**
 * The caller for the check queue: a person is one for all their keys and sessions, a service (also on behalf of
 * people) — by key. One key that filled the queue with uploads does not take it from others' documents.
 */
export const checkOwner = (c: Caller): string => (c.principalType === "person" && c.person ? `person:${c.person.id}` : `key:${c.keyId}`);

/**
 * The texts of a record and its derivatives for "Open" and for moving an open record into another space — the same set the
 * move worker checks (open-check-texts.ts). Read in the system context: the check is a server action.
 */
/** `textOnly` — showing a scan "as text only": the recognized text of a partly recognized document is checked as usual. */
export async function treeTexts(app: App, cls: DataClass, id: string, opts: { live: boolean; targetSpaceId?: string; control?: TreeTextSources["control"]; textOnly?: boolean }):
    Promise<OpenTreeTexts> {
  // at most TREE_PREP.max tree preparations at once: several "Open" over a huge edit history
  // do not keep several trees in gateway memory; queue full — "the check server is busy", as with the check's own queue
  try {
    return await treePrep.run(() => openTreeTexts({
      records: app.db.records(cls, { classes: ["open", "closed"] as const, tier: "system" as const }), control: opts.control ?? app.db.control,
      original: (key) => app.storage.get(cls, key), legacyCharset: legacyCharsetOf(app.settings),
      scanCharsets: legacyScanCharsetsOf(app.settings),
    }, id, opts));
  } catch (e) {
    if (e instanceof QueueFull) return { texts: [], unchecked: "busy" };
    throw e;
  }
}
/** Preparing trees for the open check: at most 4 at once, at most 32 waiting. */
export const TREE_PREP = Object.freeze({ max: 4, waiting: 32 });
const treePrep = new Semaphore(TREE_PREP.max, TREE_PREP.waiting);

/**
 * Moving and placing an open record do not change the class: conversion is not involved (the worker checks the document
 * text), and an unread or too large text original is a refusal without findings, as with "Open".
 */
export const originalUnchecked = (u: OpenCheckUnchecked | null): OpenCheckUnchecked | null =>
  // the tree is too large or tree preparation is busy — the texts are not read: also a refusal, not
  // a check of an empty list
  u === "original_unavailable" || u === "original_too_large" || u === "tree_too_large" || u === "busy" ? u : null;

/**
 * "Not checked" for moving and placing an open record: a record shown to agents "as text only"
 * (`attrs.original_closed`) got consent for its current space and readers — on moving and placing
 * its scans (`partial_text`) are not dropped, as for other open documents, but give a refusal: the author hides it from
 * agents, moves it and shows it again. Old open PDFs with scans and without this
 * mark — as before (originalUnchecked).
 */
export const moveUnchecked = (u: OpenCheckUnchecked | null, originalClosed: boolean): OpenCheckUnchecked | null =>
  originalClosed && u === "partial_text" ? u : originalUnchecked(u);

const LEAD: Record<OpenVia, string> = {
  remember: "The record was not accepted into the open class",
  upload: "The document was not accepted into the open class",
  promote: "The record was not moved because it is in the open class",
  open: "This record cannot be shown to agents",
  space: "The space was not saved",
  open_word: "A person’s confirmation cannot make this record open",
  link: "The link was not added. The quote or rationale failed the open check",
  correct: "The correction was not accepted into the open class",
  handover: "The decision was not handed over to the project",
};

/** A refusal with findings for someone who does not read the record: only the author sees what was found. */
export const HIDDEN_FINDINGS = "the record contains information agents cannot see. The author can see the details";
export const HIDDEN_FINDINGS_HINT = "The record stayed where it was. Ask the author to remove the information or move the record themselves";

/** The hint of a refusal on space metadata: where they go and what to do with a client from the NDA list. */
export const SPACE_HINT = "Cloud agents for space members can see the space title, description and identifier. The identifier also appears in "
  + "repository files (CLAUDE.md, AGENTS.md). Remove this information from those fields. For clients on the strict NDA list, use the project code name";
/**
 * The hint of a metadata refusal with a finding in "About the space": the field is named directly —
 * the old hint sent one to remove the finding from the name and description, where it is not. No findings in readme — SPACE_HINT
 * byte for byte (disabled templates change nothing).
 */
const NDA_CODENAME = "use the project code name for clients on the strict NDA list";
export const SPACE_README_HINT = `Cloud agents for members can read “About this space”. Remove this information and save again; ${NDA_CODENAME}`;
export const SPACE_HINT_WITH_README = "Cloud agents for members can see the space title, description, “About this space” and identifier, "
  + `and the identifier also appears in repository files (CLAUDE.md, AGENTS.md). Remove this information from those fields; ${NDA_CODENAME}`;
export const spaceHint = (findings: readonly Pick<OpenCheckFinding, "field">[]): string =>
  !findings.some((f) => f.field === "readme") ? SPACE_HINT : findings.every((f) => f.field === "readme") ? SPACE_README_HINT : SPACE_HINT_WITH_README;

/** `settings` — own check settings instead of the panel's: rules accepted on a person's word are off (acceptedSettings). */
/**
 * `hideFindings` — the caller does not read the record (a space lead moves another's record): on a refusal
 * with findings — only the general text, without kinds, rules and positions.
 */
/**
 * `refusal` — own refusal text with findings (an edit or mark of a record shown to agents despite a
 * finding); null — the usual one. The journal event and `details.open_check` — as always.
 */
export interface GuardArgs { via: OpenVia; texts: OpenCheckText[]; spaceId?: string | null; recordId?: string; unchecked?: OpenCheckUnchecked | null; settings?: OpenCheckSettings;
                      hideFindings?: boolean; refusal?: (findings: readonly OpenCheckFinding[]) => { message: string; hint: string } | null;
                      /** Own advice in place of the general — only for refusals with findings (a PDF with a title finding). */
                      hint?: string;
                      /** An older version of a document chain has no checked text, whatever `unchecked` says (openTreeTexts). */
                      uncheckedVersion?: boolean }
/**
 * `never` — the "never open" rules that fired: the refusal reason names them first, the journal gets their
 * kinds and rules. Not in `details.open_check.findings`: that is the OpenCheckFinding schema (content check kinds and fields).
 */
export interface Outcome { findings: OpenCheckFinding[]; unchecked: OpenCheckUnchecked | null; never?: readonly FallbackFinding[] }

/**
 * Findings and "not checked" — without the journal and without a refusal (the soft check of personal open and the old
 * guardOpen share it). The check did not fit in open_check.timeout_sec — `timeout`; the check server is busy or the thread
 * unavailable — `busy`; a failure — `check_failed`. The test hook processing.open_check_fault answers `busy` before
 * running the rules if the title or the file name holds its substring.
 */
export async function openCheckOutcome(app: App, caller: Caller, a: GuardArgs): Promise<Outcome> {
  let findings: OpenCheckFinding[] = [], unchecked: OpenCheckUnchecked | null = a.unchecked ?? null;
  const settings = a.settings ?? openCheckSettings(app.settings);
  // the check is off in the panel — "nothing to check" is not a refusal either: written as before the check existed
  if (unchecked && !settings.enabled) unchecked = null;
  if (!unchecked) {
    try {
      if (settings.enabled && openCheckFaultHit(app.settings.get("processing.open_check_fault", {}), a.texts)) throw new OpenCheckTimeout(settings.timeout_sec, "queue_full");
      findings = await openFindings(app, a.texts, { owner: checkOwner(caller), settings, ...(a.via === "space" ? { as: SPACE_META_FIELDS } : {}) });
    } catch (e) {
      // a check failure is a refusal with an explanation too, not a 500 without a hint and without a journal row.
      // It did not fit itself — timeout ("shorten the text"); the check server is busy or the thread is unavailable —
      // busy ("retry")
      if (e instanceof OpenCheckTimeout) unchecked = openCheckTimeoutUnchecked(e);
      else { unchecked = "check_failed"; log.warn("open_check_failed", { via: a.via, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }
  }
  return { findings, unchecked };
}

/** Personal open, a refusal without findings: nothing is saved, neither open nor closed. */
const PERSONAL_LEAD: Partial<Record<OpenVia, string>> = { remember: "The note was not saved", upload: "The document was not saved", correct: "The note was not replaced" };
const NOTHING_SAVED = "the record was saved in neither the open nor the closed class";

/**
 * "Show to agents" by a person in the workplace: the hint has no "T0 services" — they mean
 * nothing to a person. A finding — the "Make available to agents" button on the record page; nothing to check — as text again.
 */
const HUMAN_OPEN_HINT = "The record stays closed: agents cannot see it, people in the workspace can. If agents need it, select “Make available to agents” on the record page. The memory will show its findings and ask for your confirmation";
const HUMAN_OPEN_UNCHECKED_HINT = "The record stays closed: agents cannot see it, people in the workspace can. Put what agents need in a new text note";
/**
 * Some pages of the file are scans (`partial_text`), and showing scans as text is on here: a scan uploaded
 * by a person to a personal or closed space gets no check mark, and only this refusal leads it to "Make available to agents"
 * — the workplace opens the panel ("text only"). The hint must not contradict the link to it.
 */
const HUMAN_OPEN_SCANS_HINT = "The record stays closed: agents cannot see it, people in the workspace can. If agents need it, select “Make available to agents” on the record page. Agents will only get the extracted text the memory checked. The file and scanned pages stay visible only to people";
/** A file from the workplace is not accepted: where to upload instead of open — without "T0" and space addresses. */
const HUMAN_UPLOAD_CLOSED = "only people can see it there";
/** Whose text is checked after processing — in plain words, as in intake refusals: no extensions and codes. */
const TEXT_LATER_OF: Readonly<Record<ConverterFormatKind, string>> = { pdf: "PDF", word: "a Word document", powerpoint: "a PowerPoint presentation", excel: "an Excel spreadsheet" };
/**
 * A person's file into an open team or project with a finding in the title or the file name: the text of PDF and
 * office files (for everyone now) is checked only after processing, and a shared space may not save unchecked content as closed —
 * the text may hold a password or a passport, and all the space's people would read it. The old refusal; the advice is to rename.
 * The format is named by what intake recognized (Word, PowerPoint, Excel, CSV); not recognized — "document".
 */
export const textLaterNameHint = (format?: ConverterFormat | null): string =>
  `The text of ${format === "csv" ? "a CSV spreadsheet" : format ? TEXT_LATER_OF[CONVERTER_FORMAT_KIND[format]] : "document"} is checked only after processing, `
  + "so a file with this information in its title cannot be saved here. "
  + `Remove it from the title and file name, then upload the file again. You can also upload it to a closed team space: ${HUMAN_UPLOAD_CLOSED}`;
/** Showing despite a finding is turned off here by the administrator ("no button anywhere") — we do not name the button. */
const HUMAN_OPEN_OFF_HINT = "The record stays closed: agents cannot see it, people in the workspace can. Put what agents need in a new note without this information";

/**
 * Is there "Make available to agents" in this space (panel switches): all off — nowhere; off
 * "in teams and projects" — only in personal. Personal with readers or placement is decided by the preview (projects_disabled).
 */
async function despiteHere(app: App, spaceId: string | null | undefined): Promise<boolean> {
  const ds = despiteSettings(app.settings);
  if (!ds.enabled) return false;
  if (ds.projects || !spaceId) return true;
  return (await app.db.control.query("SELECT kind, owner_id FROM spaces WHERE id = $1", [spaceId])).rows[0]?.kind === "personal";
}

/**
 * The journal event `open_check_refused` (rules and kinds, no content) and the open_check refusal with a hint. `personal` —
 * personal open: there a refusal comes only without findings, and the hint is "retry", not "write into the closed
 * team space". Export — for "Show to agents" with consent:
 * the check server busy while the consent is compared — the same refusal as for the usual "Show".
 */
export async function refuseOpen(app: App, caller: Caller, a: GuardArgs, out: Outcome, personal = false): Promise<never> {
  const { findings, unchecked } = out;
  const never = unchecked ? [] : out.never ?? [];
  const kinds = [...new Set([...never, ...findings].map((f) => f.kind))], rules = [...new Set([...never, ...findings].map((f) => f.rule))];
  // space metadata is not an open-class record: for a closed project the class "open" in the event would be a lie
  await audit(app, caller, { event_type: "write", class: a.via === "space" ? null : "open", record_ids: a.recordId ? [a.recordId] : [], space_id: a.spaceId ?? null,
                             details: { op: "open_check_refused", via: a.via, kinds, rules, ...(unchecked ? { unchecked } : {}), ...(personal ? { personal_open: true } : {}) } });
  let hint: string;
  if (personal && unchecked) {
    hint = unchecked === "busy" || unchecked === "timeout"
      ? `The check server was busy or ran out of time. Try again in a minute with the same text: ${NOTHING_SAVED}`
      : `The check failed. Try again later with the same text: ${NOTHING_SAVED}`;
  }
  else if (unchecked === "tree_too_large") hint = "Put what agents need in a new note. The check cannot read the whole record when its edit history is this long";
  else if (unchecked === "conversion_pending") hint = "Wait for conversion (stage converted), then open the record again";
  // moving or placing a document shown to agents "as text only" (moveUnchecked): the consent
  // was for the current readers — hide, move and show again. They have no other sources of partial_text
  else if (unchecked === "partial_text" && a.via === "promote")
    hint = `Only the document’s text is visible to agents, and consent was for its current audience. To move it, first hide it from agents (${isHumanSession(caller) ? "“Hide from agents” on the record page" : "memory_close"}). Move it, then show it again. The memory will ask who can see it`;
  else if (unchecked === "partial_text" && a.via === "upload")
    hint = `Agents already see this file text only in another space, and consent was for that audience. To place it here, the author can hide it from agents, upload it here and show it again. You can also upload it to a closed team space: ${HUMAN_UPLOAD_CLOSED}`;
  else if (unchecked === "busy") hint = "Try again in a minute";
  else if (unchecked === "original_unavailable" || unchecked === "check_failed") hint = "Try again in a few minutes";
  // a scan for a person in the workplace: "text only" — the "Make available to agents" button, unless the administrator turned
  // it or showing scans as text off; otherwise, and for keys, the old text below
  // a scan in an older version of the chain: "text only" relaxes the head alone — no button named
  else if (unchecked === "partial_text" && a.via === "open" && !a.uncheckedVersion && isHumanSession(caller) && despiteSettings(app.settings).scansText && await despiteHere(app, a.spaceId))
    hint = HUMAN_OPEN_SCANS_HINT;
  // some pages are scans: as a scan without text — image pages cannot be checked, the original with them does not go to agents
  else if (unchecked === "conversion_failed" || unchecked === "empty_text" || unchecked === "partial_text" || (unchecked === "original_too_large" && (a.via === "open" || a.via === "open_word")))
    hint = a.via === "open" && isHumanSession(caller) ? HUMAN_OPEN_UNCHECKED_HINT : "The record stays closed. T0 services and people in the workspace can read it. Put what agents need in a new text note";
  // for a person in the workplace — the "Make available to agents" button unless the administrator turned it off; keys: old text
  else if (a.via === "open" && isHumanSession(caller)) hint = await despiteHere(app, a.spaceId) ? HUMAN_OPEN_HINT : HUMAN_OPEN_OFF_HINT;
  else if (a.via === "open" || a.via === "open_word") hint = "The record stays closed. T0 services and people in the workspace can read it. Put what agents need in a new note without this information";
  else if (a.via === "promote") hint = "The record stays open in its current location. To move it, first close it (memory_close). A closed record can be moved without this check. You can also put what you need in a new note without this information";
  else if (a.via === "link") hint = "Remove this from the justification. A quote must match an excerpt of the record exactly. If either record is closed, the link quotes are stored in the closed database";
  else if (a.via === "space") hint = unchecked === "timeout" ? `Shorten the description. ${SPACE_HINT}` : spaceHint(findings);
  // a correction falls into the class of the corrected record: it cannot be made closed — nothing is written
  else if (a.via === "correct") hint = unchecked ? "Try again in a minute with the same text. Nothing was saved" : "The correction goes alongside the corrected record in the open class. Rewrite it without personal data, contract numbers or secrets. Nothing was saved";
  // handing a meeting decision into an open project: the person in the workplace sees the refusal — only the form text is checked
  else if (a.via === "handover") hint = unchecked ? "Try again in a minute with the same text. Nothing was sent to the project" : "Remove this from the text and send it again. Only this text goes to the project, and the meeting stays closed";
  // a person's file from the workplace: in plain words — without key levels and space addresses
  else if (a.via === "upload" && isHumanSession(caller))
    hint = a.hint && !unchecked ? a.hint
      : `${unchecked === "timeout" || unchecked === "original_too_large" ? "Shorten the file" : "Remove this from the file"} or upload it to a closed team space: ${HUMAN_UPLOAD_CLOSED}`;
  else {
    // closed team spaces and closed projects the caller may write to
    const closed = [...(await readableSpaces(app, caller)).values()]
      .filter((s) => (s.kind === "team" || s.kind === "project") && s.default_class === "closed" && canWrite(s)).map((s) => s.slug).sort().slice(0, 3);
    hint = `${unchecked === "timeout" || unchecked === "original_too_large" ? "Shorten the text or save it" : "Remove this from the text or save it"} to a closed team space${closed.length ? ` (space: ${closed.join(", ")})` : ""}. Agents using personal keys cannot read closed records. T0 services and people in the workspace can read them`;
  }
  if (unchecked === "timeout" || unchecked === "check_failed") hint += ". If this happens with every record, ask the administrator to check the custom rules in “Open check” in the admin panel";
  // on "Overview" the check is labeled "check of a write into the open class" (CHECK_TITLES of the panel) — the hint names it
  // the same way
  else if (unchecked === "busy" && a.via === "upload" && isHumanSession(caller)) hint += ". If this keeps happening, tell the memory administrator";
  else if (unchecked === "busy") hint += ". If this keeps happening, tell the administrator. The status of the check workers is on the admin panel’s “Overview” page (open check for records) and at /api/v1/health";
  const lead = (personal && PERSONAL_LEAD[a.via]) || LEAD[a.via];
  // the journal event above — as always; an answer to one who does not read the record has no kinds, rules or positions: by them
  // an administrator tuning the rules could work out the content of another's meeting
  if (a.hideFindings && findings.length) throw openCheckRefused(`${LEAD[a.via]}: ${HIDDEN_FINDINGS}`, HIDDEN_FINDINGS_HINT, { via: a.via, findings: [] });
  // own refusal text (an edit or mark of a record shown despite a finding) — only with findings; "not checked" — as always
  const own = !unchecked && findings.length && a.refusal ? a.refusal(findings) : null;
  if (own) throw openCheckRefused(own.message, own.hint, { via: a.via, findings });
  // the "never open" rule — first and in its own words: "looks like a phone number" would say the wrong thing —
  // in a team or project a phone by itself keeps the file closed, it does not refuse
  const neverWhy = never.length ? `“never open” rule: ${[...new Set(never.map((f) => f.reason))].join(", ")}` : null;
  const why = unchecked ? OPEN_CHECK_UNCHECKED[unchecked]
    : [neverWhy, findings.length ? `appears to contain ${openCheckReasons(findings)}` : null].filter(Boolean).join("; ");
  throw openCheckRefused(`${lead}: ${why}`, hint, { via: a.via, findings, ...(unchecked ? { unchecked } : {}) });
}

/**
 * A write into the open class: a finding — a journal event (rules and kinds, no content) and the open_check refusal with a hint.
 * The check did not fit in open_check.timeout_sec, the check server is busy (`busy`) or there is nothing to check
 * (`unchecked`) — also a refusal: only checked content is written into open. The hint names the closed team spaces the caller may write to: closed content
 * is not read by agents with personal keys; T0 services and people in the workplace read it. Space metadata (`space`)
 * is checked under record fields (SPACE_META_FIELDS), the hint is about the repository, the event has no class.
 */
export async function guardOpen(app: App, caller: Caller, a: GuardArgs): Promise<void> {
  const out = await openCheckOutcome(app, caller, a);
  if (!out.findings.length && !out.unchecked) return;
  await refuseOpen(app, caller, a, out);
}

/**
 * The soft check of personal open: findings are returned — the record is stored closed with a mark instead of
 * getting a refusal; "not checked" (busy, out of time, failure) — a refusal, nothing is saved. The list
 * of findings is cut (OPEN_CHECK_MAX_FINDINGS) — a second pass with only the secret, NDA and own rules:
 * `strict` — its findings, `null` — it did not run (the record then does not open on word).
 */
export async function guardOpenSoft(app: App, caller: Caller, a: GuardArgs & { via: "remember" | "upload" | "correct" }): Promise<{ findings: OpenCheckFinding[]; strict?: OpenCheckFinding[] | null }> {
  const out = await openCheckOutcome(app, caller, a);
  if (out.unchecked) await refuseOpen(app, caller, a, out, true);
  if (!openCheckTruncated(out.findings)) return { findings: out.findings };
  const strict = await openFindings(app, a.texts, { owner: checkOwner(caller), settings: strictOpenCheckSettings(openCheckSettings(app.settings)) })
    .catch((e: unknown) => { log.warn("open_check_strict_failed", { via: a.via, error: String((e as Error)?.message ?? e).slice(0, 200) }); return null; });
  return { findings: out.findings, strict };
}

/**
 * A person's file upload in the workplace into an open team or project.
 * Returns the findings if all of them can be shown to agents "despite" in a team or
 * project (phone, email next to a name, tax ID, contract number, sum): the file is stored closed in the same space with a mark;
 * findings — the first 20 and one of each rule hidden past the list limit (sampleEveryRule: the mark's kind does not
 * carry rules); `more` — findings of later passes if the first list hit the limit (for the mark's kinds and rules). No findings
 * — [], the file is stored open, as before. Everything else is the old guardOpen refusal (a journal event and open_check, nothing
 * saved): "not checked" (busy, out of time, failure — retry); a secret, strict NDA, the administrator's own rule,
 * a passport, a social insurance or card number — also hidden past the 20-finding list (sweepRules: a password in a shared
 * project would be seen by all its people, there is no button for such findings); the "never open" rule by title, domain tag,
 * entity or space (`o.never` — its findings, the refusal reason names them first: such a record cannot be shown even
 * with the button). The "never open" rules are asked only on findings: a clean file is stored open, as before
 * (an ordinary write into an open project does not ask them).
 * `o.textLater` — PDF or office: only the worker checks its text after processing. A finding in the title or file
 * name — the old refusal with the advice to rename (textLaterNameHint, format `o.format`): a shared space stores no unchecked content closed —
 * all its people would read a password or passport in the text while processing runs; the worker does not check the closed copy.
 */
export async function guardOpenKeepClosed(app: App, caller: Caller, a: GuardArgs & { via: "upload" }, o: { never: () => Promise<FallbackFinding[]>; textLater?: boolean; format?: ConverterFormat | null })
    : Promise<{ findings: OpenCheckFinding[]; more?: OpenCheckFinding[] }> {
  const out = await openCheckOutcome(app, caller, a);
  if (out.unchecked) await refuseOpen(app, caller, a, out);
  if (!out.findings.length) return { findings: [] };
  const never = await o.never();
  if (o.textLater) await refuseOpen(app, caller, never.length ? a : { ...a, hint: textLaterNameHint(o.format) }, { ...out, never });
  const base = a.settings ?? openCheckSettings(app.settings);
  const sweep = await sweepRules(out.findings, "shared", (accepted) => openCheckOutcome(app, caller, { ...a, settings: acceptedSettings(base, accepted) }));
  if (sweep.unchecked) await refuseOpen(app, caller, a, { findings: [], unchecked: sweep.unchecked });
  // "never" ones first: the refusal reason names the "never open" rule and what was hiding behind the phones
  if (never.length || sweep.never.length || !sweep.complete)
    await refuseOpen(app, caller, a, { findings: [...sweep.never.filter((f) => !out.findings.includes(f)), ...out.findings].slice(0, OPEN_CHECK_MAX_FINDINGS), unchecked: null, never });
  return { findings: sampleEveryRule(out.findings, sweep.more, OPEN_CHECK_MAX_FINDINGS), ...(openCheckTruncated(out.findings) ? { more: sweep.more } : {}) };
}

/** A finding that cannot be opened on a person's word: not a built-in rule of an openable kind — a secret, NDA, an own rule. */
export const neverByWord = (findings: readonly OpenCheckFinding[]): boolean => findings.some((f) => !ruleOpenableByWord(f.rule));

/**
 * The check when opening on a person's word: the texts of the record and derivatives — with fresh settings, with
 * the accepted rules OFF (acceptedSettings: the 20-finding limit does not hide a secret behind phones). A finding —
 * a journal event `open_check_refused` (`via: open_word`, rules and kinds, accepted rules) and the open_check refusal:
 * a secret, NDA, an own rule — `never_by_word: true`; a new finding of an openable kind (to the agent) — a link to the workplace:
 * `details.workplace_path` always (the agent passes the path even without a set address) and `details.workplace_url`,
 * if the workplace address is set; the person decides. Not checked (conversion, busy, out of time) — the old refusal, none found.
 * The hint names the "Make available to agents" button and the link to its panel; without a workplace address —
 * a relative path and "the administrator knows the address", as with the forbidden refusal.
 */
export async function guardOpenWord(app: App, caller: Caller, a: { texts: OpenCheckText[]; spaceId: string; recordId: string; unchecked: OpenCheckUnchecked | null;
                                                                     accepted: readonly string[]; workplaceUrl: string | null }): Promise<OpenCheckFinding[]> {
  const out = await openCheckOutcome(app, caller, { via: "open_word", texts: a.texts, spaceId: a.spaceId, recordId: a.recordId, unchecked: a.unchecked,
                                                    settings: acceptedSettings(openCheckSettings(app.settings), a.accepted) });
  if (!out.findings.length && !out.unchecked) return [];
  if (out.unchecked) await refuseOpen(app, caller, { via: "open_word", texts: a.texts, spaceId: a.spaceId, recordId: a.recordId }, out);
  const never = neverByWord(out.findings);
  const kinds = [...new Set(out.findings.map((f) => f.kind))], rules = [...new Set(out.findings.map((f) => f.rule))];
  await audit(app, caller, { event_type: "write", class: "closed", record_ids: [a.recordId], space_id: a.spaceId,
                             details: { op: "open_check_refused", via: "open_word", kinds, rules, accepted_rules: [...a.accepted], never_by_word: never } });
  const why = `appears to contain ${openCheckReasons(out.findings)}`;
  const details: Record<string, unknown> = { open_check: { via: "open_word", findings: out.findings, never_by_word: never, ...(a.accepted.length ? { accepted: [...a.accepted] } : {}) },
                                             ...(!never ? { workplace_path: showAnywayPath(a.recordId) } : {}), ...(!never && a.workplaceUrl ? { workplace_url: a.workplaceUrl } : {}) };
  if (never) throw new MemoryError("open_check", `This record cannot be made open even with your confirmation: ${why}`,
    { hint: "Remove this and save the record again. Agents cannot make secrets, clients on the strict NDA list or information barred by the administrator’s custom rules available", details });
  throw new MemoryError("open_check", `This confirmation cannot make the record open. The new check found more: ${why}`,
    { hint: `The person did not approve this finding. They can show the record to agents by selecting “Make available to agents” in the workspace: `
            + `${showAnywayWhere(a.recordId, a.workplaceUrl)}. Do not open the link or select the button on their behalf`, details });
}
