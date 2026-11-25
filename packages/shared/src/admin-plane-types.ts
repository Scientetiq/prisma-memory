export type AdminRole = "memory_admin" | "security_auditor";
export const ADMIN_ROLES: readonly AdminRole[] = ["memory_admin", "security_auditor"];

export type AuthMethod = "sso" | "sso_webauthn" | "sso_breakglass" | "local" | "local_breakglass" | "tool";

export type RouteClass = "read" | "narrow" | "ordinary" | "second_signature" | "conditional" | "test_only" | "removed" | "auth";

export type PolicyClass = "operational" | "policy" | "anchored" | "immutable";

export type AlertLevel = "page" | "high" | "medium" | "metric";

export interface AnchoredWebauthnKey { ldap_id: string; credential_id: string; public_key_sha256: string }

export interface AnchorsState {
  inForce: boolean;
  serial?: number;
  sha256?: string;
  signers?: string[];
  admin?: { networks: string[]; ldap_ids: string[]; webauthn: AnchoredWebauthnKey[] };
  settingsPins?: Record<string, { value: unknown } | { hmac: string }>;
  settingsPolicySha256?: string;
  mfaModeMin?: "off" | "optional" | "required";
  securityModeMin?: "basic" | "advanced";
  retired?: boolean;
  reason?: string;
  problems?: string[];
}

export interface ApprovalSummary {
  id: string;
  state: "pending" | "approved" | "executed" | "rejected" | "expired" | "cancelled";
  action: string;
  summary: string;
  requested_by: string | null;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
}
