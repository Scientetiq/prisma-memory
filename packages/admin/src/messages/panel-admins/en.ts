import type { AdminRow } from "../../app/admin/(panel)/admins/page";

export const ROLE_TITLES: Readonly<Record<AdminRow["role"], string>> = { memory_admin: "memory administrator", security_auditor: "security auditor" };

export const METHOD_TITLES: Readonly<Record<string, string>> = {
    sso_webauthn: "single sign-on and security key", sso: "single sign-on", sso_breakglass: "single sign-on, emergency access", local: "admin@local", local_breakglass: "admin@local, emergency access",
    tool: "tool session",
};

export const TEXT = {
  since: "since {date}",
  administrators: "Administrators",
  neverSignedIn: "never signed in",
  lastSignIn: "Last sign-in",
  login: "Login",
  lastSignIn2: "Last sign-in",
  login2: "Login",
  noLocalAccounts: "No local accounts.",
  adminLocalSignsInWithAPassword: "admin@local signs in with a password. In advanced mode, sign-in is available only during an emergency access window.",
  localAccounts: "Local accounts",
  neverSignedIn2: "never signed in",
  lastSignIn3: "Last sign-in",
  noKeys: "no keys",
  boundToADevice: "bound to a device: {value1}",
  keys: "Keys",
  role: "Role",
  person: "Person",
  lastSignIn4: "Last sign-in",
  keys2: "Keys",
  role2: "Role",
  person2: "Person",
  noRoleAssignmentsThePanelIsAccessed: "No role assignments: the panel is accessed through admin@local.",
  assignOrRemoveARoleInRoles: "Assign or remove a role in <link1>Roles</link1>; manage keys in <link2>WebAuthn keys</link2>.",
  byRoleAssignment: "By role assignment",
  listOfAdministrators: "list of administrators",
  currentMemoryAdministratorsAndSecurityAuditorsTheir: "Current memory administrators and security auditors, their security keys and last sign-in. Advanced mode needs at least two memory administrators with keys bound to a device; otherwise nobody can provide the two signatures needed to return to basic mode.",
  administrators2: "Administrators",
};
