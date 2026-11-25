import { avText } from "./agent-view.messages";
import { records as openRecords } from "./agent-view";
import { clientKindTitle } from "./labels";
import { SECTION_TITLES } from "./plain";
import { derived } from "../i18n/runtime";
import type { PlanApplyResult, PlanItem, PlanOp, PlanSummary } from "./types";
import { PLANS_MESSAGES, PLAN_OP_TITLES, PLAN_ITEM_TITLES, PLAN_REASON_TITLES, PLAN_APPLY_REASONS, PLAN_REASON_CORRECT_BULK } from "../messages/plans";

export { PLAN_OP_TITLES } from "../messages/plans";
export { PLAN_STATUS_TITLES } from "../messages/plans";
export { PLAN_ITEM_TITLES } from "../messages/plans";
export { PLAN_ITEM_BUTTONS } from "../messages/plans";
export { PLAN_REASON_TITLES } from "../messages/plans";
export { PLAN_APPLY_REASONS } from "../messages/plans";

export { PLANS_MORE } from "../messages/plans";
export { PLANS_EMPTY } from "../messages/plans";

export const PLAN_GONE = derived(() => ({ title: PLANS_MESSAGES.thisPlanIsUnavailable, text: PLANS_MESSAGES.aWeekHasPassedSince, back: SECTION_TITLES.plans } as const));

export { PLAN_ITEM_CORRECTION } from "../messages/plans";

export const planApplyReason = (op: PlanOp, reason: string | null): string | null =>
  !reason ? null : op === "correct_bulk" && reason === "workplace_only_op" ? PLANS_MESSAGES.onlyYouCanConfirmCorrections
    // a move to a team, a project or the whole company prepared by an agent waits for the person (not "deletion")
    : (op === "promote" || op === "move_space") && reason === "workplace_only_op" ? PLANS_MESSAGES.sharedMoveReason
    : op === "open" && reason === "workplace_only_op" ? avText("plan_apply_reason") : PLAN_APPLY_REASONS[reason] ?? null;
/**
 * an agent asked to move records to a team, a project or the whole company — the plan waits for the person's Apply.
 * Chosen from the fields the plan API already returns (op, created_via, apply_reason, status, target); null otherwise.
 */
export const planConfirmationNotice = (p: Pick<PlanSummary, "op" | "created_via" | "apply_reason" | "status" | "totals" | "target">): string | null => {
  if (p.created_via !== "mcp" || p.status !== "pending" || p.apply_reason !== "workplace_only_op" || (p.op !== "promote" && p.op !== "move_space")) return null;
  return PLANS_MESSAGES.confirmation(p.totals.items === 1, p.target?.name ?? null);
};
/**
 * The reason inside the plan page's sentence "only you apply this, on this page: …". Where the notice above is shown it
 * already says who asks and who applies, so the English reason of the move is not glued into the page's sentence of the
 * other language; otherwise the reason of planApplyReason.
 */
export const planApplyHintReason = (p: Pick<PlanSummary, "op" | "created_via" | "apply_reason" | "status" | "totals" | "target">): string | null =>
  planConfirmationNotice(p) ? null : planApplyReason(p.op, p.apply_reason);
export { PLAN_REASON_CORRECT_BULK } from "../messages/plans";
/** Op open: the reasons that read differently when a record is to be shown to agents. */
const PLAN_REASON_OPEN: Record<string, string> = {
  open_check: avText("reason_open_check"), never_open: avText("reason_never_open"), failed: avText("reason_failed"),
};
export const planReasonTitle = (op: PlanOp, reason: string): string =>
  (op === "correct_bulk" ? PLAN_REASON_CORRECT_BULK[reason] : op === "open" ? PLAN_REASON_OPEN[reason] : undefined) ?? PLAN_REASON_TITLES[reason] ?? reason;
export const planCascadeShown = (op: PlanOp): boolean => op !== "correct_bulk";
export const planItemBadge = (item: Pick<PlanItem, "status" | "correction_status">): string =>
  item.status === "done" && item.correction_status === "proposed" ? PLANS_MESSAGES.sentForConfirmation : PLAN_ITEM_TITLES[item.status];
export const planPageSize = (value: string): number => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100 ? Number(value) : 20;

export const planCount = (op: PlanOp, n: number): string => op === "open" ? openRecords(n) : PLANS_MESSAGES.count(op, n);
type Target = PlanSummary["target"];
export const planTitle = (p: Pick<PlanSummary, "op" | "totals"> & { target?: Target }): string =>
  // op open keeps its English title of "What my agent sees" (its op title and its count)
  p.op === "open" ? `${PLAN_OP_TITLES.open} · ${planCount(p.op, p.totals.items)}` : PLANS_MESSAGES.title(p.op, p.totals.items, p.target ?? null);
export function planApplyLabel(op: PlanOp, count: number, o: { continuing?: boolean; target?: Target } = {}): string {
  // op open keeps its English words of "What my agent sees"
  if (op === "open" && o.continuing) return avText("plan_continue", { records: planCount(op, count) });
  if (op === "open" && count) return avText("plan_apply", { records: planCount(op, count) });
  return PLANS_MESSAGES.applyLabel(op, count, !!o.continuing, o.target ?? null);
}

export const planExpired = (p: Pick<PlanSummary, "status" | "expires_at">, now = Date.now()): boolean =>
  p.status === "expired" || (p.status === "pending" && Date.parse(p.expires_at) <= now);
export const planCreator = (p: Pick<PlanSummary, "created_via" | "key">): string =>
  p.created_via === "workplace" ? PLANS_MESSAGES.youInTheWorkspace : p.key
    ? `${clientKindTitle(p.key.client_kind)}${p.key.label ? ` · ${p.key.label}` : ""}` : PLANS_MESSAGES.yourAgentKeyNoLonger;
export const planProgress = (r: Pick<PlanApplyResult, "status" | "done" | "skipped" | "excluded" | "remaining">): string => PLANS_MESSAGES.progress(r);

export { PLANS_MESSAGES } from "../messages/plans";
