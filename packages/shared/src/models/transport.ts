// The model transport: the only `fetch` of the product that reaches a model. Every adapter and the facade
// send their requests through it, so the destination rules hold for every role and provider in one place:
//
// - the URL is the connection's canonical base URL plus a path literal of the adapter; the final URL must stay on the
//   connection's origin and path (no dot segments, no query, no fragment, no encoded slashes or dots);
// - the host must not be of a refused kind (link-local, cloud metadata, unspecified, multicast, broadcast, reserved): IP
//   literals are classified without DNS, names are resolved once per 60 s per host and refused when any address is of a
//   refused kind. Every new socket uses exactly that checked answer through pinned-fetch.ts, including cache hits;
// - redirects are never followed: any 3xx answer is refused and nothing more is sent, so a key never reaches another host;
// - the key goes only into the selected authentication header of its own connection, never into a URL or log.
//
// A name that does not resolve is not a refusal: the call fails like a failed connection does today (outcome `busy`).
// Messages of failed calls come from the facade (`ModelTexts`); the refusals of this file are English.
//
// A failed answer (status 400 and above) also carries what the provider said about it: `retryAfterMs` from
// `Retry-After` (seconds or an HTTP date, at most 10 minutes) and `providerDetail` — a short code and message taken only
// from the known error fields of a JSON body, with the key, token-like strings and any echo of the request content
// redacted, in bounded time whatever the size of the body. The adapters copy both onto
// the error they throw (`withReplyDetail`); the message of the error stays the facade's text.
//
// Before every request an adapter sends through `io().post` or `io().get` the transport asks the facade's guard (the money
// budget): a guard that throws stops the request before anything is sent. `GET /models` (`modelFetch`) is not paid and is
// not asked.
//
// The data policy at the wire (a proof records what was checked; it never
// carries permission): the last synchronous step before a POST is handed to `fetch` is the facade's `wire` check of the
// CURRENT policy for exactly this request (the connection's pair, the data class, the stage) — after every await that
// can precede the write (the budget refresh, a retry's pause, the host check), with no await between it and `fetch`.
// Every request of every role goes through it, each batch and each retry. A revocation that arrives after the request
// was handed to `fetch` is out of its reach.
import { log } from "../log.ts";
import { MAX_MIN_PAUSE_MS } from "../llm-state.ts";
import { PlatformError } from "../platform-error.ts";
import { apiKeySendable, bearer, hostLocality, parseBaseUrl, type HostLocality, type ModelLookup } from "./address.ts";
import type { ModelConnection, ModelIo, ModelReply, ModelTexts, ModelUsageReport } from "./types.ts";
import { connectionChatCapabilities, modelParamsProblems } from "./capabilities.ts";
import { CHAT_PRESETS } from "./presets.ts";
import { pinnedModelDispatcher } from "./pinned-fetch.ts";

/** New connections use English; the injected legacy texts and frozen outcomes stay unchanged. */
export const ENGLISH_MODEL_TEXTS: ModelTexts = {
  aborted: () => "model call aborted",
  timeout: (ms) => `model did not answer within ${ms} ms`,
  unreachable: () => "model endpoint is unreachable",
  busy: (role) => `${role} model is busy (429)`,
  failed: (role, status, body) => status >= 400 ? `${role} model HTTP ${status}`
    : body === null ? `model returned non-JSON (HTTP ${status})` : `model returned no expected fields (HTTP ${status})`,
};

/** How long a resolved host stays checked. */
const HOST_TTL_MS = 60_000;
/** Entries of the host cache; the cache is cleared when it is full. */
const HOST_CACHE_MAX = 256;
/** Characters and escapes a request path must not contain. */
const BAD_PATH = /[\\?#\s\u0000-\u001f\u007f]|%2f|%5c|%2e/i;

/** Acquire source locks after all asynchronous transport checks; release immediately after dispatch, before the response. */
export type BeforeModelDispatch = () => Promise<() => Promise<void>>;

/** The class and stage of a request, for the policy check at the wire. */
export interface WireUse { dataClass: "open" | "closed"; stage?: string }
/** A request of the transport. `path` is relative to the connection's base URL and starts with one `/`. `use` — of a POST (absent: closed). */
export interface ModelRequest { method: "GET" | "POST"; path: string; body?: unknown; signal: AbortSignal; use?: WireUse; beforeDispatch?: BeforeModelDispatch }

type CacheEntry = { at: number; result: HostLocality } | { pending: Promise<HostLocality> };

/**
 * Asked before every adapter request (`io().post` and `io().get`) with the connection and the stage of the call; throws to stop it (the money
 * budget). It must not read anything when nothing is to be checked.
 */
export type ModelRequestGuard = (c: ModelConnection, o: { stage?: string }) => void | Promise<void>;
/**
 * The data policy at the wire: called synchronously, as the very last step before a POST is handed to `fetch`; throws to
 * stop it (`policy_denied`). Never awaited: nothing can change between its answer and the write.
 */
export type ModelWireCheck = (c: ModelConnection, use: WireUse) => void;

/** Why a request was refused: a stable code for the message and the log line. */
type DenyReason = "connection" | "path" | "origin" | "redirect" | `address:${string}`;

export class ModelTransport {
  private readonly texts: ModelTexts;
  private readonly nonLegacyTexts: ModelTexts;
  private readonly lookup: ModelLookup | undefined;
  private readonly now: () => number;
  private readonly guard: ModelRequestGuard | undefined;
  private readonly fetcher: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  private readonly metadata = new Map<string, { at: number; batchSize: number }>();
  private readonly wire: ModelWireCheck | undefined;
  private readonly hosts = new Map<string, CacheEntry>();

  /**
   * `now` — a clock in milliseconds for the host cache; by default a monotonic one, so a wall-clock step does not move it.
   * `guard` — asked before every request of `io().post` or `io().get` (the money budget of the facade). `wire` — the data policy, the
   * last synchronous step before every POST is handed to `fetch`.
   * `send` — replaces the global `fetch` for the request itself, after every check here (the connection probe passes a
   *   connector pinned to the addresses it checked). Ordinary fetch uses the same connector through its dispatcher.
   */
  constructor(o: { texts: ModelTexts; nonLegacyTexts?: ModelTexts; lookup?: ModelLookup; now?: () => number; guard?: ModelRequestGuard; wire?: ModelWireCheck;
    send?: (url: string, init: RequestInit) => Promise<Response> }) {
    this.texts = o.texts;
    this.nonLegacyTexts = o.nonLegacyTexts ?? o.texts;
    this.lookup = o.lookup;
    this.now = o.now ?? (() => performance.now());
    this.guard = o.guard;
    this.wire = o.wire;
    this.fetcher = o.send;
  }

  /**
   * One request to the model server of `c`, after every destination check; the answer as it came (a 3xx answer is refused
   * and its body discarded). Refusals: `PlatformError("destination_denied")` or, for a key that cannot be sent,
   * `PlatformError("not_configured")` — with no request and, before the host check, no DNS lookup. A name that does not
   * resolve throws `TypeError("fetch failed")`, as `fetch` itself does.
   */
  async modelFetch(c: ModelConnection, r: ModelRequest): Promise<Response> {
    // a connection built by hand (an untyped caller) without its parts is refused like one whose parts disagree
    if (!c || typeof c !== "object" || typeof c.baseUrl !== "string" || !c.endpoint || typeof c.endpoint !== "object") this.deny(c, "connection");
    if (c.apiKey !== null && (typeof c.apiKey !== "string" || !apiKeySendable(c.apiKey)))
      throw new PlatformError("not_configured", `the API key of the ${c.role} model connection contains characters that cannot be sent in a header (control characters or characters outside Latin-1)`);
    const parsed = parseBaseUrl(c.baseUrl);
    if ("problem" in parsed || parsed.baseUrl !== c.baseUrl || parsed.origin !== c.endpoint.origin || parsed.host !== c.endpoint.host
        || parsed.pathPrefix !== c.endpoint.pathPrefix)
      this.deny(c, "connection");
    const problems = c.legacy ? [] : modelParamsProblems(c.role, c.provider, c.params);
    if (problems.length) throw new PlatformError("not_configured", `invalid model capabilities: ${problems.join("; ")}`);
    const caps = !c.legacy && c.role === "chat" && (c.provider === "openai-compatible" || Object.hasOwn(CHAT_PRESETS, c.provider))
      ? connectionChatCapabilities(c) : null;
    const auth = caps?.auth_scheme ?? (c.legacy ? "bearer" : c.params.auth_scheme ?? "bearer");
    const url = this.urlOf(c, r.path);
    const checked = await this.checkHost(c, r.signal);
    const headers: Record<string, string> = r.method === "POST" ? { "content-type": "application/json" } : {};
    if (c.apiKey !== null && auth !== "none") {
      if (auth === "bearer") headers.authorization = bearer(c.apiKey);
      else if (["api-key", "x-api-key", "x-goog-api-key"].includes(String(auth))) headers[String(auth)] = c.apiKey;
      else throw new PlatformError("not_configured", "unsupported model authentication scheme");
    }
    const extraHeaders = caps?.headers ?? (c.legacy ? {} : c.params.headers as Record<string, string> | undefined);
    for (const [name, value] of Object.entries(extraHeaders ?? {})) headers[name.toLowerCase()] = value;
    if (c.provider === "anthropic" && caps?.api_version) headers["anthropic-version"] = caps.api_version;
    const init: RequestInit = { method: r.method, signal: r.signal, headers, redirect: "manual" };
    if (r.method === "POST") init.body = JSON.stringify(r.body);
    // Keep fetch's existing wire/test seam and response decoding. Its dispatcher opens the socket through the same
    // pinned connector as the probe; it never asks DNS again, even when this check came from the host cache.
    if (!this.fetcher) Object.assign(init, { dispatcher: pinnedModelDispatcher(c.endpoint.host, checked.addresses, url, init, { role: c.role }) });
    // the data policy of this moment, for exactly this request: the last step before the write, no await in between
    const release = r.method === "POST" ? await r.beforeDispatch?.() : undefined;
    let sent: Promise<Response>;
    try {
      if (r.signal.aborted) throw r.signal.reason;
      if (r.method === "POST" && this.wire) this.wire(c, r.use ?? { dataClass: "closed" });
      // Both branches connect through pinned-fetch.ts; the probe supplies its own short-answer limit.
      sent = this.fetcher ? this.fetcher(url, init) : fetch(url, init);
      // A response may reject while the source locks are being released. Its error is still handled below.
      void sent.catch(() => undefined);
    } finally { await release?.(); }
    const res = await sent;
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      await res.body?.cancel().catch(() => undefined);
      this.deny(c, "redirect", `redirect answer ${res.status}`);
    }
    return res;
  }

  /**
   * POST `body` as JSON and read the answer: the status and the parsed body (null when it is not JSON). The time limit
   * covers the host check too. `signal` — the caller's signal (the model slot): its abort throws its reason when that is a
   * `PlatformError`, otherwise `aborted`; the time limit throws `timeout`; a network failure throws `http` without a status.
   */
  async postJson(c: ModelConnection, path: string, body: unknown, o: { timeoutMs: number; signal?: AbortSignal; use?: WireUse; beforeDispatch?: BeforeModelDispatch }): Promise<ModelReply> {
    return this.json(c, "POST", path, body, o);
  }

  private async json(c: ModelConnection, method: "GET" | "POST", path: string, body: unknown, o: { timeoutMs: number; signal?: AbortSignal; use?: WireUse; beforeDispatch?: BeforeModelDispatch }): Promise<ModelReply> {
    const texts = c.legacy ? this.texts : this.nonLegacyTexts;
    const outer = o.signal;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, ctl.signal]) : ctl.signal;
    try {
      const res = await this.modelFetch(c, { method, path, body, signal, use: o.use, beforeDispatch: o.beforeDispatch });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON: the status alone */ }
      const reply: ModelReply = { status: res.status, json };
      if (res.status >= 400) {
        const after = modelRetryAfterMs(res.headers.get("retry-after"), Date.now());
        if (after !== undefined) reply.retryAfterMs = after;
        const detail = providerDetail(json, c.apiKey, body);
        if (detail !== undefined) reply.providerDetail = detail;
      }
      return reply;
    } catch (e) {
      if (outer?.aborted) throw outer.reason instanceof PlatformError ? outer.reason : new PlatformError("aborted", texts.aborted());
      if (e instanceof PlatformError) throw e;
      if ((e as Error)?.name === "AbortError" || ctl.signal.aborted) throw new PlatformError("timeout", texts.timeout(o.timeoutMs));
      const error = new PlatformError("http", texts.unreachable((e as Error)?.message ?? String(e)));
      const cause = (e as { cause?: { code?: unknown; timeoutMs?: number } })?.cause ?? e as { code?: unknown; timeoutMs?: number };
      const code = cause?.code;
      if (typeof code === "string" && ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code))
        throw new PlatformError("timeout", texts.timeout(cause.timeoutMs ?? o.timeoutMs));
      if (typeof code === "string" && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code))
        error.networkCode = code;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What an adapter gets for `c`: the connection, the texts, a bound POST and the usage sink (no-op by default). A request
   * that was sent and got no answer (time limit, network failure) is reported here as one failed call, since the
   * adapter, which reports each answer, never sees one; a refusal before any request is no call and is not reported.
   * `o.stage` — the stage of the calls (for the guard: the probe and, by setting, search are not stopped by the budget); the
   * stage of one request (`post(…, { stage })`, the embedding adapters) wins over it. `o.dataClass` — the class of the calls,
   * for the policy at the wire (absent: closed).
   */
  io(c: ModelConnection, report?: (u: ModelUsageReport) => void, o?: { stage?: string; dataClass?: WireUse["dataClass"]; beforeDispatch?: BeforeModelDispatch }): ModelIo {
    const sink = report ?? (() => {});
    return {
      connection: c, texts: c.legacy ? this.texts : this.nonLegacyTexts, report: sink,
      get: async (path, po) => {
        // Metadata obeys the same budget guard before DNS/fetch, including cache hits. It is not billed as inference.
        if (this.guard) await this.guard(c, { stage: po.stage ?? o?.stage });
        const key = `${c.baseUrl}\0${c.apiKey ?? ""}`;
        const cached = path === "/info" ? this.metadata.get(key) : undefined;
        if (cached && this.now() - cached.at < HOST_TTL_MS)
          return { status: 200, json: { max_client_batch_size: cached.batchSize } };
        const reply = await this.json(c, "GET", path, undefined, po);
        const size = reply.json?.max_client_batch_size;
        if (path === "/info" && reply.status === 200 && Number.isSafeInteger(size) && size > 0) {
          if (this.metadata.size >= HOST_CACHE_MAX) this.metadata.clear();
          this.metadata.set(key, { at: this.now(), batchSize: size });
        }
        return reply;
      },
      post: async (path, body, po) => {
        // the guard stops a request before anything is sent (budget_exhausted): no call, nothing reported
        const stage = po.stage ?? o?.stage;
        if (this.guard) await this.guard(c, { stage });
        const use: WireUse = { dataClass: o?.dataClass === "open" ? "open" : "closed", ...(stage !== undefined ? { stage } : {}) };
        try { return await this.postJson(c, path, body, { timeoutMs: po.timeoutMs, signal: po.signal, use, beforeDispatch: o?.beforeDispatch }); }
        catch (e) { if (unanswered(e)) sink({ ok: false }); throw e; }
      },
    };
  }

  private deny(c: ModelConnection | undefined, reason: DenyReason, what?: string): never {
    const host = typeof c?.endpoint?.host === "string" ? c.endpoint.host : "";
    const role = typeof c?.role === "string" ? c.role : "unknown";
    log.warn("model_destination_denied", { role, host, reason });
    throw new PlatformError("destination_denied", `model call refused: ${what ?? reason} (${role} model, host ${host})`);
  }

  /** `baseUrl + path`, after the path and the final URL are checked against the connection's origin and path. */
  private urlOf(c: ModelConnection, path: string): string {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || BAD_PATH.test(path)
        || path.split("/").some((s) => s === "." || s === ".."))
      this.deny(c, "path");
    const url = c.baseUrl + path;
    let u: URL;
    try { u = new URL(url); } catch { this.deny(c, "path"); }
    if (u.origin !== c.endpoint.origin || u.username || u.password || u.search || u.hash || u.pathname !== c.endpoint.pathPrefix + path)
      this.deny(c, "origin");
    return url;
  }

  /**
   * Refuses a host of a refused kind; a name that does not resolve fails the way a failed connection does. A call that
   * gives up waiting for a lookup (time limit, abort) drops that lookup from the cache, so the next call asks again
   * instead of waiting on a resolver that may never answer.
   */
  private async checkHost(c: ModelConnection, signal: AbortSignal): Promise<Extract<HostLocality, { status: "ok" }>> {
    const host = c.endpoint.host;
    const { result: answer, entry } = this.locality(host);
    let result: HostLocality;
    try { result = await abortable(answer, signal); }
    catch (e) {
      if (signal.aborted && entry && this.hosts.get(host) === entry) this.hosts.delete(host);
      throw e;
    }
    if (result.status === "refused") this.deny(c, `address:${result.kind}`);
    if (result.status === "unresolved") throw new TypeError("fetch failed");
    return result;
  }

  /**
   * Locality of a host: cached 60 s when checked or refused (an entry whose age is negative — a clock set back — is
   * expired); an unresolved name is asked again next time. `entry` — the pending entry the answer comes from, if any.
   */
  private locality(host: string): { result: Promise<HostLocality>; entry: CacheEntry | null } {
    const hit = this.hosts.get(host);
    if (hit && "pending" in hit) return { result: hit.pending, entry: hit };
    if (hit) {
      const age = this.now() - hit.at;
      if (age >= 0 && age <= HOST_TTL_MS) return { result: Promise.resolve(hit.result), entry: null };
    }
    if (hit) this.hosts.delete(host);
    if (this.hosts.size >= HOST_CACHE_MAX) this.hosts.clear();
    const pending = hostLocality(host, { lookup: this.lookup }).then(
      (result) => {
        if (this.hosts.get(host) === entry) {
          if (result.status === "unresolved") this.hosts.delete(host); else this.hosts.set(host, { at: this.now(), result });
        }
        return result;
      },
      (e: unknown) => {
        if (this.hosts.get(host) === entry) this.hosts.delete(host);
        throw e;
      });
    const entry: CacheEntry = { pending };
    this.hosts.set(host, entry);
    return { result: pending, entry };
  }
}

/** A request that left and got no answer: the time limit or a network failure (not a refusal before the request). */
export function unanswered(e: unknown): boolean {
  return e instanceof PlatformError && (e.kind === "timeout" || (e.kind === "http" && e.status === undefined));
}

/** `p`, or the abort reason of `signal` when it fires first (as `fetch` rejects); the listener is always removed. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { p.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { p.catch(() => undefined); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
           (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

// ---------------------------------------------------------------- what the provider said about a failure

/** An HTTP date has a time of day (IMF-fixdate, RFC 850 and asctime forms all do); anything else with letters is not one. */
const HTTP_DATE_TIME = /\d{1,2}:\d{2}:\d{2}/;
/** A date that ends with a zone (a name such as GMT, or an offset); asctime and a zone-less IMF date do not. */
const HAS_ZONE = /(?:[A-Za-z]|[+-]\d{2}:?\d{2})\s*$/;
/**
 * The commas that separate the elements of a repeated header (fetch joins `Retry-After: 120` and `Retry-After: 30` into
 * "120, 30"): a comma followed by delay-seconds that end the element, or by a weekday that starts a date. The comma inside
 * an IMF or RFC 850 date ("Fri, 13 Nov …") is followed by the day of the month, so it does not split.
 */
const LIST_COMMA = /,\s*(?=\d+(?:\.\d+)?\s*(?:,|$)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b)/i;
/** Longest `Retry-After` value read; a longer one is not a wait. */
const RETRY_AFTER_MAX_LEN = 256;

/**
 * `Retry-After` as a wait in ms: delay-seconds (a fraction is accepted) or an HTTP date relative to `nowMs`, at most
 * 10 minutes. An HTTP date without a zone (asctime) is GMT, as RFC 9110 says, whatever the zone of the process. A
 * repeated header gives the longest of its readable elements. No header, zero, a past date or a value of another form →
 * undefined (no minimum pause).
 */
export function modelRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (typeof value !== "string" || value.length > RETRY_AFTER_MAX_LEN) return undefined;
  let best: number | undefined;
  for (const part of value.split(LIST_COMMA)) {
    const ms = oneRetryAfterMs(part.trim(), nowMs);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best === undefined ? undefined : Math.min(best, MAX_MIN_PAUSE_MS);
}

function oneRetryAfterMs(v: string, nowMs: number): number | undefined {
  let ms: number;
  if (/^\d+(?:\.\d+)?$/.test(v)) ms = Math.round(Number(v) * 1000);
  else if (/[A-Za-z]/.test(v) && HTTP_DATE_TIME.test(v)) ms = Date.parse(HAS_ZONE.test(v) ? v : `${v} GMT`) - nowMs;
  else return undefined;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Longest provider detail, in characters. */
const DETAIL_MAX = 200;
/**
 * Longest part of the provider's text that is looked at, in characters: the rest is dropped before any mask runs, so the
 * work per failed answer is bounded whatever the size of the body (an error body is not limited in size).
 */
const RAW_MAX = 2_000;
const REDACTED = "[redacted]";
/** Line breaks and tabs: one space each run. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
/** Other control characters and invisible format characters (bidi overrides, zero-width, tags, variation selectors): removed. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
/**
 * Strings that look like credentials, redacted whatever the key of the connection is. Every pattern runs in linear time:
 * a pattern that can start inside its own match (the JWT one) starts only where a token starts.
 */
const TOKEN_LIKE: ReadonlyArray<[RegExp, string]> = [
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],                // an authorization value
  [/\b((?:x-)?api[_ -]?key|access[_-]?token|auth[_-]?token)(\s*[=:]\s*)["']?[^\s"',;&]{4,}/gi, `$1$2${REDACTED}`], // key=value
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${REDACTED}@`],                                        // user:password@ in an address
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],     // a JWT
  // vendor key prefixes (OpenAI, Anthropic, Groq, xAI, Jina, Hugging Face, Replicate, Together, NVIDIA, GitHub, GitLab, Slack)
  [/\b(?:sk|pk|rk|ak|pa|xai|gsk|jina|hf|r8|tgp|nvapi|gh[pousr]|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/gi, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],                                                  // a Google API key
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, REDACTED],        // a UUID (some providers' keys)
  [/\b[A-Za-z0-9]{32,}\b/g, REDACTED],                                                      // a long run of letters and digits
];

const cleanText = (t: string): string => t.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The provider's short code and message from a JSON error body — only the known fields: `error.code` (a string; a number
 * repeats the HTTP status), `error.type`, `error.status` (Gemini), `error_type` (TEI) for the code, and `error.message`,
 * `error` as a string (TEI) or `message` for the text. Only the first 2 000 characters are looked at (a word cut in two
 * there is dropped, so half a key cannot outlive the masks). Control and invisible characters removed, the connection's
 * key (also URL-encoded) and token-like strings redacted, at most 200 characters. `request` — the body that was sent:
 * where the provider repeats its content (pydantic-style validation errors put the request into `message`), the detail
 * is cut at the start of the echo, so request content never reaches it. A body of another shape (or not JSON: null)
 * gives no detail.
 */
export function providerDetail(json: unknown, apiKey: string | null, request?: unknown): string | undefined {
  if (!plainObject(json)) return undefined;
  const err = json.error, eo = plainObject(err) ? err : null;
  const code = nonEmpty(eo?.code) ?? nonEmpty(eo?.type) ?? nonEmpty(eo?.status) ?? nonEmpty(json.error_type);
  const text = nonEmpty(eo?.message) ?? nonEmpty(err) ?? nonEmpty(json.message);
  const raw = code && text ? `${code}: ${text}` : code ?? text;
  if (raw === undefined) return undefined;
  // the key as it is, in its cleaned form (a key with a tab inside is echoed with it, and cleaning would split it) and
  // URL-encoded (an echoed request URL)
  const keys = typeof apiKey === "string"
    ? [...new Set([apiKey, cleanText(apiKey), encodeURIComponent(apiKey)])].filter((k) => k.length >= 4) : [];
  let d = headOf(raw);
  for (const k of keys) d = d.split(k).join(REDACTED);
  d = cleanText(d);
  for (const k of keys) d = d.split(k).join(REDACTED);
  d = withoutEcho(d, request);
  for (const [re, to] of TOKEN_LIKE) d = d.replace(re, to);
  d = [...d].slice(0, DETAIL_MAX).join("").trimEnd();
  return d ? d : undefined;
}

/** The first `RAW_MAX` characters of `t`; when more follows, without the last word, which the cut may have split. */
function headOf(t: string): string {
  if (t.length <= RAW_MAX) return t;
  let i = 0;
  for (let n = 0; n < RAW_MAX && i < t.length; n++) i += (t.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  if (i >= t.length) return t;
  if (/\s/u.test(t[i]!)) return t.slice(0, i);
  let j = i;
  while (j > 0 && !/\s/u.test(t[j - 1]!)) j--;
  return t.slice(0, j);
}

/** Length of the runs compared between the detail and the request, in folded characters (about three words). */
const ECHO_RUN = 16;
/** Length of a literal run, including punctuation that the fold may collapse. */
const ECHO_LITERAL_RUN = 12;
/** A shorter string of the request (a short message) is looked for whole, from this length. */
const ECHO_SHORT_MIN = 8;
/** Fields of a request body that hold no content of a record: the model, roles, kinds, the answer schema, tool definitions. */
const NOT_CONTENT = new Set(["model", "role", "type", "response_format", "json_schema", "responseSchema", "response_schema",
  "generationConfig", "tools", "tool_choice", "encoding_format"]);
/** Strings looked at in a request body at most (a bound on the work, not a limit any adapter reaches). */
const REQUEST_TEXTS_MAX = 5_000;
/** Characters that may open an echo and are dropped with it (quotes, brackets) — and spaces. */
const ECHO_OPENERS = new Set([..."\"'`([{<"]);

/**
 * Letters and digits, lower case (final sigma as sigma), every other run as one space: what an echo keeps whatever its
 * spacing, case and punctuation. Escapes (`\n`, `\t`, `\"`, `\uXXXX`…) are read by `foldWithIndex(d, true)`.
 */
function foldChar(ch: string): string {
  return ch.toLowerCase().replace(/ς/gu, "σ");
}
const isWordChar = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);
function fold(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().replace(/ς/gu, "σ").trim();
}
/** One-letter escapes of JSON, Python and JavaScript string literals: each stands for a space or a punctuation mark. */
const LETTER_ESCAPES = new Set([..."nrtbfva0\"'/`"]);
const HEX = /^[0-9a-fA-F]+$/;
/**
 * The escape that starts at `d[i]` (after its backslashes): the characters it stands for and its length, or null. `\uXXXX`
 * (a surrogate pair as two escapes), `\UXXXXXXXX`, `\xHH` are decoded; a letter escape is a space.
 */
function readEscape(d: string, i: number): { chars: string; len: number } | null {
  const c = d[i];
  if (c === undefined) return null;
  if (LETTER_ESCAPES.has(c)) return { chars: " ", len: 1 };
  const hex = (from: number, n: number): number | null => {
    const h = d.slice(from, from + n);
    return h.length === n && HEX.test(h) ? parseInt(h, 16) : null;
  };
  if (c === "u") {
    const hi = hex(i + 1, 4);
    if (hi === null) return null;
    if (hi >= 0xd800 && hi <= 0xdbff) {
      const m = /^\\+u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(d.slice(i + 5, i + 5 + 16));
      if (m) return { chars: String.fromCharCode(hi, parseInt(m[1]!, 16)), len: 5 + m[0].length };
    }
    return { chars: String.fromCharCode(hi), len: 5 };
  }
  if (c === "U") {
    const cp = hex(i + 1, 8);
    return cp !== null && cp <= 0x10ffff ? { chars: String.fromCodePoint(cp), len: 9 } : null;
  }
  if (c === "x") {
    const b = hex(i + 1, 2);
    return b !== null ? { chars: String.fromCharCode(b), len: 3 } : null;
  }
  return null;
}
/**
 * `fold(d)` and, for each of its characters, the index in `d` it comes from. `escapes` — read `d` as an escaped string
 * literal: a provider that repeats the request as a Python repr or a JSON string writes a
 * line break as `\n`, and without this the escape letter sticks to the next word (`\nBob` → `nbob`), so content made of
 * short lines shared no run with the request. A run of backslashes (an escape escaped again) counts as one; a decoded
 * character maps to the first backslash.
 */
function foldWithIndex(d: string, escapes = false): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  const put = (ch: string, i: number): void => {
    if (isWordChar(ch)) {
      const l = foldChar(ch);
      text += l;
      for (let k = 0; k < l.length; k++) at.push(i);
    } else if (text && !text.endsWith(" ")) {
      text += " ";
      at.push(i);
    }
  };
  let i = 0;
  while (i < d.length) {
    if (escapes && d[i] === "\\") {
      const start = i;
      while (d[i] === "\\") i++;
      const e = readEscape(d, i);
      if (e) { i += e.len; for (const ch of e.chars) put(ch, start); } else put(" ", start);
      continue;
    }
    const ch = String.fromCodePoint(d.codePointAt(i)!);
    put(ch, i);
    i += ch.length;
  }
  if (text.endsWith(" ")) { text = text.slice(0, -1); at.pop(); }
  return { text, at };
}

/** The strings of a request body that may be content (`NOT_CONTENT` fields skipped). */
function requestTexts(v: unknown, out: string[], depth: number): void {
  if (depth > 32 || out.length >= REQUEST_TEXTS_MAX) return;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) requestTexts(x, out, depth + 1);
  else if (plainObject(v)) for (const [k, x] of Object.entries(v)) if (!NOT_CONTENT.has(k)) requestTexts(x, out, depth + 1);
}

function earlierEchoRun(s: string, length: number, runs: ReadonlyMap<string, number>, first: number): number {
  if (runs.size === 0) return first;
  for (let k = 0; k + length <= s.length && first > 0; k++) {
    const hit = runs.get(s.slice(k, k + length));
    if (hit !== undefined && hit < first) first = hit;
  }
  return first;
}

/**
 * `d` cut at the first place where it repeats content of `request`: a run of `ECHO_LITERAL_RUN` literal or `ECHO_RUN` folded
 * characters, or a whole short string (from `ECHO_SHORT_MIN` folded characters) between word boundaries. What
 * the provider wrote before the echo stays, followed by the marker; without an echo `d` is returned as it is. A detail
 * with a backslash is folded twice — as it is and read as an escaped literal — and the earlier echo of the two wins.
 */
function withoutEcho(d: string, request: unknown): string {
  if (request === undefined || request === null || !d) return d;
  const texts: string[] = [];
  requestTexts(request, texts, 0);
  if (texts.length === 0) return d;
  const views = d.includes("\\") ? [foldWithIndex(d), foldWithIndex(d, true)] : [foldWithIndex(d)];
  // Index backwards so a repeated literal run keeps its earliest offset.
  const literalRuns = new Map<string, number>();
  for (let k = d.length - ECHO_LITERAL_RUN; k >= 0; k--) {
    literalRuns.set(d.slice(k, k + ECHO_LITERAL_RUN), k);
  }
  // each run → the earliest index in `d` where a view has it
  const runs = new Map<string, number>();
  for (const { text, at } of views) {
    for (let k = 0; k + ECHO_RUN <= text.length; k++) {
      const w = text.slice(k, k + ECHO_RUN), p = at[k]!;
      const o = runs.get(w);
      if (o === undefined || p < o) runs.set(w, p);
    }
  }
  let first = Infinity;                                       // an index in `d`
  for (const s of texts) {
    first = earlierEchoRun(s, ECHO_LITERAL_RUN, literalRuns, first);
    if (first === 0) break;
    const f = fold(s);
    if (f.length >= ECHO_RUN) {
      first = earlierEchoRun(f, ECHO_RUN, runs, first);
    } else if (f.length >= ECHO_SHORT_MIN) {
      for (const { text, at } of views) {
        for (let p = text.indexOf(f); p >= 0 && at[p]! < first; p = text.indexOf(f, p + 1)) {
          if ((p === 0 || text[p - 1] === " ") && (p + f.length === text.length || text[p + f.length] === " ")) { first = at[p]!; break; }
        }
      }
    }
    if (first === 0) break;
  }
  if (first === Infinity) return d;
  let head = d.slice(0, first);
  let j = head.length;
  while (j > 0 && (/\s/u.test(head[j - 1]!) || ECHO_OPENERS.has(head[j - 1]!))) j--;
  head = head.slice(0, j);
  return head ? `${head} ${REDACTED}` : REDACTED;
}

/** Copies what the provider said about a failed answer (`retryAfterMs`, `providerDetail`) onto the error an adapter throws. */
export function withReplyDetail(e: PlatformError, reply: ModelReply): PlatformError {
  if (reply.retryAfterMs !== undefined) e.retryAfterMs = reply.retryAfterMs;
  if (reply.providerDetail !== undefined) e.providerDetail = reply.providerDetail;
  return e;
}
