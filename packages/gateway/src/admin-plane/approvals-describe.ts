import type { RouteDef } from "./registry.ts";

const TITLES: Readonly<Record<string, string>> = {
  identity_links: "Change people’s account links",
  org_unit_managers: "Change department managers",
  wide_role: "Grant a role",
  admin_role_revoke: "Revoke an administrator or security auditor role",
  obo_allowed: "Register a service that can act on behalf of people",
  obo_enable: "Allow a service to act on behalf of people",
  obo_service_key: "Issue a key to a service acting on behalf of people",
  obo_key_net_or_open_write: "Expand a key’s network or open write access",
  owner_change: "Change the space owner",
  members_add_shared: "Add members to a shared space",
  closed_to_open: "Retry moving a record from closed to open",
  settings_weaken: "Weaken settings",
  "admin.test_sessions.post": "Issue a test session",
  "admin.people.login.custodian.put": "Assign a custodian for a former employee’s records",
  "admin.admin_users.login.person.put": "Link an administrator account to a person’s profile",
  "mfa.factor_reset": "Reset the second factor",
  "edge.unkill": "Lift the emergency shutdown of the external perimeter",
  "edge.revoke_all_external": "Revoke all external connections",
  "admin.edge_export.canary_holds.id.release.post": "Clear a decoy finding from an edge record",
  "admin.edge_export.canary_holds.release.post": "Clear decoy findings on the edge",
};

const NAME_FIELDS = ["login", "person_login", "role_code", "role", "slug", "space", "service", "kind", "org_unit"] as const;
const SERVICE_CONDITIONS: ReadonlySet<string> = new Set(["obo_allowed", "obo_enable", "obo_service_key"]);
const SIGNIFICANT_FIELDS = ["networks", "open_write", "scope", "scopes", "valid_to", "killed_at", "since", "identity_confirmed", "manager_confirmed"] as const;

export const APPROVAL_SUMMARY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]+/g;

function significant(v: unknown): string | null {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v === null) return "no";
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : null)).filter((x): x is string => x !== null)
      .map((x) => x.replace(APPROVAL_SUMMARY_CONTROLS, " ").trim().slice(0, 40));
    if (!items.length) return "empty";
    const s = items.join(", ");
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  const n = shortName(v);
  return n && n.length > 40 ? `${n.slice(0, 39)}…` : n;
}

function shortName(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(APPROVAL_SUMMARY_CONTROLS, " ").trim();
  return s ? (s.length > 60 ? `${s.slice(0, 59)}…` : s) : null;
}

function settingKeys(body: unknown): string[] {
  const b = body as { items?: unknown } | null;
  const items = Array.isArray(b?.items) ? b!.items as unknown[] : b ? [b] : [];
  return items.map((i) => {
    const x = i as { category?: unknown; key?: unknown };
    return typeof x?.category === "string" && typeof x?.key === "string" && /^[a-z_]+$/.test(x.category) && /^[a-z0-9_]+$/.test(x.key) ? `${x.category}.${x.key}` : null;
  }).filter((x): x is string => x !== null);
}

export function describeApproval(def: Pick<RouteDef, "id"> & Partial<Pick<RouteDef, "condition" | "action">>, body: unknown, o: { condition?: string; params?: Record<string, string> } = {}): string {
  const condition = o.condition ?? def.condition;
  const title = (condition && TITLES[condition]) ?? TITLES[def.id] ?? (def.action ? TITLES[def.action] : undefined) ?? `Action ${def.id}`;
  const parts: string[] = [];
  if (condition === "settings_weaken" || def.id === "admin.settings.put") {
    const keys = settingKeys(body);
    if (keys.length) parts.push(keys.length > 8 ? `${keys.slice(0, 8).join(", ")} and ${keys.length - 8} more` : keys.join(", "));
  } else {
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const names: readonly string[] = (condition && SERVICE_CONDITIONS.has(condition)) || def.id.startsWith("admin.services") ? [...NAME_FIELDS, "name"] : NAME_FIELDS;
    for (const f of names) {
      const v = shortName(b[f]);
      if (v) parts.push(`${f}: ${v}`);
    }
    for (const f of SIGNIFICANT_FIELDS) {
      if (!Object.hasOwn(b, f)) continue;
      const v = significant(b[f]);
      if (v) parts.push(`${f}: ${v}`);
    }
    for (const [k, v] of Object.entries(o.params ?? {})) {
      const s = shortName(v);
      if (s && !parts.some((p) => p.startsWith(`${k}:`))) parts.push(`${k}: ${s}`);
    }
  }
  const out = parts.length ? `${title} — ${parts.slice(0, 6).join("; ")}` : title;
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}
