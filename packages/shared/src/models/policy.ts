// Data policy on the pair "base URL + model": which model endpoints may receive records
// of which class. Two lists of explicit pairs — `models.allow_closed` (closed and open records) and `models.allow_open`
// (open records only); a pair that is in neither list receives nothing. A changed address or model no longer matches its
// entry, so the permission is dropped until it is confirmed again. Pure: no I/O, no DNS — the locality of a host is the
// pre-selection of the admin page (`suggestPolicy`), never a runtime rule.
//
// Both sides are compared in canonical form: the connection's base URL is canonical already, every stored entry is put in
// canonical form at comparison time (the seed writes the legacy gateway address as it was stored, and SQL cannot
// reproduce the URL rules). An entry that does not parse never matches.
import type { DataClass } from "../db.ts";
import { PlatformError } from "../platform-error.ts";
import type { ConnectionSettings } from "./types.ts";
import { ModelAddressError, parseBaseUrl, type HostLocality } from "./address.ts";
import { modelNameProblem } from "./names.ts";

/** One entry of `models.allow_closed` / `models.allow_open`. */
export interface PolicyPair { base_url: string; model: string }
/** The model of an entry that stands for every model at its address. */
export const POLICY_ANY_MODEL = "*";
/** The most entries one list may hold. */
export const POLICY_MAX_PAIRS = 200;
/** Values of `models.audit_calls`: `each` — an audit event per call; `hourly` — one per pair, class and hour. */
export const POLICY_AUDIT_CALLS = ["each", "hourly"] as const;

/** What a pair may receive, and which list decided it. */
export interface DataPolicy { open: boolean; closed: boolean; reason: "allow_closed" | "allow_open" | "not_listed" }

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The usable entries of a stored list: own string fields `base_url` and `model`, both non-empty; anything else is skipped. */
function entriesOf(value: unknown): PolicyPair[] {
  if (!Array.isArray(value)) return [];
  const out: PolicyPair[] = [];
  for (const e of value) {
    if (!isPlainObject(e) || !Object.hasOwn(e, "base_url") || !Object.hasOwn(e, "model")) continue;
    if (filled(e.base_url) && filled(e.model)) out.push({ base_url: e.base_url, model: e.model });
  }
  return out;
}

/** The two lists as stored (each key read by a literal call, so the settings registry sees both reads). */
export function policyPairs(settings: Pick<ConnectionSettings, "get">): { closed: PolicyPair[]; open: PolicyPair[] } {
  return { closed: entriesOf(settings.get<unknown>("models.allow_closed", [])), open: entriesOf(settings.get<unknown>("models.allow_open", [])) };
}

/** The canonical base URL of an entry, or null when it does not parse. */
function entryBase(entry: PolicyPair): string | null {
  const p = parseBaseUrl(entry.base_url);
  return "problem" in p ? null : p.baseUrl;
}

/** Does `entry` stand for the pair (canonical base URL, model)? The model is compared exactly; `*` is any model. */
function matches(entry: PolicyPair, pair: { baseUrl: string; model: string }): boolean {
  return entryBase(entry) === pair.baseUrl && (entry.model === POLICY_ANY_MODEL || entry.model === pair.model);
}

/**
 * The classes a pair may receive. `pair.baseUrl` is canonical (`ModelConnection.baseUrl`). Listed in `models.allow_closed`
 * → both classes (also when it is in `models.allow_open` too); otherwise listed in `models.allow_open` → open only;
 * otherwise nothing.
 */
export function dataPolicy(settings: Pick<ConnectionSettings, "get">, pair: { baseUrl: string; model: string }): DataPolicy {
  const lists = policyPairs(settings);
  if (lists.closed.some((e) => matches(e, pair))) return { open: true, closed: true, reason: "allow_closed" };
  if (lists.open.some((e) => matches(e, pair))) return { open: true, closed: false, reason: "allow_open" };
  return { open: false, closed: false, reason: "not_listed" };
}

/** May the pair receive a record of `dataClass`? */
export const dataPolicyAllows = (p: DataPolicy, dataClass: DataClass): boolean => (dataClass === "closed" ? p.closed : p.open);

/** The host of a canonical base URL for messages (never the path, a key or the whole URL). */
function hostOf(baseUrl: string): string {
  const p = parseBaseUrl(baseUrl);
  return "problem" in p ? "an unparsable address" : p.host;
}

/**
 * The text of a refusal: the model, the host and the list to edit — never the base URL, its path or a key. `subject` —
 * what is calling ("the chat model", "the speech model").
 */
export function policyDeniedText(subject: string, pair: { baseUrl: string; model: string }, dataClass: DataClass): string {
  const where = `${subject} "${pair.model}" at ${hostOf(pair.baseUrl)}`;
  return dataClass === "closed"
    ? `${where} is not allowed to receive closed records: to allow it, add its address and model to models.allow_closed`
    : `${where} is not allowed to receive any records: to allow open records, add its address and model to models.allow_open (or to models.allow_closed for every class)`;
}

/**
 * Throws `PlatformError("policy_denied")` unless the pair may receive a record of `dataClass`. For the model adapters
 * outside the facade (OCR by a model, speech recognition:); no audit hook here — the caller records.
 */
export function assertDataPolicy(settings: Pick<ConnectionSettings, "get">, pair: { baseUrl: string; model: string }, dataClass: DataClass,
                                 subject = "the model"): void {
  if (!dataPolicyAllows(dataPolicy(settings, pair), dataClass)) throw new PlatformError("policy_denied", policyDeniedText(subject, pair, dataClass));
}

/** Problems of one entry of a list at save; [] when it is fine. */
function entryProblems(e: unknown, i: number): string[] {
  const at = `entry ${i + 1}`;
  if (!isPlainObject(e)) return [`${at}: an object {"base_url": …, "model": …} is expected`];
  const extra = Object.keys(e).filter((k) => k !== "base_url" && k !== "model");
  if (extra.length) return [`${at}: only the fields base_url and model are allowed`];
  if (!Object.hasOwn(e, "base_url") || !Object.hasOwn(e, "model")) return [`${at}: both fields base_url and model are required`];
  const out: string[] = [];
  if (typeof e.base_url !== "string" || e.base_url === "") out.push(`${at}: base_url — a model API address is expected`);
  else {
    const parsed = parseBaseUrl(e.base_url);
    if ("problem" in parsed) out.push(`${at}: base_url — ${new ModelAddressError(parsed.problem, parsed.detail).message}`);
  }
  if (typeof e.model !== "string" || e.model === "") out.push(`${at}: model — a model name (or * for every model of the address) is expected`);
  else if (e.model !== POLICY_ANY_MODEL) {
    const p = modelNameProblem(e.model);
    if (p) out.push(`${at}: model — ${p}`);
  }
  return out;
}

/**
 * Problems of a value of a data-policy key at save (Settings.validate); [] for other keys and for null (a reset). The lists:
 * at most 200 entries, each exactly `{base_url, model}` with an address by the model address rules (no user name, query,
 * fragment or refused address) and a model name or `*`.
 */
export function policySettingProblems(path: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (path === "models.allow_closed" || path === "models.allow_open") {
    if (!Array.isArray(value)) return ['a list of pairs [{"base_url": …, "model": …}] is expected'];
    if (value.length > POLICY_MAX_PAIRS) return [`at most ${POLICY_MAX_PAIRS} pairs`];
    return value.flatMap(entryProblems);
  }
  if (path === "models.audit_calls")
    return (POLICY_AUDIT_CALLS as readonly unknown[]).includes(value) ? [] : [`allowed ${POLICY_AUDIT_CALLS.map((x) => `"${x}"`).join(", ")}`];
  if (path === "models.health_strict") return typeof value === "boolean" ? [] : ["true or false is expected"];
  return [];
}

/**
 * The list a new connection is pre-selected for on the admin page, in the wizard and in `setup` (an explicit pre-selection
 * instead of implicit trust by address): `closed` only when every address of the host is loopback or private (the result
 * of `hostLocality`); a public, refused or unresolved host — `open`. A suggestion only: nothing is allowed until the pair
 * is written.
 */
export function suggestPolicy(locality: HostLocality): "closed" | "open" {
  return locality.status === "ok" && (locality.locality === "loopback" || locality.locality === "private") ? "closed" : "open";
}

/**
 * What the previous version would read as `models.t0_aliases`: the models of the `models.allow_closed` entries whose
 * address is the legacy gateway address (the previous version sends every role there), in list order, each once, `*`
 * skipped. An unparsable or missing gateway address gives []. For the settings mirror of a rollback; nothing
 * writes it back.
 */
export function legacyT0Projection(settings: ConnectionSettings): string[] {
  const raw = settings.str("models.gateway_base_url");
  if (raw === null || raw === "") return [];
  const gw = parseBaseUrl(raw);
  if ("problem" in gw) return [];
  const out: string[] = [];
  for (const e of policyPairs(settings).closed)
    if (e.model !== POLICY_ANY_MODEL && entryBase(e) === gw.baseUrl && !out.includes(e.model)) out.push(e.model);
  return out;
}
