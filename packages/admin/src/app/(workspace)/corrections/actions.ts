"use server";
import { actionsText as M } from "@/messages/ws-corrections";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { text } from "@/lib/form";
import { bulkEmptyText, DECISION_DONE, LIMITS, charCount, correctionFailState, correctResultText, eventFieldsChange, isCorrectionKind, isUuid, multiline, parseRecordRef, sameName, type CorrectionDecision, type OwnResult, CORRECTIONS_COPY } from "@/lib/corrections";
import { noteDigest } from "@/lib/corrections-api";
import { callTool } from "@/lib/mcp";
import { meGw } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { GUIDE_BACK } from "@/lib/space-guide";
import type { CorrectionView, CorrectResult, EventFields, PlanCompose, StatusResult } from "@/lib/types";
import { actionSession } from "@/lib/user-session";

const previewDenied = (): ActionState => failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });


const area = (form: FormData, name: string): string => multiline(String(form.get(name) ?? ""));

function shownEvent(form: FormData): EventFields {
  let actors: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text(form, "was_actors") || "[]");
    if (Array.isArray(parsed)) actors = parsed.map(String);
  } catch { }
  return { title: text(form, "was_title"), statement: area(form, "was_statement"), due: text(form, "was_due") || null, actors };
}

export async function correctAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return previewDenied();
  const id = text(form, "id"), kind = text(form, "kind");
  if (!isUuid(id)) return failState(CORRECTIONS_COPY.notFoundText);
  if (!isCorrectionKind(kind)) return failState(M.thisKindOfCorrectionDoesNot);
  const args: Record<string, unknown> = { id, kind, origin: "human" };
  switch (kind) {
    case "extraction_error": {
      const change = eventFieldsChange(shownEvent(form), { title: text(form, "title"), statement: area(form, "statement"), due: text(form, "due"),
        noDue: form.get("no_due") !== null, actors: text(form, "actors") });
      if (change.error !== undefined) return failState(change.error);
      args.fields = change.fields;
      const quote = area(form, "quote");
      if (quote) {
        if (charCount(quote) < LIMITS.quoteMin || charCount(quote) > LIMITS.quoteMax) return failState(M.theTranscriptPhraseMustBeBetween);
        args.quote = quote;
      }
      break;
    }
    case "wrong": {
      const said = area(form, "text");
      if (!said) return failState(M.describeWhatIsCorrect);
      if (charCount(said) > LIMITS.text) return failState((M.tooLongUseAtMost2));
      args.text = said;
      break;
    }
    case "outdated": {
      const said = area(form, "text"), pick = text(form, "newer_pick"), ref = text(form, "newer");
      if (pick && !isUuid(pick)) return failState(M.selectTheNewerRecordFromThe);
      const newer = pick ? pick.toLowerCase() : ref ? parseRecordRef(ref) : null;
      if (!pick && ref && !newer) return failState(M.thisDoesNotLookLikeA);
      if (newer && newer === id.toLowerCase()) return failState(M.chooseAnotherRecordThisIsThe);
      if (!said && !newer) return failState(M.describeWhatChangedOrPasteThe);
      if (charCount(said) > LIMITS.text) return failState((M.tooLongUseAtMost2));
      if (said) args.text = said;
      if (newer) args.newer_id = newer;
      break;
    }
    case "own_note": {
      const note = area(form, "text"), title = text(form, "title"), wasTitle = text(form, "was_title"), wasText = text(form, "was_text");
      if (!note) return failState(M.enterTheNewNoteText);
      if (charCount(title) > LIMITS.title) return failState(M.titleMustBeAtMost200);
      const titleChanged = Boolean(title) && title !== wasTitle;
      if (!titleChanged && wasText && noteDigest(note) === wasText) return failState(CORRECTIONS_COPY.nothingChangedNote);
      args.text = note;
      if (titleChanged) args.fields = { title };
      break;
    }
  }
  const res = await callTool<CorrectResult>(session.key, "memory_correct", args);
  if (!res.ok) return endedState(res) ?? correctionFailState(res, kind);
  refresh();
  const out = correctResultText(res.data, form.get("closed_result") === "1", kind === "own_note" && form.get("open_kept") === "1" ? await ownResult(session.key, res.data) : null);
  return okState(out.message, out.link ? { link: out.link } : {});
}

async function ownResult(key: string, r: CorrectResult): Promise<OwnResult | null> {
  if (r.status !== "applied" || !r.result_id || !isUuid(r.result_id)) return null;
  const st = await meGw<StatusResult>(key, `/api/v1/records/${r.result_id}/status`);
  if (!st.ok || (st.data.class !== "open" && st.data.class !== "closed")) return null;
  return { cls: st.data.class, why: null, mark: st.data.open_check ?? null };
}

const BACK = /^\/(corrections|records\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const anchorOf = (back: string): string => back.startsWith("/records/") ? "#corrections" : GUIDE_BACK.test(back) ? "#proposals" : "";

export async function correctionDecisionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return previewDenied();
  const id = text(form, "id"), op = text(form, "op"), back = text(form, "back");
  if (!isUuid(id)) return failState(CORRECTIONS_COPY.notFoundText);
  if (!Object.hasOwn(DECISION_DONE, op)) return failState(M.unknownCorrectionDecision);
  const r = await meGw<CorrectionView>(session.key, `/api/v1/me/corrections/${id}/${op}`, { method: "POST", body: {} });
  if (!r.ok) return endedState(r) ?? correctionFailState(r);
  if (BACK.test(back) || GUIDE_BACK.test(back)) redirect(`${back}?decided=${op}${anchorOf(back)}`);
  refresh();
  return okState(DECISION_DONE[op as CorrectionDecision]);
}

export async function bulkActorAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return previewDenied();
  const meeting = text(form, "meeting_id"), from = text(form, "from"), to = text(form, "to");
  if (!isUuid(meeting)) return failState(CORRECTIONS_COPY.notFoundText);
  if (!from || !to) return failState(M.specifyWhoToReplaceAndTheir);
  if (charCount(from) > LIMITS.actor || charCount(to) > LIMITS.actor) return failState(M.namesMustBeAtMost120);
  if (sameName(from, to)) return failState(M.specifyDifferentNames);
  const res = await callTool<PlanCompose>(session.key, "memory_plan", { op: "correct_bulk", correct: { meeting_id: meeting, actors_map: { from, to } } });
  if (!res.ok) return endedState(res) ?? correctionFailState(res);
  if (res.data.status === "pending" && res.data.plan_id && isUuid(res.data.plan_id)) redirect(`/plans/${res.data.plan_id}`);
  return failState(bulkEmptyText(res.data.skipped));
}
