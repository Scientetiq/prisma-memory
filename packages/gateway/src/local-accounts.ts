import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashApiKey } from "@memory/shared";
import type pg from "pg";

// The work factors carried by each scrypt record.
export interface LocalScrypt { N: number; r: number; p: number }
// The work factors for new records and unknown accounts.
export const LOCAL_SCRYPT: LocalScrypt = { N: 2 ** 17, r: 8, p: 1 };
Object.freeze(LOCAL_SCRYPT);
// The number of scrypt runs at once: the start setting MEMORY_SCRYPT_PARALLEL, 1 or 2 (unset or empty means 2).
export function scryptParallelOf(raw: string | undefined): 1 | 2 | null {
  if (raw === undefined || raw === "" || raw === "2") return 2;
  return raw === "1" ? 1 : null;
}
// At most this many local-account jobs occupy the libuv pool at once (an invalid setting stops the gateway at start).
export const SCRYPT_PARALLEL: 1 | 2 = scryptParallelOf(process.env.MEMORY_SCRYPT_PARALLEL) ?? 1;
// One run of the default record needs 128 MiB; the rest of the gateway is budgeted at 192 MiB.
export const SCRYPT_RUN_MIB = 128, GATEWAY_BASE_MIB = 192;

// Why the gateway must not start with this setting under this memory limit in bytes, or null.
export function scryptStartProblem(raw: string | undefined, limitBytes: number | null): string | null {
  const n = scryptParallelOf(raw);
  if (n === null) return "MEMORY_SCRYPT_PARALLEL must be 1 or 2 (unset means 2)";
  const need = n * SCRYPT_RUN_MIB + GATEWAY_BASE_MIB;
  if (limitBytes === null || need * 2 ** 20 <= limitBytes) return null;
  return `MEMORY_SCRYPT_PARALLEL=${n} needs ${need} MiB (${n} x ${SCRYPT_RUN_MIB} MiB for the password hashes of local accounts and ${GATEWAY_BASE_MIB} MiB for the rest of the gateway), but the gateway's memory limit is ${Math.floor(limitBytes / 2 ** 20)} MiB: set MEMORY_SCRYPT_PARALLEL=1 or raise MEMORY_MEM_GATEWAY`;
}

// The memory limit of this process's cgroup in bytes (v2, then v1), or null when there is none or it cannot be read.
export function cgroupMemoryLimit(read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let text: string;
    try {
      text = read(path).trim();
    } catch {
      continue;
    }
    if (text === "max" || !/^[0-9]{1,19}$/.test(text)) return null;
    const bytes = Number(text);
    return bytes >= 2 ** 60 ? null : bytes;
  }
  return null;
}
// At most 32 additional jobs wait for a slot.
export const SCRYPT_WAITING_MAX = 32;
// A job that cannot enter the queue rejects with this class.
export class LocalAccountsBusy extends Error {}
// Password length bounds in code points.
export const PASSWORD_MIN = 12, PASSWORD_MAX = 1024;
// The rule that rejected a proposed password.
export type PasswordProblem = "too_short" | "too_long" | "same_as_login" | "one_character" | "common";
// The link kinds this module may issue or consume.
export type LinkKind = "invite" | "reset";
// The prefix included in every local-account link and its digest.
export const LINK_PREFIX = "mem_lnk_";
// Default and maximum lifetimes in seconds.
export const LINK_TTL_SEC: Record<LinkKind, number> = { invite: 72 * 3600, reset: 3600 };
Object.freeze(LINK_TTL_SEC);

// Database statements run through the caller's transaction client.
type Q = Pick<pg.PoolClient, "query">;

const COMMON_PASSWORDS: ReadonlySet<string> = Object.freeze(new Set([
  "password1234",
  "password12345",
  "passwordpassword",
  "passw0rd1234",
  "123456789012",
  "1234567890123",
  "123123123123",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "zaq12wsx3edc",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwerty123456",
  "qwertyuiopas",
  "qazwsxedcrfv",
  "administrator",
  "administrator1",
  "letmeinletmein",
  "welcome12345",
  "changeme1234",
  "iloveyou1234",
  "abcdefghijkl",
  "abcdefgh1234",
  "abcd1234abcd",
  "trustno1trustno1",
]));

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const DUMMY_RECORD = { params: LOCAL_SCRYPT, salt: Buffer.alloc(SALT_BYTES), hash: Buffer.alloc(HASH_BYTES) };
const RECORD = /^scrypt\$([1-9][0-9]{0,6})\$([1-9][0-9]?)\$([1-9])\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/;
const waiting: Array<() => void> = [];
let running = 0;
let runs = 0;

function validScrypt({ N, r, p }: LocalScrypt): boolean {
  return Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 20 && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 32 &&
    Number.isInteger(p) && p >= 1 && p <= 4 &&
    // scrypt also bounds N relative to the block size.
    N < 2 ** (16 * r) &&
    // One run needs 128 * N * r bytes: never more than the default record's 128 MiB, nor more than twice its work.
    N * r <= 2 ** 20 && N * r * p <= 2 ** 21;
}

function readRecord(stored: string): typeof DUMMY_RECORD | null {
  const fields = RECORD.exec(stored);
  if (!fields) return null;
  const [, N, r, p, salt64, hash64] = fields;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!validScrypt(params)) return null;
  const salt = Buffer.from(salt64, "base64");
  const hash = Buffer.from(hash64, "base64");
  if (salt.toString("base64") !== salt64 || hash.toString("base64") !== hash64) return null;
  return { params, salt, hash };
}

function runScrypt(plain: string, salt: Buffer, { N, r, p }: LocalScrypt): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (waiting.length === SCRYPT_WAITING_MAX) {
      reject(new LocalAccountsBusy());
      return;
    }
    const start = () => {
      running++;
      runs++;
      const work = new Promise<Buffer>((done, fail) => {
        const maxmem = 256 * N * r + 32 * 1024 * 1024;
        scrypt(plain, salt, HASH_BYTES, { N, r, p, maxmem }, (error, key) => {
          if (error) fail(error);
          else done(key);
        });
      });
      void work.finally(() => {
        running--;
        waiting.shift()?.();
      }).then(resolve, reject);
    };
    if (running < SCRYPT_PARALLEL) start();
    else waiting.push(start);
  });
}

// Check a proposed password before asking for a hash.
export function passwordProblem(plain: string, login: string): PasswordProblem | null {
  if (plain.length > 2 * PASSWORD_MAX) return "too_long";
  const characters = [...plain];
  if (characters.length < PASSWORD_MIN) return "too_short";
  if (characters.length > PASSWORD_MAX) return "too_long";
  const passwordLower = plain.toLowerCase();
  const loginLower = login.toLowerCase();
  if (passwordLower === loginLower || passwordLower === loginLower.split("@", 1)[0]) return "same_as_login";
  if (characters.every((character) => character === characters[0])) return "one_character";
  if (COMMON_PASSWORDS.has(passwordLower)) return "common";
  return null;
}

// Encode an asynchronous scrypt run with a fresh salt and bounded work factors.
export function hashLocalPassword(plain: string, params?: LocalScrypt): Promise<string> {
  if (plain.length > 2 * PASSWORD_MAX) return Promise.reject(new RangeError("the password is longer than 2048 UTF-16 code units"));
  const { N, r, p } = params ?? LOCAL_SCRYPT;
  const kdf = { N, r, p };
  if (!validScrypt(kdf)) return Promise.reject(new RangeError());
  const salt = randomBytes(SALT_BYTES);
  return runScrypt(plain, salt, kdf).then((hash) =>
    ["scrypt", N, r, p, salt.toString("base64"), hash.toString("base64")].join("$"),
  );
}

// Reject an over-long value and malformed records before scrypt, and do one current-cost run for an unknown account.
export function verifyLocalPassword(plain: string, stored: string | null): Promise<boolean> {
  // The length is not secret: an over-long value is no match for every account, known or unknown, without a run.
  if (plain.length > 2 * PASSWORD_MAX) return Promise.resolve(false);
  const record = stored === null ? DUMMY_RECORD : readRecord(stored);
  if (!record) return Promise.resolve(false);
  return runScrypt(plain, record.salt, record.params).then((hash) =>
    timingSafeEqual(hash, record.hash) && stored !== null,
  );
}

// Report occupied slots, queued jobs and jobs started in this process.
export function scryptStats(): { running: number; waiting: number; runs: number } {
  return { running, waiting: waiting.length, runs };
}

// Hash the whole link only if the prefix, length and alphabet match.
export function linkHash(plain: string): Buffer | null {
  if (plain.length !== LINK_PREFIX.length + 43 || !plain.startsWith(LINK_PREFIX)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(plain.slice(LINK_PREFIX.length))) return null;
  return hashApiKey(plain);
}

// Replace existing live local-account links in the caller's transaction.
export function issueLink(q: Q, o: { instanceId: string; personId: string; kind: LinkKind; issuedBy: string | null; ttlSec?: number }): Promise<{ id: string; plain: string; expiresAt: string }>;
export async function issueLink(q: Q, o: { instanceId: string; personId: string; kind: LinkKind; issuedBy: string | null; ttlSec?: number }): Promise<{ id: string; plain: string; expiresAt: string }> {
  const maxTtlSec = LINK_TTL_SEC[o.kind];
  const ttlSec = Math.max(60, Math.min(o.ttlSec ?? maxTtlSec, maxTtlSec));
  // Serialize issuers before UPDATE takes a fresh snapshot. An older transaction snapshot could miss the preceding insert.
  const lock = await q.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('local-accounts:' || $1::text || ':' || $2::uuid::text, 0))
     WHERE current_setting('transaction_isolation') IN ('read committed', 'read uncommitted')`,
    [o.instanceId, o.personId],
  );
  if (lock.rowCount !== 1) throw new Error("issueLink needs the isolation level read committed");
  const plain = LINK_PREFIX + randomBytes(32).toString("base64url");
  // Keep both writes in one command so calls on the same client cannot interleave them.
  const { rows } = await q.query<{ id: string; expires_at: Date }>(
    `WITH revoked AS (
       UPDATE auth_links SET revoked_at = now()
       WHERE instance_id = $1 AND person_id = $2 AND kind IN ('invite', 'reset')
         AND used_at IS NULL AND revoked_at IS NULL
       RETURNING revoked_at
     )
     INSERT INTO auth_links (instance_id, person_id, kind, issued_by, token_hash, expires_at)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(revoked_at), now()) + make_interval(secs => $6::double precision)
     FROM revoked
     RETURNING id, expires_at`,
    [o.instanceId, o.personId, o.kind, o.issuedBy, hashApiKey(plain), ttlSec],
  );
  return { id: rows[0].id, plain, expiresAt: rows[0].expires_at.toISOString() };
}

// The conditions of a live local-account link, the same for reading it and for taking it.
const LIVE_LINK = `token_hash = $1 AND instance_id = $2 AND kind IN ('invite', 'reset') AND person_id IS NOT NULL
       AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;

// Read a live local-account link without taking it.
export function peekLink(q: Q, instanceId: string, plain: string): Promise<{ id: string; personId: string; kind: LinkKind } | null> {
  const hash = linkHash(plain);
  if (!hash) return Promise.resolve(null);
  return q.query<{ id: string; personId: string; kind: LinkKind }>(
    `SELECT id, person_id AS "personId", kind FROM auth_links
     WHERE ${LIVE_LINK}`,
    [hash, instanceId],
  ).then(({ rows }) => rows[0] ?? null);
}

// One database update takes a live local-account link at most once.
export function consumeLink(q: Q, instanceId: string, plain: string): Promise<{ id: string; personId: string; kind: LinkKind } | null> {
  const hash = linkHash(plain);
  if (!hash) return Promise.resolve(null);
  return q.query<{ id: string; personId: string; kind: LinkKind }>(
    `UPDATE auth_links SET used_at = now()
     WHERE ${LIVE_LINK}
     RETURNING id, person_id AS "personId", kind`,
    [hash, instanceId],
  ).then(({ rows }) => rows[0] ?? null);
}

// Insert a passwordless account unless the person already has one.
export function createCredential(q: Q, o: { instanceId: string; personId: string; createdBy: string }): Promise<boolean> {
  return q.query(
    `INSERT INTO local_credentials (instance_id, person_id, created_by)
     VALUES ($1, $2, $3) ON CONFLICT (person_id) DO NOTHING`,
    [o.instanceId, o.personId, o.createdBy],
  ).then(({ rowCount }) => rowCount === 1);
}

// Set the password and timestamp only on an enabled account in the instance.
export function setLocalPassword(q: Q, instanceId: string, personId: string, record: string): Promise<boolean> {
  return q.query(
    `UPDATE local_credentials SET password_hash = $3, password_set_at = now()
     WHERE instance_id = $1 AND person_id = $2 AND disabled_at IS NULL`,
    [instanceId, personId, record],
  ).then(({ rowCount }) => rowCount === 1);
}

// Clear both password fields only on an enabled account in the instance.
export function clearLocalPassword(q: Q, instanceId: string, personId: string): Promise<boolean> {
  return q.query(
    `UPDATE local_credentials SET password_hash = NULL, password_set_at = NULL
     WHERE instance_id = $1 AND person_id = $2 AND disabled_at IS NULL`,
    [instanceId, personId],
  ).then(({ rowCount }) => rowCount === 1);
}

// Find the one person and account of a name within the instance, including inactive or disabled status; two people whose names differ only in letter case find nobody.
export function findForSignIn(q: Q, instanceId: string, login: string): Promise<{ personId: string; record: string | null; disabled: boolean; active: boolean } | null> {
  return q.query<{ personId: string; record: string | null; disabled: boolean; active: boolean }>(
    `SELECT p.id AS "personId", c.password_hash AS record, c.disabled_at IS NOT NULL AS disabled, p.active
     FROM people p
     JOIN local_credentials c ON c.person_id = p.id AND c.instance_id = p.instance_id
     WHERE p.instance_id = $1 AND lower(p.login) = lower($2)
     LIMIT 2`,
    [instanceId, login],
  ).then(({ rows }) => (rows.length === 1 ? rows[0] : null));
}
