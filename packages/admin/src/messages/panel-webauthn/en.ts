
export const TEXT: Readonly<Record<string, string>> = {
    stepup_required: "First confirm your identity by touching a registered key (“Confirm with a touch”)",
    admin_webauthn_missing: "You have no keys yet — register your first key",
    webauthn_failed: "The key did not confirm the action. Try again",
};

export const TRANSPORT_TITLES: Readonly<Record<string, string>> = {
    usb: "USB", nfc: "NFC", ble: "Bluetooth", internal: "built-in", hybrid: "phone", "smart-card": "smart card",
};

export const ROLE_TITLES: Readonly<Record<"memory_admin" | "security_auditor", string>> = { memory_admin: "administrator", security_auditor: "security auditor" };

export const ACTIONS_TEXT = {
  notSso: "Security keys belong to a company sign-in session: sign in to the panel through company sign-in",
  notCompletedResponseValue1: (value1: string | number): string => `Not completed: response ${value1}`,
  keyRegistered: "Key registered",
  touchAcceptedYouCanRemoveAKeyOrAdd: "Touch accepted: you can remove a key or add a new one for a few minutes",
  noKeyID: "No key ID",
  keyRemovedItCanNoLongerBeUsedTo: "Key removed: it can no longer be used to sign in",
};

export const PAGE_TEXT = {
  lead: "A security key (USB, NFC or fingerprint) confirms panel sign-in and important actions with a touch. Keep at least two keys: your main key and a spare in a safe place. Adding a second key or removing a key requires a touch of a registered key.",
  webauthnKeys: "WebAuthn keys",
  noActiveKeysAddYourFirstKeyBelowIt: "No active keys. Add your first key below — it does not require a touch.",
  label: "Label",
  connection: "Connection",
  added: "Added",
  lastSignIn: "Last sign-in",
  label2: "Label",
  unlabelled: "unlabelled",
  canBeCopied: "can be copied",
  thisKeyCanBeCopiedBetweenDevicesPasswordManager: "This key can be copied between devices (password manager or cloud)",
  disabled: "disabled",
  thisKeyCanNoLongerSignInItWas: "This key can no longer sign in: it was disabled (suspected copy, or removed by you or a colleague)",
  connection2: "Connection",
  added2: "Added",
  lastSignIn2: "Last sign-in",
  noSignInsYet: "no sign-ins yet",
  sinceValue1: "since {value1}",
  delete: "Delete",
  unlabelled2: "unlabelled",
  deleteKeyValue1ItCanNoLongerSignIn: (value1: string | number): string => `Delete key “${value1}”? It can no longer sign in; restoring it requires registration again.`,
  nobodyHasAnAdministratorOrSecurityAuditorRole: "Nobody has an administrator or security auditor role.",
  who: "Who",
  role: "Role",
  keys: "Keys",
  enoughKeys: "Enough keys?",
  who2: "Who",
  role2: "Role",
  keys2: "Keys",
  enoughKeys2: "Enough keys?",
  enough: "enough",
  fewerThanValue1: "fewer than {value1}",
  noKeys: "no keys",
  webauthnKeys2: "WebAuthn keys",
  myKeys: "My keys",
  yourSessionDetails: "your session details",
  securityKeysBelongToCompanySignInYouSigned: "Security keys belong to company sign-in. You signed in with admin@local — sign out and use company sign-in to add your keys.",
  yourKeys: "your keys",
  emergencyAccessIsOpenANewKeyCanBe: "Emergency access is open: a new key can be added without touching an old one to recover from lost keys. This is shown in Alerts.",
  everyoneSKeys: "Everyone’s keys",
  activeKeysHeldByEachAdministratorAndSecurityAuditor: "Active keys held by each administrator and security auditor. A colleague who lost a key should remove it themselves using their spare. If no keys remain, use emergency access.",
  everyoneSKeys2: "everyone’s keys",
};

export const REGISTER_CLIENT_TEXT = {
  noWebauthn: "This browser cannot use security keys at this address: open the panel over HTTPS (localhost for testing)",
  theKeyDidNotRespondTryAgain: "The key did not respond — try again",
  touchYourSecurityKey: "Touch your security key…",
  couldNotCompleteTheActionTryAgain: "Could not complete the action — try again",
  waitingForKey: "Waiting for key…",
  confirmWithATouch: "Confirm with a touch",
  touchTheNewSecurityKey: "Touch the new security key…",
  theKeyDidNotRespondTryAgain2: "The key did not respond — try again",
  couldNotCompleteTheActionTryAgain2: "Could not complete the action — try again",
  forExampleMainKeySpareInSafe: "For example: main key, spare in safe",
  tag1KeyLabelTag1Value2: "<tag1>Key label</tag1>{value2}",
  waitingForKey2: "Waiting for key…",
  addKey: "Add key",
};
