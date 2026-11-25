import { AsyncLocalStorage } from "node:async_hooks";
// The audit log: the fact, not the content. An event is written after the action and outside its transaction;
// an audit write failure does not break the answer but goes to the log. The gateway only appends to the journal.
import { AUDIT_OPEN_READS_SETTING, BUILTIN_OPEN_CHECK_RULES, clientKindOf, log, newId, recheckWhyOf, spoolAudit, type AuditOutboxColumn, type ClaimedKind } from "@memory/shared";
import { failureClass } from "@memory/connectors";
import type { App, Caller } from "./context.ts";
import { deferCommittedOwnerEffect } from "./owner-effects.ts";
import { decodeMyAuditCursor, keysetAtSql, nextMyAuditCursor, type MyAuditCursor } from "./paging.ts";
import { isHumanSession } from "./workplace.ts";

export const auditContext = new AsyncLocalStorage<{ plan_id: string }>();

export type AuditType =
  | "read" | "search" | "list" | "write" | "promote" | "open" | "forget" | "extended_key_use" | "t1_fallback"
  | "confirmation" | "admin" | "processing" | "auth_failure" | "rate_limited" | "class_move" | "purge" | "directory"
  | "edge_event"                                  // "External access": "Show outside again" — code hold_released
  | "external";                                   // "Access from outside": on, off, "turn everything off", a request (the registry)

/** Several `event_type` values, comma-separated: `?event_type=read,search`. Empty — no filter. */
export const parseEventTypes = (raw: string | undefined): string[] | null => {
  const xs = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xs.length ? [...new Set(xs)] : null;
};

export interface AuditEvent {
  /**
   * The event id (UUIDv7) if the caller needs it before the write: the `search` event gives it to the agent as `search_id`.
   * None — generated at write.
   */
  id?: string;
  event_type: AuditType; class?: "open" | "closed" | null; record_ids?: string[]; space_id?: string | null;
  query_text?: string | null; filters?: unknown; result_count?: number | null; details?: Record<string, unknown>; ip?: string | null;
}

/**
 * Who fills the event columns: key (or workplace session), principal (a service, else a person) and the on-behalf person. One
 * place for writing the event and for the check "this is a search of the same caller" (the search_id link).
 */
export const auditPrincipal = (caller: Caller | null): { keyId: string | null; principalId: string | null; onBehalfOf: string | null } => ({
  keyId: caller?.keyId ?? null,
  principalId: caller ? (caller.service?.id ?? caller.person?.id ?? null) : null,
  onBehalfOf: caller?.onBehalfOf ? caller.person!.id : null,
});

/**
 * The caller's marks in details: preview, workplace session and the program the client named itself (`details.client`:
 * name, version, where taken from, the User-Agent token, revision) — one place for all events with a caller.
 * The program is information only: rights, the record class, attrs and consent do not read it.
 */
export const marks = (caller: Caller | null, details: Record<string, unknown>): Record<string, unknown> => ({
  ...details, ...auditContext.getStore(), ...(caller?.preview ? { preview: true } : {}), ...(caller?.keyKind === "session" ? { session: true } : {}),
  ...(caller?.claimedClient ? { client: caller.claimedClient } : {}),
  ...(caller?.admin ? adminMarks(caller.admin) : {}),
});

/**
 * Which administrator: card, session, role, sign-in method — in the details of any admin API event. The DDL
 * of the journal does not change: the caller is the system principal, and the person is here.
 */
export const adminMarks = (a: NonNullable<Caller["admin"]>): Record<string, unknown> => ({
  admin_person: a.personId, admin_session: a.sessionId, admin_role: a.role, admin_auth: a.authMethod,
});

/** The program in "My actions": what was sent and the computed kind. */
export interface ClientView { name: string; version?: string; source: "meta" | "initialize" | "user_agent"; kind: ClaimedKind | null }
const SOURCES = new Set(["meta", "initialize", "user_agent"]);

/**
 * "My actions" `client` from `details.client`: only on one's own action (me or a service on my behalf) — a colleague's
 * program (a space owner over my record) is seen by neither the person nor their agent; a forged form — null.
 */
export function clientView(details: Record<string, unknown> | null | undefined, own: boolean): ClientView | null {
  const c = details?.client as Record<string, unknown> | undefined;
  if (!own || !c || typeof c !== "object" || Array.isArray(c) || typeof c.name !== "string" || !c.name || !SOURCES.has(String(c.source))) return null;
  return { name: c.name, ...(typeof c.version === "string" && c.version ? { version: c.version } : {}), source: c.source as ClientView["source"], kind: clientKindOf(c.name) };
}

/** `recent_actions[].client` in memory_me: a short "name version" — so the answer at each agent session start stays small. */
export const recentClient = (c: ClientView | null | undefined): string | undefined => (c ? (c.version ? `${c.name} ${c.version}` : c.name) : undefined);

const OWNER_SUCCESS_TYPES = new Set<AuditType>(["forget", "purge", "promote", "class_move", "open"]);
function ownerSuccess(e: AuditEvent): boolean {
  const details = e.details ?? {};
  return OWNER_SUCCESS_TYPES.has(e.event_type)
    && !["denied", "failed", "error"].some(key => details[key] !== undefined && details[key] !== null && details[key] !== false)
    && !(typeof details.op === "string" && /(?:^|_)(?:refused|failed|denied)$/.test(details.op));
}

/**
 * strict — a write failure goes to the caller: no sign-in session is issued without an event (as in the reference sign-in;
 * the journal is in a separate base, one transaction cannot bind them with the session, so the event is written BEFORE issuing).
 *
 * Audit outbox: a non-strict event the journal refused is kept in audit_outbox (memory_control) with the same id and
 * moved to the journal by the worker job audit_outbox_drain. A strict event is never spooled — its caller refuses instead.
 * mustKeep — throw only when neither the journal nor the outbox took the event (reads of open data under
 * observability.audit_open_reads = strict). Without strict or mustKeep audit() never rejects: callers use `void audit(…)`.
 */
export async function audit(app: App, caller: Caller | null, e: AuditEvent, o: { strict?: boolean; mustKeep?: boolean } = {}): Promise<void> {
  let id: string, values: unknown[], payload: Partial<Record<AuditOutboxColumn, unknown>>;
  try {
    const who = auditPrincipal(caller);
    id = e.id ?? newId();
    // plan_id and the details are fixed now, while the call is still inside auditContext; flush comes after it ends.
    // preview key actions are marked in the event itself: the client_label marks are not enough to link "who opened the preview";
    // workplace session actions — details.session, key_id — the session id (user_sessions.id)
    // filters as the direct write below takes them: a falsy value is no filters
    payload = { event_type: e.event_type, key_id: who.keyId, principal_type: caller?.principalType ?? null, principal_id: who.principalId,
      on_behalf_of: who.onBehalfOf, service_id: caller?.service?.id ?? null, tier: caller?.tier ?? null, class: e.class ?? null,
      record_ids: [...(e.record_ids ?? [])], space_id: e.space_id ?? null, query_text: e.query_text ?? null, filters: e.filters ? e.filters : null,
      result_count: e.result_count ?? null, details: marks(caller, e.details ?? {}), client_label: caller?.clientLabel ?? null, ip: e.ip ?? caller?.ip ?? null };
    values = [id, app.instanceId, payload.event_type, payload.key_id, payload.principal_type, payload.principal_id,
       payload.on_behalf_of, payload.service_id, payload.tier, payload.class,
       payload.record_ids, payload.space_id, payload.query_text, e.filters ? JSON.stringify(e.filters) : null,
       payload.result_count, JSON.stringify(payload.details), payload.client_label, payload.ip];
  } catch (err) {
    log.error("audit_write_failed", { event_type: e.event_type, error: failureClass(err) });   // a class, never the text
    if (o.strict || o.mustKeep) throw err;
    return;
  }
  const write = () => app.db.audit.query(
      `INSERT INTO audit_events (id, instance_id, event_type, key_id, principal_type, principal_id, on_behalf_of, service_id, tier, class,
                                 record_ids, space_id, query_text, filters, result_count, details, client_label, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, values);
  /** The journal refused the event: the same log line as before, then the outbox. true — kept; false — lost (counted). */
  const onFailed = (err: unknown): Promise<boolean> => {
    log.error("audit_write_failed", { event_type: e.event_type, error: failureClass(err) });
    return spoolAudit(app.db.control, { id, instanceId: app.instanceId, source: "gateway", payload });
  };
  if (!o.strict && !o.mustKeep && ownerSuccess(e) && deferCommittedOwnerEffect(async () => { await write().catch(onFailed); })) return;
  try {
    await write();
  } catch (err) {
    if (o.strict) {
      log.error("audit_write_failed", { event_type: e.event_type, error: failureClass(err) });
      throw err;
    }
    if (!(await onFailed(err)) && o.mustKeep) throw err;
  }
}

/** The refusal text for the workplace when the journal did not take a read of closed data (REST — 503 `internal`). */
export const AUDIT_UNAVAILABLE_TEXT = "The audit log is temporarily unavailable. Closed records cannot be shown. Try again later";

/**
 * The journal did not take the event of a read of closed data. For MCP — an internal error, as before; REST answers
 * 503 with a clear text (AUDIT_UNAVAILABLE_TEXT): an employee in the workplace sees the reason, not "internal error".
 */
export class AuditUnavailable extends Error {}

/**
 * A read event (read, search, list). If a person or an agent saw closed data, the event is mandatory ("every read of the closed
 * goes to the journal"): if the journal did not take the write, the content is not given, the caller gets
 * a refusal (AuditUnavailable), not traceless data. Reading open data still passes on a journal failure (into the log).
 */
export async function auditRead(app: App, caller: Caller | null, e: AuditEvent): Promise<void> {
  if (e.class !== "closed") {
    // open data is served when its event reached the journal or the outbox; with "strict" a lost event refuses the read
    if (app.settings?.get?.<string>(AUDIT_OPEN_READS_SETTING, "spool") !== "strict") return audit(app, caller, e);
    try {
      await audit(app, caller, e, { mustKeep: true });
    } catch {
      throw new AuditUnavailable(`the audit log and the audit outbox did not take the ${e.event_type} event: data is not served without a record (observability.audit_open_reads = strict)`);
    }
    return;
  }
  try {
    await audit(app, caller, e, { strict: true });
  } catch {
    throw new AuditUnavailable(`the audit log rejected event ${e.event_type}. Closed records cannot be returned unless the read is logged`);
  }
}

/**
 * Showing closed data in workplace lists: titles and summaries of closed
 * records in "Meetings with me", the trash, "My deletion requests", the participants of a closed meeting and the titles of closed
 * derived records in a record's state — also a read of closed data, as with memory_list. `ids` — only the records whose closed
 * content got into the answer (hidden locators without a title do not count); empty — no event. Called before the answer:
 * if the journal did not take it, no list is given (auditRead). Type `list` (not `read`: read is counted by the "new" mark
 * of "Meetings with me" and search outcomes); for an extended key — extended_key_use, as memory_read. `details.auto` — only for
 * a workplace session (`details.session`, as WORKPLACE_AUTO_SQL): the page loaded the list itself, not the person —
 * "My actions" by default, the Overview and recent_actions do not show it (AUTO_SQL), "Rollout" sessions do not
 * start from it (the worker's isSessionEvent). The same list asked for by an agent or a service (personal, extended key, OBO) is
 * an ordinary action without a mark: the person sees every use of an extended key, and the agent's sessions
 * are extended by it, as by any of its calls.
 */
export async function auditShownClosed(app: App, caller: Caller, ids: Iterable<string>, op: string): Promise<void> {
  const shown = [...new Set(ids)];
  if (!shown.length) return;
  const event = caller.keyKind === "extended" ? "extended_key_use" : "list"; // vis-ok: the log by key kind (as memory_read), not visibility
  await auditRead(app, caller, { event_type: event, class: "closed", record_ids: shown, result_count: shown.length,
                                 details: { op, ...(caller.keyKind === "session" ? { auto: true } : {}) } });
}

/**
 * The move worker's event on a person's word: `move_id`, the accepted rules and the author — the one who ordered the move
 * (`details.author`), so the author sees it in "My actions".
 */
const workerByWord = (d: Record<string, unknown> | null | undefined): boolean =>
  !!d && typeof d.move_id === "string" && Array.isArray(d.accepted_rules) && typeof d.author === "string";

/** The action code of a recheck with a reason: NDA — no suffix (older events), else _rules or _unchecked. */
const recheckAction = (base: string, details: Record<string, unknown>): string => { const why = recheckWhyOf(details); return why === "nda" ? base : `${base}_${why}`; };

/**
 * The action code of an event for "My actions": details.op, else details.action, else details.reason (up to 40 characters).
 * Opening on a person's word differs by confirmation, while the journal's `op` stays: `open` by an agent on the person's
 * answer (`confirmation: agent_relayed`, the old name `agent_word`) — `open_relayed`; by the button "Show to agents despite
 * the finding" (`human_workplace` with accepted rules; also showing "text only" without rules) — `open_despite`;
 * a closing by an administrator rollback (`by: admin_rollback`) — `close_rollback`. The move worker of such an opening: a refused
 * re-check (processing `open_check_refused` with accepted rules) or the "never open" rules (class_move
 * `denied: never_open`) — `open_refused`; a move failure (storage, row check) — `open_failed`; the move finished —
 * `open_done`.
 */
export function actionOf(details: Record<string, unknown> | null | undefined): string | null {
  // a correction sent for confirmation is the same op correct in the journal, with status proposed
  if (details?.op === "correct" && details.status === "proposed") return "correct_proposed";
  if (details?.op === "open" && (details.confirmation === "agent_relayed" || details.confirmation === "agent_word")) return "open_relayed";
  // "Make available to agents": showing "text only" may be without accepted rules — then the sign is despite or text_only
  if (details?.op === "open" && details.confirmation === "human_workplace"
      && ((Array.isArray(details.accepted_rules) && details.accepted_rules.length) || details.despite === true || details.text_only === true)) return "open_despite";
  // an administrator's rollback of showings in teams and projects ("Hide what was shown in teams and projects"): the author sees
  // that the record was hidden neither by them nor by the space owner
  if (details?.op === "close" && details.by === "admin_rollback") return "close_rollback";
  if (details?.op === "open_check_refused" && details.via === "move" && Array.isArray(details.accepted_rules)) return "open_refused";
  // the administrator changed the "write into open" flag of a person's key — the key's owner sees it as a separate action
  if (details?.op === "key_update" && typeof details.open_write === "boolean") return details.open_write ? "key_open_write_on" : "key_open_write_off";
  // a return on expiry: the author sees that the record came back by itself — the curator did not confirm it in time
  if (details?.op === "org_return" && details.by === "auto") return "org_return_auto";
  // a meeting passed to the keeper, and one shown despite a finding is hidden from agents — the consent of the former
  // organizer does not pass to the new one; a return to the former organizer — with a reason (came back to the company, setting)
  if (details?.op === "close" && details.via === "organizer_transfer") return "close_organizer_transfer";
  // the open recheck: memory hid the record from agents — the NDA list grew; "Recheck the hidden" brought back a clean one
  // why it was hidden (details.why): a client from the NDA list, the pass rules, or "not checked three times"
  if (details?.op === "close" && details.via === "nda_recheck") return recheckAction("close_nda_recheck", details);
  if (details?.op === "open_recheck_held" || details?.op === "open_recheck_on_restore") return recheckAction(details.op, details);
  if (details?.op === "open" && details.via === "nda_recheck") return "open_nda_recheck";
  // a meeting from the keeper's trash went back to the former organizer — into their trash with a new term
  if (details?.op === "organizer_return" && details.trashed === true) return "organizer_return_trashed";
  if (details?.op === "organizer_return" && (details.reason === "reactivated" || details.reason === "wait")) return `organizer_return_${details.reason}`;
  // the keeper read a closed ("for myself") record of one who left — apart from an open one: the administrator sees it
  if (details?.op === "custody_read" && details.closed === true) return "custody_read_closed";
  if (!details?.op && workerByWord(details)) {
    if (details!.denied === "never_open") return "open_refused";
    if (details!.failed) return "open_failed";
    if (details!.to === "open") return "open_done";
  }
  for (const k of ["op", "action", "reason"] as const) {
    const v = details?.[k];
    if (typeof v === "string" && v) return v.slice(0, 40);
  }
  return null;
}

/** Why the worker did not show the record to agents (`refusal` of `open_refused` in "My actions"). */
export type OpenRefusal = "changed" | "audience" | "no_write" | "disabled" | "found" | "never_open" | "unchecked" | "consent_needed" | "other";
const GATE_REFUSALS: ReadonlySet<string> = new Set(["changed", "audience", "no_write", "disabled", "consent_needed"]);
/**
 * The worker's refusal reason in words for "My actions" ("Not shown to agents: {reason}"; before, there was
 * one shared caption for all reasons). Only the code — no findings, rules or record text: the "never open" rule
 * (`denied`), the gate code (`gate`), "not checked" (`unchecked`), a re-check finding (`rules` or `kinds`); the other
 * gates of opening on an agent's word (space, marker, notebook, rules) — other.
 */
export function openRefusalOf(details: Record<string, unknown> | null | undefined): OpenRefusal {
  if (details?.denied === "never_open") return "never_open";
  if (typeof details?.gate === "string") return GATE_REFUSALS.has(details.gate) ? (details.gate as OpenRefusal) : "other";
  if (typeof details?.unchecked === "string") return "unchecked";
  const some = (v: unknown) => Array.isArray(v) && v.length > 0;
  return some(details?.rules) || some(details?.kinds) ? "found" : "other";
}

/**
 * Memory's own actions on a person's record (the worker): the personal-open fallback path moved the record into closed;
 * a move on a person's word failed the re-check (`open_check_refused`); a closing failed, and the record
 * is found by agents again (`close_failed` — to the one closing and to the author); the converter did not reprocess a file shown
 * to agents "text only" (`convert_refused`). The other events of the move worker on a word (a refusal by the "never
 * open" rule, a failure, completion) — by `workerByWord`.
 */
// the open recheck: memory hid the record from agents (the NDA list grew) or found it in the trash — it will return closed
const MEMORY_OPS = new Set(["open_check_fallback", "open_check_fallback_failed", "open_check_refused", "org_return", "close_failed", "convert_refused",
                            "open_recheck_held", "open_recheck_on_restore"]);
/**
 * Others' actions on my record in "Company common knowledge": decisions — the curator, the "Useful" and "Wrong" marks —
 * a colleague (the author is not told who). A return on expiry and the "circle narrowed" job pick (reason narrowed) are signed
 * "memory" (system principal, MEMORY_OPS); narrowing by the meeting recorder — "<service> on my behalf", by the organizer — "me".
 */
const ORG_REVIEW_ACTOR: Readonly<Record<string, ActorKind>> = {
  org_confirm: "org_curator", org_return: "org_curator", org_delete: "org_curator", org_useful: "colleague", org_wrong: "colleague",
};

/**
 * Another's correction of my record: who — by the role in the event (the decider — `decider_role`, else the corrector —
 * `by_role`). A reader not entitled to correct at once only proposes — "colleague (proposal)".
 */
const CORRECTION_ROLE_ACTOR: Readonly<Record<string, ActorKind>> = {
  participant: "meeting_participant", space_owner: "space_owner", space_member: "space_member", reader: "colleague_proposal",
};

/** Who acted, as a stable code; the display label comes from ACTOR_LABELS. */
export type ActorKind = "self" | "service" | "memory" | "administrator" | "org_curator" | "colleague" | "meeting_participant" | "space_owner"
  | "space_member" | "colleague_proposal";

/** The display labels of the actor codes in the `actor` field (English server text); a service is "<name> on my behalf". */
export const ACTOR_LABELS: Readonly<Record<ActorKind, string>> = {
  self: "me", service: "service", memory: "memory", administrator: "administrator", org_curator: "“Company knowledge” curator",
  colleague: "a colleague", meeting_participant: "a meeting participant", space_owner: "the space owner", space_member: "a space member",
  colleague_proposal: "colleague (suggestion)",
};

/**
 * Who did it (the `actor` field of "My actions"). The system principal is the worker, the administrator's panel session
 * (`mem_adm_`) and the system key: "memory" — only events of the fallback-path worker (details.op), other system ones —
 * "administrator" (for example, a meeting deletion at a participant's request, deletion-requests), not "memory" and not "space
 * owner". "Memory" — also the move of a dismissed person's file into a project by the `dismissed_retention` job
 * (`details.job`): its author sees the event after reactivation.
 */
type ActorRow = { principal_type: string | null; principal_id: string | null; on_behalf_of: string | null; service_id: string | null; details: Record<string, unknown> | null };

export function actorKindOf(r: ActorRow, personId: string): ActorKind {
  if (r.principal_type === "system")
    return MEMORY_OPS.has(String(r.details?.op ?? "")) || workerByWord(r.details) || r.details?.job === "dismissed_retention" || r.details?.job === "open_recheck"
      || (r.details?.via === "nda_recheck" && r.details?.by === "auto") ? "memory" : "administrator";
  if (r.principal_id !== personId && r.on_behalf_of !== personId) {
    if (r.details?.tool === "org_review") return ORG_REVIEW_ACTOR[String(r.details.op ?? "")] ?? "org_curator";
    return CORRECTION_ROLE_ACTOR[String(r.details?.decider_role ?? r.details?.by_role ?? "")] ?? "space_owner";
  }
  return r.service_id ? "service" : "self";
}

export function actorOf(r: ActorRow, personId: string, names: ReadonlyMap<string, string>): string {
  const kind = actorKindOf(r, personId);
  return kind === "service" ? `${(r.service_id && names.get(r.service_id)) || ACTOR_LABELS.service} on my behalf` : ACTOR_LABELS[kind];
}

/** The whitespace `String.prototype.trim` removes (ECMAScript WhiteSpace and LineTerminator) — for a Postgres regex. */
const JS_TRIM_SPACE = String.raw`\t\n\v\f\r    -     　﻿`;

/**
 * An automatic workplace list: the Overview and "My records" load `memory_search {mode: "recent",
 * filters: {space}}` by session — not a person's search; the "Find something" step must not be ticked by it. The rule is
 * the `workplace_auto` channel of search outcomes exactly (`channelOf`, packages/workers/src/jobs/outcomes-core.ts): a `search`
 * event of a workplace session (`details.session` true), `details.mode` the string "recent", query text empty after JS trim
 * (the journal stores it trimmed; old and cleared rows hold anything), filters — an object with the key `space` and besides it
 * at most `types` ("Latest records" of "Common knowledge" without employee cards).
 * Change one — change the other: shared test cases run channelOf and this expression on Postgres.
 * A spare boolean expression over the row: the "My actions" query indexes stay; coalesce — so NOT does not lose rows with NULL.
 */
export const WORKPLACE_AUTO_SQL = `coalesce(a.event_type = 'search' AND a.details->'session' = 'true'::jsonb AND a.details->'mode' = '"recent"'::jsonb
    AND (a.query_text IS NULL OR a.query_text ~ '^[${JS_TRIM_SPACE}]*$')
    AND CASE WHEN jsonb_typeof(a.filters) = 'object' THEN a.filters ? 'space' AND a.filters - 'space' - 'types' = '{}'::jsonb ELSE false END, false)`;

/** Reading record titles for the "My actions" feed: the journal row about it is a service one. */
export const MY_AUDIT_TITLES_OP = "my_audit_titles";

/**
 * A workplace service load: the session frame reads the profile itself on every page (`read`
 * memory_me), and under a limit its background reads get refused (`rate_limited`, memory_me or a REST GET — details.method).
 * Also the read of closed record titles for the "My actions" feed (details.op my_audit_titles): the journal
 * must write it, but it is a page load, not a person's action.
 * Not actions of the person or their agent: in "My actions" they are like automatic lists (the auto field, exclude_auto),
 * in the panel — by the "Hide service entries" flag (exclude_service). Everything is written to the journal, as before.
 * A 429 refusal of a change (POST, PATCH, DELETE) and everything done with an agent's key is not service. Kept apart from
 * WORKPLACE_AUTO_SQL: that one is tied to the search outcomes channel and changes only with it. coalesce — NOT keeps NULL rows.
 */
export const WORKPLACE_SERVICE_SQL = `coalesce(a.details->'session' = 'true'::jsonb AND (
    (a.event_type = 'read' AND (a.details->'tool' = '"memory_me"'::jsonb OR a.details->'op' = '"${MY_AUDIT_TITLES_OP}"'::jsonb))
    OR (a.event_type = 'rate_limited' AND (a.details->'tool' = '"memory_me"'::jsonb OR a.details->'method' = '"GET"'::jsonb))), false)`;

/**
 * Automatic in "My actions": the auto search of the Overview and "My records" (WORKPLACE_AUTO_SQL), workplace service
 * loads (WORKPLACE_SERVICE_SQL) and workplace lists with closed data that the page loaded itself
 * (`details.auto` — auditShownClosed sets it only for a workplace session). WORKPLACE_AUTO_SQL is not
 * widened: it is paired with the search outcomes channel (channelOf), and a search never has `details.auto`.
 */
export const AUTO_SQL = `(${WORKPLACE_AUTO_SQL} OR ${WORKPLACE_SERVICE_SQL} OR coalesce(a.details->'auto' = 'true'::jsonb, false))`;

/**
 * Keeper reads of the personal space of an employee who left: `read {op: custody_read}`
 * and `list {op: custody}` carry record ids of another's personal space. The keeper's agents never see it, by search or by the
 * journal: `recent_actions` (memory_me, GET /me) and GET /me/audit outside a workplace session hold no such rows. The person
 * sees them in "My actions", the administrator in the panel journal. The self-copy (`write {op: custody_copy}`) is theirs: shown.
 */
export const CUSTODY_READS_SQL = `coalesce(a.event_type IN ('read', 'list') AND a.details->>'op' IN ('custody_read', 'custody'), false)`;

/**
 * The "My actions" view (GET /me/audit?view=): main — the main things: without service entries and automatic workplace lists
 * and without the person's own reads, searches, browsing and "Whom to invite?" hints in the workplace (those are page loads
 * and typing in a field) — everything agents and services did stays, the person's own changes (delete, open,
 * move, keys) and others' actions on their records; agents — the person's agent keys' actions (not a workplace session, service, preview or system);
 * me — the person in the workplace without service entries (the "View as" preview is the administrator); all — everything, as
 * before (the default: old clients get the old behaviour).
 * The filter is before LIMIT, the page is full. $1 — the person (first query parameter). The same parse for a row — viaOf.
 * Automatic — AUTO_SQL as a whole: showings of closed data in lists the page loaded, in main and me
 * do not appear, like the auto search and service loads.
 */
export const MY_AUDIT_VIEWS = ["main", "agents", "me", "all"] as const;
export type MyAuditView = (typeof MY_AUDIT_VIEWS)[number];
const SESSION_SQL = `coalesce(a.details->'session' = 'true'::jsonb, false)`;
const PREVIEW_SQL = `coalesce(a.details->'preview' = 'true'::jsonb, false)`;
/** Export of a space: its start and its end are actions of the person, not page loads — in "main". */
const SPACE_EXPORT_SQL = `coalesce(a.details->>'op' IN ('export', 'export_done'), false)`;
export const MY_AUDIT_VIEW_SQL: Readonly<Record<Exclude<MyAuditView, "all">, string>> = {
  main: `NOT ${AUTO_SQL} AND NOT (${SESSION_SQL} AND a.event_type IN ('read', 'search', 'list', 'directory') AND NOT ${SPACE_EXPORT_SQL})`,
  agents: `a.principal_id = $1 AND a.service_id IS NULL AND a.principal_type IS DISTINCT FROM 'system' AND NOT ${SESSION_SQL} AND NOT ${PREVIEW_SQL}`,
  me: `a.principal_id = $1 AND ${SESSION_SQL} AND NOT ${AUTO_SQL} AND NOT ${PREVIEW_SQL}`,
};

/**
 * Who did it — for the "My actions" feed phrase (the via field): workplace — the person in the workplace
 * (session), agent — their agent's key (personal, extended, a connection through an account), service — a service on their
 * behalf (the transcriber), system — memory or the administrator (and the "View as" preview), other_person — a colleague over
 * their record. The `actor` field stays (agents read it in recent_actions).
 */
export type MyAuditVia = "workplace" | "agent" | "service" | "system" | "other_person";
export function viaOf(r: Pick<MyAuditSource, "principal_type" | "principal_id" | "on_behalf_of" | "service_id" | "details">, personId: string): MyAuditVia {
  if (r.principal_type === "system" || r.details?.preview === true) return "system";
  if (r.principal_id !== personId && r.on_behalf_of !== personId) return "other_person";
  if (r.service_id) return "service";
  return r.details?.session === true ? "workplace" : "agent";
}

/**
 * "An employee sees the actions made on their behalf": read by the memory_audit_reader role with a filter by person.
 * excludeAuto — no automatic ones (AUTO_SQL): the filter is before LIMIT, the page is full; the auto field marks all automatic.
 * Order — time and id descending: without the second key, rows of one time came in random order.
 * `cursor` — the parsed page cursor (decodeMyAuditCursor): the old time cursor — `at <`, the new one — `at <=` and OFFSET.
 * (time, id) pairs, as in the panel journal, are absent here on purpose: an event id in the "My actions" cursor
 * would reveal a search's search_id (a guard test keeps that). `view` — the feed view (MY_AUDIT_VIEW_SQL).
 */
async function myAuditRows(app: App, personId: string, opts: { limit: number; from?: string; to?: string; eventType?: string; cursor?: MyAuditCursor | null; excludeAuto?: boolean; view?: MyAuditView;
                                                                hideCustody?: boolean }) {
  // one's own actions and others' actions on my records (a move, a closing, a deletion by the space owner)
  // copies of a space export event for the space owners (details.owner_notice): only in the owners' feeds, not twice in the exporter's
  const where = ["(((principal_id = $1 OR on_behalf_of = $1) AND NOT coalesce(details->'owner_notice' = 'true'::jsonb, false)) OR (details ? 'author' AND details->>'author' = $1::text))"], args: unknown[] = [personId];   // index audit_events_author_idx
  if (opts.from) { args.push(opts.from); where.push(`at >= $${args.length}`); }
  if (opts.to) { args.push(opts.to); where.push(`at <= $${args.length}`); }
  const types = parseEventTypes(opts.eventType);
  if (types) { args.push(types); where.push(`event_type = ANY($${args.length}::text[])`); }
  const cur = opts.cursor ?? null;
  if (cur && "before" in cur) { args.push(cur.before); where.push(`at < $${args.length}`); }
  // a "time + how many shown" cursor: rows of exactly that time already given are skipped by OFFSET (the order by id is stable)
  if (cur && "at" in cur) { args.push(cur.at); where.push(`at <= $${args.length}::timestamptz`); }
  if (opts.excludeAuto) where.push(`NOT ${AUTO_SQL}`);
  // not for a person in the workplace — without keeper reads of the personal space of one who left (CUSTODY_READS_SQL)
  if (opts.hideCustody) where.push(`NOT ${CUSTODY_READS_SQL}`);
  if (opts.view && opts.view !== "all") where.push(`(${MY_AUDIT_VIEW_SQL[opts.view]})`);
  args.push(opts.limit);
  let page = `LIMIT $${args.length}`;
  if (cur && "at" in cur && cur.skip) { args.push(cur.skip); page += ` OFFSET $${args.length}`; }
  const { rows } = await app.db.auditRead().query(
    `SELECT a.at, ${keysetAtSql("a.at")} AS at_key, a.event_type, a.principal_type, a.principal_id, a.service_id, a.on_behalf_of, a.client_label, a.record_ids, a.result_count, a.class, a.details,
            ${AUTO_SQL} AS auto
     FROM audit_events a WHERE ${where.join(" AND ")} ORDER BY a.at DESC, a.id DESC ${page}`, args);
  return rows as Array<MyAuditSource & { at_key: string }>;
}

async function myAuditItems(app: App, personId: string, rows: readonly MyAuditSource[]) {
  const ids = [...new Set(rows.map((r) => r.service_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length) for (const s of (await app.db.control.query("SELECT id, name FROM services WHERE id = ANY($1)", [ids])).rows) names.set(s.id, s.name);
  return rows.map((r) => myAuditRow(r, personId, names));
}

export async function myAudit(app: App, personId: string, opts: { limit: number; from?: string; to?: string; eventType?: string; excludeAuto?: boolean; view?: MyAuditView; hideCustody?: boolean }) {
  return myAuditItems(app, personId, await myAuditRows(app, personId, opts));
}

/**
 * The "My actions" page (GET /me/audit): next_cursor — an opaque string (encodeMyAuditCursor) of the time of the last
 * row with microseconds, as in the base. The cursor used to be the row's `at` via JS Date (ms) with `at <`: events of the same
 * millisecond below the page border and of one time dropped out. Garbage in the cursor — 400.
 */
export async function myAuditPage(app: App, personId: string, opts: { limit: number; from?: string; to?: string; eventType?: string; cursor?: string; excludeAuto?: boolean; view?: MyAuditView;
                                                                     hideCustody?: boolean }) {
  const cursor = decodeMyAuditCursor(opts.cursor);
  const rows = await myAuditRows(app, personId, { ...opts, cursor, limit: opts.limit + 1 });
  const shown = rows.slice(0, opts.limit);
  return { items: await myAuditItems(app, personId, shown), next_cursor: rows.length > opts.limit ? nextMyAuditCursor(shown.map((r) => r.at_key), cursor) : null };
}

/**
 * `recent_actions` in memory_me and GET /me: up to 20 latest "My actions" without automatic lists and workplace service
 * loads — for an agent at session start that is noise, not the person's actions. The schema is strict: no `auto`, no `via`, no `widened_by_human` (for the
 * workplace only); the client program — a short string, only on one's own actions (actor "me"). A journal failure — empty list.
 * Without keeper reads of the personal space of an employee who left (CUSTODY_READS_SQL): agents read the answer.
 * `noRecordIds` — the external agents' address: without `record_ids` (the field is optional in the contract) — by them
 * the ids of a person's closed records would be learned from outside.
 */
export async function recentActions(app: App, personId: string, o: { noRecordIds?: boolean } = {}) {
  return (await myAudit(app, personId, { limit: 20, excludeAuto: true, hideCustody: true }).catch(() => [])).map(({ client, widened_by_human: _widened, auto: _auto, via: _via, refusal: _refusal, reasons: _reasons, ...a }) => {
    const c = a.actor === ACTOR_LABELS.self ? recentClient(client) : undefined;
    const { record_ids: _ids, ...rest } = a;
    const b = o.noRecordIds ? rest : a;
    return c ? { ...b, client: c } : b;
  });
}

/** Built-in check rule titles in words (their `reason`) — for the reasons in "My actions"; one's own rules do not get here. */
const RULE_REASONS: ReadonlyMap<string, string> = new Map(BUILTIN_OPEN_CHECK_RULES.map((r) => [r.name, r.reason]));

/** The reason "some pages are scans" in `reasons` — in the same form as the rule titles ("the check found page scans"). */
export const SCANS_REASON = "page scans";

/**
 * What the text check of a PDF saved closed in a team or project found ("The file
 * is saved. Agents do not see it yet: …"): built-in rule titles in words — the same as after "looks like", also read
 * after "the check found" ("a phone number", "a price or sum"), — and last "page scans" (SCANS_REASON). Without
 * content, positions and the administrator's own rules. Only the worker event `open_check_fallback` with `check_via: convert` and
 * `shared` (a team or project); otherwise — null, the row caption stays. Given only to a person in the workplace
 * (reasonsFor): to an agent the author's findings of a record outside the personal space are not named.
 */
export function fallbackReasons(details: Record<string, unknown> | null | undefined): string[] | null {
  if (details?.op !== "open_check_fallback" || details.check_via !== "convert" || details.shared !== true) return null;
  const rules = Array.isArray(details.rules) ? details.rules.map(String) : [];
  const out = [...new Set(rules.map((r) => RULE_REASONS.get(r)).filter((r): r is string => !!r))];
  if (Array.isArray(details.kinds) && details.kinds.includes("unchecked")) out.push(SCANS_REASON);
  return out.length ? out : null;
}

/**
 * To whom "My actions" give `reasons`: only to the person's own workplace session — not to the panel
 * preview, not an on-behalf service and not agent keys (personal, script, extended, via an account). Outside one's personal space
 * an agent does not learn what the check found (just as `memory_read` gives it the kind without findings).
 */
export const reasonsFor = (caller: Pick<Caller, "keyKind" | "principalType" | "person" | "onBehalfOf" | "preview">): boolean => isHumanSession(caller);

/** "My actions" rows without `reasons` — for those not given them (reasonsFor); the field is optional, the row type the same. */
export function withoutReasons<T extends { reasons?: unknown }>(items: T[]): T[] {
  return items.map(({ reasons: _reasons, ...rest }) => rest as unknown as T);
}

/** The journal row from which "My actions" build an action (audit_events columns; auto — AUTO_SQL). */
export interface MyAuditSource {
  at: Date | string; event_type: string; principal_type: string | null; principal_id: string | null; service_id: string | null; on_behalf_of: string | null;
  client_label: string | null; record_ids: string[] | null; result_count: number | null; class?: string | null; details: Record<string, unknown> | null;
  auto?: boolean | null;
}

/**
 * One "My actions" action. Another's handover of my meeting's decision to a project (`op: handover`, `details.author` —
 * me): `record_ids` — only the decision (the event's last id): the organizer may lack access to the project record, so a link
 * would lead to "no record"; `actor` — by the role of the one who handed it over ("meeting participant").
 */
export function myAuditRow(r: MyAuditSource, personId: string, names: ReadonlyMap<string, string>) {
  const own = r.principal_id === personId || r.on_behalf_of === personId;
  const recordIds = (r.record_ids ?? []) as string[];
  const action = actionOf(r.details);
  return {
    at: new Date(r.at).toISOString(), event_type: r.event_type as string,
    actor: actorOf(r, personId, names),
    // who did it — for the feed phrase: you in the workplace, your agent, a service, memory, a colleague
    via: viaOf(r, personId),
    // the client program — only on one's own actions: me or a service on my behalf
    client: clientView(r.details, own),
    client_label: r.client_label as string | null, tool: (r.details?.tool as string | undefined) ?? null,
    // what exactly was done within the event type — delete, restore, delete forever from the trash,
    // close, open, issue and revoke one's key, a refusal reason — the code from details.op / action / reason
    action,
    // why the worker did not show the record to agents: the workplace writes the reason in words; recent_actions does not give it
    ...(action === "open_refused" ? { refusal: openRefusalOf(r.details) } : {}),
    // a PDF in a team or project saved closed after processing: what was found — in words; recent_actions does not give it
    ...(fallbackReasons(r.details) ? { reasons: fallbackReasons(r.details)! } : {}),
    record_ids: !own && r.details?.op === "handover" ? recordIds.slice(-1) : recordIds, result_count: r.result_count as number | null,
    // written into open by an agent with extended access by the administrator's permission: the action code
    // stays (remember, placement, move, correction), the sign — a separate field
    ...(r.details?.extended_open === true ? { extended_open: true as const } : {}),
    // a person moved a retelling wider than its sources with confirmation — the workplace gets the line "wider than the source";
    // a meeting decision was handed to a project where people who did not see the meeting see it
    ...(r.details?.widened_by_human === true ? { widened_by_human: true as const } : {}),
    // a list or profile the workplace loaded itself (AUTO_SQL: the auto search, service loads, showing closed data in
    // lists): the Overview and "My actions" do not count them as the person's action
    ...(r.auto === true ? { auto: true as const } : {}),
  };
}
