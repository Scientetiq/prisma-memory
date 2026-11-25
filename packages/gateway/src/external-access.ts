import type { Context, Hono } from "hono";
import { anchorsDir, checkAnchors, cidrContains, currentAnchors, dirAnchorFiles, invalid, log, newId, SKILL_BUNDLE, tx } from "@memory/shared";
import { isNoticeKind, noticeNetwork, noticeText, noticeTime, queueExternalNotice } from "@memory/shared/external-notices";
import { audit } from "./audit.ts";
import { workplaceClientAddress } from "./auth.ts";
import { bareAddress, forwardedAddress, inNetworks, trustedProxies } from "./channel.ts";
import { authcheckCall, authcheckPreflight, AuthcheckUnavailable } from "./authcheck-client.ts";
import type { App, Caller } from "./context.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { requireHuman } from "./workplace.ts";

/** The MCP server name in generated agent configurations: the product name, read from the skill bundle description. */
const MCP_SERVER_NAME = SKILL_BUNDLE.name;

export const EXTERNAL_ERRORS = {
  fresh_login_required: { http: 409, text: "To switch on access from outside, sign in to the workplace again: a fresh sign-in is needed" },
  first_confirm_required: { http: 409, text: "Access from outside must be switched on for the first time from the office network or after support confirms who you are. The request has been sent to support" },
  factor_required: { http: 409, text: "Access from outside needs a second factor, and it is not set up in the memory yet. Contact support" },
  external_not_allowed: { http: 403, text: "Access from outside cannot be switched on for you now: the company rules do not allow it. Ask support" },
  external_unavailable: { http: 503, text: "Outside sign-in is not available now. Try again later" },
} as const;
export type ExternalErrorCode = keyof typeof EXTERNAL_ERRORS;

export const FRESH_LOGIN_PATH = "/login?fresh=1&next=/external";
export const CONFIRM_TTL_HOURS = 24;
const REQUEST_REUSE_HOURS = 24;
const FRESH_DEFAULT_MIN = 10;

const refuse = (c: Context, code: ExternalErrorCode, details?: Record<string, unknown>): Response =>
  c.json({ code, message: EXTERNAL_ERRORS[code].text, ...(details ? { details } : {}) }, EXTERNAL_ERRORS[code].http as 403 | 409 | 503);

const where = { path: "/external", section: "External access" };

export function freshLogin(authTime: Date | string | null | undefined, freshMin: number, now = Date.now()): boolean {
  if (authTime === null || authTime === undefined) return false;
  const at = new Date(authTime).getTime();
  const min = Number.isFinite(freshMin) && freshMin > 0 ? Math.min(60, freshMin) : FRESH_DEFAULT_MIN;
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= min * 60_000;
}

export function inOfficeNetworks(address: string | null | undefined, networks: readonly unknown[] | null | undefined): boolean {
  const ip = address?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (!ip || !Array.isArray(networks)) return false;
  return networks.some((n) => typeof n === "string" && (() => { try { return cidrContains(n, ip); } catch { return false; } })());
}

export type FirstConfirmStatus = "not_needed" | "office" | "requested" | "confirmed" | "none";

export function firstConfirmStatus(o: { firstTime: boolean; mode: unknown; office: boolean; confirmed: boolean; requested: boolean }): FirstConfirmStatus {
  if (!o.firstTime || o.mode !== "office_or_support") return "not_needed";
  if (o.office) return "office";
  if (o.confirmed) return "confirmed";
  return o.requested ? "requested" : "none";
}

export function preflightVerdict(p: { allowed: boolean; reasons: readonly string[]; needs_factor: boolean }):
  { ok: true } | { ok: false; code: "external_not_allowed"; reasons: string[] } | { ok: false; code: "factor_required" } {
  const reasons = [...new Set(p.reasons.filter((r) => r !== "needs_factor"))];
  if (reasons.length) return { ok: false, code: "external_not_allowed", reasons };
  if (p.needs_factor || p.reasons.includes("needs_factor")) return { ok: false, code: "factor_required" };
  return p.allowed ? { ok: true } : { ok: false, code: "external_not_allowed", reasons: ["closed"] };
}

export interface ExternalProgram { client_id: string; kind: string; title: string; command: string | null }

const q1 = (v: string): string => `'${v.replaceAll("'", "'\"'\"'")}'`;

export function externalCommand(kind: string, clientId: string, resource: string): string | null {
  if (/[\s'"\\]/.test(clientId) || /[\s'"\\]/.test(resource)) return null;
  if (kind === "claude_code") return `claude mcp add --transport http --scope user --client-id ${q1(clientId)} ${MCP_SERVER_NAME} ${q1(resource)}\nclaude mcp login ${MCP_SERVER_NAME}`;
  if (kind === "codex") return `codex mcp add ${MCP_SERVER_NAME} --url ${q1(resource)} --oauth-client-id ${q1(clientId)} --oauth-resource ${q1(resource)}\ncodex mcp login ${MCP_SERVER_NAME}`;
  return null;
}

interface EdgeDoc { hosts?: Array<{ resource?: string; roles?: string[] }>; clients?: Array<{ client_id: string; enabled: boolean; kind?: string; title?: string }> }

export function programsOf(doc: EdgeDoc | null | undefined): ExternalProgram[] {
  if (!doc) return [];
  const resource = (doc.hosts ?? []).find((h) => typeof h.resource === "string" && (h.roles ?? []).includes("mcp"))?.resource ?? null;
  return (doc.clients ?? []).filter((x) => x.enabled).slice(0, 32).map((x) => {
    const kind = x.kind ?? "local_other";
    return { client_id: x.client_id, kind, title: (x.title ?? x.client_id).slice(0, 40), command: resource ? externalCommand(kind, x.client_id, resource) : null };
  });
}

let programsCache: { tag: string; items: ExternalProgram[] } | null = null;
let programsOverride: ExternalProgram[] | null = null;
export function setExternalProgramsForTests(items: ExternalProgram[] | null): void { programsOverride = items; programsCache = null; }

async function edgePrograms(): Promise<ExternalProgram[]> {
  if (programsOverride) return programsOverride;
  const st = currentAnchors();
  if (!st.inForce) return [];
  const tag = `${st.serial ?? ""}:${st.sha256 ?? ""}`;
  if (programsCache?.tag === tag) return programsCache.items;
  let items: ExternalProgram[] = [];
  try {
    const checked = await checkAnchors(dirAnchorFiles(anchorsDir()));
    items = checked.inForce ? programsOf(checked.edge?.anchors as EdgeDoc | undefined) : [];
  } catch (e) {
    log.warn("external_programs_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
  }
  programsCache = { tag, items };
  return items;
}

interface AccessRow { enabled_at: Date | null; disabled_at: Date | null; disabled_code: string | null; first_enabled_at: Date | null }
const isOn = (r: AccessRow | undefined): boolean => !!r?.enabled_at && !r.disabled_at;
const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function officeCandidateAddress(app: Pick<App, "settings">, header: (name: string) => string | undefined): string | null {
  const peer = bareAddress(header("x-memory-client-peer") ?? "");            // the panel's socket stamp: the socket rule
  if (!peer) return null;
  const chain = (header("x-memory-client-forwarded") ?? "").trim();
  const addr = forwardedAddress(app, chain || null, peer);
  if (!addr || (chain && addr === peer)) return null;
  const peers = app.settings.get<unknown>("access.workplace_peers", []);
  if (inNetworks(addr, trustedProxies(app)) || inNetworks(addr, Array.isArray(peers) ? peers.filter((x): x is string => typeof x === "string") : [])) return null;
  return addr;
}

async function browserAddresses(app: App, c: Context, remoteOf: (c: Context) => string | null): Promise<{ office: string | null; shown: string | null }> {
  const header = (n: string): string | undefined => c.req.header(n);
  const office = officeCandidateAddress(app, header);
  if (!(header("x-memory-client-peer") || header("x-memory-client-ip"))) return { office, shown: null };
  const sock = remoteOf(c)?.replace(/^::ffff:/, "") ?? null;
  return { office, shown: await workplaceClientAddress(app, header, sock) };
}

async function sessionAuthTime(app: App, caller: Caller): Promise<Date | null> {
  const r = await app.db.control.query<{ auth_time: Date | null }>("SELECT auth_time FROM user_sessions WHERE id = $1", [caller.keyId]);
  return r.rows[0]?.auth_time ?? null;
}

async function confirmations(app: App, personId: string): Promise<{ confirmed: { id: string } | null; requested: boolean }> {
  const r = await app.db.control.query<{ id: string; confirmed_at: Date | null; expires_at: Date | null; requested_at: Date }>(
    `SELECT id, confirmed_at, expires_at, requested_at FROM external_access_confirmations
      WHERE person_id = $1 AND instance_id = $2 AND used_at IS NULL ORDER BY requested_at DESC LIMIT 20`, [personId, app.instanceId]);
  const now = Date.now();
  const confirmed = r.rows.find((x) => x.confirmed_at && x.expires_at && new Date(x.expires_at).getTime() > now) ?? null;
  const requested = r.rows.some((x) => !x.confirmed_at && now - new Date(x.requested_at).getTime() < REQUEST_REUSE_HOURS * 3_600_000);
  return { confirmed: confirmed ? { id: confirmed.id } : null, requested };
}

async function mfaMode(app: App): Promise<string> {
  try {
    const r = await app.db.control.query<{ mode: string }>("SELECT mode FROM mfa_policy($1)", [app.instanceId]);
    return r.rows[0]?.mode ?? "off";
  } catch (e) {
    if ((e as { code?: string })?.code !== "42883") throw e;
    return String(app.settings.get<string>("edge.mfa_mode", "off") ?? "off");
  }
}

async function factorEnrolled(personId: string): Promise<boolean> {
  const r = await authcheckCall("POST", "/v1/factor/status", { person_id: personId });
  const b = r.body as { enrolled?: unknown } | null;
  return r.status === 200 && !!b && b.enrolled === true;
}

export function registerExternalAccess(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null): void {
  const human = async (c: Context, what: string, bucket: "me_keys" | "me_keys_view"): Promise<{ caller: Caller; personId: string }> => {
    const caller = c.get("caller") as Caller;
    await requireHuman(app, caller, what, where);
    app.limiter.check(caller, bucket);
    return { caller, personId: caller.person!.id };
  };

  r.get("/api/v1/me/external", async (c) => {
    const { caller, personId } = await human(c, "View External access", "me_keys_view");
    const row = (await app.db.control.query<AccessRow>("SELECT enabled_at, disabled_at, disabled_code, first_enabled_at FROM external_access WHERE person_id = $1 AND instance_id = $2",
                                                        [personId, app.instanceId])).rows[0];
    const [authTime, conf, addr, programs, unseen] = await Promise.all([
      sessionAuthTime(app, caller), confirmations(app, personId), browserAddresses(app, c, remoteOf), edgePrograms(),
      app.db.control.query<{ n: number }>("SELECT count(*)::int AS n FROM external_notices WHERE person_id = $1 AND instance_id = $2 AND seen_at IS NULL", [personId, app.instanceId]),
    ]);
    const mode = app.settings.get<string>("edge.optin_first_confirm", "office_or_support");
    const firstTime = !row?.first_enabled_at;
    const status = firstConfirmStatus({ firstTime, mode, office: inOfficeNetworks(addr.office, app.settings.get<string[]>("edge.office_networks", [])),
                                        confirmed: !!conf.confirmed, requested: conf.requested });
    return c.json({
      enabled: isOn(row), enabled_at: isOn(row) ? iso(row!.enabled_at) : null, disabled_at: iso(row?.disabled_at), disabled_code: row?.disabled_code ?? null,
      fresh_ok: freshLogin(authTime, Number(app.settings.get<number>("edge.optin_fresh_login_min", FRESH_DEFAULT_MIN))),
      first_confirm: { needed: status !== "not_needed", status },
      login_enabled: app.settings.get<boolean>("edge.login_enabled", false) === true,
      programs, unseen_notices: Number(unseen.rows[0]?.n ?? 0),
    });
  });

  r.post("/api/v1/me/external/enable", async (c) => {
    const { caller, personId } = await human(c, "Enable external access", "me_keys");
    const raw = await c.req.text();
    if (raw.trim()) rejectUnknownFields(jsonObjectBody(safeJson(raw), "{}"), []);
    const already = (await app.db.control.query<AccessRow>("SELECT enabled_at, disabled_at, disabled_code, first_enabled_at FROM external_access WHERE person_id = $1 AND instance_id = $2",
                                                            [personId, app.instanceId])).rows[0];
    if (isOn(already)) return c.json({ enabled: true, first_confirm: null });
    if (!freshLogin(await sessionAuthTime(app, caller), Number(app.settings.get<number>("edge.optin_fresh_login_min", FRESH_DEFAULT_MIN))))
      return refuse(c, "fresh_login_required", { login_path: FRESH_LOGIN_PATH });
    try {
      const v = preflightVerdict(await authcheckPreflight(personId));
      if (!v.ok) return v.code === "factor_required" ? refuse(c, "factor_required", { reason: "needs_factor" }) : refuse(c, "external_not_allowed", { reasons: v.reasons });
      if ((await mfaMode(app)) === "required" && !(await factorEnrolled(personId))) return refuse(c, "factor_required", { reason: "mfa_required" });
    } catch (e) {
      if (!(e instanceof AuthcheckUnavailable)) throw e;
      log.warn("external_authcheck_unavailable", { why: e.why });
      return refuse(c, "external_unavailable");
    }
    const address = await browserAddresses(app, c, remoteOf);
    const firstTime = !already?.first_enabled_at;
    const confirmMode = app.settings.get<string>("edge.optin_first_confirm", "office_or_support");
    const out = await tx(app.db.control, async (q) => {
      await q.query("SELECT 1 FROM people WHERE id = $1 AND instance_id = $2 FOR UPDATE", [personId, app.instanceId]);
      const cur = (await q.query<AccessRow>("SELECT enabled_at, disabled_at, disabled_code, first_enabled_at FROM external_access WHERE person_id = $1", [personId])).rows[0];
      if (isOn(cur)) return { done: true as const, first: null };
      let first: "office" | "support" | "none" | null = null;
      if (!cur?.first_enabled_at) {
        if (confirmMode !== "office_or_support") first = "none";
        else if (inOfficeNetworks(address.office, app.settings.get<string[]>("edge.office_networks", []))) first = "office";
        else {
          const ok = (await q.query<{ id: string }>(
            `SELECT id FROM external_access_confirmations WHERE person_id = $1 AND instance_id = $2 AND used_at IS NULL
                AND confirmed_at IS NOT NULL AND expires_at > now() ORDER BY confirmed_at DESC LIMIT 1 FOR UPDATE`, [personId, app.instanceId])).rows[0];
          if (!ok) {
            const pending = (await q.query<{ id: string }>(
              `SELECT id FROM external_access_confirmations WHERE person_id = $1 AND instance_id = $2 AND used_at IS NULL AND confirmed_at IS NULL
                  AND requested_at > now() - make_interval(hours => $3) ORDER BY requested_at DESC LIMIT 1`, [personId, app.instanceId, REQUEST_REUSE_HOURS])).rows[0];
            const id = pending?.id ?? newId();
            if (!pending) await q.query("INSERT INTO external_access_confirmations (id, person_id, instance_id, requested_ip) VALUES ($1, $2, $3, $4::inet)",
                                        [id, personId, app.instanceId, address.shown]);
            return { done: false as const, request: id, created: !pending };
          }
          await q.query("UPDATE external_access_confirmations SET used_at = now() WHERE id = $1", [ok.id]);
          first = "support";
        }
      }
      await q.query(
        `INSERT INTO external_access (person_id, instance_id, enabled_at, enabled_session_id, first_enabled_at, first_confirm, updated_at)
         VALUES ($1, $2, now(), $3, now(), $4, now())
         ON CONFLICT (person_id) DO UPDATE SET enabled_at = now(), enabled_session_id = EXCLUDED.enabled_session_id,
           first_enabled_at = COALESCE(external_access.first_enabled_at, EXCLUDED.first_enabled_at),
           first_confirm = COALESCE(external_access.first_confirm, EXCLUDED.first_confirm),
           disabled_at = NULL, disabled_by = NULL, disabled_code = NULL, updated_at = now()`,
        [personId, app.instanceId, caller.keyId, first]);
      await queueExternalNotice(q, personId, "optin_enabled", { time: noticeTime(new Date()) });
      return { done: true as const, first };
    });
    if (!out.done) {
      if (out.created) await audit(app, caller, { event_type: "external", details: { op: "optin_confirm_requested", request_id: out.request } });
      return refuse(c, "first_confirm_required", { request_id: out.request });
    }
    await audit(app, caller, { event_type: "external", details: { op: "optin_enabled", first_confirm: out.first, first: firstTime } });
    return c.json({ enabled: true, first_confirm: out.first });
  });

  r.post("/api/v1/me/external/disable", async (c) => {
    const { caller, personId } = await human(c, "Disable external access", "me_keys");
    const off = await tx(app.db.control, async (q) => {
      const done = (await q.query<{ ok: boolean }>("SELECT external_access_disable($1::uuid, 'self', 'self') AS ok", [personId])).rows[0]?.ok === true;
      if (done) await queueExternalNotice(q, personId, "optin_disabled", { time: noticeTime(new Date()) });
      return done;
    });
    if (off) await audit(app, caller, { event_type: "external", details: { op: "optin_disabled", by: "self" } });
    return c.json({ disabled: off });
  });

  r.post("/api/v1/me/external/revoke-all", async (c) => {
    const { caller, personId } = await human(c, "Disconnect all external connections", "me_keys");
    const n = Number((await app.db.control.query<{ n: number }>("SELECT edge_revoke_person($1::uuid, 'self_all') AS n", [personId])).rows[0]?.n ?? 0);
    await audit(app, caller, { event_type: "external", details: { op: "revoke_all", revoked: n } });
    return c.json({ revoked: n });
  });

  r.get("/api/v1/me/external/notices", async (c) => {
    const { personId } = await human(c, "View External access notices", "me_keys_view");
    const unseen = c.req.query("unseen");
    if (unseen !== undefined && unseen !== "true" && unseen !== "false") throw invalid("unseen: true or false");
    const rows = (await app.db.control.query<{ id: string; kind: string; data: Record<string, string>; created_at: Date; seen_at: Date | null }>(
      `SELECT id, kind, data, created_at, seen_at FROM external_notices WHERE person_id = $1 AND instance_id = $2 ${unseen === "false" ? "" : "AND seen_at IS NULL"}
        ORDER BY created_at DESC, id DESC LIMIT 50`, [personId, app.instanceId])).rows;
    const items = rows.flatMap((n) => {
      if (!isNoticeKind(n.kind)) return [];
      const b = noticeText(n.kind, { program: n.data?.program, time: n.data?.time, network: n.data?.network }).banner;
      return b ? [{ id: n.id, kind: n.kind, title: b.title.slice(0, 200), text: b.text.slice(0, 2000), created_at: iso(n.created_at)!, seen_at: iso(n.seen_at) }] : [];
    });
    return c.json({ items });
  });

  r.post("/api/v1/me/external/notices/seen", async (c) => {
    const { personId } = await human(c, "Mark External access notices as seen", "me_keys");
    const b = jsonObjectBody(safeJson(await c.req.text()), "{ids}");
    rejectUnknownFields(b, ["ids"]);
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length
        || !ids.every((x) => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)))
      throw invalid("ids: 1 to 50 distinct notice identifiers");
    const r2 = await app.db.control.query("UPDATE external_notices SET seen_at = now() WHERE person_id = $1 AND instance_id = $2 AND id = ANY($3::uuid[]) AND seen_at IS NULL",
                                          [personId, app.instanceId, ids]);
    return c.json({ seen: r2.rowCount ?? 0 });
  });
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

export async function externalAdLinkChanged(q: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }, personId: string): Promise<boolean> {
  const off = (await q.query("SELECT external_access_disable($1::uuid, 'auto', 'ad_link_changed') AS ok", [personId])).rows[0]?.ok === true;
  if (off) await queueExternalNotice(q, personId, "optin_disabled", { time: noticeTime(new Date()) });
  await q.query("UPDATE external_access SET first_enabled_at = NULL, first_confirm = NULL, updated_at = now() WHERE person_id = $1 AND first_enabled_at IS NOT NULL", [personId]);
  await q.query("UPDATE external_access_confirmations SET expires_at = now() WHERE person_id = $1 AND used_at IS NULL AND confirmed_at IS NOT NULL AND expires_at > now()", [personId]);
  return off;
}

export async function externalAccessInstalled(q: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<boolean> {
  return (await q.query("SELECT to_regprocedure('external_access_disable(uuid,text,text)') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

export const networkOf = (ip: string | null | undefined): string | null => (ip ? noticeNetwork(ip) || null : null);
