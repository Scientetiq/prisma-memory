// Secrets of connectors: the table connector_secrets of the control database, encrypted with the settings
// keyring exactly as secret settings are ({"ct","iv"} of AES-256-GCM, no associated data, enc_kid beside the value), so a
// setting's ciphertext can be copied into a connector secret as it is. The gateway writes (admin API); the workers only
// read (the database grants memory_worker SELECT). The package has no database driver of its own: the caller passes
// anything with a pg-like query().
//
// Values never leave this module except through LoadedSecrets.get/candidates: errors carry a code and the secret's name,
// the loaded object keeps the values in a closure (JSON.stringify and util.inspect show nothing of them), and the
// fingerprint the admin API returns is keyed, so the audit journal cannot be used to guess a weak secret.
import { createHmac } from "node:crypto";
import { decryptWithKey, encryptWithKey, type EncryptedValue, type SettingsKeyring } from "@memory/shared/crypto";
import { markCore } from "./failure.ts";

/** Anything that runs a parameterised query (pg.Pool, pg.Client, a transaction client). */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** Name of a secret: the CHECK connector_secrets_name_check of the table. */
export const SECRET_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const SECRET_MAX_CHARS = 8192;
/** Longest overlap of a rotation: the previous value stays valid for at most seven days. */
export const ROTATE_OVERLAP_MAX_SEC = 604_800;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ConnectorSecretCode = "secret_unreadable" | "secret_invalid";

/** A secret that cannot be read (key missing, ciphertext damaged) or a refused write; the message is `<code>: <name>`. */
export class ConnectorSecretError extends Error {
  readonly code: ConnectorSecretCode;
  /** The secret's name when it is a valid name, otherwise "invalid". */
  readonly secret: string;
  /**
   * Why a write was refused, when the store knows a reason of its own; null otherwise. Since the store gives no
   * reason of its own (`over_budget` of is not produced: an over-budget value is stored, its run's diagnostics close).
   */
  readonly reason: SecretRefusal | null;
  constructor(code: ConnectorSecretCode, name: unknown, reason: SecretRefusal | null = null) {
    const secret = typeof name === "string" && SECRET_NAME.test(name) ? name : "invalid";
    super(`${code}: ${secret}`);
    this.name = "ConnectorSecretError";
    this.code = code;
    this.secret = secret;
    this.reason = reason === "over_budget" ? "over_budget" : null;
  }
}
export type SecretRefusal = "over_budget";
/** A ConnectorSecretError built by the secret store itself: marked as the core's. */
const secretError = (code: ConnectorSecretCode, name: unknown, reason: SecretRefusal | null = null): ConnectorSecretError =>
  markCore(new ConnectorSecretError(code, name, reason), code);

export interface StoredSecret {
  readonly enc_kid: string;
  readonly value: EncryptedValue;
}

export interface LoadedSecrets {
  /** The current value; null when the secret is not set; throws secret_unreadable when it is set but cannot be read. */
  get(name: string): string | null;
  /** Values to accept (webhook verification): the current one, then the previous one while its overlap lasts. */
  candidates(name: string): string[];
  /** Names of the secrets that are set (readable or not), sorted. */
  names(): string[];
  /** Names of the secrets whose current value cannot be read, sorted. */
  unreadable(): string[];
  stored(name: string): StoredSecret | null;
}

const isCiphertext = (v: unknown): v is EncryptedValue =>
  v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as EncryptedValue).ct === "string" && typeof (v as EncryptedValue).iv === "string";

/** The plaintext of one stored value, or null when it cannot be read (no key of that kid, damaged, not a string). */
function open(keyring: SettingsKeyring, kid: unknown, value: unknown): string | null {
  if (typeof kid !== "string" || !isCiphertext(value)) return null;
  const key = keyring.byKid(kid);
  if (!key) return null;
  try {
    const plain = decryptWithKey(key, value);
    return typeof plain === "string" ? plain : null;
  } catch {
    return null;   // the error of the cipher says nothing useful and must not travel
  }
}

function checkId(connectorId: unknown, name: unknown): void {
  if (typeof connectorId !== "string" || !UUID.test(connectorId)) throw secretError("secret_invalid", name);
  if (typeof name !== "string" || !SECRET_NAME.test(name)) throw secretError("secret_invalid", name);
}

// Validate new values only; stored secrets remain readable. Tab, LF and CR are allowed for multiline credentials.
function checkValue(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > SECRET_MAX_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw secretError("secret_invalid", name);
  // no refusal by the redaction budget here (it refused an RSA-2048 PEM and longer): a run whose secret its
  // redactor cannot cover takes the closed redactor (createRedactor), so every diagnostic line of that run is the
  // constant refusal and the value reaches no log line
}

/**
 * Reads all secrets of one connector. The previous value counts only while prev_until is in the future by the
 * DATABASE clock (one statement), so a service with a wrong clock cannot extend an overlap.
 */
export async function loadConnectorSecrets(q: Queryable, keyring: SettingsKeyring, connectorId: string): Promise<LoadedSecrets> {
  if (typeof connectorId !== "string" || !UUID.test(connectorId)) throw secretError("secret_invalid", null);
  const { rows } = await q.query(
    "SELECT name, value, enc_kid, CASE WHEN prev_until > now() THEN prev_value END AS prev_value, "
    + "CASE WHEN prev_until > now() THEN prev_enc_kid END AS prev_enc_kid FROM connector_secrets WHERE connector_id = $1",
    [connectorId]);
  const current = new Map<string, string>();
  const previous = new Map<string, string>();
  const bad = new Set<string>();
  const stored = new Map<string, StoredSecret>();
  for (const r of rows as Array<{ name: unknown; value: unknown; enc_kid: unknown; prev_value: unknown; prev_enc_kid: unknown }>) {
    if (typeof r.name !== "string") continue;
    if (typeof r.enc_kid === "string") stored.set(r.name, { enc_kid: r.enc_kid, value: r.value as EncryptedValue });
    const v = open(keyring, r.enc_kid, r.value);
    if (v === null) bad.add(r.name); else current.set(r.name, v);
    // an unreadable previous value is simply absent: it could only widen what is accepted
    if (r.prev_value !== null && r.prev_value !== undefined) {
      const p = open(keyring, r.prev_enc_kid, r.prev_value);
      if (p !== null) previous.set(r.name, p);
    }
  }
  const names = [...new Set([...current.keys(), ...bad])].sort();
  const loaded: LoadedSecrets = {
    get(name) {
      if (bad.has(name)) throw secretError("secret_unreadable", name);
      return current.get(name) ?? null;
    },
    candidates(name) {
      if (bad.has(name)) throw secretError("secret_unreadable", name);
      const out: string[] = [];
      const c = current.get(name), p = previous.get(name);
      if (c !== undefined) out.push(c);
      if (p !== undefined && p !== c) out.push(p);
      return out;
    },
    names: () => [...names],
    unreadable: () => [...bad].sort(),
    stored(name) {
      const row = stored.get(name);
      return row ? structuredClone(row) : null;
    },
  };
  // the values live in the closures above; serialising or inspecting the object shows none of them
  Object.defineProperty(loaded, "toJSON", { value: () => ({}), enumerable: false });
  return loaded;
}

const UPSERT = "INSERT INTO connector_secrets (connector_id, name, enc_kid, value) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (connector_id, name) DO UPDATE SET ";

/** Sets a secret (a replaced vendor key: no overlap, any previous value is dropped). Returns the keyed fingerprint. */
export async function setConnectorSecret(q: Queryable, keyring: SettingsKeyring, connectorId: string, name: string, value: string): Promise<{ fingerprint: string }> {
  checkId(connectorId, name);
  checkValue(name, value);
  const { kid, key } = keyring.current;
  await q.query(
    `${UPSERT}value = EXCLUDED.value, enc_kid = EXCLUDED.enc_kid, prev_value = NULL, prev_enc_kid = NULL, prev_until = NULL, updated_at = now()`,
    [connectorId, name, kid, JSON.stringify(encryptWithKey(key, value))]);
  return { fingerprint: secretFingerprint(keyring, value) };
}

export async function replaceConnectorSecretIf(q: Queryable, keyring: SettingsKeyring, connectorId: string, name: string,
                                               value: string, expected: StoredSecret): Promise<boolean> {
  return (await replaceConnectorSecretIfAndGet(q, keyring, connectorId, name, value, expected)) !== null;
}

export async function replaceConnectorSecretIfAndGet(q: Queryable, keyring: SettingsKeyring, connectorId: string, name: string,
                                                     value: string, expected: StoredSecret): Promise<StoredSecret | null> {
  checkId(connectorId, name);
  checkValue(name, value);
  const { kid, key } = keyring.current;
  const stored = { enc_kid: kid, value: encryptWithKey(key, value) };
  const { rowCount } = await q.query(
    "UPDATE connector_secrets SET enc_kid = $3, value = $4::jsonb, prev_value = NULL, prev_enc_kid = NULL, "
    + "prev_until = NULL, updated_at = now() WHERE connector_id = $1 AND name = $2 AND value = $5::jsonb AND enc_kid = $6",
    [connectorId, name, stored.enc_kid, JSON.stringify(stored.value), JSON.stringify(expected.value), expected.enc_kid],
  );
  return rowCount === 1 ? stored : null;
}

/**
 * Rotates a secret in one statement (two concurrent rotations cannot lose the row): the current value becomes the
 * previous one for overlapSec seconds (0 — no overlap). Only one previous value exists: a second rotation inside the
 * window ends the oldest value at once.
 */
export async function rotateConnectorSecret(q: Queryable, keyring: SettingsKeyring, connectorId: string, name: string, value: string,
                                            overlapSec: number): Promise<{ fingerprint: string }> {
  checkId(connectorId, name);
  checkValue(name, value);
  if (!Number.isSafeInteger(overlapSec) || overlapSec < 0 || overlapSec > ROTATE_OVERLAP_MAX_SEC) throw secretError("secret_invalid", name);
  const { kid, key } = keyring.current;
  const enc = JSON.stringify(encryptWithKey(key, value));
  if (overlapSec === 0) {
    await q.query(
      `${UPSERT}value = EXCLUDED.value, enc_kid = EXCLUDED.enc_kid, prev_value = NULL, prev_enc_kid = NULL, prev_until = NULL, updated_at = now()`,
      [connectorId, name, kid, enc]);
  } else {
    await q.query(
      `${UPSERT}prev_value = connector_secrets.value, prev_enc_kid = connector_secrets.enc_kid, prev_until = now() + make_interval(secs => $5::integer), `
      + "value = EXCLUDED.value, enc_kid = EXCLUDED.enc_kid, updated_at = now()",
      [connectorId, name, kid, enc, overlapSec]);
  }
  return { fingerprint: secretFingerprint(keyring, value) };
}

/** Deletes a secret; true when it existed. */
export async function deleteConnectorSecret(q: Queryable, connectorId: string, name: string): Promise<boolean> {
  checkId(connectorId, name);
  const r = await q.query("DELETE FROM connector_secrets WHERE connector_id = $1 AND name = $2", [connectorId, name]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteConnectorSecretIf(q: Queryable, connectorId: string, name: string, expected: StoredSecret): Promise<boolean> {
  checkId(connectorId, name);
  const { rowCount } = await q.query(
    "DELETE FROM connector_secrets WHERE connector_id = $1 AND name = $2 AND value = $3::jsonb AND enc_kid = $4",
    [connectorId, name, JSON.stringify(expected.value), expected.enc_kid],
  );
  return rowCount === 1;
}

/**
 * A keyed fingerprint of a secret value for the admin API and the audit journal: "fp:<kid>:<16 hex>" of
 * HMAC-SHA256 under the current settings key. Without the key it cannot be used to test guesses; two fingerprints are
 * comparable only under the same key id (after a key rotation the same value gets another fingerprint).
 */
export function secretFingerprint(keyring: SettingsKeyring, value: string): string {
  const mac = createHmac("sha256", keyring.current.key).update("connector-secret-fingerprint\u0000", "utf8");
  // Well-formed text is hashed exactly as before, so the fingerprint of every value a row already stores never
  // changes. A value that is not well-formed text (it holds a lone surrogate) would otherwise share the UTF-8 bytes
  // of the replacement character, so it is hashed with every lone surrogate kept as its own three-byte sequence.
  const utf8 = Buffer.from(value, "utf8");
  mac.update(utf8.toString("utf8") === value ? utf8 : loneSurrogateBytes(value));
  return `fp:${keyring.current.kid}:${mac.digest("hex").slice(0, 16)}`;
}

/** UTF-8 bytes of a value that is not well-formed text, with each lone surrogate as its own three-byte sequence. */
function loneSurrogateBytes(value: string): Buffer {
  const out = Buffer.alloc(value.length * 3);
  let n = 0;
  const put = (cp: number) => {
    if (cp < 0x80) out[n++] = cp;
    else if (cp < 0x800) { out[n++] = 0xc0 | (cp >> 6); out[n++] = 0x80 | (cp & 0x3f); }
    else if (cp < 0x10000) { out[n++] = 0xe0 | (cp >> 12); out[n++] = 0x80 | ((cp >> 6) & 0x3f); out[n++] = 0x80 | (cp & 0x3f); }
    else { out[n++] = 0xf0 | (cp >> 18); out[n++] = 0x80 | ((cp >> 12) & 0x3f); out[n++] = 0x80 | ((cp >> 6) & 0x3f); out[n++] = 0x80 | (cp & 0x3f); }
  };
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const d = value.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { put(0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)); i++; continue; }
    }
    put(c);
  }
  return out.subarray(0, n);
}
