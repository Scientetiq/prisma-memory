import { createHash, randomUUID } from "node:crypto";
import { constants as zlibConstants, inflateSync } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import type { ConverterStepPoint } from "./converter-fault.ts";
import { ConverterSession, converterSettingsFingerprint, type ConverterLoginResult } from "./converter-session.ts";
import { log } from "./log.ts";
import type { Settings } from "./settings.ts";

export const CONVERTIBLE_MIME = new Set(["application/pdf"]);

export const CONVERTER_ROLES = ["admin_upload", "export_manager"] as const;

export const CONVERTER_FAST_PROFILE = "fast-extraction";
export const CONVERTER_FAST_LANE_PROFILE = "fast-lane";

export const CONVERTER_EXPORT_PROFILES = ["DRAFT_UNCERTIFIED", "MARKDOWN_PACKAGE"] as const;
export type ConverterExportProfile = typeof CONVERTER_EXPORT_PROFILES[number];
export const UNCERTIFIED_EXPORT_PROFILES = new Set<string>(["DRAFT_UNCERTIFIED"]);
export const CONVERTER_MARKDOWN_ENTRY = "document.md";
export const CONVERTER_UNCERTIFIED_ENTRY = "НЕ-СЕРТИФИЦИРОВАНО.md";
export const CONVERTER_CONVERSION_ENTRY = "conversion.json";
export const DC_FAST_LANE_MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;
export const DC_FAST_LANE_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export type RunStatus =
  | "ACCEPTED" | "PROCESSING" | "VERIFYING" | "FAIL_RETRYABLE"
  | "PASS_AUTOMATED" | "REJECTED_AUTOMATED" | "NEEDS_REVIEW" | "PASS_WITH_REVIEW" | "CANCELLED";

export const RUN_READY = new Set<RunStatus>(["PASS_AUTOMATED", "PASS_WITH_REVIEW", "NEEDS_REVIEW", "REJECTED_AUTOMATED"]);
export const RUN_REFUSED = new Set<RunStatus>(["CANCELLED"]);
export const RUN_CERTIFIED = new Set<RunStatus>(["PASS_AUTOMATED", "PASS_WITH_REVIEW"]);
export const RUN_UNCERTIFIED = new Set<RunStatus>(["REJECTED_AUTOMATED", "NEEDS_REVIEW"]);

export function chooseExportProfile(verdict: RunStatus): ConverterExportProfile | null {
  if (RUN_UNCERTIFIED.has(verdict)) return "DRAFT_UNCERTIFIED";
  if (RUN_CERTIFIED.has(verdict)) return "MARKDOWN_PACKAGE";
  return null;
}

export type ExtractionState = "ready" | "partial" | "unavailable";
const EXTRACTION_STATES = new Set<string>(["ready", "partial", "unavailable"]);

export function extractionState(run: Pick<ConverterRun, "extraction_summary">): ExtractionState | null {
  const state = run.extraction_summary?.state;
  return typeof state === "string" && EXTRACTION_STATES.has(state) ? state as ExtractionState : null;
}

export type ConverterErrorKind = "auth" | "network" | "rejected" | "timeout" | "http" | "too_large" | "assurance_conflict";

export class ConverterError extends Error {
  declare readonly detail?: string;
  readonly retryAfterSec?: number;
  readonly login?: boolean;
  readonly exhausted?: boolean;
  readonly mismatch?: boolean;
  constructor(readonly kind: ConverterErrorKind, message: string, readonly status?: number, readonly terminal = false,
              detail?: string, readonly code?: string, extra: { retryAfterSec?: number; login?: boolean; exhausted?: boolean; mismatch?: boolean } = {}) {
    super(message);
    this.name = "ConverterError";
    Object.defineProperty(this, "detail", { value: detail, enumerable: false, writable: false, configurable: true });
    if (extra.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
    if (extra.login) this.login = true;
    if (extra.exhausted) this.exhausted = true;
    if (extra.mismatch) this.mismatch = true;
  }
}

export class ConverterStorageError extends Error {
  constructor(message: string, readonly code: "storage_unavailable" | "storage_not_configured" = "storage_unavailable") {
    super(message);
    this.name = "ConverterStorageError";
  }
}

export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const sec = /^\d+$/.test(v) ? Number(v) : (Date.parse(v) - now) / 1000;
  return Number.isFinite(sec) && sec > 0 ? Math.min(86_400, Math.ceil(sec)) : undefined;
}

export function converterProblemCode(json: unknown): string | undefined {
  const code = json && typeof json === "object" ? (json as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z][a-z0-9_.:-]{0,79}$/.test(code) ? code : undefined;
}

export class ConverterNoText extends ConverterError {
  constructor(message: string) { super("rejected", message, undefined, true); }
}

export interface ConverterConfig {
  url: string;
  login: string;
  secret: string;
  classification: string;
  profile: string;
  timeoutMs: number;
  pollMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  resultMaxBytes?: number;
  textMaxBytes?: number;
  maxReruns?: number;
}

export const DEFAULT_CONVERTER_MAX_RESPONSE_BYTES = 2 * 20 * 1024 * 1024;
export const DEFAULT_CONVERTER_RESULT_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_CONVERTER_MAX_RERUNS = 2;

export const converterIdempotencyBase = (recordId: string, gen: number): string => `memconv|${recordId}|g${Math.max(0, Math.floor(gen) || 0)}`;

export const converterActionBase = (recordId: string, kind: "run" | "retry", seq: number): string =>
  `memconv|${recordId}|${kind}-${Math.max(0, Math.floor(seq) || 0)}`;

export function converterDocumentRunBody(policyReleaseId: string, why: string): { processing_profile: string; policy_release_id: string; requested_priority: "NORMAL"; reason: string } {
  return { processing_profile: CONVERTER_FAST_PROFILE, policy_release_id: policyReleaseId, requested_priority: "NORMAL", reason: `memory: ${why}`.slice(0, 1000) };
}

export const CONVERTER_FAST_PROFILES: ReadonlySet<string> = new Set([CONVERTER_FAST_PROFILE, CONVERTER_FAST_LANE_PROFILE]);

export const converterIdempotencyKey = (base: string, step: string): string => createHash("sha256").update(`${base}|${step}`).digest("hex").slice(0, 32);

export const CONVERTER_MAX_GEN_BUMPS = 3;

export type ConverterUploadLostWhy = "upload_session_not_found" | "idempotency_conflict" | "upload_state_conflict";
export type ConverterGenBumpWhy = ConverterUploadLostWhy | "run_not_found" | "run_control_conflict" | "fast_lane_missing" | "document_not_found" | "new_cycle";

export function converterUploadLost(e: unknown): ConverterUploadLostWhy | null {
  if (!(e instanceof ConverterError)) return null;
  if (e.code === "upload_session_not_found" && e.status === 404) return "upload_session_not_found";
  if (e.status === 409 && (e.code === "idempotency_conflict" || e.code === "upload_state_conflict")) return e.code;
  if (e.status === 422 && e.code === "idempotency_conflict") return e.code;
  return null;
}

export const CONVERTER_FILE_REJECT_CODES: ReadonlySet<string> = new Set([
  "encrypted", "unsupported_format", "malformed_document", "malformed_pdf", "no_pages", "input_too_large", "too_many_pages", "resource_limit",
  "password_protected", "file_encrypted", "unsupported_media_type", "not_a_pdf", "quarantined", "file_quarantined",
]);
const FAST_LANE_SIZE_CODES: ReadonlySet<string> = new Set(["input_too_large", "too_many_pages", "resource_limit"]);

export const CONVERTER_UPLOAD_RETRY = { completeMs: 2_000 };

export function converterProfile(settings: Pick<Settings, "get">): string {
  const configured = settings.get<unknown>("integrations.converter_profile", CONVERTER_FAST_PROFILE);
  if (configured !== CONVERTER_FAST_PROFILE)
    log.warn("converter_profile_forced", { configured: String(configured).slice(0, 80), used: CONVERTER_FAST_PROFILE });
  return CONVERTER_FAST_PROFILE;
}

export function converterConfig(settings: Settings): ConverterConfig | null {
  const url = settings.str("integrations.converter_url");
  const login = settings.str("integrations.converter_login");
  const secret = settings.str("integrations.converter_password");
  if (!url || !login || !secret) return null;
  const uploadMax = Math.max(1, settings.get("limits.upload_max_bytes", 20 * 1024 * 1024));
  const resultMax = Number(settings.get("integrations.converter_result_max_bytes", DEFAULT_CONVERTER_RESULT_MAX_BYTES));
  const textMax = Number(settings.get("integrations.converter_text_max_bytes", 0));
  const reruns = Number(settings.get("integrations.converter_max_reruns", DEFAULT_CONVERTER_MAX_RERUNS));
  return {
    url: url.replace(/\/+$/, ""), login, secret,
    classification: settings.get("integrations.converter_classification", "internal"),
    profile: converterProfile(settings),
    timeoutMs: Math.max(30, settings.get("integrations.converter_timeout_sec", 900)) * 1000,
    pollMs: Math.max(1, settings.get("integrations.converter_poll_sec", 5)) * 1000,
    requestTimeoutMs: Math.max(5, settings.get("integrations.converter_request_timeout_sec", 120)) * 1000,
    maxResponseBytes: 2 * uploadMax,
    resultMaxBytes: Number.isFinite(resultMax) && resultMax >= 1024 * 1024 ? Math.floor(resultMax) : DEFAULT_CONVERTER_RESULT_MAX_BYTES,
    textMaxBytes: Number.isFinite(textMax) && textMax > 0 ? Math.floor(textMax) : 2 * uploadMax,
    maxReruns: Number.isFinite(reruns) ? Math.min(5, Math.max(0, Math.floor(reruns))) : DEFAULT_CONVERTER_MAX_RERUNS,
  };
}

export function converterConfigured(settings: Pick<Settings, "str">): boolean {
  return Boolean(settings.str("integrations.converter_url") && settings.str("integrations.converter_login") && settings.str("integrations.converter_password"));
}

export function converterMissing(settings: Settings): string[] {
  const out: string[] = [];
  for (const key of ["converter_url", "converter_login", "converter_password"])
    if (!settings.str(`integrations.${key}`)) out.push(`integrations.${key}`);
  return out;
}

export interface ConverterUser { user_id: string; username: string; roles: string[]; permissions: string[] }
export interface ConverterUpload { document_id: string; run_id: string; status: RunStatus }
export interface ConverterRun {
  run_id: string; document_id: string; status: RunStatus; processing_profile?: string;
  policy_release_id?: string | null;
  extraction_summary?: { state?: ExtractionState | string; readable_pages?: number; total_pages?: number; ocr_failed_pages?: number } | null;
}
export interface ConverterDocument {
  document_id: string; filename: string | null; source_sha256: string | null; size_bytes: number | null;
  data_classification: string | null; latest_run_id: string | null;
}
export interface ConverterExport { export_id: string; run_id: string; profile: string; status: "REQUESTED" | "BUILDING" | "READY" | "FAILED" | "EXPIRED" | "REVOKED" }

const pathLabel = (path: string): string => path.replace(/\?.*$/su, "");
const strOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseConverterDocument(x: unknown): ConverterDocument | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const id = strOf(o.document_id) ?? strOf(o.id);
  if (!id) return null;
  const runs = Array.isArray(o.runs) ? o.runs as unknown[] : [];
  const firstRun = runs.map((r) => (typeof r === "string" ? r : r && typeof r === "object" ? strOf((r as Record<string, unknown>).run_id) ?? strOf((r as Record<string, unknown>).id) : null)).find(Boolean) ?? null;
  const latest = o.latest_run && typeof o.latest_run === "object" ? strOf((o.latest_run as Record<string, unknown>).run_id) : null;
  const sha = strOf(o.source_sha256) ?? strOf(o.sha256);
  const size = Number(o.size_bytes ?? o.source_size_bytes);
  return { document_id: id, filename: strOf(o.filename) ?? strOf(o.display_name), source_sha256: sha ? sha.toLowerCase() : null, size_bytes: Number.isFinite(size) && size >= 0 ? size : null,
           data_classification: strOf(o.data_classification), latest_run_id: strOf(o.latest_run_id) ?? latest ?? firstRun };
}

export function parseConverterDocumentList(json: unknown): ConverterDocument[] {
  const o = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
  const list = Array.isArray(json) ? json : [o?.items, o?.documents, o?.data, o?.results].find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).map(parseConverterDocument).filter((d): d is ConverterDocument => d !== null);
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RequestOpts {
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
  expect?: number[];
  raw?: boolean;
  idem?: string;
  noRelogin?: boolean;
  maxBytes?: number;
  overflowFallback?: boolean;
  api?: "v1" | "v2";
}

export class ConverterClient {
  readonly session: ConverterSession;
  private idempotencyBase: string | null;
  private readonly signal: AbortSignal | null;
  private readonly onStep: ((point: ConverterStepPoint) => Promise<void>) | null;

  constructor(private readonly cfg: ConverterConfig, opts: { idempotencyBase?: string; session?: ConverterSession; signal?: AbortSignal; onStep?: (point: ConverterStepPoint) => Promise<void> } = {}) {
    this.idempotencyBase = opts.idempotencyBase ?? null;
    this.session = opts.session ?? new ConverterSession(converterSettingsFingerprint(cfg));
    this.signal = opts.signal ?? null;
    this.onStep = opts.onStep ?? null;
  }

  withBase(idempotencyBase: string): ConverterClient {
    return new ConverterClient(this.cfg, { idempotencyBase, session: this.session, ...(this.signal ? { signal: this.signal } : {}), ...(this.onStep ? { onStep: this.onStep } : {}) });
  }

  get principal(): string | null { return this.session.principal; }

  rebase(idempotencyBase: string): void { this.idempotencyBase = idempotencyBase; }

  private idempotencyKey(step: string): string {
    if (!this.idempotencyBase) return `memory-${randomUUID()}`;
    return converterIdempotencyKey(this.idempotencyBase, step);
  }

  private absorbCookies(res: Response, jar: Map<string, string>): void {
    const raw: string[] = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
    for (const line of raw) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "" || value === '""') jar.delete(name);
      else jar.set(name, value);
    }
  }

  private static cookieHeader(jar: Map<string, string>): string {
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  csrfToken(): string | null { return this.session.jar.get("kos_csrf") ?? null; }

  private async request(method: string, path: string, opts: RequestOpts = {}): Promise<{ status: number; json: any; bytes: Buffer }> {
    const mutating = method !== "GET" && method !== "HEAD";
    const keyed: RequestOpts = mutating && !opts.headers?.["idempotency-key"]
      ? { ...opts, headers: { ...(opts.headers ?? {}), "idempotency-key": this.idempotencyKey(opts.idem ?? `${method} ${path}`) } }
      : opts;
    const seen = this.session.generation;
    try {
      const r = await this.send(method, path, keyed);
      this.session.used();
      return r;
    } catch (e) {
      if (!(e instanceof ConverterError) || e.kind !== "auth" || keyed.noRelogin || this.session.generation === 0) throw e;
      log.info("converter_session_renewed", { method, path: pathLabel(path), status: e.status ?? null });
      await this.session.renew(seen, () => this.performLogin());
      const r = await this.send(method, path, { ...keyed, noRelogin: true });
      this.session.used();
      return r;
    }
  }

  private async send(method: string, path: string, opts: RequestOpts = {}, jar: Map<string, string> = this.session.jar): Promise<{ status: number; json: any; bytes: Buffer }> {
    const mutating = method !== "GET" && method !== "HEAD";
    const headers: Record<string, string> = { accept: "application/json, application/zip;q=0.9, */*;q=0.1", ...(opts.headers ?? {}) };
    const cookies = ConverterClient.cookieHeader(jar);
    if (cookies) headers.cookie = cookies;
    if (mutating) {
      const csrf = jar.get("kos_csrf") ?? null;
      if (csrf) headers["x-csrf-token"] = csrf;
      headers["idempotency-key"] = headers["idempotency-key"] ?? this.idempotencyKey(opts.idem ?? `${method} ${path}`);
    }
    let body: BodyInit | undefined;
    if (opts.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.json); }
    else if (opts.body) { headers["content-type"] = "application/octet-stream"; body = opts.body as unknown as BodyInit; }

    const shown = pathLabel(path);
    const aborted = () => new ConverterError("network", `the converter request was interrupted when the worker stopped (${method} ${shown})`, undefined, false, undefined, "aborted");
    if (this.signal?.aborted) throw aborted();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.requestTimeoutMs);
    let res: Response, bytes: Buffer;
    try {
      const signal = this.signal ? AbortSignal.any([ctl.signal, this.signal]) : ctl.signal;
      res = await fetch(`${this.cfg.url}/api/${opts.api ?? "v1"}${path}`, { method, headers, body, signal, redirect: "manual" });
      this.absorbCookies(res, jar);
      bytes = await this.readCapped(res, method, shown, opts.maxBytes ?? this.cfg.maxResponseBytes, opts.overflowFallback === true);
    } catch (e) {
      if (e instanceof ConverterError) throw e;
      if (this.signal?.aborted) throw aborted();
      if ((e as Error).name === "AbortError") throw new ConverterError("timeout", `the converter did not respond within ${this.cfg.requestTimeoutMs} ms (${method} ${shown})`, undefined, false, undefined, "request_timeout");
      throw new ConverterError("network", `the converter is unavailable (${method} ${shown})`, undefined, false, (e as Error).message.slice(0, 160));
    } finally { clearTimeout(timer); }

    const ok = opts.expect ? opts.expect.includes(res.status) : res.status >= 200 && res.status < 300;
    let json: any = null;
    if (!opts.raw || !ok) { try { json = JSON.parse(bytes.toString("utf8")); } catch { json = null; } }
    if (!ok) {
      const detail = String(json?.detail ?? json?.message ?? json?.title ?? bytes.toString("utf8").slice(0, 160)).slice(0, 200);
      const code = converterProblemCode(json);
      const retryAfterSec = res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      const extra = retryAfterSec !== undefined ? { retryAfterSec } : {};
      if (res.status === 401 || res.status === 403)
        throw new ConverterError("auth", `the converter denied access (${res.status}). Check the login, password and roles ${CONVERTER_ROLES.join(" + ")}`, res.status, false, detail, code);
      if (res.status === 409 && code === "export_assurance_conflict")
        throw new ConverterError("assurance_conflict", `the converter cannot export this run (409 ${code}). Get fast-lane text from /fast-lane`, 409, false, detail, code);
      if (res.status === 409 && code?.startsWith("run_control_"))
        throw new ConverterError("http", `the converter rejected the run action (409 ${code})`, 409, false, detail, code);
      if (res.status === 413)
        throw new ConverterError("too_large", `the file exceeds the converter’s limit (413${code ? ` ${code}` : ""})`, 413, true, detail, code);
      if (res.status === 422 && !(code && (CONVERTER_FILE_REJECT_CODES.has(code) || code === "idempotency_conflict")))
        throw new ConverterError("http", `the converter rejected the request (422${code ? ` ${code}` : ""}): it does not match the schema`, 422, false, detail, code, { mismatch: true });
      if (res.status === 422 && code && FAST_LANE_SIZE_CODES.has(code))
        throw new ConverterError("too_large", `the file exceeds the converter’s limit (422 ${code})`, 422, true, detail, code);
      if (res.status === 422 || res.status === 409)
        throw new ConverterError("rejected",`the converter rejected the request (${res.status}${code ? ` ${code}` : ""})`, res.status, true, detail, code);
      throw new ConverterError("http", `the converter returned ${res.status}${code ? ` ${code}` : ""} for ${method} ${shown}`, res.status, false, detail, code, extra);
    }
    return { status: res.status, json, bytes };
  }

  private async readCapped(res: Response, method: string, path: string, limit: number, fallback: boolean): Promise<Buffer> {
    const cap = Math.max(1, limit);
    const tooLarge = (got: string) => fallback
      ? new ConverterError("too_large", `the converter response exceeds ${cap} bytes (${method} ${path}, ${got}). Retrieving text through the fallback path`,
                           undefined, false, undefined, "result_too_large")
      : new ConverterError("too_large", `the converter response exceeds the ${cap}-byte limit (${method} ${path}, ${got}). Reading was stopped`, undefined, true);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(`declared size ${declared}`);
    }
    if (!res.body) return Buffer.from(await res.arrayBuffer());
    const reader = res.body.getReader();
    const parts: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(`read more than ${cap}`);
      }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }

  async login(): Promise<ConverterUser> {
    await this.session.login(() => this.performLogin(), "forced");
    return (this.session.user ?? {}) as ConverterUser;
  }

  private async performLogin(): Promise<ConverterLoginResult> {
    const jar = new Map<string, string>();
    const asLogin = (e: unknown): unknown => {
      if (!(e instanceof ConverterError)) return e;
      const code = e.code ?? (e.status === 429 ? "login_locked" : e.status === 401 || e.status === 403 ? "login_rejected" : undefined);
      return new ConverterError(e.kind, e.message, e.status, false, e.detail, code, { retryAfterSec: e.retryAfterSec, login: true });
    };
    let r: { json: any };
    try {
      r = await this.send("POST", "/auth/login", {
        json: { username: this.cfg.login, password: this.cfg.secret },
        headers: { "idempotency-key": `memory-${randomUUID()}` }, noRelogin: true,
      }, jar);
    } catch (e) { throw asLogin(e); }
    if (!jar.has("kos_session")) throw new ConverterError("auth", "the converter did not return the kos_session session cookie", undefined, false, undefined, "login_no_session", { login: true });
    if (!jar.get("kos_csrf")) await this.send("GET", "/auth/csrf", {}, jar).catch(() => undefined);
    let user = (r.json ?? null) as ConverterUser | null;
    try { user = (await this.send("GET", "/auth/me", {}, jar)).json as ConverterUser; }
    catch (e) {
      if (e instanceof ConverterError && e.kind === "auth") throw asLogin(e);
      log.warn("converter_me_failed", { status: (e as ConverterError).status ?? null, kind: (e as ConverterError).kind ?? null });
    }
    return { jar, user };
  }

  private async ensureSession(): Promise<void> { await this.session.ensure(() => this.performLogin()); }

  async whoami(): Promise<ConverterUser> {
    await this.ensureSession();
    return (await this.request("GET", "/auth/me")).json as ConverterUser;
  }

  static missingRoles(user: Pick<ConverterUser, "roles">): string[] {
    const have = new Set((user.roles ?? []).map((r) => String(r)));
    return CONVERTER_ROLES.filter((r) => !have.has(r));
  }

  async upload(bytes: Buffer, filename: string, opts: { classification?: string; profile?: string } = {}): Promise<ConverterUpload> {
    await this.ensureSession();
    if (!bytes.length) throw new ConverterError("rejected", "the file is empty, so there is nothing to send to the converter", undefined, true);
    const session = (await this.request("POST", "/upload-sessions", {
      json: {
        filename: filename.slice(0, 500), size_bytes: bytes.length, expected_sha256: sha256Hex(bytes),
        data_classification: opts.classification ?? this.cfg.classification,
        processing_profile: opts.profile ?? this.cfg.profile,
      },
      expect: [200, 201], idem: "upload-session",
    })).json as { upload_session_id: string; part_size_bytes: number };
    if (!session?.upload_session_id) throw new ConverterError("http", "the converter did not return an upload session ID");
    await this.onStep?.("after_session");

    const partSize = Math.max(1, Number(session.part_size_bytes) || bytes.length);
    const parts: Array<{ part_number: number; sha256: string }> = [];
    for (let offset = 0, n = 1; offset < bytes.length; offset += partSize, n++) {
      const chunk = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
      const hex = sha256Hex(chunk);
      await this.request("PUT", `/upload-sessions/${encodeURIComponent(session.upload_session_id)}/parts/${n}`, {
        body: chunk, headers: { "x-part-sha256": hex }, expect: [200, 201, 204], idem: `part-${n}`,
      });
      parts.push({ part_number: n, sha256: hex });
    }
    const complete = () => this.request("POST", `/upload-sessions/${encodeURIComponent(session.upload_session_id)}/complete`, {
      json: { parts, expected_source_sha256: sha256Hex(bytes) }, expect: [200, 201, 202], idem: "complete",
    });
    let done: ConverterUpload;
    try { done = (await complete()).json as ConverterUpload; }
    catch (e) {
      if (!(e instanceof ConverterError) || e.status !== 409 || e.code !== "upload_state_conflict") throw e;
      log.info("converter_complete_retry", { code: e.code });
      await sleep(CONVERTER_UPLOAD_RETRY.completeMs);
      done = (await complete()).json as ConverterUpload;
    }
    if (!done?.run_id) throw new ConverterError("http", "the converter did not return a run ID");
    log.info("converter_upload", { parts: parts.length, bytes: bytes.length, run_id: done.run_id });
    await this.onStep?.("after_complete");
    return done;
  }

  async getDocument(documentId: string): Promise<ConverterDocument | null> {
    await this.ensureSession();
    try {
      const doc = parseConverterDocument((await this.request("GET", `/documents/${encodeURIComponent(documentId)}`)).json);
      return { ...(doc ?? { filename: null, source_sha256: null, size_bytes: null, data_classification: null, latest_run_id: null }), document_id: documentId };
    } catch (e) {
      if (e instanceof ConverterError && e.status === 404) return null;
      throw e;
    }
  }

  async findDocumentsBySha(sha256: string): Promise<{ docs: ConverterDocument[]; via: "v2" | "v1" | null }> {
    const want = sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(want)) return { docs: [], via: null };
    await this.ensureSession();
    const exact = (docs: ConverterDocument[]) => docs.filter((d) => d.source_sha256 === want);
    const unavailable = (e: unknown) => !(e instanceof ConverterError) || e.status === undefined || e.status === 429 || (e.status >= 502 && e.status <= 504);
    try {
      const r = await this.request("GET", `/documents?source_sha256=${want}`, { api: "v2", noRelogin: true });
      return { docs: exact(parseConverterDocumentList(r.json)), via: "v2" };
    } catch (e) {
      if (unavailable(e)) throw e;
      if (![400, 401, 403, 404, 405, 422, 501].includes((e as ConverterError).status!)) return { docs: [], via: null };
      log.info("converter_document_search_v1", { status: (e as ConverterError).status ?? null });
    }
    try {
      const r = await this.request("GET", `/documents?q=${want}`);
      return { docs: exact(parseConverterDocumentList(r.json)), via: "v1" };
    } catch (e) {
      if (unavailable(e) || (e as ConverterError).login) throw e;
      log.info("converter_document_search_failed", { status: (e as ConverterError).status ?? null, code: (e as ConverterError).code ?? null });
      return { docs: [], via: null };
    }
  }

  async run(runId: string): Promise<ConverterRun> {
    await this.ensureSession();
    return (await this.request("GET", `/runs/${encodeURIComponent(runId)}`)).json as ConverterRun;
  }

  async waitRun(runId: string, opts: { timeoutMs?: number; pollMs?: number; onPoll?: () => unknown } = {}): Promise<ConverterRun> {
    const deadline = Date.now() + (opts.timeoutMs ?? this.cfg.timeoutMs);
    const poll = opts.pollMs ?? this.cfg.pollMs;
    let last: ConverterRun | null = null;
    for (;;) {
      last = await this.run(runId);
      const status = last?.status as RunStatus;
      if (RUN_READY.has(status) || status === "FAIL_RETRYABLE") return last;
      if (RUN_REFUSED.has(status))
        throw new ConverterError("rejected", `the converter run was canceled (${status}) and has no result`, undefined, true);
      if (Date.now() >= deadline)
        throw new ConverterError("timeout", `the converter did not complete the run within ${Math.round((opts.timeoutMs ?? this.cfg.timeoutMs) / 1000)} s (last status: ${status})`);
      await opts.onPoll?.();
      await sleep(Math.min(poll, Math.max(250, deadline - Date.now())));
    }
  }

  async createExport(runId: string, profile: string, after?: string | null): Promise<ConverterExport> {
    await this.ensureSession();
    const idem = after ? `export-${runId}-${profile}-after-${after}` : `export-${runId}-${profile}`;
    const r = await this.request("POST", `/runs/${encodeURIComponent(runId)}/exports`, { json: { profile }, expect: [200, 201, 202], idem });
    const out = r.json as ConverterExport;
    if (!out?.export_id) throw new ConverterError("http", "the converter did not return an export ID");
    return out;
  }

  async cancelRun(runId: string): Promise<{ run_id: string; status: string } | null> {
    await this.ensureSession();
    const r = await this.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { expect: [200, 202, 204, 409], idem: `cancel-${runId}` });
    return (r.json as { run_id: string; status: string } | null) ?? null;
  }

  async waitExport(exportId: string, opts: { timeoutMs?: number; pollMs?: number; onPoll?: () => unknown } = {}): Promise<ConverterExport> {
    await this.ensureSession();
    const deadline = Date.now() + (opts.timeoutMs ?? this.cfg.timeoutMs);
    const poll = opts.pollMs ?? this.cfg.pollMs;
    for (;;) {
      const out = (await this.request("GET", `/exports/${encodeURIComponent(exportId)}`)).json as ConverterExport;
      if (out?.status === "READY") return out;
      if (out?.status === "FAILED" || out?.status === "EXPIRED" || out?.status === "REVOKED")
        throw new ConverterError("rejected", `converter export status: ${out.status}`, undefined, true, undefined, `export_${out.status.toLowerCase()}`);
      if (Date.now() >= deadline)
        throw new ConverterError("timeout", `the converter did not build the export within ${Math.round((opts.timeoutMs ?? this.cfg.timeoutMs) / 1000)} s (status: ${out?.status})`);
      await opts.onPoll?.();
      await sleep(Math.min(poll, Math.max(250, deadline - Date.now())));
    }
  }

  async download(exportId: string): Promise<Buffer> {
    await this.ensureSession();
    const r = await this.request("GET", `/exports/${encodeURIComponent(exportId)}/download`, { raw: true, maxBytes: this.resultMaxBytes() });
    if (!r.bytes.length) throw new ConverterError("rejected", "the converter returned an empty export archive", undefined, true);
    return r.bytes;
  }

  private resultMaxBytes(): number { return Math.max(1, this.cfg.resultMaxBytes ?? DEFAULT_CONVERTER_RESULT_MAX_BYTES); }
  private textMaxBytes(): number { return Math.max(1, this.cfg.textMaxBytes ?? this.cfg.maxResponseBytes); }

  async fastLaneResult(runId: string): Promise<FastLaneResult> {
    await this.ensureSession();
    const r = await this.request("GET", `/runs/${encodeURIComponent(runId)}/fast-lane`, { maxBytes: this.resultMaxBytes(), overflowFallback: true });
    return parseFastLaneResult(r.json, runId);
  }

  async fastLaneBundle(runId: string, opts: { lowerBoundBytes?: number | null } = {}): Promise<FastLaneResult> {
    await this.ensureSession();
    let r: { status: number; bytes: Buffer };
    try {
      r = await this.request("GET", `/runs/${encodeURIComponent(runId)}/fast-lane/bundle`, { raw: true, maxBytes: this.resultMaxBytes() });
    } catch (e) {
      if (e instanceof ConverterError && e.status === 503 && e.code === "artifact_unavailable"
          && typeof opts.lowerBoundBytes === "number" && opts.lowerBoundBytes > DC_FAST_LANE_MAX_BUNDLE_BYTES)
        throw new ConverterError("too_large", `the text archive exceeds ${DC_FAST_LANE_MAX_BUNDLE_BYTES} bytes, so the converter will not build it`,
                                 503, true, e.detail, "bundle_too_large");
      throw e;
    }
    if (!r.bytes.length) throw new ConverterError("http", "the converter returned an empty fast-lane archive", r.status, false, undefined, "unexpected_response");
    return fastLaneResultFromBundle(r.bytes, { maxBytes: this.textMaxBytes(), runId });
  }

  async retryRun(runId: string, idem: string, why = "fail_retryable"): Promise<ConverterRun> {
    if (!idem) throw new Error("retryRun: an idempotency key step is required (retry-<n>)");
    await this.ensureSession();
    const r = await this.request("POST", `/runs/${encodeURIComponent(runId)}/retry`, { json: { reason: `memory: ${why}`.slice(0, 1000) }, expect: [200, 201, 202], idem });
    const run = r.json as ConverterRun | null;
    if (!run?.run_id) throw new ConverterError("http", "the converter did not return a child run ID", r.status, false, undefined, "unexpected_response");
    return run;
  }

  async startDocumentRun(documentId: string, body: ReturnType<typeof converterDocumentRunBody>, idem: string): Promise<ConverterRun> {
    if (!idem) throw new Error("startDocumentRun: an idempotency key step is required");
    await this.ensureSession();
    const r = await this.request("POST", `/documents/${encodeURIComponent(documentId)}/runs`, { json: body, expect: [200, 201, 202], idem });
    const run = r.json as ConverterRun | null;
    if (!run?.run_id) throw new ConverterError("http", "the converter did not return a new run ID", r.status, false, undefined, "unexpected_response");
    return run;
  }
}

export function converterExportGone(e: unknown): boolean {
  return e instanceof ConverterError && (e.code === "export_expired" || e.code === "export_revoked" || (e.status === 409 && e.code === "export_not_ready"));
}

export interface ConverterBundle { markdown: string; entries: string[]; certified: boolean }

const DRAFT_BANNER = /^\uFEFF?\s*# ⚠\uFE0F? НЕ СЕРТИФИЦИРОВАНО[^\n]*\r?\n[\s\S]{0,4000}?\r?\n---[ \t]*(?:\r?\n|$)/u;
const NO_PAGES_NOTE = /^\s*>[ \t]*Этот прогон не опубликовал ни одной страницы[^\n]*(?:\r?\n|$)/u;

export function stripConverterDraftBanner(markdown: string): { text: string; banner: boolean } {
  const head = DRAFT_BANNER.exec(markdown);
  const text = head ? markdown.slice(head[0].length).replace(/^\s*\n/u, "") : markdown;
  return { text: text.replace(NO_PAGES_NOTE, ""), banner: head !== null };
}

interface ConverterArchive {
  entries: string[];
  markdown: string | null;
  conversion: string | null;
  images: FastLaneImage[];
}

const baseName = (name: string): string => name.split("/").pop() ?? name;
const IMAGE_ENTRY = /(?:^|\/)images\/[^/]+$/u;

function unpackConverterArchive(zip: Buffer, cap: number, label: string): ConverterArchive {
  const entries: string[] = [];
  const images: FastLaneImage[] = [];
  const tooLarge = () => new ConverterError("too_large", `unpacked ${label} exceeds the ${cap}-byte limit. Conversion was stopped`, undefined, true);
  let total = 0, files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(zip), {
      filter: (f) => {
        entries.push(f.name);
        const base = baseName(f.name);
        if (base === CONVERTER_MARKDOWN_ENTRY || base === CONVERTER_CONVERSION_ENTRY) {
          total += Number(f.originalSize) || 0;
          if (total > cap) throw tooLarge();
          return true;
        }
        if (IMAGE_ENTRY.test(f.name)) images.push({ path: f.name, size_bytes: Math.max(0, Number(f.originalSize) || 0) });
        return false;
      },
    });
  } catch (e) {
    if (e instanceof ConverterError) throw e;
    throw new ConverterError("rejected", `${label} could not be read`, undefined, true, (e as Error).message.slice(0, 120));
  }
  const pick = (entry: string): Uint8Array | null => {
    const name = entries.find((n) => baseName(n) === entry && files[n] !== undefined);
    return name ? files[name]! : null;
  };
  const md = pick(CONVERTER_MARKDOWN_ENTRY), conversion = pick(CONVERTER_CONVERSION_ENTRY);
  if ((md?.length ?? 0) + (conversion?.length ?? 0) > cap) throw tooLarge();
  return { entries, markdown: md ? strFromU8(md) : null, conversion: conversion ? strFromU8(conversion) : null, images };
}

export function readConverterBundle(zip: Buffer, opts: { maxBytes?: number } = {}): ConverterBundle {
  const cap = Math.max(1, opts.maxBytes ?? DEFAULT_CONVERTER_MAX_RESPONSE_BYTES);
  const archive = unpackConverterArchive(zip, cap, "export archive");
  const entries = archive.entries;
  if (archive.markdown === null) throw new ConverterError("rejected", `the export archive is missing ${CONVERTER_MARKDOWN_ENTRY}`, undefined, true, `files: ${entries.slice(0, 10).join(", ")}`);
  const source = archive.markdown;
  const { text: markdown, banner } = stripConverterDraftBanner(source);
  if (!markdown.trim())
    throw new ConverterNoText(source.trim() ? `the converter’s ${CONVERTER_MARKDOWN_ENTRY} contains a draft header only, with no document text` : `the converter returned an empty ${CONVERTER_MARKDOWN_ENTRY}`);
  return { markdown, entries, certified: !banner && !entries.some((n) => baseName(n) === CONVERTER_UNCERTIFIED_ENTRY) };
}

export type FastLaneStatus = "ready" | "partial" | "failed";
const FAST_LANE_STATUSES = new Set<string>(["ready", "partial", "failed"]);

export interface FastLaneUnit { kind: string; number: number | null; method: string; chars: number; images: number; warnings: string[]; title?: string | null }
export interface FastLaneImage { path: string; size_bytes: number; artifact_id?: string; media_type?: string }
export interface FastLaneResult {
  run_id: string;
  status: FastLaneStatus;
  source_format: string | null;
  family: string | null;
  export_profile: string;
  certified: boolean;
  converter_release: string | null;
  error: string | null;
  markdown: string | null;
  blocks_truncated: boolean;
  warnings: string[];
  units: FastLaneUnit[];
  images: FastLaneImage[];
}

const unexpectedFastLane = (what: string, status?: number): ConverterError =>
  new ConverterError("http", `the converter’s fast-lane result does not match the contract (${what})`, status, false, undefined, "unexpected_response");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nonNegative = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function stringList(v: unknown, what: string): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw unexpectedFastLane(what);
  return v.map((x) => String(x).slice(0, 200));
}

function parseFastLaneUnits(v: unknown): FastLaneUnit[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw unexpectedFastLane("units");
  return v.map((u) => {
    if (!isRecord(u)) throw unexpectedFastLane("units[]");
    const number = typeof u.number === "number" && Number.isInteger(u.number) && u.number >= 0 ? u.number : null;
    return { kind: strOrNull(u.kind) || "document", number, method: strOrNull(u.method) ?? "", chars: nonNegative(u.chars),
             images: nonNegative(u.images), warnings: stringList(u.warnings, "units[].warnings"), title: strOrNull(u.title) };
  });
}

export function parseFastLaneResult(json: unknown, runId: string): FastLaneResult {
  if (!isRecord(json)) throw unexpectedFastLane("not a JSON object");
  const status = strOrNull(json.status);
  if (!status || !FAST_LANE_STATUSES.has(status)) throw unexpectedFastLane("status");
  if (json.markdown !== null && json.markdown !== undefined && typeof json.markdown !== "string") throw unexpectedFastLane("markdown");
  if (json.images !== undefined && json.images !== null && !Array.isArray(json.images)) throw unexpectedFastLane("images");
  const images = ((json.images ?? []) as unknown[]).map((img): FastLaneImage => {
    if (!isRecord(img) || !strOrNull(img.path)) throw unexpectedFastLane("images[]");
    return { path: img.path as string, size_bytes: nonNegative(img.size_bytes),
             ...(strOrNull(img.artifact_id) ? { artifact_id: img.artifact_id as string } : {}),
             ...(strOrNull(img.media_type) ? { media_type: img.media_type as string } : {}) };
  });
  return {
    run_id: strOrNull(json.run_id) ?? runId,
    status: status as FastLaneStatus,
    source_format: strOrNull(json.source_format), family: strOrNull(json.family),
    export_profile: strOrNull(json.export_profile) ?? "DRAFT_UNCERTIFIED",
    certified: false,
    converter_release: strOrNull(json.converter_release), error: strOrNull(json.error),
    markdown: typeof json.markdown === "string" ? json.markdown : null,
    blocks_truncated: json.blocks_truncated === true,
    warnings: stringList(json.warnings, "warnings"), units: parseFastLaneUnits(json.units), images,
  };
}

export function fastLaneResultFromBundle(zip: Buffer, opts: { maxBytes?: number; runId?: string } = {}): FastLaneResult {
  const cap = Math.max(1, opts.maxBytes ?? DEFAULT_CONVERTER_MAX_RESPONSE_BYTES);
  const archive = unpackConverterArchive(zip, cap, "fast-lane archive");
  if (archive.conversion === null) throw unexpectedFastLane(`the archive is missing ${CONVERTER_CONVERSION_ENTRY}`);
  let manifest: unknown;
  try { manifest = JSON.parse(archive.conversion); } catch { throw unexpectedFastLane(`${CONVERTER_CONVERSION_ENTRY} is not JSON`); }
  if (!isRecord(manifest)) throw unexpectedFastLane(CONVERTER_CONVERSION_ENTRY);
  const status = strOrNull(manifest.status);
  if (!status || !FAST_LANE_STATUSES.has(status)) throw unexpectedFastLane(`${CONVERTER_CONVERSION_ENTRY}: status`);
  if (status !== "failed" && archive.markdown === null) throw unexpectedFastLane(`the archive is missing ${CONVERTER_MARKDOWN_ENTRY}`);
  const source = isRecord(manifest.source) ? manifest.source : {};
  return {
    run_id: opts.runId ?? "",
    status: status as FastLaneStatus,
    source_format: strOrNull(source.format), family: strOrNull(source.family),
    export_profile: "DRAFT_UNCERTIFIED", certified: false,
    converter_release: strOrNull(manifest.converter), error: strOrNull(manifest.error),
    markdown: archive.markdown, blocks_truncated: false,
    warnings: stringList(manifest.warnings, "warnings"), units: parseFastLaneUnits(manifest.units), images: archive.images,
  };
}

export type FastLaneBundleReason = "markdown_truncated" | "result_too_large" | "timeout";

export function fastLaneBundleReason(x: unknown): FastLaneBundleReason | null {
  if (x instanceof ConverterError) return x.code === "result_too_large" ? "result_too_large" : x.code === "request_timeout" ? "timeout" : null;
  if (isRecord(x) && x.status !== "failed" && x.markdown === null && x.blocks_truncated === true) return "markdown_truncated";
  return null;
}

export function fastLaneBundleLowerBound(result: FastLaneResult): number | null {
  if (fastLaneBundleReason(result) !== "markdown_truncated") return null;
  return result.images.reduce((sum, img) => sum + img.size_bytes, 0) + DC_FAST_LANE_MAX_MARKDOWN_BYTES + 1;
}

export interface FastLaneOutcome {
  dc_status: FastLaneStatus;
  extraction: ExtractionState;
  ocr_rerun: boolean;
  ocr_units: number;
  text: string;
  pages: number | null;
  warning_codes: string[];
  error_code: string | null;
  error_class: FastLaneErrorClass | null;
  agent_file: boolean;
  agent_file_why: AgentFileWhy[];
  source_format: string | null;
  converter_release: string | null;
  certified: false;
  export_profile: "DRAFT_UNCERTIFIED";
}

import type { AgentFileWhy, FastLaneErrorClass } from "./documents/outcome.ts";
export { FAST_LANE_TERMINAL_ERRORS, FAST_LANE_RERUN_ERRORS, fastLaneErrorClass, FAST_LANE_OCR_METHODS, FAST_LANE_OFFICE_FORMATS, deriveOutcome as fastLaneOutcome } from "./documents/outcome.ts";
export type { AgentFileWhy, FastLaneErrorClass } from "./documents/outcome.ts";

/** The step's two errors for a fast-lane result without text; the outcome rule calls this before it reads the text. */
export function assertFastLaneText(markdown: string | null): asserts markdown is string {
  if (markdown === null)
    throw new ConverterError("http", "the converter response contains no text. Only the fast-lane archive provides it", undefined, false, undefined, "markdown_truncated");
  if (!markdown.trim()) throw new ConverterNoText("the converter returned empty fast-lane text");
}

const PDF_NAME_END = String.raw`(?=[\s/\[\]<>(){}%]|$)`;
const PDF_ATTACHMENTS = new RegExp(String.raw`/(?:EmbeddedFile|FileAttachment)${PDF_NAME_END}`, "u");
const PDF_FORMS = new RegExp(String.raw`/AcroForm${PDF_NAME_END}`, "u");
const PDF_ANNOTATIONS = new RegExp(String.raw`/Subtype\s*/(?:Text|FreeText|Popup|Highlight|Underline|StrikeOut|Squiggly|Ink|Stamp|Caret|Redact)${PDF_NAME_END}`, "u");

export function pdfSourceFlags(bytes: Uint8Array): string[] {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) return [];
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const flags: string[] = [];
  if (PDF_ANNOTATIONS.test(text)) flags.push("pdf_annotations");
  if (PDF_ATTACHMENTS.test(text)) flags.push("pdf_attachments");
  if (PDF_FORMS.test(text)) flags.push("pdf_forms");
  if (pdfHasPictures(bytes, text)) flags.push("pdf_images");
  return flags;
}

const PDF_IMAGE_MIN_PIXELS = 32;
const PDF_REPEATED_MIN_PAGES = 3, PDF_REPEATED_SHARE = 0.3;
const PDF_OBJSTM_MAX_BYTES = 64 * 1024 * 1024;
const PDF_FORM_MAX_DEPTH = 8;
const PDF_OBJ_HEAD = /(?<![0-9])(\d{1,10})[ \t\r\n\f\0]+\d{1,5}[ \t\r\n\f\0]+obj(?![A-Za-z0-9])/gu;
const PDF_STREAM_KW = /(?:^|[\s>])stream(?:\r\n|\n|\r)/gu;
const PDF_REF = /(\d{1,10})\s+\d{1,5}\s+R(?![A-Za-z0-9])/gu;
const pdfKey = (key: string) => new RegExp(String.raw`/${key}${PDF_NAME_END}`, "u");
const PDF_IS_IMAGE = new RegExp(String.raw`/Subtype\s*/Image${PDF_NAME_END}`, "u");
const PDF_IS_FORM = new RegExp(String.raw`/Subtype\s*/Form${PDF_NAME_END}`, "u");
const PDF_IS_PAGE = new RegExp(String.raw`/Type\s*/Page${PDF_NAME_END}`, "u");
const PDF_IS_OBJSTM = new RegExp(String.raw`/Type\s*/ObjStm${PDF_NAME_END}`, "u");
const PDF_MASK_REF = /\/S?Mask\s+(\d{1,10})\s+\d{1,5}\s+R(?![A-Za-z0-9])/gu;

interface PdfObj { body: string; data?: Uint8Array }

function pdfDictAt(s: string, i: number): string | null {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "(") {
      let d = 1;
      for (j++; j < s.length && d > 0; j++) { const x = s[j]; if (x === "\\") j++; else if (x === "(") d++; else if (x === ")") d--; }
      j--;
    } else if (c === "<") {
      if (s[j + 1] === "<") { depth++; j++; }
      else { const k = s.indexOf(">", j); if (k < 0) return null; j = k; }
    } else if (c === ">" && s[j + 1] === ">") {
      depth--; j++;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return null;
}

function pdfEntry(dict: string, key: string): string | null {
  const m = pdfKey(key).exec(dict);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < dict.length && /\s/u.test(dict[i]!)) i++;
  if (dict.startsWith("<<", i)) return pdfDictAt(dict, i);
  if (dict[i] === "[") { const k = dict.indexOf("]", i); return k < 0 ? null : dict.slice(i, k + 1); }
  if (dict[i] === "/") return `/${/^[^\s/\[\]<>(){}%]*/u.exec(dict.slice(i + 1, i + 128))?.[0] ?? ""}`;
  const ref = /^\d{1,10}\s+\d{1,5}\s+R(?![A-Za-z0-9])/u.exec(dict.slice(i, i + 32));
  if (ref) return ref[0];
  return /^[^\s/\[\]<>(){}%]*/u.exec(dict.slice(i, i + 64))?.[0] ?? null;
}

const pdfRefNum = (v: string | null): number | null => { const m = v ? /^(\d{1,10})\s+\d{1,5}\s+R/u.exec(v) : null; return m ? Number(m[1]) : null; };

function pdfObjects(bytes: Uint8Array, text: string): { objs: Map<number, PdfObj>; complete: boolean } {
  const objs = new Map<number, PdfObj>();
  let complete = true, budget = PDF_OBJSTM_MAX_BYTES;
  const head = new RegExp(PDF_OBJ_HEAD.source, "gu"), kw = new RegExp(PDF_STREAM_KW.source, "gu");
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const num = Number(m[1]), start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    kw.lastIndex = start;
    const s = kw.exec(text);
    if (!s || (end >= 0 && s.index > end)) {
      objs.set(num, { body: text.slice(start, end < 0 ? Math.min(text.length, start + 65_536) : end) });
      if (end >= 0) head.lastIndex = end + 6;
      continue;
    }
    const body = text.slice(start, s.index + s[0].indexOf("stream"));
    const dataStart = s.index + s[0].length;
    const len = /\/Length\s+(\d{1,10})(?![0-9])(?!\s+\d{1,5}\s+R)/u.exec(body);
    let dataEnd = len ? dataStart + Number(len[1]) : -1;
    if (dataEnd < 0 || dataEnd > text.length || !/^\s*endstream/u.test(text.slice(dataEnd, dataEnd + 32))) {
      const es = text.indexOf("endstream", dataStart);
      dataEnd = es < 0 ? text.length : es;
    }
    const data = bytes.subarray(dataStart, dataEnd);
    objs.set(num, { body, data });
    head.lastIndex = dataEnd;
    if (!PDF_IS_OBJSTM.test(body)) continue;
    const n = Number(/\/N\s+(\d{1,7})/u.exec(body)?.[1] ?? NaN), first = Number(/\/First\s+(\d{1,10})/u.exec(body)?.[1] ?? NaN);
    const filters = [...(pdfEntry(body, "Filter") ?? "").matchAll(/\/([A-Za-z0-9]+)/gu)].map((x) => x[1]);
    if (!(n > 0) || !(first >= 0) || pdfEntry(body, "DecodeParms") || filters.some((f) => f !== "FlateDecode") || filters.length > 1) { complete = false; continue; }
    let dec: Buffer;
    try { dec = filters.length ? inflateSync(data, { maxOutputLength: Math.max(1, budget), finishFlush: zlibConstants.Z_SYNC_FLUSH }) : Buffer.from(data); }
    catch { complete = false; continue; }
    budget -= dec.length;
    const s2 = dec.toString("latin1");
    const nums = s2.slice(0, first).trim().split(/\s+/u).map(Number);
    for (let i = 0; i < n && 2 * i + 1 < nums.length; i++) {
      const on = nums[2 * i]!, off = nums[2 * i + 1]!, next = i + 1 < n && 2 * i + 3 < nums.length ? nums[2 * i + 3]! : s2.length - first;
      if (Number.isFinite(on) && Number.isFinite(off)) objs.set(on, { body: s2.slice(first + off, first + next) });
    }
  }
  return { objs, complete };
}

export function pdfHasPictures(bytes: Uint8Array, text: string): boolean {
  if (!PDF_IS_IMAGE.test(text)) return false;
  const { objs, complete } = pdfObjects(bytes, text);
  const masks = new Set<number>();
  for (const o of objs.values()) for (const m of o.body.matchAll(PDF_MASK_REF)) masks.add(Number(m[1]));
  const intOf = (body: string, key: string): number | null => {
    const v = pdfEntry(body, key), ref = pdfRefNum(v);
    const raw = ref === null ? v : objs.get(ref)?.body.trim() ?? null;
    return raw && /^\d{1,9}$/u.test(raw) ? Number(raw) : null;
  };
  const images = new Map<number, string>();
  for (const [num, o] of objs) {
    if (!o.data || masks.has(num) || !PDF_IS_IMAGE.test(o.body)) continue;
    const w = intOf(o.body, "Width"), h = intOf(o.body, "Height");
    if ((w !== null && w < PDF_IMAGE_MIN_PIXELS) || (h !== null && h < PDF_IMAGE_MIN_PIXELS)) continue;
    images.set(num, createHash("sha1").update(o.data).digest("hex"));
  }
  if (!images.size) return false;
  if (!complete) return true;
  const pages = [...objs].filter(([, o]) => !o.data && PDF_IS_PAGE.test(o.body)).map(([num]) => num);
  if (!pages.length) return true;
  const dictOf = (v: string | null): { id: string | null; text: string } | null => {
    if (!v) return null;
    if (v.startsWith("<<")) return { id: null, text: v };
    const n = pdfRefNum(v), body = n === null ? undefined : objs.get(n)?.body;
    if (!body) return null;
    const at = body.indexOf("<<");
    const text = at < 0 ? null : pdfDictAt(body, at);
    return text ? { id: `o${n}`, text } : null;
  };
  const resOf = new Map<number, { id: string; text: string }>(), users = new Map<string, number>();
  for (const page of pages) {
    let node: number | null = page;
    for (let depth = 0; node !== null && depth < 32; depth++) {
      const body = objs.get(node)?.body;
      if (!body) break;
      const d = dictOf(pdfEntry(body, "Resources"));
      if (d) { const id = d.id ?? `i${node}`; resOf.set(page, { id, text: d.text }); users.set(id, (users.get(id) ?? 0) + 1); break; }
      node = pdfRefNum(pdfEntry(body, "Parent"));
    }
  }
  const usage = new Map<string, { pages: Set<number>; uncertain: boolean }>();
  for (const digest of images.values()) usage.set(digest, { pages: new Set(), uncertain: false });
  const visit = (xobjects: string, page: number, uncertain: boolean, depth: number, seen: Set<number>): void => {
    for (const m of xobjects.matchAll(PDF_REF)) {
      const n = Number(m[1]), digest = images.get(n);
      if (digest) { const u = usage.get(digest)!; u.pages.add(page); u.uncertain ||= uncertain; continue; }
      const o = objs.get(n);
      if (!o?.data || depth >= PDF_FORM_MAX_DEPTH || seen.has(n) || !PDF_IS_FORM.test(o.body)) continue;
      seen.add(n);
      const fres = dictOf(pdfEntry(o.body, "Resources"));
      const fx = fres ? dictOf(pdfEntry(fres.text, "XObject")) : null;
      if (fx) visit(fx.text, page, uncertain, depth + 1, seen);
    }
  };
  for (const [page, res] of resOf) {
    const xo = dictOf(pdfEntry(res.text, "XObject"));
    if (xo) visit(xo.text, page, (users.get(res.id) ?? 0) > 1, 0, new Set());
  }
  const repeated = (u: { pages: Set<number>; uncertain: boolean }) =>
    !u.uncertain && u.pages.size >= PDF_REPEATED_MIN_PAGES && u.pages.size >= PDF_REPEATED_SHARE * pages.length;
  return [...usage.values()].some((u) => !repeated(u));
}

const MASTER_FAST_OCR_NOTE = /распознаны в быстром режиме\s+\*{0,2}без повторной проверки/u;
export function hasMasterFastOcrNote(markdown: string): boolean { return MASTER_FAST_OCR_NOTE.test(markdown); }
export const MASTER_FAST_OCR_NOTE_PG = MASTER_FAST_OCR_NOTE.source;

export function exportPathExtraction(run: Pick<ConverterRun, "extraction_summary">, markdown: string): { extraction: ExtractionState | null; fast_ocr: boolean } {
  const state = extractionState(run);
  const fast_ocr = hasMasterFastOcrNote(markdown);
  return { extraction: fast_ocr && (state === "ready" || state === null) ? "partial" : state, fast_ocr };
}

const SOURCE_PAGE_ANCHOR = /^[ \t]*<!--[ \t]*source-page:[ \t]*(\d+)[ \t]*-->[ \t]*$/gmu;
const FAST_PAGE_ANCHOR = /^[ \t]*<!--[ \t]*стр\.[ \t]*(\d+)(?:[ \t]*·[^>\n]*)?[ \t]*-->[ \t]*$/gmu;
// The heading a converter gives a slide: the Russian word of the reference converter or the English one.
const SLIDE_HEADING = /^## (?:Слайд|Slide) (\d+)(?=[.\s(]|$)/u;
const PAGE_ANCHOR_LINE = /^[ \t]*<!--\s*page:\s*(\d+)\s*-->[ \t]*$/u;
const IMAGE_LINK = /!\[((?:\\.|[^\]\\\n])*)\]\(images\/[^)\s]*\)/gu;

export function normalizeConverterMarkdown(markdown: string): { text: string; pages: number | null } {
  const anchored = markdown
    .replace(SOURCE_PAGE_ANCHOR, "<!-- page: $1 -->")
    .replace(FAST_PAGE_ANCHOR, "<!-- page: $1 -->")
    .replace(IMAGE_LINK, (_m, alt: string) => {
      const caption = alt.replace(/\\(.)/gu, "$1").trim();
      return caption ? `[figure: ${caption}]` : "[figure]";
    });
  const out: string[] = [];
  let lastNonBlank = "";
  for (const line of anchored.split("\n")) {
    const slide = SLIDE_HEADING.exec(line);
    if (slide && PAGE_ANCHOR_LINE.exec(lastNonBlank)?.[1] !== slide[1]) out.push(`<!-- page: ${slide[1]} -->`, "");
    out.push(line);
    if (line.trim()) lastNonBlank = line;
  }
  const text = out.join("\n");
  const pages = (text.match(/^[ \t]*<!--\s*page:\s*\d+\s*-->[ \t]*$/gmu) ?? []).length;
  return { text, pages: pages || null };
}
