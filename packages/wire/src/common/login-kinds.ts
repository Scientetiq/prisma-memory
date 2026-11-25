// Generated from the login-check contract by the maintainers' generator. Do not edit by hand: a new request kind or
// factor level is added to the contract registry (and to contracts/schema/enums.json) and this file is regenerated.

/** Registry of login-check request kinds: the number is the AAD byte and the login.checks.kind column value. */
export const LOGIN_KINDS = [
  { id: 1, name: "code", stage: "1f" },
  { id: 2, name: "password", stage: "1e" },
  { id: 3, name: "authorize", stage: "1e" },
  { id: 4, name: "passkey", stage: "5" },
  { id: 5, name: "passkey_challenge", stage: "5" },
  { id: 6, name: "push", stage: "S2-3" },
  { id: 7, name: "ping", stage: "1f" },
] as const;
export type LoginKindName = (typeof LOGIN_KINDS)[number]["name"];
export type LoginKindId = (typeof LOGIN_KINDS)[number]["id"];

/** Kind name to number. */
export const LOGIN_KIND_IDS = { code: 1, password: 2, authorize: 3, passkey: 4, passkey_challenge: 5, push: 6, ping: 7 } as const satisfies Record<LoginKindName, LoginKindId>;

/** Registry of second-factor levels. */
export const MFA_LEVELS = ["none","totp","recovery","radius_otp","push","passkey"] as const;
export type MfaLevel = (typeof MFA_LEVELS)[number];
