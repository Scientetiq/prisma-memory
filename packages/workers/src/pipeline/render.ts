import { pipelineText } from "./verify.ts";
const { PY_DIGIT_CLASS, pyDivmod, pyInt, pyRstrip, pyStrip, pyTruthy } = pipelineText.pytext;

const D = PY_DIGIT_CLASS;
const TIME = new RegExp(`^([${D}]{1,3}):([${D}]{2})(?::([${D}]{2}))?$`, "u");

export function timeToSec(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = TIME.exec(pyStrip(label));
  if (!m) return null;
  const [, a, b, c] = m as unknown as [string, string, string, string | undefined];
  return c !== undefined ? pyInt(a) * 3600 + pyInt(b) * 60 + pyInt(c) : pyInt(a) * 60 + pyInt(b);
}

export function anchor(label: string | null | undefined): string {
  const sec = timeToSec(label);
  return sec !== null ? `#t-${sec}` : "";
}

function timeLink(label: string | null | undefined): string {
  if (!label) return "";
  const a = anchor(label);
  return a ? `[${label}](${a})` : `[${label}]`;
}

export interface SummaryTopic {
  title: string;
  summary: string;
  time_from: string;
  time_to?: string | null;
}

export interface SummaryPoint {
  text: string;
  time_from: string;
}

export interface SummaryAction extends SummaryPoint {
  owner?: string | null;
  due?: string | null;
}

export interface SummaryMention {
  text: string;
  kind: string;
}

export interface SummaryData {
  headline: string;
  topics?: SummaryTopic[] | null;
  decisions?: SummaryPoint[];
  actions?: SummaryAction[];
  questions_risks?: SummaryPoint[];
  mentions?: SummaryMention[] | null;
  language?: string;
  notes?: string | null;
}

export interface RenderSummaryOptions {
  title: string;
  dateLabel: string;
  transcriptPath?: string | null;
}

/** A required key: a missing one is an error, like `KeyError` in the reference implementation. */
function req<T extends object, K extends keyof T & string>(obj: T, key: K): NonNullable<T[K]> {
  if (!(key in obj)) throw new TypeError(`the model answer has no required field ${key}`);
  return obj[key] as NonNullable<T[K]>;
}

// The same words as the reference implementation of the renderer.
const NOTHING = "- nothing recorded";
const MENTION_KINDS: Readonly<Record<string, string>> = Object.freeze({
  company: "companies", deal: "deals", person: "people", project: "projects", document: "documents", other: "other",
});
export const ACTIONS_HEADING = "## Actions and agreements";

/** Markdown of a `summary` record. An empty section says "nothing recorded", so an agent sees there is nothing to look for. */
export function renderSummary(data: SummaryData, options: RenderSummaryOptions): string {
  const { title, dateLabel, transcriptPath } = options;
  const lines: string[] = [`# Summary: ${title} (${dateLabel})`, ""];
  if (transcriptPath) lines.push(`Source: transcript \`${transcriptPath}\`; the time marks link to its fragments.`, "");
  lines.push("## Outcome", "", pyStrip(req(data, "headline")), "");

  lines.push("## Topics discussed", "");
  if (pyTruthy(data.topics)) {
    for (const tp of data.topics as SummaryTopic[]) {
      const span = timeLink(req(tp, "time_from")) + (tp.time_to ? `–${tp.time_to}` : "");
      lines.push(`- **${pyStrip(req(tp, "title"))}** ${span}: ${pyStrip(req(tp, "summary"))}`);
    }
  } else {
    lines.push(NOTHING);
  }
  lines.push("");

  const points = (items: SummaryPoint[] | undefined): string[] => {
    const out = (items ?? []).map((d) => `- ${pyStrip(req(d, "text"))} ${timeLink(req(d, "time_from"))}`);
    return out.length ? out : [NOTHING];
  };

  lines.push("## Decisions", "", ...points(data.decisions), "");

  lines.push(ACTIONS_HEADING, "");
  const acts = (data.actions ?? []).map((a) => {
    const who = a.owner ? ` — ${a.owner}` : "";
    const due = a.due ? `, due date: ${a.due}` : "";
    return `- ${pyStrip(req(a, "text"))}${who}${due} ${timeLink(req(a, "time_from"))}`;
  });
  lines.push(...(acts.length ? acts : [NOTHING]), "");

  lines.push("## Open questions and risks", "", ...points(data.questions_risks), "");

  lines.push("## Companies, projects and documents mentioned", "");
  if (pyTruthy(data.mentions)) {
    const byKind = new Map<string, string[]>();
    for (const m of data.mentions as SummaryMention[]) {
      const kind = req(m, "kind");
      const text = req(m, "text");
      let items = byKind.get(kind);
      if (!items) byKind.set(kind, (items = []));
      if (!items.includes(text)) items.push(text);
    }
    for (const [kind, items] of byKind) {
      lines.push(`- ${Object.hasOwn(MENTION_KINDS, kind) ? MENTION_KINDS[kind] : kind}: ${items.join(", ")}`);
    }
  } else {
    lines.push(NOTHING);
  }
  lines.push("");
  if (data.notes) lines.push("## Notes on the source", "", pyStrip(data.notes), "");
  return pyRstrip(lines.join("\n")) + "\n";
}

export type RenderableEvent = pipelineText.RenderableEvent;
export const { renderEvent, eventTimeLabel, actorsLabel } = pipelineText;

// ---------------------------------------------------------------- the actions section built from the action cards

export interface ActionCard { title: string | null; actors?: readonly unknown[] | null; due?: unknown; time_from?: number | null }

/**
 * Lines of the summary's actions section from the action cards of a meeting, written as in renderSummary:
 * "- text — who, due date: … [mm:ss](#t-sec)". Ordered by time, cards without a time last, equal times as given; no lines —
 * "nothing recorded". Port of the Python reference.
 */
export function summaryActionLines(cards: readonly ActionCard[]): string[] {
  const order = cards.map((c, i) => ({ c, i })).sort((a, b) => {
    const ta = a.c.time_from ?? null, tb = b.c.time_from ?? null;
    if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
    return (ta ?? 0) - (tb ?? 0) || a.i - b.i;
  });
  const out: string[] = [];
  for (const { c } of order) {
    const title = pyStrip(c.title ?? "");
    if (!title) continue;
    const actors = (c.actors ?? []).map((a) => pyStrip(String(a))).filter(Boolean);
    const who = actors.length ? ` — ${actors.join(", ")}` : "";
    const due = typeof c.due === "string" && pyStrip(c.due) ? `, due date: ${pyStrip(c.due)}` : "";
    const mark = typeof c.time_from === "number" ? ` [${eventTimeLabel(c.time_from)}](#t-${Math.trunc(c.time_from)})` : "";
    out.push(`- ${title}${who}${due}${mark}`);
  }
  return out.length ? out : [NOTHING];
}

/** The summary with its actions section (the heading at the start of a line) replaced by `lines`; without it, unchanged. Port of the Python reference. */
export function replaceActionsSection(md: string, lines: readonly string[]): string {
  const marker = `${ACTIONS_HEADING}\n`;
  let head = md.indexOf(marker);
  if (head > 0 && md[head - 1] !== "\n") {
    const lineBreak = md.indexOf(`\n${marker}`, head);
    head = lineBreak < 0 ? -1 : lineBreak + 1;
  }
  if (head < 0) return md;
  const body = head + marker.length;
  const next = md.indexOf("\n## ", body);
  const tail = next >= 0 ? md.slice(next + 1) : "";
  return md.slice(0, body) + "\n" + lines.join("\n") + "\n" + (tail ? "\n" + tail : "");
}
