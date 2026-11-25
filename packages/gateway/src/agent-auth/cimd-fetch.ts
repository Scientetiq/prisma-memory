// Client metadata documents ("client passport") on the gateway: the download with its network policy and
// limits, the caches, the client resolver of https:// client ids, what readiness and the panel know of the downloads, and
// the administrator's probe. The rules of the document itself (admission, the reply, the document, KNOWN_CIMD, the cache
// lifetime, reason codes) are pure and live in packages/shared/src/oauth-as/cimd.ts; nothing here decides them again.
//
// Order of one lookup, and nothing before admission touches the network:
//   1. admission of the address by an agent_auth.cimd_hosts entry "host/prefix/" (or cimd_any_https) — on EVERY call,
//      cache hits included: a removed entry closes cached documents at once;
//   2. the positive cache (LRU 256, lifetime from Cache-Control clamped to 5 min … 3 days; an expired entry is never used,
//      also not when the new download fails: the document may have changed its return addresses);
//   3. the negative caches: this client_id for 60 s (404, an invalid or too large document), its host for 5 minutes
//      (403, 429, 5xx, TLS, DNS, timeout, refused connection, blocked address) — cimd_host_cooling, no network;
//   4. one flight per client_id: parallel sign-ins of one app wait for one download;
//   5. at most CIMD_HOST_PER_MIN downloads per host in any minute and CIMD_ADDRESS_PER_MIN per client address
//      (cimd_rate_limited, no network), and at most CIMD_MAX_INFLIGHT downloads at once per process (above — "busy": the
//      sign-in page is temporarily_unavailable, no waiting), of which documents that are not reserved (step 5a) hold at most
//      CIMD_MAX_INFLIGHT − CIMD_RESERVED_INFLIGHT (four slow made-up paths would otherwise take every slot
//      for 5 s at a time, and a pinned connector would be busy for everybody). Together with the path prefix of step 1 an anonymous GET
//      /oauth/authorize cannot turn the gateway into an amplifier against claude.ai or chatgpt.com: Cloudflare would
//      answer the gateway's address 403 for everybody;
//   5a. reserved documents (a deliberate deviation): the exact addresses of KNOWN_CIMD
//      and documents that validated before in this process under an agent_auth.cimd_hosts entry — and are under one NOW,
//      proven in the current generation (a proof does not outlive the entry it was earned under, nor a
//      save of agent_auth.*; a download that started before that save adds none) — are not counted in the
//      minutes of step 5 — single flight and the ≥ 5-minute cache already bound each of them to about one download per
//      lifetime — and only THEIR answers cool the host. A made-up path under a listed prefix (its path is the caller's
//      choice) uses up only the minute of the other made-up paths, and its 403, 429, 5xx, timeout or broken connection (a
//      WAF rule on that path) waits only that path for 60 s: otherwise 30 anonymous requests a minute, or one, would close
//      CIMD sign-in of claude.ai, ChatGPT, Claude Code and Codex for everybody. What fails before the path is sent — DNS, a
//      blocked address, the TLS handshake — is the host's whatever the path, and still cools it;
//   5b. a slot is held until the download has settled AND every DNS lookup it started has really finished (
//      the system resolver cannot be cancelled — a deadline ended the request, not the lookup, and the freed slot let
//      the next made-up host start another one while the old ones still queued for the same resolver threads). Closed
//      when in doubt: a lookup the resolver never ends keeps its slot, so lookups of documents that are not reserved
//      never exceed CIMD_MAX_INFLIGHT − CIMD_RESERVED_INFLIGHT and the kept slot stays for the reserved ones;
//   6. the download: GET through systemHttp of oidc.ts WITHOUT `ca` (Node's built-in roots — oidc.ca_cert and oauth.ca_cert
//      are about the sign-in provider, and with `ca` Node trusts nothing else: a private test CA would fail claude.ai),
//      with privateNetworks [] (oidc.private_networks are the provider's networks, not the apps'), every DNS answer
//      checked before connecting (oidcLookup: one private, loopback, link-local or metadata answer refuses the whole
//      lookup), no redirects (3xx is a refusal), no connection pool, 5 KiB, 5 s.
// Downloads run outside every database transaction: the callers resolve the client before they open one.
//
// State is per process (one gateway process — one fetcher, created lazily: oauth.ts, health.ts and the admin plane import
// this module, and a module-level instance could be read before store.ts finished loading in an import cycle). The
// positive and negative caches are the process cache of store.ts (agentAuthCimdCache), cleared by the policy step on every
// save of agent_auth.*; the fetcher's listener of that step also stops a download in flight from filling the cache.
//
// What the downloads tell readiness (information without refusal): cimd_last_failure per host of
// agent_auth.cimd_hosts — the last failed download of this process (a later good download of the same document, or of
// any document of the host when the failure was the host's, clears it); cimd_needs_egress — only on evidence: mode builtin,
// CIMD on, no download of this process has given a valid document yet, AND the last download of a listed host got no HTTP
// answer at all (EGRESS_EVIDENCE: TLS, DNS, timeout, network, blocked address). A fresh process — after every restart —
// has tried nothing and failed nothing, so it warns nobody (a rule of "no download has succeeded yet" would tell every
// employee "cannot download" before anything was tried and steer people away from the very sign-in that clears it). An HTTP answer (403, 429, 5xx, 404, an invalid document) is no egress problem — the host was reached — and its
// path under the prefix is the caller's choice: an anonymous GET /oauth/authorize must not be able to turn the warning on
// for everybody. Such failures stay in cimd_last_failure and on the sign-in page. Outside builtin the built-in server
// downloads nothing for sign-ins, so the flag is false there on every surface (the panel, like health and
// /me/connections/config). Nothing here is secret: document addresses are public.
import { AGENT_AUTH_PROBLEM_TEXT, agentAuthConfig, log, systemHttp, type OidcTransport, type Settings } from "@memory/shared";
import {
  admitCimdClientId, checkCimdDocument, checkCimdReply, cimdClientFor, cimdEnabled, cimdFailureScope, cimdPolicyFrom, isLoopbackRedirectUri,
  cimdRefusedDetails, cimdTransportReason, CIMD_ADDRESS_PER_MIN, CIMD_HOST_PER_MIN, CIMD_MAX_BYTES, CIMD_MAX_INFLIGHT, CIMD_REQUEST_HEADERS, CIMD_RESERVED_INFLIGHT,
  CIMD_TIMEOUT_MS, KNOWN_CIMD,
  type CimdDocument, type CimdPolicy, type CimdReason,
} from "@memory/shared/oauth-as";
// types only (erased): the authorize module imports oauth.ts at load time, and oauth.ts imports this module
import type { App } from "../context.ts";
import type { ClientResolver, ClientView, ResolvedClient } from "./routes-authorize.ts";
import { addressKey } from "../preauth.ts";
import { agentAuthCimdCache, CimdCache, cimdTtlSec } from "./store.ts";

type Getter = Pick<Settings, "get">;

/** Reasons of a download that got no HTTP answer from the host — the only evidence for cimd_needs_egress (header). */
const EGRESS_EVIDENCE: ReadonlySet<CimdReason> = new Set<CimdReason>(["tls", "dns", "timeout", "network", "address_blocked"]);

/** Hosts (and client addresses) whose minute window is kept (above — empty windows go first, then the oldest). */
const HOST_WINDOWS_MAX = 1024;
/** Documents that validated before and keep a budget of their own (step 5a of the header); the oldest go first. */
const PROVEN_MAX = 256;
/** Failures decided before the request path is sent (step 5a): the host's, whoever asked for which path. */
const BEFORE_THE_PATH: ReadonlySet<CimdReason> = new Set<CimdReason>(["dns", "address_blocked", "tls"]);
/** The exact document addresses of KNOWN_CIMD (not the patterns: an id of a pattern is the caller's choice). */
const PINNED_IDS: ReadonlySet<string> = new Set(KNOWN_CIMD.flatMap((r) => r.clientIds));
/** Hosts whose last failure is kept for readiness. */
const LAST_FAILURES_MAX = 256;
const MINUTE_MS = 60_000;
/** The fetcher's own deadline over the transport's (a transport that ignores timeoutMs must not hold a slot forever). */
const DEADLINE_SLACK_MS = 1000;

/** Why a document was not served, with what is known of the download (the page shows host and reason, step 4). */
export interface CimdFailure {
  reason: CimdReason;
  /** host of client_id when the address parses */
  host: string | null;
  status?: number;
  rule?: number;
  contentType?: string;
  bytes?: number;
  /** usable-line skips of a refused document */
  skipped?: number;
  /** the transport's error code of a TLS failure (the probe shows it) */
  tlsCode?: string;
  ms?: number;
  /** a download was attempted for this answer (false: admission, a negative cache, a limit) */
  network: boolean;
}
export type CimdLoad =
  | { ok: true; doc: CimdDocument; cached: boolean; status?: number; bytes?: number; ms?: number }
  | { ok: false; busy: true }
  | ({ ok: false; busy?: undefined } & CimdFailure);

/** The last failed download of a host (readiness, the panel: {host, at, reason, status, rule, client_id}). */
export interface CimdHostFailure { host: string; at: string; reason: CimdReason; status: number | null; rule: number | null; client_id: string; scope: "host" | "client" }

export interface CimdFetcherOptions {
  transport?: OidcTransport;
  cache?: CimdCache<CimdDocument>;
  now?: () => number;
  /** the transport's timeoutMs (5000); tests of a slow server pass less */
  timeoutMs?: number;
}

const errCode = (e: unknown): string | undefined => {
  const c = (e && typeof e === "object" ? (e as { code?: unknown }).code : undefined);
  return typeof c === "string" ? c.slice(0, 80) : undefined;
};

/**
 * The downloader of one process. load() serves sign-ins (caches, one flight); probe() serves the administrator (a real
 * download past the caches, but within the limits). Neither ever throws: a failure is an answer.
 */
export class CimdFetcher {
  readonly transport: OidcTransport;
  readonly cache: CimdCache<CimdDocument>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly flights = new Map<string, Promise<CimdLoad>>();
  private readonly windows = new Map<string, number[]>();
  private readonly addressWindows = new Map<string, number[]>();
  /** client_id → the generation it validated in (step 5a: a proof counts only in its own generation) */
  private readonly proven = new Map<string, number>();
  private readonly failures = new Map<string, CimdHostFailure>();
  private inflight = 0;
  /** of inflight: downloads of documents that are not reserved (step 5a) */
  private inflightOpen = 0;
  private succeeded = false;
  /** bumped by reset(): a download that started before it does not fill the cache */
  private generation = 0;

  constructor(o: CimdFetcherOptions = {}) {
    this.transport = o.transport ?? systemHttp;
    this.cache = o.cache ?? new CimdCache<CimdDocument>(undefined, o.now);
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? CIMD_TIMEOUT_MS;
  }

  /**
   * The document of client_id for a sign-in, under the policy of the current settings (steps 1–6 of the header). who — the
   * client address of the sign-in (addressKey), for the per-address minute; null or absent — not counted per address.
   */
  load(clientId: string, policy: CimdPolicy, o: { who?: string | null } = {}): Promise<CimdLoad> {
    // everything up to the flight is synchronous: callers of the same tick see one flight
    const adm = admitCimdClientId(clientId, policy);
    if (!adm.ok) return Promise.resolve({ ok: false, reason: adm.reason, host: adm.host, network: false });
    const hit = this.cache.get(clientId);
    if (hit) return Promise.resolve({ ok: true, doc: hit, cached: true });
    const neg = this.cache.failure(clientId, adm.host);
    if (neg) {
      return Promise.resolve(neg.scope === "host"
        ? { ok: false, reason: "cimd_host_cooling", host: adm.host, network: false }
        : { ok: false, reason: neg.reason as CimdReason, host: adm.host, network: false,
            ...(neg.status !== undefined ? { status: neg.status } : {}), ...(neg.rule !== undefined ? { rule: neg.rule } : {}) });
    }
    const joined = this.flights.get(clientId);
    if (joined) return joined;
    const flight = this.start(clientId, adm.host, { probe: false, listed: adm.entry !== null, who: o.who ?? null });
    if (flight.ok === false) return Promise.resolve(flight.load);
    this.flights.set(clientId, flight.promise);
    void flight.promise.finally(() => { if (this.flights.get(clientId) === flight.promise) this.flights.delete(clientId); });
    return flight.promise;
  }

  /**
   * The administrator's probe: admission, then a real download past the positive and negative caches and
   * without joining a flight, but within the per-host minute and the concurrency limit. It does not write the caches;
   * what it learns about the host goes to readiness like any other download of this process.
   */
  probe(clientId: string, policy: CimdPolicy): Promise<CimdLoad> {
    const adm = admitCimdClientId(clientId, policy);
    if (!adm.ok) return Promise.resolve({ ok: false, reason: adm.reason, host: adm.host, network: false });
    const flight = this.start(clientId, adm.host, { probe: true, listed: adm.entry !== null, who: null });
    return flight.ok ? flight.promise : Promise.resolve(flight.load);
  }

  /**
   * A reserved document (step 5a of the header): an exact KNOWN_CIMD address, or one that validated in this generation
   * under a listed host and is under a listed host now (`listed` — the admission of this call by agent_auth.cimd_hosts).
   */
  private reserved(clientId: string, listed: boolean): boolean {
    return PINNED_IDS.has(clientId) || (listed && this.proven.get(clientId) === this.generation);
  }

  /** Limits, then the download in the background of the returned promise (it never rejects). */
  private start(clientId: string, host: string, o: { probe: boolean; listed: boolean; who: string | null }): { ok: true; promise: Promise<CimdLoad> } | { ok: false; load: CimdLoad } {
    const t = this.now();
    const reserved = this.reserved(clientId, o.listed);
    const limited: CimdLoad = { ok: false, reason: "cimd_rate_limited", host, network: false };
    const fresh = (m: Map<string, number[]>, k: string) => (m.get(k) ?? []).filter((at) => t - at < MINUTE_MS);
    const w = reserved ? [] : fresh(this.windows, host);
    if (!reserved && w.length >= CIMD_HOST_PER_MIN) {
      this.windows.set(host, w);
      return { ok: false, load: limited };
    }
    const aw = reserved || o.who === null ? [] : fresh(this.addressWindows, o.who);
    if (!reserved && o.who !== null && aw.length >= CIMD_ADDRESS_PER_MIN) {
      this.addressWindows.set(o.who, aw);
      return { ok: false, load: limited };
    }
    // the ceiling for all; a document that is not reserved never takes the slots kept for the reserved ones
    if (this.inflight >= CIMD_MAX_INFLIGHT || (!reserved && this.inflightOpen >= CIMD_MAX_INFLIGHT - CIMD_RESERVED_INFLIGHT)) {
      return { ok: false, load: { ok: false, busy: true } };
    }
    if (!reserved) {
      w.push(t);
      this.keepWindow(this.windows, host, w);
      if (o.who !== null) { aw.push(t); this.keepWindow(this.addressWindows, o.who, aw); }
    }
    this.inflight++;
    if (!reserved) this.inflightOpen++;
    const gen = this.generation;
    // the slot belongs to the class it was taken in (a document may become proven while it downloads) and is held while the
    // download runs or any DNS lookup it started is unfinished (step 5b): a lookup reported after the download settled
    // takes the slot again until it ends
    let holds = 1;
    const take = () => { if (holds++ === 0) { this.inflight++; if (!reserved) this.inflightOpen++; } };
    const drop = () => { if (--holds === 0) { this.inflight--; if (!reserved) this.inflightOpen--; } };
    const onLookup = (settled: Promise<void>) => { take(); void settled.then(drop, drop); };
    const promise = this.download(clientId, host, o.probe, o.listed, gen, onLookup).finally(drop);
    return { ok: true, promise };
  }

  private keepWindow(windows: Map<string, number[]>, key: string, w: number[]): void {
    windows.delete(key);
    windows.set(key, w);
    if (windows.size <= HOST_WINDOWS_MAX) return;
    const t = this.now();
    for (const [k, v] of windows) {
      if (windows.size <= HOST_WINDOWS_MAX) return;
      if (k !== key && v.every((at) => t - at >= MINUTE_MS)) windows.delete(k);
    }
    for (const k of windows.keys()) {
      if (windows.size <= HOST_WINDOWS_MAX) return;
      if (k !== key) windows.delete(k);
    }
  }

  private async download(clientId: string, host: string, probe: boolean, listed: boolean, gen: number, onLookup: (settled: Promise<void>) => void): Promise<CimdLoad> {
    const t0 = this.now();
    const ms = () => Math.max(0, Math.round(this.now() - t0));
    let reply: Awaited<ReturnType<OidcTransport["request"]>>;
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`no answer in ${this.timeoutMs} ms`), { code: "OIDC_TIMEOUT" })), this.timeoutMs + DEADLINE_SLACK_MS);
        timer.unref?.();
      });
      // no `ca`: the built-in roots of Node; no private networks of the sign-in provider; at most 5 KiB
      reply = await Promise.race([this.transport.request(new URL(clientId), {
        method: "GET", headers: { ...CIMD_REQUEST_HEADERS }, timeoutMs: this.timeoutMs, privateNetworks: [], maxBytes: CIMD_MAX_BYTES, onLookup,
      }), deadline]);
    } catch (e) {
      const reason = cimdTransportReason(e);
      const limit = e && typeof e === "object" ? (e as { bodyLimit?: unknown }).bodyLimit : undefined;
      return this.failed(clientId, probe, listed, gen, { reason, host, network: true, ms: ms(),
        ...(reason === "tls" && errCode(e) ? { tlsCode: errCode(e) } : {}),
        ...(typeof limit === "number" ? { bytes: limit + 1 } : {}) });
    } finally {
      clearTimeout(timer);
    }
    const r = checkCimdReply(reply);
    if (!r.ok) {
      return this.failed(clientId, probe, listed, gen, { reason: r.reason, host, network: true, status: r.status, bytes: r.bytes, contentType: r.contentType, ms: ms(),
        ...(r.rule !== undefined ? { rule: r.rule } : {}) });
    }
    const d = checkCimdDocument(clientId, r.json);
    if (!d.ok) {
      return this.failed(clientId, probe, listed, gen, { reason: d.reason, host, network: true, status: reply.status, rule: d.rule, bytes: r.bytes,
        contentType: String(reply.contentType ?? "").slice(0, 100), skipped: d.skipped, ms: ms() });
    }
    this.succeeded = true;
    // a valid document under the administrator's list earns a budget of its own (step 5a); cimd_any_https alone does not,
    // nor a download that started before a save of agent_auth.* (its admission may be gone)
    if (listed && !probe && gen === this.generation) {
      this.proven.delete(clientId);
      this.proven.set(clientId, gen);
      while (this.proven.size > PROVEN_MAX) { const k = this.proven.keys().next().value; if (k === undefined) break; this.proven.delete(k); }
    }
    const f = this.failures.get(host);
    if (f && (f.client_id === clientId || f.scope === "host")) this.failures.delete(host);
    if (!probe && gen === this.generation) this.cache.set(clientId, d.doc, cimdTtlSec(reply.cacheControl));
    return { ok: true, doc: d.doc, cached: false, status: reply.status, bytes: r.bytes, ms: ms() };
  }

  private failed(clientId: string, probe: boolean, listed: boolean, gen: number, f: CimdFailure): CimdLoad {
    // only a reserved document's answer speaks for the whole host (step 5a): a made-up path waits alone, unless the failure
    // came before its path was sent
    const byReason = cimdFailureScope(f.reason, f.status);
    const scope = byReason === "host" && !this.reserved(clientId, listed) && !BEFORE_THE_PATH.has(f.reason) ? "client" : byReason;
    if (scope && f.host) {
      if (!probe && gen === this.generation) {
        this.cache.fail(clientId, f.host, f.reason, { host: scope === "host", ...(f.status !== undefined ? { status: f.status } : {}), ...(f.rule !== undefined ? { rule: f.rule } : {}) });
      }
      this.failures.delete(f.host);
      this.failures.set(f.host, { host: f.host, at: new Date(this.now()).toISOString(), reason: f.reason, status: f.status ?? null, rule: f.rule ?? null,
        client_id: clientId.slice(0, 255), scope });
      while (this.failures.size > LAST_FAILURES_MAX) { const k = this.failures.keys().next().value; if (k === undefined) break; this.failures.delete(k); }
    }
    return { ok: false, ...f };
  }

  /**
   * On every save of agent_auth.* (the policy step): forget documents, failures and the proofs of step 5a (a proof is of
   * its generation); a download in flight caches nothing and proves nothing.
   */
  reset(): void {
    this.generation++;
    this.cache.clear();
    this.proven.clear();
  }

  /**
   * Readiness of the downloads for the current settings: the last failures of listed hosts, and
   * cimd_needs_egress — builtin, CIMD on, nothing valid downloaded yet and a listed host's last download got no answer
   * (the header: evidence, not "not tried yet").
   */
  readiness(settings: Getter): { cimd_needs_egress: boolean; cimd_last_failure: CimdHostFailure[] } {
    const cfg = agentAuthConfig(settings);
    const policy = cimdPolicyFrom(cfg.cimd_hosts, cfg.cimd_any_https);
    const listed = new Set(policy.hosts.map((h) => h.host));
    const last = [...this.failures.values()].filter((f) => listed.has(f.host)).sort((a, b) => a.host.localeCompare(b.host));
    return {
      cimd_needs_egress: cfg.mode === "builtin" && cimdEnabled(policy) && !this.succeeded && last.some((f) => EGRESS_EVIDENCE.has(f.reason)),
      cimd_last_failure: last,
    };
  }

  /** Downloads running now (tests and the panel). */
  get running(): number { return this.inflight; }
  /** Of them, downloads of documents that are not reserved (tests). */
  get runningOpen(): number { return this.inflightOpen; }
}

let processFetcher: CimdFetcher | null = null;
/** The fetcher of this gateway process (systemHttp, the process cache of store.ts). */
export function agentAuthCimd(): CimdFetcher {
  // the process cache holds only what this fetcher put there: validated documents
  return (processFetcher ??= new CimdFetcher({ cache: agentAuthCimdCache as CimdCache<CimdDocument> }));
}
/** Tests: replace the process fetcher (null — a fresh one with systemHttp on next use). */
export function setAgentAuthCimdForTests(f: CimdFetcher | null): void { processFetcher = f; }

export const cimdReadiness = (settings: Getter): ReturnType<CimdFetcher["readiness"]> => agentAuthCimd().readiness(settings);

/**
 * The addition to the detail of the health check `oauth` in builtin (information without refusal — the status of
 * the check does not change): cimd_needs_egress with its remedy, then the last failure of each listed host. null — nothing
 * to say.
 */
export function cimdHealthNote(settings: Getter, fetcher: CimdFetcher = agentAuthCimd()): string | null {
  const r = fetcher.readiness(settings);
  const parts: string[] = [];
  if (r.cimd_needs_egress) parts.push(`cimd_needs_egress — ${AGENT_AUTH_PROBLEM_TEXT.cimd_needs_egress}`);
  for (const f of r.cimd_last_failure.slice(0, 5)) {
    parts.push(`cimd_last_failure ${f.host}: ${f.reason}${f.status !== null ? ` (HTTP ${f.status})` : ""}${f.rule !== null ? ` (rule ${f.rule})` : ""} at ${f.at}`);
  }
  return parts.length ? parts.join("; ").slice(0, 600) : null;
}

/** The policy of client metadata documents from settings. */
export function cimdPolicyOf(settings: Getter): CimdPolicy {
  const cfg = agentAuthConfig(settings);
  return cimdPolicyFrom(cfg.cimd_hosts, cfg.cimd_any_https);
}

// ---------------------------------------------------------------- the client of a document (resolveClient, step 4)

/**
 * The client of a valid document: the consent view for one return address — "known" only for the exact
 * document address (or a pinned pattern) together with a pinned return address of this transaction; otherwise the host of
 * client_id names the app, never the self-chosen client_name (that is only "It calls itself …").
 */
export function cimdClient(doc: CimdDocument, listed: boolean): ResolvedClient {
  return {
    id: doc.clientId, source: "cimd",
    view(redirectUri): ClientView | null {
      const v = cimdClientFor(doc, redirectUri);
      // errors before consent go back only to a document the administrator's list admits, or to loopback (RFC 9700 §4.11.2):
      // under cimd_any_https alone the document's https addresses are whoever wrote it
      return v ? { kind: v.kind, title: v.title, known: v.known, name: v.name, label: v.title, redirect: v.redirect,
        redirectTrusted: listed || isLoopbackRedirectUri(v.redirect.uri) } : null;
    },
  };
}

/** Writes one refusal event with the throttle of noteAuthFailure (the authorize side's noteRefusal). */
export type RefusalNote = (app: App, ip: string | null, details: Record<string, unknown>) => Promise<void>;

/**
 * The resolver of https:// client ids for resolveClient (setClientResolver("cimd", …), routes.ts). Every refusal is the
 * audit event auth_failure {op: "oauth_cimd_refused", client_id, host, reason, status, rule, content_type, bytes,
 * skipped_lines}, throttled per address; "busy" (too many downloads at once) is not the app's fault and is
 * answered temporarily_unavailable by the page.
 */
export function cimdResolver(note: RefusalNote, fetcher: () => CimdFetcher = agentAuthCimd): ClientResolver {
  return async (app, clientId, settings, ctx) => {
    const policy = cimdPolicyOf(settings);
    const r = await fetcher().load(clientId, policy, { who: ctx?.ip ? addressKey(ctx.ip) : null });
    if (r.ok) {
      const adm = admitCimdClientId(clientId, policy);
      return { ok: true, client: cimdClient(r.doc, adm.ok && adm.entry !== null) };
    }
    if (r.busy) return { ok: false, busy: true };
    try {
      await note(app, ctx?.ip ?? null, cimdRefusedDetails({ clientId, host: r.host, reason: r.reason, status: r.status, rule: r.rule,
        contentType: r.contentType, bytes: r.bytes, skipped: r.skipped }));
    } catch (e) {
      log.warn("agent_auth_cimd_event_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
    }
    return { ok: false, cimd: { host: r.host, reason: r.reason, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.rule !== undefined ? { rule: r.rule } : {}) } };
  };
}

// ---------------------------------------------------------------- the administrator's probe

export interface CimdProbeAnswer {
  ok: boolean;
  problem?: CimdReason;
  kind?: string;
  title?: string;
  known?: boolean;
  redirect_uris?: string[];
  skipped_lines?: number;
  status?: number;
  rule?: number;
  bytes?: number;
  ms?: number;
  tls_code?: string;
}

/**
 * POST /api/v1/admin/agent-auth/cimd-probe {url}: –3.4 with a real download past the cache, within the limits of.
 * The app as a sign-in would show it: the first usable return address that makes it known, else the first one. null —
 * too many downloads at once (the route answers 429 with Retry-After).
 */
export async function probeCimd(url: string, settings: Getter, fetcher: CimdFetcher = agentAuthCimd()): Promise<CimdProbeAnswer | null> {
  const r = await fetcher.probe(url, cimdPolicyOf(settings));
  if (!r.ok && r.busy) return null;
  if (!r.ok) {
    return { ok: false, problem: r.reason, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.rule !== undefined ? { rule: r.rule } : {}),
      ...(r.skipped !== undefined ? { skipped_lines: r.skipped } : {}), ...(r.bytes !== undefined ? { bytes: r.bytes } : {}), ...(r.ms !== undefined ? { ms: r.ms } : {}),
      ...(r.tlsCode ? { tls_code: r.tlsCode } : {}) };
  }
  const views = r.doc.lines.map((l) => cimdClientFor(r.doc, l.uri)).filter((v): v is NonNullable<typeof v> => v !== null);
  const v = views.find((x) => x.known) ?? views[0];
  return {
    ok: true, ...(v ? { kind: v.kind, title: v.title, known: v.known } : {}), redirect_uris: r.doc.lines.map((l) => l.uri),
    skipped_lines: r.doc.skipped.length, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
    ...(r.ms !== undefined ? { ms: r.ms } : {}),
  };
}
