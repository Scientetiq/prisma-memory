import { personalAgent } from "./personal-agent.ts";
import type pg from "pg";
import { SUPERSEDED_STAGE_NOTE, classDenied, enqueueMail, MEETING_MAIL_NOT_PARTICIPANT, estimateTokens, inProgress, invalid, log, MAIL_RE, meetingHandoverBusy, meetingOriginOf, MemoryError, newId, notFound, recordPath, smtpConfig, tx, type DataClass } from "@memory/shared";
import { archivedOnlyNarrows, archivedTeamSpace, locate, peopleOnlyNarrow, resolveSpace, serviceWriteSpace } from "./access.ts";
import { audit } from "./audit.ts";
import { leaveOrgNarrowed } from "./org-review.ts";
import { orgSpace } from "./org-hold.ts";
import { HttpReject } from "./auth.ts";
import type { App, Caller, PersonRow } from "./context.ts";
import { withCommittedOwnerEffects } from "./owner-effects.ts";
import { underRecordLock, withRecordLocksWait } from "./owner-lock.ts";
import { workplaceUrl } from "./workplace.ts";
import { ambiguousError, grantPendingMeetings, personEntities, publicParticipant, resolveParticipants, syncParticipantLinks, type ParticipantResult, type PendingParticipant, type Resolution } from "./participants.ts";
import { createRecord, DESCENDANTS_SQL, originalKey, queueOf, resolveEntities, sourceHash, stagesOf } from "./records.ts";
import { withKeyLock } from "./control-lock.ts";
import { checkDiskForUpload, takeUploadDaily } from "./limits.ts";
import { daytimeCapExceeded } from "./intake-lane.ts";

// Parsing and channel types are shared by all meeting clients.
import { MEETING_MAX_PARTICIPANTS, meetingLanguage, type MeetingChannel, type MeetingEnvelope } from "./meetings/envelope.ts";
import { serializeMeeting } from "./meetings/serialize.ts";
export { MEETING_MAX_PARTICIPANTS, PARTICIPANTS_RAW_MAX, RESERVED_ATTRS, oneLineTitle, parseSegments,
  parseMeetingBody, parseMeetingHead, withMeetingText } from "./meetings/envelope.ts";
export type { MeetingChannel, MeetingEnvelope, MeetingInput, MeetingHead, ParticipantMeta, Segment } from "./meetings/envelope.ts";

export interface ConsentText { version: string; text: string }
export interface ConsentRecord { version: string; accepted_at: string; by: string; channel: MeetingChannel; client: string | null; key_id: string; service: string | null }

export function consentText(app: App): ConsentText {
  return serializeMeeting("ConsentText", { version: String(app.settings.get("meetings.consent_version", "v0") ?? "v0"), text: String(app.settings.get("meetings.consent_text", "") ?? "") }, "base");
}

export function consentRefusal(cur: ConsentText, why: string): string {
  const version = `consent: {accepted: true, version: "${cur.version}"}`;
  const text = cur.text.trim();
  return text
    ? `The meeting was not accepted: ${why}. Show the person this consent text verbatim: “${text}”. Ask if they confirm it. Send ${version} only if they say yes`
    : `The meeting was not accepted: ${why}. No consent text is set in memory. Do not supply your own text or paraphrase the consent field description. Tell the person the memory administrator sets the text. Ask what to do next. If they confirm consent, send ${version}`;
}

export function checkConsent(app: App, raw: unknown): ConsentText {
  const cur = consentText(app);
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const why = !c ? "participant consent is missing (consent)" : c.accepted !== true ? "consent was unconfirmed (consent.accepted must be true)"
    : c.version !== cur.version ? `consent text version ${JSON.stringify(c.version ?? null)} is not the current version (${cur.version})` : null;
  if (why) throw invalid(consentRefusal(cur, why), { consent: cur });
  return cur;
}

export const publicConsent = (c: ConsentRecord): Omit<ConsentRecord, "key_id" | "service"> =>
  ({ version: c.version, accepted_at: c.accepted_at, by: c.by, channel: c.channel, client: c.client });

export function meetingOwner(caller: Caller, channel: MeetingChannel): PersonRow {
  if (caller.principalType === "system") throw new HttpReject(403, "forbidden", "The system key is for the admin API only");
  if (channel === "service") {
    if (caller.principalType !== "service") throw new HttpReject(403, "forbidden", "Only a service key can submit meetings from a service");
    if (!caller.onBehalfOf || !caller.person) throw new HttpReject(403, "forbidden", "X-On-Behalf-Of is required: give the meeting initiator’s login");
    return caller.person;
  }
  if (caller.principalType !== "person" || !caller.person || (!personalAgent(caller) && caller.keyKind !== "extended"))   // vis-ok: who may submit a meeting, not visibility
    throw new HttpReject(403, "forbidden", "An agent or script must use a personal key to submit a meeting. The key owner becomes the meeting owner");
  return caller.person;
}

async function meetingSpace(app: App, caller: Caller, owner: PersonRow) {
  if (caller.service?.write_space_id) {
    const fixed = await serviceWriteSpace(app, caller);
    if (!fixed) throw new HttpReject(403, "forbidden", "The service’s write space is archived or deleted. The service cannot write until the administrator changes the space");
    return fixed;
  }
  const space = await resolveSpace(app, caller, "me");
  if (!space || space.owner_id !== owner.id) throw notFound();
  return space;
}

export interface MeetingAccepted { status: 200 | 201; body: Record<string, unknown> }

export function meetingOriginalKey(instanceId: string, m: Pick<MeetingEnvelope, "startedAt" | "meetingRef">, ext: string, hash: Buffer, recordId: string): string {
  return originalKey(instanceId, m.startedAt, hash, recordId, `meeting-${m.meetingRef.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80)}.${ext}`);
}

export interface MeetingVersionRow {
  id: string; version: number; source_hash: Buffer; occurred_at: Date; attrs: Record<string, unknown>;
  supersedes_id: string | null; space_id: string; asserted_by: string | null; is_current: boolean; deleted: boolean; ingested_at: Date;
  other_prev?: string | null;
}
export interface MeetingSeeker { channel: MeetingChannel; service: string | null; login: string | null; serviceSpaces: ReadonlySet<string> }

export function pickCurrentMeeting<R extends MeetingVersionRow>(rows: readonly R[], seeker: MeetingSeeker): R | null {
  return meetingCandidates(rows, seeker)[0] ?? null;
}

export function meetingCandidates<R extends MeetingVersionRow>(rows: readonly R[], seeker: MeetingSeeker): R[] {
  const byId = new Map<string, MeetingVersionRow>(rows.map((r) => [r.id, r]));
  const chainSome = (head: MeetingVersionRow, test: (r: MeetingVersionRow) => boolean): boolean => {
    const seen = new Set<string>();
    for (let r: MeetingVersionRow | undefined = head; r && !seen.has(r.id); r = byId.get(r.supersedes_id ?? r.other_prev ?? "")) {
      seen.add(r.id);
      if (test(r)) return true;
    }
    return false;
  };
  const fits = (r: MeetingVersionRow): boolean => seeker.channel === "service"
    ? !!seeker.service && chainSome(r, (v) => v.asserted_by === seeker.service)
    : !chainSome(r, (v) => seeker.serviceSpaces.has(v.space_id));
  const own = (r: MeetingVersionRow): number => (seeker.channel !== "service" && seeker.login
    ? Number(chainSome(r, (v) => v.asserted_by?.toLowerCase() === seeker.login!.toLowerCase())) : 0);
  const at = (r: MeetingVersionRow): number => +new Date(r.ingested_at) || 0;
  return rows.filter((r) => r.is_current && !r.deleted && fits(r))
    .sort((a, b) => own(b) - own(a) || b.version - a.version || at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

type ControlQuery = Pick<pg.PoolClient, "query">;

async function serviceWriteSpaces(app: App, control?: ControlQuery): Promise<Set<string>> {
  return new Set<string>((await (control ?? app.db.control).query("SELECT write_space_id FROM services WHERE instance_id = $1 AND write_space_id IS NOT NULL", [app.instanceId])).rows.map((x) => x.write_space_id as string));
}

export interface CurrentMeeting extends MeetingVersionRow {
  class: DataClass;
  other_prev: string | null;
}

export async function currentMeeting(app: App, caller: Caller, channel: MeetingChannel, ownerId: string, ref: string,
                                     o: { control?: ControlQuery } = {}): Promise<CurrentMeeting | null> {
  const control = o.control ?? app.db.control;
  const serviceSpaces = channel === "service" ? new Set<string>() : await serviceWriteSpaces(app, o.control);
  const rows: Array<CurrentMeeting & { hidden: boolean }> = [];
  for (const cls of ["closed", "open"] as const) {
    const { rows: got } = await app.db.recordsForWrite(cls, caller.scope).query(
      `SELECT id, version, source_hash, occurred_at, supersedes_id, space_id, is_current, deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden,
              attrs #>> '{access,asserted_by}' AS asserted_by, attrs->>'supersedes_id_other_class' AS other_prev, ingested_at,
              jsonb_strip_nulls(jsonb_build_object('process_now_at', attrs->'process_now_at', 'deferred_reason', attrs->'deferred_reason', 'participants_pending', attrs->'participants_pending',
                                                   'organizer_transfer', attrs->'organizer_transfer',
                                                   'narrowed_by_source', CASE WHEN attrs #>> '{access,narrowed_by_source}' = 'true'
                                                                                OR attrs #>> '{access,restricted_by_source}' = 'true' THEN true END)) AS attrs
         FROM records WHERE source_kind = 'transcriber' AND source_ref = $1 AND owner_id = $2
        ORDER BY version DESC, ingested_at DESC, id DESC`, [ref, ownerId]);
    for (const r of got) rows.push({ ...r, class: cls, other_prev: r.other_prev ?? null });
  }
  const cands = meetingCandidates(rows, { channel, service: caller.service?.name ?? null, login: channel === "service" ? null : caller.person?.login ?? null, serviceSpaces });
  if (!cands.length) return null;
  const ids = [...new Set(cands.map((r) => r.id))];
  if ((await control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [ids])).rowCount) throw inProgress();
  const home = new Map<string, DataClass>((await control.query("SELECT record_id, class FROM record_locations WHERE record_id = ANY($1::uuid[])", [ids])).rows
    .map((x) => [x.record_id as string, x.class as DataClass]));
  const head = cands.find((r) => !r.hidden && (home.get(r.id) ?? r.class) === r.class);
  if (!head) throw inProgress();
  const { hidden: _hidden, ...out } = head;
  return out;
}

export function carriedTransfer(mark: unknown, ownerId: string): Record<string, unknown> | null {
  if (!mark || typeof mark !== "object" || Array.isArray(mark)) return null;
  const t = mark as Record<string, unknown>;
  return t.to === ownerId && typeof t.from === "string" ? { ...t } : null;
}

export async function meetingHome(app: App, spaceId: string, known?: { id: string; slug: string } | null): Promise<string | null> {
  if (known && known.id === spaceId) return known.slug;
  return (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [spaceId])).rows[0]?.slug ?? null;
}

async function retireOtherClass(app: App, caller: Caller, prevId: string, newId: string): Promise<void> {
  try {
    await underRecordLock(app, prevId, () => { throw inProgress(); }, async (q) => {
      if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [prevId])).rowCount) throw inProgress();
      const loc = (await q.query("SELECT class FROM record_locations WHERE record_id = $1", [prevId])).rows[0] as { class: DataClass } | undefined;
      if (!loc) return;
      await tx(app.db.recordsForWrite(loc.class, caller.scope), async (c) => {
        const hit = await c.query("UPDATE records SET is_current = false, attrs = attrs || jsonb_build_object('superseded_by_id_other_class', $1::text) WHERE id = $2 AND is_current", [newId, prevId]);
        if (!hit.rowCount) return;
        await c.query(`${DESCENDANTS_SQL} UPDATE records SET is_current = false WHERE id IN (SELECT id FROM d)`, [prevId]);
        await c.query(`${DESCENDANTS_SQL} UPDATE record_stages SET status = 'skipped', last_error = $2, updated_at = now()
                       WHERE status IN ('pending','failed') AND (record_id = $1 OR record_id IN (SELECT id FROM d))`, [prevId, SUPERSEDED_STAGE_NOTE]);
      });
    });
  } catch (e) {
    log.warn("meeting_supersede_deferred", { record_id: newId, supersedes: prevId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    throw inProgress();
  }
}

async function otherStillCurrent(app: App, caller: Caller, prevId: string): Promise<boolean> {
  const loc = (await app.db.control.query("SELECT class FROM record_locations WHERE record_id = $1", [prevId])).rows[0] as { class: DataClass } | undefined;
  if (!loc) return false;
  return ((await app.db.recordsForWrite(loc.class, caller.scope).query("SELECT 1 FROM records WHERE id = $1 AND is_current", [prevId])).rowCount ?? 0) > 0;
}

export async function acceptMeeting(app: App, caller: Caller, channel: MeetingChannel, m: MeetingEnvelope,
                                    o: { auditDetails?: Record<string, unknown>; waitSec?: number; automatic?: true } = {}): Promise<MeetingAccepted> {
  const owner = meetingOwner(caller, channel);
  const sourceParticipants = o.automatic && m.participants.length ? m.participants.map(lower) : undefined;
  if (m.initiator && m.initiator !== owner.login) throw invalid(channel === "service" ? "initiator does not match X-On-Behalf-Of" : "initiator does not match the key owner");
  const consentOk = checkConsent(app, m.consent);
  const space = await meetingSpace(app, caller, owner);
  const cls = "closed" as const;
  const bytes = Buffer.from(m.text, "utf8");
  const hash = sourceHash(bytes, {});
  if (caller.tier === "T1") throw classDenied("A meeting is closed class. The T1 channel does not accept it");
  await checkDiskForUpload(app);
  return withMeetingLock(`${owner.id}\u0000${m.meetingRef}`, async (): Promise<MeetingAccepted> => {
  const prev = await currentMeeting(app, caller, channel, owner.id, m.meetingRef);
  if (prev?.other_prev && await otherStillCurrent(app, caller, prev.other_prev)) await retireOtherClass(app, caller, prev.other_prev, prev.id);
  if (prev && sameTranscript(prev, bytes, hash, m.meetingRef)) {
    const home = (await meetingHome(app, prev.space_id, space)) ?? space.slug;
    const known = { id: prev.id, path: recordPath(home, "transcript", prev.occurred_at, prev.id), type: "transcript", space: home, class: prev.class, version: prev.version, supersedes_id: null,
                    already_known: true, stages: await stagesOf(app.db.recordsForWrite(prev.class, caller.scope), prev.id), queue: await queueOf(app, prev.attrs), format: m.format, ...meetingPage(app, prev.id) };
    if (!m.participants.length) return { status: 200, body: serializeMeeting("IngestResult", known, "base") };
    const rp = await meetingParticipants(app, caller, m.participants);
    if (channel === "service" && !caller.netBound) await onlyNarrows(app, caller, prev.id, owner.id, rp, prev.class, await meetingLeft(app, caller, owner.id, m.meetingRef));
    const applied = await applyParticipants(app, caller, prev.id, owner.id, rp, "ingest", { waitSec: o.waitSec, sourceParticipants });
    if (applied.added.length) await notifyParticipants(app, { id: prev.id, title: m.title || null, occurred_at: prev.occurred_at, owner_id: owner.id }, applied.added)
      .catch((e: Error) => log.warn("meeting_mail_failed", { error: e.message.slice(0, 160) }));
    const unknown = rp.items.filter((x) => x.status !== "resolved").map((x) => x.input);
    const left = applied.left ?? [];
    const warnings = [...rp.warnings, ...(applied.skipped.length ? ["participants_not_added"] : []), ...(left.length ? ["participants_left"] : [])];
    return { status: 200, body: serializeMeeting("IngestResult", { ...known, participants: rp.items.map(publicParticipant), ...(unknown.length ? { participants_unknown: unknown } : {}),
                                  ...(applied.changed ? { participants_changed: true } : {}), ...(left.length ? { participants_left: left } : {}), ...(warnings.length ? { warnings } : {}) }, "base") };
  }

  const rp = await meetingParticipants(app, caller, m.participants);
  const leftAll = await meetingLeft(app, caller, owner.id, m.meetingRef);
  const isLeft = (x: { status: string; login?: string }): boolean => x.status !== "not_found" && !!x.login && leftAll.has(x.login.toLowerCase());
  const leftOut = [...new Set(rp.items.filter(isLeft).map((x) => x.login!.toLowerCase()))];
  if (prev && channel === "service" && !caller.netBound) await onlyNarrows(app, caller, prev.id, owner.id, rp, prev.class, leftAll);
  const resolved = rp.items.filter((x) => x.status === "resolved" && !isLeft(x));
  const known = [...new Set([owner.id, ...resolved.map((x) => x.personId!)])];
  const resolvedLogins = [...new Set(resolved.map((x) => x.login!))];
  const fresh: PendingParticipant[] = rp.items.filter((x) => x.status === "in_directory" && !isLeft(x)).map((x) => ({ login: x.login!, display_name: x.display_name ?? null, input: x.input }));
  const before = prev && Array.isArray(prev.attrs.participants_pending) ? prev.attrs.participants_pending as PendingParticipant[] : [];
  const { kept, inputs: keptInputs } = keptPending(before, rp.items, fresh);
  const pending = [...fresh, ...kept];
  const unresolved = rp.items.filter((x) => x.status === "not_found" && !(x.undetermined && keptInputs.has(x.input.toLowerCase()))).map((x) => x.input);
  const unknown = rp.items.filter((x) => x.status !== "resolved").map((x) => x.input);
  const daily = channel === "service" ? null
    : await takeUploadDaily(app, caller, m.original ? Buffer.byteLength(m.original.text, "utf8") : bytes.length);
  let dailyKept = false;
  try {
  const recordId = newId();
  let storedKey: string | null = null;
  if (m.original) {
    const key = meetingOriginalKey(app.instanceId, m, m.original.ext, hash, recordId);
    const ok = await app.storage.put(cls, key, Buffer.from(m.original.text, "utf8"), m.original.mime).catch((e: Error) => { log.warn("original_not_stored", { class: cls, error: e.message.slice(0, 160) }); return false; });
    if (ok) storedKey = key;
  }
  const entities = await resolveEntities(app, [...new Set<string>([...m.entities, ...resolvedLogins.map((l) => `person:${l}`)])], caller);
  entities.unresolved = entities.unresolved.filter((k) => !k.startsWith("person:") || m.entities.includes(k));
  const capped = await daytimeCapExceeded(app, 2 * estimateTokens(m.text));
  const lane = capped ? { deferred_reason: "daytime_cap", deferred_to_night_at: new Date().toISOString() } : { process_now_at: new Date().toISOString() };
  const consent: ConsentRecord = { version: consentOk.version, accepted_at: new Date().toISOString(), by: owner.login, channel,
                                   client: caller.clientLabel ?? null, key_id: caller.keyId, service: caller.service?.name ?? null };
  const versions = m.participants.length ? await meetingRootIds(app, caller, owner.id, m.meetingRef, prev?.id ?? null) : [];
  const keep: Narrowing = { keep: [...new Set(known)], keepLogins: [...resolvedLogins, ...pending.map((x) => x.login)] };
  const cross = prev !== null && prev.class !== cls;
  const lockIds = [...new Set([...versions, ...(prev ? [prev.id] : [])])];
  const write = async (wApp: App, ctl?: pg.PoolClient) => {
    if (await returnPending(wApp, caller, owner.id, m.meetingRef, ctl)) throw meetingHandoverBusy(MEETING_HANDOVER_TEXT);
    const now = await currentMeeting(wApp, caller, channel, owner.id, m.meetingRef, { control: ctl });
    if ((now?.id ?? null) !== (prev?.id ?? null)) throw inProgress(10);
    if (ctl) await meetingFamilyLocked(wApp, caller, ctl, { ownerId: owner.id, ref: m.meetingRef, locked: lockIds, ...(versions.length ? { anchor: prev?.id ?? null } : {}) });
    const carried = carriedTransfer(now?.attrs.organizer_transfer, owner.id);
    const narrowed = versions.length ? await narrowLocked(wApp, caller, owner.id, versions, keep, ctl!) : null;
    return { narrowed, created: await createRecord(wApp, caller, {
      id: recordId, type: "transcript", space, classOverride: cls, title: m.title || `Meeting ${m.startedAt.toISOString().slice(0, 10)}`, text: m.text, method: "source_document", origin: "human",
      sourceKind: "transcriber", sourceRef: m.meetingRef, sourceHash: hash, occurredAt: m.startedAt, entities, ownerId: owner.id,
      audiencePeople: m.participants.length ? known : undefined,
      narrowedBySource: now?.attrs.narrowed_by_source === true,
      attrs: { meeting_id: m.meetingRef, participants: resolvedLogins, ...(pending.length ? { participants_pending: pending } : {}),
               ...(sourceParticipants ? { source_participants: sourceParticipants } : {}),
               ...(unresolved.length ? { participants_unresolved: unresolved } : {}),
               ...(m.audioObjectKey ? { audio_object_key: m.audioObjectKey } : {}),
               ...(m.segments.length ? { segments: m.segments } : {}), ...(Object.keys(m.attrs).length ? { source: m.attrs } : {}), channel, transcript_format: m.format, consent, ...lane,
               ...(m.participantsMeta?.length ? { participants_meta: m.participantsMeta } : {}),
               ...(cross ? { supersedes_id_other_class: prev!.id } : {}), ...(leftAll.size ? { participants_left: [...leftAll.values()] } : {}),
               ...(carried ? { organizer_transfer: carried } : {}) },
      auditDetails: { channel, consent_version: consent.version, ...o.auditDetails },
      original: m.original
        ? { key: storedKey, mime: m.original.mime, bytes: Buffer.byteLength(m.original.text), durationSec: m.durationSec, language: meetingLanguage(m, app.settings) }
        : { key: null, mime: "text/plain", bytes: Buffer.byteLength(m.text), durationSec: m.durationSec, language: meetingLanguage(m, app.settings) },
      version: prev ? prev.version + 1 : 1, supersedesId: cross ? null : prev?.id ?? null,
    }, undefined, { control: ctl }) };
  };
  const { created, narrowed } = lockIds.length
    ? await withCommittedOwnerEffects(app, (effApp) => withRecordLocksWait(effApp, lockIds, (ctl) => write(effApp, ctl), { waitSec: o.waitSec }))
    : await write(app);
  dailyKept = true;
  if (narrowed) await narrowReport(app, caller, versions, narrowed);
  if (cross) await retireOtherClass(app, caller, prev!.id, created.id);
  const warns = [...m.warnings, ...rp.warnings, ...(leftOut.length ? ["participants_left"] : [])];
  if (!prev) await notifyParticipants(app, { id: created.id, title: m.title || `Meeting ${m.startedAt.toISOString().slice(0, 10)}`, occurred_at: m.startedAt, owner_id: owner.id }, known)
    .catch((e: Error) => log.warn("meeting_mail_failed", { error: e.message.slice(0, 160) }));
  if (pending.length) {
    const appeared = (await app.db.control.query("SELECT id, login FROM people WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') <> 'true' AND login = ANY($2::text[])",
                                                 [app.instanceId, pending.map((x) => x.login)])).rows;
    if (appeared.length) await grantPendingMeetings(app, appeared, "meeting_accept", caller);
  }
  return { status: prev ? 200 : 201, body: serializeMeeting("IngestResult", { id: created.id, path: created.path, type: "transcript", space: created.space, class: created.class, version: prev ? prev.version + 1 : 1, supersedes_id: prev?.id ?? null,
                                             already_known: false, stages: created.stages, queue: await queueOf(app, lane, created.stages.length),
                                             participants: rp.items.map(publicParticipant), ...(unknown.length ? { participants_unknown: unknown } : {}), consent: publicConsent(consent),
                                             ...(leftOut.length ? { participants_left: leftOut } : {}), format: m.format, ...meetingPage(app, created.id),
                                             ...(warns.length ? { warnings: warns } : {}),
                                             ...(entities.unresolved.length ? { entities_unresolved: entities.unresolved } : {}) }, "base") };
  } finally { if (!dailyKept) await daily?.release(); }
  });
}

function meetingPage(app: App, id: string): { workplace_url?: string } {
  const url = workplaceUrl(app, `/records/${id}`);
  return url ? { workplace_url: url } : {};
}

export function withMeetingLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`meeting:${key}`, fn);
}

export function sameTranscript(prev: { source_hash: Buffer; occurred_at: Date | string }, bytes: Buffer, hash: Buffer, ref: string): boolean {
  if (Buffer.compare(prev.source_hash, hash) === 0) return true;
  const legacy = sourceHash(bytes, { meeting_id: ref, started_at: new Date(prev.occurred_at).toISOString() });
  return Buffer.compare(prev.source_hash, legacy) === 0;
}

export async function meetingParticipants(app: App, caller: Caller, list: string[], o: { pending?: unknown } = {}) {
  const rp = await resolveParticipants(app, list, o);
  if (rp.ambiguous.length) throw ambiguousError(rp.ambiguous);
  await auditLookups(app, caller, rp, "meeting");
  return rp;
}

async function auditLookups(app: App, caller: Caller, rp: Awaited<ReturnType<typeof resolveParticipants>>, via: string) {
  if (rp.directory.lookups)
    await audit(app, caller, { event_type: "directory", result_count: rp.directory.found,
                               details: { source: "ldap", via, lookups: rp.directory.lookups, cached: rp.directory.cached, ...(rp.directory.error ? { ldap_error: rp.directory.error } : {}) } });
}

export async function checkParticipants(app: App, caller: Caller, body: unknown) {
  const owner = meetingOwner(caller, "service");
  if (caller.tier === "T1") throw classDenied("A meeting is closed class. The T1 channel does not accept it");
  const list = (body as { participants?: unknown } | null)?.participants;
  if (!Array.isArray(list) || !list.length || list.length > MEETING_MAX_PARTICIPANTS || list.some((x) => typeof x !== "string" || !x.trim() || x.length > 200))
    throw invalid(`participants: 1 to ${MEETING_MAX_PARTICIPANTS} strings with logins, e-mail addresses or full names (up to 200 characters)`);
  const space = await meetingSpace(app, caller, owner);
  const rp = await resolveParticipants(app, list.map((x: string) => x.trim()));
  await auditLookups(app, caller, rp, "participants_check");
  return serializeMeeting("ParticipantsCheck", {
    owner: { login: owner.login, display_name: owner.display_name ?? null }, space: space.slug, class: "closed" as const,
    participants: rp.items.map(publicParticipant), ambiguous: rp.ambiguous, ...(rp.warnings.length ? { warnings: rp.warnings } : {}),
  }, "base");
}

async function onlyNarrows(app: App, caller: Caller, rootId: string, ownerId: string, rp: Resolution, cls: DataClass, left: ReadonlyMap<string, LeftMark>): Promise<void> {
  const db = app.db.recordsForWrite(cls, caller.scope);
  const people = new Set<string>([ownerId, ...(await db.query("SELECT person_id FROM record_people WHERE record_id = $1", [rootId])).rows.map((x) => x.person_id as string)]);
  const pending = (await db.query("SELECT attrs->'participants_pending' AS p FROM records WHERE id = $1", [rootId])).rows[0]?.p;
  const wasPending = new Set<string>((Array.isArray(pending) ? pending : []).map((x: PendingParticipant) => String(x.login).toLowerCase()));
  const isLeft = (x: { status: string; login?: string }): boolean => x.status !== "not_found" && !!x.login && left.has(x.login.toLowerCase());
  const added = rp.items.filter((x) => !isLeft(x) && ((x.status === "resolved" && !people.has(x.personId!)) || (x.status === "in_directory" && !wasPending.has(x.login!.toLowerCase())))).length;
  if (added) throw new HttpReject(403, "forbidden", `A key without an address binding can only narrow the meeting’s audience, but retrying or submitting a new version adds new participants (${added}). Bind the key to the service’s address in “Services and keys” in the admin panel`);
}

export function keptPending(before: PendingParticipant[], items: ParticipantResult[], fresh: PendingParticipant[]): { kept: PendingParticipant[]; inputs: Set<string> } {
  const unasked = new Set(items.filter((x) => x.status === "not_found" && x.undetermined).map((x) => x.input.toLowerCase()));
  const inputs = new Set<string>(), freshLogins = new Set(fresh.map((x) => x.login.toLowerCase()));
  const kept = before.filter((p) => {
    const login = String(p.login ?? "").toLowerCase(), input = String(p.input ?? "").toLowerCase();
    if (!login || freshLogins.has(login)) return false;
    const hit = [login, input].filter((k) => k && unasked.has(k));
    for (const k of hit) inputs.add(k);
    return hit.length > 0;
  });
  return { kept, inputs };
}

export type ParticipantsChange = { op: "set"; rp: Resolution } | { op: "add"; rp: Resolution } | { op: "remove"; logins: string[] };
export interface ParticipantsApplied { changed: boolean; added: string[]; removed: string[]; records: string[]; versions: number; skipped: string[]; left?: string[] }

export interface LeftMark { login: string; at: string }
export function leftMarks(attrs: unknown): LeftMark[] {
  const v = (attrs as { participants_left?: unknown } | null)?.participants_left;
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && typeof (x as LeftMark).login === "string")
    .map((x) => ({ login: lower((x as LeftMark).login), at: String((x as LeftMark).at ?? "") })) : [];
}
async function leftOf(q: pg.Pool | pg.PoolClient, ids: string[]): Promise<LeftMark[]> {
  if (!ids.length) return [];
  return (await q.query("SELECT attrs->'participants_left' AS l FROM records WHERE id = ANY($1::uuid[]) AND jsonb_typeof(attrs->'participants_left') = 'array'", [ids])).rows
    .flatMap((r) => leftMarks({ participants_left: r.l }));
}
export async function meetingLeft(app: App, caller: Caller, ownerId: string, ref: string): Promise<Map<string, LeftMark>> {
  const out = new Map<string, LeftMark>();
  for (const cls of ["open", "closed"] as const)
    for (const r of (await app.db.recordsForWrite(cls, caller.scope).query(
      "SELECT attrs->'participants_left' AS l FROM records WHERE source_kind = 'transcriber' AND source_ref = $1 AND owner_id = $2 AND parent_id IS NULL AND jsonb_typeof(attrs->'participants_left') = 'array'",
      [ref, ownerId])).rows)
      for (const m of leftMarks({ participants_left: r.l })) if (!out.has(m.login) || out.get(m.login)!.at < m.at) out.set(m.login, m);
  return out;
}
const MARK_LEFT = `UPDATE records SET attrs = attrs || jsonb_build_object('participants_left',
    COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(attrs->'participants_left') = 'array' THEN attrs->'participants_left' ELSE '[]'::jsonb END) e
               WHERE lower(e->>'login') <> $2), '[]'::jsonb) || jsonb_build_array(jsonb_build_object('login', $2::text, 'at', $3::text)))
  WHERE id = ANY($1::uuid[])`;
const CLEAR_LEFT = `UPDATE records SET attrs = CASE WHEN x.rest IS NULL THEN records.attrs - 'participants_left' ELSE records.attrs || jsonb_build_object('participants_left', x.rest) END
  FROM (SELECT r.id, (SELECT jsonb_agg(e) FROM jsonb_array_elements(r.attrs->'participants_left') e WHERE lower(e->>'login') <> ALL($2::text[])) AS rest
          FROM records r WHERE r.id = ANY($1::uuid[]) AND jsonb_typeof(r.attrs->'participants_left') = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.attrs->'participants_left') e WHERE lower(e->>'login') = ANY($2::text[]))) x
  WHERE records.id = x.id`;

const TREE = "WITH RECURSIVE t AS (SELECT id FROM records WHERE id = $1 UNION ALL SELECT r.id FROM records r JOIN t ON r.parent_id = t.id) SELECT id FROM t";
const ACL_BUMP = "UPDATE records SET attrs = jsonb_set(jsonb_set(attrs, '{access,acl_version}', to_jsonb(COALESCE((attrs #>> '{access,acl_version}')::int, 1) + 1)), '{access,acl_checked_at}', to_jsonb(now())) WHERE id = ANY($1::uuid[])";
const lower = (x: unknown): string => String(x ?? "").toLowerCase();

async function meetingVersionIds(app: App, caller: Caller, rootId: string, ownerId: string): Promise<{ ids: string[]; ref: string | null }> {
  const loc = await locate(app, rootId);
  if (!loc || loc.deleted) throw notFound();
  let ref: { source_kind: string; source_ref: string | null } | undefined;
  for (const cls of [loc.class, loc.class === "open" ? "closed" as const : "open" as const]) {
    ref ??= (await app.db.recordsForWrite(cls, caller.scope).query("SELECT source_kind, source_ref FROM records WHERE id = $1", [rootId])).rows[0];
  }
  if (ref?.source_kind !== "transcriber" || !ref.source_ref) return { ids: [rootId], ref: null };
  return { ids: [...new Set([rootId, ...(await meetingRootIds(app, caller, ownerId, ref.source_ref, rootId))])], ref: ref.source_ref };
}

export interface MeetingRootRow { id: string; supersedes_id: string | null; other: string | null; asserted_by: string | null; space_id: string }

export function meetingFamily(rows: readonly MeetingRootRow[], anchor: string | null,
                              who: { service: string } | { serviceSpaces: ReadonlySet<string> }): string[] {
  const up = new Map<string, string>(rows.map((r) => [r.id, r.id]));
  const find = (x: string): string => { let r = x; while (up.get(r) !== r) r = up.get(r)!; up.set(x, r); return r; };
  const join = (a: string, b: string | null): void => { if (b && up.has(b)) { const ra = find(a), rb = find(b); if (ra !== rb) up.set(ra, rb); } };
  for (const r of rows) { join(r.id, r.supersedes_id); join(r.id, r.other); }
  const chains = new Map<string, MeetingRootRow[]>();
  for (const r of rows) { const k = find(r.id); chains.set(k, [...(chains.get(k) ?? []), r]); }
  const fits = (c: MeetingRootRow[]): boolean => "service" in who ? c.some((v) => v.asserted_by === who.service)
    : !c.some((v) => who.serviceSpaces.has(v.space_id));
  const own = anchor && up.has(anchor) ? chains.get(find(anchor))! : null;
  const picked = own && !fits(own) ? [own] : [...chains.values()].filter(fits);
  return [...new Set(picked.flat().map((r) => r.id))];
}

export const MEETING_HANDOVER_TEXT = "The meeting is being handed over to a new organiser. Try again in a minute.";

export interface HandoverRoot { owner_id: string; transfer: { from?: string; to?: string; origin?: string } | null; ret: { from?: string; to?: string } | null }

export function organizerSplit(rows: readonly HandoverRoot[], owner?: string): boolean {
  return rows.some((a) => rows.some((b) => b !== a && b.owner_id !== a.owner_id && (owner === undefined || a.owner_id === owner || b.owner_id === owner) && (
    (!!a.transfer?.from && b.owner_id === a.transfer.from)
    || (!!a.ret?.from && b.owner_id === a.ret.from && !!a.ret.to && b.transfer?.origin === a.ret.to)
    || meetingOriginOf(a.transfer, a.owner_id) === meetingOriginOf(b.transfer, b.owner_id))));
}

export async function meetingTransferPending(app: App, caller: Caller, rec: { owner_id: string; source_kind?: string | null; source_ref?: string | null }): Promise<void> {
  if (rec.source_kind !== "transcriber" || !rec.source_ref) return;
  const rows: HandoverRoot[] = [];
  for (const cls of ["open", "closed"] as const)
    rows.push(...(await app.db.recordsForWrite(cls, caller.scope).query(
      `SELECT owner_id, attrs->'organizer_transfer' AS transfer, attrs->'organizer_return' AS ret
         FROM records WHERE source_kind = 'transcriber' AND source_ref = $1 AND parent_id IS NULL AND deleted_at IS NULL AND hidden_at IS NULL`,
      [rec.source_ref])).rows as HandoverRoot[]);
  if (rows.some((r) => r.transfer || r.ret) && organizerSplit(rows, rec.owner_id)) throw meetingHandoverBusy(MEETING_HANDOVER_TEXT);
}

async function returnPending(app: App, caller: Caller, ownerId: string, ref: string, control?: ControlQuery): Promise<boolean> {
  const hidden = new Set<string>();
  for (const cls of ["open", "closed"] as const)
    for (const r of (await app.db.recordsForWrite(cls, caller.scope).query(
      `SELECT id, hidden_at IS NOT NULL AS hidden FROM records
        WHERE attrs ? 'organizer_transfer' AND attrs->'organizer_transfer'->>'origin' = $2::text AND owner_id <> $2::uuid
          AND owner_id::text = attrs->'organizer_transfer'->>'to' AND source_kind = 'transcriber' AND source_ref = $1
          AND parent_id IS NULL AND deleted_at IS NULL`, [ref, ownerId])).rows as Array<{ id: string; hidden: boolean }>) {
      if (!r.hidden) return true;
      hidden.add(r.id);
    }
  if (!hidden.size) return false;
  const ids = [...hidden];
  if ((await (control ?? app.db.control).query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [ids])).rowCount) return true;
  for (const cls of ["open", "closed"] as const)
    if ((await app.db.recordsForWrite(cls, caller.scope).query("SELECT 1 FROM records WHERE id = ANY($1::uuid[]) AND hidden_at IS NULL LIMIT 1", [ids])).rowCount) return true;
  return false;
}

export async function meetingFamilyLocked(app: App, caller: Caller, control: ControlQuery,
                                          o: { ownerId: string; ref: string | null; locked: readonly string[]; anchor?: string | null }): Promise<void> {
  const busy = () => meetingHandoverBusy(MEETING_HANDOVER_TEXT);
  const locked = new Set(o.locked);
  const rows: Array<HandoverRoot & { id: string; hidden: boolean; deleted: boolean }> = [];
  for (const cls of ["open", "closed"] as const)
    rows.push(...(await app.db.recordsForWrite(cls, caller.scope).query(
      `SELECT id, owner_id, hidden_at IS NOT NULL AS hidden, deleted_at IS NOT NULL AS deleted,
              attrs->'organizer_transfer' AS transfer, attrs->'organizer_return' AS ret
         FROM records WHERE parent_id IS NULL AND (id = ANY($2::uuid[]) OR ($1::text IS NOT NULL AND source_kind = 'transcriber' AND source_ref = $1))`,
      [o.ref, [...locked]])).rows);
  if (rows.some((r) => locked.has(r.id) && !r.hidden && r.owner_id !== o.ownerId)) throw busy();
  if (!o.ref) return;
  const visible = new Set(rows.filter((r) => !r.hidden).map((r) => r.id));
  const family = rows.filter((r) => !r.deleted && (!r.hidden || (!visible.has(r.id) && !!(r.transfer || r.ret))));
  if (family.some((r) => r.transfer || r.ret) && organizerSplit(family, o.ownerId)) throw busy();
  if (o.anchor !== undefined && (await meetingRootIds(app, caller, o.ownerId, o.ref, o.anchor, control)).some((id) => !locked.has(id))) throw busy();
}

async function meetingRootIds(app: App, caller: Caller, ownerId: string, ref: string, anchor: string | null, control?: ControlQuery): Promise<string[]> {
  const rows: MeetingRootRow[] = [];
  for (const cls of ["open", "closed"] as const)
    rows.push(...(await app.db.recordsForWrite(cls, caller.scope).query(
      `SELECT id, supersedes_id, attrs->>'supersedes_id_other_class' AS other, attrs #>> '{access,asserted_by}' AS asserted_by, space_id
         FROM records WHERE source_kind = 'transcriber' AND source_ref = $1 AND owner_id = $2 AND parent_id IS NULL`, [ref, ownerId])).rows as MeetingRootRow[]);
  const service = caller.principalType === "service" ? caller.service?.name ?? null : null;
  return meetingFamily(rows, anchor, service ? { service } : { serviceSpaces: await serviceWriteSpaces(app, control) });
}

type Narrowing = { drop: string[]; dropLogins: string[] } | { keep: string[]; keepLogins: string[] };
async function narrowVersions(q: pg.PoolClient, versions: string[], ownerId: string, n: Narrowing): Promise<{ touched: string[]; removed: string[] }> {
  const keepMode = "keep" in n;
  if (!versions.length || (!keepMode && !n.drop.length && !n.dropLogins.length)) return { touched: [], removed: [] };
  const listed = new Set((keepMode ? n.keepLogins : n.dropLogins).map(lower));
  const gone = (login: unknown): boolean => listed.has(lower(login)) !== keepMode;
  const roots = (await q.query("SELECT id, attrs->'participants' AS participants, attrs->'participants_pending' AS pending FROM records WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
                               [[...versions].sort()])).rows as Array<{ id: string; participants: unknown; pending: unknown }>;
  const touched: string[] = [], removed = new Set<string>();
  for (const r of roots) {
    const tree = (await q.query(TREE, [r.id])).rows.map((x) => x.id as string);
    const del = keepMode
      ? await q.query("DELETE FROM record_people WHERE record_id = ANY($1::uuid[]) AND person_id <> ALL($2::uuid[]) AND person_id <> $3 RETURNING person_id", [tree, n.keep, ownerId])
      : await q.query("DELETE FROM record_people WHERE record_id = ANY($1::uuid[]) AND person_id = ANY($2::uuid[]) AND person_id <> $3 RETURNING person_id", [tree, n.drop, ownerId]);
    for (const x of del.rows) removed.add(x.person_id as string);
    if (keepMode) await q.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'participant' AND entity_id <> ALL($2::uuid[]) AND entity_id <> $3", [r.id, n.keep, ownerId]);
    else if (n.drop.length) await q.query("DELETE FROM record_entities WHERE record_id = $1 AND role = 'participant' AND entity_id = ANY($2::uuid[]) AND entity_id <> $3", [r.id, n.drop, ownerId]);
    const patch: Record<string, unknown> = {};
    if (Array.isArray(r.participants)) {
      const keep = r.participants.filter((l) => !gone(l));
      if (keep.length !== r.participants.length) patch.participants = keep;
    }
    if (Array.isArray(r.pending)) {
      const keep = r.pending.filter((x) => !gone((x as PendingParticipant)?.login));
      if (keep.length !== r.pending.length) patch.participants_pending = keep;
    }
    if (!del.rowCount && !Object.keys(patch).length) continue;
    if (Object.keys(patch).length) await q.query("UPDATE records SET attrs = attrs || $2::jsonb WHERE id = $1", [r.id, JSON.stringify(patch)]);
    await q.query(ACL_BUMP, [tree]);
    touched.push(...tree);
  }
  return { touched, removed: [...removed] };
}

type Narrowed = { touched: Record<DataClass, string[]>; removed: string[] };

export async function narrowLocked(app: App, caller: Caller, ownerId: string, versions: string[], n: Narrowing, control: pg.PoolClient): Promise<Narrowed> {
  const nn: Narrowing = "keep" in n ? { keep: [...new Set([ownerId, ...n.keep])], keepLogins: n.keepLogins } : n;
  const locs = (await control.query("SELECT record_id, class FROM record_locations WHERE record_id = ANY($1::uuid[])", [versions])).rows as Array<{ record_id: string; class: DataClass }>;
  const touched: Record<DataClass, string[]> = { open: [], closed: [] }, removed = new Set<string>();
  for (const cls of ["open", "closed"] as const) {
    const ids = locs.filter((l) => l.class === cls).map((l) => l.record_id);
    if (!ids.length) continue;
    const r = await tx(app.db.recordsForWrite(cls, caller.scope), (q) => narrowVersions(q, ids, ownerId, nn));
    touched[cls] = r.touched; r.removed.forEach((x) => removed.add(x));
  }
  return { touched, removed: [...removed] };
}

export async function narrowReport(app: App, caller: Caller, versions: string[], out: Narrowed): Promise<{ removed: string[]; records: string[] }> {
  const records = [...out.touched.open, ...out.touched.closed];
  if (records.length) {
    const classes = (["open", "closed"] as const).filter((c) => out.touched[c].length);
    await audit(app, caller, { event_type: "write", ...(classes.length === 1 ? { class: classes[0] } : {}), record_ids: records,
                               details: { op: "meeting_participants_changed", via: "ingest_version", added: 0, removed: out.removed.length, versions: versions.length } });
  }
  if (out.removed.length) await cancelMeetingMail(app, versions, out.removed);
  for (const cls of ["open", "closed"] as const) await leaveOrgNarrowed(app, caller, cls, out.touched[cls], "system");
  return { removed: out.removed, records };
}

async function versionsLeavingOrg(q: pg.PoolClient, versions: string[], orgId: string | null): Promise<string[]> {
  if (!orgId || !versions.length) return [];
  const trees = (await q.query(`WITH RECURSIVE t AS (SELECT id FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
                                 UNION ALL SELECT r.id FROM records r JOIN t ON r.parent_id = t.id) SELECT id FROM t`, [versions])).rows.map((x) => x.id as string);
  if (!trees.length) return [];
  const narrowed = (await q.query("UPDATE records SET audience = 'people' WHERE id = ANY($1::uuid[]) AND space_id = $2 AND audience <> 'people' RETURNING id",
                                  [trees, orgId])).rows.map((x) => x.id as string);
  if (narrowed.length) await q.query("UPDATE chunks SET audience = 'people' WHERE record_id = ANY($1::uuid[])", [narrowed]);
  return trees;
}

export async function applyParticipants(app: App, caller: Caller, rootId: string, ownerId: string, change: Resolution | ParticipantsChange,
                                        via: "ingest" | "workplace" = "ingest", o: { maxTotal?: number; waitSec?: number; sourceParticipants?: string[] } = {}): Promise<ParticipantsApplied> {
  const ch: ParticipantsChange = "items" in change ? { op: "set", rp: change } : change;
  const sourceParticipants = o.sourceParticipants;
  const { ids: versionIds, ref } = await meetingVersionIds(app, caller, rootId, ownerId);
  let versions = 1, skipped: string[] = [], leftSkipped: string[] = [];
  const org = await orgSpace(app);
  const out = await withRecordLocksWait(app, versionIds, async (ctl) => {
    const locs = (await ctl.query("SELECT record_id, class, deleted FROM record_locations WHERE record_id = ANY($1::uuid[]) AND (record_id <> $2 OR NOT deleted)", [versionIds, rootId])).rows as Array<{ record_id: string; class: DataClass; deleted: boolean }>;
    const head = locs.find((l) => l.record_id === rootId);
    if (!head) throw notFound();
    await meetingFamilyLocked(app, caller, ctl, { ownerId, ref, locked: versionIds, anchor: rootId });
    versions = locs.filter((l) => !l.deleted).length;
    const other: DataClass = head.class === "open" ? "closed" : "open";
    const sameClass = locs.filter((l) => l.record_id !== rootId && l.class === head.class).map((l) => l.record_id);
    const otherClass = locs.filter((l) => l.class === other).map((l) => l.record_id);
    return tx(app.db.recordsForWrite(head.class, caller.scope), async (q) => {
      await q.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[rootId, ...sameClass].sort()]);
      const rec = (await q.query("SELECT attrs, space_id FROM records WHERE id = $1 AND deleted_at IS NULL", [rootId])).rows[0];
      if (!rec) throw notFound();
      const attrs = (rec.attrs ?? {}) as Record<string, unknown>;
      const current = new Set<string>((await q.query("SELECT person_id FROM record_people WHERE record_id = $1", [rootId])).rows.map((x) => x.person_id as string));
      const curPending: PendingParticipant[] = Array.isArray(attrs.participants_pending) ? attrs.participants_pending as PendingParticipant[] : [];
      const curUnresolved: string[] = Array.isArray(attrs.participants_unresolved) ? (attrs.participants_unresolved as unknown[]).map(String) : [];
      const curLogins: string[] = Array.isArray(attrs.participants) ? (attrs.participants as unknown[]).map(String) : [];
      const wasPending = new Set<string>(curPending.map((x) => lower(x.login)));
      const left = new Set([...(await leftOf(q, [rootId, ...sameClass])), ...(await leftOf(app.db.recordsForWrite(other, caller.scope), otherClass))].map((m) => m.login));
      const isLeft = (x: { status: string; login?: string }): boolean => via === "ingest" && x.status !== "not_found" && !!x.login && left.has(lower(x.login));
      const items = ch.op === "remove" ? [] : ch.rp.items.filter((x) => !isLeft(x));
      if (ch.op !== "remove") leftSkipped = [...new Set(ch.rp.items.filter(isLeft).map((x) => lower(x.login)))];

      let ids: string[], logins: string[], pending: PendingParticipant[], unresolved: string[];
      if (sourceParticipants) {
        const named = new Set(sourceParticipants);
        const before = Array.isArray(attrs.source_participants) ? attrs.source_participants : [];
        const omitted = new Set(before.map(lower).filter((login) => !named.has(login)));
        const omittedIds = new Set<string>(omitted.size ? (await ctl.query(
          "SELECT id FROM people WHERE instance_id = $1 AND login = ANY($2::text[])", [app.instanceId, [...omitted]],
        )).rows.map((x) => x.id as string) : []);
        const pendingNames = new Set(curPending.flatMap((x) => [lower(x.login), lower(x.input)]));
        skipped = items.filter((x) => x.personId !== ownerId && !(x.personId && current.has(x.personId))
          && !pendingNames.has(lower(x.login ?? x.input)) && !pendingNames.has(lower(x.input))).map((x) => lower(x.login ?? x.input));
        ids = [...current].filter((id) => id === ownerId || !omittedIds.has(id));
        logins = curLogins.filter((login) => !omitted.has(lower(login)));
        pending = curPending.filter((x) => !omitted.has(lower(x.login)));
        unresolved = curUnresolved.filter((input) => !omitted.has(lower(input)));
        await q.query("UPDATE records SET attrs = jsonb_set(attrs, '{source_participants}', $2::jsonb) WHERE id = $1 AND attrs->'source_participants' IS DISTINCT FROM $2::jsonb",
                      [rootId, JSON.stringify(sourceParticipants)]);
      } else if (ch.op === "remove") {
        const gone = new Set(ch.logins.map(lower));
        const goneIds = new Set<string>((await ctl.query("SELECT id FROM people WHERE instance_id = $1 AND login = ANY($2::text[])", [app.instanceId, [...gone]])).rows
          .map((x) => x.id as string).filter((id) => id !== ownerId && current.has(id)));
        const pendingGone = curPending.some((x) => gone.has(lower(x.login)));
        if (!goneIds.size && !pendingGone) return null;
        ids = [...new Set([ownerId, ...[...current].filter((id) => !goneIds.has(id))])];
        logins = curLogins.filter((l) => !gone.has(lower(l)));
        pending = curPending.filter((x) => !gone.has(lower(x.login)));
        unresolved = curUnresolved.filter((x) => !gone.has(lower(x)));
      } else {
        const resolved = items.filter((x) => x.status === "resolved");
        const found: PendingParticipant[] = items.filter((x) => x.status === "in_directory").map((x) => ({ login: x.login!, display_name: x.display_name ?? null, input: x.input }));
        if (ch.op === "set") {
          ids = [...new Set([ownerId, ...resolved.map((x) => x.personId!)])];
          logins = [...new Set(resolved.map((x) => x.login!))];
          const { kept, inputs } = keptPending(curPending, items, found);
          pending = [...found, ...kept];
          unresolved = items.filter((x) => x.status === "not_found" && !(x.undetermined && inputs.has(x.input.toLowerCase()))).map((x) => x.input);
        } else {
          ids = [...new Set([ownerId, ...current, ...resolved.map((x) => x.personId!)])];
          logins = [...new Set([...curLogins, ...resolved.map((x) => x.login!)])];
          pending = [...curPending, ...found.filter((x, i) => !wasPending.has(lower(x.login)) && found.findIndex((y) => lower(y.login) === lower(x.login)) === i)];
          unresolved = curUnresolved;
        }
      }
      if (head.class === "open") unresolved = unresolved.filter((x) => curUnresolved.some((y) => lower(y) === lower(x)));
      if (!sourceParticipants && head.class === "open" && attrs.open_check_accepted && via === "ingest") {
        const loginOf = new Map(items.filter((x) => x.status === "resolved").map((x) => [x.personId!, lower(x.login)]));
        const fresh = ids.filter((id) => id !== ownerId && !current.has(id));
        const freshPending = pending.filter((x) => !wasPending.has(lower(x.login)));
        skipped = [...fresh.map((id) => loginOf.get(id) ?? id), ...freshPending.map((x) => lower(x.login))];
        const dropped = new Set(fresh.map((id) => loginOf.get(id)).filter((l): l is string => !!l));
        ids = ids.filter((id) => !fresh.includes(id));
        logins = logins.filter((l) => !dropped.has(lower(l)));
        pending = [...pending.filter((x) => wasPending.has(lower(x.login))), ...curPending.filter((x) => dropped.has(lower(x.login)))];
      }
      const same = current.size === ids.length && ids.every((id) => current.has(id)) && wasPending.size === pending.length && pending.every((x) => wasPending.has(lower(x.login)));
      if (same) {
        const sameUnresolved = unresolved.length === curUnresolved.length && unresolved.every((x) => curUnresolved.some((y) => lower(y) === lower(x)));
        if (!sameUnresolved)
          await q.query("UPDATE records SET attrs = (attrs - 'participants_unresolved') || $2::jsonb WHERE id = $1",
                        [rootId, JSON.stringify(unresolved.length ? { participants_unresolved: unresolved } : {})]);
        return null;
      }

      const newPeople = ids.filter((id) => id !== ownerId && !current.has(id)), newPending = pending.filter((x) => !wasPending.has(lower(x.login)));
      const tree = (await q.query(TREE, [rootId])).rows.map((x) => x.id as string);
      if (newPending.length) {
        const homes = (await q.query("SELECT DISTINCT space_id FROM records WHERE id = ANY($1::uuid[])", [tree])).rows.map((x) => x.space_id as string);
        const arch = await archivedTeamSpace(ctl, [rec.space_id, ...homes]);
        if (arch) throw peopleOnlyNarrow(arch);
      }
      if (ids.some((id) => !current.has(id))) await archivedOnlyNarrows(app, q, tree, ids, ownerId, ctl);
      if (newPeople.length || newPending.length) {
        if (head.class === "open" && attrs.open_check_accepted)
          throw new MemoryError("forbidden", "The meeting was shown to agents despite a finding from the check. Only a record you alone can read can be shown this way. To add participants, select “Hide from agents” first, then add them");
        if (o.maxTotal !== undefined) {
          const was = [...current].filter((id) => id !== ownerId).length + curPending.length;
          const total = ids.filter((id) => id !== ownerId).length + pending.length;
          if (total > o.maxTotal)
            throw invalid(was >= o.maxTotal
              ? `A meeting can have up to ${o.maxTotal} participants, and it already has ${was}. You cannot add anyone, but you can always remove participants`
              : `A meeting can have up to ${o.maxTotal} participants. Adding these participants would bring the total to ${total}, so the list was not changed`);
        }
      }
      const removed = [...current].filter((id) => id !== ownerId && !ids.includes(id));
      const removedPending = curPending.map((x) => lower(x.login))
        .filter((l) => !pending.some((y) => lower(y.login) === l) && !logins.some((y) => lower(y) === l));
      const removedLogins = removed.length ? (await ctl.query("SELECT login FROM people WHERE id = ANY($1::uuid[])", [removed])).rows.map((x) => lower(x.login)) : [];
      const narrowIds = [...new Set([...removed, ...(removedPending.length
        ? (await ctl.query("SELECT id FROM people WHERE instance_id = $1 AND login = ANY($2::text[])", [app.instanceId, removedPending])).rows.map((x) => x.id as string).filter((id) => id !== ownerId && !ids.includes(id))
        : [])])];
      const narrowLogins = [...new Set([...removedLogins, ...removedPending])];
      const touched: Record<DataClass, string[]> = { open: [], closed: [] }, leaving: Record<DataClass, string[]> = { open: [], closed: [] };
      const narrowing = narrowIds.length > 0 || narrowLogins.length > 0;
      if (otherClass.length && (narrowing || org))
        await tx(app.db.recordsForWrite(other, caller.scope), async (q2) => {
          if (narrowing) touched[other] = (await narrowVersions(q2, otherClass, ownerId, { drop: narrowIds, dropLogins: narrowLogins })).touched;
          leaving[other] = await versionsLeavingOrg(q2, otherClass, org?.id ?? null);
        });
      touched[head.class].push(...(await narrowVersions(q, sameClass, ownerId, { drop: narrowIds, dropLogins: narrowLogins })).touched);
      leaving[head.class] = await versionsLeavingOrg(q, sameClass, org?.id ?? null);

      if (sourceParticipants) {
        await q.query("DELETE FROM record_people WHERE record_id = ANY($1::uuid[]) AND person_id = ANY($2::uuid[])", [tree, narrowIds]);
      } else {
        await q.query("DELETE FROM record_people WHERE record_id = ANY($1::uuid[])", [tree]);
        await q.query("INSERT INTO record_people (record_id, person_id) SELECT t, p FROM unnest($1::uuid[]) t CROSS JOIN unnest($2::uuid[]) p ON CONFLICT DO NOTHING", [tree, ids]);
      }
      await q.query("UPDATE records SET audience = 'people' WHERE id = ANY($1::uuid[])", [tree]);
      await q.query(ACL_BUMP, [tree]);
      await q.query("UPDATE chunks SET audience = 'people' WHERE record_id = ANY($1::uuid[])", [tree]);
      await q.query("UPDATE records SET attrs = (attrs - 'participants_pending' - 'participants_unresolved') || jsonb_build_object('participants', $2::jsonb) || $3::jsonb WHERE id = $1",
                    [rootId, JSON.stringify(logins), JSON.stringify({ ...(pending.length ? { participants_pending: pending } : {}), ...(unresolved.length ? { participants_unresolved: unresolved } : {}) })]);
      const back = via === "workplace" ? [...left].filter((l) => logins.some((y) => lower(y) === l) || pending.some((y) => lower(y.login) === l)) : [];
      if (back.length) {
        await q.query(CLEAR_LEFT, [[rootId, ...sameClass], back]);
        if (otherClass.length) await app.db.recordsForWrite(other, caller.scope).query(CLEAR_LEFT, [otherClass, back]);
      }
      const listed = sourceParticipants ? [] : items.filter((x) => x.status === "resolved").map((x) => x.personId!);
      const linked = ch.op === "set" && !sourceParticipants ? [] : (await q.query("SELECT entity_id FROM record_entities WHERE record_id = $1 AND role = 'participant'", [rootId])).rows.map((x) => x.entity_id as string);
      const participantIds = [...new Set([...linked, ...listed])].filter((id) => ids.includes(id));
      await syncParticipantLinks(q, rootId, participantIds);
      touched[head.class].push(...tree);
      return { touched, leaving, tree, head: head.class, added: ids.filter((id) => !current.has(id)), removed: narrowIds, pending: pending.length, participantIds };
    });
  }, { waitSec: o.waitSec });
  if (!out) return { changed: false, added: [], removed: [], records: [], versions, skipped, left: leftSkipped };
  await personEntities(app, out.participantIds);
  const records = [...new Set([...out.touched.open, ...out.touched.closed])];
  const classes = (["open", "closed"] as const).filter((c) => out.touched[c].length);
  await audit(app, caller, { event_type: "write", ...(classes.length === 1 ? { class: classes[0] } : {}), record_ids: records,
                             details: { op: "meeting_participants_changed", via, added: out.added.length, removed: out.removed.length, pending: out.pending,
                                        ...(versionIds.length > 1 ? { versions: versionIds.length } : {}) } });
  if (out.removed.length) await cancelMeetingMail(app, versionIds, out.removed);
  for (const cls of ["open", "closed"] as const) {
    const first = cls === out.head ? out.tree : [];
    const units = [...new Set([...first, ...out.touched[cls], ...out.leaving[cls]])];
    if (units.length) await leaveOrgNarrowed(app, caller, cls, units, via === "workplace" ? "author" : "system");
  }
  return { changed: true, added: out.added, removed: out.removed, records, versions, skipped, left: leftSkipped };
}

export async function leaveMeeting(app: App, caller: Caller, rootId: string, ownerId: string, o: { waitSec?: number } = {}): Promise<{ changed: boolean; versions: number; records: string[] }> {
  const me = caller.person!;
  if (me.id === ownerId) throw invalid("You are the meeting organizer. You can delete the meeting, but you cannot leave it");
  const { ids: versionIds, ref } = await meetingVersionIds(app, caller, rootId, ownerId);
  const at = new Date().toISOString();
  let versions = 1;
  const touched: Record<DataClass, string[]> = { open: [], closed: [] };
  const removed = await withRecordLocksWait(app, versionIds, async (ctl) => {
    const locs = (await ctl.query("SELECT record_id, class, deleted FROM record_locations WHERE record_id = ANY($1::uuid[])", [versionIds])).rows as Array<{ record_id: string; class: DataClass; deleted: boolean }>;
    if (!locs.some((l) => l.record_id === rootId && !l.deleted)) throw notFound();
    await meetingFamilyLocked(app, caller, ctl, { ownerId, ref, locked: versionIds, anchor: rootId });
    versions = locs.filter((l) => !l.deleted).length;
    let any = false;
    for (const cls of ["open", "closed"] as const) {
      const ids = locs.filter((l) => l.class === cls).map((l) => l.record_id);
      if (!ids.length) continue;
      const r = await tx(app.db.recordsForWrite(cls, caller.scope), async (q) => {
        const n = await narrowVersions(q, ids, ownerId, { drop: [me.id], dropLogins: [me.login] });
        await q.query(MARK_LEFT, [ids, lower(me.login), at]);
        return n;
      });
      touched[cls] = r.touched;
      any ||= r.removed.length > 0 || r.touched.length > 0;
    }
    return any;
  }, { waitSec: o.waitSec });
  const records = [...touched.open, ...touched.closed];
  if (removed) {
    const classes = (["open", "closed"] as const).filter((c) => touched[c].length);
    await audit(app, caller, { event_type: "write", ...(classes.length === 1 ? { class: classes[0] } : {}), record_ids: records,
                               details: { op: "meeting_participant_left", author: ownerId, by_role: "participant", ...(versionIds.length > 1 ? { versions: versionIds.length } : {}) } });
    await cancelMeetingMail(app, versionIds, [me.id]);
  }
  return { changed: removed, versions, records };
}

export const MEETING_MAIL_CANCELLED = { code: "participant_removed", text: "The e-mail was not sent because the person was removed from the meeting before it went out" } as const;

export async function cancelMeetingMail(app: App, recordIds: string[], personIds: string[]): Promise<number> {
  const keys = recordIds.flatMap((r) => personIds.map((p) => `meeting_new:${r}:${p}`));
  if (!keys.length) return 0;
  try {
    return (await app.db.control.query(
      `UPDATE mail_outbox SET status = 'cancelled', last_error_code = $3, last_error = $4, updated_at = now()
        WHERE instance_id = $1 AND kind = 'meeting_new' AND status IN ('pending','failed') AND dedupe_key = ANY($2::text[])`,
      [app.instanceId, keys, MEETING_MAIL_CANCELLED.code, MEETING_MAIL_CANCELLED.text])).rowCount ?? 0;
  } catch (e) {
    log.warn("meeting_mail_cancel_failed", { error: (e as Error).message.slice(0, 160) });
    return 0;
  }
}

export async function notifyParticipants(app: App, rec: { id: string; title: string | null; occurred_at: Date | string; owner_id: string }, personIds: string[]): Promise<void> {
  const ids = personIds.filter((x) => x !== rec.owner_id);
  if (!ids.length || app.settings.get<boolean>("meetings.notify_participants", false) !== true || !smtpConfig(app.settings).enabled) return;
  const ctl = app.db.control;
  const people = (await ctl.query("SELECT id, login, display_name FROM people WHERE id = ANY($1::uuid[]) AND active", [[...ids, rec.owner_id]])).rows;
  const owner = people.find((p) => p.id === rec.owner_id);
  const who = owner ? (owner.display_name?.trim() || owner.login) : "organiser";
  const title = rec.title ?? "meeting", date = new Date(rec.occurred_at).toISOString().slice(0, 10), link = workplaceUrl(app, `/records/${rec.id}`);
  let queued = 0;
  for (const p of people) {
    if (p.id === rec.owner_id || !MAIL_RE.test(p.login)) continue;
    await ctl.query(
      `UPDATE mail_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error_code = NULL, last_error = NULL, updated_at = now()
        WHERE instance_id = $1 AND dedupe_key = $2 AND status = 'cancelled' AND last_error_code = ANY($3::text[])`,
      [app.instanceId, `meeting_new:${rec.id}:${p.id}`, [MEETING_MAIL_CANCELLED.code, MEETING_MAIL_NOT_PARTICIPANT]]);
    await enqueueMail(ctl, app.instanceId, {
      kind: "meeting_new", dedupeKey: `meeting_new:${rec.id}:${p.id}`, createdBy: owner?.login ?? null, to: p.login,
      subject: `Prisma Memory: You are a participant in “${title.slice(0, 120)}”`,
      text: [
        `You are a participant in “${title}” from ${date} (organizer: ${who}). The meeting transcript, summary and decisions are now available in memory to you and your AI agents.`,
        "",
        "The summary and decisions appear a few minutes after submission. If the model is busy during the day, they appear after nightly processing.",
        link ? `Open the meeting: ${link}` : "The meeting is in the workspace, section “Meetings with me”.",
        "To request deletion, select “Ask to delete” on the meeting page.",
        "",
        `Record: ${rec.id}. You do not need to reply to this e-mail.`,
      ].join("\n"),
    });
    queued++;
  }
  if (queued) await app.queue.wake("mail");
}
