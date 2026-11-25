import { unstable_rethrow } from "next/navigation";
import { call } from "@/lib/gateway";

export interface AuthMethods { ldap: { enabled: boolean; domains: string[] }; oidc: { enabled: boolean }; local?: { enabled: boolean }; support_contact: string | null }

export async function authMethods(): Promise<AuthMethods | null> {
  try {
    const { status, data } = await call("/api/v1/auth/methods", { timeoutMs: 10_000 });
    const m = data as (Omit<AuthMethods, "local" | "support_contact"> & { local?: { enabled?: unknown }; support_contact?: unknown }) | null;
    if (status !== 200 || !m?.ldap) return null;
    const contact = typeof m.support_contact === "string" && m.support_contact.trim() ? m.support_contact.trim().slice(0, 300) : null;
    return { ldap: { enabled: m.ldap.enabled === true, domains: Array.isArray(m.ldap.domains) ? m.ldap.domains.map(String) : [] }, oidc: { enabled: m.oidc?.enabled === true }, local: { enabled: m.local?.enabled === true }, support_contact: contact };
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}
