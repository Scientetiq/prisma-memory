import { pluralEn } from "../../i18n/core";
import { formatCount } from "../../i18n/format";
import type { MfaMode } from "../../app/admin/(panel)/factor/view";

export const MODE_TITLE: Readonly<Record<MfaMode, string>> = { off: "off", optional: "optional", required: "required" };

export const RESET_MODE_TEXT: Readonly<Record<"basic" | "advanced", string>> = {
    basic: "Security mode is basic: a reset runs immediately, and only an administrator personally signed in through company sign-in can perform it.",
    advanced: "Security mode is advanced: a reset requires a second signature from another administrator or security auditor on the “Second signatures” page.",
};

export const ACTIONS_TEXT = {
  noColleagueSelected: "No colleague selected",
  enterAReason: "Enter a reason",
  value1ToValue2Characters: (value1: string | number, value2: string | number): string => `${value1} to ${value2} characters`,
  confirmBothChecks: "Confirm both checks",
  resettingTheFactorRequiresAnIdentityCheckNotBy: "Resetting the factor requires an identity check (not by email) and manager confirmation.",
  secondFactorReset: "Second factor reset",
  theSignInServiceRespondedLateTheResetSucceeded: "The sign-in service responded late: the reset succeeded, but the number of closed sessions is unknown",
  externalSignInSessionsClosedValue1: (value1: string | number): string => `External sign-in sessions closed: ${value1}`,
  thereWereNoActiveExternalSignInSessions: "There were no active external sign-in sessions",
  anEmailWasSentToTheColleague: "An email was sent to the colleague.",
  theEmailWasNotSentTellTheColleagueAbout: "The email was not sent — tell the colleague about the reset yourself (not by email).",
  emailDeliveryIsUnknownTellTheColleagueAboutThe: "Email delivery is unknown — tell the colleague about the reset yourself.",
  theyCanSetUpANewFactorInThe: "They can set up a new factor in the workspace from the office network or with support confirmation (a request is sent automatically and approved under “External access” → “First-time activation confirmations”).",
};

export const PAGE_TEXT = {
  secondFactorStatus: "second factor status",
  resetAColleagueSFactor: "Reset a colleague’s factor",
  colleagueLoginOrName: "Colleague login or name",
  findAColleague: "Find a colleague",
  find: "Find",
  mode: "Mode",
  changeInSettings: "Change in Settings",
  theSecondFactorIsNotInstalledInTheDatabase: "The second factor is not installed in the database yet: mode “{value1}” applies, with no coverage data.",
  requiredSinceValue1: "required since {value1}",
  settingChangedValue1: "setting changed {value1}",
  settingHasNotChanged: "setting has not changed",
  itIsStricterThanTheSettingValue1SoIt: " — it is stricter than the setting (“{value1}”), so it takes precedence",
  minimumModeFromEdgeAnchorsValue1Value2: "Minimum mode from edge anchors: “{value1}”{value2}.",
  noMinimumModeFromEdgeAnchors: "No minimum mode from edge anchors.",
  currentlyValue1: " (currently {value1})",
  existingApplicationConnectionsIssuedWithoutAFactorHaveA: "Existing application connections issued without a factor have a grace period until {value1}{value2}. External sign-in already requires a code.",
  colleagues: "colleagues",
  noColleaguesFound: "No colleagues found.",
  colleague: "Colleague",
  login: "Login",
  actions: "Actions",
  colleague2: "Colleague",
  login2: "Login",
  actions2: "Actions",
  selected: "selected",
  select: "Select",
  showingTheFirstValue1ResultsRefineYourSearch: "Showing the first {value1} results — refine your search.",
};

export const RESET_FORM_TEXT = {
  resetSecondFactor: "Reset second factor",
  resetting: "Resetting…",
  value1WillLoseExternalCodeSignInTheirExternal: (value1: string | number): string => `“${value1}” will lose external code sign-in; their external sign-in sessions will close.`,
  theColleagueWillReceiveAnEmailAdministratorsAndSecurity: "The colleague will receive an email; administrators and security auditors will see the event.",
  thisCannotBeUndoneTheColleagueWillSetUp: "This cannot be undone: the colleague will set up a new factor.",
  reset: "Reset",
  reason: "Reason",
  whyAreYouResettingItUseValue1Value2Characters: (value1: string | number, value2: string | number): string => `Why are you resetting it? Use ${value1}–${value2} characters; the reason is saved in the audit log.`,
  forExamplePhoneLostNoRecoveryCodes: "For example: phone lost, no recovery codes",
};

export const VIEW_TEXT = {
  factorPanelTitle: "Second factor",
  factorPanelLead: "A code from a phone app provides a second check when signing in to memory externally. Colleagues set it up in the workspace from the company network. Here you can view the current mode and coverage, and reset the factor for someone who lost their phone.",
  identityLabel: "Identity verified in person or by video call, not by email",
  managerLabel: "Confirmed by a manager",
  resetHint: "For someone who lost their phone and recovery codes. First verify their identity in person or by video call (not by email) and obtain manager confirmation. After a reset, external code sign-in stops working, external sign-in sessions close and an email is sent. They set up a new factor from the company network.",
  resetConfirm: "Reset this colleague’s second factor?",
  nobodyHasEnabledExternalAccessYet: "Nobody has enabled external access yet.",
  coverage: (people: number, enrolled: number, percent: number): string => `External access enabled for ${formatCount(people)} ${pluralEn(people, "colleague", "colleagues")}; second factor set up for ${formatCount(enrolled)} (${formatCount(percent)}%).`,
  requiredWarning: (without: number, connections: number, days: number): string => {
    const people = without
      ? `${formatCount(without)} ${pluralEn(without, "colleague with external access has", "colleagues with external access have")} no factor: their external sign-in sessions will close immediately, and they can sign in again only after setting up a factor internally.`
      : "all colleagues with external access have a factor.";
    const programs = !connections ? "" : days > 0
      ? ` Application connections issued without a factor (${formatCount(connections)}) will work for another ${formatCount(days)} ${pluralEn(days, "day", "days")} (grace period), then disconnect.`
      : ` Application connections issued without a factor (${formatCount(connections)}) will disconnect immediately: there is no grace period.`;
    return `If you require a second factor, ${people}${programs}`;
  },
  notResetOnlyAnAdministratorPersonallySignedInThrough: "Not reset: only an administrator personally signed in through company sign-in can reset a second factor — system keys, local accounts and emergency access cannot do this",
  notResetTheRequestIsStaleOrAlreadyUsed: "Not reset: the request is stale or already used — start again",
  notResetTheSignInServiceDidNotRespond: "Not reset: the sign-in service did not respond. Try again later",
  notResetAnotherAdministratorMustResetYourSecondFactor: "Not reset: another administrator must reset your second factor. You can replace your phone yourself using a recovery code in the workspace",
  notResetThisRequiresTheAdminPlaneWhichIs: "Not reset: this requires the admin plane, which is not configured",
  notResetColleagueNotFoundRefreshThePage: "Not reset: colleague not found — refresh the page",
  notResetValue1: (value1: string | number): string => `Not reset: ${value1}`,
  notResetValue12: (value1: string | number): string => `Not reset: ${value1}`,
  gatewayError: "gateway error",
  notResetValue13: (value1: string | number): string => `Not reset: ${value1}`,
};
