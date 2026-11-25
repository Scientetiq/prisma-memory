"use server";
import { actionsText as M } from "@/messages/ws-actions";

import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { endedState } from "@/lib/action-ended";
import { tryGw } from "@/lib/api";
import { call } from "@/lib/gateway";
import { endOfDayIso, personKeyLimitIso } from "@/lib/format";
import { HANDOVER_BATCH_MAX, isId, isLogin, isSpaceRef, text } from "@/lib/form";
import { CLIENT_KIND_TITLES, EVENT_KIND_TITLES, EVENT_KINDS, isClientKind, PERSON_KEY_MAX_DAYS, queueLine } from "@/lib/labels";
import { formTz, wallToIso } from "@/lib/local-datetime";
import { callTool, toolErrorMessage, type McpFail } from "@/lib/mcp";
import { archivedOf, derivedDenial, ERROR_PLAIN, isOverloaded, overloadedMessage } from "@/lib/mcp-parse";
import { meGw } from "@/lib/me-api";
import { MORNING_NOTE_PATH, parseNoteSwitch } from "@/lib/morning-note";
import { mnText } from "@/lib/morning-note.messages";
import { CLOSED_CLASS_TEXT } from "@/lib/closed-class";
import { DELETION_REASONS, DELETION_REQUESTS_TEXT, type DeletionStatus } from "@/lib/deletion-requests";
import { PREVIEW_TEXT } from "@/lib/preview";
import { isHandoverBusy } from "@/lib/meeting-state";
import { waitMoved, waitMovedClass } from "@/lib/record-moving";
import { despiteStale, openCheckFound, openCheckScans, showAnywayHref } from "@/lib/show-anyway";
import { summarizeStages } from "@/lib/stages";
import { capitalize, DERIVED_PLAIN, EXTENDED_OPEN_PLAIN, formatDay, HANDOVER_PLAIN, MEETINGS_PLAIN, PROMOTE_PLAIN, RETURN_PERSONAL, returnLines } from "@/lib/plain";
import { callResult, MEMBER_ROLE_PLAIN, placeOf } from "@/lib/project-people";
import { RESTORE_PLAIN } from "@/lib/trash";
import type { HandoverForm, HandoverResult, MyKeyIssue, MyKeyKind, MyKeyOpenWrite, ProcessNowResult, PromoteResult, ShowAnywayToggles, SpaceCallResult, WriteResult } from "@/lib/types";
import { actionSession, clearPreviewCookies, clearUserSessionCookie, clearWasInCookie, previewExit, readUserSession, sessionEndedState, type UserSession } from "@/lib/user-session";

const fail = (prefix: string, e: McpFail): ActionState | Promise<ActionState> =>
  ended(e) ?? failState(e.code === "open_check" ? toolErrorMessage(e) : `${prefix}: ${toolErrorMessage(e)}`, e.hint && !archivedOf(e.details) ? { lines: [e.hint] } : {});

const ended = endedState;
const handoverBusy = isHandoverBusy;

const denyPreview = (s: UserSession): ActionState | null => (s.preview ? failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] }) : null);

export async function rememberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const body = text(formData, "text"), title = text(formData, "title"), space = text(formData, "space"), kind = text(formData, "kind"), when = text(formData, "occurred_at");
  if (body.length < 3) return failState(M.writeWhatToRememberAtLeast);
  if (body.length > 20_000) return failState(M.textIsTooLongUpTo);
  if (!isSpaceRef(space)) return failState(M.chooseASpace);
  if (kind && kind !== "note" && !(EVENT_KINDS as readonly string[]).includes(kind)) return failState(M.unknownRecordType);
  const args: Record<string, unknown> = { text: body, space, kind: kind || "note", origin: "human" };
  if (title) args.title = title.slice(0, 200);
  // "When was it": a time on the person's clock (the browser zone: client_tz of ActionForm or the hidden tz field; without
  // it the zone of the installation), not the UTC of the server
  if (when) { const iso = wallToIso(when, formTz(formData)); if (!iso) return failState(M.dateEnterADateAndTime); args.occurred_at = iso; }
  const res = await callTool<WriteResult>(session.key, "memory_remember", args);
  if (!res.ok) return res.code === "response_lost" ? failState(ERROR_PLAIN.responseLostRemember) : fail(M.notRemembered, res);
  refresh();
  const st = summarizeStages(res.data.stages);
  return okState(res.data.already_known ? M.thisRecordAlreadyExistsNoDuplicate : M.remembered, {
    record: { id: res.data.id, path: res.data.path, class: res.data.class },
    lines: [st.total ? M.processing(st.label) : M.recordQueuedForProcessing, queueLine(res.data.queue?.lane, res.data.queue?.eta_sec),
      ...(res.data.class === "closed" ? [CLOSED_CLASS_TEXT.closedClassLine] : []),
      ...(res.data.entities_unresolved?.length ? [M.notFoundInTheDealCompany(res.data.entities_unresolved.join(", "))] : [])],
  });
}

export async function processNowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  const res = await callTool<ProcessNowResult>(session.key, "memory_process_now", { id });
  if (!res.ok) return fail(M.notQueued, res);
  refresh();
  const st = summarizeStages(res.data.stages);
  return okState(res.data.priority_raised ? M.recordMovedToTheFrontOf : st.state === "done" ? M.recordHasAlreadyBeenProcessed : M.recordIsAlreadyAtTheFront,
    { lines: [M.processing(st.label), queueLine(res.data.queue?.lane ?? "now", res.data.queue?.eta_sec)] });
}

export async function promoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id"), to = text(formData, "to_space"), toName = text(formData, "to_name").slice(0, 200);
  if (!isId(id)) return failState(M.recordIdIsMissing);
  if (!isSpaceRef(to)) return failState(M.chooseTheSpaceToMoveThe);
  const confirm = text(formData, "confirm_wider") === "on";
  const res = await callTool<PromoteResult>(session.key, "memory_promote", { id, to_space: to, ...(confirm ? { confirm_wider: true } : {}) });
  if (!res.ok) {
    const d = derivedDenial(res.details);
    if (d?.reason === "derived_sources_unreadable") return failState(DERIVED_PLAIN.unreadable);
    if (d) return failState(d.reason === "derived_basis_missing" ? DERIVED_PLAIN.basisMissing : DERIVED_PLAIN.promoteWarning(null),
                            d.confirm ? { lines: [DERIVED_PLAIN.tick], ask: "confirm_wider" } : {});
    return fail(M.notMoved, res);
  }
  refresh();
  const who = (res.text ?? "").split(". ").filter((l) => /^Now visible to |^The audience did not expand|can see (?:it|parts)|^The class is still /.test(l) && !/source/.test(l)).map((l) => l.replace(/\.$/, ""));
  return okState(PROMOTE_PLAIN.done(toName || null), { lines: [...who, ...(res.data.widened_by_human ? [DERIVED_PLAIN.after] : [])] });
}

export async function handoverAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const P = HANDOVER_PLAIN;
  const id = text(formData, "id"), to = text(formData, "to_space"), name = text(formData, "to_name").slice(0, 200), title = text(formData, "title"), body = text(formData, "text");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  if (!isSpaceRef(to)) return failState(M.chooseAProject);
  if (formData.get("confirm") !== "on") return failState(P.confirmMissing);
  if (!title || title.length > 200) return failState(M.titleMustBeBetween1And);
  if (!body) return failState(M.writeTheTextForTheProject);
  if (body.length > 20_000) return failState(M.textIsTooLongUpTo2);
  const res = await meGw<HandoverResult>(session.key, `/api/v1/records/${id}/handover`, { method: "POST", body: { to_space: to, title, text: body, confirm: true } });
  if (!res.ok) {
    const gone = ended(res); if (gone) return gone;
    const d = (res.details ?? {}) as { reason?: unknown; current_id?: unknown; archived?: unknown };
    if (res.code === "open_check") return failState(res.message, { lines: [P.openCheckTail] });
    if (res.code === "class_denied") return failState(d.archived ? P.archived(name) : P.readOnly(name));
    if (res.code === "forbidden" && d.reason === "not_participant") return failState(P.cannot);
    if (d.reason === "not_current")
      return failState(P.notCurrent, typeof d.current_id === "string" && isId(d.current_id) ? { link: { href: `/records/${d.current_id}`, label: P.openCurrent } } : {});
    return failState(`${P.failed}: ${res.message}`);
  }
  refresh();
  const link = { href: `/records/${res.data.id}`, label: P.openNew };
  if (res.data.already_known) return okState(P.repeat, { link });
  return okState(P.done(name), { lines: [P.meetingKept, ...(text(formData, "own") === "1" ? [] : [P.organizerSees])], link });
}

export async function handoverAllAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const P = HANDOVER_PLAIN;
  const to = text(formData, "to_space"), ids = [...new Set(formData.getAll("decision").map(String).filter(isId))];
  if (!isSpaceRef(to)) return failState(M.chooseAProject);
  if (!ids.length) return failState(M.selectAtLeastOneDecision);
  if (ids.length > HANDOVER_BATCH_MAX) return failState(M.upToDecisionsAtATime(HANDOVER_BATCH_MAX));
  if (formData.get("confirm") !== "on") return failState(M.tickTheBoxToConfirmYou);
  let done = 0, again = 0, name = text(formData, "to_name").slice(0, 200) || to;
  const failed: string[] = [];
  for (const id of ids) {
    const form = await meGw<HandoverForm>(session.key, `/api/v1/records/${id}/handover?to=${encodeURIComponent(to)}`);
    if (!form.ok && form.code === "unauthorized" && !done && !again) return sessionEndedState();
    if (!form.ok || !form.data.allowed || !form.data.source) { failed.push(form.ok ? M.decisionCannotBeHandedOver : form.message); continue; }
    name = form.data.targets.find((t) => t.slug === to)?.name ?? name;
    const src = form.data.source;
    const title = (src.title || (src.event_kind && EVENT_KIND_TITLES[src.event_kind] ? capitalize(EVENT_KIND_TITLES[src.event_kind]!) : null) || M.meetingDecision).slice(0, 200);
    const res = await meGw<HandoverResult>(session.key, `/api/v1/records/${id}/handover`, { method: "POST", body: { to_space: to, title, text: (src.statement || title).slice(0, 20_000), confirm: true } });
    if (!res.ok && res.code === "unauthorized" && !done && !again) return sessionEndedState();
    if (!res.ok) { failed.push(`«${title}»: ${res.code === "open_check" ? M.foundInformationThatMustStayWithin : res.message}`); continue; }
    if (res.data.already_known) again++; else done++;
  }
  if (done || again) refresh();
  const lines = [...(again ? [M.alreadyInTheProjectNoDuplicates(again)] : []), ...failed.slice(0, 5).map((f) => M.notHandedOver(f)), P.meetingKept];
  if (!done && !again) return failState(M.decisionsWereNotHandedOverTo(name), { lines });
  return okState(M.decisionsHandedOver(name, done), { lines });
}

export async function meetingProjectMarkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id"), space = text(formData, "space");
  if (!isId(id)) return failState(M.meetingIsMissing);
  if (space && !isSpaceRef(space)) return failState(M.chooseAProject);
  const res = await meGw<{ id: string; project_mark: { slug: string; name: string } | null }>(session.key, `/api/v1/records/${id}/project-mark`, { method: "PUT", body: { space: space || null } });
  if (!res.ok) return ended(res) ?? (handoverBusy(res) ? failState(MEETINGS_PLAIN.handoverBusy) : failState(M.projectMarkWasNotChanged(res.message)));
  refresh();
  return res.data.project_mark
    ? okState(M.meetingMarkedAsAMeetingFor(res.data.project_mark.name), { lines: [M.onlyMeetingParticipantsWhoCanRead] })
    : okState(M.theProjectMeetingMarkHasBeen);
}

export async function returnToPersonalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  const listed = Math.max(0, Math.min(10_000, Number.parseInt(text(formData, "listed") || "0", 10) || 0));
  const res = await callTool<PromoteResult>(session.key, "memory_promote", { id, to_space: "me" });
  if (!res.ok) return fail(RETURN_PERSONAL.failed, res);
  refresh();
  if (res.data.unchanged) return okState(RETURN_PERSONAL.already);
  return okState(RETURN_PERSONAL.done, { lines: returnLines(res.data, listed) });
}

export async function openAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  if (formData.get("confirm") !== "on") return failState(M.tickTheBoxToConfirmYou2);
  const res = await meGw<{ id: string; status: "in_progress" | "done" }>(session.key, `/api/v1/records/${id}/open`, { method: "POST" });
  if (!res.ok) {
    const gone = ended(res); if (gone) return gone;
    if (res.code === "open_check") {
      if (openCheckFound(res)) {
        const off = text(formData, "despite") === "off"
          || (text(formData, "from") !== "record" && await meGw<ShowAnywayToggles>(session.key, "/api/v1/me/show-anyway")
            .then((t) => t.ok && (t.data?.enabled === false || (openCheckScans(res) && t.data?.scans_text === false)), () => false));
        if (off) return failState(res.message, res.hint ? { lines: [res.hint] } : {});
        if (text(formData, "from") === "record") redirect(showAnywayHref(id));
        return failState(res.message, { ...(res.hint ? { lines: [res.hint] } : {}), link: { href: showAnywayHref(id), label: CLOSED_CLASS_TEXT.showAnywayLook } });
      }
      return failState(res.message, res.hint ? { lines: [res.hint] } : {});
    }
    return failState(M.notShownToAgents(res.message));
  }
  const cls = res.data.status === "in_progress" ? await movedClass(session.key, id) : null;
  refresh();
  if (res.data.status === "done") return okState(M.recordIsAlreadyVisibleToAgents, { lines: [CLOSED_CLASS_TEXT.openClassWarning] });
  if (cls === "closed") return failState(CLOSED_CLASS_TEXT.showAnywayRefused);
  return okState(cls === "open" ? M.recordIsVisibleToAgents : M.recordIsBecomingVisibleToAgents, { lines: [CLOSED_CLASS_TEXT.openClassWarning] });
}

const statusProbe = (key: string, id: string) => () => meGw<unknown>(key, `/api/v1/records/${id}/status?derived=false`);
const moveDone = (key: string, id: string): Promise<boolean> => waitMoved(statusProbe(key, id));
const movedClass = (key: string, id: string): Promise<"open" | "closed" | null> => waitMovedClass(statusProbe(key, id));

export async function openDespiteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  if (formData.get("confirm") !== "on") return failState(M.tickTheBoxToConfirmYou3);
  const consent = String(formData.get("consent") ?? "").trim();
  if (!consent || consent.length > 4096) redirect(showAnywayHref(id, "consent_required"));
  const res = await meGw<{ id: string; status: "in_progress" | "done"; text_only?: boolean }>(
    session.key, `/api/v1/records/${id}/open`, { method: "POST", body: { despite_findings: true, consent } });
  if (!res.ok) {
    const gone = ended(res); if (gone) return gone;
    const stale = despiteStale(res);
    if (stale) redirect(showAnywayHref(id, stale));
    if (res.code === "in_progress" && !isOverloaded(res.details))
      return failState((res.details as { reason?: unknown } | undefined)?.reason === "closing" ? CLOSED_CLASS_TEXT.showAnywayClosing : CLOSED_CLASS_TEXT.showAnywayInProgress);
    if ((res.code === "forbidden" && res.details) || res.code === "open_check") return failState(res.message, res.code === "open_check" && res.hint ? { lines: [res.hint] } : {});
    return failState(M.notShownToAgents(res.message));
  }
  if (res.data.status === "done") { refresh(); return okState(CLOSED_CLASS_TEXT.showAnywayOpen); }
  const cls = await movedClass(session.key, id);
  refresh();
  if (cls === "closed") return failState(CLOSED_CLASS_TEXT.showAnywayRefused);
  return okState(cls === "open" ? CLOSED_CLASS_TEXT.showAnywayDone : CLOSED_CLASS_TEXT.showAnywayBecoming, { lines: [CLOSED_CLASS_TEXT.openClassWarning] });
}

export async function closeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  const res = await callTool<{ id: string; status: "in_progress" | "done"; affected?: number }>(session.key, "memory_close", { id });
  if (!res.ok) return fail(M.notHiddenFromAgents, res);
  const moved = res.data.status === "in_progress" && await moveDone(session.key, id);
  refresh();
  return okState(res.data.status === "done" ? M.recordIsAlreadyHiddenFromAgents : moved ? M.recordIsHiddenFromAgents : M.recordIsBeingHiddenFromAgents,
    { lines: [CLOSED_CLASS_TEXT.closeClassWarning] });
}

export async function deleteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  const res = await callTool<{ id: string; purge_after: string }>(session.key, "memory_delete", { id });
  if (!res.ok) return fail(M.notDeleted, res);
  redirect("/materials?deleted=1");
}

export async function askDeleteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  const reason = text(formData, "reason");
  if (reason && !(DELETION_REASONS as readonly string[]).includes(reason)) return failState(M.chooseAReasonFromTheList);
  const res = await meGw<{ id: string; status: DeletionStatus }>(session.key, `/api/v1/records/${id}/deletion-request`, { method: "POST", ...(reason ? { body: { reason } } : {}) });
  if (!res.ok) return ended(res) ?? failState(M.requestWasNotSent(res.message));
  refresh();
  if (res.data.status === "kept") return okState(DELETION_REQUESTS_TEXT.keptByAdmin);
  return okState(res.data.status === "declined" ? M.theOrganiserKeptTheMeetingThe : M.deletionRequestSent,
    { lines: [M.theMeetingOrganiserAndMemoryAdministrator] });
}

export async function keepMeetingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "request");
  if (!isId(id)) return failState(M.requestIdIsMissing);
  const res = await meGw<{ id: string }>(session.key, `/api/v1/me/deletion-requests/${id}/decline`, { method: "POST" });
  if (!res.ok) return ended(res) ?? failState(M.notSaved(res.message));
  refresh();
  return okState(M.meetingKept, { lines: [M.theParticipantCanSeeYourDecision] });
}

type ParticipantsChanged = { owner: { login: string }; participants: Array<{ login: string }>; pending: Array<{ login: string }>; changed: boolean;
                             versions?: number; results: Array<{ input: string; status: string; login?: string; display_name?: string }>; warnings?: string[] };

export async function meetingParticipantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id"), op = text(formData, "op"), who = text(formData, "who").trim();
  if (!isId(id)) return failState(M.meetingIdIsMissing);
  if (op !== "add" && op !== "remove") return failState(M.unknownAction);
  if (who.length < 3 || who.length > 200) return failState(M.enterTheParticipantSEmailOr);
  let before: Set<string> | null = null;
  if (op === "add") {
    const cur = await meGw<{ participants: Array<{ login: string }>; pending: Array<{ login: string }> }>(session.key, `/api/v1/records/${id}/participants`);
    if (cur.ok) before = new Set([...cur.data.participants, ...cur.data.pending].map((p) => p.login.toLowerCase()));
  }
  const key = who.toLowerCase();
  const res = await meGw<ParticipantsChanged>(session.key, `/api/v1/records/${id}/participants`, { method: "PUT", body: op === "add" ? { add: [who] } : { remove: [who] } });
  if (!res.ok) {
    const gone = ended(res); if (gone) return gone;
    if (res.code === "invalid_argument" && Array.isArray((res.details as { participants_ambiguous?: unknown } | undefined)?.participants_ambiguous)) return failState(M.matchesSeveralPeople(who), { lines: [M.findThePersonInTheDirectory] });
    if (handoverBusy(res)) return failState(MEETINGS_PLAIN.handoverBusy, { lines: [M.participantsHaveNotChanged] });
    if (res.code === "in_progress" && isOverloaded(res.details)) return failState(M.participantsHaveNotChanged2(overloadedMessage(res.retryAfter)));
    if (res.code === "in_progress") return failState(M.participantsHaveNotChangedTheMeeting, { lines: [M.tryAgainInAMinute] });
    return failState(M.participantsHaveNotChanged2(res.message));
  }
  refresh();
  const inMeeting = (login: string) => [...res.data.participants, ...res.data.pending].some((p) => p.login.toLowerCase() === login);
  if (op === "remove") {
    if (inMeeting(key)) return failState(M.participantsHaveNotChangedIsStill(who), { lines: [M.refreshThePageAndTryAgain] });
    if (!res.data.changed) return failState(M.isNotAMeetingParticipant(who));
    const versions = (res.data.versions ?? 1) > 1 ? M.includingPreviousVersionsOfTheMeeting : "";
    const name = text(formData, "name").trim().slice(0, 200) || who;
    return okState(M.isNoLongerAMeetingParticipant(name), { lines: [M.thisPersonCanNoLongerSee(versions)],
      undo: { label: M.restore, fields: { id, op: "add", who: key } } });
  }
  const r = res.data.results.find((x) => x.input.toLowerCase() === key);
  const viaDirectory = who.includes("@") || !/^[a-z]+:/i.test(who);
  if (r?.status === "not_found" && viaDirectory && res.data.warnings?.includes("directory_unavailable"))
    return failState(M.theCompanyDirectoryIsUnavailableWas(who), { lines: [M.allOtherMeetingParticipantsIncludingThose] });
  if (r?.status === "not_found" && viaDirectory && res.data.warnings?.includes("directory_lookups_capped"))
    return failState(M.couldNotCheckInTheCompany(who), { lines: [M.thePersonWasNotAddedAll] });
  if (r?.status === "not_found") return failState(M.wasNotFoundInMemoryOr(who), { lines: [M.checkTheEmailAddressOrFind] });
  const name = r?.display_name ?? who, login = (r?.login ?? key).toLowerCase();
  if (login === res.data.owner.login.toLowerCase()) return okState(M.isTheMeetingOrganiserAndAlready(name));
  if (!inMeeting(login)) return failState(M.participantsHaveNotChangedWasNot(name), { lines: [M.refreshThePageAndTryAgain] });
  if (!res.data.changed || before?.has(login)) return okState(M.isAlreadyAMeetingParticipant(name));
  const undo = r?.login && before ? { undo: { label: M.undo, fields: { id, op: "remove", who: login } } } : {};
  if (r?.status === "in_directory") return okState(M.isAParticipantAccessStartsOn(name), { lines: [M.thePersonIsInTheCompany], ...undo });
  return okState(M.isNowAMeetingParticipant(name), { lines: [M.thisPersonCanNowSeeThe], ...undo });
}

export async function leaveMeetingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.meetingIdIsMissing);
  const res = await meGw<{ id: string; changed: boolean; versions: number }>(session.key, `/api/v1/records/${id}/participants/me`, { method: "DELETE" });
  if (!res.ok) {
    const gone = ended(res); if (gone) return gone;
    if (handoverBusy(res)) return failState(MEETINGS_PLAIN.handoverBusy);
    if (res.code === "in_progress" && isOverloaded(res.details)) return failState(M.couldNotCompleteTheAction(overloadedMessage(res.retryAfter)));
    if (res.code === "in_progress") return failState(M.couldNotCompleteTheActionThe, { lines: [M.tryAgainInAMinute] });
    return failState(M.couldNotCompleteTheAction(res.message));
  }
  redirect("/meetings?left=1");
}

export async function restoreAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  if (text(formData, "op") === "undo") {
    const del = await callTool<{ id: string; purge_after: string }>(session.key, "memory_delete", { id });
    if (!del.ok) return fail(M.notDeleted, del);
    refresh();
    redirect("/trash?undone=1");
  }
  const res = await meGw<{ id: string; restored: number }>(session.key, `/api/v1/me/trash/${id}/restore`, { method: "POST" });
  if (!res.ok) return ended(res) ?? failState(M.notRestored(res.message));
  refresh();
  const data = res.data as { id: string; restored: number; space?: { slug: string; name: string; kind: string }; closed_on_restore?: boolean; closed_why?: string };
  redirect(RESTORE_PLAIN.href(id, res.data.restored, data.space,
    data.closed_why === "nda_recheck" ? "nda" : data.closed_why === "organizer_transfer" ? "organizer" : data.closed_on_restore === true));
}

export async function purgeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  if (formData.get("confirm") !== "on") return failState(M.tickTheBoxToConfirmThat);
  const res = await meGw<{ id: string; affected: number }>(session.key, `/api/v1/me/trash/${id}`, { method: "DELETE" });
  if (!res.ok) return ended(res) ?? failState(M.notDeleted2(res.message));
  refresh();
  return okState(M.recordPermanentlyDeleted, { lines: [M.theTextAndOriginalFileWill] });
}

const memberWords = (formData: FormData, login: string, space: string) =>
  ({ who: text(formData, "name").slice(0, 200) || login, where: text(formData, "space_name").slice(0, 200) || space });

async function memberAction(formData: FormData, op: "add" | "remove" | "role" | "uninvite"): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), login = text(formData, "login").toLowerCase();
  if (!isSpaceRef(space)) return failState(M.spaceIsMissing);
  if (!isLogin(login)) return failState(op === "add" ? M.colleagueSEmailForExampleUser : M.participantSEmailIsMissing);
  const w = memberWords(formData, login, space);
  const kind = text(formData, "space_kind"), place = placeOf(kind, w.where);
  const keep = { space, login, name: w.who, space_name: w.where, ...(kind ? { space_kind: kind } : {}) };
  const path = `/api/v1/me/spaces/${encodeURIComponent(space)}`;
  if (op === "add") {
    const as = text(formData, "as") || text(formData, "role") || "member";
    if (as !== "member" && as !== "reader") return failState(M.chooseTheInviteeSAccessMember);
    const res = await meGw<SpaceCallResult>(session.key, `${path}/members`, { method: "POST", body: { login, role: as } });
    if (!res.ok) return ended(res) ?? failState(M.notInvited(res.message));
    if (res.data.role === "owner") return okState(M.isAlreadyTheOwnerOf(w.who, w.where), { lines: [M.theOwnerManagesTheSpaceNo] });
    refresh();
    const r = callResult(res.data, res.data.display_name || w.who, kind, w.where);
    const undo = res.data.status === "added" ? { undo: { label: M.undo, fields: { ...keep, op: "remove", role: res.data.role } } }
      : res.data.status === "invited" ? { undo: { label: M.undo, fields: { ...keep, op: "uninvite" } } } : {};
    return okState(r.message, { lines: r.lines, ...undo });
  }
  if (op === "role") {
    const role = text(formData, "as");
    if (role !== "member" && role !== "reader") return failState(M.chooseAccessMemberOrReadOnly);
    const res = await meGw<{ login: string; role: string }>(session.key, `${path}/members/${encodeURIComponent(login)}`, { method: "PUT", body: { role } });
    if (!res.ok) return ended(res) ?? failState(M.accessHasNotChanged(res.message));
    refresh();
    return okState(`${w.who} — ${MEMBER_ROLE_PLAIN[role]}`, { lines: [role === "reader" ? M.canReadRecordsButCannotAdd : M.canReadAndAddRecords] });
  }
  if (op === "uninvite") {
    const res = await meGw<{ login: string; removed: boolean }>(session.key, `${path}/invites/${encodeURIComponent(login)}`, { method: "DELETE" });
    if (!res.ok) return ended(res) ?? failState(M.invitationWasNotCancelled(res.message));
    refresh();
    return okState(res.data.removed ? M.invitationForCancelled(w.who) : M.thereIsNoLongerAnInvitation(w.who));
  }
  const res = await callTool<{ space: string; login: string; removed: boolean }>(session.key, "memory_space_remove_member", { space, login });
  if (!res.ok) return fail(M.notRemoved, res);
  refresh();
  if (res.data.removed === false) return okState(M.remains(w.who, place), { lines: [res.text || M.theyWereNotAnInvitedMember] });
  const role = text(formData, "role");
  return okState(M.isNoLonger(w.who, place), { lines: [M.onlyInvitedMembershipIsRemovedHere],
    ...(role === "member" || role === "reader" ? { undo: { label: M.restore, fields: { ...keep, op: "add", as: role } } } : {}) });
}

const MEMBER_OPS = ["add", "remove", "role", "uninvite"] as const;
const memberOp = (formData: FormData, fallback: (typeof MEMBER_OPS)[number]) =>
  (MEMBER_OPS as readonly string[]).includes(text(formData, "op")) ? text(formData, "op") as (typeof MEMBER_OPS)[number] : fallback;

export async function addMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return memberAction(formData, memberOp(formData, "add"));
}

export async function removeMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return memberAction(formData, memberOp(formData, "remove"));
}

export async function memberRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return memberAction(formData, memberOp(formData, "role"));
}

export async function cancelInviteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return memberAction(formData, memberOp(formData, "uninvite"));
}

export async function issueMyKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const label = text(formData, "client_label"), expires = text(formData, "expires_at");
  if (label.length > 60) return failState(M.whereItWillRunUpTo);
  if (!expires) return failState(M.setTheKeySExpiryDate(PERSON_KEY_MAX_DAYS));
  const expires_at = endOfDayIso(expires);
  if (!expires_at) return failState(M.expiryEnterADate);
  if (Date.parse(expires_at) <= Date.now()) return failState(M.theExpiryDateIsInThe);
  if (expires_at > personKeyLimitIso(PERSON_KEY_MAX_DAYS)) return failState(M.keysLastUpToDaysAnd(PERSON_KEY_MAX_DAYS));
  const client_kind = text(formData, "client_kind");
  if (!client_kind) return failState(M.chooseTheProgramYouWillPaste);
  if (!isClientKind(client_kind)) return failState(M.unknownKeyProgramChooseFromThe);
  const res = await meGw<MyKeyIssue>(session.key, "/api/v1/me/keys", { method: "POST", body: { client_label: label || null, client_kind, expires_at } });
  if (!res.ok) return ended(res) ?? failState(M.keyWasNotIssued(res.message));
  refresh();
  return okState(label ? M.keyIssued(label) : M.keyIssued2(res.data.key.key_prefix), {
    keyId: res.data.key.id,
    keyLabel: label || null,
    lines: [M.program(CLIENT_KIND_TITLES[client_kind], client_kind === "script" ? M.thisKeySRecordsInYour : ""),
      label ? M.whereItWillRun(label) : M.noWhereItWillRunLabel, res.data.key.expires_at ? M.validThroughItCannotBeExtended(formatDay(res.data.key.expires_at)) : M.noExpiryUntilRevoked],
    secret: { label: M.key(res.data.key.key_prefix), value: res.data.secret, warning: M.theKeyIsShownOncePaste },
    clientKind: client_kind,
  });
}

export async function revokeMyKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.keyIdIsMissing);
  const res = await meGw<unknown>(session.key, `/api/v1/me/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return ended(res) ?? failState(res.status === 404 ? M.alreadyRevoked : res.message);
  refresh();
  return okState(M.revoked);
}

export async function markMyKeyScriptAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.keyIdIsMissing);
  const res = await meGw<MyKeyKind>(session.key, `/api/v1/me/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: { client_kind: "script" } });
  if (!res.ok) return ended(res) ?? failState(res.status === 404 ? M.keyNotFoundRevokedOrExpired : M.notChanged(res.message));
  refresh();
  return okState(M.keyMarkedAsAScriptKey, {
    lines: [M.newRecordsThisKeySavesIn],
  });
}

export async function narrowMyKeyOpenWriteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.keyIdIsMissing);
  const res = await meGw<MyKeyOpenWrite>(session.key, `/api/v1/me/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: { open_write: false } });
  if (!res.ok) return ended(res) ?? failState(res.status === 404 ? M.keyNotFoundRevokedOrExpired : M.notChanged(res.message));
  refresh();
  return okState(EXTENDED_OPEN_PLAIN.offDone, { lines: [EXTENDED_OPEN_PLAIN.offDoneLine] });
}

export async function setNotebookAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const enabled = text(formData, "enabled") === "1";
  const res = await meGw<{ enabled: boolean }>(session.key, "/api/v1/me/notebook", { method: "PUT", body: { enabled } });
  if (!res.ok) return ended(res) ?? failState(res.message);
  refresh();
  return okState(enabled ? M.newAgentRecordsInYourPersonal : M.newAgentRecordsInYourPersonal2, {
    lines: [enabled
      ? M.newNotesAndDocumentsYourAi
      : M.newNotesAndDocumentsYourAi2],
  });
}

/**
 * The person's own switch of the morning note e-mail: PUT /api/v1/me/morning-note {enabled} →
 * people.morning_note. The card on the Overview stays either way; a preview session is refused before any call.
 */
export async function setMorningNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const enabled = parseNoteSwitch(formData.get("enabled"));
  if (enabled === undefined) return failState(mnText("switch_invalid"));
  const res = await meGw<{ enabled?: unknown } | null>(session.key, MORNING_NOTE_PATH, { method: "PUT", body: { enabled } });
  if (!res.ok) return ended(res) ?? failState(mnText("not_saved", { message: res.message }));
  refresh();
  // the saved value as the gateway says it; an answer without it (another gateway version) — the value that was sent
  const saved = typeof res.data?.enabled === "boolean" ? res.data.enabled : enabled;
  return saved ? okState(mnText("saved_on"), { lines: [mnText("saved_on_line")] }) : okState(mnText("saved_off"), { lines: [mnText("saved_off_line")] });
}

export async function logoutAction(): Promise<void> {
  const pv = await previewExit();
  if (pv) {
    if (pv.revokeKeyId) await revokePreviewKey(pv.revokeKeyId);
    await clearPreviewCookies();
    redirect("/admin/preview");
  }
  const s = await readUserSession();
  if (s) await endCurrentSession(s.key);
  await clearUserSessionCookie();
  await clearWasInCookie();
  redirect("/login?left=1");
}

export async function endMySessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.sessionIdIsMissing);
  const res = await meGw<unknown>(session.key, `/api/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return ended(res) ?? failState(res.status === 404 ? M.alreadyEnded : res.message);
  refresh();
  return okState(M.sessionEnded);
}

export async function endAllSessionsAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const res = await meGw<{ ended: number }>(session.key, "/api/v1/me/sessions/end-all", { method: "POST" });
  if (!res.ok) return ended(res) ?? failState(res.message);
  await clearUserSessionCookie();
  await clearWasInCookie();
  redirect("/login?ended=1");
}

export async function exitPreviewAction(): Promise<void> {
  const pv = await previewExit();
  if (pv?.revokeKeyId) await revokePreviewKey(pv.revokeKeyId);
  await clearPreviewCookies();
  redirect("/admin/preview");
}

async function endCurrentSession(token: string): Promise<void> {
  try {
    await call("/api/v1/auth/logout", { method: "POST", token });
  } catch (e) {
    unstable_rethrow(e);
  }
}

async function revokePreviewKey(keyId: string): Promise<void> {
  if (!isId(keyId)) return;
  try {
    await tryGw(`/api/v1/admin/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  } catch (e) {
    unstable_rethrow(e);
  }
}
