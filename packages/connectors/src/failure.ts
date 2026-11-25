// One classification of exceptions:
// before an exception reaches a log line, a stored run or connector error, an audit detail, a queue row or an answer, it
// becomes a NEW value chosen from fixed tables. The code is picked by the BRANCH of the core's own logic, never taken from
// the exception: membership is not origin. An error carries a code only when the core built it at one of its own sites
// (the egress client, the secret store — marked here — or the runner, which keeps its own mark), or when it is a
// ConnectorError made by the SDK's constructor and its code is one a connector may declare (the vendor's answer, its own
// configuration). Anything else — a foreign object with a code of the right form, even a code of the tables, a message, a
// name, a cause, a stack — is `internal` or a class of the infrastructure failure. The exception is never read through a
// getter or a proxy trap: the marks are keyed by identity (a WeakMap lookup runs no foreign code), the infrastructure class
// reads only an own data property. No free text is handed to the redactor here.
import { infraFailureClass, ownData, type FailureClass } from "@memory/shared";
import { DELIVERY_REASONS } from "./delivery-codes.ts";
import { RUN_ERRORS } from "./run-codes.ts";

/** Codes a run stores (connector_runs.error, connectors.last_error, the audit `error`). */
export const RUN_CODES: ReadonlySet<string> = new Set([...Object.keys(RUN_ERRORS), "internal"]);
/** Reasons a delivery of a staged item stores and logs. */
export const DELIVERY_CODES: ReadonlySet<string> = new Set([...Object.keys(DELIVERY_REASONS), "internal"]);
const SECRET_CODES: ReadonlySet<string> = new Set(["secret_unreadable", "secret_invalid"]);
/**
 * Codes a connector itself may declare — by a ConnectorError of the SDK or by the answer of test(): what the vendor
 * answered and its own configuration. A connector cannot make the core store a code of the core's own branches (egress,
 * secrets, state, lease, storage, stop).
 */
export const DECLARABLE_CODES: ReadonlySet<string> = new Set(["auth_failed", "rate_limited", "vendor_unavailable", "vendor_not_found", "vendor_refused", "config_invalid"]);

/** Classes of an infrastructure failure, for the logs of the processes. */
export { FAILURE_CLASSES, type FailureClass } from "@memory/shared";

interface Mark { code: string; retryAfterSec: number | null }
/** Errors the core built at its own sites, with the code it chose there (module-internal). */
const CORE = new WeakMap<object, Mark>();
/** ConnectorErrors built by the SDK's constructor, with the code the constructor checked (module-internal). */
const DECLARED = new WeakMap<object, Mark>();

const markOf = (m: WeakMap<object, Mark>, e: unknown): Mark | undefined =>
  (typeof e === "object" && e !== null) || typeof e === "function" ? m.get(e as object) : undefined;

/** The literal of `table` equal to v, or undefined (the input string itself is never returned). */
function literal(table: ReadonlySet<string>, v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  for (const x of table) if (x === v) return x;
  return undefined;
}
const retry = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 86_400 ? v : null);

/**
 * Module-internal (NOT exported at the package root): the core marks an error it built at one of its own sites — the
 * egress client, the secret store — with the code that site chose.
 */
export function markCore<E extends object>(e: E, code: string, retryAfterSec: number | null = null): E {
  CORE.set(e, { code, retryAfterSec: retry(retryAfterSec) });
  return e;
}
/** Module-internal: called only by the ConnectorError constructor of the SDK. */
export function markDeclared(e: object, code: string, retryAfterSec: number | null): void {
  DECLARED.set(e, { code, retryAfterSec: retry(retryAfterSec) });
}

/**
 * The code a run stores for an error and the vendor's Retry-After: the core's own mark (a code of the run table), else a
 * ConnectorError of the SDK with a declarable code, else `internal` (the runner checks its own marks before this).
 */
export function runFailure(e: unknown): Mark {
  const core = markOf(CORE, e);
  if (core) return { code: literal(RUN_CODES, core.code) ?? "internal", retryAfterSec: core.retryAfterSec };
  const declared = markOf(DECLARED, e);
  const code = declared ? literal(DECLARABLE_CODES, declared.code) : undefined;
  return code ? { code, retryAfterSec: declared!.retryAfterSec } : { code: "internal", retryAfterSec: null };
}
export const runFailureCode = (e: unknown): string => runFailure(e).code;

/**
 * The code of what test() answered: `ok` for {ok: true}; for {ok: false}, the code a built-in connector of this package
 * chose by its own branch and marked on the answer (a code of the run table), else a declarable code; `internal` otherwise
 * (a code of the core's own branches the package did not mark, a code of the vendor's form, a getter, a proxy, anything else).
 */
export function testAnswerCode(res: unknown): string {
  const ok = ownData(res, "ok");
  if (ok === true) return "ok";
  if (ok !== false) return "internal";
  // an answer marked inside the package (markCore) carries the code its own branch chose
  const core = markOf(CORE, res);
  if (core) return literal(RUN_CODES, core.code) ?? "internal";
  return literal(DECLARABLE_CODES, ownData(res, "code")) ?? "internal";
}

const ANY_TABLE = [RUN_CODES, DELIVERY_CODES, SECRET_CODES];

/**
 * The class of a failure for the logs of the processes. A core-marked error gives its code (a code of the tables); any
 * other error is classed by the core's own switch on an own data property `code` — a PostgreSQL SQLSTATE (connection and
 * shutdown → db_unavailable, serialization and deadlock → db_conflict, integrity → db_constraint, syntax / rights / data →
 * db_refused, other → db_error), a Node network or timeout code, an abort. The value returned is always a literal of
 * this module: a code of the form of a code — even one of the tables — that the core did not mark is `internal`.
 */
export function failureClass(e: unknown): FailureClass | string {
  const core = markOf(CORE, e);
  if (core) {
    for (const t of ANY_TABLE) { const x = literal(t, core.code); if (x) return x; }
    return "internal";
  }
  return infraFailureClass(e);
}
