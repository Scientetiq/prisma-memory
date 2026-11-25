import "server-only";
import { call } from "@/lib/gateway";
import { adminPlaneSeparate } from "@/lib/gateway-transport";

export interface AdminMethods { sso: boolean; local: "open" | "breakglass" | "off"; breakglass_open: boolean }
export const LEGACY_METHODS: AdminMethods = { sso: false, local: "open", breakglass_open: false };

export async function adminMethods(): Promise<AdminMethods> {
  if (!adminPlaneSeparate()) return LEGACY_METHODS;
  try {
    const r = await call("/api/v1/admin-auth/methods", { timeoutMs: 10_000 });
    const d = (r?.data ?? null) as Partial<AdminMethods> | null;
    if (!r || r.status !== 200 || !d || typeof d.sso !== "boolean") return LEGACY_METHODS;
    const local = d.local === "breakglass" || d.local === "off" ? d.local : "open";
    return { sso: d.sso, local, breakglass_open: d.breakglass_open === true };
  } catch {
    return LEGACY_METHODS;
  }
}

export const localFormVisible = (m: AdminMethods): boolean => m.local === "open" || (m.local === "breakglass" && m.breakglass_open);
