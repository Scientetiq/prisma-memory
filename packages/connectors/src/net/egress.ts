// The outbound HTTP client of connectors. A connector reaches the world only through ConnectorCtx.http; the
// runtime builds this client for it with the exact origins of the connector's manifest and the private networks of the
// installation. Every refusal is a stable code (EGRESS_CODES), never a text: the address rules of @memory/shared are
// used as decisions only, their (OIDC-specific) wording never leaves this module.
//
// Policy, checked for every request and for every redirect hop, first failure wins:
//   request shape → URL → scheme (http, https) → exact origin (scheme, host, port) → address of an IP literal, or every
//   DNS answer of a name. Loopback, link-local, cloud metadata, multicast, broadcast, unspecified and reserved addresses
//   are always refused; private addresses only inside integrations.connectors_private_networks; plain http only to an
//   allowed private address. The socket connects to the checked answers (no second resolution). No connection pool, no
//   proxy from the environment, no redirects unless the runtime opts in (≤ 3, GET and HEAD only), one total deadline for
//   DNS, redirects and body, a body cap, no compression.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type ClientRequest, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { oidcAddressKind, oidcAddressRefusal, oidcLookup, privateNetworkProblem, type OidcResolve } from "@memory/shared";
import { NO_EGRESS_HOST } from "../sdk/manifest.ts";
import type { ConnectorManifest, EgressClient, EgressRequest, EgressResponse } from "../sdk/types.ts";
import { retryAfterSec } from "../sdk/errors.ts";
import { markCore } from "../failure.ts";

export const EGRESS_CODES = [
  "egress_blocked:url", "egress_blocked:scheme", "egress_blocked:host", "egress_blocked:private", "egress_blocked:loopback",
  "egress_blocked:link_local", "egress_blocked:metadata", "egress_blocked:reserved", "egress_blocked:redirect", "egress_request_invalid",
  "egress_dns", "egress_tls", "egress_unreachable", "egress_timeout", "egress_too_large", "egress_aborted", "egress_bad_json",
] as const;
export type EgressCode = (typeof EGRESS_CODES)[number];

/** A refusal or a failure of the egress client: the message is the code, nothing else (no URL, path, query or cause). */
export class EgressError extends Error {
  readonly code: EgressCode;
  /**
   * The host name of the request when the URL was parsed (never the path or the query); null otherwise. Not enumerable
   * a JSON copy, a spread or util.inspect of the error does not carry the address.
   */
  declare readonly host: string | null;
  constructor(code: EgressCode, host: string | null = null) {
    super(code);
    this.name = "EgressError";
    this.code = code;
    Object.defineProperty(this, "host", { value: host, enumerable: false, writable: false, configurable: false });
  }
}
/** An EgressError built by the egress client itself: marked as the core's, so the runner stores its code. */
const egressError = (code: EgressCode, host: string | null = null): EgressError => markCore(new EgressError(code, host), code);

/** A refusal by the policy (a configuration problem): the scheduler sets the connector to error at once, without retries. */
export const isEgressConfigError = (code: string): boolean => code.startsWith("egress_blocked:");

export interface EgressOptions {
  /** Exact URL origins (scheme://host[:port]) the connector may reach — from allowedOrigins(). */
  origins: readonly string[];
  /** integrations.connectors_private_networks, read on every request (a settings change applies without a restart). */
  privateNetworks: () => readonly string[];
  /** Body cap of the client, 1 … 67 108 864 bytes; a request's own maxBytes (default 1 MiB) cannot exceed it. */
  maxResponseBytes: number;
  /** Redirect hops the client follows (GET and HEAD only); default 0 — a 3xx answer is returned as it is. */
  maxRedirects?: 0 | 1 | 2 | 3;
  /** The run's signal: an abort ends the request with egress_aborted. */
  signal?: AbortSignal;
  /** Tests only: a resolver instead of the system DNS, and loopback addresses allowed (local test servers). */
  test?: { resolve?: OidcResolve; allowLoopback?: boolean };
}

const DEFAULT_MAX_BYTES = 1_048_576;
const CLIENT_MAX_BYTES = 67_108_864;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const METHODS = new Set(["GET", "POST", "PUT", "HEAD"]);
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect",
  "proxy-authorization", "proxy-connection", "accept-encoding"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HEADER_VALUE_BAD = /[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-\u00ff]/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TLS_CODE = /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO|EPROTO|HANDSHAKE/i;
const DNS_CODE = /^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME|EAI_FAIL|ENODATA|ESERVFAIL)$/;

// Addresses the shared rules do not know yet: cloud metadata in IPv6 (GCP, OpenStack), prefixes that translate to an
// IPv4 address we cannot check (local-use NAT64, 6to4, Teredo, IPv4-translated) and the non-global special-purpose
// ranges of RFC 6890 (IETF protocol assignments, benchmarking, documentation, the 6to4 relay anycast, the discard prefix,
// ORCHID). A BlockList applies its IPv4 rules to IPv4-mapped IPv6 addresses too.
const OWN_METADATA = new BlockList();
OWN_METADATA.addAddress("fd20:ce::254", "ipv6");
OWN_METADATA.addAddress("fd00:c1::a9fe:a9fe", "ipv6");
const OWN_RESERVED = new BlockList();
OWN_RESERVED.addSubnet("64:ff9b:1::", 48, "ipv6");
OWN_RESERVED.addSubnet("2002::", 16, "ipv6");
OWN_RESERVED.addSubnet("2001::", 32, "ipv6");
OWN_RESERVED.addSubnet("2001:db8::", 32, "ipv6");
OWN_RESERVED.addSubnet("2001:10::", 28, "ipv6");
OWN_RESERVED.addSubnet("2001:20::", 28, "ipv6");
OWN_RESERVED.addSubnet("100::", 64, "ipv6");
OWN_RESERVED.addSubnet("::ffff:0:0:0", 96, "ipv6");
for (const [net, bits] of [["192.0.0.0", 24], ["192.0.2.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["192.88.99.0", 24]] as const)
  OWN_RESERVED.addSubnet(net, bits, "ipv4");

export interface EgressAddressPolicy {
  privateNetworks: readonly string[];
  /** The scheme of the request: plain http is allowed only to an allowed private address. */
  scheme: "http:" | "https:";
  /** Tests only. */
  allowLoopback?: boolean;
}

/** The decision for one address: null — the client may connect; otherwise the code of the refusal. */
export function egressAddressCode(ip: string, p: EgressAddressPolicy): EgressCode | null {
  const family = isIP(ip);
  if (family === 0) return "egress_blocked:reserved";
  if (family === 6 && OWN_METADATA.check(ip, "ipv6")) return "egress_blocked:metadata";
  if (OWN_RESERVED.check(ip, family === 6 ? "ipv6" : "ipv4")) return "egress_blocked:reserved";
  const kind = oidcAddressKind(ip);
  const allowLoopback = p.allowLoopback === true;
  if (oidcAddressRefusal(ip, { privateNetworks: validNetworks(p.privateNetworks), allowLoopback }) !== null) {
    switch (kind) {
      case "private": return "egress_blocked:private";
      case "loopback": return "egress_blocked:loopback";
      case "link_local": return "egress_blocked:link_local";
      case "metadata": return "egress_blocked:metadata";
      default: return "egress_blocked:reserved";
    }
  }
  if (p.scheme === "http:" && kind !== "private" && !(kind === "loopback" && allowLoopback)) return "egress_blocked:scheme";
  return null;
}

/** The checked resolver: every answer of the name passes egressAddressCode, the first refused one names the code. */
function checkedResolve(base: OidcResolve, p: () => EgressAddressPolicy, onBlocked: (code: EgressCode) => void): OidcResolve {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list: LookupAddress[] = Array.isArray(addresses) ? addresses : [];
      const policy = p();
      for (const a of list) {
        const code = egressAddressCode(a.address, policy);
        if (code) {
          onBlocked(code);
          return callback(egressError(code) as unknown as NodeJS.ErrnoException, []);
        }
      }
      return callback(null, list);
    });
  };
}

const systemResolve: OidcResolve = (hostname, options, callback) => dnsLookup(hostname, options, callback);

/** The checked lookup for one policy: oidcLookup pins the socket to the answers checkedResolve accepted. */
function policyLookup(base: OidcResolve, nets: EgressAddressPolicy, onBlocked: (code: EgressCode) => void): LookupFunction {
  const inner = oidcLookup({ privateNetworks: nets.privateNetworks, allowLoopback: nets.allowLoopback === true }, checkedResolve(base, () => nets, onBlocked));
  // oidcLookup checks the answers once more (never stricter than egressAddressCode); its own refusal carries a text that
  // must not leave this module, so it becomes a code here.
  return ((hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void) => {
    (inner as unknown as (h: string, o: unknown, cb: (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void) => void)(hostname, options, (err, ...rest) => {
      if (err && !(err instanceof EgressError)) {
        if (err.code === "OIDC_ADDRESS_BLOCKED") {
          onBlocked("egress_blocked:reserved");
          err = egressError("egress_blocked:reserved") as unknown as NodeJS.ErrnoException;
        } else {
          const code = DNS_CODE.test(err.code ?? "") ? "egress_dns" : "egress_unreachable";
          err = Object.assign(new Error(code), { code: err.code });   // the resolver's code, never its text
        }
      }
      callback(err, ...rest);
    });
  }) as unknown as LookupFunction;
}

/**
 * A lookup function with the same checks (for clients that take an http(s).Agent, such as the object storage client of
 * the s3 connector): a refusal fails the lookup with an EgressError that carries the code. The caller still checks IP
 * literal hosts itself (Node does not call lookup for them) — egressAddressCode.
 */
export function egressLookup(o: Pick<EgressOptions, "privateNetworks" | "test"> & { scheme?: "http:" | "https:" }): LookupFunction {
  const base = o.test?.resolve ?? systemResolve;
  return ((hostname: string, options: unknown, callback: unknown) => {
    const nets: EgressAddressPolicy = { privateNetworks: readNetworks(o.privateNetworks), scheme: o.scheme ?? "https:", allowLoopback: o.test?.allowLoopback === true };
    (policyLookup(base, nets, () => undefined) as unknown as (h: string, o: unknown, cb: unknown) => void)(hostname, options, callback);
  }) as unknown as LookupFunction;
}

/**
 * The entries of the private networks list that the setting itself accepts (an address or a CIDR inside a private range:
 * no /0, no prefix wider than the range, no public network); others open nothing, also when a row reached the table
 * around the setting's own check (a restore, direct SQL).
 */
function validNetworks(list: readonly unknown[]): string[] {
  return list.filter((x): x is string => typeof x === "string" && privateNetworkProblem(x) === null);
}

/** The private networks setting as a list of strings; a failing reader gives none (private targets refused). */
function readNetworks(read: () => readonly string[]): readonly string[] {
  try { const v = read(); return Array.isArray(v) ? validNetworks(v) : []; } catch { return []; }
}

/** The exact origins a connector may reach: its fixed vendor hosts over https, or the origin of its configured URL. */
export function allowedOrigins(manifest: ConnectorManifest, config: unknown): string[] {
  const e = manifest.egress as { hosts?: unknown; hostFromConfig?: unknown };
  if (Array.isArray(e.hosts)) {
    const out = new Set<string>();
    for (const h of e.hosts) {
      if (typeof h !== "string" || h === NO_EGRESS_HOST) continue;
      try {
        const u = new URL(`https://${h}`);
        if (u.hostname && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash) out.add(u.origin);
      } catch { /* a bad host gives no origin */ }
    }
    return [...out];
  }
  if (typeof e.hostFromConfig === "string" && config && typeof config === "object") {
    const raw = (config as Record<string, unknown>)[e.hostFromConfig];
    if (typeof raw !== "string") return [];
    try {
      const u = new URL(raw);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname && !u.username && !u.password && u.port !== "0") return [u.origin];
    } catch { /* not a URL */ }
  }
  return [];
}

// Retry-After of a response: defined beside ConnectorError (the SDK reads it without the runtime), the same function here
export { retryAfterSec };

// ---------------------------------------------------------------- the client

interface Target { url: URL; host: string; literal: boolean }

/** The URL checks before any connection; throws the code of the first failure. */
function checkUrl(raw: string | URL, origins: ReadonlySet<string>, policy: () => EgressAddressPolicy): Target {
  let url: URL;
  try { url = typeof raw === "string" ? new URL(raw) : raw; } catch { throw egressError("egress_blocked:url"); }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw egressError("egress_blocked:scheme", host || null);
  if (url.username || url.password || url.port === "0" || !host) throw egressError("egress_blocked:url", host || null);
  if (!origins.has(url.origin)) throw egressError("egress_blocked:host", host);
  const literal = isIP(host) !== 0;
  if (literal) {
    const code = egressAddressCode(host, { ...policy(), scheme: url.protocol as "http:" | "https:" });
    if (code) throw egressError(code, host);
  }
  return { url, host, literal };
}

function checkRequest(req: EgressRequest): void {
  const bad = (): never => { throw egressError("egress_request_invalid"); };
  if (!req || typeof req !== "object" || typeof req.url !== "string") bad();
  if (!METHODS.has(req.method)) bad();
  if (req.body !== undefined && req.method !== "POST" && req.method !== "PUT") bad();
  if (req.body !== undefined && typeof req.body !== "string" && !(req.body instanceof Uint8Array)) bad();
  if (req.maxBytes !== undefined && !(Number.isSafeInteger(req.maxBytes) && req.maxBytes > 0)) bad();
  if (req.timeoutMs !== undefined && !(Number.isFinite(req.timeoutMs) && req.timeoutMs > 0)) bad();
  if (req.headers !== undefined) {
    if (typeof req.headers !== "object" || req.headers === null || Array.isArray(req.headers)) bad();
    for (const [k, v] of Object.entries(req.headers)) {
      if (!TOKEN.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) bad();
      if (typeof v !== "string" || v.length > 8192 || HEADER_VALUE_BAD.test(v)) bad();
    }
  }
}

function joinHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function makeResponse(status: number, headers: Record<string, string>, body: Uint8Array): EgressResponse {
  return {
    status, headers, body,
    text: () => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"),
    json: () => {
      try { return JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")) as unknown; }
      catch { throw egressError("egress_bad_json"); }
    },
  };
}

/** One call's shared state: the total deadline, the run's signal and the request in flight. */
class Call {
  timedOut = false;
  aborted = false;
  private current: ClientRequest | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly onAbort = () => { this.aborted = true; this.current?.destroy(); };
  constructor(timeoutMs: number, private readonly signal: AbortSignal | undefined) {
    this.timer = setTimeout(() => { this.timedOut = true; this.current?.destroy(); }, timeoutMs);
    if (signal?.aborted) this.aborted = true;
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }
  track(r: ClientRequest | null): void { this.current = r; if (r && (this.aborted || this.timedOut)) r.destroy(); }
  /** The code when the deadline or the signal ended the call. */
  stopped(): EgressCode | null { return this.aborted ? "egress_aborted" : this.timedOut ? "egress_timeout" : null; }
  done(): void { clearTimeout(this.timer); this.signal?.removeEventListener("abort", this.onAbort); this.current = null; }
}

function failureCode(e: unknown): EgressCode {
  if (e instanceof EgressError) return e.code;
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "";
  if (code === "OIDC_ADDRESS_BLOCKED") return "egress_blocked:reserved";
  if (DNS_CODE.test(code)) return "egress_dns";
  if (TLS_CODE.test(code)) return "egress_tls";
  return "egress_unreachable";
}

/** Builds the egress client of one connector run. */
export function createEgressClient(o: EgressOptions): EgressClient {
  if (!Number.isSafeInteger(o.maxResponseBytes) || o.maxResponseBytes < 1 || o.maxResponseBytes > CLIENT_MAX_BYTES)
    throw new RangeError("maxResponseBytes must be an integer from 1 to 67108864");
  const maxRedirects = o.maxRedirects ?? 0;
  if (![0, 1, 2, 3].includes(maxRedirects)) throw new RangeError("maxRedirects must be 0, 1, 2 or 3");
  const origins = new Set<string>();
  for (const x of o.origins) {
    try { const u = new URL(x); if (u.protocol === "https:" || u.protocol === "http:") origins.add(u.origin); } catch { /* ignored */ }
  }
  const allowLoopback = o.test?.allowLoopback === true;
  const base = o.test?.resolve ?? systemResolve;
  const policy = (): EgressAddressPolicy => ({ privateNetworks: readNetworks(o.privateNetworks), scheme: "https:", allowLoopback });

  /** One hop: connect, send, read the body under the cap. */
  function hop(t: Target, method: EgressRequest["method"], headers: Record<string, string>, body: Buffer | undefined, cap: number, call: Call,
               nets: EgressAddressPolicy): Promise<EgressResponse> {
    return new Promise<EgressResponse>((resolve, reject) => {
      let settled = false, blocked: EgressCode | null = null;
      const isHttps = t.url.protocol === "https:";
      // keepAlive false with the default maxSockets: Node then sends "Connection: close" (a finite maxSockets makes it
      // announce keep-alive although the agent is destroyed after the answer)
      const agent = isHttps ? new HttpsAgent({ keepAlive: false, rejectUnauthorized: true, minVersion: "TLSv1.2" }) : new HttpAgent({ keepAlive: false });
      const finish = (fn: () => void) => { if (settled) return; settled = true; call.track(null); fn(); queueMicrotask(() => agent.destroy()); };
      const fail = (e: unknown) => finish(() => reject(egressError(call.stopped() ?? blocked ?? failureCode(e), t.host)));
      const scheme = t.url.protocol as "http:" | "https:";
      const lookup = policyLookup(base, { ...nets, scheme }, (c) => { blocked = c; });
      const opts: RequestOptions = {
        protocol: t.url.protocol, hostname: t.host, port: t.url.port || undefined, path: `${t.url.pathname}${t.url.search}`, method,
        headers: { ...headers, "accept-encoding": "identity", "user-agent": "memory-connectors", ...(body ? { "content-length": String(body.length) } : {}) },
        agent, ...(t.literal ? {} : { lookup }),
      };
      let req: ClientRequest;
      try { req = (isHttps ? httpsRequest : httpRequest)(opts); } catch (e) { fail(e); return; }
      call.track(req);
      req.on("error", fail);
      req.on("response", (res) => {
        res.on("error", fail);
        const status = res.statusCode ?? 0;
        const declared = res.headers["content-length"];
        if (method !== "HEAD" && declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > cap) {
          finish(() => reject(egressError("egress_too_large", t.host)));
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        // Over the cap: reject at once. When the overflowing chunk is also the last one, "end" fires before the destroy
        // settles anything, so "end" after an overflow resolves nothing (a truncated body never resolves).
        res.on("data", (c: Buffer) => {
          if (size > cap) return;
          size += c.length;
          if (size > cap) { finish(() => reject(egressError("egress_too_large", t.host))); req.destroy(); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          if (size > cap) return;
          const stopped = call.stopped();
          if (stopped) { finish(() => reject(egressError(stopped, t.host))); return; }
          // a copy: a small Buffer.concat result is a view of Node's shared pool, and .buffer of a view would expose it
          const bytes = new Uint8Array(Buffer.concat(chunks));
          finish(() => resolve(makeResponse(status, joinHeaders(res), bytes)));
        });
        res.on("close", () => { if (!res.complete) fail(Object.assign(new Error("closed"), { code: "ECONNRESET" })); });
      });
      if (body) req.write(body);
      req.end();
    });
  }

  return {
    async request(req: EgressRequest): Promise<EgressResponse> {
      checkRequest(req);
      const cap = Math.min(req.maxBytes ?? DEFAULT_MAX_BYTES, o.maxResponseBytes);
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
      const nets = policy();
      let target = checkUrl(req.url, origins, () => nets);
      const body = req.body === undefined ? undefined : typeof req.body === "string" ? Buffer.from(req.body, "utf8") : Buffer.from(req.body);
      let headers: Record<string, string> = { ...(req.headers ?? {}) };
      const call = new Call(timeoutMs, o.signal);
      try {
        if (call.aborted) throw egressError("egress_aborted", target.host);
        for (let n = 0; ; n++) {
          const res = await hop(target, req.method, headers, body, cap, call, nets);
          const follow = maxRedirects > 0 && REDIRECTS.has(res.status) && (req.method === "GET" || req.method === "HEAD");
          if (!follow) return res;
          if (n >= maxRedirects) throw egressError("egress_blocked:redirect", target.host);
          const location = res.headers.location;
          let next: URL;
          try { if (!location) throw new Error("none"); next = new URL(location, target.url); } catch { throw egressError("egress_blocked:redirect", target.host); }
          const crossOrigin = next.origin !== target.url.origin;
          target = checkUrl(next, origins, () => nets);
          if (crossOrigin) {
            const keep: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "accept") keep[k] = v;
            headers = keep;
          }
        }
      } finally {
        call.done();
      }
    },
  };
}
