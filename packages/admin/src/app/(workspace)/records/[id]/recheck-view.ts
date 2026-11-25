import { recheckViewText as M } from "@/messages/ws-records";
import { derived } from "@/i18n/runtime";

export interface RecordRecheck { held: boolean; state?: "held" | "kept" | "on_restore"; why?: "nda" | "rules" | "unchecked"; held_at?: string | null; text?: string; can_keep?: boolean }

export const RECHECK_BLOCK = derived(() => ({
  title: M.hiddenByRecheck,
  hint: M.anOpenCheckRecheckHidesRecords,
  held: M.hiddenFromAgents,
  kept: M.keptHidden,
  onRestore: M.willReturnFromTrashHidden,
  keep: M.keepHidden,
  keepConfirm: M.theRecordWillStayHiddenFrom,
  keptLine: M.youChoseToKeepItHidden,
  done: M.recordKeptHidden,
  failed: M.couldNotPrepare,
} as const));
