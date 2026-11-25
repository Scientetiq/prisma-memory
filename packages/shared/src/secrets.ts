// Secrets mode, MEMORY_SECRETS_MODE — read only in this module:
//   files (the default when the variable is unset or empty)
//       Every service reads its own secrets from its credentials directory and nothing is derived from one shared value.
//       PG_APP_PASSWORD in the environment stops the start. Required files: app-derive-key, pg-<role> of every role the
//       process logs in with over TCP, settings-key-<n>, despite-keys; each at least 16 bytes where it is free text, and no
//       two secret files of the directory with the same value. The start refusal names files, never values.
//       app-derive-key still signs pins, legacy sessions, second-signature requests and setting fingerprints, but it derives
//       no role password and no key here, so it is not "legacy" (health secrets_source can be ok).
//   legacy-derived
//       Only permits the old derivation from PG_APP_PASSWORD (or from the old shared value moved into app-derive-key);
//       files still win, nothing else changes. Existing installs set it explicitly.
// An unknown value stops the start: a typo must not silently pick another set of rules.
import { derivePassword, parseKey32, settingsKeyring, SETTINGS_KEY_PREFIX, type SettingsKeyring } from "./crypto.ts";
import { credentialNames, credentialsDir, latestVersion, readCredential, readCredentialSet, readCredentialText } from "./credentials.ts";
import type { Env } from "./db.ts";
import { DESPITE_KEYS_FILE, despiteKeysFrom, parseDespiteKeys, type DespiteKeys } from "./despite.ts";

export const SECRETS_MODES = ["files", "legacy-derived"] as const;
export type SecretsMode = (typeof SECRETS_MODES)[number];
/** The mode of a process that was told nothing: per-service files. */
export const SECRETS_MODE_DEFAULT: SecretsMode = "files";
export const SECRETS_MODE_ENV = "MEMORY_SECRETS_MODE";
/** Minimum length of a free-text secret file (role passwords, app-derive-key) in the files mode. */
export const SECRET_FILE_MIN_BYTES = 16;
/** Database roles of the gateway process and of its one-off jobs (run-visibility-check, run-derivation-check). */
export const GATEWAY_DB_ROLES = ["memory_gateway", "memory_audit_reader"] as const;
/** Database roles of the workers process and of its one-off jobs (run-job, prompt-lab): memory_audit_reader reads the log. */
export const WORKER_DB_ROLES = ["memory_worker", "memory_audit_maint", "memory_audit_reader"] as const;

/** A secrets configuration the process must not start with. The message names variables and files, never values. */
export class SecretsConfigError extends Error {
  constructor(message: string) { super(message); this.name = "SecretsConfigError"; }
}

const VALUE_SHOWN_MAX = 40;
export const secretsModeUnknownMessage = (value: string): string =>
  `${SECRETS_MODE_ENV} has the unknown value "${value.length > VALUE_SHOWN_MAX ? `${value.slice(0, VALUE_SHOWN_MAX)}…` : value}". `
  + `Accepted values: ${SECRETS_MODES.join(", ")}. Leave the variable unset for per-service secret files (${SECRETS_MODE_DEFAULT}).`;
export const PG_APP_PASSWORD_REFUSED = "PG_APP_PASSWORD is set, but MEMORY_SECRETS_MODE is not legacy-derived. By default every service reads "
  + "its own secret files from its credentials directory (CREDENTIALS_DIRECTORY) and nothing is derived from one shared secret. Remove "
  + "PG_APP_PASSWORD from the environment of the service, or set MEMORY_SECRETS_MODE=legacy-derived to keep deriving role passwords and keys from it.";
const DERIVE_HINT = "Deriving keys from PG_APP_PASSWORD needs MEMORY_SECRETS_MODE=legacy-derived.";
export const appDeriveKeyMissingMessage = (dirSet: boolean): string => dirSet
  ? `No application key: the file ${APP_DERIVE_KEY} is missing from the credentials directory of this service (CREDENTIALS_DIRECTORY). ${DERIVE_HINT}`
  : `No application key: CREDENTIALS_DIRECTORY is not set, so the file ${APP_DERIVE_KEY} cannot be read. ${DERIVE_HINT}`;

/** Mode from the raw value of the variable: unset or empty — the default; spaces around are ignored; anything else must match exactly. */
export function parseSecretsMode(raw: string | undefined | null): SecretsMode {
  const v = (raw ?? "").trim();
  if (!v) return SECRETS_MODE_DEFAULT;
  if ((SECRETS_MODES as readonly string[]).includes(v)) return v as SecretsMode;
  throw new SecretsConfigError(secretsModeUnknownMessage(v));
}

/** The secrets mode of this process (MEMORY_SECRETS_MODE); an unknown value throws SecretsConfigError. */
export function secretsMode(): SecretsMode {
  return parseSecretsMode(process.env.MEMORY_SECRETS_MODE);
}

/** File name of the root of the derived keys, written by the secrets step of the installation. */
export const APP_DERIVE_KEY = "app-derive-key";
export const LINK_KEY_PREFIX = "link-signing-key-";
export const LINK_SWITCH_AT = "link-switch-at";
export const LINK_LEGACY_RETIRED = "link-legacy-retired";

const isSocketHost = (host: string): boolean => host.startsWith("/");

export function passwordFor(env: Pick<Env, "appSecret" | "pgAppPassword" | "pgHost"> & Partial<Pick<Env, "secretsMode">>, role: string): string | undefined {
  const file = readCredentialText(`pg-${role}`);
  if (file !== null) return file;
  const legacy = "pgAppPassword" in env ? env.pgAppPassword ?? null : env.appSecret;
  if (legacy) return derivePassword(legacy, role);
  if (isSocketHost(env.pgHost)) return undefined;
  // files mode: English, and no advice to set PG_APP_PASSWORD — this mode refuses it
  if ((env.secretsMode ?? secretsMode()) === "files") {
    throw new SecretsConfigError(`No password for the database role ${role}: the file pg-${role} is missing from the credentials directory of this service (CREDENTIALS_DIRECTORY).`);
  }
  throw new Error(`password missing for role ${role}: the service credentials directory has no pg-${role} file and PG_APP_PASSWORD is not set`);
}

export interface LinkKeys {
  sign: { version: string; key: Buffer } | null;
  verify: Buffer[];
  switchAt?: number | null;
  legacyRetired?: boolean;
}

export function parseSwitchAt(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim();
  if (!/^[0-9]{9,11}$/.test(t)) throw new Error(`credentials: ${LINK_SWITCH_AT} is not a Unix timestamp in seconds`);
  return Number(t);
}

export function readLinkKeys(files: Map<string, Buffer> = readCredentialSet(LINK_KEY_PREFIX, { minBytes: 32 }),
                             marks: { switchAt?: string | null; retired?: boolean } = {
                               switchAt: readCredentialText(LINK_SWITCH_AT), retired: readCredential(LINK_LEGACY_RETIRED) !== null }): LinkKeys {
  const versions = [...files.keys()].filter((v) => /^[0-9]{1,6}$/.test(v)).sort((a, b) => Number(b) - Number(a));
  if (versions.length !== files.size) throw new Error(`credentials: ${LINK_KEY_PREFIX}<n> has a nonnumeric version number`);
  const latest = latestVersion(files);
  return {
    sign: latest === null ? null : { version: latest, key: files.get(latest)! },
    verify: versions.slice(0, 2).map((v) => files.get(v)!),
    switchAt: parseSwitchAt(marks.switchAt ?? null),
    legacyRetired: marks.retired === true,
  };
}

export interface ServiceSecrets {
  pgPassword(role: string): string | undefined;
  settingsKeyring: SettingsKeyring;
  despiteKeys: DespiteKeys;
  linkKeys: LinkKeys;
  legacy: string[];
}

export function loadServiceSecrets(env: Pick<Env, "appSecret" | "pgAppPassword" | "pgHost" | "secretsMode">, roles: readonly string[] = []): ServiceSecrets {
  const mode = env.secretsMode ?? secretsMode();
  if (mode === "files") {
    if (env.pgAppPassword) throw new SecretsConfigError(PG_APP_PASSWORD_REFUSED);
    const problem = fileModeProblems(roles, env.pgHost);
    if (problem) throw new SecretsConfigError(problem);
  }
  const legacy: string[] = [];
  // files: a role without a file is refused over TCP above; over the unix socket it logs in by peer — nothing is derived
  if (mode === "legacy-derived") for (const r of roles) if (readCredentialText(`pg-${r}`) === null) legacy.push(`pg-${r}`);
  const keyring = settingsKeyring({ appSecret: env.appSecret });
  if (!keyring.current.kid.startsWith("cred-")) legacy.push("settings-key");
  const despiteFile = readCredential(DESPITE_KEYS_FILE, { minBytes: 32 });
  if (!despiteFile) legacy.push(DESPITE_KEYS_FILE);
  const linkKeys = readLinkKeys();
  if (!linkKeys.sign) legacy.push("link-signing-key");
  if (env.pgAppPassword) legacy.push("PG_APP_PASSWORD");
  else if (mode === "legacy-derived" && "pgAppPassword" in env && env.appSecret) legacy.push(APP_DERIVE_KEY);
  const despite = despiteKeysFrom({ credential: despiteFile, appSecret: env.appSecret });
  if (!despite) throw new Error(`keys are missing: neither the ${DESPITE_KEYS_FILE} file nor an application secret is available`);
  return {
    pgPassword: (role) => passwordFor(env, role),
    settingsKeyring: keyring,
    despiteKeys: despite,
    linkKeys,
    legacy,
  };
}

// ---------------------------------------------------------------- files mode: what the start requires
/** Name of the install code file of the gateway (packages/gateway/src/first-run-code.ts): compared with the other secrets. */
const FIRST_RUN_CODE_NAME = "first-run-code";
/** Files that hold secrets of a process; only these are compared for equal values (marks such as link-switch-at and the
 *  empty pg-app-password left after the secrets move are not secrets of the process). */
const isSecretFile = (name: string): boolean =>
  (name.startsWith("pg-") && name !== "pg-app-password") || name.startsWith(SETTINGS_KEY_PREFIX) || name.startsWith(LINK_KEY_PREFIX)
  || name === DESPITE_KEYS_FILE || name === APP_DERIVE_KEY || name === FIRST_RUN_CODE_NAME;
const SHORT = `shorter than ${SECRET_FILE_MIN_BYTES} bytes`;
const problemMessage = (parts: string[]): string => `Secret files of this service cannot be used (secrets mode files): ${parts.join("; ")}. `
  + "Each secret is its own random value in the credentials directory of the service (CREDENTIALS_DIRECTORY).";
/** Value of a file without trailing line breaks, byte for byte (keys may be raw bytes). */
const fileValue = (b: Buffer): string => b.toString("latin1").replace(/[\r\n]+$/, "");
const VERSION = /^[0-9]{1,6}$/;
/**
 * Key files whose shape the later readers (settingsKeyring, readLinkKeys, parseDespiteKeys) would refuse with the old
 * messages of the legacy path: here they are named in English, before any of those readers runs.
 */
function keyFormatProblems(name: string, raw: Buffer): string[] {
  if (name.startsWith(SETTINGS_KEY_PREFIX) && name.length > SETTINGS_KEY_PREFIX.length) {
    if (!VERSION.test(name.slice(SETTINGS_KEY_PREFIX.length))) return [`not a numbered version: ${name}`];
    return parseKey32(raw) ? [] : [`not a 32-byte key: ${name}`];
  }
  if (name.startsWith(LINK_KEY_PREFIX) && name.length > LINK_KEY_PREFIX.length) {
    if (!VERSION.test(name.slice(LINK_KEY_PREFIX.length))) return [`not a numbered version: ${name}`];
    return raw.length < 32 ? [`shorter than 32 bytes: ${name}`] : [];
  }
  if (name === DESPITE_KEYS_FILE) {
    try { parseDespiteKeys(raw); return []; } catch { return [`not JSON {print, token} of two 32-byte base64 keys: ${name}`]; }
  }
  return [];
}

/** app-derive-key of the files mode for readEnv(): missing, unreadable or short — SecretsConfigError with the file name. */
export function appDeriveKeyFromFile(): string {
  if (!credentialsDir()) throw new SecretsConfigError(appDeriveKeyMissingMessage(false));
  let text: string | null;
  try { text = readCredentialText(APP_DERIVE_KEY); } catch { throw new SecretsConfigError(problemMessage([`empty or unreadable: ${APP_DERIVE_KEY}`])); }
  if (text === null) throw new SecretsConfigError(appDeriveKeyMissingMessage(true));
  if (Buffer.byteLength(text, "utf8") < SECRET_FILE_MIN_BYTES) throw new SecretsConfigError(problemMessage([`${SHORT}: ${APP_DERIVE_KEY}`]));
  return text;
}

/**
 * What stops the start of a process in the files mode, as one message with file names only (null — nothing): a required
 * file missing (pg-<role> of every role over TCP, settings-key-<n>, despite-keys, app-derive-key), a free-text secret shorter
 * than 16 bytes, an empty or unreadable secret file, two secret files of the directory with the same value.
 */
export function fileModeProblems(roles: readonly string[], pgHost: string): string | null {
  if (!credentialsDir()) return problemMessage(["CREDENTIALS_DIRECTORY is not set"]);
  let names: string[];
  try { names = credentialNames(); } catch { return problemMessage(["the credentials directory cannot be read"]); }
  const missing: string[] = [], short: string[] = [], broken: string[] = [], format: string[] = [];
  const values = new Map<string, string>();
  for (const name of names.filter(isSecretFile)) {
    let raw: Buffer | null;
    try { raw = readCredential(name); } catch { broken.push(name); continue; }
    if (raw === null) continue;
    values.set(name, fileValue(raw));
    format.push(...keyFormatProblems(name, raw));
  }
  const has = (name: string): boolean => values.has(name) || broken.includes(name);
  const textOf = (name: string): void => {
    const v = values.get(name);
    if (v !== undefined && Buffer.byteLength(v, "latin1") < SECRET_FILE_MIN_BYTES) short.push(name);
  };
  for (const r of roles) {
    const name = `pg-${r}`;
    if (!has(name)) { if (!isSocketHost(pgHost)) missing.push(name); } else textOf(name);
  }
  if (![...values.keys(), ...broken].some((n) => n.startsWith(SETTINGS_KEY_PREFIX) && n.length > SETTINGS_KEY_PREFIX.length)) missing.push(`${SETTINGS_KEY_PREFIX}<n>`);
  if (!has(DESPITE_KEYS_FILE)) missing.push(DESPITE_KEYS_FILE);
  if (!has(APP_DERIVE_KEY)) missing.push(APP_DERIVE_KEY); else textOf(APP_DERIVE_KEY);
  const byValue = new Map<string, string[]>();
  for (const [name, v] of values) byValue.set(v, [...(byValue.get(v) ?? []), name]);
  const parts: string[] = [];
  if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
  if (short.length) parts.push(`${SHORT}: ${short.join(", ")}`);
  if (broken.length) parts.push(`empty or unreadable: ${broken.join(", ")}`);
  parts.push(...format);
  // the link switch mark is no secret, but its reader (parseSwitchAt) would refuse a bad one with the old Russian text of
  // the legacy path (final): named here in English first
  if (names.includes(LINK_SWITCH_AT)) {
    let text: string | null = null;
    try { text = readCredentialText(LINK_SWITCH_AT); } catch { text = ""; }
    if (text !== null && !/^[0-9]{9,11}$/.test(text.trim())) parts.push(`not a time in Unix seconds: ${LINK_SWITCH_AT}`);
  }
  for (const names of byValue.values()) if (names.length > 1) parts.push(`the same value in: ${names.sort().join(", ")}`);
  return parts.length ? problemMessage(parts) : null;
}
