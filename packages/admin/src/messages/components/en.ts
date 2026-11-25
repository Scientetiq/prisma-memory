// Component texts in English.
import { productName } from "../../i18n/brand";
import { pluralEn } from "../../i18n/core";
import { formatCount } from "../../i18n/format";
export const ACTION_FORM_TEXT = {
  openRecord: "Open record",
  recordActions: "on the record page — “{value1}” and “Delete”",
  sending: "Sending…",
};

export const STEP_LABEL = { ok: "success", fail: "error", warn: "warning", skip: "skipped" } as const;

export const ADMIN_PLANE_STUB_TEXT = {
  stubText: "This section will be available in the next release. There is nothing to do here yet.",
};

export const AGENT_CARD_TEXT = {
  cloudAgent: "cloud agent",
  agent: "Agent",
  keyPrefix: (prefix: string): string => `key ${prefix}…`,
  validThrough: (day: string): string => `valid through ${day}`,
  noExpiry: "no expiry",
  edgeSignIn: "external access · sign in on the memory page",
  workspaceSignIn: "sign in through the memory workspace",
  companySignIn: "sign in with your company account",
  reconnectEdge: "To reconnect, connect again from the app and enter your password on the memory sign-in page.",
  reconnectBuiltin: "To reconnect, connect the app again. Memory will ask for your consent again.",
  reconnectCompany: "To reconnect, sign out of your company account in the browser, then sign in again.",
  connectionExpiry: "{value1} · until {value2}",
  disconnected: "disconnected",
  disconnect: "Disconnect",
  disconnectConfirm: (title: string, hint: string): string => `Disconnect ${title}? Its next requests will be rejected. ${hint}`,
};

export const CONNECTION_KIND_TITLES: Record<string, string> = { vscode: "VS Code", claude_desktop: "Claude Desktop", local_other: "Another local app" };

export const APPROVAL_PENDING_TEXT = {
  request: "Request: {value1}",
  openRequest: "Open request",
};

export const CONFIRM_DIALOG_TEXT = {
  change: "What will change",
  who: "Who will see it",
  undo: "Can it be undone",
  cancel: "Cancel",
};

export const CONVERTER_BLOCK_TEXT = {
  title: "Document converter",
  state: "converter status",
  holdNew: "Pause new documents",
  holdNewConfirm: "Pause sending new documents to the converter? Documents already sent will finish processing.",
  holdAll: "Pause all",
  holdAllConfirm: "Pause all document conversion? Documents will wait until you select “Resume”.",
  resume: "Resume",
  probe: "Check connection",
  probing: "Checking…",
  accountChangedHint: "Select this only if the memory account at the converter was changed intentionally. Documents sent by the previous account will be sent again.",
  accountChanged: " account changed intentionally",
  lead: "The converter turns PDF documents into text. It is shared by everyone and processes documents in order. When it is busy or unavailable, documents wait and resume automatically without using up attempts.",
  confirmNewAccount: "To resend documents with the new account, select “account changed intentionally” and “Check connection”.",
  recent: "Recent conversions ({value1})",
  record: "Record",
  status: "Status",
  atConverter: "At converter",
  waiting: "Waiting",
  retries: "Retries",
  orphans: "Unused converter copies (last {value1})",
  orphansHint: "No record in memory refers to these converter copies any more. Give their IDs to the converter administrator to remove them there.",
  when: "When",
  whyUnused: "Why it is unused",
  converterId: "Converter ID",
  document: "document {document}",
};

export const COPY_BLOCK_TEXT = {
  copyLabel: (label: string): string => `Copy: ${label}`,
  copied: "Copied",
  copy: "Copy",
  failed: "Could not copy — select the text and copy it manually.",
};

export const ERROR_ACTIONS_TEXT = {
  home: "Back to Overview",
  failed: "This section could not be opened.",
  retryHint: " Try again. If the problem continues, contact the memory administrator.",
  retrying: "Retrying…",
  retry: "Retry",
  details: "Details for IT",
};

export const EXTERNAL_NOTICES_TEXT = {
  dismiss: "Got it",
};

export const HEALTH_BANNER_TEXT = {
  unreachable: "Gateway unavailable.",
  instance: (id: string): string => `instance ${id}`,
  statusLine: "{value1}Gateway: {value2}",
  missingSettings: "Required settings are missing, so memory is not answering agents or services (HTTP 503). The admin panel remains available. Complete them in <mark1>Settings</mark1> — they are marked “not set”.",
  failClosed: "The gateway is deliberately refusing requests until the checks below pass. The admin panel remains available. Configure it in <mark1>Settings</mark1>.",
};

export const STATUS_TITLES = { ok: "healthy", degraded: "operating with limitations", fail_closed: "refusing requests (fail-closed)" } as const;

export const HEALTH_DEGRADED_TEXT = {
  genericExplain: "Reading and full-text search work. Processing stages that need a model or storage are waiting to retry.",
  fresh: "new",
  freshCount: ", new: {value1}",
  statusLine: "{value1}Gateway: <mark1>operating with limitations</mark1>{value2}{value3}",
  failedChecks: " — failed checks: {value1}.",
  details: "details",
  overview: "See Overview for what needs attention",
};

export const LLM_STATE_BLOCK_TEXT = {
  title: "Model",
  state: "model status",
  resume: "Resume",
  resumeConfirm: "Resume model requests? Pauses in the test queue will remain in place.",
  tryNow: "Try now",
  lead: "One model serves the whole company, handling requests one at a time. When it is busy or slow to respond, processing waits and retries automatically.",
  pausedBy: "Paused by",
};

export const LOGIN_STATUS_CARD_TEXT = {
  unavailable: "{value1} summary unavailable: {value2}",
  lastCheck: "Last check",
  notInNinetyDays: "none in the last 90 days",
  passed: "passed",
  failed: "failed{value1}",
  lastSignIn: "Last successful sign-in",
  lastDay: "Last 24 hours",
  counts: "sign-ins — {value1}, refused — {value2} · <mark1>Sign-ins in audit log</mark1>",
};

export const MEETING_ROW_TEXT = {
  ready: "Ready",
  failed: "Could not process",
  processing: "Processing",
  untitled: "Untitled",
  projectMeeting: "Project meeting",
  noProjectMeetings: "No project meetings yet. A meeting appears here when one of its decisions is handed over to the project or the organizer marks it as a project meeting.",
};

export const MISSING_PLAIN = {
  title: "Page not found",
  lead: "The link may be out of date or the address may contain a typo. The record may have been deleted or moved — try Search.",
  home: "Back to Overview",
  search: "Search",
} as const;

export const MOCKS_TEXT = {
  then: ", then ",
  terminal: "Terminal",
  bestMatch: "Best match",
  application: "Application",
  program: "Program",
  companySignIn: "<mark1>Example Corp</mark1> · Single sign-on",
  // Third-party screens and program names are reproduced in their original language.
  powerShell: "Windows PowerShell",
  signInHeading: "Sign in to your account",
  english: "English",
  username: "Username",
  password: "Password",
  rememberMe: "Remember me",
  signIn: "Sign In",
  authenticated: "Authentication successful",
  closeWindow: "You can close this window.",
  installServer: "Install MCP Server",
  cancelInstall: "Cancel",
  install: "Install",
  agentHeading: "Agent",
  chatPrompt: "Plan, search, build anything",
  toolCalled: "Called <app>{server}</app>.{tool}",
  welcome: " Welcome to <app>Claude Code</app>!",
  codexBrand: ">_ OpenAI Codex",
  directory: "· directory: ~",

};

export const KEYS: Record<string, { label: string; glyph?: string; sr?: string; wide?: boolean }> = {
  cmd: { glyph: "⌘", label: "cmd", sr: "Command" },
  win: { glyph: "⊞", label: "Win", sr: "Windows key" },
  ctrl: { label: "Ctrl" }, alt: { label: "Alt" }, shift: { label: "Shift" },
  space: { label: "Space", wide: true },
  enter: { glyph: "↵", label: "Enter", sr: "Enter" },
};

export const WHO: Record<"user" | "agent" | "tool", string> = { user: "You: ", tool: "Agent calls memory: ", agent: "Agent: " };

export const PAGER_TEXT = {
  first: "« First page",
  back: "‹ Back",
  next: "Next ›",
  last: "this is the last page",
  total: "Total",
};

export const PEOPLE_PICKER_TEXT = {
  get waitingPlain(): string { return `has not signed in to ${productName()} yet — invite them after their first sign-in`; },
  get invitePlain(): string { return `has not signed in to ${productName()} yet — will join the project on first sign-in`; },
  sessionEnded: "Your session ended — refresh the page and sign in again",
  searchFailed: "Search did not respond — try again",
  seconds: (seconds: number): string => `${seconds} s`,
  oneMinute: "a minute",
  rateLimited: (wait: string): string => `Too many searches in a row — wait ${wait}, then continue typing`,
  networkFailed: "Search did not respond — check your connection and try again",
  searching: "Searching people who have access to memory…",
  notFound: "No one with access to memory matched your search. Check the spelling or enter your colleague’s full email address.",
  notSelected: (query: string): string => `“${query}” is not selected — choose a colleague from the suggestions to invite them`,
  inviteColleague: "Invite a colleague",
  newOwner: "New owner",
  inviteAnother: "Invite another colleague",
  anotherPlaceholder: "Another colleague: last name, first name or email",
  placeholder: "Colleague’s last name, first name or email",
  actHint: "Start typing a last name, first name or email. Memory will suggest colleagues who have access. Selecting someone invites them to the project immediately.",
  singleHint: "Choose someone already in the project or start typing a last name, first name or email.",
  collectHint: "Start typing a last name, first name or email. Memory will suggest colleagues who have access. Each invitee gets a separate row. This is optional — you can invite people later on the project page.",
  inviteToProject: "Invite to project",
  emailPending: "by email — memory will check it when the project is created",
  removePerson: (name: string): string => `Remove ${name}`,
  remove: "Remove",
  chooseAnother: "Choose someone else",
  limit: "You can invite at most {value1} people at once. Add the others on the project page.",
  suggestions: "Matching colleagues",
  currentMembers: "Already in the project",
  inviteByEmail: (email: string): string => `Invite by email ${email}`,
  emailSearchFailed: "Search did not respond — memory will check the email when the project is created",
  invite: "Invite",
  inviteShort: "Invite",
  alreadyMember: "already in the project",
  notSignedIn: "In the company directory, but have not signed in to memory yet",
  firstTen: "Showing the first 10 — narrow your search by last name.",
  role: "Invitee’s permissions",
  inviting: "Inviting…",
  moreChars: (n: number): string => `Type ${n} more ${pluralEn(n, "character", "characters")}`,
};

export const PERSON_SUGGEST_TEXT = {
  linkedPerson: "person from the link",
  selected: "selected: {value1}{value2}",
  unavailable: "Suggestions are unavailable — you can enter the full login",
  searching: "Searching…",
  notFound: "No active people matched your search",
};

export const SLUG_PREVIEW = {
  label: "Address",
  empty: "The address will be based on the name",
  edit: "edit",
  note: "A number will be added if the address is already taken.",
} as const;

export const RECORD_ROW_TEXT = {
  untitled: "Untitled",
};

export const REPORT_DESPITE_TEXT = {
  summary: "Made available by the author despite findings in the last {value1} h: {value2}; including text only — {value3}. Refused by the worker: {value4}.",
  record: "Record",
  space: "Space",
  author: "Author",
  when: "When",
  accepted: "Accepted findings",
  authorOnly: "visible only to the author",
  shared: "visible to others",
  textOnly: "text only (scan)",
};

export const REPORT_QUALITY_TEXT = {
  details: "More on the Search quality page",
  title: "Search quality this week",
  week: (span: string): string => `For the week ${span}.`,
  searches: "Searches",
  nothingFound: "Nothing found",
  firstThree: "Read from the first three",
  nothingOpened: "Nothing opened",
  largestChange: "Largest change since last week: {value1}.",
  periodSearches: "Searches in this period",
  rollout: "Adoption",
  rolloutHint: (span: string, counted: string): string => `How colleagues start using memory. For the week ${span}; counts only, without names or record content.${counted}`,
  conversations: "AI agent conversations with memory",
  notCalculated: "This week has not been calculated yet — check back later.",
  conversationCount: "AI agent conversations with memory — {value1}",
  queryCount: "with a question to memory — {value1}",
  pastNotesFound: "found previously saved notes — {value1}",
  pastNotesOpened: "opened one of those notes — {value1}",
  colleagueNotes: "found colleagues’ notes — {value1}",
  overviewPastNotes: "new-content overview at the start found previous notes — {value1}",
  conversationHint: "A conversation is a period of agent activity with no break longer than 30 minutes. The agent checks the new-content overview at the start of each conversation, so it is counted separately.",
  openCheck: "Open check",
  agentNotes: "New notes from AI agents — {value1}, including {value2} saved as closed; another {value3} were blocked by the open check and were not saved.",
  other: "other",
  otherChecks: "Other check triggers: {value1}.",
  notesBySpace: "Notes by space",
  space: "Space",
  kind: "Kind",
  notes: "Notes",
  newThisWeek: "New this week",
  personalSpaces: "Personal spaces ({value1})",
  archived: "archived",
  spaceFallback: "space",
  totalNotes: "Total notes",
  individualSpaces: "Individual spaces",
  privacyHint: "Counts only. Personal and small spaces are combined into single rows so that one person’s notes cannot be identified.",
  adoptionHeading: "How colleagues adopt memory",
  catalogCount: "People in the directory — {value1}",
  step: "Step",
  people: "Colleagues",
  insufficientData: "not enough data",
  usualDays: (days: string): string => `usually ${days} days`,
  firstRead: "From first sign-in to the first record opened by an agent — {value1}",
  funnelHint: "Steps reflect the current state: revoking a key makes step 2 incomplete again. Steps 3–4 cover the last 12 months, from when counting began.",
};

export const RETRY_LATER_TEXT = {
  get limited(): string { return `${productName()} asks you to wait — this page will refresh automatically.`; },
  refreshSoon: "This page will refresh automatically soon.",
  retry: "Retry",
  retryNow: "Retry now",
};

export const ROW_MENU_TEXT = {
  more: "More actions",
};

export const SECRET_BOX_TEXT = {
  copy: "Copy",
  copied: "Copied",
  failed: "Could not copy — select the value and copy it manually",
};

export const SECTION_SETTINGS_FORM_TEXT = {
  ldapInsecure: "Without encryption, people’s passwords travel over the network as plain text. Anyone who can see traffic between the memory server and the directory controller can read them. In basic mode, this is supported when controllers do not provide LDAPS; passwords for colleagues signing in from outside use the same channel. In advanced mode, external sign-in requires encryption. Switch to LDAPS or StartTLS as soon as your controllers support it.",
  smtpInsecure: "Without encryption, the sender’s login, password and emails travel over the network as plain text. Anyone who can see traffic between the memory server and the mail server can read them. Use STARTTLS or TLS for normal operation.",
  checkSavedFirst: "You have unsaved changes, but checks run against the saved configuration. Continue with the saved configuration? Select “Save” first to check your changes.",
  ldapPasswordHint: "Password for the directory service account.",
  clearPassword: "clear password",
  saveLogin: "Save sign-in settings",
  dirtyLogin: "You have unsaved sign-in settings. Leave and lose them?",
  oidcSecretHint: "Find the secret in the client settings at the identity provider (in Keycloak: the client’s Credentials tab).",
  clearSecret: "clear secret",
  saveSso: "Save single sign-on settings",
  dirtySso: "You have unsaved single sign-on settings. Leave and lose them?",
  smtpPasswordHint: "Password for the email sender’s account.",
  saveMail: "Save mail settings",
  dirtyMail: "You have unsaved mail settings. Leave and lose them?",
  setKeep: "set, keep unchanged",
  notSet: "not set",
  workspaceValue: "For this workspace: {value1}",
  pemFormat: "Format: a block from {value1} to {value2}",
  example: "For example: {value1}",
  set: "set",
  missing: "not set",
  requiredHint: "This section cannot be enabled without this field",
  saving: "Saving…",
  invalidFields: "Some rules are not met — see the notes below the fields.",
  checksUseSaved: "You have unsaved changes — the checks below use the saved settings.",
  mailSavesFirst: "You have unsaved changes — the test email below will save them first.",
};

export const SETTINGS_SEARCH_TEXT = {
  label: "Find a setting",
  hint: "For example, “trash”, “model” or a setting name. Search by label or key across all sections.",
  empty: "Nothing found. Try another word or setting name.",
};

export const SHELL_TEXT = {
  logout: "Sign out",
  skip: "Skip to content",
  closeMenu: "Close menu",
  openMenu: "Open menu",
  navigation: "Navigation",
  sections: "Sections",
};

export const SPACE_CARD_TEXT = {
  noData: "no data",
  archived: "{value1}archived",
  newProject: "New project",
  newProjectHint: "Shared memory for the project team",
  recordNoun: (n: number): string => pluralEn(n, "record", "records"),
  processingCount: (n: number): string => `${formatCount(n)} processing`,
};

export const SPACE_SEARCH_TEXT = {
  searchIn: (name: string): string => `Search in “${name}”`,
};

export const TABLE_WRAP_TEXT = {
  moreColumns: "more columns →",
  start: "← back to start",
};

export const TEST_AFTER_SAVE_TEXT = {
  saveFailedText: "Settings were not saved — correct the marked fields above. No email was sent.",
  sending: "Sending…",
  saving: "Saving…",
  hint: "The settings above will be saved before the email is sent, so it reflects your changes.",
};

export const TOASTS_TEXT = {
  failed: "Could not complete the action — refresh the page and try again",
  close: "Close notification",
};

export const UI_TEXT = {
  details: "Details for IT",
  responseLost: "The connection to memory was lost before the response finished.",
  directoryUnavailable: "The company directory is not responding — try again later.",
  failed: "Memory returned an error.",
  loadFailed: "Could not load: {value1}.",
};

export const VIEW_AS_TEXT = {
  auditorBarText: "You are viewing the admin panel as an auditor. Audit log, Report and Search quality are available; changes are disabled.",
  returnAdmin: "Return to admin mode",
};

export const GROUP_VALIDITY_TEXT = {
  stale: "Not verified in time: members removed until the directory answers",
  validUntil: "membership valid until {until}",
};

export const PAGER_NOUNS = {
  rows: "rows", records: "records", meetings: "meetings", colleagues: "colleagues", clients: "clients", consents: "consents",
  proposals: "proposals", versions: "versions", alerts: "alerts", decisions: "decisions", risks: "questions and risks", deadlines: "deadlines",
};

export const PAGER_COUNTS = {
  rows: (n: number): string => `Rows shown: ${n}`,
  records: (n: number): string => `Records shown: ${n}`,
  meetings: (n: number): string => `Meetings shown: ${n}`,
  colleagues: (n: number): string => `Colleagues shown: ${n}`,
  clients: (n: number): string => `Clients shown: ${n}`,
  consents: (n: number): string => `Consents shown: ${n}`,
  proposals: (n: number): string => `Proposals shown: ${n}`,
  versions: (n: number): string => `Versions shown: ${n}`,
  alerts: (n: number): string => `Alerts shown: ${n}`,
  decisions: (n: number): string => `Decisions shown: ${n}`,
  risks: (n: number): string => `Questions and risks shown: ${n}`,
  deadlines: (n: number): string => `Deadlines shown: ${n}`,
  custom: (noun: string, n: number): string => `${noun} shown: ${n}`,
  local: (label: string, total: number, shown: number, page: number, pages: number): string => `${label}: ${total}${total > shown ? ` · shown ${shown}` : ""}${pages > 1 ? ` · page ${page} of ${pages}` : ""}`,
};
