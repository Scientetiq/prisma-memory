// Deploy profile: one explicit switch between "safe on a server reachable from the internet" and "as before".
// The process reads MEMORY_DEPLOY_PROFILE once, at start; everything that differs between the profiles asks deployProfile().
//
//   internet (the default when the variable is unset or empty)
//       For a server that strangers can reach. The strictest rules: the install code is always required for the first
//       administrator, the admin API must have its own listener, only loopback is an internal network until the
//       administrator says otherwise, a request that came through an unknown proxy is external, the public address must
//       be https.
//   internal-http
//       A closed company network served over plain HTTP by address. Private networks are internal
//       as before; the install code is still always required.
//   development
//       A development installation on one machine. Exactly the behaviour before the profiles existed, including the first-run
//       without a code from loopback and private addresses. Never for a server that others can reach.
//
// An unknown value stops the start: a typo must not silently pick a weaker (or a different) set of rules.
// What each rule looks like is decided where the rule lives (first-run, listeners, channel defaults); this module only
// names the profile. It is the only place that reads the variable (contracts/env-allowlist.json).

export const DEPLOY_PROFILES = ["internet", "internal-http", "development"] as const;
export type DeployProfile = (typeof DEPLOY_PROFILES)[number];

/** The profile of a process that was told nothing: the strictest one. */
export const DEPLOY_PROFILE_DEFAULT: DeployProfile = "internet";
export const DEPLOY_PROFILE_ENV = "MEMORY_DEPLOY_PROFILE";

const VALUE_SHOWN_MAX = 40;
/** Message of the start refusal (English; kept in one place for the message catalogue). */
export const deployProfileUnknownMessage = (value: string): string =>
  `${DEPLOY_PROFILE_ENV} has the unknown value "${value.length > VALUE_SHOWN_MAX ? `${value.slice(0, VALUE_SHOWN_MAX)}…` : value}". `
  + `Accepted values: ${DEPLOY_PROFILES.join(", ")}. Leave the variable unset for the strictest profile (${DEPLOY_PROFILE_DEFAULT}).`;

/** The value of MEMORY_DEPLOY_PROFILE is not one of the profiles: the process must not start. */
export class DeployProfileError extends Error {
  constructor(value: string) { super(deployProfileUnknownMessage(value)); this.name = "DeployProfileError"; }
}

/** Profile from the raw value of the variable: unset or empty — the default; spaces around are ignored; anything else must match exactly. */
export function parseDeployProfile(raw: string | undefined | null): DeployProfile {
  const value = (raw ?? "").trim();
  if (!value) return DEPLOY_PROFILE_DEFAULT;
  if ((DEPLOY_PROFILES as readonly string[]).includes(value)) return value as DeployProfile;
  throw new DeployProfileError(value);
}

let cached: DeployProfile | null = null;

/**
 * The profile of this process. Read from the environment on the first call and remembered; an unknown value throws
 * DeployProfileError on every call (the entry point of the process turns it into a refusal to start).
 */
export function deployProfile(): DeployProfile {
  return (cached ??= parseDeployProfile(process.env.MEMORY_DEPLOY_PROFILE));
}

/** For tests: set the profile, or (no argument) forget it so that the next call reads the environment again. */
export function resetDeployProfileForTests(profile?: DeployProfile): void {
  cached = profile === undefined ? null : parseDeployProfile(profile);
}
