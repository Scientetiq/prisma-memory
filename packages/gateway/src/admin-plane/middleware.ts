import type { Context, MiddlewareHandler } from "hono";
import { ADMIN_SESSION_PREFIX, effectiveMode, kindFromPrefix, raiseAlert, testHooksEnabled, type AdminRole, type RouteClass } from "@memory/shared";
import type { AdminCaller, App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { authenticate, baseUrlOf, HttpReject, workplaceClientAddress } from "../auth.ts";
import { bareAddress, NOT_FOUND_BODY, onceIn } from "../channel.ts";
import { remoteOf } from "../rest.ts";
import { fromWorkplace } from "../workplace.ts";
import { legacyPanelTokenProblem } from "./legacy-token.ts";
import { currentListener } from "./listeners.ts";
import { compilePath, matchRoute, routeOf, type RouteDef } from "./registry.ts";
import { localTotpLogin } from "./local-totp-caller.ts";
import { breakglassWindowLive } from "./breakglass.ts";
import { adminSessionCaller, isSessionReject, verifyAdminSession } from "./session.ts";
import { BREAKGLASS_ONLY, ROLE_FORBIDDEN, SESSION_EXPIRED } from "./responses.ts";

export type AdminEnv = { Variables: {
  caller: Caller;
  adminRoute: RouteDef | null;
  breakglassNarrowOnly?: boolean;
  approvalUnavailable?: boolean;
  approvalNames?: Record<string, string>;
} };

export const AUDITOR_KEY_PATHS = /^\/api\/v1\/admin\/(audit|report|search-quality)$/;

export const LLM_GATE_OP = "llm_gate";
export const LLM_GATE_KEY_ROUTES: ReadonlySet<string> = new Set([
  "admin.llm_gate.get", "admin.llm_gate.hold.put", "admin.llm_gate.hold.delete", "admin.llm_gate.lease.put", "admin.llm_gate.lease.delete",
  "admin.llm_gate.arbiter.put", "admin.llm_gate.arbiter.delete",
]);
export const LLM_GATE_KEY_AUTH: AdminCaller["authMethod"] = "llm_gate_key";
export const LLM_GATE_KEY_OWNER_PREFIX = "floor:";

export function isLlmGateKey(caller: Caller): boolean {
  const svc = caller.service;
  return caller.principalType === "service" && svc !== null && !caller.onBehalfOf && caller.person === null && svc.obo_allowed !== true
    && Array.isArray(svc.allowed_ops) && svc.allowed_ops.length === 1 && svc.allowed_ops[0] === LLM_GATE_OP
    && caller.allowedOps !== null && caller.allowedOps.size === 1 && caller.allowedOps.has(LLM_GATE_OP);
}

export function llmGateKeyModeOn(app: Pick<App, "settings">): boolean {
  return effectiveMode(app.settings) === "advanced";
}

export interface LlmGateKeyRequest {
  unix: boolean;
  netBound: boolean;
  force?: boolean;
  owner?: unknown;
  reason?: unknown;
}

export function llmGateKeyRefusal(route: RouteDef, r: LlmGateKeyRequest): string | null {
  if (!r.unix && !r.netBound) return "The scoped model arbiter key is accepted only through the admin listener socket or with a network restriction (net_cidrs)";
  if (route.id === "admin.llm_gate.hold.delete" && r.force) return "The administrator’s “Resume” action (force) is unavailable to the arbiter, which can only lift its own pause";
  if (route.id === "admin.llm_gate.get") return null;
  if (typeof r.owner !== "string" || !r.owner.startsWith(LLM_GATE_KEY_OWNER_PREFIX))
    return `The scoped model arbiter key can only manage its own pauses, leases and registration. The owner (owner) is “${LLM_GATE_KEY_OWNER_PREFIX}…”`;
  if (route.id === "admin.llm_gate.hold.put" && r.reason !== "floor") return "The scoped model arbiter key can pause only the check queue (reason floor)";
  return null;
}

export function llmGateKeyCaller(caller: Caller, route: RouteDef | null): Caller | null {
  if (!route || !LLM_GATE_KEY_ROUTES.has(route.id) || !isLlmGateKey(caller)) return null;
  const name = caller.service!.name;
  return { ...caller, principalType: "system", clientLabel: `llm-gate:${name}`,
           admin: { sessionId: null, personId: null, login: `service:${name}`, role: "memory_admin", authMethod: LLM_GATE_KEY_AUTH, uvAt: null, breakglassWindowId: null } };
}

async function llmGateKeyRequest(app: App, c: Context, caller: Caller): Promise<LlmGateKeyRequest> {
  const out: LlmGateKeyRequest = { unix: currentListener()?.unix === true, netBound: caller.netBound === true,
                                   force: c.req.query("force") !== undefined };
  if (c.req.method === "DELETE") out.owner = c.req.query("owner");
  else if (c.req.method === "PUT") {
    const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (b && typeof b === "object" && !Array.isArray(b)) { out.owner = b.owner; out.reason = b.reason; }
  }
  return out;
}

export const UNIX_SOCKET_ADDRESS = "127.0.0.1";

export async function adminClientIp(app: App, c: Context): Promise<string | null> {
  const unix = currentListener()?.unix === true;
  const sock = remoteOf(c);
  const hinted = await fromWorkplace(app, sock) ? await workplaceClientAddress(app, (n) => c.req.header(n), sock) : sock;
  const ip = bareAddress(hinted);
  if (ip) return ip;
  return unix ? UNIX_SOCKET_ADDRESS : null;
}

export function directAdminCall(c: Context): boolean {
  if (currentListener()?.unix !== true) return false;
  return !Object.keys(c.req.header()).some((h) => h.toLowerCase().startsWith("x-memory-client-"));
}

const bearerOf = (c: Context): string | null => /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? null;

async function hasRole(app: App, personId: string, role: AdminRole): Promise<boolean> {
  const r = await app.db.control.query(
    `SELECT 1 FROM role_grants WHERE person_id = $1 AND role_code = $2 AND instance_id = $3
        AND revoked_at IS NULL AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [personId, role, app.instanceId]);
  return (r.rowCount ?? 0) > 0;
}

export function adminPlaneAuth(app: App): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const route = routeOf(c.req.method, c.req.path);
    c.set("adminRoute", route);
    if (route?.class === "auth") { await next(); return; }
    const plain = bearerOf(c);
    const ip = await adminClientIp(app, c);
    if (plain?.startsWith(ADMIN_SESSION_PREFIX)) {
      const v = await verifyAdminSession(app, plain, ip, { direct: directAdminCall(c) });
      if (isSessionReject(v)) {
        if (v.breakglassWindowId) await breakglassWindowLive(app, v.breakglassWindowId);
        await audit(app, null, { event_type: "auth_failure", ip, details: { reason: "session_expired", why: v.reason, ...(v.sessionId ? { admin_session: v.sessionId } : {}) } });
        return c.json(SESSION_EXPIRED, 401);
      }
      c.set("caller", adminSessionCaller(v, ip, baseUrlOf(c.req.raw)));
      await next();
      return;
    }
    if (!plain) return c.json(SESSION_EXPIRED, 401);
    const legacyProblem = plain.startsWith("mem_adm_") ? legacyPanelTokenProblem(app.settings.get<string>("admin.local_login", "open")) : null;
    if (legacyProblem) {
      await audit(app, null, { event_type: "auth_failure", ip, details: { reason: legacyProblem.reason, ...legacyProblem.details } });
      return c.json(SESSION_EXPIRED, 401);
    }
    const caller = await authenticate(app, c.req.raw, remoteOf(c));
    // Authenticated non-local credentials get the own-factor unknown-path response before key-role restrictions.
    if (route?.id.startsWith("admin_auth.local_totp.") && caller.principalType !== "system") {
      c.header("Cache-Control", "no-store");
      return c.json(NOT_FOUND_BODY, 404);
    }
    let admin: AdminCaller | null = null;
    if (caller.principalType === "system") {
      const legacy = plain.startsWith("mem_adm_");
      admin = { sessionId: null, personId: null, login: legacy ? (caller.clientLabel ?? "admin:?").replace(/^admin:/, "") : "system", role: "memory_admin",
                authMethod: legacy ? "legacy_session" : "system_key", uvAt: null, breakglassWindowId: null };
    } else if (caller.principalType === "person" && caller.person && !caller.allowedOps && kindFromPrefix(plain) !== null
               && ["GET", "HEAD"].includes(c.req.method) && AUDITOR_KEY_PATHS.test(c.req.path)
               && app.settings.get<boolean>("admin.auditor_key_access", true) === true && await hasRole(app, caller.person.id, "security_auditor")) {
      admin = { sessionId: null, personId: caller.person.id, login: caller.person.login, role: "security_auditor", authMethod: "auditor_key", uvAt: null, breakglassWindowId: null };
    }
    if (!admin) {
      const gate = llmGateKeyCaller(caller, route);
      if (gate) {
        const why = llmGateKeyRefusal(route!, await llmGateKeyRequest(app, c, caller));
        if (why) throw new HttpReject(403, "forbidden", why);
        c.set("caller", gate);
        await next();
        return;
      }
      throw new HttpReject(403, "forbidden", "The admin API requires an administrator session");
    }
    c.set("caller", { ...caller, admin });
    await next();
  };
}

type RouteList = ReadonlyArray<{ method: string; path: string }>;
export function honoHasRoute(routes: RouteList, method: string, path: string): boolean {
  const handlers = routes.filter((r) => r.method !== "ALL" && !r.path.endsWith("*"));
  return matchRoute(handlers.map((r) => ({ def: r, ...compilePath(r.path) })), method, path) !== null;
}

const GATED_CLASSES: ReadonlySet<RouteClass> = new Set<RouteClass>(["read", "narrow", "ordinary", "second_signature", "conditional"]);

export function routeGate(app: App, routes: () => RouteList): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const def = c.get("adminRoute");
    if (!def) {
      if (honoHasRoute(routes(), c.req.method, c.req.path) && onceIn(app, `admin_route_unclassified:${c.req.method}:${c.req.routePath ?? c.req.path}`, 3_600_000))
        await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "admin_route_unclassified",
          summary: `Admin API route without a class: ${c.req.method} ${c.req.path.slice(0, 200)}`, details: { method: c.req.method, path: c.req.path.slice(0, 200) },
          dedupeKey: `admin_route_unclassified:${c.req.method}:${c.req.path.slice(0, 200)}:${new Date().toISOString().slice(0, 10)}` });
      return c.json(NOT_FOUND_BODY, 404);
    }
    if (def.class === "auth") { await next(); return; }
    if (def.class === "test_only" ? !testHooksEnabled() : !GATED_CLASSES.has(def.class)) return c.json(NOT_FOUND_BODY, 404);
    // Own local factors have the same hidden-path refusal for every non-local caller, before the role gate.
    if (def.id.startsWith("admin_auth.local_totp.")) {
      c.header("Cache-Control", "no-store");
      if (!localTotpLogin(app, c)) return c.json(NOT_FOUND_BODY, 404);
    }
    const a = c.get("caller")?.admin;
    if (!a || !Array.isArray(def.roles) || !def.roles.includes(a.role)) return c.json(ROLE_FORBIDDEN, 403);
    if (a.breakglassWindowId) {
      if (def.breakglass !== true) return c.json(BREAKGLASS_ONLY, 403);
      if (def.class === "conditional") c.set("breakglassNarrowOnly", true);
    }
    await next();
  };
}
