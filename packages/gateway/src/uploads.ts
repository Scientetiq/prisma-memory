// One-time meeting upload links: the agent's main path is a 15-minute link and
// `curl -T`: the transcript goes from the person's disk straight into memory, not via the model context. Issued by a person's
// key (REST — script channel; the memory_meeting_upload tool — agent channel): the description is checked at once, by the
// same code as intake (owner, consent, T1, participants). The link: a keyless PUT, once, before the term, within the limit;
// rights — the issuer key's at intake (revoked or dismissed — the link dies). Stored: only the ticket SHA-256 (upload_tickets).
import { createHash, randomBytes } from "node:crypto";
import { classDenied, invalid, log, newId, notFound, recordPath, tooLarge } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { callerForKey } from "./auth.ts";
import { isExternal, requestChannel } from "./channel.ts";
import { acceptMeeting, checkConsent, consentText, currentMeeting, meetingHome, meetingOwner, parseMeetingBody, parseMeetingHead, withMeetingText, type MeetingAccepted, type MeetingChannel } from "./meetings.ts";
import { MEETING_HEAD_FIELDS } from "./meetings/envelope.ts";
import { serializeMeeting } from "./meetings/serialize.ts";
import { ambiguousError, publicParticipant, resolveParticipants } from "./participants.ts";

export const UPLOAD_TICKET_PREFIX = "mem_upl_";
const TICKET = /^mem_upl_[A-Za-z0-9_-]{43}$/;

const hashTicket = (t: string): Buffer => createHash("sha256").update(t, "utf8").digest();
const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : def);

/** The link term and the largest file size — from the panel settings (meetings.*), within sane bounds. */
export function uploadLimits(app: App): { ttlSec: number; maxBytes: number } {
  const ttlSec = Math.round(Math.min(86_400, Math.max(1, num(app.settings.get("meetings.upload_ticket_ttl_sec", 900), 900))));
  // the fallback — as in the seed (20 MB): a setting cleared in the panel (null) is read from here
  const mb = Math.min(50, Math.max(1, num(app.settings.get("meetings.upload_max_mb", 20), 20)));
  return { ttlSec, maxBytes: Math.floor(mb * 1_048_576) };
}

/**
 * Issue a link: the same checks as meeting intake, before issuing — owner (a person's key), initiator, consent, T1,
 * participants (an ambiguous one — 400). Expired tickets are deleted right here. The answer carries the link once.
 */
export async function issueUpload(app: App, caller: Caller, channel: Exclude<MeetingChannel, "service">, body: any): Promise<Record<string, unknown>> {
  const owner = meetingOwner(caller, channel);
  if (body && typeof body === "object" && ("text" in body || "segments" in body))
    throw invalid("The transcript is not sent when a link is issued: only the meeting description; the file itself goes by PUT to the link (curl -T)");
  const head = parseMeetingHead(body, { initiatorRequired: false });
  if (head.initiator && head.initiator !== owner.login) throw invalid("initiator does not match the owner of the key");
  const consent = checkConsent(app, head.consent);
  if (caller.tier === "T1") throw classDenied("A meeting is of the closed class: a T1 channel does not accept it");
  const rp = await resolveParticipants(app, head.participants);
  if (rp.ambiguous.length) throw ambiguousError(rp.ambiguous);
  if (rp.directory.lookups)
    await audit(app, caller, { event_type: "directory", result_count: rp.directory.found,
                               details: { source: "ldap", via: "meeting_upload", lookups: rp.directory.lookups, cached: rp.directory.cached, ...(rp.directory.error ? { ldap_error: rp.directory.error } : {}) } });
  // a meeting with this meeting_id exists (the repeat key — with the source, pickCurrentMeeting; in both databases): the same
  // file returns it, another — a new version; agent and script do not see services' test copies. The path — by the space
  // where it lies now (a move into a team or project): it will be read by it
  // to the external agents' address — existing is always null: a closed-class meeting, closed is not spoken of there
  const prev = isExternal(caller) ? null : await currentMeeting(app, caller, channel, owner.id, head.meetingRef);
  const slug = prev ? await meetingHome(app, prev.space_id) : null;
  const existing = prev && slug ? { id: prev.id, path: recordPath(slug, "transcript", prev.occurred_at, prev.id), version: prev.version } : null;

  const { ttlSec, maxBytes } = uploadLimits(app);
  const meeting = Object.fromEntries(MEETING_HEAD_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const token = UPLOAD_TICKET_PREFIX + randomBytes(32).toString("base64url"), id = newId();
  await app.db.control.query("DELETE FROM upload_tickets WHERE instance_id = $1 AND expires_at < now()", [app.instanceId]);
  const { rows } = await app.db.control.query(
    `INSERT INTO upload_tickets (id, token_hash, instance_id, person_id, key_id, channel, meeting, max_bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9::int)) RETURNING expires_at`,
    [id, hashTicket(token), app.instanceId, owner.id, caller.keyId, channel, JSON.stringify(meeting), maxBytes, ttlSec]);
  const expiresAt = new Date(rows[0].expires_at).toISOString();
  await audit(app, caller, { event_type: "write", details: { op: "upload_ticket_issued", ticket_id: id, meeting_id: head.meetingRef, channel, expires_at: expiresAt, max_bytes: maxBytes } });
  const url = `${caller.baseUrl}/api/v1/uploads/${token}`;
  return serializeMeeting("UploadTicket", {
    meeting_id: head.meetingRef,
    upload: { url, method: "PUT", expires_at: expiresAt, max_bytes: maxBytes },
    command: `curl -sS --fail-with-body -T <file> '${url}'`,
    existing,
    participants: rp.items.map(publicParticipant),
    consent: { version: consent.version },
    ...(rp.warnings.length ? { warnings: rp.warnings } : {}),
  }, "base");
}

/** A request body of at most max bytes: declared length checked before reading, actual length while reading. null — more. */
async function readCapped(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The answer to a PUT by link on the external agents' address: only "accepted" — no id, path or meeting version. */
export interface UploadAccepted { status: 202; body: { status: "accepted" } }

/**
 * Accept a file by link. An unknown, used, expired ticket and a ticket whose key or person is no longer valid —
 * 404 (alike from outside); over the limit — 413, the ticket kept. It is taken atomically; an intake refusal (not UTF-8,
 * format, the consent changed its version) frees it — the same file, fixed, can be sent again before the term.
 *
 * The external agents' address (channel — channelGate, else by Host): the key that issued the ticket must be
 * allowed from outside (callerForKey with the channel; an extended key — not) — otherwise the same 404; an accepted meeting — 202
 * `{status: "accepted"}`: a closed-class meeting, its id and path are not named outside.
 */
export async function acceptUpload(app: App, token: string, req: Request, ip: string | null, baseUrl: string): Promise<MeetingAccepted | UploadAccepted> {
  if (!TICKET.test(token)) throw notFound();
  const rc = await requestChannel(app, req, null);
  const { rows } = await app.db.control.query(
    `SELECT id, person_id, key_id, channel, meeting, max_bytes FROM upload_tickets
     WHERE token_hash = $1 AND instance_id = $2 AND used_at IS NULL AND expires_at > now()`, [hashTicket(token), app.instanceId]);
  const t = rows[0];
  if (!t) throw notFound();
  const caller = await callerForKey(app, t.key_id, ip, baseUrl, rc.channel);
  if (!caller || caller.person?.id !== t.person_id) {
    await audit(app, null, { event_type: "auth_failure", details: { reason: "upload_ticket_key", ticket_id: t.id, key_id: t.key_id }, ip });
    throw notFound();
  }
  caller.transport = "rest";                                       // a PUT by link is REST (details.via of the write event)
  const buf = await readCapped(req, t.max_bytes);
  if (!buf) throw tooLarge(`File larger than ${Math.round(t.max_bytes / 1_048_576 * 10) / 10} MB (meetings.upload_max_mb): the link is still valid, send a smaller file`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { throw invalid("The file is not UTF-8 text"); }
  if (!text.trim()) throw invalid("The file is empty");

  const claimed = await app.db.control.query("UPDATE upload_tickets SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id", [t.id]);
  if (!claimed.rowCount) throw notFound();
  // sweep: the ticket is given back only while no meeting was accepted with it. Once acceptMeeting returned, the
  // record exists and the ticket stays spent, so one ticket never accepts two uploads.
  let accepted = false;
  try {
    const m = withMeetingText(parseMeetingHead(t.meeting, { initiatorRequired: false }), text);
    const res = await acceptMeeting(app, caller, t.channel as MeetingChannel, m, { auditDetails: { upload_ticket: t.id } });
    accepted = true;
    // the meeting IS accepted — the answer says so even when the ticket's note fails (a 5xx would make the
    // client ask for a new ticket and upload the same meeting again); the missing record_id is only bookkeeping, logged
    await app.db.control.query("UPDATE upload_tickets SET record_id = $2 WHERE id = $1", [t.id, res.body.id])
      .catch((e: unknown) => log.warn("upload_ticket_note_failed", { ticket: t.id, error: ((e as Error)?.message ?? String(e)).slice(0, 160) }));
    return isExternal(rc) ? { status: 202, body: { status: "accepted" } } : res;
  } catch (e) {
    if (!accepted) await app.db.control.query("UPDATE upload_tickets SET used_at = NULL WHERE id = $1", [t.id]).catch(() => undefined);
    throw e;
  }
}

/** Intake warnings that only an already stored meeting has: we do not give them to the external address. */
const PRIOR_WARNINGS = new Set(["participants_not_added", "participants_left"]);

/**
 * memory_meeting_upload with text on the external agents' address: the meeting is accepted — and that is all. No id,
 * path, version, previous version, stages, workplace link or "already exists": a closed-class meeting, and a repeat of the same
 * transcript must not differ from a new one. The contract's required fields and what is derived from the request remain.
 */
function externalAccepted(app: App, a: any, b: Record<string, any>): { result: Record<string, unknown>; text: string } {
  const participants = Array.isArray(b.participants) ? b.participants : [];
  const warnings = Array.isArray(b.warnings) ? (b.warnings as unknown[]).filter((w) => typeof w === "string" && !PRIOR_WARNINGS.has(w)) as string[] : [];
  const result: Record<string, unknown> = serializeMeeting("MeetingToolResult", {
    mode: "accepted", meeting_ref: a.meeting_ref, participants, consent: { version: consentText(app).version },
    ...(typeof b.format === "string" ? { format: b.format } : {}), ...(b.participants_unknown ? { participants_unknown: b.participants_unknown } : {}),
    ...(warnings.length ? { warnings } : {}),
  }, "base");
  return { result, text: ["Meeting accepted.", ...(participants.length ? ["Participants:", ...participantLines(participants)] : []),
                          ...(warnings.length ? [`Warnings: ${warnings.join(", ")}`] : [])].join("\n") };
}

const STATUS_TEXT: Record<string, string> = { resolved: "recognised", in_directory: "in the directory — gets access once they appear in memory", not_found: "not found" };
const participantLines = (items: Array<Record<string, any>>): string[] =>
  items.map((p) => `  • ${p.input} — ${STATUS_TEXT[p.status] ?? p.status}${p.login && p.login !== p.input ? ` (${[p.display_name, p.login].filter(Boolean).join(", ")})` : ""}`);

/**
 * The memory_meeting_upload tool: a person's agent passes the meeting description and gets a link with a ready
 * `curl -T` command (agent channel) — the transcript goes from disk, past the model context; a short `text` is taken at once.
 * Only to a person's key: the tool is not visible to a service (mcp.ts), the meeting owner is the key owner.
 */
export async function meetingUploadTool(app: App, caller: Caller, a: any): Promise<{ result: Record<string, unknown>; text: string }> {
  const body: Record<string, unknown> = { meeting_id: a.meeting_ref, started_at: a.started_at, title: a.title, participants: a.participants, consent: a.consent,
                                          format: a.format, entities: a.entities, duration_sec: a.duration_sec, language: a.language };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  if (typeof a.text === "string") {
    const r = await acceptMeeting(app, caller, "agent", parseMeetingBody({ ...body, text: a.text }, { initiatorRequired: false }));
    const b = r.body as Record<string, any>;
    if (isExternal(caller)) return externalAccepted(app, a, b);
    const result: Record<string, unknown> = serializeMeeting("MeetingToolResult", {
      mode: "accepted", meeting_ref: a.meeting_ref, id: b.id, path: b.path, version: b.version, already_known: b.already_known, supersedes_id: b.supersedes_id ?? null,
      stages: b.stages, format: b.format, participants: b.participants ?? [], consent: b.consent ?? { version: consentText(app).version },
      ...(b.participants_unknown ? { participants_unknown: b.participants_unknown } : {}), ...(b.warnings ? { warnings: b.warnings } : {}),
      ...(b.participants_changed ? { participants_changed: true } : {}), ...(b.workplace_url ? { workplace_url: b.workplace_url } : {}),
    }, "base");
    const head = b.already_known ? `This meeting is already in memory (same text): ${b.path}, version ${b.version}.${b.participants_changed ? " The participant list is updated." : ""}`
      : b.supersedes_id ? `A new version of the meeting is accepted: ${b.path}, version ${b.version}.` : `Meeting accepted: ${b.path}.`;
    return { result, text: [head, ...(b.participants?.length ? ["Participants:", ...participantLines(b.participants)] : []),
                            ...(b.warnings?.length ? [`Warnings: ${b.warnings.join(", ")}`] : []),
                            b.workplace_url ? `Give the person the link to the meeting page — the summary and decisions appear there in a few minutes: ${b.workplace_url}` : "Give the person this record path.",
                            "Do not read the meeting itself: it is of the closed class, and an agent key does not receive its content."].join("\n") };
  }
  const t = await issueUpload(app, caller, "agent", body) as Record<string, any>;
  const external = isExternal(caller);
  const result: Record<string, unknown> = serializeMeeting("MeetingToolResult", {
    mode: "upload", meeting_ref: a.meeting_ref, upload: t.upload, command: t.command, ...(external ? {} : { existing: t.existing }), participants: t.participants, consent: t.consent,
    ...(t.warnings ? { warnings: t.warnings } : {}),
  }, "base");
  const until = new Date(t.upload.expires_at).toISOString().slice(11, 16);
  const text = [
    ...(t.existing ? [`A meeting with this meeting_ref already exists: ${t.existing.path}, version ${t.existing.version}. The same file returns it again; a different file becomes a new version.`] : []),
    `One-time upload link — valid until ${until} UTC, for one use, file up to ${Math.round(t.upload.max_bytes / 1_048_576 * 10) / 10} MB (txt, srt, vtt, json).`,
    "Run this on the person's computer with the path to the transcript file filled in (do not read the file itself into the context):",
    `  ${t.command}`,
    ...(t.participants.length ? ["Participants:", ...participantLines(t.participants)] : []),
    external ? "The command answers {\"status\":\"accepted\"}: the meeting is accepted; the person finds it in the memory workspace. Do not read the meeting itself."
      : "The command answers with the meeting as JSON: give the person the link to the meeting page from the field workplace_url (the summary and decisions appear there in a few minutes; without that field, the path). Do not read the meeting itself.",
  ].join("\n");
  return { result, text };
}
