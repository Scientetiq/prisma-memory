import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { approvalsRequired, canonicalJson, derivedKey, HUMAN_ONLY_ACTIONS, HUMAN_SESSION_REQUIRED_TEXT, isHumanSession, log, newId, raiseAlert, setAdminSettingsGuardWired, settingsPolicy, testHooksEnabled,
         type AdminRole, type ApprovalSummary } from "@memory/shared";
import type { AdminCaller, App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { APPROVAL_SUMMARY_CONTROLS, describeApproval } from "./approvals-describe.ts";
import { breakglassWindowLive } from "./breakglass.ts";
import { adminDb } from "./db.ts";
import { isUuidParam } from "../paging.ts";
import type { AdminEnv } from "./middleware.ts";
import { actionOf, adminRouteDefs, routeOf, routeParam, type RouteDef } from "./registry.ts";
import { BREAKGLASS_ONLY, NOT_IMPLEMENTED, SESSION_EXPIRED, STEPUP_REQUIRED } from "./responses.ts";
import { freshUv } from "./session.ts";
import { adminNow } from "./test-clock.ts";

export const secondSignatureOn = (app: Pick<App, "settings">): boolean => approvalsRequired(app);

export const APPROVAL = {
  not_found: { code: "approval_not_found", message: "Request not found" },
  self: { code: "approval_self", message: "You cannot sign your own request: another person is needed" },
  role: { code: "approval_role", message: "This request is signed by another role" },
  state: { code: "approval_state", message: "The request is already signed, rejected, cancelled or carried out" },
  expired: { code: "approval_expired", message: "The request has expired — submit it again" },
  mismatch: { code: "approval_mismatch", message: "The request does not match the action being carried out" },
} as const;
export const APPROVAL_NEEDS_SESSION = { code: "forbidden", reason: "approval_required",
  message: "The action needs a second signature from another administrator or security auditor. Sign in to the admin panel with your own session" } as const;
const NOT_A_PERSON = { code: "forbidden", message: "Sign the request using your own session. The shared admin@local account cannot sign requests" } as const;
export const APPROVAL_REQUIRES_PERSON = { code: "forbidden", reason: "approval_requires_person",
  message: "Submit the second-signature request using your own session. Sign in to the admin panel with your company account. The shared admin@local account cannot submit requests" } as const;
const LOCAL_METHODS: ReadonlySet<string> = new Set(["local", "local_breakglass"]);
const isLocalSession = (a: Pick<AdminCaller, "authMethod">): boolean => LOCAL_METHODS.has(a.authMethod);
const NO_REQUESTER = { code: "forbidden", message: "A person must submit the request before it can be signed. Ask them to submit it again using their own session" } as const;
const SUBJECT_SELF = { code: "approval_self", message: "Another person must sign a request for an action affecting you" } as const;
const APPROVER_GONE = { code: "approval_state", message: "The signer no longer holds the required role or is inactive. Get a new signature" } as const;
const TOOL_SESSION = { code: "forbidden", message: "Tool sessions cannot sign or execute requests" } as const;
const NOT_REQUESTER = { code: "forbidden", message: "Only the person who submitted the request can execute or cancel it" } as const;

export const DEFAULT_APPROVERS: readonly AdminRole[] = ["memory_admin", "security_auditor"];

interface Execution { approvalId: string; action: string; approver: string | null; expires: number; conditions: readonly string[]; summary: string }
interface ApprovalCtx { app: App; execution?: Execution; wouldRequire?: boolean }
const ctxs = new WeakMap<object, ApprovalCtx>();

export function adminAppOf(c: Context): App | null {
  return ctxs.get(c)?.app ?? null;
}
function ctxFor(c: Context, app: App): ApprovalCtx {
  let x = ctxs.get(c);
  if (!x) { x = { app }; ctxs.set(c, x); }
  return x;
}

export const APPROVED_EXECUTION_HEADER = "x-memory-approved-execution";
const executions = new Map<string, Execution>();
function takeExecution(token: string): Execution | null {
  const now = Date.now();
  for (const [k, v] of executions) if (v.expires < now) executions.delete(k);
  const e = executions.get(token) ?? null;
  executions.delete(token);
  return e;
}

export function issueExecutionForTests(e: Omit<Execution, "expires">): string {
  if (!testHooksEnabled()) throw new Error("issueExecutionForTests requires MEMORY_TEST_HOOKS=1");
  const token = randomBytes(32).toString("base64url");
  executions.set(token, { ...e, expires: Date.now() + 60_000 });
  return token;
}

export function approvalIdOf(c: Context): string | null {
  return ctxs.get(c)?.execution?.approvalId ?? null;
}

export function approverOf(c: Context): string | null {
  return ctxs.get(c)?.execution?.approver ?? null;
}

export function wouldRequireApproval(c: Context): boolean {
  return ctxs.get(c)?.wouldRequire === true;
}

let conditionalWired = false;
export function setConditionalApprovalsWired(v: boolean): void {
  conditionalWired = v;
  setAdminSettingsGuardWired(v);
}
export const conditionalApprovalsWired = (): boolean => conditionalWired;

export function routeAlways(def: (Pick<RouteDef, "id"> & Partial<RouteDef>) | null | undefined, app?: Pick<App, "settings">): boolean {
  if (!def) return false;
  if (app && !approvalsRequired(app)) return false;
  if (def.always === true) return true;
  const actions = settingsPolicy().actions;
  return actions[actionOf(def)]?.always === true || actions[def.id]?.always === true;
}

export function routeSubject(def: Pick<RouteDef, "id"> & Partial<RouteDef>, path: string): string | null | undefined {
  if (!def.subject_param || !def.path) return undefined;
  const v = routeParam(def.path, path, def.subject_param);
  return v !== null && isUuidParam(v) ? v.toLowerCase() : null;
}

export function canonicalQuery(search: string): string {
  const p = [...new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)];
  p.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

export function canonicalBody(text: string): string {
  if (!text.trim()) return "null";
  try { return canonicalJson(JSON.parse(text)); } catch { return JSON.stringify(text); }
}

export interface ApprovalRequestParts { method: string; path: string; query: string; body: string }

export function canonicalRequest(r: ApprovalRequestParts): string {
  return `${r.method.toUpperCase()}\n${r.path}\n${canonicalQuery(r.query)}\n${canonicalBody(r.body)}`;
}

export const requesterOf = (a: Pick<AdminCaller, "personId" | "localLogin" | "login">): string => a.personId ?? `local:${a.localLogin ?? a.login}`;

export function payloadHash(appSecret: string, canonical: string, requester: string): Buffer {
  return createHmac("sha256", derivedKey(appSecret, "memory-approval")).update(`${canonical}\n${requester}`).digest();
}

interface SealedRequest extends ApprovalRequestParts { contentType: string | null; conditions?: string[] }

export function sealBody(appSecret: string, id: string, r: SealedRequest): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derivedKey(appSecret, "memory-approval-body"), iv);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(JSON.stringify(r), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function openBody(appSecret: string, id: string, buf: Buffer): SealedRequest {
  const d = createDecipheriv("aes-256-gcm", derivedKey(appSecret, "memory-approval-body"), buf.subarray(0, 12));
  d.setAAD(Buffer.from(id));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as SealedRequest;
}

export const subjectHash = (action: string, subject: string): Buffer => createHash("sha256").update(`${action}\n${subject}`).digest();

interface ApprovalRow {
  id: string; action: string; summary: string; method: string; path: string; requested_at: Date; expires_at: Date;
  decided_at: Date | null; executed_at: Date | null; cancelled_at: Date | null; decision: "approved" | "rejected" | null;
  requested_by: string | null; requested_local: string | null; requested_login: string | null; decided_login: string | null;
  subject_hash: Buffer | null;
}
const ROW_COLS = `a.id, a.action, a.summary, a.method, a.path, a.requested_at, a.expires_at, a.decided_at, a.executed_at, a.cancelled_at,
  a.decision, a.requested_by, a.requested_local, COALESCE(a.requested_local, rp.login) AS requested_login, dp.login AS decided_login, a.subject_hash`;
const ROW_FROM = "admin_approvals a LEFT JOIN people rp ON rp.id = a.requested_by LEFT JOIN people dp ON dp.id = a.decided_by";

export type ApprovalState = ApprovalSummary["state"];
export function approvalState(r: Pick<ApprovalRow, "executed_at" | "cancelled_at" | "decision" | "expires_at">, now: Date): ApprovalState {
  if (r.executed_at) return "executed";
  if (r.cancelled_at) return "cancelled";
  if (r.decision === "rejected") return "rejected";
  if (new Date(r.expires_at).getTime() <= now.getTime()) return "expired";
  return r.decision === "approved" ? "approved" : "pending";
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
function summaryOf(r: ApprovalRow, now: Date): ApprovalSummary {
  return { id: r.id, state: approvalState(r, now), action: r.action, summary: r.summary, requested_by: r.requested_login ?? null,
           requested_at: iso(r.requested_at)!, expires_at: iso(r.expires_at)!, decided_by: r.decided_login ?? null,
           decided_at: iso(r.decided_at), executed_at: iso(r.executed_at) };
}

const STATE_SQL: Readonly<Record<ApprovalState, string>> = {
  pending: "a.decision IS NULL AND a.cancelled_at IS NULL AND a.executed_at IS NULL AND a.expires_at > $2",
  approved: "a.decision = 'approved' AND a.cancelled_at IS NULL AND a.executed_at IS NULL AND a.expires_at > $2",
  executed: "a.executed_at IS NOT NULL",
  rejected: "a.decision = 'rejected'",
  expired: "a.executed_at IS NULL AND a.cancelled_at IS NULL AND a.decision IS DISTINCT FROM 'rejected' AND a.expires_at <= $2",
  cancelled: "a.cancelled_at IS NOT NULL AND a.executed_at IS NULL",
};

async function rowById(app: App, id: string): Promise<ApprovalRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const r = await adminDb(app).query(`SELECT ${ROW_COLS} FROM ${ROW_FROM} WHERE a.id = $1 AND a.instance_id = $2`, [id, app.instanceId]);
  return (r.rows[0] as ApprovalRow | undefined) ?? null;
}

const adminOf = (c: Context): AdminCaller | null => (c.get("caller") as Caller | undefined)?.admin ?? null;
const isRequester = (r: Pick<ApprovalRow, "requested_by" | "requested_local">, a: AdminCaller): boolean =>
  r.requested_by ? r.requested_by === a.personId : !a.personId && !!r.requested_local && r.requested_local === (a.localLogin ?? a.login);

function routeDefByAction(action: string): RouteDef | null {
  const defs = adminRouteDefs();
  return defs.find((d) => d.id === action) ?? defs.find((d) => actionOf(d) === action) ?? null;
}

export interface ApprovalOptions {
  app?: App;
  always?: boolean;
  subject?: string;
}

export async function createApproval(app: App, c: Context, def: Pick<RouteDef, "id"> & Partial<RouteDef>,
                                     o: { condition?: string; describe?: () => string; subject?: string; conditions?: readonly string[]; previousSummary?: string } = {}): Promise<Response> {
  const a = adminOf(c);
  if (!a?.sessionId) return c.json(APPROVAL_NEEDS_SESSION, 403);
  if (a.breakglassWindowId) return c.json(BREAKGLASS_ONLY, 403);
  if (!a.personId || isLocalSession(a)) return c.json(APPROVAL_REQUIRES_PERSON, 403);
  const action = actionOf(def);
  const subject = o.subject ?? routeSubject(def, c.req.path);
  if (def.subject_param && !subject)
    return c.json({ code: "invalid_argument", message: `Path parameter ${def.subject_param} must be an identifier (uuid) to link the request` }, 400);
  const body = await c.req.text().catch(() => "");
  const url = new URL(c.req.url);
  const conditions = [...new Set([...(o.conditions ?? []), ...(o.condition ? [o.condition] : [])])];
  const parts: SealedRequest = { method: c.req.method.toUpperCase(), path: c.req.path, query: url.search.slice(1), body, contentType: c.req.header("content-type") ?? null, conditions };
  const id = newId();
  const now = adminNow();
  const ttlH = Number(app.settings.get<number>("admin.second_signature_ttl_hours", 24));
  const expires = new Date(now.getTime() + (Number.isFinite(ttlH) && ttlH > 0 ? ttlH : 24) * 3_600_000);
  let parsed: unknown = null;
  try { parsed = body.trim() ? JSON.parse(body) : null; } catch { parsed = null; }
  let summary: string;
  const names = (c.get("approvalNames") ?? {}) as Record<string, string>;
  try { summary = (o.describe ? o.describe() : describeApproval(def, parsed, { condition: o.condition, params: { ...names, ...(c.req.param() as Record<string, string>) } })) || action; }
  catch { summary = action; }
  if (o.previousSummary) summary = `${o.previousSummary}; also: ${summary}`;
  summary = summary.replace(APPROVAL_SUMMARY_CONTROLS, " ");
  summary = summary.length > 300 ? `${summary.slice(0, 299)}…` : summary;
  await adminDb(app).query(
    `INSERT INTO admin_approvals (id, instance_id, action, summary, method, path, payload_hash, body_enc, requested_by, requested_local,
                                  requested_session, requested_at, expires_at, subject_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, app.instanceId, action, summary, parts.method, parts.path, payloadHash(app.appSecret, canonicalRequest(parts), requesterOf(a)),
     sealBody(app.appSecret, id, parts), a.personId, null, a.sessionId, now, expires,
     subject ? subjectHash(action, subject) : null]);
  const route = action !== def.id ? { route: def.id } : {};
  await audit(app, c.get("caller") as Caller, { event_type: "admin", details: { op: "approval_request", approval: id, action, ...route } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "medium", code: "approval_requested",
    summary: `New second-signature request from ${a.login}: ${summary}`.slice(0, 300), details: { approval: id, action, admin_login: a.login, ...route } });
  return c.json({ approval: { id, state: "pending", summary, expires_at: expires.toISOString() } }, 202);
}

export async function requireApproval(c: Context, condition: string, describe: () => string, o: ApprovalOptions = {}): Promise<Response | null> {
  if (c.get("breakglassNarrowOnly") === true) return c.json(BREAKGLASS_ONLY, 403);
  const app = o.app ?? adminAppOf(c);
  if (!app) throw new Error("requireApproval: the request is not bound to an application. Pass { app } on the main listener");
  const x = ctxFor(c, app);
  const def = (c.get("adminRoute") as RouteDef | null | undefined) ?? routeOf(c.req.method, c.req.path) ?? { id: `${c.req.method} ${c.req.routePath ?? c.req.path}`.slice(0, 120) };
  if (x.execution) {
    if (x.execution.conditions.includes(condition)) return null;
    return createApproval(app, c, def, { condition, describe, subject: o.subject, conditions: x.execution.conditions, previousSummary: x.execution.summary });
  }
  if (!secondSignatureOn(app)) { x.wouldRequire = true; return null; }
  return createApproval(app, c, def, { condition, describe, subject: o.subject });
}

export function approvalGate(app: App): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const x = ctxFor(c, app);
    const token = c.req.header(APPROVED_EXECUTION_HEADER);
    const def = c.get("adminRoute");
    if (token) {
      const e = takeExecution(token);
      if (!e || !def || actionOf(def) !== e.action) return c.json(APPROVAL.mismatch, 409);
      x.execution = e;
      await next();
      return;
    }
    const a = c.get("caller")?.admin;
    if (a?.sessionId && a.breakglassWindowId && !(await breakglassWindowLive(app, a.breakglassWindowId))) return c.json(SESSION_EXPIRED, 401);
    const required = secondSignatureOn(app);
    const humanOnly = !required && !!def && HUMAN_ONLY_ACTIONS.has(actionOf(def));
    if (humanOnly && !isHumanSession(a)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (def?.class === "second_signature") {
      if (required) return createApproval(app, c, def);
      x.wouldRequire = true;
    } else if (def?.class === "conditional" && required && !conditionalWired) {
      c.set("approvalUnavailable", true);
      return c.json(NOT_IMPLEMENTED, 501);
    }
    await next();
    if (x.wouldRequire && def && c.res.status >= 200 && c.res.status < 300)
      await audit(app, c.get("caller"), { event_type: "admin", details: { op: "approval_request", action: actionOf(def), would_require_approval: true } });
    if (humanOnly && def && c.res.status >= 200 && c.res.status < 300) await externalWeakened(app, { action: actionOf(def), admin_login: a?.login ?? null, auth: a?.authMethod ?? null });
  };
}

export const HUMAN_SESSION_REQUIRED = { code: "human_session_required", message: HUMAN_SESSION_REQUIRED_TEXT } as const;

export async function externalWeakened(app: App, d: { keys?: string[]; action?: string; admin_login: string | null; auth: string | null; old_transport_mail?: "sent" | "failed"; via?: string }): Promise<void> {
  const what = d.action ? `executed action ${d.action}` : `weakened ${(d.keys ?? []).slice(0, 8).join(", ")}`;
  const pre = d.old_transport_mail === "failed" ? "; the previous mail transport failed to send the message" : "";
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "external_weakened",
    summary: `External perimeter in basic: ${what}${d.admin_login ? ` (${d.admin_login})` : ""}${pre}`.slice(0, 300),
    details: { ...(d.keys ? { keys: d.keys.slice(0, 50) } : {}), ...(d.action ? { action: d.action } : {}), ...(d.admin_login ? { admin_login: d.admin_login } : {}), ...(d.auth ? { auth: d.auth } : {}),
               ...(d.old_transport_mail ? { old_transport_mail: d.old_transport_mail } : {}), ...(d.via ? { via: d.via } : {}) } });
}

export function mainListenerApprovalGuard(app: App): MiddlewareHandler {
  return async (c, next) => {
    const def = routeOf(c.req.method, c.req.path);
    const required = secondSignatureOn(app);
    if (!required && def && HUMAN_ONLY_ACTIONS.has(actionOf(def))) return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (def?.class === "second_signature" && required) return c.json(APPROVAL_NEEDS_SESSION, 403);
    if (def?.class === "conditional" && required && !conditionalWired) return c.json(NOT_IMPLEMENTED, 501);
    ctxFor(c, app);
    await next();
  };
}

export async function cancelOpenApprovals(app: App): Promise<number> {
  const r = await adminDb(app).query(
    "UPDATE admin_approvals SET cancelled_at = $2, body_enc = NULL WHERE instance_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL AND decision IS DISTINCT FROM 'rejected' RETURNING id",
    [app.instanceId, adminNow()]);
  return r.rowCount ?? 0;
}

const planes = new WeakMap<App, { request: (r: Request, init?: RequestInit, env?: unknown) => Response | Promise<Response> }>();
async function planeOf(app: App) {
  let p = planes.get(app);
  if (!p) {
    const { buildAdminPlane } = await import("./app.ts");
    p = buildAdminPlane(app);
    planes.set(app, p);
  }
  return p;
}

async function execute(app: App, c: Context, a: AdminCaller, id: string): Promise<Response> {
  const db = adminDb(app);
  const now = adminNow();
  const approverLive = `EXISTS (SELECT 1 FROM people p JOIN role_grants g ON g.person_id = p.id AND g.instance_id = p.instance_id
      WHERE p.id = admin_approvals.decided_by AND p.instance_id = admin_approvals.instance_id AND p.active
        AND g.role_code = admin_approvals.decided_role AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()))`;
  const claimed = (await db.query(
    `UPDATE admin_approvals SET executed_at = $3
      WHERE id = $1 AND instance_id = $2 AND decision = 'approved' AND executed_at IS NULL AND cancelled_at IS NULL AND expires_at > $3
        AND ${approverLive}
      RETURNING body_enc, payload_hash, method, path, action, summary, requested_by, requested_local, decided_by`, [id, app.instanceId, now])).rows[0] as
    { body_enc: Buffer | null; payload_hash: Buffer; method: string; path: string; action: string; summary: string; requested_by: string | null; requested_local: string | null; decided_by: string | null } | undefined;
  if (!claimed) {
    const gone = (await db.query(`SELECT 1 FROM admin_approvals WHERE id = $1 AND instance_id = $2 AND decision = 'approved' AND executed_at IS NULL
        AND cancelled_at IS NULL AND expires_at > $3 AND NOT ${approverLive}`, [id, app.instanceId, now])).rowCount;
    return c.json(gone ? APPROVER_GONE : APPROVAL.state, 409);
  }
  const finish = async (status: number) => {
    await db.query("UPDATE admin_approvals SET executed_status = $2, body_enc = NULL WHERE id = $1", [id, status]);
    await audit(app, c.get("caller") as Caller, { event_type: "admin", details: { op: "approval_execute", approval: id, action: claimed.action, status } });
  };
  let parts: SealedRequest;
  try {
    if (!claimed.body_enc) throw new Error("no body");
    parts = openBody(app.appSecret, id, claimed.body_enc);
  } catch {
    await finish(409);
    return c.json(APPROVAL.mismatch, 409);
  }
  const want = payloadHash(app.appSecret, canonicalRequest(parts), requesterOf(a));
  const def = routeOf(parts.method, parts.path);
  if (want.length !== claimed.payload_hash.length || !timingSafeEqual(want, claimed.payload_hash) || parts.method !== claimed.method
      || parts.path !== claimed.path || !def || actionOf(def) !== claimed.action) {
    await finish(409);
    return c.json(APPROVAL.mismatch, 409);
  }
  const approver = claimed.decided_by
    ? ((await db.query("SELECT login FROM people WHERE id = $1", [claimed.decided_by])).rows[0]?.login as string | undefined) ?? null : null;
  const token = randomBytes(32).toString("base64url");
  executions.set(token, { approvalId: id, action: claimed.action, approver, expires: Date.now() + 60_000, conditions: parts.conditions ?? [], summary: claimed.summary });
  const headers = new Headers();
  for (const [k, v] of Object.entries(c.req.header())) if (k.toLowerCase() === "authorization" || k.toLowerCase().startsWith("x-memory-client-")) headers.set(k, v);
  if (parts.contentType) headers.set("content-type", parts.contentType);
  headers.set(APPROVED_EXECUTION_HEADER, token);
  const target = new URL(`${parts.path}${parts.query ? `?${parts.query}` : ""}`, c.req.url);
  let res: Response;
  try {
    const plane = await planeOf(app);
    res = await plane.request(new Request(target, { method: parts.method, headers, ...(parts.method === "GET" || parts.method === "HEAD" ? {} : { body: parts.body }) }), undefined, c.env);
  } catch (e) {
    executions.delete(token);
    log.error("approval_execute_failed", { approval: id, error: ((e as Error)?.message ?? "").slice(0, 200) });
    await finish(500);
    return c.json({ code: "internal", message: "The request could not be executed" }, 500);
  }
  executions.delete(token);
  await finish(res.status);
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "medium", code: "approval_executed",
    summary: `Executed second-signature request (${claimed.action}), response ${res.status}`.slice(0, 300), details: { approval: id, action: claimed.action, status: res.status } });
  return res;
}

async function hasWebauthnKeys(app: App, personId: string): Promise<boolean> {
  const r = await adminDb(app).query("SELECT 1 FROM admin_webauthn_credentials WHERE person_id = $1 AND instance_id = $2 AND disabled_at IS NULL LIMIT 1",
    [personId, app.instanceId]);
  return (r.rowCount ?? 0) > 0;
}

export function approvalsRoutes(app: App): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();
  r.get("/api/v1/admin/approvals", async (c) => {
    const state = c.req.query("state") as ApprovalState | undefined;
    if (state !== undefined && !Object.hasOwn(STATE_SQL, state)) return c.json({ code: "invalid_argument", message: "state must be pending, approved, executed, rejected, expired or cancelled" }, 400);
    const now = adminNow();
    const rows = (await adminDb(app).query(
      `SELECT ${ROW_COLS} FROM ${ROW_FROM} WHERE a.instance_id = $1 AND ${state ? STATE_SQL[state] : "$2::timestamptz IS NOT NULL"}
        ORDER BY a.requested_at DESC LIMIT 200`, [app.instanceId, now])).rows as ApprovalRow[];
    return c.json({ items: rows.map((x) => summaryOf(x, now)) });
  });
  r.get("/api/v1/admin/approvals/:id", async (c) => {
    const row = await rowById(app, c.req.param("id"));
    return row ? c.json(summaryOf(row, adminNow())) : c.json(APPROVAL.not_found, 404);
  });

  const decide = async (c: Context<AdminEnv>, decision: "approved" | "rejected"): Promise<Response> => {
    const a = adminOf(c);
    if (!a?.sessionId) return c.json(APPROVAL_NEEDS_SESSION, 403);
    if (a.breakglassWindowId) return c.json(BREAKGLASS_ONLY, 403);
    if (a.authMethod === "tool") return c.json(TOOL_SESSION, 403);
    if (!a.personId || isLocalSession(a)) return c.json(NOT_A_PERSON, 403);
    const id = c.req.param("id")!;
    const row = await rowById(app, id);
    if (!row) return c.json(APPROVAL.not_found, 404);
    if (row.requested_by === a.personId) return c.json(APPROVAL.self, 403);
    if (decision === "approved" && !row.requested_by) return c.json(NO_REQUESTER, 403);
    if (decision === "approved" && row.subject_hash && [a.personId, a.login].some((s) => subjectHash(row.action, s).equals(row.subject_hash!)))
      return c.json(SUBJECT_SELF, 403);
    const now = adminNow();
    const st = approvalState(row, now);
    if (st === "expired") return c.json(APPROVAL.expired, 409);
    if (st !== "pending") return c.json(APPROVAL.state, 409);
    const approvers = routeDefByAction(row.action)?.approvers ?? DEFAULT_APPROVERS;
    if (!approvers.includes(a.role)) return c.json(APPROVAL.role, 403);
    if (decision === "approved" && await hasWebauthnKeys(app, a.personId) && !freshUv(app, a.uvAt)) return c.json(STEPUP_REQUIRED, 403);
    const upd = await adminDb(app).query(
      `UPDATE admin_approvals SET decided_by = $3, decided_role = $4, decided_at = $5, decision = $6${decision === "rejected" ? ", body_enc = NULL" : ""}
        WHERE id = $1 AND instance_id = $2 AND decision IS NULL AND cancelled_at IS NULL AND executed_at IS NULL AND expires_at > $5
          AND (requested_by IS NULL OR requested_by <> $3) RETURNING id`, [id, app.instanceId, a.personId, a.role, now, decision]);
    if (!upd.rowCount) return c.json(APPROVAL.state, 409);
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: decision === "approved" ? "approval_approve" : "approval_reject", approval: id, action: row.action } });
    return c.json(summaryOf((await rowById(app, id))!, adminNow()));
  };
  r.post("/api/v1/admin/approvals/:id/approve", (c) => decide(c, "approved"));
  r.post("/api/v1/admin/approvals/:id/reject", (c) => decide(c, "rejected"));

  r.post("/api/v1/admin/approvals/:id/cancel", async (c) => {
    const a = adminOf(c);
    if (!a?.sessionId) return c.json(APPROVAL_NEEDS_SESSION, 403);
    const id = c.req.param("id");
    const row = await rowById(app, id);
    if (!row) return c.json(APPROVAL.not_found, 404);
    if (!isRequester(row, a)) return c.json(NOT_REQUESTER, 403);
    const st = approvalState(row, adminNow());
    if (st !== "pending" && st !== "approved") return c.json(st === "expired" ? APPROVAL.expired : APPROVAL.state, 409);
    const upd = await adminDb(app).query(
      "UPDATE admin_approvals SET cancelled_at = $3, body_enc = NULL WHERE id = $1 AND instance_id = $2 AND cancelled_at IS NULL AND executed_at IS NULL RETURNING id",
      [id, app.instanceId, adminNow()]);
    if (!upd.rowCount) return c.json(APPROVAL.state, 409);
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "approval_cancel", approval: id, action: row.action } });
    return c.json(summaryOf((await rowById(app, id))!, adminNow()));
  });

  r.post("/api/v1/admin/approvals/:id/execute", async (c) => {
    const a = adminOf(c);
    if (!a?.sessionId) return c.json(APPROVAL_NEEDS_SESSION, 403);
    if (a.breakglassWindowId) return c.json(BREAKGLASS_ONLY, 403);
    if (a.authMethod === "tool") return c.json(TOOL_SESSION, 403);
    if (isLocalSession(a)) return c.json(APPROVAL_REQUIRES_PERSON, 403);
    const id = c.req.param("id");
    const row = await rowById(app, id);
    if (!row) return c.json(APPROVAL.not_found, 404);
    if (!isRequester(row, a)) return c.json(NOT_REQUESTER, 403);
    const st = approvalState(row, adminNow());
    if (st === "expired") return c.json(APPROVAL.expired, 409);
    if (st !== "approved") return c.json(APPROVAL.state, 409);
    return execute(app, c, a, id);
  });
  return r;
}
