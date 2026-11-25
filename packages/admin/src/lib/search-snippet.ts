import { searchSnippet as M } from "../messages/search-snippet";
import { fmtTime } from "./markdown";
import type { Hit } from "./types";

export const SNIPPET_CHARS = 320;
export const SNIPPET_TOKENS = 160;
export const WEAK_SHARE = 0.3;
export const MIN_SHOWN = 5;

/** Event kind label at the start of a decision text ("**Decision.** …"): the label row already names the kind. */
const KIND_LEAD = /^(?:Decision|Action|Task|Question \/ risk|Risk or question|Fact)\.\s+/;
/** Meeting summary head: "Summary: <title> (<date>)", the line "Source: transcript `…`; …" and the first section "Outcome". */
const SUMMARY_HEAD = /^Summary:\s.{0,300}?\([^()]{4,40}\)\s*/;
const SUMMARY_SOURCE = /^Source: transcript\s+\S+?;\s*the time marks link to its fragments\.\s*/;
const SUMMARY_FIRST = /^Outcome\s+/;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

const SNIP_LIT0 = 0xe000, SNIP_LIT_ANY = /[\ue000-\ue07f]/g;
const SNIP_NAMED: Readonly<Record<string, string>> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"' };
const SNIP_LITERAL = /\\([!-/:-@\[-`{-~])|<[bB][rR][ \t]*\/?>|&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|nbsp|amp|lt|gt|quot);/g;
function snippetEntity(body: string): string | null {
  if (body[0] !== "#") return SNIP_NAMED[body] ?? null;
  const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!Number.isInteger(cp) || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= SNIP_LIT0 && cp <= 0xe07f) || cp > 0x10ffff) return null;
  return String.fromCodePoint(cp);
}
const snipLit = (ch: string): string => (ch.length === 1 && ch.charCodeAt(0) < 0x80 ? String.fromCharCode(SNIP_LIT0 + ch.charCodeAt(0)) : ch);
const lower = (s: string): string => s.toLowerCase();

export function cleanSnippet(snippet: string, title?: string | null): string {
  let s = ` ${snippet.replace(SNIP_LIT_ANY, "\ufffd")} `;
  s = s.replace(SNIP_LITERAL, (m: string, ch: string | undefined, ent: string | undefined) => {
    if (ch !== undefined) return snipLit(ch);
    if (ent === undefined) return " ";
    const c = snippetEntity(ent);
    return c === null ? m : snipLit(c);
  });
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_m, a: string, b: string | undefined) => (b ?? a).trim());
  s = s.replace(/!\[([^\]]*)\]\([^)\s]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1");
  s = s.replace(/\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?/g, " ").replace(/\s*\|\s*/g, " · ");
  s = s.replace(/(\s)#{1,6}(?=\s)/g, "$1");
  s = s.replace(/(\s)>+(?=\s)/g, "$1");
  s = s.replace(/(\s)-{3,}(?=\s)/g, "$1").replace(/(\s)={3,}(?=\s)/g, "$1").replace(/~{3,}/g, " ").replace(/(\s)[-*+•](?=\s)/g, "$1·");
  s = s.replace(/(^\s*|·\s*)\[ \](?=\s)/g, "$1☐").replace(/(^\s*|·\s*)\[[xX]\](?=\s)/g, "$1☑");
  const notes = new Set([...s.matchAll(/\[\^([^\]\s]{1,20})\]:/g)].map((m) => m[1]!));
  s = s.replace(/`[^`]*`|\[\^([^\]\s]{1,20})\]:?/g, (m: string, l: string | undefined) => (l !== undefined && (/^\d{1,3}$/.test(l) || notes.has(l)) ? "" : m));
  s = s.replace(/\*\*|__/g, "").replace(/`+/g, "");
  s = s.replace(/(^|[\s(«"'])\*(?=\S)([^*]*?\S)\*(?=$|[\s).,;:!?»"'])/g, "$1$2").replace(/(^|[\s(«"'])_(?=\S)([^_]*?\S)_(?=$|[\s).,;:!?»"'])/g, "$1$2");
  s = s.replace(/\[![A-Za-z-]{1,20}\][+-]?/g, "");
  s = s.replace(/~~(?=[^\s~])([^~]*?[^\s~])~~/g, "$1").replace(/==(?=[^\s=])([^=]*?[^\s=])==/g, "$1");
  s = s.replace(SNIP_LIT_ANY, (c) => String.fromCharCode(c.charCodeAt(0) - SNIP_LIT0));
  s = norm(s).replace(/(?:\s*·\s*){2,}/g, " · ").replace(/^·\s*|\s*·$/g, "").trim();
  if (s.startsWith("…")) return s;
  const t = norm(title ?? "").replace(/[*_`#]/g, "");
  let titles = 0;
  for (let i = 0; i < 6; i++) {
    const was = s;
    s = s.replace(SUMMARY_HEAD, "").replace(SUMMARY_SOURCE, "").replace(SUMMARY_FIRST, "");
    if (titles < 2 && t.length >= 3 && lower(s).startsWith(lower(t))) { s = s.slice(t.length).replace(/^[\s.:—–-]+/, ""); titles++; }
    s = s.replace(KIND_LEAD, "").replace(/^\d{1,3}[.)]\s+/, "");
    if (s === was) break;
  }
  return s.trim();
}

const EN_STOP = ["what", "when", "where", "which", "that", "this", "these", "those", "with", "from", "about", "into", "have", "were",
  "been", "does", "there", "their", "them", "they", "then", "than", "also", "only", "some", "such", "very", "will", "would", "should",
  "could", "after", "before", "between", "through", "your", "much", "many", "more", "most"];
// Russian stop words of the query: data for Russian queries.
const STOP = new Set([...EN_STOP, "когда", "только", "чтобы", "также", "этот", "этой", "этом", "того", "тоже", "какой", "какие", "какая", "каким", "почему",
  "зачем", "сколько", "были", "была", "было", "есть", "всех", "всего", "нужно", "можно", "между", "через", "после", "перед", "более",
  "менее", "очень", "будет", "чтоб", "если", "который", "которые", "которая", "какое", "свой", "свои", "своих", "наши", "наш", "наша"]);

export interface QueryTerm { word: string; stem: string }

export function queryTerms(q: string): QueryTerm[] {
  const out = new Map<string, QueryTerm>();
  const add = (raw: string) => {
    const w = raw.replace(/^-+|-+$/g, "");
    const digits = /\p{N}/u.test(w);
    if (w.length < (digits ? 2 : 4) || STOP.has(w)) return;
    const stem = digits ? w : w.slice(0, Math.max(4, w.length - 2));
    if (!out.has(stem)) out.set(stem, { word: w, stem });
  };
  for (const w of lower(q).split(/[^\p{L}\p{N}-]+/u).filter(Boolean)) {
    add(w);
    if (w.includes("-")) for (const p of w.split("-")) add(p);
  }
  return [...out.values()].sort((a, b) => b.stem.length - a.stem.length);
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function termsRe(terms: readonly QueryTerm[]): RegExp | null {
  if (!terms.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map((t) => escRe(t.stem)).join("|")})[\\p{L}\\p{N}]*`, "giu");
}

export function trimAround(text: string, terms: readonly QueryTerm[], max = SNIPPET_CHARS): string {
  text = text.toWellFormed();
  if (text.length <= max) return text;
  const re = termsRe(terms);
  const at = re ? text.search(re) : -1;
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3));
  if (start > 0) { const sp = text.indexOf(" ", start); start = sp >= 0 && sp < (at < 0 ? start + 20 : at) ? sp + 1 : start; }
  let end = Math.min(text.length, start + max);
  if (end < text.length) { const sp = text.lastIndexOf(" ", end); if (sp > start + max / 2) end = sp; }
  if ((text.codePointAt(start - 1) ?? 0) > 0xffff) start--;
  if ((text.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  const lead = start > 0 && !text.slice(start).startsWith("…") ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${lead}${text.slice(start, end).replace(/[\s,;:—–-]+$/, "")}${tail}`;
}

export interface Segment { text: string; hit: boolean }

export function highlight(text: string, terms: readonly QueryTerm[]): Segment[] {
  const re = termsRe(terms);
  if (!re || !text) return text ? [{ text, hit: false }] : [];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (!m[0]) continue;
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

export function hitSnippet(h: Pick<Hit, "snippet" | "title">, terms: readonly QueryTerm[]): string {
  return trimAround(cleanSnippet(h.snippet ?? "", h.title), terms);
}

export function topScore(hits: ReadonlyArray<Pick<Hit, "score">>): number {
  const best = hits.reduce((max, { score }) =>
    typeof score === "number" && Number.isFinite(score) ? Math.max(max, score) : max, -Infinity);
  return best === -Infinity ? 0 : best;
}

export function splitHits<T extends Pick<Hit, "score">>(hits: readonly T[], mode: string, o: { top?: number; minShown?: number } = {}): { strong: T[]; weak: T[]; top: number } {
  if (mode === "recent") return { strong: [...hits], weak: [], top: 0 };
  const top = Math.max(topScore(hits), o.top ?? 0);
  if (top <= 0) return { strong: [...hits], weak: [], top: 0 };
  let k = 0;
  while (k < hits.length && typeof hits[k]!.score === "number" && hits[k]!.score! / top >= WEAK_SHARE) k++;
  k = Math.max(k, Math.min(o.minShown ?? MIN_SHOWN, hits.length));
  return { strong: hits.slice(0, k), weak: hits.slice(k), top };
}

export const lastSection = (section: string): string => section.split(" > ").map((x) => x.trim()).filter(Boolean).pop() ?? section.trim();

export function sourceText(h: Pick<Hit, "type" | "origin" | "locator">): string | null {
  const l = h.locator ?? null;
  const time = typeof l?.time_from === "number" && l.time_from >= 0 ? fmtTime(Math.floor(l.time_from)) : null;
  if (h.type === "transcript") return time ? M.meetingTranscript(time) : M.meetingTranscript2;
  if ((h.type === "event" || h.type === "summary") && time) return M.fromAMeeting(time);
  if (h.type === "profile") return h.origin === "human" ? M.workProfileWrittenByTheColleague : M.fromTheColleagueDirectory;
  const where = [
    l?.page ? M.p(l.page, l.page_to && l.page_to !== l.page ? `–${l.page_to}` : "") : null,
    l?.section ? M.section(lastSection(l.section)) : null,
  ].filter(Boolean).join(", ");
  if (h.type === "document" || h.origin === "document") return where ? M.fromADocument(where) : M.fromADocument2;
  if (h.origin === "agent") return where ? M.addedByAnAiAgent(where) : M.addedByAnAiAgent2;
  if (h.origin === "model") return where ? M.generatedAutomatically(where) : M.generatedAutomatically2;
  return where || null;
}

export function scoreHint(score: number | undefined, top: number): string | undefined {
  if (typeof score !== "number" || !(top > 0)) return undefined;
  return M.similarityOfTheBestMatch(Math.round((score / top) * 100));
}
