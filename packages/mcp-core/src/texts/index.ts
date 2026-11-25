// The words mcp-core prints into MCP answers, by language: data markers, the search header and hit marks, the
// read header, continuation and table-of-contents lines, the refusals of reading by parts, list and me lines, the labels
// of the error text. Every renderer of the package takes a catalogue as a required argument — the package has no default
// language, so a forgotten call site does not compile instead of printing words of another language inside an answer.
// The gateway passes the catalogue of the setting locale.mcp_language, the edge — the one its generator names.
// Not here: the messages of errors.ts (notFound) and paging-cursor.ts — they join the catalogue with the message
// framework, as do the literals of the gateway files that build lines for the renderers.
import { EN } from "./en.ts";
import { RU } from "./ru.ts";

/**
 * How instruction-like lines of record text are marked (setting access.instruction_marking): `inline` — the notice
 * line before the data block and the prefix on each flagged line; `notice` — the notice line only; `off` — no marking at all
 * (the answers of 0.21.0, byte for byte). The mode travels with the catalogue, so every renderer marks the same way.
 */
export const INSTRUCTION_MARKINGS = Object.freeze(["inline", "notice", "off"] as const);
export type InstructionMarking = (typeof INSTRUCTION_MARKINGS)[number];

/** Languages of the catalogue — the values of locale.mcp_language. */
export const TEXT_LANGUAGES = Object.freeze(["en", "ru"] as const);
export type TextLanguage = (typeof TEXT_LANGUAGES)[number];

/** The words of one language. Plain strings and plain functions: no formatting library, no state. */
export interface McpTexts {
  readonly language: TextLanguage;
  /** The lines around everything taken from records (server.data_markers of the contract). */
  readonly markers: { readonly begin: string; readonly end: string };
  readonly search: {
    /** First line of memory_search: count, estimate, mode, current space, search_id and the server notes (joined; null — none). */
    header(v: { readonly shown: number; readonly total: number; readonly mode: string; readonly space: string | null; readonly searchId: string; readonly notes: string | null }): string;
    /**
     * The server line under the header of a search with hits: how to read a hit — the call with this search_id, and
     * the hit's ready `range` when its line shows one.
     */
    readHint(searchId: string): string;
    /** Pages of a hit's locator: "p. 12", "p. 12–13" (`to` null or equal to `from` — one page). */
    pages(from: number, to: number | null): string;
    /**
     * The time of a hit whose record has no time marks of its own (an event of a meeting: the time of its quote in the
     * transcript it came from) — "in the source 00:05:00–00:06:00"; such a hit gets no time range.
     */
    sourceTime(clock: string): string;
    /** The data block of a search without hits. */
    readonly nothing: string;
    /** Hit mark of a confirmed record without a review state of the company knowledge space. */
    readonly confirmed: string;
    /** Hit mark of a record written by an agent with extended access. */
    readonly extended: string;
    /** Review states of the company knowledge space (unreviewed, confirmed, community, disputed). */
    readonly orgReview: Readonly<Record<string, string>>;
  };
  readonly read: {
    /** Header mark of a record written with extended access. */
    readonly extended: string;
    /**
     * Header mark of a cut answer: code points start–end of total (of the selected range, when one was chosen) and the
     * estimated tokens left after `end`.
     */
    truncated(start: number, end: number, total: number, ranged: boolean, tokensLeft: number): string;
    /** The continuation line; `how` is the call to make (a JSON call, or the words of sameRange). */
    continuation(how: string): string;
    /** The call for a section continued by its anchor: the anchor is not repeated outside the data block. */
    sameRange(idJson: string, offset: number): string;
    /** Heading of the "sections further on" block. */
    readonly tocHeading: string;
    /** How many more sections are only in toc. */
    tocMore(n: number): string;
    /** Page of a section: "p. 3". */
    page(n: number): string;
    readonly pageOrder: string;
    readonly timeOrder: string;
    readonly badOffset: string;
    /** Refusal of a section name that several sections carry, and its hint. */
    sectionsAmbiguous(n: number): string;
    readonly sectionsAmbiguousHint: string;
  };
  readonly list: {
    /** "Records by type: note — 3, event — 2." — `items` already joined, empty for none. */
    typeCounts(items: string): string;
    /** "By month: 2026-10 — 3." — `items` already joined (not empty). */
    months(items: string): string;
    /** The next-page line. */
    more(cursor: string): string;
  };
  readonly me: {
    spaces(n: number): string;
    archived(n: number): string;
    /** The end of the key's access, a mark of the first line (`date` — YYYY-MM-DD). */
    until(date: string): string;
    /** Heading of the spaces block. */
    readonly spacesHeading: string;
    /** The spaces past the shown ones. */
    moreSpaces(n: number): string;
    /** Where memory_remember puts a note of this key: the space and its class. */
    notesTo(slug: string, cls: "open" | "closed"): string;
    /** Heading of the latest personal notes. */
    readonly notesHeading: string;
    /** What to call next: memory_search (`search`), all notes with memory_list (`list`); neither — an empty string. */
    next(search: boolean, list: boolean): string;
  };
  readonly error: {
    readonly hint: string;
    readonly reason: string;
    readonly link: string;
    /** Heading of the anchors of same-named sections (memory_read). */
    readonly sections: string;
  };
  /** The answer of memory_manage `help`: the list of actions and the long-form text of a topic. */
  readonly manage: {
    /** Heading of the actions of memory_manage. */
    readonly heading: string;
    /** How to call an action of memory_manage and how to ask for its full description. */
    readonly call: string;
    /** How to ask for the full description of an action, for a key without actions of memory_manage (only destructive ones). */
    readonly topicOnly: string;
    /** Heading of the actions of memory_manage_destructive, with how to call them. */
    readonly destructiveHeading: string;
    /** The line between the present description of a topic and its long-form text: which of the two is current. */
    readonly topicLong: string;
    /** The line before the input schema of a topic. */
    topicSchema(tool: string): string;
  };
  /** Marking of instruction-like lines and the structured data notice. */
  readonly instruction: {
    readonly marking: InstructionMarking;
    /** Put before a flagged line inside the data block (inline mode): server words, not record text. */
    readonly prefix: string;
    /** The server line before a data block with `n` flagged lines (inline and notice). */
    notice(n: number): string;
    /** The first field `data_notice` of the structured answers of search, read, list and me. */
    readonly dataNotice: string;
  };
}

/** The words of one language as en.ts and ru.ts write them: everything but the marking mode, which the caller picks. */
export type McpWords = Omit<McpTexts, "instruction"> & { readonly instruction: Omit<McpTexts["instruction"], "marking"> };

/** Frozen all the way down: a catalogue is shared by every answer of the process. */
function frozen<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) { for (const v of Object.values(o)) frozen(v); Object.freeze(o); }
  return o;
}
const WORDS: Readonly<Record<TextLanguage, McpWords>> = { en: EN, ru: RU };
const CATALOGUES: Readonly<Record<TextLanguage, Readonly<Record<InstructionMarking, McpTexts>>>> = frozen(Object.fromEntries(TEXT_LANGUAGES.map((l) => [l,
  Object.fromEntries(INSTRUCTION_MARKINGS.map((m) => [m, { ...WORDS[l], instruction: { ...WORDS[l].instruction, marking: m } }]))])) as Record<TextLanguage, Record<InstructionMarking, McpTexts>>);

/**
 * The catalogue of a language and a marking mode; the same pair gives the same object. There is no fallback for either:
 * the caller resolves the settings (the gateway reads English and `inline` for no row or an unknown value).
 */
export function mcpTexts(language: TextLanguage, marking: InstructionMarking): McpTexts {
  if (!Object.hasOwn(CATALOGUES, language)) throw new TypeError(`mcp-core texts: unknown language ${JSON.stringify(language)}`);
  const byMarking = CATALOGUES[language];
  if (!Object.hasOwn(byMarking, marking)) throw new TypeError(`mcp-core texts: unknown instruction marking ${JSON.stringify(marking)}`);
  return byMarking[marking];
}

/** The four data markers of every language: a record line that looks like any of them is escaped in every answer. */
export const ALL_MARKERS: readonly string[] = Object.freeze(TEXT_LANGUAGES.flatMap((l) => [WORDS[l].markers.begin, WORDS[l].markers.end]));
