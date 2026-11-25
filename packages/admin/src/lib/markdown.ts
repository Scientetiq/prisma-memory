import { text as M } from "../messages/markdown";
import { dueLooksPast, DUE_CHECK_COPY } from "./due-check";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const anchorOf = (title: string): string => title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";

const PAGE = /^\s*<!--\s*page:\s*(\d+)\s*-->\s*$/;
const WS = /\s/, LINE_BREAK = /[\n\r\u2028\u2029]/;
export const TABLE_SEP = /^\s*(?:\|\s*)?:?-{2,}/;
const TS = /^\s*\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]\s?/;
const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;

const noEmph = (s: string): string => s.replace(/\*/g, "&#42;").replace(/_/g, "&#95;")
  .replace(/~~/g, "&#126;&#126;").replace(/==/g, "&#61;&#61;").replace(/\[\[/g, "&#91;&#91;").replace(/\[\^/g, "&#91;^");

const LIT0 = 0xe000, BR = "\ue080", LIT_ANY = /[\ue000-\ue080]/g;
const ENTITY_NAMED: Readonly<Record<string, string>> = { nbsp: "\u00a0", amp: "&", lt: "<", gt: ">", quot: '"' };
function entityChar(body: string): string | null {
  if (body[0] !== "#") return ENTITY_NAMED[body] ?? null;
  const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!Number.isInteger(cp) || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= LIT0 && cp <= 0xe080) || cp > 0x10ffff) return null;
  return String.fromCodePoint(cp);
}
const lit = (ch: string): string => (ch.length === 1 && ch.charCodeAt(0) < 0x80 ? String.fromCharCode(LIT0 + ch.charCodeAt(0)) : ch);
const LITERAL = /`[^`]+`|\\([!-/:-@\[-`{-~])|<[bB][rR][ \t]*\/?>|&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|nbsp|amp|lt|gt|quot);/g;
function literals(text: string, plain = false): string {
  const t = text.replace(LIT_ANY, "\ufffd");
  if (plain || !/[\\&<]/.test(t)) return t;
  return t.replace(LITERAL, (m: string, ch: string | undefined, ent: string | undefined) => {
    if (m[0] === "`") return m;
    if (ch !== undefined) return lit(ch);
    if (ent !== undefined) { const c = entityChar(ent); return c === null ? m : lit(c); }
    return BR;
  });
}
const unliterals = (s: string): string => s.replace(LIT_ANY, (c) => (c === BR ? "<br>" : `&#${c.charCodeAt(0) - LIT0};`));

type TimeLink = ((sec: number) => string) | null;

const NOTE_REF = /\[\^([^\]\s]{1,20})\]/g, NOTE_DEF = /^ {0,3}\[\^([^\]\s]{1,20})\]:/;
function noteLabels(lines: readonly string[], plain: boolean): ReadonlySet<string> {
  const out = new Set<string>();
  for (const l of lines) { const m = NOTE_DEF.exec(l); if (m) out.add(esc(literals(m[1]!, plain))); }
  return out;
}
interface InlineOptions { timeLink?: TimeLink; notes?: ReadonlySet<string>; plain?: boolean }

export function replaceLinks(s: string, cb: (t: string, href: string, image: boolean) => string, o: { images?: boolean } = {}): string {
  let p = s.indexOf("[");
  if (p === -1) return s;
  const n = s.length, nextClose = new Int32Array(n + 1), nextStop = new Int32Array(n + 1);
  nextClose[n] = n; nextStop[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = s[i]!;
    nextClose[i] = c === "]" ? i : nextClose[i + 1]!;
    nextStop[i] = c === ")" || WS.test(c) ? i : nextStop[i + 1]!;
  }
  let out = "", last = 0;
  while (p !== -1) {
    const q = nextClose[p + 1]!;
    const image = o.images === true && p > last && s[p - 1] === "!";
    if ((q > p + 1 || (image && q === p + 1)) && q + 1 < n && s[q + 1] === "(") {
      const r = nextStop[q + 2]!;
      if (r > q + 2 && r < n && s[r] === ")") {
        out += s.slice(last, image ? p - 1 : p) + cb(s.slice(p + 1, q), s.slice(q + 2, r), image);
        last = r + 1; p = s.indexOf("[", last); continue;
      }
    }
    p = s.indexOf("[", p + 1);
  }
  return last === 0 ? s : out + s.slice(last);
}

function inline(text: string, o: InlineOptions = {}): string {
  const timeLink = o.timeLink;
  let s = esc(literals(text, o.plain === true));
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${noEmph(c)}</code>`);
  s = s.replace(/\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g, (_m, a: string, b: string | undefined) => (b ?? a).trim());
  s = replaceLinks(s, (t, href, image) => {
    if (image) return t.trim() ? M.image(t) : M.image2;
    const tm = /^#t-(\d{1,6})$/.exec(href);
    if (tm && timeLink !== undefined) return timeLink === null ? t : `<a href="${noEmph(esc(timeLink(Number(tm[1]))))}">${t}</a>`;
    return SAFE_HREF.test(href) ? `<a href="${noEmph(href)}" rel="noopener noreferrer"${href.startsWith("#") ? "" : ' target="_blank"'}>${t}</a>` : t;
  }, { images: true });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  if (o.notes?.size) s = s.replace(NOTE_REF, (m, l: string) => (o.notes!.has(l) ? `<sup>${l}</sup>` : m));
  s = s.replace(/~~(?=[^\s~])([^~\n]*[^\s~])~~/g, "<del>$1</del>");
  s = s.replace(/==(?=[^\s=])([^=\n]*[^\s=])==/g, "<mark>$1</mark>");
  return unliterals(s);
}

export function headingOf(line: string): { level: number; title: string } | null {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level < 1 || level > 6) return null;
  let i = level, j = line.length;
  while (i < j && WS.test(line[i]!)) i++;
  if (i === level) return null;
  while (j > i && WS.test(line[j - 1]!)) j--;
  while (j > i && line[j - 1] === "#") j--;
  while (j > i && WS.test(line[j - 1]!)) j--;
  const title = line.slice(i, j);
  return LINE_BREAK.test(title) ? null : { level, title };
}

export function listItemOf(line: string): { ordered: boolean; text: string } | null {
  const n = line.length;
  let i = 0;
  while (i < n && WS.test(line[i]!)) i++;
  let ordered: boolean;
  const c = line[i];
  if (c === "-" || c === "*" || c === "+") { ordered = false; i++; }
  else {
    const d = i;
    while (i < n && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i === d || (line[i] !== "." && line[i] !== ")")) return null;
    ordered = true; i++;
  }
  const w = i;
  while (i < n && WS.test(line[i]!)) i++;
  if (i === w) return null;
  const text = line.slice(i);
  return LINE_BREAK.test(text) ? null : { ordered, text };
}

export function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 2, "0")}:${String(s).padStart(2, "0")}`;
}

const NUM_CELL = /^[+\u2212-]?[$€₽]?\s?\d[\d\s\u00a0\u202f.,]*\s?(?:%|₽|\$|€|руб\.?|р\.|тыс\.?|млн\.?|млрд\.?)?$/iu;
export const isNumberCell = (cell: string): boolean => NUM_CELL.test(cell.trim());

function labelSec(label: string): number | null {
  const p = label.split(":").map(Number);
  if (p.some((x) => !Number.isInteger(x))) return null;
  return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p.length === 2 ? p[0]! * 60 + p[1]! : null;
}

export const titleNorm = (x: string): string => x.replace(/\s+/g, " ").replace(/ \(\d{4}-\d{2}-\d{2}\) ?$/, "").trim().toLowerCase();

function sameTitle(heading: string, title: string): boolean {
  return Boolean(title.trim()) && titleNorm(heading) === titleNorm(title);
}

export const isPlainTextMime = (mime: string | null | undefined): boolean => /^text\/plain\s*(?:;|$)/i.test(mime ?? "");

export interface RenderOptions {
  frontmatter?: boolean;
  dropTitle?: string | null;
  timeLink?: TimeLink;
  occurredAt?: string | null;
  plain?: boolean;
  shift?: number;
}

const ACTIONS_SECTION = "actions and agreements";
const TASK = /^\[([ xX])\][ \t]+/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const FENCE_OPEN = /^\s*(```|~~~)/;
/** The due date of a line of the summary actions section: "…, due date: X [05:00](#t-300)" (workers pipeline/render.ts). */
const ACTION_DUE = /, due date: (.+?)(?:\s+\[[^\]]*\](?:\([^)]*\))?)?\s*$/u;

export function renderMarkdown(src: string, type = "document", o: RenderOptions = {}): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const seen = new Map<string, number>(), used = new Set<string>();
  let i = 0, para: string[] = [], list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let section = "", first = true;
  const io: InlineOptions = { timeLink: o.timeLink, notes: noteLabels(lines, o.plain === true), plain: o.plain === true };
  const inl = (x: string) => inline(x, io);
  const uniqueAnchorOf = (title: string): string => {
    const base = anchorOf(title);
    let n = seen.get(base) ?? 0, id: string;
    do { n++; id = n > 1 ? `${base}-${n}` : base; } while (used.has(id));
    seen.set(base, n); used.add(id);
    return id;
  };
  const dueMark = '<span class="chip amber due-check" title="' + esc(DUE_CHECK_COPY.dueCheckHint) + '">' + DUE_CHECK_COPY.dueCheck + "</span>";

  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inl).join(" ")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${x}</li>`).join("")}</${list.tag}>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) { if (o.frontmatter !== false) out.push(`<pre class="frontmatter">${esc(lines.slice(1, end).join("\n"))}</pre>`); i = end + 1; }
  }
  while (i < lines.length) {
    const l = lines[i]!;
    const atStart = first;
    if (!/^\s*$/.test(l)) first = false;
    const fm = FENCE_OPEN.exec(l);
    if (fm) {
      flush();
      const close = fm[1] === "```" ? /^\s*```/ : /^\s*~~~/;
      const buf: string[] = []; i++;
      const targets: string[] = [];
      let gwFence = false;
      while (i < lines.length && !close.test(lines[i]!)) {
        const b = lines[i++]!;
        if (fm[1] === "~~~") {
          if (/^\s*```/.test(b)) gwFence = !gwFence;
          const h = gwFence ? null : headingOf(b);
          if (h) targets.push(`<span id="${esc(uniqueAnchorOf(h.title))}"></span>`);
        }
        buf.push(b);
      }
      i++;
      out.push(`${targets.join("")}<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const pm = PAGE.exec(l);
    if (pm) { flush(); out.push(M.page(pm[1], pm[1])); i++; continue; }
    const hm = headingOf(l);
    if (hm) {
      flush();
      const id = uniqueAnchorOf(hm.title);
      if (atStart && o.dropTitle && sameTitle(hm.title, o.dropTitle)) { out.push(`<span id="${esc(id)}"></span>`); i++; continue; }
      if (hm.level <= 2) section = hm.title.trim().toLowerCase();
      const lvl = Math.min(6, hm.level + Math.max(0, Math.trunc(o.shift ?? 0)));
      out.push(`<h${lvl} id="${esc(id)}">${inl(hm.title)}</h${lvl}>`); i++; continue;
    }
    if (/^\s*$/.test(l)) { flush(); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { flush(); out.push("<hr>"); i++; continue; }
    if (/^\s*>\s?/.test(l)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      buf[0] = buf[0]!.replace(/^\[![A-Za-z-]{1,20}\][+-]?[ \t]*/, "");
      let q = buf.map(inl).join(" ");
      if (type === "event" && o.timeLink !== undefined) q = q.replace(/\((\d{1,2}:\d{2}(?::\d{2})?)\)$/, (m, label: string) => {
        const sec = labelSec(label);
        return sec === null || !o.timeLink ? m : `(<a href="${noEmph(esc(o.timeLink(sec)))}" class="ts-link">${label}</a>)`;
      });
      out.push(`<blockquote><p>${q}</p></blockquote>`); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const raw = (row: string) => row.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const head = raw(l).map(inl); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(raw(lines[i++]!));
      const td = (c: string) => (isNumberCell(c) ? `<td class="num">${inl(c)}</td>` : `<td>${inl(c)}</td>`);
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map(td).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const lm = listItemOf(l);
    if (lm) {
      flushPara();
      const tag: "ul" | "ol" = lm.ordered ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      const due = type === "summary" && o.occurredAt && section === ACTIONS_SECTION && lm.text.length <= 2000 ? ACTION_DUE.exec(lm.text)?.[1] : null;
      const task = TASK.exec(lm.text);
      const item = task ? `${task[1] === " " ? "☐" : "☑"} ${inl(lm.text.slice(task[0].length))}` : inl(lm.text);
      list.items.push(item + (due && dueLooksPast(due, o.occurredAt) ? ` ${dueMark}` : "")); i++; continue;
    }
    if (type === "transcript") {
      const tm = TS.exec(l);
      if (tm) {
        flush();
        const sec = Number(tm[1] ?? 0) * 3600 + Number(tm[2]) * 60 + Number(tm[3]);
        out.push(`<p><span class="ts" id="t-${sec}">[${fmtTime(sec)}]</span>${inl(l.slice(tm[0].length))}</p>`); i++; continue;
      }
    }
    if (i + 1 < lines.length && SETEXT.test(lines[i + 1]!)) {
      flushList();
      const title = [...para, l.trim()].join(" "), alone = para.length === 0;
      para = [];
      i += 2;
      if (alone && atStart && o.dropTitle && sameTitle(title, o.dropTitle)) continue;
      const level = lines[i - 1]!.includes("=") ? 1 : 2;
      if (level <= 2) section = title.trim().toLowerCase();
      const lvl = Math.min(6, level + Math.max(0, Math.trunc(o.shift ?? 0)));
      out.push(`<h${lvl}>${inl(title)}</h${lvl}>`);
      continue;
    }
    flushList();
    para.push(l.trim()); i++;
  }
  flush();
  return out.join("\n");
}
