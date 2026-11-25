// Health check tls_links: which gateway links go without TLS — a warning, not a refusal (the health status does not
// change), in both modes. In basic, TLS to the workspace and the panel ends at the shared proxy, and the directory
// may work without encryption: these are working decisions, but they are visible here. What is checked:
//   - the model gateway address (models.gateway_base_url) and the converter (integrations.converter_url) with http://; also the
//     address each model role uses (its own models.<role>_base_url, or the legacy gateway address for a role without a
//     provider; provider none — no address), and an address on this machine (loopback) is not a link;
//   - addresses of the two embeddings connections (models.embeddings_base_url, models.embeddings_b_base_url) with http://;
//   - mail on without TLS (smtp.security = none);
//   - the directory on without LDAPS (ldap.tls_mode ≠ ldaps — both StartTLS and no encryption);
//   - the gateway has no HTTPS of its own (access.https_port = 0 or no keys);
//   - the gateway HTTPS certificate expires in less than 30 days (or has expired).
// The text holds no addresses or key values, only setting names and the number of days.
import { CERT_WARN_DAYS, daysLeft, parseBaseUrl, readCredential, type Settings } from "@memory/shared";
import { HTTPS_CERT, httpsListening } from "./listen.ts";

export interface TlsLinksCheck { ok: true; level: "ok" | "warn"; detail: string; links: string[] }

const isHttp = (v: unknown): boolean => typeof v === "string" && /^http:\/\//i.test(v.trim());
const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** A model address over plain HTTP that leaves the machine: loopback (127.0.0.0/8, ::1, 0.0.0.0, localhost) is not a link. */
function httpOffHost(raw: string): boolean {
  if (!isHttp(raw)) return false;
  const p = parseBaseUrl(raw);
  if ("problem" in p) return true;
  return !(p.ipKind === "loopback" || p.host === "localhost" || p.host.endsWith(".localhost"));
}

/**
 * Model links without TLS, by the key that holds the address: each role's own base URL, or the legacy gateway address for
 * a role that has no provider (rule R2 of the connections, without the other checks: an address with a missing key is still
 * a link). The legacy line keeps its text; a role's own address is a line of its own. Every key is read by a literal call.
 * The embeddings role has two connections: connection 1 is the role above, with its label;
 * connection 2 (`models.embeddings_b_*`) has no legacy fallback (an empty slot is off, rule R7) — its own address only.
 */
function modelLinks(get: (path: string) => unknown): string[] {
  const roles: Array<{ label: string; key: string; base: unknown; provider: unknown }> = [
    { label: "chat model", key: "models.chat_base_url", base: get("models.chat_base_url"), provider: get("models.chat_provider") },
    { label: "embedding model", key: "models.embeddings_base_url", base: get("models.embeddings_base_url"), provider: get("models.embeddings_provider") },
    { label: "reranker", key: "models.rerank_base_url", base: get("models.rerank_base_url"), provider: get("models.rerank_provider") },
  ];
  const legacy = get("models.gateway_base_url");
  const out: string[] = [];
  for (const r of roles) {
    if (r.provider === "none") continue;
    if (filled(r.base)) { if (httpOffHost(r.base)) out.push(`${r.label} over HTTP (${r.key})`); continue; }
    if (!filled(r.provider) && filled(legacy) && httpOffHost(legacy)) out.push("model gateway over HTTP (models.gateway_base_url)");
  }
  const b = get("models.embeddings_b_base_url");
  if (get("models.embeddings_b_provider") !== "none" && filled(b) && httpOffHost(b)) out.push("embedding model over HTTP (models.embeddings_b_base_url)");
  return [...new Set(out)];
}

/** Links without TLS. https: whether the gateway HTTPS listens; cert: the PEM of the HTTPS certificate (null: none). */
export function tlsLinks(get: (path: string) => unknown, o: { https: boolean; cert: Buffer | null; now?: number }): string[] {
  const out: string[] = [];
  out.push(...modelLinks(get));
  if (isHttp(get("integrations.converter_url"))) out.push("document converter over HTTP (integrations.converter_url)");
  if (get("smtp.enabled") === true && get("smtp.security") === "none") out.push("e-mail without TLS (smtp.security = none)");
  if (get("ldap.enabled") === true) {
    const m = get("ldap.tls_mode");
    if (m !== "ldaps") out.push(m === "starttls" ? "directory using StartTLS instead of LDAPS (ldap.tls_mode)" : "unencrypted directory connection (ldap.tls_mode = none)");
  }
  if (!o.https) out.push("gateway has no HTTPS of its own (access.https_port, keys https.crt and https.key). In basic mode, TLS terminates at the shared proxy");
  if (o.cert) {
    try {
      const d = daysLeft(o.cert, o.now ?? Date.now());
      if (d < 0) out.push("gateway HTTPS certificate has expired");
      else if (d < CERT_WARN_DAYS) out.push(`gateway HTTPS certificate expires in ${d} days.`);
    } catch {
      out.push("gateway HTTPS certificate could not be read");
    }
  }
  return out;
}

/** The health line: always ok, level warn if there are links without TLS. */
export function tlsLinksCheck(settings: Pick<Settings, "get">, o: { read?: (name: string) => Buffer | null; now?: number } = {}): TlsLinksCheck {
  let cert: Buffer | null = null;
  try { cert = (o.read ?? readCredential)(HTTPS_CERT); } catch { cert = null; }
  const links = tlsLinks((p) => settings.get<unknown>(p, null), { https: httpsListening() !== null, cert, now: o.now });
  return links.length ? { ok: true, level: "warn", detail: `connections without TLS: ${links.join("; ")}`, links }
    : { ok: true, level: "ok", detail: "all gateway connections use TLS", links };
}
