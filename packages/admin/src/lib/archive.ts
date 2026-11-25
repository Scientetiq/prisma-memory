import { derived } from "../i18n/runtime";
import { ARCHIVE_TEXT, TRANSFER_SPEC as TRANSFER_SPEC_LABELS } from "../messages/archive";
import { archive as M } from "../messages/archive";
import type { ConfirmSpec } from "@/components/confirm-dialog";


/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { ARCHIVE_TEXT } from "../messages/archive";


export function archiveConfirm(name: string, records: number | null): string {
  return M.archiveProjectAgentsWillNoLongerWrite(name, records !== null ? M.records(records) : "");
}

export function archiveSpec(name: string, records: number | null): ConfirmSpec {
  return { question: archiveConfirm(name, records), undo: M.youOrTheMemoryAdministratorCanRestore, danger: true, ack: { name: "confirm", label: M.theProjectIsFinishedAgentsNoLonger } };
}


export const transferSpec = (project: string): ConfirmSpec => ({
  ...TRANSFER_SPEC,
  question: M.transferOwnershipOfTo(project),
  change: M.youWillRemainAMemberTheNew,
  fill: "login_name",
});








// (final): the former last sentence promised that membership is never removed while the directory is down





export { archive as ARCHIVE_MESSAGES } from "../messages/archive";

export const TRANSFER_SPEC: ConfirmSpec = derived(() => ({ ...TRANSFER_SPEC_LABELS, ack: { name: "confirm", label: TRANSFER_SPEC_LABELS.ack.label } }));
