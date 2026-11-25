import { hasTimeMarks, instanceLocaleOf, invalid, noSpeakerLabel, normalizeTranscript, renderTranscript, tooLarge, TRANSCRIPT_FORMATS, type TranscriptFormat } from "@memory/shared";

/** Service on behalf of a person, personal MCP agent, or personal REST script. */
export type MeetingChannel = "service" | "agent" | "script";

/** One participant limit for ingest, checks and workplace edits. Removing people is allowed for meetings of any size. */
export const MEETING_MAX_PARTICIPANTS = 200;

/** Meeting description fields the ticket stores (the text and segments come as a file). */
export const MEETING_HEAD_FIELDS = ["meeting_id", "started_at", "initiator", "title", "participants", "entities", "attrs", "format", "consent", "audio_object_key", "duration_sec", "language"] as const;

/** Record-owned attrs cannot be supplied by a client. */
export const RESERVED_ATTRS = new Set(["process_now_at", "extraction", "pipeline_mentions", "confidence", "mentions", "access", "filename", "meeting_id", "participants", "participants_pending", "participants_unresolved", "participants_left", "audio_object_key", "segments", "channel", "transcript_format", "consent", "deferred_reason", "deferred_to_night_at",
  "participants_meta", "process_now_by", "origin", "speakers", "participants_unconfirmed", "source_participants"]);

/**
 * Assistant marks are stored only for transcriber ingest. They do not change participant resolution,
 * access or warnings. Other clients keep the existing string-only path.
 */
export interface ParticipantMeta { name: string; is_agent: true }

// Diarization segments.
/** Transcriber-only assistant marker, stored as supplied. */
export interface Segment { start_sec: number; end_sec: number; speaker: string | null; text: string; is_agent?: boolean }

/** Segments are validated and stored in record metadata; malformed input is refused. */
export function parseSegments(raw: unknown, o: { agentMarks?: boolean } = {}): Segment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("segments: an array of segments {start_sec, end_sec, speaker?, text}");
  if (raw.length > 20_000) throw invalid("segments: at most 20,000 segments");
  return raw.map((s: any, i: number) => {
    const start = Number(s?.start_sec), end = Number(s?.end_sec);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < 0) throw invalid(`segments[${i}]: start_sec and end_sec are seconds from the start of the meeting`);
    if (typeof s?.text !== "string" || !s.text.trim()) throw invalid(`segments[${i}]: a non-empty text is required`);
    if (s.speaker !== undefined && s.speaker !== null && typeof s.speaker !== "string") throw invalid(`segments[${i}]: speaker is a string or null`);
    // Other clients do not read assistant marks.
    if (o.agentMarks && s.is_agent !== undefined && typeof s.is_agent !== "boolean") throw invalid(`segments[${i}]: is_agent is true or false`);
    return { start_sec: start, end_sec: end, speaker: s.speaker ?? null, text: String(s.text), ...(o.agentMarks && typeof s.is_agent === "boolean" ? { is_agent: s.is_agent } : {}) };
  });
}

/** Strict transcriber participant object; its name follows the same path as a string participant. */
function participantObject(raw: Record<string, unknown>, i: number): { name: string; isAgent: boolean } {
  const extra = Object.keys(raw).filter((k) => k !== "name" && k !== "is_agent");
  if (extra.length || typeof raw.name !== "string" || typeof raw.is_agent !== "boolean")
    throw invalid(`participants[${i}]: a participant is a string (login, e-mail or full name) or an object {name, is_agent}: name is a string of up to 200 characters, is_agent is true or false`);
  const name = raw.name.replace(/\s+/g, " ").trim();
  if (!name) throw invalid(`participants[${i}]: the name of a participant object cannot be empty`);
  return { name, isAgent: raw.is_agent };
}

// Common internal meeting envelope.
export interface MeetingEnvelope {
  meetingRef: string; startedAt: Date; initiator: string | null; title: string | null; text: string;
  participants: string[]; entities: string[]; segments: Segment[]; attrs: Record<string, unknown>;
  /** Transcriber-marked assistants, stored only in attrs.participants_meta. */
  participantsMeta?: ParticipantMeta[];
  audioObjectKey: string | null; durationSec: number | null;
  /** Language the request names for the transcript; null when it names none (see meetingLanguage). */
  language: string | null;
  /** Source format and normalization warnings. */
  format: TranscriptFormat | "segments"; warnings: string[];
  /** Source text retained when canonical text differs. */
  original: { text: string; mime: string; ext: string } | null;
  /** Unmodified consent, checked against settings by acceptMeeting. */
  consent: unknown;
}

/** Compatibility name for existing internal callers. */
export type MeetingInput = MeetingEnvelope;

/**
 * Language stored with a meeting: the one the request names; when it names none, the language of the installation
 * (setting locale.language; English when that setting has no value).
 */
export function meetingLanguage(m: Pick<MeetingEnvelope, "language">, settings: { get<T>(path: string, fallback: T): T }): string {
  return m.language ?? instanceLocaleOf(settings);
}

const ORIGINAL_TYPE: Record<string, { mime: string; ext: string }> = {
  marked: { mime: "text/plain", ext: "txt" }, timeline: { mime: "text/plain", ext: "txt" }, plain: { mime: "text/plain", ext: "txt" },
  segments: { mime: "text/plain", ext: "txt" }, srt: { mime: "application/x-subrip", ext: "srt" }, vtt: { mime: "text/vtt", ext: "vtt" }, json: { mime: "application/json", ext: "json" },
};

/**
 * Parse the existing TranscriptIngest body. Normalize text or render supplied segments when text has no time marks.
 * A service must supply its initiator; personal clients get their owner from the key.
 */
export function parseMeetingBody(b: any, o: { initiatorRequired: boolean; agentMarks?: boolean }): MeetingEnvelope {
  const head = parseMeetingHead(b, o);
  if (typeof b.text !== "string" || !b.text.trim()) throw invalid("Required field: text");
  return withMeetingText(head, b.text, b.segments, { agentMarks: o.agentMarks === true });
}

/** Metadata validated before text arrives, including when issuing an upload ticket. */
export type MeetingHead = Omit<MeetingEnvelope, "text" | "segments" | "format" | "warnings" | "original"> & { formatHint: TranscriptFormat | "auto" };

/** Bound raw input before deduplication, with room above the unique-participant limit. */
export const PARTICIPANTS_RAW_MAX = 1000;

/** Keep titles on one line: they appear outside the source data block in model input. */
export const oneLineTitle = (v: unknown): string | null => String(v ?? "").replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, 300) || null;

/** Enable assistant marks only for transcriber ingest; upload tickets and MCP retain the old parsing rules. */
export function parseMeetingHead(b: any, o: { initiatorRequired: boolean; agentMarks?: boolean }): MeetingHead {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("The request body must be a JSON object");
  for (const k of ["meeting_id", "started_at", ...(o.initiatorRequired ? ["initiator"] : [])])
    if (typeof b[k] !== "string" || !b[k].trim()) throw invalid(`Required field: ${k}`);
  if (typeof b.text === "string" && b.text.length > 2_000_000) throw tooLarge("text is longer than 2,000,000 characters");  // Existing contract bound.
  // Normalize logins and whitespace while preserving display-name casing.
  // Bound raw input and stop at the first participant over the unique limit.
  const rawParticipants: unknown[] = Array.isArray(b.participants) ? b.participants : [];
  if (rawParticipants.length > PARTICIPANTS_RAW_MAX) throw invalid(`participants: at most ${MEETING_MAX_PARTICIPANTS}`);
  const participants: string[] = [], seen = new Set<string>(), agents = new Set<string>();
  for (const [i, raw] of rawParticipants.entries()) {
    const obj = o.agentMarks && raw !== null && typeof raw === "object" && !Array.isArray(raw) ? participantObject(raw as Record<string, unknown>, i) : null;
    const v = obj ? obj.name : String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!v) continue;
    if (v.length > 200) throw invalid("participants: an item is at most 200 characters long");
    const x = v.includes("@") && !v.includes(" ") ? v.toLowerCase() : v;
    // Preserve a mark on any occurrence of a deduplicated participant.
    if (obj?.isAgent) agents.add(x.toLowerCase());
    if (seen.has(x.toLowerCase())) continue;
    seen.add(x.toLowerCase());
    participants.push(x);
    if (participants.length > MEETING_MAX_PARTICIPANTS) throw invalid(`participants: at most ${MEETING_MAX_PARTICIPANTS}`);
  }
  const participantsMeta: ParticipantMeta[] = participants.filter((p) => agents.has(p.toLowerCase())).map((name) => ({ name, is_agent: true as const }));
  if (Array.isArray(b.entities) && b.entities.length > 20) throw invalid("entities: at most 20");
  const entities: string[] = Array.isArray(b.entities) ? b.entities.map(String) : [];
  const startedAt = new Date(b.started_at);
  if (Number.isNaN(startedAt.getTime())) throw invalid("started_at is not a valid date");
  const fmt = b.format === undefined || b.format === null ? "auto" : String(b.format);
  if (fmt !== "auto" && !(TRANSCRIPT_FORMATS as readonly string[]).includes(fmt)) throw invalid(`format: auto, ${TRANSCRIPT_FORMATS.join(", ")}`);
  // Source attributes cannot replace record-owned metadata.
  const attrs = Object.fromEntries(Object.entries((b.attrs && typeof b.attrs === "object" && !Array.isArray(b.attrs)) ? b.attrs : {}).filter(([k]) => !RESERVED_ATTRS.has(k)).slice(0, 50));
  return {
    meetingRef: b.meeting_id, startedAt, initiator: typeof b.initiator === "string" && b.initiator.trim() ? b.initiator.trim().toLowerCase() : null,
    title: oneLineTitle(b.title),
    participants, participantsMeta, entities, attrs, formatHint: fmt as TranscriptFormat | "auto",
    consent: b.consent,
    audioObjectKey: b.audio_object_key ? String(b.audio_object_key) : null,
    durationSec: typeof b.duration_sec === "number" ? b.duration_sec : null,
    language: typeof b.language === "string" ? b.language : null,
  };
}

/**
 * Attach text to validated metadata. Prefer supplied segments only when text has no time marks;
 * otherwise normalize the text.
 */
export function withMeetingText(head: MeetingHead, rawText: string, rawSegments?: unknown, o: { agentMarks?: boolean } = {}): MeetingEnvelope {
  if (rawText.length > 2_000_000) throw tooLarge("text is longer than 2,000,000 characters");
  const segments = parseSegments(rawSegments, o);
  let text: string, format: MeetingEnvelope["format"], warnings: string[], changed: boolean;
  if (segments.length && !hasTimeMarks(rawText)) {
    text = renderTranscript(segments.map((x) => ({ ...x, speaker: x.speaker?.trim() || noSpeakerLabel() })));
    format = "segments"; warnings = segments.every((x) => !x.speaker?.trim()) ? ["no_speakers"] : []; changed = true;
  } else {
    let n;
    try { n = normalizeTranscript(rawText, head.formatHint); } catch (e) { throw invalid(`text: ${(e as Error).message}`); }
    ({ text, format, warnings, changed } = n);
  }
  const { formatHint: _, ...rest } = head;
  return { ...rest, text, segments, format, warnings, original: changed ? { text: rawText, ...ORIGINAL_TYPE[format]! } : null };
}
