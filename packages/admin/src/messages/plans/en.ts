import { pluralEn } from "../../i18n/core";
import type { PlanOp, PlanSummary, PlanApplyResult } from "../../lib/types";
// English messages for this area.
export const PLAN_OP_TITLES = {
    delete: "Move to trash", close: "Hide from agents", promote: "Move records",
    move_space: "Move between spaces", purge: "Delete permanently",
    correct_bulk: "Correct the assignee in meeting events",
    open: "Show to agents",
} as const;
export const PLAN_STATUS_TITLES = {
    pending: "Awaiting decision", applying: "Applying", applied: "Applied", partially_applied: "Partly applied",
    expired: "Expired", cancelled: "Cancelled",
} as const;
export const PLAN_ITEM_TITLES = { pending: "In list", excluded: "Removed from list", done: "Applied", skipped: "Skipped" } as const;
export const PLAN_ITEM_BUTTONS = { exclude: "Leave untouched", include: "Return to list" } as const;
export const PLAN_REASON_TITLES: Record<string, string> = {
    changed: "The record changed after you saw the list, so it was left untouched", no_rights: "You no longer have permission to access this record", gone: "The record is no longer available",
    in_progress: "The record is being moved — try again later", open_check: "The record contains something that cannot be shown to agents, such as a phone number",
    never_open: "An administrator’s rule prevents these records from ever being shared with agents", expired: "The plan expired before this change could be applied",
    failed: "Could not apply the change — ask your agent to create a new plan",
    archived: "Space archived", not_found: "Record unavailable", derived: "Included with the source record",
    already_deleted: "Already in trash", same_space: "Already in this space", not_current: "This is an earlier version of the record",
    not_applicable: "The directory manages colleague profiles, so they cannot be moved",
    extended_open: "An agent that reads closed records cannot change records for agents without permission from the memory administrator",
    derived_wider: "Moving this retelling would expose it to people who cannot see its sources. Use “Move” on the record page instead",
};
export const PLAN_APPLY_REASONS: Record<string, string> = {
    over_threshold: "There are many records — you must confirm this list yourself", many_spaces: "The records span several spaces — you must confirm this list yourself",
    workplace_only_op: "Only you can confirm permanent deletion", created_in_workplace: "This list was created here in the workspace",
    script_key: "A script created this list — you must confirm it yourself", preview_key: "This list was created in preview",
};
export const PLANS_MORE = [
    "Your agent can apply a small list in one space (usually up to 20 records), but only after you say yes in the conversation.",
    "Only you can apply large lists, lists spanning several spaces, permanent deletion, and lists you created yourself, on this page.",
    "Only the saved list is applied. New records will not be added, and records changed since the list was shown will be left untouched.",
] as const;
export const PLANS_EMPTY = {
    pending: "Nothing is awaiting your decision right now.",
    all: "No change plans yet.",
    steps: [
        "Your agent proposes: ask it in a conversation to change many records at once.",
        "You review the list and see exactly what will change for each record.",
        "Confirm or cancel. Nothing changes without your decision.",
    ],
    example: "“Find my notes about the pilot from September and propose moving them to trash”",
} as const;
export const PLAN_ITEM_CORRECTION = { applied: "corrected", proposed: "sent for confirmation" } as const;
export const PLAN_REASON_CORRECT_BULK: Record<string, string> = {
    not_applicable: "This event has no such assignee",
    failed: "Could not apply the change — create the plan again on the meeting page",
};
export const PLANS_MESSAGES = {
    plansLead: "Your agent sends a list of changes to many records here. Review what will change and decide.",
    planDueTitle: "Decide by",
    planPageTitle: "Bulk change plan",
    planPurgeConfirm: "Recovery will be impossible",
    planCorrectProposeNotice: "If you are neither a meeting participant nor the space owner, a proposal will be sent to the participants for each event instead of applying the correction.",
    planEmptyApply: "Close plan without changes",
    planEmptyApplyHint: "All records have been removed from the list. The plan will close without changing any records.",
    thisPlanIsUnavailable: "This plan is unavailable",
    aWeekHasPassedSince: "A week has passed since its deadline, the link belongs to someone else, or the address is invalid. Ask your agent to create a new plan.",
    onlyYouCanConfirmCorrections: "Only you can confirm corrections to many events",
    sentForConfirmation: "Sent for confirmation",
    youInTheWorkspace: "You, in the workspace",
    yourAgentKeyNoLonger: "Your agent (key no longer available)",
    count: (op: PlanOp, n: number): string => `${n} ${op === "correct_bulk" ? pluralEn(n, "event", "events") : pluralEn(n, "record", "records")}`,
    title: (op: PlanOp, n: number, target: PlanSummary["target"]): string => { const into = !target ? "" : target.kind === "personal" ? " to personal space" : ` to “${target.name}”`; const head = op === "promote" && target?.kind === "personal" ? "Return to personal space" : `${PLAN_OP_TITLES[op]}${op === "promote" || op === "move_space" ? into : ""}`; return `${head} · ${`${n} ${op === "correct_bulk" ? pluralEn(n, "event", "events") : pluralEn(n, "record", "records")}`}`; },
    applyLabel: (op: PlanOp, n: number, continuing: boolean, target: PlanSummary["target"]): string => {
        const count = `${n} ${op === "correct_bulk" ? pluralEn(n, "event", "events") : pluralEn(n, "record", "records")}`;
        if (continuing)
            return `Continue: remaining ${count}`;
        if (!n)
            return "Close plan without changes";
        const into = !target ? "" : target.kind === "personal" ? " to personal space" : ` to “${target.name}”`;
        switch (op) {
            case "delete": return `Move ${count} to trash`;
            case "close": return `Hide ${count} from agents`;
            case "purge": return `Delete ${count} permanently`;
            case "correct_bulk": return `Correct the assignee in ${count}`;
            case "promote": return target?.kind === "personal" ? `Return ${count} to personal space` : `Move ${count}${into}`;
            case "move_space": return `Move ${count}${into}`;
            case "open": return `Show ${count} to agents`;
        }
    },
    progress: (r: Pick<PlanApplyResult, "status" | "done" | "skipped" | "excluded" | "remaining">): string => `${r.status === "applying" ? "Changes are still being applied" : "Done"}: ${r.done} applied, ${r.skipped} skipped, ${r.excluded} left untouched at your request${r.remaining ? `, ${r.remaining} remaining` : ""}`,
    sharedMoveReason: "Sharing a record with a team, a project or the whole company is confirmed by you, not by an agent",
    confirmation: (one: boolean, name: string | null): string => { const where = name ? `“${name}”` : "a shared space"; return `Your agent asks to move ${one ? "this record" : "these records"} to ${where} — everyone there will be able to read ${one ? "it" : "them"}. Nothing moves until you press Apply.`; },
};
