// Text of the memory_me answer — shared by gateway and edge.
// The first minute of a session — after the line about the person, the key and the spaces, the spaces one per line
// ("slug · role · what goes here"), where the notes of this key go, the latest personal notes and what to call next. The
// words of the people (space names and descriptions, note titles) stand inside data blocks; the server words outside.
import { asData } from "./markers.ts";
import type { McpTexts } from "./texts/index.ts";

/** At most this many spaces in the text of memory_me; the rest — one line "+N more: memory_list /spaces". */
export const ME_SPACES_MAX = 12;
/** "What goes here" of a space and the title of a note in the text of memory_me: at most this many characters. */
export const ME_ABOUT_MAX = 80;
/** At most this many latest personal notes. */
export const ME_NOTES_MAX = 3;

/** A space in the text of memory_me: its slug (`me` — the caller's own personal space), role and what goes here. */
export interface MeSpaceLine { slug: string; role: string; about: string | null }
/** A latest personal note: the day (YYYY-MM-DD), the path memory_read takes, the title. */
export interface MeNoteLine { date: string; path: string; title: string }

/**
 * The first-minute part of memory_me. `until` — the end of the key's access (YYYY-MM-DD), a mark of the first line;
 * `spaces` — in the order to print; `notes_to` — where memory_remember puts a note of this key (null — no such line: a
 * service, or a key that writes nowhere); `notes` — the newest first; `next` — which of the next calls the key may make.
 */
export interface MeFirstMinute {
  until?: string | null;
  spaces: readonly MeSpaceLine[];
  notes_to?: { slug: string; class: "open" | "closed" } | null;
  notes: readonly MeNoteLine[];
  next: { search: boolean; list: boolean };
}

/**
 * What memory_me prints. `key_marks` — parts of the access line after «name (login)» (gateway: key kind, level, script
 * key, service on behalf, writes to open; edge: the connection), with no leading « · »; empty ones are skipped.
 * `warning` — the access term warning, on its own line. `first_minute` — the lines after them; absent — the
 * text of 0.27.0 byte for byte.
 */
export interface MeView {
  display_name: string; login: string; key_marks: readonly string[]; spaces: number; archived_spaces: number; warning?: string | null;
  first_minute?: MeFirstMinute;
}

/** One line of record words: line breaks and runs of white space as one space, at most `max` characters (then "…"). */
function oneLine(s: string, max = ME_ABOUT_MAX): string {
  const flat = s.replace(/\s+/gu, " ").trim(), chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The lines after the first one (and the warning): spaces, where notes go, the latest notes, the next calls. */
function firstMinuteLines(f: MeFirstMinute, texts: McpTexts): string[] {
  const t = texts.me, out: string[] = [];
  if (f.spaces.length) {
    const shown = f.spaces.slice(0, ME_SPACES_MAX);
    out.push(t.spacesHeading, asData(shown.map((s) => [s.slug, s.role, s.about ? oneLine(s.about) : ""].filter(Boolean).join(" · ")).join("\n"), { texts }));
    if (f.spaces.length > shown.length) out.push(t.moreSpaces(f.spaces.length - shown.length));
  }
  if (f.notes_to) out.push(t.notesTo(f.notes_to.slug, f.notes_to.class));
  const notes = f.notes.slice(0, ME_NOTES_MAX);
  if (notes.length) out.push(t.notesHeading, asData(notes.map((n) => `${n.date} · ${n.path} · ${oneLine(n.title)}`).join("\n"), { texts }));
  const next = t.next(f.next.search, f.next.list);
  if (next) out.push(next);
  return out;
}

/**
 * One line joined by « · »: «name (login)», access parts, «spaces: N», «archived: N» (if any) and the caller's parts
 * (`extras`, no leading « · »; empty ones skipped); then the warning. With `first_minute` the line also says
 * when the access ends (after the key marks), and the first-minute lines follow the warning.
 */
export function meText(view: MeView, extras: readonly string[], texts: McpTexts): string {
  const f = view.first_minute;
  const line = [`${view.display_name} (${view.login})`, ...view.key_marks, f?.until ? texts.me.until(f.until) : "", texts.me.spaces(view.spaces),
                view.archived_spaces ? texts.me.archived(view.archived_spaces) : "", ...extras].filter(Boolean).join(" · ");
  return [`${line}${view.warning ? `\n${view.warning}` : ""}`, ...(f ? firstMinuteLines(f, texts) : [])].join("\n");
}
