// A connector for model calls and their connection probe that connects only to addresses already checked.
// The transport (or the probe) resolves the host with `hostLocality` and passes the checked answer here. Every request then
// connects to exactly those addresses: the socket's lookup returns them instead of asking DNS again, so a name that
// answers differently later is never reached at its new address. The name stays in the request: the URL keeps it, so
// the Host header and the TLS server name (SNI and certificate check) are the configured name. Redirects are never
// followed (node's http client does not follow them; the transport refuses any 3xx). No connection pool: each request
// opens its own socket through the same pinned lookup. Same pattern as `oidcLookup` (oidc.ts), with the model address
// policy of `refusedKind` (loopback and private allowed, every other refused kind refused).
// The wire equals an ordinary call's (`fetch`, Node's bundled undici): the same default request headers are added when
// the caller did not set them, a compressed answer is decoded, and the answer is handed over as soon as its status and
// headers arrive (the body streams), so a 3xx is refused at once even when its body never ends.
// Only `connection` differs (hop-by-hop; every request has its own socket here). A `host` request header is refused:
// node would take the TLS server name from it.
import { request as httpRequest, type IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { log } from "../log.ts";
import { PlatformError } from "../platform-error.ts";
import { addressLocality, modelAddressKind, refusedKind, type ClassifiedAddress } from "./address.ts";

/** The subset of `fetch` the model transport uses. */
export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Upper bound of an answer body read by the probe (its answers are a few hundred bytes). */
export const PINNED_FETCH_MAX_BYTES = 4 * 1024 * 1024;
/** Native fetch's connection/TLS, headers and body-idle defaults. Only the ordinary dispatcher opts into these. */
const SOCKET_TIMEOUTS = { connect: 10_000, headers: 300_000, body: 300_000 } as const;
/** Bytes queued between the node stream and fetch; this is a water mark, never a total response limit. */
const BODY_HIGH_WATER_MARK = 64 * 1024;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const refused = (what: string): PlatformError =>
  new PlatformError("destination_denied", `model call refused: ${what}`);

function bareHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
}

/** Lookup that answers with the checked addresses only; it never resolves anything itself. */
function pinnedLookup(host: string, addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>): LookupFunction {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (bareHost(hostname) !== host) {
      const e = Object.assign(refused("unchecked host name"), { code: "MODEL_ADDRESS_UNCHECKED" });
      return all ? callback(e, []) : callback(e, "", 0);
    }
    const list = addresses.map((a) => ({ address: a.address, family: a.family }));
    return all ? callback(null, list) : callback(null, list[0]!.address, list[0]!.family);
  }) as LookupFunction;
}

function headersOf(res: IncomingMessage): Headers {
  const h = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) { try { h.append(name, v); } catch { /* invalid header value: dropped */ } }
  }
  return h;
}

/** The request headers `fetch` adds when absent, in its order (Node 22–26 bundle undici 6–8; pinned by the loopback
 * comparison tests). `fetch` asks for `br` only over https (undici, `lib/web/fetch/index.js`, «Modify httpRequest's
 * header list per HTTP»). */
export function fetchDefaultHeaders(protocol: string): ReadonlyArray<readonly [string, string]> {
  return [["accept", "*/*"], ["accept-language", "*"], ["sec-fetch-mode", "cors"], ["user-agent", "node"],
    ["accept-encoding", protocol === "https:" ? "br, gzip, deflate" : "gzip, deflate"]];
}

function requestHeaders(init: RequestInit, protocol: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, name) => { out[name] = value; });
  if (Object.hasOwn(out, "host")) return null;
  for (const [name, value] of fetchDefaultHeaders(protocol)) if (!Object.hasOwn(out, name)) out[name] = value;
  return out;
}

/** At most this many content codings are decoded, as `fetch` (undici) allows. */
export const MAX_CONTENT_CODINGS = 5;
const DECODERS: Record<string, () => Transform> = {
  gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress,
};
/** The codings of `content-encoding`, outermost last; null when one is unknown or there are too many (refused at the headers). */
function contentCodings(header: string | string[] | undefined): string[] | null {
  const list = String(header ?? "").toLowerCase().split(",").map((c) => c.trim()).filter((c) => c && c !== "identity");
  if (list.length > MAX_CONTENT_CODINGS || list.some((c) => !Object.hasOwn(DECODERS, c))) return null;
  return list;
}
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

/**
 * A `ModelFetch` bound to one host and the addresses its check accepted. A URL with another host, an empty or refused
 * address list, a non-HTTP scheme, a `host` request header or a body that is not a string is refused before any socket
 * is opened. The decoded answer body is limited to `maxBytes`. An unknown content coding, or more than
 * `MAX_CONTENT_CODINGS`, is refused when the headers arrive, before any decoder exists. `rawBody` is used only by the
 * ordinary fetch dispatcher below: fetch retains its existing decoding and response-size behaviour in that path.
 * `consumerFlow` (that dispatcher only) receives, once per request, a switch the consumer flips when it pauses and
 * resumes: while paused the body-idle deadline is suspended, as undici suspends it while its parser is paused.
 */
export function pinnedModelFetch(host: string, checked: ReadonlyArray<ClassifiedAddress>,
  o: { maxBytes?: number; rawBody?: boolean; socketTimeouts?: boolean; consumerFlow?: (setPaused: (paused: boolean) => void) => void } = {}): ModelFetch {
  const pinnedHost = bareHost(host);
  const addresses: Array<{ address: string; family: 4 | 6 }> = [];
  for (const a of checked) {
    const family = isIP(a.address);
    // The kind is recomputed here: a caller cannot pin an address the model address policy refuses.
    if ((family !== 4 && family !== 6) || refusedKind(modelAddressKind(a.address))) { addresses.length = 0; break; }
    addresses.push({ address: a.address, family });
  }
  const limit = o.maxBytes ?? PINNED_FETCH_MAX_BYTES;
  return (url, init) => new Promise<Response>((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(refused("invalid URL")); return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") { reject(refused("scheme")); return; }
    const urlHost = bareHost(u.hostname);
    if (urlHost !== pinnedHost || !addresses.length) { reject(refused("unchecked address")); return; }
    // An IP literal is connected to as written; it must be one of the checked addresses.
    if (isIP(urlHost) && !addresses.some((a) => a.address === urlHost)) { reject(refused("unchecked address")); return; }
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") { reject(refused("unsupported body")); return; }
    const headers = requestHeaders(init, u.protocol);
    if (!headers) { reject(refused("host header")); return; }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) { reject(signal.reason ?? new DOMException("aborted", "AbortError")); return; }
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    // ---- The pump. INVARIANT: every stream or emitter this function creates or receives —
    // the request, its socket, the response, each decoder — gets an `error` listener (`guarded`) in the same synchronous
    // step that creates or receives it, and the decoders and the response sit in one `pipeline()` whose callback is a
    // single exit. The outcome is decided once (`decide`): before the answer is handed over it settles the promise,
    // after that it closes or errors the body stream; every later event, error or chunk of an already destroyed stream
    // is swallowed into the decided outcome and never thrown. Deciding destroys the whole chain. A new stream added here
    // must go through `guarded` (held by a static test of this file).
    // An error of any guarded stream before the outcome IS the outcome (a decoder can fail after
    // the pipeline reported success, e.g. an empty or truncated gzip body); after the outcome `decide` ignores it.
    // Every decoder's output is counted, so nested codings cannot expand without bound in a middle layer.
    const owned: Array<{ destroy(e?: Error): unknown }> = [];
    const guarded = <T extends NodeJS.EventEmitter & { destroy(e?: Error): unknown }>(s: T, code?: string): T => {
      s.on("error", (e: unknown) => decide(code ? coded("invalid compressed answer", code) : e));
      owned.push(s); return s;
    };
    let answered = false, decided = false, consumerPaused = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const timers = new Map<keyof typeof SOCKET_TIMEOUTS, ReturnType<typeof setTimeout>>();
    const stopTimer = (phase: keyof typeof SOCKET_TIMEOUTS) => { clearTimeout(timers.get(phase)); timers.delete(phase); };
    const startTimer = (phase: keyof typeof SOCKET_TIMEOUTS) => {
      stopTimer(phase);
      if (!o.socketTimeouts || decided || (phase === "body" && consumerPaused)) return;
      const ms = SOCKET_TIMEOUTS[phase];
      const code = phase === "connect" ? "UND_ERR_CONNECT_TIMEOUT" : phase === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT";
      timers.set(phase, setTimeout(() => decide(Object.assign(coded(`model ${phase} timed out`, code), { timeoutMs: ms })), ms));
    };
    const destroyAll = () => { for (const s of owned.slice().reverse()) { try { s.destroy(); } catch { /* already gone */ } } };
    const decide = (e?: unknown) => {
      if (decided) return;
      decided = true;
      for (const phase of timers.keys()) stopTimer(phase);
      signal?.removeEventListener("abort", abort);
      if (!answered) reject(e ?? coded("model answer ended early", "ECONNRESET"));
      else if (e === undefined) { try { controller?.close(); } catch { /* cancelled */ } }
      else { try { controller?.error(e); } catch { /* cancelled */ } }
      destroyAll();
    };
    const abort = () => decide(signal?.reason ?? new DOMException("aborted", "AbortError"));
    // The consumer's own pause is not network idleness, even when this function's queue
    // is far from full. On resume the deadline is re-armed only while the queue still takes bytes; a full queue re-arms
    // it from `pull` when the consumer reads again.
    o.consumerFlow?.((paused) => {
      consumerPaused = paused;
      if (paused) stopTimer("body");
      else if (answered && controller && (controller.desiredSize ?? 0) > 0) startTimer("body");
    });
    // TLS: the server name is the configured name, set here rather than derived from any header (none for an IP literal).
    const tls = u.protocol === "https:" && !isIP(urlHost) ? { servername: urlHost } : {};
    const req = guarded(send(u, { method: init.method ?? "GET", headers, agent: false, lookup: pinnedLookup(pinnedHost, addresses), ...tls, ...(u.protocol === "https:" ? { rejectUnauthorized: true } : {}) }, (incoming) => {
      const res = guarded(incoming);
      // a throw anywhere in this callback (it runs inside the HTTP parser) is the outcome, never uncaught.
      try { onAnswer(res); } catch (e) { decide(e); }
    }));
    function onAnswer(res: IncomingMessage): void {
      if (decided) return;
      stopTimer("connect"); stopTimer("headers");
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) { decide(coded("invalid HTTP status", "MODEL_BAD_STATUS")); return; }
      const codings = NULL_BODY.has(status) || o.rawBody ? [] : contentCodings(res.headers["content-encoding"]);
      if (!codings) { decide(coded("unsupported content coding", "MODEL_BAD_ENCODING")); return; }
      let answer: Response;
      if (NULL_BODY.has(status)) {
        try { answer = new Response(null, { status, statusText: res.statusMessage, headers: headersOf(res) }); } catch (e) { decide(e); return; }
        answered = true; resolve(answer); decide();
        return;
      }
      const decoders = codings.slice().reverse().map((c) => guarded(DECODERS[c]!(), "MODEL_BAD_ENCODING"));
      for (const step of decoders.length ? [res, ...decoders.slice(0, -1)] : []) {
        let produced = 0;
        step.on("data", (chunk: Buffer) => { produced += chunk.length; if (produced > limit) decide(coded("model answer too large", "MODEL_ANSWER_TOO_LARGE")); });
      }
      const tail: Readable = decoders.length ? decoders[decoders.length - 1]! : res;
      let size = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        pull() { if (!decided) { startTimer("body"); tail.resume(); } },
        cancel() { decide(coded("model answer cancelled", "MODEL_ANSWER_CANCELLED")); },
      }, { highWaterMark: BODY_HIGH_WATER_MARK, size: (chunk) => chunk.byteLength });
      startTimer("body");
      // Measure network idleness, including compressed answers. Consumer backpressure suspends this timer just as
      // undici suspends its parser's body deadline; time spent waiting for the consumer is not network idleness. Both
      // kinds suspend it: a full queue here (below) and the consumer's own pause (`consumerFlow` above).
      res.on("data", () => startTimer("body"));
      tail.on("data", (chunk: Buffer) => {
        if (decided) return;
        size += chunk.length;
        if (size > limit) { decide(coded("model answer too large", "MODEL_ANSWER_TOO_LARGE")); return; }
        try {
          controller!.enqueue(new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)));
          if (controller!.desiredSize! <= 0) { tail.pause(); stopTimer("body"); }
        }
        catch (e) { decide(e); }
      });
      tail.on("end", () => decide());
      // The single exit of the chain: an error of the response or of any decoder, or a premature close.
      if (decoders.length) (pipeline as unknown as (streams: unknown[], done: (e: Error | null) => void) => void)([res, ...decoders], (e) => { if (e) decide(e); });
      res.on("close", () => { if (!res.complete) decide(coded("model answer aborted", "ECONNRESET")); });
      try { answer = new Response(stream, { status, statusText: res.statusMessage, headers: headersOf(res) }); } catch (e) { decide(e); return; }
      answered = true; resolve(answer);
    }
    startTimer("connect");
    req.on("socket", (socket) => {
      guarded(socket);
      const connected = () => { stopTimer("connect"); if (!answered) startTimer("headers"); };
      if (u.protocol === "https:") socket.once("secureConnect", connected);
      else if (socket.connecting) socket.once("connect", connected);
      else connected();
    });
    req.on("error", (e) => decide(e));
    req.on("close", () => { if (!answered) decide(coded("model request closed", "ECONNRESET")); });
    signal?.addEventListener("abort", abort, { once: true });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The callback interface used by Node's bundled fetch (undici); no runtime dependency on a second HTTP client. */
interface FetchDispatchHandler {
  onConnect(abort: (reason?: Error) => void): void;
  onHeaders(status: number, headers: Buffer[], resume: () => void, statusText: string): boolean;
  onData(chunk: Buffer): boolean;
  onComplete(trailers: string[]): void;
  onError(error: Error): void;
}
interface FetchDispatchController {
  readonly aborted: boolean;
  readonly paused: boolean;
  readonly reason: Error | null;
  /** Name/value pairs of the response headers, set before `onResponseStart`: undici 8's fetch reads its headers from
   * here only and ignores the parsed object. */
  readonly rawHeaders: Buffer[] | null;
  abort(reason?: Error): void;
  pause(): void;
  resume(): void;
}
/** undici 8 (Node 26) supplies this contract directly, without the legacy-handler adapter. */
interface CurrentFetchDispatchHandler {
  onRequestStart(controller: FetchDispatchController, context: unknown): void;
  onResponseStart(controller: FetchDispatchController, status: number, headers: IncomingHttpHeaders, statusText: string): void;
  onResponseData(controller: FetchDispatchController, chunk: Buffer): void;
  onResponseEnd(controller: FetchDispatchController, trailers: IncomingHttpHeaders): void;
  onResponseError(controller: FetchDispatchController, error: Error): void;
}

/**
 * Adapt the pinned connector to the dispatcher seam of Node's fetch. The request bytes are the transport's immutable
 * string, captured before dispatch; fetching still adds its normal headers, decodes the response once and streams it.
 * The ordinary call never had a response byte cap. The probe keeps its separate short-answer cap and decoder above.
 * The dispatcher is bound to exactly one URL/method: neither a redirect nor a rewritten request can reuse its pin.
 */
export function pinnedModelDispatcher(host: string, checked: ReadonlyArray<ClassifiedAddress>, url: string, init: RequestInit, about: { role?: string } = {}) {
  const ctl = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal;
  const request = { ...init, signal };
  // The consumer's pause switch of the one request this dispatcher sends (see `consumerFlow`).
  let flow: (paused: boolean) => void = () => {};
  const send = pinnedModelFetch(host, checked, { rawBody: true, maxBytes: Infinity, socketTimeouts: true,
    consumerFlow: (setPaused) => { flow = setPaused; } });
  let dispatched = false;
  // The fields of the one log event below: configuration values only (the role) and the class of the checked addresses.
  const failure = { role: about.role ?? "unknown", host_class: addressClass(checked) };
  return {
    dispatch(options: { origin: string | URL; path: string; method: string; headers: Record<string, string> | string[] }, handler: FetchDispatchHandler | CurrentFetchDispatchHandler): boolean {
      const current = "onResponseStart" in handler ? handler : undefined;
      const legacy = "onHeaders" in handler ? handler : undefined;
      const callbacks = current ? [current.onRequestStart, current.onResponseStart, current.onResponseData, current.onResponseEnd, current.onResponseError]
        : legacy ? [legacy.onConnect, legacy.onHeaders, legacy.onData, legacy.onComplete, legacy.onError] : [];
      // Throw synchronously: fetch catches dispatch errors. An unusable error callback must never leave it pending.
      if (callbacks.length !== 5 || callbacks.some((f) => typeof f !== "function")) throw new TypeError("invalid model fetch dispatcher handler");
      // fetch owns redirect handling; even an accidental change to its redirect option cannot grant a second dispatch.
      const run = async () => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let wake: (() => void) | undefined;
        let paused = false, resumes = 0;
        let rawHeaders: Buffer[] | null = null;
        const pause = () => { paused = true; flow(true); };
        const resume = () => { paused = false; resumes++; flow(false); wake?.(); wake = undefined; };
        const controller: FetchDispatchController = {
          get aborted() { return signal.aborted; }, get paused() { return paused; },
          get reason() { return signal.aborted ? signal.reason : null; },
          get rawHeaders() { return rawHeaders; },
          abort(reason) { ctl.abort(reason); }, pause, resume,
        };
        const aborted = () => resume();
        signal.addEventListener("abort", aborted, { once: true });
        try {
          if (current) current.onRequestStart(controller, null);
          else legacy!.onConnect((reason) => ctl.abort(reason));
          if (String(options.origin) + options.path !== url || options.method !== (request.method ?? "GET") || dispatched)
            throw refused("unchecked request");
          dispatched = true;
          // Pass fetch's actual headers (including its defaults) to the same connector used by the probe.
          const h = options.headers;
          const headers = Array.isArray(h) ? Array.from({ length: h.length / 2 }, (_, i) => [h[2 * i]!, h[2 * i + 1]!] as [string, string]) : h;
          const res = await send(url, { ...request, headers });
          const raw: Buffer[] = [];
          // F-M51-3: a header value is a byte string (node read it as latin1); its bytes go on unchanged, not re-encoded as UTF-8.
          res.headers.forEach((value, name) => { raw.push(Buffer.from(name, "latin1"), Buffer.from(value, "latin1")); });
          const deliver = async (f: () => boolean | void) => {
            const before = resumes;
            if (f() === false && resumes === before) pause();
            if (paused && !signal.aborted) await new Promise<void>((resolve) => { wake = resolve; });
            wake = undefined;
            if (signal.aborted) throw signal.reason;
          };
          reader = res.body?.getReader();
          rawHeaders = raw;
          await deliver(() => current ? current.onResponseStart(controller, res.status, Object.fromEntries(res.headers), res.statusText)
            : legacy!.onHeaders(res.status, raw, resume, res.statusText));
          if (reader) for (;;) {
            const part = await reader.read();
            if (part.done) break;
            await deliver(() => current ? current.onResponseData(controller, Buffer.from(part.value)) : legacy!.onData(Buffer.from(part.value)));
          }
          if (current) current.onResponseEnd(controller, {}); else legacy!.onComplete([]);
        } catch (e) {
          ctl.abort(e);
          const error = e instanceof Error ? e : new Error("model connection failed");
          if (current) current.onResponseError(controller, error); else legacy!.onError(error);
        } finally {
          signal.removeEventListener("abort", aborted);
          await reader?.cancel().catch(() => undefined);
        }
      };
      // rule «log and abort»: an error callback that itself throws is logged by a fixed event without its
      // text; nothing is rethrown, so no callback can end the process. `run` rejects only from its `catch`, which aborted
      // the call (its socket closes) before it called the error callback — no second abort here.
      // The event names the connection, not the failure: its role and the class of the checked addresses.
      void run().catch(() => { try { log.error("model_dispatch_handler_failed", failure); } catch { /* the log is best effort */ } });
      return true;
    },
  };
}

/** The class of a checked address list for a log line: loopback, private or public (the widest), never an address. */
function addressClass(checked: ReadonlyArray<ClassifiedAddress>): string {
  const kinds = checked.map((a) => addressLocality(modelAddressKind(a.address)));
  if (!kinds.length || kinds.includes(null)) return "refused";
  return kinds.includes("public") ? "public" : kinds.includes("private") ? "private" : "loopback";
}
