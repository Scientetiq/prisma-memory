import { isIP } from "node:net";
import { isHostName, parseCidr } from "./channel-settings.ts";

export const ADMIN_NETWORK_WIDEST = { ipv4: 16, ipv6: 48 } as const;

const EMAIL = /^[^\s@<>()",;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NODE_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const isNodeName = (x: unknown): boolean => typeof x === "string" && NODE_NAME.test(x) && !/^[\d.]+$/.test(x);

function networkProblems(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const net = parseCidr(raw);
    if (!net) { out.push(`“${String(raw).slice(0, 64)}” is not a CIDR network (example: 10.20.30.0/24)`); continue; }
    const widest = net.family === "ipv4" ? ADMIN_NETWORK_WIDEST.ipv4 : ADMIN_NETWORK_WIDEST.ipv6;
    if (net.bits < widest) out.push(`“${String(raw)}” is wider than /${widest}. Enter the administrators’ subnet`);
  }
  return out;
}

export function panelUrlProblem(raw: unknown, withPath: boolean): string | null {
  if (typeof raw !== "string") return "line";
  let u: URL;
  try { u = new URL(raw); } catch { return `“${raw.slice(0, 80)}” is not a URL`; }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return `“${raw.slice(0, 80)}”: use https:// only (http is for localhost on a test installation)`;
  if (u.username || u.password) return `“${raw.slice(0, 80)}”: omit the username and password from the URL`;
  if (u.search || u.hash || raw.includes("#") || raw.includes("?")) return `“${raw.slice(0, 80)}”: omit the query and fragment`;
  if (!withPath && (u.pathname !== "/" || raw.endsWith("/"))) return `“${raw.slice(0, 80)}”: use an origin without a path or trailing “/” (https://host[:port])`;
  if (!withPath && raw !== u.origin) return `“${raw.slice(0, 80)}”: use the canonical origin — ${u.origin}`;
  return null;
}

export function auditShipTargetProblems(value: unknown): string[] {
  if (value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["object: {} or {\"file_dir\": …} or {\"host\", \"port\", \"ca_cert\", \"tls_server_name\"}"];
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (!keys.length) return [];
  if ("file_dir" in v) {
    if (keys.length !== 1) return ["the file target accepts only file_dir"];
    return typeof v.file_dir === "string" && v.file_dir.startsWith("/") && v.file_dir.length <= 1024 && !v.file_dir.split("/").includes("..")
      ? [] : ["file_dir must be an absolute directory path without “..” (up to 1024 characters)"];
  }
  const out: string[] = [];
  const extra = keys.filter((k) => !["host", "port", "ca_cert", "tls_server_name"].includes(k));
  if (extra.length) out.push(`unexpected fields: ${extra.join(", ")}`);
  if (!(isNodeName(v.host) || (typeof v.host === "string" && isIP(v.host) !== 0))) out.push("host: receiver hostname or address");
  if (!(typeof v.port === "number" && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535)) out.push("port: an integer from 1 to 65535");
  if (!(typeof v.ca_cert === "string" && v.ca_cert.includes("BEGIN CERTIFICATE") && v.ca_cert.length <= 65_536))
    out.push("ca_cert — the receiver’s CA certificate in PEM (up to 64 KB). This is required because the default CA list is not used");
  if (v.tls_server_name !== undefined && !isNodeName(v.tls_server_name)) out.push("tls_server_name — the name on the receiver’s certificate");
  return out;
}

export const ADMIN_NOT_READY: Readonly<Record<string, { allowed: readonly unknown[]; message: string }>> = {
  "admin.local_login": { allowed: ["open"],
    message: "You cannot disable admin@local sign-in yet. Readiness is not checked when saving settings, so the admin panel would lose sign-in access" },
  "admin.second_signature": { allowed: ["off"],
    message: "You cannot enable the second signature yet. It is not connected to conditional actions or saving settings" },
};

let guardWired = false;
export function setAdminSettingsGuardWired(v: boolean): void { guardWired = v; }
export const adminSettingsGuardWired = (): boolean => guardWired;

export const ADMIN_OIDC_CALLBACK_PATH = "/admin/login/callback";

export function fullDnProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "line";
  const v = raw.trim();
  if (!v) return null;
  const parts = v.split(/(?<!\\),/).map((x) => x.trim());
  if (parts.length < 2 || parts.some((x) => !/^[A-Za-z][A-Za-z0-9-]*=.+$/.test(x)))
    return `“${v.slice(0, 80)}”: enter the full group DN (CN=…,OU=…,DC=…) instead of just the name`;
  return null;
}

export function adminGroupProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "line";
  const v = raw.trim();
  if (!v) return null;
  if (v.includes("=")) return fullDnProblem(v);
  if (/,/.test(v) || v.length > 256) return `“${v.slice(0, 80)}”: enter a group name without commas (up to 256 characters) or a full DN (CN=…,OU=…,DC=…)`;
  return null;
}

export function adminSettingProblems(path: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const notReady = guardWired ? undefined : ADMIN_NOT_READY[path];
  if (notReady && !notReady.allowed.includes(value)) return [notReady.message];
  switch (path) {
    case "admin.networks":
    case "admin.bastion_cidrs":
      return networkProblems(value);
    case "admin.alert_recipients":
      return Array.isArray(value) ? value.filter((x) => typeof x !== "string" || !EMAIL.test(x)).map((x) => `“${String(x).slice(0, 80)}” is not an e-mail address`) : [];
    case "admin.webauthn_origins":
      return Array.isArray(value) ? value.map((x) => panelUrlProblem(x, false)).filter((x): x is string => x !== null) : [];
    case "admin.oidc_redirect_uri": {
      if (value === "") return [];
      const p = panelUrlProblem(value, true);
      if (p) return [p];
      return new URL(String(value)).pathname === ADMIN_OIDC_CALLBACK_PATH ? [] : [`callback URL path: ${ADMIN_OIDC_CALLBACK_PATH} (https://panel${ADMIN_OIDC_CALLBACK_PATH})`];
    }
    case "admin.ad_admin_group": {
      const p = adminGroupProblem(value);
      return p ? [p] : [];
    }
    case "admin.webauthn_rp_id":
      return value === "" || value === "localhost" || isHostName(value) ? [] : ["admin panel hostname without a scheme or port (for example, admin.example.test, or localhost on a test installation)"];
    case "observability.audit_ship_target":
      return auditShipTargetProblems(value);
    default:
      return [];
  }
}

export const ADMIN_STRICT_FLAGS: ReadonlyArray<{ path: string; strict: (v: unknown) => boolean }> = [
  { path: "admin.webauthn_required", strict: (v) => v === true },
  { path: "admin.system_key_admin", strict: (v) => v === false },
  { path: "admin.local_login", strict: (v) => v === "breakglass" || v === "off" },
  { path: "admin.second_signature", strict: (v) => v === "on" },
  { path: "admin.auditor_key_access", strict: (v) => v === false },
  { path: "admin.service_keys_by_fingerprint", strict: (v) => v === true },
];

export function adminStrictMode(get: (path: string) => unknown): boolean {
  return ADMIN_STRICT_FLAGS.every((f) => f.strict(get(f.path)));
}
