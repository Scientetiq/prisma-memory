// The delivery loop of connectors: the only code that turns staged connector items into
// records, and it does so through the same functions as REST and MCP — acceptMeeting() with the existing channel
// `script`, upload() and remember() — as the connector's run-as person (caller.ts), after the class and space
// gates (gates.ts). It runs inside the gateway process (the per-meeting and per-file queues of those functions live
// here): a poll every 5 s plus wakeDelivery() from the hooks handler. The state table connector_items is the queue:
// an item is claimed with FOR UPDATE SKIP LOCKED and a 2-minute lease (status `delivering`, extended every 30 s), one
// item at a time per connector (claims of an instance take turns under an advisory lock, so two gateway processes
// never claim two items of one connector), at most 2 connectors in parallel per process; a second gateway process sees
// the lease. The loop does nothing while integrations.connectors_enabled is false or the instance is fail_closed (the
// rule of the REST routes); the health state is asked only when an item is due.
//
// Outcomes, written only while the row is still the claimed one (status `delivering`, same content hash — a newer
// staging of the item wins):
// - delivered (record id, class, version; `adopted` when the write answered already_known with a record the item did not
//   point to yet — the record existed before this delivery: a file the person uploaded, or the retry after a crash
//   between the write and this update, which is the safe direction; the record the item already points to keeps its
//   flag) and one audit event `processing` / connector_delivered with ids only. A newer staging that replaced the row
//   while the write ran still gets the record id, so a changed document never becomes a second record;
// - held when upload() found the same file in another space of the person and did not place it into the target
//   (`placement_unavailable`), or when the item alone is larger than the person's whole daily budget
//   (`over_daily_budget`: it would wait for ever and hold the connector's other items back);
// - held with a code an administrator or the source can clear (gates, run-as person, consent, open-content check);
//   codes that every later item would meet too also stop the connector (status error, revoked or needs_reconfirm);
// - failed or skipped with a code (invalid, too large, staged body gone, format not accepted);
// - retried: back to `staged` after 1, 5, 25, 120, 720 minutes, failed after the 6th attempt;
// - the run-as person's daily upload budget used up (rate_limited with reason upload_daily), or the connector's own daily
//   quota (connector_daily, quotas.ts): the whole connector waits until the next day, no attempt is counted.
// Changes and deletions at the source: a changed document follows the connector's on_change policy (changes.ts:
// a new version through document versions, held as `versions_unavailable` while the build has none, or a new
// record); an item deleted at the source follows on_delete (deletes.ts: keep, or the run-as person's trash for a record
// the connector made alone). The connector's daily quota is taken right before the write function and given back when
// the item did not become a record.
import { auditConnectorDelivered, auditConnectorPaused, externalEntityKey, failureClass, type DeliveryReasonCode, type DocumentItem, type EntityRef, type MeetingItem,
         type NoteItem } from "@memory/connectors";
import { log, MemoryError, parseEntityKey, tx, type DataClass } from "@memory/shared";
import { HttpReject } from "../auth.ts";
import { audit } from "../audit.ts";
import type { App, Caller } from "../context.ts";
import { healthState } from "../health.ts";
import { acceptMeeting, parseMeetingBody } from "../meetings.ts";
import { remember, upload } from "../write.ts";
import { runAs, type ConnectorRow } from "./caller.ts";
import { documentPlan, versionRefusal, type DocumentPlan } from "./changes.ts";
import { anyDeleteDue, claimDelete, handleDelete } from "./deletes.ts";
import { deliveryTarget, type Gate } from "./gates.ts";
import { ConnectorQuotaError, takeConnectorDaily, type ConnectorDailyTake } from "./quotas.ts";
import { readStaged, StagedReadError } from "./staging.ts";

export const DELIVERY_POLL_MS = 5_000;
export const DELIVERY_LEASE_SEC = 120;
export const DELIVERY_HEARTBEAT_MS = 30_000;
/** Connectors delivered at once by one gateway process (one item each). */
export const DELIVERY_PARALLEL = 2;
/** Minutes before the next attempt after the 1st … 5th retryable failure; the 6th fails the item. */
export const DELIVERY_LADDER_MIN: readonly number[] = [1, 5, 25, 120, 720];
export const DELIVERY_MAX_ATTEMPTS = 6;
/** Items one poll delivers at most before it yields (the next poll continues). */
const ROUND_MAX = 50;
const RECORD_TYPES = ["document", "meeting", "note"];
const CONNECTOR_COLS = "id, instance_id, kind, pack, name, scope, owner_id, target_space_id, data_class, status, config, policy, consent_version, consent_by, last_error, created_by";
const MIB = 1024 * 1024;
/**
 * Kinds whose meeting ids are the vendor's own and the same everywhere: the same id means the same meeting, also from
 * a connector created again (Fireflies, Fathom). Every other kind (`webhook` above all: n8n, Zapier,
 * Make and scripts number their meetings themselves) gets the connector in the meeting id, so two connectors of one
 * person never turn each other's meetings into versions.
 */
const VENDOR_MEETING_KINDS: ReadonlySet<string> = new Set(["fireflies", "fathom"]);

/** The meeting id of a meeting item: `<kind>:<external_id>` for vendor kinds, `<kind>:<connector id>:<external_id>` otherwise. */
export const connectorMeetingId = (c: Pick<ConnectorRow, "id" | "kind">, externalId: string): string =>
  VENDOR_MEETING_KINDS.has(c.kind) ? `${c.kind}:${externalId}` : `${c.kind}:${c.id}:${externalId}`;

/** A claimed item. */
export interface ClaimedItem {
  id: string; connector_id: string; item_type: string; external_id: string; content_hash: Buffer; staged_key: string | null;
  attempts: number; record_id: string | null; adopted: boolean; lease_until: Date | null;
}

type Outcome =
  | { kind: "delivered"; recordId: string; cls: DataClass; version: number; adopted: boolean; reason: "entities_unresolved" | null }
  | { kind: "held" | "failed" | "skipped"; reason: DeliveryReasonCode; stop?: StopKind }
  | { kind: "retry"; reason: DeliveryReasonCode }
  | { kind: "wait"; reason: "upload_daily" | "connector_daily"; seconds: number }
  | { kind: "release" };
/** What a code does to the connector: stop with status error, revoked (person connectors) or needs_reconfirm. */
type StopKind = "error" | "needs_reconfirm";

export interface DeliveryResult { itemId: string; connectorId: string; status: string; reason: string | null }

/**
 * Claims one due record item of an active connector of this instance that has no item in delivery now and is not in
 * `busy` (connectors this process already works on). Lease expired → the item is claimed again, and that counts as an
 * attempt: an item that brings the process down every time ends `failed` instead of coming back for ever.
 */
export async function claimItem(app: App, busy: readonly string[]): Promise<ClaimedItem | null> {
  // claims of one instance take turns: NOT EXISTS below is read from the snapshot of the statement, so two claims at the
  // same moment could each take an item of the same connector (claims are short; the lock ends with the transaction)
  return tx(app.db.control, async (q) => {
  await q.query("SELECT pg_advisory_xact_lock(hashtext('connector_claim:' || $1))", [app.instanceId]);
  const { rows } = await q.query(
    `WITH cand AS (
       SELECT i.id, i.status AS was FROM connector_items i JOIN connectors c ON c.id = i.connector_id
       WHERE c.instance_id = $1 AND c.status = 'active' AND i.item_type = ANY($4::text[])
         AND ((i.status = 'staged' AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= now()))
              OR (i.status = 'delivering' AND (i.lease_until IS NULL OR i.lease_until < now())))
         AND NOT (i.connector_id = ANY($2::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM connector_items d WHERE d.connector_id = i.connector_id AND d.status = 'delivering' AND d.lease_until >= now())
       ORDER BY i.next_attempt_at NULLS FIRST, i.received_at, i.id
       LIMIT 1
       FOR UPDATE OF i, c SKIP LOCKED)
     UPDATE connector_items x SET status = 'delivering', lease_until = now() + make_interval(secs => $3),
                                  attempts = x.attempts + CASE WHEN cand.was = 'delivering' THEN 1 ELSE 0 END
     FROM cand WHERE x.id = cand.id
     RETURNING x.id, x.connector_id, x.item_type, x.external_id, x.content_hash, x.staged_key, x.attempts, x.record_id, x.adopted, x.lease_until`,
    [app.instanceId, [...busy], DELIVERY_LEASE_SEC, RECORD_TYPES]);
  return (rows[0] as ClaimedItem | undefined) ?? null;
  });
}

/** Whether any record item (a delivery or a deletion) of an active connector of this instance is due now (a cheap look before the health state). */
async function anyDue(app: App): Promise<boolean> {
  const { rows } = await app.db.control.query(
    `SELECT EXISTS (SELECT 1 FROM connector_items i JOIN connectors c ON c.id = i.connector_id
       WHERE c.instance_id = $1 AND c.status = 'active' AND i.item_type = ANY($2::text[])
         AND ((i.status = 'staged' AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= now()))
              OR (i.status = 'delivering' AND (i.lease_until IS NULL OR i.lease_until < now())))) AS due`, [app.instanceId, RECORD_TYPES]);
  return rows[0]?.due === true || await anyDeleteDue(app, RECORD_TYPES);
}

/** Held items of a connector back to `staged` (after the administrator or the owner cleared the cause); `reasons` — only these. */
export async function requeueHeld(app: App, connectorId: string, reasons?: readonly string[]): Promise<number> {
  const { rowCount } = await app.db.control.query(
    `UPDATE connector_items SET status = 'staged', reason = NULL, attempts = 0, next_attempt_at = now(), lease_until = NULL
     WHERE connector_id = $1 AND status = 'held' AND ($2::text[] IS NULL OR reason = ANY($2::text[]))`, [connectorId, reasons ? [...reasons] : null]);
  if (rowCount) wakeDelivery();
  return rowCount ?? 0;
}

// ---------------------------------------------------------------- items → arguments of the write functions

/** Entity keys of the item's references that the memory parses today; the rest is counted. */
function entityKeys(refs: readonly EntityRef[] | undefined): { keys: string[]; dropped: number } {
  const keys = new Set<string>();
  let dropped = 0;
  for (const ref of refs ?? []) {
    let key: string | null = null;
    if ("email" in ref) key = `person:${ref.email.toLowerCase()}`;
    else {
      const r = externalEntityKey(ref.system, ref.kind, ref.id);
      key = r.ok ? r.key.key : null;
    }
    if (key && parseEntityKey(key)) keys.add(key);
    else dropped++;
  }
  return { keys: [...keys].slice(0, 20), dropped };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * What a write counts: `bytes` against the run-as person's daily budget, and the connector's own daily quota, taken by
 * take() right before the write function is called (given back by the caller when the item did not become a record).
 */
interface WriteSize { bytes?: number; take(bytes: number): Promise<void> }

/** Upload arguments of a document item; `replaces` — the version path of (doc-versions.ts). */
type DocumentArgs = Parameters<typeof upload>[2] & { replaces?: string };
type UploadOut = { result: { id: string; class: DataClass; already_known: boolean; placed?: boolean; entities_unresolved?: string[] }; chain?: { version?: number } };

async function writeDocument(app: App, caller: Caller, c: ConnectorRow, gate: Extract<Gate, { ok: true }>, d: DocumentItem, plan: Extract<DocumentPlan, { kind: "upload" | "version" }>,
                             size: WriteSize): Promise<Outcome> {
  const isText = typeof d.text === "string";
  const bytes = isText ? Buffer.from(d.text!, "utf8") : Buffer.from(d.content ?? new Uint8Array());
  await size.take(bytes.length);
  const mime = d.mime ?? (isText ? (/\.(md|markdown)$/i.test(d.filename) ? "text/markdown" : "text/plain") : "application/octet-stream");
  const ents = entityKeys(d.entities);
  const args: DocumentArgs = { filename: d.filename, mime, bytes, space: gate.ref, title: d.title, occurred_at: d.occurred_at, entities: ents.keys,
                               sourceRef: `conn:${c.id}:${d.external_id}` };
  // The extended scope lets read and replace the run-as person's own closed head, including under its locks.
  const headCaller: Caller | undefined = plan.kind === "version" && plan.cls === "closed"
    ? { ...caller, keyKind: "extended", scope: { ...caller.scope, classes: ["closed"], keyKind: "extended" } }
    : undefined;
  let replaces = plan.kind === "version" ? plan.replaces : undefined;
  let out: UploadOut | null = null;
  // a newer version added meanwhile (not_current): the version goes on top of the current one — a few times at most
  for (let turn = 0; turn < 3 && !out; turn++) {
    try {
      out = (await upload(app, caller, (replaces ? { ...args, replaces } : args) as Parameters<typeof upload>[2], replaces ? headCaller : undefined)) as unknown as UploadOut;
    } catch (e) {
      const r = replaces ? versionRefusal(e) : null;
      if (!r) throw e;
      if (r.kind === "held") return { kind: "held", reason: r.reason };
      replaces = r.kind === "replace" ? r.id : undefined;
    }
  }
  if (!out) return { kind: "retry", reason: "in_progress" };
  const res = out.result;
  // the same file in another space of the person: upload() did not place it into the target — nothing landed there
  if (res.already_known === true && res.placed === false) return { kind: "held", reason: "placement_unavailable" };
  const version = replaces && typeof out.chain?.version === "number" ? out.chain.version : 1;
  return { kind: "delivered", recordId: res.id, cls: res.class, version, adopted: !replaces && res.already_known === true,
           reason: ents.dropped || res.entities_unresolved?.length ? "entities_unresolved" : null };
}

async function writeNote(app: App, caller: Caller, c: ConnectorRow, gate: Extract<Gate, { ok: true }>, n: NoteItem, size: WriteSize): Promise<Outcome> {
  await size.take(Buffer.byteLength(n.text, "utf8"));
  const ents = entityKeys(n.entities);
  const out = (await remember(app, caller, { text: n.text, title: n.title, space: gate.ref, kind: n.kind ?? "note", entities: ents.keys, occurred_at: n.occurred_at,
                                             // «stated by a human, confirmed» only when an administrator switched it on for this connector
                                             origin: c.config?.human_authored === true ? "human" : "agent" })).result;
  return { kind: "delivered", recordId: out.id, cls: out.class, version: 1, adopted: out.already_known === true,
           reason: ents.dropped || out.entities_unresolved.length ? "entities_unresolved" : null };
}

/** `first` — the item has no record yet (its first delivery). */
async function writeMeeting(app: App, caller: Caller, c: ConnectorRow, m: MeetingItem, size: WriteSize, first: boolean): Promise<Outcome> {
  if (!c.consent_version) return { kind: "held", reason: "consent_outdated", stop: "needs_reconfirm" };
  const policy = c.policy?.participants === "attended_emails" ? "attended_emails" : "owner_only";
  const reported = (m.participants ?? []).map((p) => ({ ...(p.name ? { name: p.name } : {}), ...(p.email ? { email: p.email } : {}),
                                                        ...(p.attended !== undefined ? { attended: p.attended } : {}), ...(p.role ? { role: p.role } : {}) }));
  // names never grant access; under attended_emails only an attended participant with an e-mail (an invitee is never attended)
  const participants = policy === "attended_emails"
    ? [...new Set((m.participants ?? []).filter((p) => p.attended === true && p.role !== "invitee" && p.email).map((p) => p.email!.toLowerCase()))] : [];
  const t = m.transcript;
  const segments = "segments" in t ? t.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, text: s.text, speaker: s.speaker ?? null })) : undefined;
  const text = "segments" in t ? t.segments.map((s) => s.text).join("\n") : t.text;
  const ents = entityKeys(m.entities);
  const input = parseMeetingBody({
    meeting_id: connectorMeetingId(c, m.external_id), started_at: m.started_at, title: m.title, text, ...(segments ? { segments } : {}),
    ...("text" in t && t.format ? { format: t.format } : {}), participants, entities: ents.keys,
    // the item never relies on the server default of the language
    language: m.language ?? str(c.config?.language) ?? "en", ...(typeof m.duration_sec === "number" ? { duration_sec: m.duration_sec } : {}),
    attrs: { connector: { id: c.id, kind: c.kind }, ...(reported.length ? { participants_reported: reported } : {}) },
    consent: { accepted: true, version: c.consent_version },
  }, { initiatorRequired: false });
  // acceptMeeting() counts the sent form of the transcript (or the canonical text) against the daily budget
  await size.take(Buffer.byteLength(input.original ? input.original.text : input.text, "utf8"));
  const r = await acceptMeeting(app, caller, "script", input, { automatic: true, auditDetails: { connector_id: c.id, connector_kind: c.kind } });
  const b = r.body as { id: string; class: DataClass; version: number; already_known: boolean };
  const version = Number(b.version) || 1;
  // the meeting existed before this item when its first delivery is already a later version (a person's own upload of the
  // same vendor meeting, or an earlier connector of that kind): the chain is not the connector's own — never trashed
  return { kind: "delivered", recordId: b.id, cls: b.class, version, adopted: b.already_known === true || (first && version > 1),
           reason: ents.dropped ? "entities_unresolved" : null };
}

/** An error of a write function as an outcome; `bytes` — what the write counted against the daily budget. */
export function outcomeOf(e: unknown, bytes?: number): Outcome {
  // the connector's own daily quota: wait until the next day (no attempt counted), or held when the item never fits
  if (e instanceof ConnectorQuotaError) return e.kind === "over" ? { kind: "held", reason: "over_connector_daily" } : { kind: "wait", reason: "connector_daily", seconds: Math.max(60, e.seconds) };
  if (e instanceof StagedReadError) return e.code === "storage_unavailable" ? { kind: "retry", reason: "storage_unavailable" } : { kind: "failed", reason: e.code };
  if (e instanceof HttpReject) return { kind: "held", reason: "run_as_denied", stop: "error" };
  if (!(e instanceof MemoryError)) return { kind: "retry", reason: "internal" };
  const details = (e.extra.details ?? {}) as Record<string, unknown>;
  switch (e.code) {
    case "invalid_argument":
      if (details.consent) return { kind: "held", reason: "consent_outdated", stop: "needs_reconfirm" };
      if (details.accepted !== undefined || details.refusal !== undefined) return { kind: "skipped", reason: "format_not_accepted" };
      return { kind: "failed", reason: "invalid_argument" };
    case "too_large": return { kind: "failed", reason: "too_large" };
    case "class_denied": return details.archived ? { kind: "held", reason: "space_denied", stop: "error" } : { kind: "held", reason: "class_denied" };
    case "open_check": return { kind: "held", reason: "open_check" };
    case "never_open": return { kind: "held", reason: "never_open" };
    case "not_found": case "forbidden": return { kind: "held", reason: "space_denied", stop: "error" };
    case "unauthorized": return { kind: "held", reason: "run_as_denied", stop: "error" };
    case "rate_limited":
      if (details.reason === "upload_daily") {
        // larger than the whole daily budget: no day would let it through — hold it instead of holding the connector back
        const limit = Number(details.mib_limit);
        if (details.kind === "mib" && typeof bytes === "number" && Number.isFinite(limit) && bytes > limit * MIB) return { kind: "held", reason: "over_daily_budget" };
        return { kind: "wait", reason: "upload_daily", seconds: Math.max(60, Math.ceil(Number(e.extra.retry_after) || 3600)) };
      }
      return { kind: "retry", reason: "rate_limited" };
    case "in_progress": return { kind: "retry", reason: "in_progress" };
    default: return { kind: "retry", reason: "internal" };
  }
}

// ---------------------------------------------------------------- one item

const cref = (c: ConnectorRow) => ({ id: c.id, kind: c.kind, scope: c.scope });

/** Stops a connector whose every next item would meet the same code; one audit event when it was active. */
async function stopConnector(app: App, caller: Caller | null, c: ConnectorRow, kind: StopKind, reason: string): Promise<void> {
  const status = kind === "needs_reconfirm" ? "needs_reconfirm" : reason === "owner_inactive" && c.scope === "person" ? "revoked" : "error";
  const { rowCount } = await app.db.control.query("UPDATE connectors SET status = $2, last_error = $3, updated_at = now() WHERE id = $1 AND status = 'active'", [c.id, status, reason]);
  if (rowCount) await audit(app, caller, auditConnectorPaused(cref(c), reason));
}

/** Writes the outcome while the row is still the claimed one; false — a newer staging replaced it (nothing written). */
async function finish(app: App, caller: Caller | null, c: ConnectorRow, it: ClaimedItem, o: Outcome): Promise<{ status: string; reason: string | null } | null> {
  const q = app.db.control;
  const own = "id = $1 AND status = 'delivering' AND content_hash = $2";
  const base = [it.id, it.content_hash];
  switch (o.kind) {
    case "delivered": {
      // adopted: the record the item already points to keeps its flag; a new version of a meeting keeps the flag of the
      // chain (a meeting that existed before the connector stays protected after the connector added a version to it);
      // a new record of a document or a note is the connector's own
      const adopted = (rec: string, flag: string) => `CASE WHEN record_id = ${rec} THEN adopted WHEN item_type = 'meeting' THEN adopted OR ${flag} ELSE ${flag} END`;
      const r = await q.query(
        `UPDATE connector_items SET status = 'delivered', reason = $3, record_id = $4, record_class = $5, version = $6,
                adopted = ${adopted("$4", "$7")}, delivered_at = now(),
                lease_until = NULL, next_attempt_at = NULL WHERE ${own}`, [...base, o.reason, o.recordId, o.cls, o.version, o.adopted]);
      if (!r.rowCount) {
        // a newer staging replaced the row while the write ran: the record exists, so the row still learns it (status
        // and hash stay the newer staging's) — a changed document then meets versions_unavailable, not a second record.
        // A deletion at the source that arrived while the write ran and is not handled yet: the row learns the new record
        // too (with this content as delivered), so the deletion acts on the record the item became, not on the earlier one
        await q.query(
          `UPDATE connector_items SET record_id = $3, record_class = $4, version = $5, adopted = ${adopted("$3", "$6")},
                  delivered_at = CASE WHEN status = 'deleted_at_source' THEN now() ELSE delivered_at END
            WHERE id = $1 AND (record_id IS NULL OR (status = 'deleted_at_source' AND reason IS NULL AND content_hash = $2))`,
          [it.id, it.content_hash, o.recordId, o.cls, o.version, o.adopted]);
        return null;
      }
      await q.query("UPDATE connectors SET last_error = NULL, updated_at = now() WHERE id = $1 AND last_error IN ('upload_daily', 'connector_daily')", [c.id]);
      if (caller) {
        const ev = auditConnectorDelivered(cref(c), { item_type: it.item_type, record_id: o.recordId, record_class: o.cls });
        await audit(app, caller, { event_type: ev.event_type, details: ev.details, record_ids: ev.record_ids, class: ev.class });
      }
      return { status: "delivered", reason: o.reason };
    }
    case "held": case "failed": case "skipped": {
      const r = await q.query(`UPDATE connector_items SET status = $3, reason = $4, lease_until = NULL, next_attempt_at = NULL WHERE ${own}`, [...base, o.kind, o.reason]);
      if (!r.rowCount) return null;
      if (o.stop) await stopConnector(app, caller, c, o.stop, o.reason);
      return { status: o.kind, reason: o.reason };
    }
    case "retry": {
      const n = it.attempts + 1;
      if (n >= DELIVERY_MAX_ATTEMPTS) {
        const r = await q.query(`UPDATE connector_items SET status = 'failed', reason = $3, attempts = $4, lease_until = NULL, next_attempt_at = NULL WHERE ${own}`, [...base, o.reason, n]);
        return r.rowCount ? { status: "failed", reason: o.reason } : null;
      }
      const r = await q.query(
        `UPDATE connector_items SET status = 'staged', reason = $3, attempts = $4, lease_until = NULL, next_attempt_at = now() + make_interval(mins => $5) WHERE ${own}`,
        [...base, o.reason, n, DELIVERY_LADDER_MIN[n - 1]]);
      return r.rowCount ? { status: "staged", reason: o.reason } : null;
    }
    case "wait": {
      // a daily budget used up — the run-as person's (shared with their own uploads) or the connector's own quota: the
      // whole connector waits until the next day, no attempt counted
      const r = await q.query(
        `UPDATE connector_items SET status = 'staged', reason = $4, lease_until = NULL, next_attempt_at = now() + make_interval(secs => $3) WHERE ${own}`,
        [...base, o.seconds, o.reason]);
      if (!r.rowCount) return null;
      await q.query(
        `UPDATE connector_items SET next_attempt_at = GREATEST(COALESCE(next_attempt_at, now()), now() + make_interval(secs => $2))
         WHERE connector_id = $1 AND status = 'staged' AND id <> $3`, [c.id, o.seconds, it.id]);
      await q.query("UPDATE connectors SET last_error = $2, updated_at = now() WHERE id = $1", [c.id, o.reason]);
      return { status: "staged", reason: o.reason };
    }
    case "release": {
      const r = await q.query(`UPDATE connector_items SET status = 'staged', lease_until = NULL WHERE ${own}`, base);
      return r.rowCount ? { status: "staged", reason: null } : null;
    }
  }
}

export interface DeliveryHooks {
  /** Test hook: runs after the write and before the item update; a throw leaves the row as it is (a simulated crash). */
  afterWrite?: (itemId: string) => Promise<void>;
}

async function deliverItem(app: App, it: ClaimedItem, hooks: DeliveryHooks): Promise<DeliveryResult> {
  const result = (r: { status: string; reason: string | null } | null): DeliveryResult =>
    ({ itemId: it.id, connectorId: it.connector_id, status: r?.status ?? "superseded", reason: r?.reason ?? null });
  const c = (await app.db.control.query(`SELECT ${CONNECTOR_COLS} FROM connectors WHERE id = $1`, [it.connector_id])).rows[0] as ConnectorRow | undefined;
  if (!c) return result(null);                                            // deleted: its items went with it
  if (c.status !== "active" || c.instance_id !== app.instanceId) return result(await finish(app, null, c, it, { kind: "release" }));
  const heartbeat = setInterval(() => {
    void app.db.control.query("UPDATE connector_items SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND status = 'delivering' AND content_hash = $2",
                              [it.id, it.content_hash, DELIVERY_LEASE_SEC]).catch(() => undefined);
  }, DELIVERY_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const who = await runAs(app, c, it.item_type);
    if (!who.ok) return result(await finish(app, null, c, it, { kind: "held", reason: who.reason, stop: who.reason === "consent_outdated" ? "needs_reconfirm" : "error" }));
    const caller = who.caller;
    const gate = await deliveryTarget(app, caller, c, it.item_type);
    if (!gate.ok) return result(await finish(app, caller, c, it, { kind: "held", reason: gate.reason, stop: "error" }));
    if (it.attempts >= DELIVERY_MAX_ATTEMPTS) return result(await finish(app, caller, c, it, { kind: "failed", reason: "internal" }));
    // a changed document at an item that already became a record: the connector's on_change policy (changes.ts) — never
    // a second record under the default policy
    const plan: DocumentPlan | null = it.item_type === "document" ? await documentPlan(app, c, it, gate) : null;
    if (plan?.kind === "held") return result(await finish(app, caller, c, it, { kind: "held", reason: plan.reason }));
    let outcome: Outcome;
    let taken: ConnectorDailyTake | null = null;
    const size: WriteSize = { take: async (bytes) => { size.bytes = bytes; taken = await takeConnectorDaily(app, c, bytes); } };
    try {
      const item = await readStaged(app, it);
      outcome = item.type === "meeting" ? await writeMeeting(app, caller, c, item, size, it.record_id === null)
        : item.type === "document" ? await writeDocument(app, caller, c, gate, item, plan as Extract<DocumentPlan, { kind: "upload" | "version" }>, size)
        : await writeNote(app, caller, c, gate, item as NoteItem, size);
    } catch (e) {
      outcome = outcomeOf(e, size.bytes);
      if (outcome.kind === "retry") log.warn("connector_delivery_retry", { item_id: it.id, connector_id: c.id, reason: outcome.reason,
                                                                          error: failureClass(e) });   // a class, never the exception
    }
    // the connector's quota counts what became a record, once: anything else gives its place back
    if (taken && outcome.kind !== "delivered") await (taken as ConnectorDailyTake).release();
    if (hooks.afterWrite) await hooks.afterWrite(it.id);
    return result(await finish(app, caller, c, it, outcome));
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------- the loop

/** Settings switch and the fail_closed rule of the REST routes. */
async function idle(app: App, health?: () => Promise<string>): Promise<boolean> {
  if (app.settings.get<boolean>("integrations.connectors_enabled", true) === false) return true;
  // nothing due: the health state (models, storage, directory) is not computed for an empty queue every poll
  if (!(await anyDue(app))) return true;
  const status = health ? await health() : (await healthState(app)).status;
  return status === "fail_closed";
}

/** Handles one claimed deletion at the source (deletes.ts); the connector is read again, as for a delivery. */
async function deleteItem(app: App, it: Awaited<ReturnType<typeof claimDelete>> & object): Promise<DeliveryResult> {
  const c = (await app.db.control.query(`SELECT ${CONNECTOR_COLS} FROM connectors WHERE id = $1`, [it.connector_id])).rows[0] as ConnectorRow | undefined;
  const result = (r: { status: string; reason: string | null } | null): DeliveryResult =>
    ({ itemId: it.id, connectorId: it.connector_id, status: r?.status ?? "superseded", reason: r?.reason ?? null });
  if (!c) return result(null);
  if (c.status !== "active" || c.instance_id !== app.instanceId) {
    await app.db.control.query("UPDATE connector_items SET lease_until = NULL WHERE id = $1 AND status = 'deleted_at_source' AND reason IS NULL", [it.id]);
    return result({ status: "deleted_at_source", reason: null });
  }
  return result(await handleDelete(app, c, it, DELIVERY_LADDER_MIN, DELIVERY_MAX_ATTEMPTS));
}

/**
 * One round: claims up to `parallel` items of different connectors (at most DELIVERY_PARALLEL) and delivers them, then
 * up to `parallel` deletions at the source. `health` replaces the health state in tests.
 */
export async function deliverOnce(app: App, o: DeliveryHooks & { parallel?: number; health?: () => Promise<string> } = {}): Promise<{ claimed: number; outcomes: DeliveryResult[] }> {
  if (await idle(app, o.health)) return { claimed: 0, outcomes: [] };
  const parallel = Math.max(1, Math.min(o.parallel ?? DELIVERY_PARALLEL, DELIVERY_PARALLEL));
  const claimed: ClaimedItem[] = [];
  for (let i = 0; i < parallel; i++) {
    const it = await claimItem(app, claimed.map((x) => x.connector_id));
    if (!it) break;
    claimed.push(it);
  }
  const outcomes = await Promise.all(claimed.map((it) => deliverItem(app, it, o).catch((e: unknown): DeliveryResult => {
    // the row stays `delivering` until its lease expires; the write functions are idempotent, the retry adopts what was written
    log.warn("connector_delivery_failed", { item_id: it.id, connector_id: it.connector_id, error: failureClass(e) });
    return { itemId: it.id, connectorId: it.connector_id, status: "delivering", reason: null };
  })));
  // deletions at the source: one after another (each is a few short queries and at most one deleteRecord)
  let deletes = 0;
  for (let i = 0; i < parallel; i++) {
    const d = await claimDelete(app, RECORD_TYPES, DELIVERY_LEASE_SEC);
    if (!d) break;
    deletes++;
    outcomes.push(await deleteItem(app, d).catch((e: unknown): DeliveryResult => {
      log.warn("connector_delete_failed", { item_id: d.id, connector_id: d.connector_id, error: failureClass(e) });
      return { itemId: d.id, connectorId: d.connector_id, status: "deleted_at_source", reason: null };
    }));
  }
  return { claimed: claimed.length + deletes, outcomes };
}

let loop: { app: App; timer: ReturnType<typeof setInterval>; running: boolean; again: boolean } | null = null;

async function tick(): Promise<void> {
  const l = loop;
  if (!l) return;
  if (l.running) { l.again = true; return; }
  l.running = true;
  try {
    for (let n = 0; n < ROUND_MAX; n += DELIVERY_PARALLEL) if ((await deliverOnce(l.app)).claimed === 0) break;
  } catch (e) {
    log.warn("connector_delivery_round_failed", { error: failureClass(e) });
  } finally {
    l.running = false;
    if (l.again && loop === l) { l.again = false; void tick(); }
  }
}

/** Starts the delivery loop of this process (one call at gateway start-up). */
export function startConnectorDelivery(app: App): void {
  if (loop) return;
  const timer = setInterval(() => void tick(), DELIVERY_POLL_MS);
  timer.unref?.();
  loop = { app, timer, running: false, again: false };
}

/** Delivers soon (the hooks handler calls it after staging); no-op while the loop is not started. */
export function wakeDelivery(): void {
  if (loop) setImmediate(() => void tick());
}

/** Stops the loop (tests, shutdown). */
export function stopConnectorDelivery(): void {
  if (loop) clearInterval(loop.timer);
  loop = null;
}
