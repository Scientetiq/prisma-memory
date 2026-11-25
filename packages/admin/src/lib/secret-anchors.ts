import { ANCHOR_MESSAGES } from "../messages/secret-anchors";

export interface SecretAnchor { secret: string; anchors: string[]; message: string }

// Stable anchor data may be captured by a form at module load; only the message follows the request locale.
export const SECRET_ANCHORS: Record<"ldap" | "oidc" | "smtp", SecretAnchor> = {
  oidc: { secret: "client_secret", anchors: ["issuer", "client_id", "ca_cert"], get message() { return ANCHOR_MESSAGES.oidc; } },
  ldap: { secret: "bind_password", anchors: ["servers", "port", "tls_mode", "insecure_ack", "ca_cert", "tls_server_name", "bind_dn"], get message() { return ANCHOR_MESSAGES.ldap; } },
  smtp: { secret: "password", anchors: ["host", "port", "security", "insecure_ack", "ca_cert", "username"], get message() { return ANCHOR_MESSAGES.smtp; } },
};

export function anchorText(key: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean).sort().join("\n");
  if (v === null || v === undefined || v === false || v === 0) return "";
  if (typeof v !== "string") return String(v);
  const s = v.replace(/\r\n?/g, "\n").trim();
  if (key === "issuer") return s.replace(/\/+$/, "");
  return key === "host" || key === "tls_server_name" ? s.toLowerCase() : s;
}

export function secretAnchorProblem(anchor: SecretAnchor, saved: (key: string) => unknown, typed: (key: string) => unknown, secretKept: boolean, secretTyped: string | null): string | null {
  if (!secretKept || (secretTyped ?? "").trim()) return null;
  return anchor.anchors.some((k) => { const t = typed(k); return t !== undefined && anchorText(k, t) !== anchorText(k, saved(k)); }) ? anchor.message : null;
}
