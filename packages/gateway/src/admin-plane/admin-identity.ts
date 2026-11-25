import {
  adminGroupProblem, canonicalObjectGuid, currentAnchors, directoryAccountByGuid, directoryNestedMember, guidAccountMatches, ldapConfig, LdapFailure, log,
  matchGroups, type AdminRole, type DirectoryAccount, type KeycloakUsernameForm, type Settings,
} from "@memory/shared";
import type { App } from "../context.ts";
import { inNetworks } from "../channel.ts";
import { breakglassState } from "./breakglass.ts";
import { adminDb } from "./db.ts";
import { usableCredentials } from "./webauthn-routes.ts";

export interface AdminClaims { sub: string; preferred_username?: string; ldap_id?: string; groups?: string[] }

export const ADMIN_LOGIN_TEXT = {
  admin_login_denied: "This account is not allowed to sign in as an administrator",
  admin_network_denied: "The administrator panel opens only from the administrators' network",
  admin_identity_unconfirmed: "Sign in to the memory workspace first",
  admin_directory_unavailable: "The company directory does not answer — administrator sign-in is not possible for now",
  admin_webauthn_missing: "No security key is registered; recovery goes through the emergency access",
  webauthn_failed: "The security key did not confirm the sign-in. Try again",
} as const;
export type AdminLoginCode = keyof typeof ADMIN_LOGIN_TEXT;

export type AdminRefusal = "admin_network" | "admin_guid_unknown" | "admin_guid_mismatch" | "admin_account_disabled" | "admin_directory_unavailable"
  | "admin_group" | "admin_identity_unconfirmed" | "admin_role_missing" | "admin_not_in_anchors" | "admin_webauthn_missing";

export interface AdminDenied {
  ok: false;
  reason: AdminRefusal;
  status: 403 | 503;
  code: AdminLoginCode;
  message: string;
  login: string | null;
  extra?: Record<string, unknown>;
}

export type ResolvedAdmin =
  | { ok: true; personId: string; login: string; guid: string; role: AdminRole; webauthn: "required" | "not_required"; breakglassWindowId: string | null; keys: number }
  | AdminDenied;

const deny = (reason: AdminRefusal, code: AdminLoginCode, login: string | null, extra?: Record<string, unknown>): AdminDenied =>
  ({ ok: false, reason, status: code === "admin_directory_unavailable" ? 503 : 403, code, message: ADMIN_LOGIN_TEXT[code], login, ...(extra ? { extra } : {}) });

export const loginLabel = (raw: unknown): string | null => {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100) : "";
  return s || null;
};

type DirectoryLookup = (app: App, guid: string) => Promise<DirectoryAccount | null>;
type NestedLookup = (app: App, dn: string, groupDn: string) => Promise<boolean>;
const realDirectory: DirectoryLookup = (app, guid) => directoryAccountByGuid(ldapConfig(app.settings), guid);
const realNested: NestedLookup = (app, dn, groupDn) => directoryNestedMember(ldapConfig(app.settings), dn, groupDn);
let directory: DirectoryLookup = realDirectory;
let nested: NestedLookup = realNested;
export function setAdminDirectoryForTests(f: DirectoryLookup | null, n?: NestedLookup | null): void {
  directory = f ?? realDirectory;
  nested = n ?? realNested;
}

export function adminNetworks(app: App): string[] {
  const a = currentAnchors();
  if (a.inForce) return [...(a.admin?.networks ?? [])];
  const v = app.settings.get<unknown>("admin.networks", []);
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

export function adminNetworkAllowed(app: App, ip: string | null): boolean {
  const nets = adminNetworks(app);
  if (!nets.length) return !currentAnchors().inForce;
  return inNetworks(ip, nets);
}

export function adminGroupSetting(app: { settings: Pick<Settings, "get"> }, o: { requireDn?: boolean } = {}): { group: string; problem: string | null } {
  const group = String(app.settings.get<unknown>("admin.ad_admin_group", "") ?? "").trim();
  const problem = adminGroupProblem(group);
  if (problem) return { group, problem: `admin.ad_admin_group: ${problem}` };
  return { group, problem: group && o.requireDn && !group.includes("=") ? "admin.ad_admin_group requires the full group DN (CN=…,OU=…,DC=…), not just its name" : null };
}

export function adminUsernameForm(app: { settings: Pick<Settings, "get"> }): KeycloakUsernameForm {
  const v = app.settings.get<unknown>("admin.oidc_username_form", "any");
  return v === "account" || v === "upn" ? v : "any";
}

async function cardOf(app: App, guid: string): Promise<{ kind: "none" } | { kind: "ok"; personId: string; login: string; usable: boolean }> {
  const r = await adminDb(app).query(
    `SELECT i.person_id, i.verified, p.login, p.active, COALESCE(p.attrs->>'demo', '') = 'true' AS demo
       FROM person_identities i JOIN people p ON p.id = i.person_id
      WHERE i.system = 'ad' AND lower(btrim(i.external_id, '{}')) = $1 AND i.active AND p.instance_id = $2`, [guid, app.instanceId]);
  const rows = r.rows as Array<{ person_id: string; verified: boolean; login: string; active: boolean; demo: boolean }>;
  if (new Set(rows.map((x) => x.person_id)).size !== 1 || !rows.every((x) => x.verified)) return { kind: "none" };
  const x = rows[0]!;
  return { kind: "ok", personId: x.person_id, login: x.login, usable: x.active && !x.demo };
}

async function rolesOf(app: App, personId: string): Promise<AdminRole[]> {
  const r = await adminDb(app).query(
    `SELECT DISTINCT role_code FROM role_grants
      WHERE person_id = $1 AND instance_id = $2 AND role_code IN ('memory_admin', 'security_auditor')
        AND revoked_at IS NULL AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [personId, app.instanceId]);
  return (r.rows as Array<{ role_code: AdminRole }>).map((x) => x.role_code);
}

async function activeKeyCount(app: App, personId: string): Promise<number> {
  const r = await adminDb(app).query(
    "SELECT count(*)::int AS n FROM admin_webauthn_credentials WHERE person_id = $1 AND instance_id = $2 AND disabled_at IS NULL", [personId, app.instanceId]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function resolveAdmin(app: App, claims: AdminClaims, ip: string | null): Promise<ResolvedAdmin> {
  const login = loginLabel(claims.preferred_username);
  if (!adminNetworkAllowed(app, ip)) return deny("admin_network", "admin_network_denied", login, { ip });

  const guid = canonicalObjectGuid(claims.ldap_id);
  if (!guid) return deny("admin_guid_unknown", "admin_login_denied", login);
  let account: DirectoryAccount | null;
  try {
    account = await directory(app, guid);
  } catch (e) {
    const code = e instanceof LdapFailure ? e.code : "ldap_error";
    log.warn("admin_login_directory_failed", { login, code, detail: e instanceof LdapFailure ? String(e.detail ?? "").slice(0, 300) : String((e as Error)?.message ?? e).slice(0, 300) });
    return deny("admin_directory_unavailable", "admin_directory_unavailable", login, { error_code: code });
  }
  if (!account) return deny("admin_guid_unknown", "admin_login_denied", login);
  if (!account.enabled) return deny("admin_account_disabled", "admin_login_denied", login);
  if (!guidAccountMatches(account, claims.preferred_username, adminUsernameForm(app))) return deny("admin_guid_mismatch", "admin_login_denied", login);

  const { group, problem } = adminGroupSetting(app);
  if (problem) {
    log.warn("admin_group_not_dn", { login });
    return deny("admin_group", "admin_login_denied", login);
  }
  if (group && !matchGroups(account.memberOf, [group]).length) {
    let member = false;
    if (group.includes("=") && app.settings.get<unknown>("ldap.nested_groups", false) === true) {
      try {
        member = await nested(app, account.dn, group);
      } catch (e) {
        const code = e instanceof LdapFailure ? e.code : "ldap_error";
        log.warn("admin_login_directory_failed", { login, code, stage: "nested_group" });
        return deny("admin_directory_unavailable", "admin_directory_unavailable", login, { error_code: code });
      }
    }
    if (!member) return deny("admin_group", "admin_login_denied", login);
  }

  const card = await cardOf(app, guid);
  if (card.kind === "none") return deny("admin_identity_unconfirmed", "admin_identity_unconfirmed", login);
  if (!card.usable) return deny("admin_role_missing", "admin_login_denied", login);

  const roles = await rolesOf(app, card.personId);
  if (!roles.length) return deny("admin_role_missing", "admin_login_denied", login);
  const role: AdminRole = roles.includes("memory_admin") ? "memory_admin" : "security_auditor";

  const anchors = currentAnchors();
  if (anchors.inForce && !(anchors.admin?.ldap_ids ?? []).some((x) => canonicalObjectGuid(String(x).trim().replace(/^\{|\}$/g, "")) === guid))
    return deny("admin_not_in_anchors", "admin_login_denied", login);

  const bg = await breakglassState(app);
  if (bg.open && bg.window)
    return { ok: true, personId: card.personId, login: card.login, guid, role, webauthn: "not_required", breakglassWindowId: bg.window, keys: 0 };
  const any = await activeKeyCount(app, card.personId);
  const required = app.settings.get<unknown>("admin.webauthn_required", false) === true || any > 0;
  if (!required) return { ok: true, personId: card.personId, login: card.login, guid, role, webauthn: "not_required", breakglassWindowId: null, keys: 0 };

  const usable = (await usableCredentials(app, card.personId, guid)).length;
  if (!usable) return deny("admin_webauthn_missing", "admin_webauthn_missing", login);
  return { ok: true, personId: card.personId, login: card.login, guid, role, webauthn: "required", breakglassWindowId: null, keys: usable };
}
