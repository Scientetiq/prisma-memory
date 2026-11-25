// The class of an infrastructure failure for a log line (moves it here so that the shared modules — the
// audit outbox — use the same switch as @memory/connectors' failureClass, which adds the core's own marked codes on top).
// The class is chosen by the core's own switch on an own data property `code` of the error, read without a getter or a
// proxy trap: a PostgreSQL SQLSTATE (connection and shutdown → db_unavailable, serialization and deadlock → db_conflict,
// integrity → db_constraint, syntax / rights / data → db_refused, other → db_error), a Node network or timeout code, an
// abort. Anything else — and always the message, the name, the cause, the stack — is `internal`. The value is a literal
// of this module, never a string of the error.
import { types } from "node:util";

export const FAILURE_CLASSES = ["db_unavailable", "db_conflict", "db_constraint", "db_refused", "db_error", "network", "timeout", "aborted", "internal"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** An own data property of an object that is not a proxy; undefined otherwise. Never throws, never calls a getter. */
export function ownData(e: unknown, key: string): unknown {
  try {
    if (typeof e !== "object" || e === null || types.isProxy(e)) return undefined;
    const d = Reflect.getOwnPropertyDescriptor(e, key);
    return d && Object.hasOwn(d, "value") ? d.value : undefined;
  } catch {
    return undefined;
  }
}

const NETWORK = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"]);
const TIMEOUT = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

export function infraFailureClass(e: unknown): FailureClass {
  const code = ownData(e, "code");
  if (typeof code === "string") {
    if (/^[0-9A-Z]{5}$/.test(code)) {
      const c = code.slice(0, 2);
      if (c === "08" || c === "53" || code.startsWith("57P")) return "db_unavailable";
      if (c === "40") return "db_conflict";
      if (c === "23") return "db_constraint";
      if (c === "42" || c === "22" || c === "28") return "db_refused";
      return "db_error";
    }
    if (NETWORK.has(code)) return "network";
    if (TIMEOUT.has(code)) return "timeout";
    if (code === "ABORT_ERR") return "aborted";
  }
  return "internal";
}
