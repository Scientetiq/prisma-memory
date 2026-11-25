import { currentListener, processTopology } from "./listeners.ts";

export const LEGACY_PANEL_TOKEN_ON_ADMIN_LISTENER: boolean = false;

let override: boolean | null = null;
export function setLegacyPanelTokenForTests(v: boolean | null): void { override = v; }
const legacyOpen = (): boolean => override ?? LEGACY_PANEL_TOKEN_ON_ADMIN_LISTENER;

const adminSeparate = (): boolean => { try { return processTopology().adminSeparate; } catch { return false; } };

export function adminLoginTokenKind(): "mem_as_" | "mem_adm_" {
  return adminSeparate() && !legacyOpen() ? "mem_as_" : "mem_adm_";
}

export interface LegacyReject { reason: "admin_token_on_main" | "session_expired" | "local_login_closed"; details: Record<string, unknown> }

export function legacyPanelTokenProblem(localLogin: unknown): LegacyReject | null {
  const l = currentListener();
  const onAdmin = l?.kind === "admin";
  if (adminSeparate() && !onAdmin) return { reason: "admin_token_on_main", details: { listener: l?.kind ?? "main" } };
  if (onAdmin && !legacyOpen()) return { reason: "session_expired", details: { why: "legacy_session" } };
  if (localLogin !== "open") return { reason: "local_login_closed", details: {} };
  return null;
}
