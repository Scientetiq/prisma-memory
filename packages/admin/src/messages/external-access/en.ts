import type { ExternalState } from "../../lib/external-access";
// English messages for this area.
export const EXTERNAL_FACTS: readonly string[] = [
    "An agent connecting from outside sees only the open records you can see. Closed and personal records are unavailable externally.",
    "External access is read-only. Records cannot be written or deleted.",
    "The company directory checks your password. Memory does not store it.",
];
export const DISABLED_CODE_TEXT: Readonly<Record<string, string>> = {
    self: "you disabled it yourself",
    admin: "the memory administrator disabled it",
    support: "support disabled it",
    idle: "it had not been used for a long time",
    person_inactive: "your colleague profile is disabled",
    ad_disabled: "your company directory account is disabled",
    ad_deleted: "your account is no longer in the company directory",
    ad_expired: "your company directory account has expired",
    ad_group: "you are not in the external access group",
    ad_deny: "you belong to a group barred from external access",
    admin_no_webauthn: "memory administrators need a WebAuthn key for external access",
    compromise: "a compromise was suspected",
    ad_link_changed: "the link between your profile and directory account changed",
};
export const NOT_ALLOWED_TEXT: Readonly<Record<string, string>> = {
    closed: "the sign-in check service cannot verify you at the moment",
    person_inactive: "your colleague profile is disabled",
    no_directory_link: "your profile is not linked to a company directory account",
    not_in_login_groups: "you are not in the external access group",
    in_deny_groups: "you belong to a group barred from external access",
    admin_count: "your directory account has special privileges that prevent external access",
    ad_disabled: "your directory account is disabled",
    ad_expired: "your directory account has expired",
    ad_deleted: "your account is not in the directory",
    admin_no_webauthn: "memory administrators need a WebAuthn key",
    directory_unavailable: "the company directory is not responding",
};
export const FIRST_CONFIRM_TEXT: Readonly<Record<ExternalState["first_confirm"]["status"], string | null>> = {
    not_needed: null,
    office: "First-time access: you are on the office network, so support confirmation is not needed.",
    none: "First-time access requires the office network or support verification of your identity. Select “Enable”. If you are outside the office, a request will be sent to support.",
    requested: "Your confirmation request is already with support. Once support verifies your identity, select “Enable” again. You will have 24 hours.",
    confirmed: "Support has verified your identity. Enable access within 24 hours.",
};
export const ENABLE_CONFIRM = {
    question: "Enable external access?",
    change: "Your agents will be able to read the open records you can see from outside the company network, after you enter your password on the memory sign-in page. You will receive an email about each new connection.",
    verb: "Enable",
} as const;
export const DISABLE_CONFIRM = {
    question: "Disable external access?",
    change: "All external connections will stop working immediately. You can enable access again here, from inside the network after signing in again.",
    verb: "Disable",
    danger: true,
} as const;
export const REVOKE_ALL_CONFIRM = {
    question: "Disconnect all external connections?",
    change: "All apps connected from outside will need to be connected again. External access itself will remain enabled.",
    verb: "Disconnect all",
    danger: true,
} as const;
export const CLOSED_REASON_TEXT: Readonly<Record<string, string>> = {
    threshold_unknown: "the directory lockout threshold is not set, so external passwords are not checked",
    window_unknown: "the incorrect password counter window is not set",
    pdc_unset: "the primary domain controller is not set",
    pdc_unreachable: "the primary domain controller is not responding",
    pdc_not_emulator: "the primary domain controller does not match a controller in “Sign-in and LDAP”, is not the PDC emulator, or its role cannot be determined",
    counter_unreadable: "the directory’s incorrect password counter cannot be read",
    pso_unreadable: "the directory’s password policy cannot be read",
    tls_none: "there is no secure connection to the directory",
    no_keys: "the service has no keys",
    anchors_invalid: "edge anchors failed validation",
    login_disabled: "external sign-in is disabled in settings",
    settings_invalid: "the service settings are invalid",
    groups_unreadable: "sign-in and deny groups cannot be read from the directory",
};
export const PAUSE_CONFIRM = {
    question: "Pause external sign-in?",
    change: "New external sign-ins will be blocked until the pause ends or is lifted. Connected apps will keep working.",
    verb: "Pause",
} as const;
export const LIFT_CONFIRM = {
    question: "Lift the manual pause?",
    change: "External sign-in will resume. This does not lift an automatic pause after incorrect passwords, which will end on its own.",
    verb: "Lift pause",
} as const;
export const EXTERNAL_ACCESS_MESSAGES = {
    externalTitle: "External access",
    externalLead: "Let your AI agents (Claude Code, Codex) work with memory from home or while travelling, outside the company network. Only you can enable access, from here inside the network. You can disable it at any time.",
    foreverPauseText: "External sign-in is paused indefinitely because edge export was disabled automatically. This pause cannot be lifted here and will not expire. It ends when the automatic shutdown is lifted (“Edge export” → “Canaries and automatic shutdown” → “Clear automatic shutdown”).",
    itWasDisabled: "it was disabled",
    supportHasMoreInformationAbout: "support has more information about the reason",
    reason: (value1: string | number): string => `Reason: ${value1}.`,
    externalSignInIsCurrently: "External sign-in is currently unavailable. Try again later",
    thisProtectsYouIfSomeone: "This protects you if someone else uses your computer. You will be asked for your password again.",
    signInAgain: "Sign in again",
    supportWillContactYouAnd: "Support will contact you and verify your identity. Then select “Enable” again.",
    firstSetUpASecond: "First set up a second factor: a code from an app on your phone.",
    setUpSecondFactor: "Set up second factor",
    used: "used",
    confirmed: "confirmed",
    confirmationExpired: "confirmation expired",
    awaitingSupport: "awaiting support",
    expired: "expired",
    theColleagueThemselves: "the colleague themselves",
    automatically: "automatically",
    administrator: "administrator",
    support: "support",
    disabledByText5: (value1: string | number, value2: string | number): string => `${value1} ${value2}`,
    notResponding: "not responding",
    theInternalSignInCheck: "The internal sign-in check service is not responding. External sign-in is unavailable and colleagues cannot enable access.",
    reasonUnknown: "reason unknown",
    closed: "closed",
    externalPasswordsAreNotChecked: (value1: string | number): string => `External passwords are not checked: ${value1}.`,
    theLastDirectoryCheckFailed: "The last directory check failed. The service will retry automatically.",
    running: "running",
    colleagues: "Colleagues",
    confirmations: "Confirmations",
    externalSignIn: "External sign-in",
    disableExternalAccessFor: (value1: string | number): string => `Disable external access for ${value1}?`,
    allTheirExternalConnectionsWill: "All their external connections will stop working immediately and they will receive an email. Only they can enable access again, from inside the network.",
    disable: "Disable",
    confirmThatTheRequestWas: (value1: string | number): string => `Confirm that the request was made by ${value1}?`,
    confirmOnlyAfterVerifyingIdentity: "Confirm only after verifying identity outside memory, by phone or in person. The colleague will have 24 hours to enable external access.",
    confirm: "Confirm",
};
