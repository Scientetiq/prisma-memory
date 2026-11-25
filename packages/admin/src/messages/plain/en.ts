// English workspace texts. Each exported dictionary is wired separately for client tree shaking.
import { pluralEn } from "../../i18n/core";
import { dates } from "../common/en";
import { formatCount } from "../../i18n/format";
import { productName } from "../../i18n/brand";

const capitalize = (s: string): string => s ? s[0]!.toUpperCase() + s.slice(1) : s;
const dayWords = (day: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m)
        return day;
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? dates.dayMonth(Number(m[3]), month) : `${Number(m[3])} ${m[2]}`;
};
const WEEKDAY_GEN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const SECTION_GROUPS = { owner: "For the owner", personal: "Personal", service: "Utilities" };
export const SECTION_HINTS = {
    plans: "Change plans from you and agents for many records. Nothing changes without your approval",
    corrections: "Your proposed record corrections and colleagues’ proposals for your records",
    connect: "Connect a new AI agent: Claude Code, Codex, Cursor",
    keys: "Connected agents and their keys: expiry dates and how to disconnect",
    trash: "Deleted records: restore or delete permanently",
    custody: "Personal records of former colleagues entrusted to you",
    profile: "Your current work and how to work with you, for agents and colleagues",
    consents: "Company services allowed to search and read memory on your behalf",
    external: "Agent access from home or while travelling: enable, disable and connect an app",
    agentView: "What your AI agents can find in memory and how to show them more",
};
export const OVERVIEW_WHAT = {
    get summary(): string { return `What are ${productName()} and an AI agent?`; },
    get text(): string { return `${productName()} keeps company knowledge in one place: documents, notes, meetings and decisions. An AI agent is an assistant such as Claude Code, Codex or Cursor. Connect it to find what you need and save new records. It can only see what you can see.`; },
};
export const PLAIN = {
    addHere: "Upload or write",
    emptySelectionText: "Nothing here yet: no related records are visible to you.",
    newRecordsPlain: "new records",
    newRecordsHelp: "This is how new records are saved in this space. Existing records stay as they are. You can hide your own record from agents on its page.",
    findSubmit: "Find",
    openPlain: "visible to space members and their AI agents",
    closedPlain: "visible only to people here in the workspace; never sent to AI agents",
};
export const RECORD_TYPE_FOLDERS: Record<string, string> = {
    document: "Documents", transcript: "Meetings", event: "Decisions and tasks", summary: "Meeting summaries", profile: "Colleague profiles", note: "Notes",
};
export const EVENT_KIND_FOLDERS: Record<string, string> = { decision: "Decisions", action: "Tasks", question_risk: "Risks and questions", fact: "Facts" };
export const ACCESS_PLAIN = { open: "visible to agents", closed: "people only" };
export const NEW_RECORDS_TAG = { open: "New records are also visible to AI agents", closed: "New records are for people only, without agents" };
export const CLASS_CHOICE = {
    open: { title: "Members and their AI agents", hint: "Agents read project records and save decisions." },
    closed: { title: "People only, without agents", hint: "Agents can write here but cannot read." },
};
export const CLASS_PLAIN = { open: "open = visible to AI agents", closed: "closed = people only" };
export const ACCESS_PAST_PLAIN = { open: "visible to AI agents before deletion", closed: "visible to people only before deletion" };
export const MOVING_PLAIN = {
    lead: "Moving the record",
    wait: "this page will refresh automatically in a few seconds.",
    slow: "this is taking longer than usual. Refresh the page a little later.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
};
export const NOTEBOOK_PLAIN = {
    hide: "Hide new agent records",
    show: "Show new agent records",
    hideConfirm: "Hide new agent records in your personal space? New notes and documents from your AI agents will be closed. An agent with a personal key cannot read them, even its own. Existing records stay as they are.",
};
export const ACCESS_EXPLAIN = {
    open: "Open record: visible in search and answers to people with access and their AI agents.",
    closed: "Closed record: visible only to people here in the workspace. It is never sent to AI agents.",
};
export const CONNECT_PLAIN = {
    title: "Connect an AI agent",
    lead: "About 5 minutes. No keys or passwords to copy.",
    keyLead: "Five steps, about 5 minutes.",
    keyWhen: "If your app cannot sign in through a browser, or sign-in failed",
    toKeyLink: "Connect with a personal key",
    toOAuthLink: "Connect with your company account",
    itParams: "Settings for IT",
    autoOs: "detected automatically",
    notClaudeApp: "Claude in a browser and the Claude app cannot access memory.",
    oauthLater: "Agent sign-in with a company account, without a key, will be available when your administrator enables it.",
    ssoOnce: "Browser sign-in worked but your agent still cannot connect? Sign in to the workspace once using “Sign in with company single sign-on” so memory can link your account to you, then reconnect the agent.",
    waiting: "Waiting for the agent’s first request…",
    keyLeave: "This key is shown once and will disappear. Leave this page?",
    waitingKey: (label: string | null | undefined): string => (label ? `Waiting for a request with key “${label}”…` : "Waiting for the first request with the new key…"),
    again: "Ready ✓ · Connect another computer",
    otherKeyTitle: "Get a key for your app",
    otherPasteTitle: "Add the key to your app’s settings",
    noOffer: "The agent did not offer?",
};
export const KEYS_PLAIN = {
    revoke: "Revoke",
    revokeConfirm: (label: string): string => `Revoke key “${label}”? The agent on this computer will immediately lose access to memory. This cannot be undone; you will need a new key.`,
    script: "This is a script",
    scriptConfirm: (label: string): string => `Mark key “${label}” as a key for a script or local app? Its new records in your personal space will be closed. This cannot be undone; you will need a new key.`,
    scriptHint: "Choose “This is a script” if the key is used by a script or local app rather than a cloud agent. Its new records in your personal space will be closed. This cannot be undone.",
    more: "More",
    noLabel: (program: string, day: string): string => `${program}, issued ${day}`,
    connected: "connected",
    waiting: "waiting for the first request",
    revoked: "revoked",
    expired: "expired",
    connectMore: "Connect another agent",
    itSection: "For IT: script key and ready-to-use commands",
    lead: "Your AI agent keys and workspace sessions. Revoke a key at any time; your other agents will keep working.",
    leadOauth: "Your AI agent keys and workspace sessions. The easiest way to connect an agent is with your company account, without a key. Use a key if your app cannot sign in through a browser or sign-in failed.",
    sessionEnd: "End session",
    sessionEndConfirm: "End this session? You will need to sign in again on that device.",
    lastSeen: "last request",
    thisSession: "this session",
};
export const RETURN_PERSONAL = {
    button: "Return to personal space",
    confirm: "Return the record to your personal space? Colleagues will no longer see it",
    explain: (where: string | null) => `Colleagues will immediately lose access to this record${where ? ` in “${where}”` : ""}, both in search and in their AI agents’ answers. Summaries, decisions and previous versions will return with it. Anything already read cannot be taken back.`,
    explainDerived: (where: string | null) => `Only this record will return. Colleagues will immediately lose access to it${where ? ` in “${where}”` : ""}, both in search and in their AI agents’ answers. The source record it was created from stays where it is. Anything already read cannot be taken back.`,
    parentLink: "Source record",
    parentHint: "— return it to your personal space too if colleagues should no longer see it. Summaries and decisions will return with it.",
    participants: "Meeting participants will keep their access.",
    agents: "Your AI agents can still see it.",
    versions: "Previous versions",
    versionsHint: "A previous version may have been moved separately to Company knowledge, a team or a project. This button returns all versions, summaries and decisions to your personal space. If they are already here, nothing changes.",
    versionsConfirm: "Return previous versions, summaries and decisions to your personal space?",
    done: "Record returned to your personal space",
    already: "The record is already in your personal space",
    parentLeft: "The source record stayed where it was and is still visible to colleagues. To remove it too, open the source record and choose “Return to personal space”",
    card: "The company directory maintains colleague profiles; they cannot be moved",
    failed: "Could not return",
};
export const DERIVED_PLAIN = {
    promoteWarning: (name: string | null): string => `This record retells other records. If you move it${name ? ` in “${name}”` : ""}, people who cannot see its sources will also see it. Anything already read cannot be taken back.`,
    confirm: "I understand that people who cannot see the sources will see this record",
    tick: "To move it anyway, select “I understand…” and choose “Move” again.",
    unreadable: "Only someone who can see all sources can share this record with a wider audience.",
    basisMissing: "Some sources have been deleted or their links were not saved. Move this record only if you are sure it can be shown to the new readers.",
    after: "Shared beyond the source audience. This was your decision and is recorded in “My actions”.",
    openLine: "This retells other records. Opening it to agents lets members’ AI agents read it.",
    activity: "shared beyond the source audience, approved by a person",
    refused: "This retells other records. People there would see it without access to its sources. Save it where everyone can see the sources, or in your personal space.",
};
export const BASED_ON_PLAIN = {
    title: "Based on",
    sources: "This is an agent’s retelling, based on these records:",
    hidden: "This is an agent’s retelling. You do not have access to its source records.",
    echo: "This appears to retell a record:",
    advice: "Refer to the source records rather than the retelling.",
    untitled: "Untitled",
};
export const HANDOVER_PLAIN = {
    title: "Send to project",
    explain: "Creates a separate record in the project with this decision. The meeting stays as it is: project members will not see its transcript or other decisions.",
    project: "Project",
    choose: "Next",
    titleField: "Title",
    textField: "Text for the project",
    textHint: "Review the text. Remove anything that should stay within the meeting: phone numbers, amounts, contract numbers and names of people the project does not concern.",
    wider: (name: string, open: boolean): string => `This decision will be visible to all members of project “${name}”, including those who were not at the meeting, ${open ? "and their AI agents" : "but not their AI agents"}. Anything already read cannot be taken back.`,
    notWider: (name: string): string => `Members of project “${name}” already have access to this meeting. The record will also appear in the project.`,
    already: (name: string, day: string): string => `This decision was already sent to “${name}” ${day}. You can send it again or open the earlier record.`,
    confirm: "I have read the decision and agree to share it with project members",
    confirmMissing: "Select the checkbox to confirm you have read the decision and agree to share it with project members",
    button: "Send to project",
    done: (name: string): string => `Decision sent to project “${name}”`,
    openNew: "Open the new record",
    meetingKept: "The meeting stayed as it was, with the same access",
    organizerSees: "The meeting organiser will see this in their actions",
    repeat: "This record is already in the project; no duplicate was created",
    cannot: "Meeting participants, its organiser and the owner of its space can send a decision. Ask a participant to send it.",
    noProjects: "You have no projects you can add records to. Create one in “Spaces and projects” → “New project”.",
    notCurrent: "This is a previous version of the decision. Send the current one.",
    openCurrent: "Open current version",
    readOnly: (name: string): string => `You have read-only access to project “${name}” and cannot send a decision there.`,
    archived: (name: string): string => `Project “${name}” is archived and cannot receive records.`,
    openCheckTail: "Remove this from the text and try again. Only this text goes to the project; the meeting stays closed.",
    doneTitle: "Already sent",
    doneLine: (name: string, day: string): string => `In “${name}” ${day}`,
    open: "Open",
    link: "Send to project",
    failed: "Could not send",
};
export const EXTENDED_OPEN_PLAIN = {
    badge: "written by an agent with extended access",
    badgeHint: "An AI agent with access to a person’s open and closed records created this record. Such an agent needs the memory administrator’s permission to create open records. Each action is recorded in the audit log.",
    activity: "with extended access",
    keyDenied: "This key cannot create open records because the agent can also read your closed records. Only the memory administrator can allow this.",
    keyMarked: "Open records are marked as created with extended access, as allowed by the memory administrator. Each action is recorded in the audit log.",
    offButton: "Disallow open records",
    offConfirm: "Disallow this key from creating open records? The agent will immediately stop writing where colleagues and their AI agents can see its records, and will save to your personal space. Only the memory administrator can allow this again.",
    offDone: "This key can no longer create open records",
    offDoneLine: "New records from the agent using this key will be closed and saved in your personal space only. Only the memory administrator can allow open records again.",
};
export const PERSON_ACCESS_PLAIN = {
    hint: "What this person can see and do, with the reason for each permission. In the workspace they can also see closed records through space roles and meeting participation. A personal AI agent key reads only open records. Closed records require an extended key issued by the administrator, or an internal memory service acting on the person’s behalf.",
    selfLabel: "In the workspace they can see",
    agentsLabel: "Their AI agents can read",
    viaLabel: "How agents can access closed records",
    inactive: "nothing; this account is inactive",
    self: "open and closed records in their spaces, according to their role, and meetings they organise or participate in",
    agentsOpen: "open records only",
    agentsClosed: "open records and their own closed records, with an extended key",
    viaNone: "no access to closed records through agent keys",
};
export const MEETING_PROMOTE = {
    more: "More",
    button: "Move the whole meeting to a project…",
    warning: (cls: "open" | "closed"): string => `Members of the selected space will see the transcript, summary and all decisions. ${cls === "open"
        ? "The meeting is open to AI agents, so members’ AI agents will also receive it."
        : "The meeting will stay closed; AI agents will not receive it."} To share just one decision, use “Send to project” on that decision.`,
};
export const PROMOTE_PLAIN = {
    field: "Move to space",
    choose: "Choose a destination…",
    button: "Move",
    more: "More: move the record itself",
    moreHint: "Moves the original record. The meeting and its participants stay as they are.",
    moreHandover: "To share a decision as a separate record in the project, use “Send to project” above.",
    undo: "You can use “Return to personal space” to bring it back. Anything colleagues or their AI agents have already read cannot be taken back.",
    orgAck: "I understand that all company colleagues will see this record",
    done: (name: string | null): string => (name ? `Record moved to “${name}”` : "Record moved to the selected space"),
};
export const MEMBER_UNDO_PLAIN = {
    reader: "This person had read-only access. Only the memory administrator can restore that role. “Add member” makes them a member who can also write.",
};
export const MEETING_PEOPLE_PLAIN = {
    organizer: "Organiser",
    participants: "Participants",
    noParticipants: "no other participants",
    change: "Edit",
    show: "Participants",
    hintEdit: "The organiser and participants can see the meeting, its summary and decisions. Removing a participant revokes access immediately; adding one grants access.",
    hintView: "The organiser and participants can see the meeting, its summary and decisions. The organiser manages participants.",
    labelOrganizer: "organiser",
    labelParticipant: "participant",
    labelWaiting: "waiting for first sign-in",
    gone: "no longer with the company",
    waitingTitle: "This person is in the company directory but has not signed in to memory yet. Access will be available on first sign-in",
    addLabel: "Add participant",
    addPlaceholder: "Colleague’s name or email",
    addHint: "Start typing to find colleagues who have access to memory. You will be asked to confirm before adding them.",
    inMeeting: "already a participant",
    manualSummary: "Cannot find them?",
    manualHint: "Enter their full name or email. Memory will look them up the same way as when receiving a meeting.",
    manualLabel: "Email or full name",
    manualSubmit: "Add",
    unresolved: "Not found when received",
    notInvitedTitle: "Spoke at the meeting but cannot see it",
    notInvitedHint: "These people spoke at the meeting or were assigned tasks in its decisions, but are not participants. Add them if they need access.",
    why: { speaker: "spoke at the meeting", actor: "assigned tasks in decisions" } as Record<string, string>,
    leftTitle: "Left the meeting themselves",
    leftHint: "These people removed themselves as participants. The transcription service will not add them again; only you can.",
    returnLabel: "Restore",
    mistakeTitle: "Added by mistake?",
    mistakeHint: "If you were not at this meeting, remove yourself as a participant. If the meeting should not be in memory at all, ask to delete it.",
    leave: "Remove me as a participant",
    askDelete: "Ask to delete the meeting",
};
export const MEETINGS_PLAIN = {
    lead: "Meetings you organise or participate in. Only meeting participants can see them; they are never sent to AI agents.",
    more: "Learn more",
    moreLines: [
        "A meeting appears here when its organiser sends it to memory through a transcription service or their agent.",
        "Summaries and decisions are usually ready in a few minutes, or later under heavy load. Memory will finish processing automatically.",
        "Each time a meeting is opened, it is recorded in the audit log, visible in “My actions”.",
        "A colleague who has not signed in to memory yet will see the meeting on first sign-in.",
    ],
    previewNote: "Meetings are hidden in preview because they are closed. Preview, like an AI agent using a personal key, sees only open records.",
    searchLabel: "Find a meeting",
    searchPlaceholder: "Title, name or email",
    searchSubmit: "Find",
    searchShort: "Enter at least 2 characters to search.",
    filters: { all: "All", fresh: "New", owner: "I organise", participant: "I participate" },
    empty: "No meetings with you yet. They will appear when an organiser sends a meeting to memory.",
    emptyFiltered: "No matching meetings. Check the spelling or clear the filter.",
    emptyFresh: "No new meetings; you have already opened them all.",
    emptyPage: "No meetings on this page.",
    newUnavailable: "New meeting markers are unavailable right now. Show all meetings.",
    reset: "Clear",
    you: "you organise",
    organizer: (name: string) => `organiser ${name}`,
    noOthers: "no other participants",
    more_n: (n: number) => `and ${n} more`,
    fresh: "new",
    overviewTitle: "New meetings",
    overviewAll: "All meetings",
    overviewAllNew: (n: number) => `All new: ${n}`,
    navNew: (n: number) => `New meetings: ${n}`,
    navAsked: (n: number) => `Requests to delete your meetings: ${n}`,
    pagerNoun: "meetings",
    hiddenMeeting: "You no longer have access to this meeting",
    left: "You are no longer a participant and cannot see this meeting through participation. If it is in your project or Company knowledge, you can still see it there. The organiser can see that you left and can add you again.",
    handoverToYou: (day: string | null, from: string) => `This meeting was handed over to you${day ? ` ${day}` : ""}. Its previous organiser, ${from}, is no longer with the company. You now organise it.`,
    handoverToOthers: (day: string | null, from: string, to: string) => `The organiser changed${day ? ` ${day}` : ""}: ${from} is no longer with the company. The new organiser is ${to}.`,
    handoverBusy: "The meeting is being handed over to a new organiser. Try again in a minute.",
};
export const CUSTODY_PLAIN = {
    lead: "These personal records of former colleagues were entrusted to you because you were their manager or the memory administrator appointed you. Only you can read them, here in the workspace; your agents cannot see them. To work with a record, copy it to your personal space as your own closed record. The originals stay where they are.",
    personLine: (name: string, day: string) => `${name} — with the company until ${day}`,
    basis: { manager: "You are their manager in the org table", department_head: "You are their department head", admin: "Appointed by the memory administrator", manual: "Appointed by the memory administrator" } as Record<string, string>,
    countLine: (n: number, k: number) => `${n} ${counts.records(n)}, including ${k} ${pluralEn(k, "closed", "closed")}`,
    empty: "Nothing has been handed over to you yet.",
    open: "Open",
    colTitle: "Title",
    colType: "Type",
    colDate: "Date",
    closedMark: "Closed",
    searchLabel: "Find by title",
    searchSubmit: "Find",
    showDeleted: "Show records deleted by the colleague",
    showLive: "Show records",
    deletedMark: (day: string) => `deleted ${day}`,
    closedHidden: (k: number) => `Another ${k} ${pluralEn(k, "closed record", "closed records")}. You cannot read them, as configured by the memory administrator.`,
    closedHiddenSearch: (k: number) => `Closed records: ${k}. They are excluded from search because the memory administrator has disabled access.`,
    emptyList: "No records.",
    emptyDeleted: "No records deleted by the colleague.",
    emptyFound: "Nothing found. Check the spelling.",
    pagerNoun: "records",
    back: "All handed-over records",
    backPerson: (name: string) => `Records: ${name}`,
    closedTitle: "This is a closed record",
    sessionEnded: "Your session ended. Sign in again using the link (opens a new tab), then choose “Open” again",
    closedNote: "This was a colleague’s personal record. The text will open after confirmation.",
    confirmClosed: {
        question: "This is a closed personal record of a colleague. Open it?",
        change: "Opening this record will be logged. The memory administrator will see that you read it.",
        verb: "Open",
        cancel: "Do not open",
    },
    download: "Download file",
    truncated: (withFile: boolean) => withFile
        ? "Only the start of the document is shown. Download the file for the full document."
        : "Only the start of this record is shown because it is too long to display in full.",
    derivedTitle: "Created from this record",
    copy: "Copy to my space",
    confirmCopy: {
        question: "Copy this record to your personal space?",
        change: "A closed copy will appear in your personal space as your own record. You can show it to agents, move it to a project or delete it. The colleague’s original record stays where it is.",
        verb: "Copy",
    },
    copied: (title: string) => `Copied to your space: ${title}.`,
    notCopyable: "You can copy a note or decision. For a document, download the file; for a meeting, read it here.",
    tooBig: "This record is too large to copy. Download the file or save the parts you need.",
    emptyText: "This record has no text to copy.",
    activeAgain: (name: string) => `${name} is back with the company. These records belong to them again.`,
    gone: "These records are no longer in your custody.",
    off: "Nobody can currently read former colleagues’ personal records, as configured by the memory administrator. The records are kept.",
    copiedFrom: (name: string, day: string | null) => `Copied from the records of ${name} (no longer with the company)${day ? ` ${day}` : ""}.`,
    untitled: "Untitled",
};
export const SPACE_README = {
    label: "About this space",
    fieldLabel: "Description text",
    hint: "Members’ agents read this first when working with the space. Do not include passwords, personal data or amounts.",
    newHint: "Optional. Members’ agents read this first. Replace the prompts under each heading with your own words; an unchanged template is not saved. Do not include passwords, personal data or amounts.",
    nudge: "This space has no description, so agents do not know what belongs here. Fill in “About this space”.",
    fill: "Fill in",
    save: "Save description",
    saving: "Saving…",
    saved: "Description saved",
    savedLine: "Members’ AI agents will read it the next time they open this space.",
    cleared: "Description cleared",
    templateOnly: "Description is empty: only the template was entered",
    templateOnlyLine: "Replace the prompts under each heading with your own words and save again. Memory does not save an unchanged template.",
    clearHint: "To remove the description, clear the field and save.",
    orgTitle: "About Company knowledge",
    orgEdit: "Edit description",
    orgHint: "All colleagues’ AI agents read it. Company knowledge curators maintain it; the memory administrator sets the name and short description.",
    tooLong: (max: number) => `“About this space” allows up to ${max} characters`,
};
export const ADDABLE_PLAIN = {
    title: "Available to add",
    hint: (kind: "project" | "team", days: number) => `Your meetings from the last ${days} ${counts.days(days)} where more than half of the participants are ${kind === "project" ? "members of this project" : "members of this team"}. ` +
        `Select the meetings to move. All members of the ${kind === "project" ? "project" : "team"} will see them.`,
    share: (inSpace: number, people: number, kind: "project" | "team") => `${inSpace} of ${people} ${pluralEn(people, "participant", "participants")} ${kind === "project" ? "in the project" : "in the team"}`,
    move: "Move to space",
    moving: "Preparing the list…",
    note: "You will see the exact list first. Use “Apply” on the next page to move the meetings. Closed meetings stay closed and their participants keep access.",
    empty: "No matching meetings",
    open: "Open",
    pick: (title: string) => `Select meeting “${title}”`,
    pickNone: "Select at least one meeting.",
    tooMany: (max: number) => `Select no more than ${max} meetings at a time.`,
    nothing: "Nothing was moved: the selected meetings no longer qualify.",
    failed: "Could not load the meeting list",
    noun: "meetings",
};
export const PROFILE_PLAIN = {
    title: "My profile",
    sectionsTitle: "Profile sections",
    lead: "A few lines for your AI agents about your current work and how to work with you. An agent reads your profile when it starts working. Colleagues see only the sections you mark “Show to colleagues”.",
    sectionHints: {
        role: "What you are responsible for and which decisions you make.",
        focus: "Projects, topics and tasks for the next few weeks.",
        expertise: "Which questions people can come to you with.",
        work_with_me: "When and how to contact you, and what to send in advance.",
        agent: "How your AI agent should answer: for example, “briefly, in a list”, and the terms you use.",
    },
    rules: "Write about work. Health, family, salary and judgements about colleagues are not allowed and will not be saved. Do not include phone numbers, emails or contract numbers: your AI agents read the profile in the cloud.",
    agentOnly: "Only you and your agents can see this",
    showColleagues: "Show to colleagues",
    sourcePerson: "you",
    sourceAgent: "your agent, on your behalf",
    updated: (day: string, who: string | null) => `Updated ${day}${who ? ` · ${who}` : ""}`,
    stale: (day: string) => `Updated ${day} — check whether this is still current`,
    extended: "An AI agent with extended access made the last edit. This section stays hidden from colleagues until you select “Show to colleagues” again.",
    extendedPlain: "An AI agent with extended access made the last edit.",
    publicEmpty: "Colleagues will see this section once you fill it in.",
    empty: "Not filled in yet",
    limit: (chars: number) => `Up to ${formatCount(chars)} ${pluralEn(chars, "character", "characters")}`,
    save: "Save profile",
    saving: "Saving…",
    saved: "Profile saved",
    savedLine: "Your AI agents will see the changes when they next start working.",
    savedHidden: "Your profile is hidden from agents. They cannot see it until you choose “Show to agents” on the profile record’s page.",
    clash: "Profile not saved: it changed while this page was open",
    clashLine: (items: readonly string[]) => `While you were editing, ${items.length === 1 ? "the following section changed:" : "the following sections changed:"} ${items.join(", ")}.`,
    clashWho: (src: "person" | "agent_on_behalf" | null) => (src === "agent_on_behalf" ? "saved by your AI agent" : src === "person" ? "edited by you in another tab" : "section cleared"),
    clashHint: "To see the new text, copy what you typed and refresh the page. To keep your text, select “Replace with my text” and save again.",
    overwrite: "Replace with my text",
    savedPublic: (titles: readonly string[]) => (titles.length ? `Colleagues can see: ${titles.map((t) => `“${t}”`).join(", ")}.` : "Colleagues cannot see your profile."),
    unchanged: "No changes; your profile stayed as it was",
    notSaved: "Profile not saved",
    hidden: "Your profile is hidden from agents. They cannot see or change it. You can edit it here. Choose “Show to agents” on the profile record’s page to restore their access.",
    hiddenLink: "Open profile record",
    hiddenFlags: "While your profile is hidden from agents, colleagues cannot see it",
    noProfile: "Your profile is empty. Fill in at least one section and save it so your agents can read it when they start working.",
    previewTitle: "How colleagues see you",
    previewHint: "This is how colleagues see you in Company knowledge, on your colleague profile and through their AI agents.",
    previewEmpty: "Colleagues cannot see anything yet. Mark sections “Show to colleagues” and save your profile.",
    previewPending: "The selected sections are still hidden from colleagues. Save your profile to show them.",
    previewUnfilled: "The selected sections are empty. Fill them in and save your profile to show them to colleagues.",
    historyTitle: "Change history",
    historyHint: "Each change is saved as a new version. Only you can see the history. Use “Open” to read a previous version.",
    historyEmpty: "No changes yet",
    historyVersion: (n: number) => `Version ${n}`,
    historyChanged: (titles: readonly string[]) => (titles.length ? `changed: ${titles.map((t) => `“${t}”`).join(", ")}` : null),
    historyPublic: "colleague visibility changed",
    historyOpen: "Open",
    historyFailed: "Could not load history",
    historyNoun: "versions",
    failed: "Could not load profile",
    homeStale: (day: string) => `“Current work” in your profile was updated ${day}. Update it if anything has changed: your AI agents use it to understand what you are working on.`,
    homeStaleAction: "Refresh",
    aboutTitle: "About me",
    aboutHint: (day: string) => `This colleague wrote this about themselves. Updated ${day}.`,
    ownRecord: "This is your work profile. Use “My profile” to edit sections and choose what colleagues can see.",
    copyRecord: "This is what colleagues see in your work profile. The copy updates automatically when you edit “My profile”, where you can also clear “Show to colleagues”.",
    copyOther: "This colleague wrote this about themselves. The copy updates when they change their profile.",
    toProfile: "Open “My profile”",
    peopleCopyLine: "Work profile: what this colleague shared about themselves",
};
export const OVERVIEW_PLAIN = {
    lead: "This overview is for you. It includes only records you can open, and counts based on those records. Each line links to a record.",
    decisions: "Latest decisions",
    risks: "Open questions and risks",
    risksHint: "From the last 30 days.",
    due: "Due this week",
    dueHint: "Tasks due this week and overdue from last week. Memory inferred the deadline from the record’s words, such as “by Friday”. Open the record to check.",
    counts: "Work areas and deals",
    countsHint: (from: string | null) => `${from ? `Based on records since ${dayWords(from)}` : "Based on records from recent months"}. Choose a line to search these records.`,
    directions: "Work areas",
    entities: "Deals, companies, projects",
    week: "This week",
    weekHint: "What was saved to memory in the last 7 days.",
    empty: {
        decisions: "No decisions yet",
        risks: "No questions or risks this month",
        due_this_week: "No deadlines this week",
        counts: "No work areas or deals yet",
        week: "Nothing new this week",
    },
    allEmptyTitle: (kind: "project" | "team") => (kind === "project" ? "Project overview" : "Team overview"),
    allEmpty: (kind: "project" | "team") => `No decisions, questions, deadlines or new records this week ${kind === "project" ? "in the project" : "in the team"} yet. They will appear as meetings, documents and notes are added.`,
    failed: "Could not load overview",
    noun: { decisions: "decisions", risks: "questions and risks", due_this_week: "deadlines" },
    dueText: (due: string, overdue: boolean): string => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
        if (!m)
            return due;
        if (overdue)
            return `overdue: was due ${dayWords(due)}`;
        return `by ${WEEKDAY_GEN[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]}, ${dayWords(due)}`;
    },
    dueFrom: "record from",
    countLine: (title: string, count: number, kind: "deal" | "company" | "project" | null = null): string => {
        const what = kind ? `${ENTITY_KIND_WORD[kind]} “${title}”` : capitalize(title);
        return `${what} — ${formatCount(count)} ${counts.records(count)}`;
    },
    weekGroup: { meetings: "Meetings", documents: "Documents", notes: "Notes" },
    weekAll: { meetings: "All meetings", documents: "All documents", notes: "All notes" },
    weekMore: (n: number) => `and ${formatCount(n)} more`,
    guideTab: "How we work",
    pick: (p: {
        domain: string;
        entity: string;
        what: string;
    }, kind: "deal" | "company" | "project" | null): string => {
        const parts: string[] = [];
        if (p.domain)
            parts.push(`work area “${capitalize(p.domain)}”`);
        if (p.entity) {
            const word = kind ? ENTITY_KIND_WORD[kind].toLowerCase() : "deal, company or project";
            parts.push(p.what ? `${word} “${p.what}”` : `${word} from the overview`);
        }
        return parts.join(" and ");
    },
    pickLead: "Filter from the overview:",
    pickDrop: "Remove filter",
};
export const ENTITY_KIND_WORD = { deal: "Deal", company: "Company", project: "Project" };
export const GUIDE_PLAIN = {
    title: "How we work",
    lead: "A short guide for members’ AI agents: where tasks and documents live, which sources to trust and who is responsible for what. Agents read it first when working with this space.",
    sections: {
        tasks: { title: "Where tasks live", hint: "For example: a task tracker, project “CRM migration”; urgent matters in the project chat" },
        docs: { title: "Where documents live", hint: "For example: contracts in the project folder on the shared drive, minutes in the knowledge base" },
        sources: { title: "Sources to trust", hint: "For example: prices in the accounting system, rather than spreadsheets from email" },
        glossary: { title: "Glossary", hint: "For example: portal means the customer’s account area" },
        people: { title: "Who does what", hint: "For example: logistics handles the warehouse, legal handles contracts. Do not include phone numbers or emails" },
        rhythm: { title: "Routine", hint: "Team check-in on Tuesdays; decisions in the minutes" },
    },
    limit: (max: number) => `The guide exceeds ${max} tokens. Keep short lines and links here, and save knowledge as notes`,
    keepShort: "Keep short lines and links here, and save knowledge as notes",
    sectionTooLong: (title: string) => `Section “${title}” is too long`,
    size: (tokens: number, max: number) => `Size: about ${tokens} of ${max} tokens.`,
    formTitle: "Guide sections",
    formHint: "Empty sections are hidden. Do not include passwords, personal data or amounts: members’ AI agents read this guide.",
    save: "Save guide",
    saving: "Saving…",
    saved: (version: number) => `Guide saved — version ${version}`,
    savedLine: "Members’ AI agents will read the new version the next time they open this space.",
    savedClosedLine: "The guide is for people only because new records in this space are for people only.",
    same: "No changes; the guide is already the same",
    applied: (version: number) => `Proposal applied — guide updated, version ${version}`,
    appliedSame: "The guide is already the same; the proposal was marked as applied",
    notSaved: "Guide not saved",
    empty: "No guide yet.",
    emptyOwner: "Fill in the sections below. Members’ agents will read the guide first and go straight to the right system.",
    emptyReader: "The space owner maintains it. Your agent can propose guide text, and the owner will see it here.",
    readOnly: "The space owner edits the guide. Your agent can propose a change, and the owner will see it on this page.",
    readOnlyOrg: "Company knowledge curators maintain this guide. Your agent can propose a change, and the curators will see it on this page.",
    disabled: "The administrator has disabled the “How we work” guide.",
    personal: "Personal spaces have no guide. It helps colleagues’ agents find things in a shared project.",
    archived: "This space is archived. The guide is read-only.",
    closed: "This guide is for people only; AI agents cannot read it.",
    proposalsTitle: "Agent proposals",
    proposalsHint: "A member’s agent proposes the full text of a new guide. The guide changes only after you open the proposal, review it and save it.",
    proposalsMineHint: "These are your agent’s proposals. The space owner decides whether to apply them.",
    proposalsEmpty: "No new proposals.",
    proposalTitle: "An agent proposed a guide change",
    fromAgent: "agent’s inference",
    fromHuman: "on a person’s behalf",
    mine: "yours",
    by: (name: string) => `from ${name}`,
    changes: (titles: string) => `Changes: ${titles}`,
    noChanges: "The sections are the same as now",
    stale: "Proposed for a previous guide version. It does not include later edits.",
    showText: "Show proposal text",
    apply: "Apply",
    reject: "Reject",
    withdraw: "Withdraw",
    fromProposal: "This is the proposed text. Review and save it to change the guide",
    cancelProposal: "Do not apply",
    proposalGone: "This proposal is no longer pending: it was applied, rejected or withdrawn. The current guide is shown.",
    unplacedTitle: "Not assigned to sections",
    unplacedText: "This part of the proposal was not assigned to any section. Move what you need into a section; anything left here will not be saved",
    historyTitle: "Version history",
    historyHint: "Each save creates a new version. Open a version’s page to read its previous text.",
    historyEmpty: "No versions yet.",
    version: (n: number) => `Version ${n}`,
    current: "current",
    changed: (titles: string) => `Changed: ${titles}`,
    fromAgentProposal: "from an agent’s proposal",
    fromHumanProposal: "from a proposal on a person’s behalf",
    historyMore: "Showing the latest 50 versions.",
    open: "Open",
    correctionWhat: "New “How we work” guide text; review and apply it on the guide page",
    correctionKind: "“How we work” guide change",
    openGuide: "Open guide",
    appliedLine: (day: string) => `Guide change applied ${day}`.trim(),
    newVersion: "new guide version",
    back: "Back to space",
    failed: "Could not load guide",
};
export const counts = {
    records: (n: number): string => pluralEn(n, "record", "records"),
    days: (n: number): string => pluralEn(n, "day", "days"),
};
export const spaceWords = {
    personal: { kind: "Personal", audience: "Only you can see this" },
    project: { kind: "Project", audience: "Visible to project members" },
    org: { kind: "Company knowledge", audience: "Visible to all company colleagues" },
    department: { kind: "Department", audience: "Visible to everyone in the department" },
    team: { kind: "Team", audience: "Visible to team members" },
};
export const roles = {
    personal: { label: "yours only", hint: "You add and delete your own records. Colleagues cannot see them." },
    curator: { label: "you are a curator", hint: "You add records and review new ones in “Company knowledge review”: confirm, return or delete. All company colleagues can see them." },
    orgMember: { label: "you are a member", hint: "You add records. All company colleagues can see them." },
    orgReader: { label: "read-only · you can move your own record here", hint: "Use “Move” on your own record’s page to share it with all colleagues. You can undo the move." },
    departmentOwner: { label: "you are an owner", hint: "You add and delete records. Membership follows the org table; you can add colleagues from other departments yourself." },
    owner: { label: "you are an owner", hint: "You add and delete records and choose who participates." },
    member: { label: "you are a member", hint: "You read and add records." },
    reader: { label: "read-only", hint: "You can read but cannot add records. Members can add records." },
};
export const emptySpace = {
    text: (kind: string, add: boolean, open: boolean, preview: boolean): string => {
        const what = kind === "personal" ? "What you upload or write yourself and notes from your AI agents appear here. Colleagues cannot see them."
            : kind === "org" ? (add ? `What you upload here will be visible to all company colleagues${open ? " and their AI agents" : ""}.`
                : "Curators add policies, reference material and other company knowledge here. All colleagues can see it and find it in search.")
                : !add ? "Members add records here."
                    : kind === "project" ? "Project decisions, agreements and documents appear here. Members upload them, and AI agents connected using the repository line save them."
                        : "Members upload records or move them from their personal spaces. All members can see the records.";
        const how = preview ? "" : add ? ` To add a record, choose “${PLAIN.addHere}”.`
            : kind === "org" ? " You can also move your own record here: open it and choose “Move”." : "";
        return `Nothing here yet. ${what}${how}`;
    },
};
export const returnResult = {
    visible: (listed: number, file: boolean): string => {
        const who = listed > 0 ? `you and the meeting participants (${formatCount(listed)})` : "only you";
        return `It is now visible to ${who}${file ? " — except in spaces where colleagues uploaded the same file: it is still visible there" : ""}`;
    },
    noLonger: (file: boolean): string => `${file ? "Other colleagues" : "Colleagues"} immediately lost access. Anything already read cannot be taken back`,
    agents: "Your AI agents can still see it",
    derived: (n: number): string => `Summaries, decisions and previous versions returned with it: ${formatCount(n)}`,
    placements: (n: number): string => `The same file is also uploaded to ${formatCount(n)} ${pluralEn(n, "space", "spaces")} that you can see`,
};
export const handoverText = {
    defaultText: (statement: string | null, due: string | null): string => [statement?.trim() ?? "", due ? `Due: ${due}` : ""].filter(Boolean).join("\n\n"),
};
export const promote = {
    empty: "Visible to: Choose a space to see who will have access to this record.",
    audience: (kind: string, name: string, department: boolean, cls: "open" | "closed"): string => {
        const who = kind === "org" ? "all company colleagues"
            : kind === "project" ? `members of project “${name}”`
                : department ? `members of department “${name}”` : `members of “${name}”`;
        return `${who}${cls === "open" ? " and their AI agents" : ". AI agents cannot see it while the record is closed"}.`;
    },
    line: (audience: string): string => `Visible to: ${audience}`,
    question: (name: string): string => `Move the record to “${name}”?`,
    change: (meeting: boolean): string => `${meeting ? "The meeting, its summary and decisions will move there" : "The record and any records memory extracted from it will move there"}; access for AI agents stays the same, whether the record is open or closed.`,
    verb: (name: string): string => `Move to “${name}”`,
};
export const participants = {
    addQuestion: (who: string | null): string => `Add ${who ?? "“{}”"} as a meeting participant?`,
    addWho: (waiting: boolean, notify: boolean, manual: boolean): string => {
        const sees = "They will immediately see the meeting, its summary, decisions and transcript";
        return waiting ? "This person has not signed in to memory yet. They will see the meeting, its summary, decisions and transcript on first sign-in."
            : !notify ? `${sees}.` : manual ? `${sees}. If they have already signed in to memory, they will receive an email about the meeting.` : `${sees} and receive an email about the meeting.`;
    },
    addUndo: "You can remove them at any time, but anything already read cannot be taken back.",
    addVerb: "Add",
    leaveQuestion: "Remove yourself as a meeting participant?",
    leaveChange: (versions: boolean): string => `You will no longer see the meeting, its summary or decisions through participation${versions ? " — including previous versions of the meeting" : ""}. If the meeting is in your project or Company knowledge, you can still see it there.`,
    leaveWho: "The organiser will see that you left the meeting yourself. Sending the meeting again will not add you back.",
    leaveUndo: "Only the organiser can add you again.",
    leaveVerb: "Remove me",
    removeQuestion: (name: string): string => `Remove ${name} as a meeting participant?`,
    pendingChange: "This person has not signed in to memory yet. They will not see the meeting on first sign-in either.",
    removeUndo: "You can add this person as a participant again.",
    removeVerb: "Remove",
    askerChange: "This person will no longer see the meeting, its summary or decisions. The meeting stays in memory.",
  askerQuestion: (name: string): string => `Remove ${name} as a meeting participant?`,
  askerUndo: "You can add this person as a participant again.",
  askerVerb: "Remove",
};
export const names = {
    line: (people: string[], others: number): string => {
        if (!people.length)
            return others > 0 ? `participants: ${others}` : "";
        return `${people.join(", ")}${others > 0 ? ` ${MEETINGS_PLAIN.more_n(others)}` : ""}`;
    },
};
