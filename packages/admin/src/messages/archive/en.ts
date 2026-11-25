import type { ConfirmSpec } from "../../components/confirm-dialog";
export const archive = {
  completedProjectsAndTeamSpacesYouCan: "Completed projects and team spaces you can read. Read-only: you can read, delete and hide records from agents, but cannot add or move them. Search finds them only with “Include archived records” selected.",
  theProjectIsFinishedArchiveItRecords: "The project is finished — archive it. Records stay: members can read them, and search finds them only with “Include archived records” selected. You cannot add or move records here, or restore records from Trash into an archived project. You or the memory administrator can restore the project from the archive.",
  records: (value0: unknown): string => ` Records: ${value0}.`,
  archiveProjectAgentsWillNoLongerWrite: (value0: unknown, value1: unknown): string => `Archive project “${value0}”?${value1} Agents will no longer write here, and search will no longer find its records by default.`,
  theProjectIsFinishedAgentsNoLonger: "The project is finished: agents no longer write here",
  youOrTheMemoryAdministratorCanRestore: "You or the memory administrator can restore it from the archive.",
  transferOwnershipOfTo: (value0: unknown): string => `Transfer ownership of “${value0}” to {}?`,
  youWillRemainAMemberTheNew: "You will remain a member: the new owner will manage members, colleague groups and the name.",
  theProjectWillBecomeActiveAgainMembers: "The project will become active again: members’ agents will be able to write here and search will find its records.",
  projectArchived: "Project archived.",
  anyProjectRecordsRemainMembersCanRead: "Any project records remain: members can read them, and search finds them only with “Include archived records” selected. Projects with records appear under “Spaces and projects” → “Project archive”. Restore the project here with “Restore from archive”.",
  projectActiveAgain: "Project active again.",
  membersAgentsCanWriteHereAgainAnd: "Members’ agents can write here again, and search finds its records by default. Group membership will be checked against the company directory.",
  theProjectIsArchivedAgentsCannotWrite: "The project is archived: agents cannot write here. Remove the connection line from CLAUDE.md or AGENTS.md in the project’s repositories.",
  whileTheProjectIsArchivedYouCannot: "While the project is archived, you cannot change its name, description or owner, or add members or groups. You can remove members or unlink groups. Restore it from the archive to make other changes.",
  roleAndMembershipBasisWhileTheProject: "Role and membership basis. While the project is archived, you can only remove members. People leaving a colleague group lose membership; new group members do not join the project.",
  includeArchivedRecords: "Include archived records",
  recordsFromCompletedProjects: "records from completed projects",
  theSpaceIsArchivedReadOnlySearch: "The space is archived: read-only. Search finds its records only with “Include archived records” selected.",
  unarchiveConfirm: ((value0: unknown): string => `Restore the project from the archive? ${value0}`)("The project will become active again: members’ agents will be able to write here and search will find its records."),
  archivedGroupsHint: "While the project is archived, you can only unlink groups. People leaving a group lose membership; new group members do not join the project. "
  + /* i18n */ "While the company directory does not answer, membership through groups is kept until the expiry set by the memory administrator passes without a successful sync, then removed until the directory answers.",
};

export const ARCHIVE_TEXT = {

  archivedReadonly: "Read-only: you can read, delete and hide records from agents, but cannot add, move or show them to agents.",

  trashArchived: "The space is archived — records cannot be restored here. Its owner or the memory administrator must restore it from the archive first.",

  openInArchive: "The space is archived: you can show a record to agents only if it was hidden from them after the space was archived.",
};

export const TRANSFER_SPEC = {
  question: "Transfer ownership of the space?",
  change: "The new owner will manage members, colleague groups and the name; you will remain a member.",
  undo: "Only the new owner or the memory administrator can return ownership.",
  danger: true,
  ack: { label: "I understand: I will become a member and the new owner will manage the space" },
};
