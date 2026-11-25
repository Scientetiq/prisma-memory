// Without diarization (srt, vtt without <v>, json without a speaker, a timeline line without a name) a turn gets the
// no-speaker label of the instance language: otherwise a leading "Summary:" or "Decided:" in a turn would be taken
// for a speaker name. Text without a single mark is accepted as is, with the warning `no_time_marks`: no time locators.

import { LOCALES, t } from "@memory/i18n";
import { currentLocale, tr, trInstance, withLocale } from "@memory/i18n/context";
import { M } from "./messages/transcript.ts";

export type TranscriptFormat = "marked" | "timeline" | "srt" | "vtt" | "json" | "plain";
export const TRANSCRIPT_FORMATS: readonly TranscriptFormat[] = ["marked", "timeline", "srt", "vtt", "json", "plain"];

/** The internal mark of a turn without a speaker: never stored, never shown — text and segments carry the label. */
export const NO_SPEAKER = "::no-speaker::";
/** The label of a turn without a speaker in the instance language: what the stored text and the segments carry. */
export const noSpeakerLabel = (): string => trInstance(M.noSpeaker);
/** True for the internal mark and for the label in any language of the catalogue (text stored under another one). */
export const isNoSpeakerLabel = (name: string): boolean =>
  name === NO_SPEAKER || LOCALES.some((locale) => name === withLocale(locale, () =>
    currentLocale() === locale ? tr(M.noSpeaker) : t(locale, M.noSpeaker)));

export const TIME_MARK = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/;
export const hasTimeMarks = (text: string): boolean => text.split("\n").some((l) => TIME_MARK.test(l));

export interface TranscriptSegment { start_sec: number; end_sec: number | null; speaker: string; text: string }
export interface NormalizedTranscript {
  format: TranscriptFormat;
  text: string;
  segments: TranscriptSegment[];
  changed: boolean;
  warnings: string[];
}

const MAX_SPEAKER = 40;

export function hhmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, "0")).join(":");
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
// An incoming speaker equal to the no-speaker label of any catalogue language means "no speaker" (the transcriber contract).
const cleanSpeaker = (s: string | null | undefined): string => {
  const v = oneLine(String(s ?? "")).replace(/:+$/, "").slice(0, MAX_SPEAKER).trim();
  return v && !isNoSpeakerLabel(v) ? v : NO_SPEAKER;
};
export const renderSegment = (s: TranscriptSegment): string =>
  `[${hhmmss(s.start_sec)}] ${s.speaker === NO_SPEAKER ? noSpeakerLabel() : s.speaker}: ${oneLine(s.text)}`;
export const renderTranscript = (segs: TranscriptSegment[]): string => segs.map(renderSegment).join("\n");

export function parseClock(raw: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0, mm = Number(m[2]), ss = Number(m[3]);
  if (ss > 59 || (m[1] && mm > 59)) return null;
  return h * 3600 + mm * 60 + ss;
}

function splitSpeaker(body: string): [string | null, string] {
  const m = /^([^:\n]{1,40}):(?!\/\/)\s*(.*)$/.exec(body.trim());
  return m ? [m[1]!.trim(), m[2]!] : [null, body.trim()];
}

const BRACKET = /^\s*\[((?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?)\]\s*(.*)$/;
const LEAD_TIME = /^\s*((?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?)\s*(?:[-–—|]\s*)?(.*)$/;
/** A line "Name Surname   00:01:02" above a turn (exports of meeting services such as Teams and Zoom). */
const SPEAKER_THEN_TIME = /^\s*([^\d:\n][^:\n]{0,39}?)\s{1,}\(?((?:\d{1,3}:)?\d{1,3}:\d{2})\)?\s*$/;
const CUE = /^\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function fromMarked(lines: string[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const line of lines) {
    const m = BRACKET.exec(line);
    const t = m ? parseClock(m[1]!) : null;
    if (m && t !== null) {
      const [speaker, text] = splitSpeaker(m[2]!);
      out.push({ start_sec: t, end_sec: null, speaker: cleanSpeaker(speaker), text });
    } else if (out.length && line.trim()) out[out.length - 1]!.text += " " + line.trim();
    else if (line.trim()) out.push({ start_sec: 0, end_sec: null, speaker: NO_SPEAKER, text: line.trim() });
  }
  return out;
}

function fromTimeline(lines: string[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let pending: { speaker: string; start: number } | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const head = SPEAKER_THEN_TIME.exec(line);
    const headT = head ? parseClock(head[2]!) : null;
    if (head && headT !== null) { pending = { speaker: cleanSpeaker(head[1]), start: headT }; continue; }
    const lead = LEAD_TIME.exec(line);
    const leadT = lead ? parseClock(lead[1]!) : null;
    if (lead && leadT !== null && lead[2]!.trim()) {
      const [speaker, text] = splitSpeaker(lead[2]!);
      out.push({ start_sec: leadT, end_sec: null, speaker: cleanSpeaker(speaker), text });
      pending = null;
    } else if (pending) {
      out.push({ start_sec: pending.start, end_sec: null, speaker: pending.speaker, text: line.trim() });
      pending = null;
    } else if (out.length) out[out.length - 1]!.text += " " + line.trim();
    else out.push({ start_sec: 0, end_sec: null, speaker: NO_SPEAKER, text: line.trim() });
  }
  return out;
}

function fromCues(lines: string[], vtt: boolean): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = CUE.exec(lines[i]!);
    if (!m) { i++; continue; }
    const start = parseClock(m[1]!), end = parseClock(m[2]!);
    const body: string[] = [];
    for (i++; i < lines.length && lines[i]!.trim() && !CUE.exec(lines[i]!); i++) body.push(lines[i]!);
    if (!vtt && body.length > 1 && /^\d+$/.test(body[body.length - 1]!.trim()) && i < lines.length && CUE.exec(lines[i]!)) body.pop();
    let speaker: string | null = null;
    let text = body.join(" ");
    if (vtt) {
      const v = /<v(?:\.[^\s<>]*)?\s+([^\s<>][^<>]*)>/.exec(text);
      if (v) speaker = v[1]!;
      text = text.replace(/<[^<>]+>/g, "");
    }
    text = oneLine(text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    if (start === null || !text) continue;
    out.push({ start_sec: start, end_sec: end, speaker: cleanSpeaker(speaker), text });
  }
  return out;
}

function jsonTime(o: Record<string, unknown>, keys: string[], msKeys: string[]): number | null {
  for (const k of msKeys) if (typeof o[k] === "number" && Number.isFinite(o[k])) return (o[k] as number) / 1000;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string") { const t = parseClock(v); if (t !== null) return t; const n = Number(v); if (v.trim() && Number.isFinite(n) && n >= 0) return n; }
  }
  return null;
}

function fromJson(raw: unknown): TranscriptSegment[] | null {
  const list = Array.isArray(raw) ? raw
    : raw && typeof raw === "object" ? (["segments", "utterances", "transcript", "transcription", "results", "items"].map((k) => (raw as any)[k]).find(Array.isArray) ?? null) : null;
  if (!list) return null;
  const out: TranscriptSegment[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const text = ["text", "transcript", "phrase", "content"].map((k) => o[k]).find((v) => typeof v === "string") as string | undefined;
    const start = jsonTime(o, ["start", "start_sec", "start_time", "from", "begin", "timestamp"], ["start_ms", "startMs", "begin_ms"]);
    if (!text?.trim() || start === null) continue;
    const end = jsonTime(o, ["end", "end_sec", "end_time", "to"], ["end_ms", "endMs"]);
    const sp = ["speaker", "speaker_name", "speakerName", "speaker_label", "name", "author"].map((k) => o[k]).find((v) => typeof v === "string" || typeof v === "number");
    out.push({ start_sec: start, end_sec: end, speaker: cleanSpeaker(sp === undefined ? null : String(sp)), text: oneLine(text) });
  }
  return out.length ? out.sort((a, b) => a.start_sec - b.start_sec) : null;
}

export function detectTranscriptFormat(text: string): TranscriptFormat {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const head = t.trimStart();
  if (/^WEBVTT\b/.test(head)) return "vtt";
  if (/^[[{]/.test(head)) { try { if (fromJson(JSON.parse(head))) return "json"; } catch { } }
  const lines = t.split("\n");
  if (lines.some((l) => CUE.test(l))) return "srt";
  if (lines.some((l) => { const m = BRACKET.exec(l); return m !== null && parseClock(m[1]!) !== null; })) return "marked";
  const timed = lines.filter((l) => { const a = LEAD_TIME.exec(l); const b = SPEAKER_THEN_TIME.exec(l); return (a !== null && !!a[2]!.trim() && parseClock(a[1]!) !== null) || (b !== null && parseClock(b[2]!) !== null); });
  if (timed.length >= 2) return "timeline";
  return "plain";
}

/** A profile parses cleaned input; rendering, end times and warnings stay shared. */
export type TranscriptProfile = (text: string) => Pick<NormalizedTranscript, "format" | "segments">;
const transcriptProfiles = new Map<TranscriptFormat | "auto", TranscriptProfile>();

/** Register an internal parser. The returned function restores the previous profile. */
export function registerTranscriptProfile(name: TranscriptFormat | "auto", parse: TranscriptProfile): () => void {
  const previous = transcriptProfiles.get(name);
  transcriptProfiles.set(name, parse);
  return () => { if (previous) transcriptProfiles.set(name, previous); else transcriptProfiles.delete(name); };
}

registerTranscriptProfile("marked", (text) => ({ format: "marked", segments: fromMarked(text.split("\n")) }));
registerTranscriptProfile("timeline", (text) => ({ format: "timeline", segments: fromTimeline(text.split("\n")) }));
registerTranscriptProfile("srt", (text) => ({ format: "srt", segments: fromCues(text.split("\n"), false) }));
registerTranscriptProfile("vtt", (text) => ({ format: "vtt", segments: fromCues(text.split("\n"), true) }));
registerTranscriptProfile("json", (text) => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("transcript in json format could not be parsed as JSON"); }
  const segments = fromJson(raw);
  if (!segments) throw new Error("transcript json: expected an array of utterances {start, end?, speaker?, text} or an object with a segments field");
  return { format: "json", segments };
});
registerTranscriptProfile("plain", () => ({ format: "plain", segments: [] }));
registerTranscriptProfile("auto", (text) => transcriptProfiles.get(detectTranscriptFormat(text))!(text));

export function normalizeTranscript(input: string, format: TranscriptFormat | "auto" = "auto"): NormalizedTranscript {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { format: fmt, segments: segs } = transcriptProfiles.get(format)!(text);
  if (fmt === "plain") {
    const warnings = hasTimeMarks(text) ? [] : ["no_time_marks"];
    return { format: "plain", text, segments: [], changed: text !== input, warnings };
  }
  if (!segs.length) throw new Error(`${fmt} transcript: no utterances with timestamps`);
  for (let i = 0; i < segs.length; i++) if (segs[i]!.end_sec === null && i + 1 < segs.length) segs[i]!.end_sec = segs[i + 1]!.start_sec;
  const warnings: string[] = [];
  if (segs.every((s) => s.speaker === NO_SPEAKER)) warnings.push("no_speakers");
  const label = noSpeakerLabel();
  const segments = segs.map((s) => s.speaker === NO_SPEAKER ? { ...s, speaker: label } : s);
  const out = renderTranscript(segments);
  return { format: fmt, text: out, segments, changed: out !== input, warnings };
}
