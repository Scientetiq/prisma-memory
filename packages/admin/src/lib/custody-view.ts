import type { ConfirmSpec } from "@/components/confirm-dialog";
import { dayKey } from "../i18n/format";
import { derived, instanceTz } from "../i18n/runtime";
import { isTestLogin } from "./labels";
import { formatDay } from "./plain";
import type { CustodyCounts, CustodyPolicyView, PersonAccess, PersonCustody } from "./types";
import { CUSTODY_VIEW_MESSAGES, CUSTODY_PANEL } from "../messages/custody-view";

type Named = { login: string; display_name: string | null };
const nameOf = (p: Named): string => p.display_name?.trim() || p.login;
/** A moment in words, as a day in zone `tz` (not a date: null); without a zone, the zone of the installation. */
const dayOf = (iso: string | null | undefined, tz: string = instanceTz()): string | null => {
  const d = dayIn(iso, tz);
  return d ? formatDay(d) : null;
};

export function custodyBasisTitle(c: Pick<PersonCustody, "basis" | "levels" | "reason">): string {
  if (c.basis === "manual") return c.reason ? CUSTODY_VIEW_MESSAGES.assignedByAnAdministrator(c.reason) : CUSTODY_VIEW_MESSAGES.assignedByAnAdministrator2;
  if (c.basis === "department_head") return CUSTODY_VIEW_MESSAGES.departmentHead;
  if (c.basis === "manager") return c.levels >= 1 ? CUSTODY_VIEW_MESSAGES.managerSManagerInThe : CUSTODY_VIEW_MESSAGES.managerInTheOrgTable;
  return CUSTODY_VIEW_MESSAGES.assignedByAnAdministrator3;
}

export { CUSTODY_PANEL } from "../messages/custody-view";

export function dayIn(iso: string | null | undefined, tz: string = instanceTz()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  return dayKey(new Date(t), tz);
}

export function closedOpenedLine(a: Pick<PersonAccess, "person" | "custody" | "spaces">, tz: string = instanceTz()): { text: string; href: string } | null {
  const of = a.custody?.of_person;
  const n = of?.closed_opened;
  if (a.person.active || typeof n !== "number") return null;
  const personal = of?.space ?? a.spaces?.find((s) => s.kind === "personal")?.slug ?? null;
  const from = dayIn(of?.since, tz);
  const q = [`event_type=read`, ...(personal ? [`space=${encodeURIComponent(personal)}`] : []), ...(from ? [`from=${from}`] : [])].join("&");
  return { text: CUSTODY_PANEL.closedOpened(n), href: `/admin/audit?${q}#events` };
}

export function custodyHint(a: Pick<PersonAccess, "person" | "custody">): string {
  if (isTestLogin(a.person.login)) return CUSTODY_PANEL.hintTest;
  return a.custody?.policy.personal === "delete" ? CUSTODY_PANEL.hintDelete : CUSTODY_PANEL.hint;
}

const retentionOf = (policy: CustodyPolicyView | undefined): number => policy?.retention_days ?? 90;

export function custodyLines(a: Pick<PersonAccess, "person" | "custody">, now: number = Date.now(), tz: string = instanceTz()): string[] {
  const c = a.custody;
  if (!c || a.person.active) return [];
  const policy = c.policy, of = c.of_person, test = isTestLogin(a.person.login);
  const days = retentionOf(policy);
  const deleting = test || policy.personal === "delete";
  const head = deleting ? (days > 0 ? (test ? CUSTODY_PANEL.deletedTest(days) : CUSTODY_PANEL.deleted(days)) : CUSTODY_PANEL.neverDeleted) : null;
  if (!of) return [head ?? CUSTODY_PANEL.nothing];
  const out: string[] = [];
  const late = of.late_manager ? CUSTODY_PANEL.lateManager(of.late_manager.login, of.late_manager.display_name?.trim() || null) : null;
  if (of.custodian) {
    const who = CUSTODY_PANEL.custodian(nameOf(of.custodian), custodyBasisTitle(of), dayOf(of.since, tz));
    out.push(head ? `${head} ${who}` : `${CUSTODY_PANEL.kept} ${who}`);
    if (late) out.push(late);
    if (policy.meetings === "wait") out.push(CUSTODY_PANEL.meetingsWait);
    else if (of.active_from && Date.parse(of.active_from) > now) out.push(CUSTODY_PANEL.meetingsLater(dayOf(of.active_from, tz) ?? formatDay(of.active_from)));
    else out.push(CUSTODY_PANEL.meetingsMoved(of.meetings_moved));
  } else {
    if (head) out.push(head);
    out.push(noneLine(of));
    if (late) out.push(late);
  }
  if (of.meetings_waiting > 0) out.push(CUSTODY_PANEL.waiting(of.meetings_waiting));
  return out;
}

export const noneLine = (of: Pick<PersonCustody, "late_manager"> | null | undefined): string => (of?.late_manager ? CUSTODY_PANEL.noneLate : CUSTODY_PANEL.none);

export function holdsLine(holds: ReadonlyArray<Named> | undefined): string | null {
  return holds?.length ? CUSTODY_PANEL.holds(holds.map(nameOf)) : null;
}

export function activateConfirm(login: string, since: string | null | undefined, tz: string = instanceTz()): string {
  const day = dayOf(since, tz);
  return CUSTODY_VIEW_MESSAGES.activatePerson(login, day);
}

/** The "same person" checkbox label; the dictionary below uses it twice (the label and the hint that names it). */

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export const CUSTODY_VIEW_TEXT = derived(() => ({
  reactivationAckOne: CUSTODY_VIEW_MESSAGES.reactivationAckOneText,
  activateAckHint: CUSTODY_VIEW_MESSAGES.ifThisIsTheSame(CUSTODY_VIEW_MESSAGES.reactivationAckOneText),
  activatedText: CUSTODY_VIEW_MESSAGES.thisPersonIsActiveAgain,
  reactivationAskLabel: CUSTODY_VIEW_MESSAGES.yesTheseAreTheSame,
}));
export const REACTIVATION_ACK_FIELD = "confirm";

export const activateSpec = (login: string, since: string | null | undefined, tz: string = instanceTz()): ConfirmSpec =>
  ({ question: activateConfirm(login, since, tz), verb: CUSTODY_VIEW_MESSAGES.activate2, ack: { name: REACTIVATION_ACK_FIELD, label: CUSTODY_VIEW_TEXT.reactivationAckOne } });

export const REACTIVATION_FIELD = "confirm_reactivations";

export function reactivationAsk(logins: readonly string[], partial: boolean): { message: string; lines: string[] } {
  const n = logins.length;
  return {
    message: CUSTODY_VIEW_MESSAGES.reactivationMessage(n),
    lines: [
      CUSTODY_VIEW_MESSAGES.theFollowingExistingProfilesWill(logins.join(", ")),
      CUSTODY_VIEW_MESSAGES.ifThisIsANew2(partial ? CUSTODY_VIEW_MESSAGES.theOtherRowsHaveBeen : CUSTODY_VIEW_MESSAGES.nothingHasChanged),
    ],
  };
}

export function reactivationLogins(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@,]+@[^\s@,]+$/.test(x)))].slice(0, 20_000);
}

export function custodyUploadLine(c: CustodyCounts | undefined): string | null {
  if (!c || c.assigned + c.waiting <= 0) return null;
  return CUSTODY_VIEW_MESSAGES.uploadResult(c.assigned, c.waiting);
}

export { DISMISSED_REPORT } from "../messages/custody-view";

export function policyFromSettings(items: ReadonlyArray<{ category: string; key: string; value: unknown }> | null | undefined): { personal: "keep" | "delete"; meetings: "transfer" | "wait"; after_days: number } {
  const v = (key: string): unknown => items?.find((i) => i.category === "access" && i.key === key)?.value;
  const unset = (x: unknown) => typeof x !== "string" || x === "";
  const after = v("dismissed_custody_after_days"), meetings = v("dismissed_meetings");
  return {
    personal: v("dismissed_personal") === "delete" ? "delete" : "keep",
    meetings: unset(meetings) || meetings === "transfer" ? "transfer" : "wait",
    after_days: typeof after === "number" && Number.isInteger(after) && after >= 0 && after <= 90 ? after : 7,
  };
}

/** A date in words (the day in zone `tz`, by default the installation's) or null: report cells and the result line of "Assign". */
export const custodyDay = dayOf;

export { CUSTODY_VIEW_MESSAGES } from "../messages/custody-view";
