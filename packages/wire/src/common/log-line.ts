// The coded log line of the edge and the bridge: one JSON line with time, level, process, code and fields
// from a closed list of names. Shared by edge-core and the bridge (which may not use edge-core), so it is a leaf:
// here only the line is built; where to write it is the caller's choice.
//
// What does not pass:
//   - a field whose name is not in LOG_FIELDS (the line keeps only their count, dropped);
//   - a field named t, level, process, code, dropped: the line sets these keys itself, a field cannot replace them;
//   - a string that does not look like a code: spaces, Cyrillic, @ (mail, sign-in name), longer than 128;
//   - a string with a token or key prefix (edge_ac_, edge_at_, edge_rt_, mem_, v1.) and a string with a long run
//     of mixed base64url or hex characters (keys, tokens, hashes; a uuid is fine);
//   - nested objects, arrays, NaN and infinities.
export type LogLevel = "error" | "warn" | "info";
export type LogFields = Record<string, string | number | boolean | null>;

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_STRING = /^[A-Za-z0-9_.:/+-]{1,128}$/;
const SECRET_PREFIX = /^(edge_(ac|at|rt)_|mem_|v1\.)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN = /[A-Za-z0-9_-]{20,}/g;

/** Keys the log line sets itself: a field with such a name is dropped. */
export const RESERVED_LOG_KEYS = ["t", "level", "process", "code", "dropped"] as const;

/**
 * Names of fields that may be written to the edge and bridge log: numbers, codes and ids; no passwords, no tokens, no
 * sign-in names, no texts. A stage that needs a new field adds it to its own section (an empty line between
 * sections, so edits of different stages do not conflict).
 */
export const LOG_FIELDS: readonly string[] = [
  // [P0]
  "serial", "signers", "rejected", "count", "stage", "kid", "kind", "reason", "status", "ms", "bytes", "version",

  "tool", "outcome", "hits", "connection_id", "person_id", "error_code", "class", "ip_prefix", "record_id", "why", "age_ms",
  "theta_sec", "process", "problem", "key", "bound", "limit", "have", "want", "method", "file", "valid", "seen",
  // inner export services: reconciliation result, pending revocation, bridge service in alarm, restore from a copy
  "mode", "rows", "pending", "service", "tombstones", "holds",
  // bridge: call name, client certificate CN, number of items in a batch, server port
  "call", "cn", "items", "port",

  // codes of the edge processes from audit-codes.json (edge-core writes them as a log line)
  "seconds", "queue", "client_id", "step", "action",

  // [S2-3]

  // [4]

  // [5]
];

/** Whether a string looks like a code or an id, not like a secret, a mail address or a text. */
export function isSafeLogString(v: string): boolean {
  if (!SAFE_STRING.test(v) || SECRET_PREFIX.test(v)) return false;
  if (UUID.test(v)) return true;
  // A long run of mixed-case letters or letters with digits is a key, a token or a hash; a long lower-case code
  // («anchors_signature_rejected») is not one of them.
  for (const run of v.match(RUN) ?? []) if (/[a-z]/.test(run) && /[A-Z0-9]/.test(run)) return false;
  return true;
}

/** Field filter: name from LOG_FIELDS, value a number, boolean, null or safe string. The rest counts in dropped. */
export function safeLogFields(fields: Record<string, unknown> = {}): { fields: LogFields; dropped: number } {
  const out: LogFields = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    let ok = CODE.test(k) && !(RESERVED_LOG_KEYS as readonly string[]).includes(k) && LOG_FIELDS.includes(k);
    if (ok) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      else if (typeof v === "boolean" || v === null) out[k] = v;
      else if (typeof v === "string" && isSafeLogString(v)) out[k] = v;
      else ok = false;
    }
    if (!ok) dropped++;
  }
  return { fields: out, dropped };
}

/** The log line: the service keys first and only from the arguments; a code against the rule gives log_bad_code. */
export function logLine(proc: string, level: LogLevel, code: string, fields: Record<string, unknown> = {}, now: Date = new Date()): string {
  const { fields: safe, dropped } = safeLogFields(fields);
  const line: Record<string, unknown> = { t: now.toISOString(), level, process: proc, code: CODE.test(code) ? code : "log_bad_code" };
  for (const [k, v] of Object.entries(safe)) line[k] = v;
  if (dropped > 0) line.dropped = dropped;
  return JSON.stringify(line);
}
