
export const REASONS: Readonly<Record<string, string>> = {
    keys_lost: "security keys lost", sso_down: "identity provider unavailable", directory_down: "directory unavailable", incident: "incident", drill: "drill",
};

export const PAGE_TEXT = {
  emergencyAccess: "Emergency access",
  emergencyAccess2: "Emergency access",
  openAnEmergencyAccessWindowOnTheVMFrom: "Open an emergency access window on the VM from the bastion with memory-admin-cli breakglass open: each custodian enters their half of the key in turn. While it is open, sign-in without a security key is allowed only for reading and actions that restrict access. These sessions cannot provide a second signature. The window lasts at most admin.breakglass_max_hours (up to 2 hours); closing it revokes all its sessions.",
  emergencyAccessStatus: "emergency access status",
  window: "Window",
  tag1WindowOpenTag1Value2: "<tag1>Window open</tag1>{value2}.",
  closesAutomaticallyValue1ToCloseItEarlierRunMemory: "Closes automatically: {value1}. To close it earlier, run memory-admin-cli breakglass close on the VM.",
  windowClosed: "Window closed.",
};
