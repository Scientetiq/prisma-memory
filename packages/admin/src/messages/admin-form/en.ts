import type { AdminField, AdminFieldKind, AdminFormGroup } from "../../lib/admin-form";
const A = (key: string, kind: AdminFieldKind, hint?: string, placeholder?: string): AdminField => ({ category: "admin", key, kind, hint, placeholder });

export const ADMIN_FORM_TEXT = {
    approvalPendingText: "This change needs a second signature from another administrator or security auditor",
};

export const ADMIN_FORM_GROUPS: readonly AdminFormGroup[] = [
    { title: "Sign-in", hint: "Administrator sign-in through the identity provider (OpenID Connect) and where the panel can be opened. Values are pinned by anchors.", fields: [
            A("sso_login_enabled", "bool", "Enable after configuring the client and checking Readiness. Until then, administrators sign in as before."),
            A("oidc_client_id", "text", "In basic mode, you can use the memory workspace client: IT adds one exact panel return URL. Advanced mode needs a separate memory-admin client."),
            A("oidc_client_secret", "secret", "The same client’s secret (in basic mode, the workspace secret). Stored encrypted; the audit log records only its fingerprint."),
            A("oidc_redirect_uri", "text", "The exact https://panel.example.com/admin/login/callback URL, matching the client at the identity provider. In basic mode, no port or “*”. HTTP is allowed only for localhost testing.", "https://admin.example.test/admin/login/callback"),
            A("ad_admin_group", "text", "Optional: a group DN or name. Only its members with the administrator role can sign in."),
            A("oidc_username_form", "enum", "How the identity provider sends the username: short name, full UPN including the domain, or either. A name without a domain is not matched against a UPN."),
            A("networks", "lines", "One CIDR network per line, no wider than /16 (IPv4) or /48 (IPv6). Empty disables network checks.", "198.51.100.0/24"),
        ] },
    { title: "WebAuthn keys", hint: "Administrators’ hardware keys: touch to sign in or sign sensitive actions.", fields: [
            A("webauthn_rp_id", "text", "Panel host name without scheme or port; localhost for testing.", "admin.example.test"),
            A("webauthn_origins", "lines", "Exact panel origins, https://host[:port], one per line. For testing: http://localhost:18083."),
            A("webauthn_uv", "enum", "“Required” asks for a PIN or fingerprint every time the key is touched."),
            A("webauthn_required", "bool", "Enable after every administrator has keys (Readiness)."),
            A("webauthn_min_keys", "number", "1–5: required keys per administrator, so losing one does not prevent sign-in."),
            A("stepup_max_min", "number", "1–15 minutes: a sensitive action asks you to touch the key if the last touch is older than this."),
            A("webauthn_aaguids", "lines", "Advanced mode: device-bound key models (AAGUID), one per line. If empty, a person confirms device binding in Readiness.", "00000000-0000-0000-0000-000000000000"),
        ] },
    { title: "Sessions", hint: "An administrator session is bound to the browser’s address; lifetime and idle timeout are not extended.", fields: [
            A("session_max_min", "number", "15–480 minutes from sign-in; at most 60 in advanced mode."),
            A("session_idle_min", "number", "Sign out after 5–120 minutes of inactivity; at most 15 in advanced mode."),
            A("tool_sessions", "bool", "Short sessions for scripts on the VM itself, directly through the admin listener socket only."),
            A("tool_session_max_min", "number", "5–60 minutes, no longer than the session that issued it."),
        ] },
    { title: "Security mode", hint: "Basic runs actions immediately and raises alerts for weaker security. Advanced requires second signatures and keys. Change modes using “Enable advanced” in Readiness; returning to basic requires a request signed by two people.", fields: [
            { category: "security", key: "mode", kind: "enum", hint: "Read-only: the mode cannot be changed in settings." },
            { category: "security", key: "downgrade_delay_hours", kind: "number", hint: "24–168 hours between signature and execution of a return to basic mode." },
        ] },
    { title: "Second signature", hint: "In advanced mode, sensitive actions await another administrator’s or security auditor’s signature. In basic mode, actions run immediately.", fields: [
            A("second_signature", "enum", "Set by security mode: none in basic, always required in advanced."),
            A("second_signature_ttl_hours", "number", "1–72 hours: an unsigned request expires after this time."),
        ] },
    { title: "Legacy and emergency access", hint: "Legacy sign-in methods and emergency access. Enabling advanced mode applies strict values here.", fields: [
            A("system_key_admin", "bool", "When off, the system key no longer opens the admin API. Use a session or the VM CLI for maintenance."),
            A("local_login", "enum", "You can close admin@local sign-in once sign-in through the identity provider and emergency access work."),
            A("local_totp_required", "bool", "Can be turned on once every local administrator has set up an authenticator app (Readiness: local_admin_factor)."),
            A("auditor_key_access", "bool", "Security auditors read the audit log, report and Search quality with a personal agent key."),
            A("service_keys_by_fingerprint", "bool", "The panel does not issue secrets to services: service keys use only the public key fingerprint."),
            A("breakglass_max_hours", "number", "1–2 hours: the emergency access window closes automatically."),
            A("bastion_cidrs", "lines", "One CIDR network per line: emergency access is available only from a bastion."),
        ] },
    { title: "Alerts", hint: "Email alerts about sign-ins, keys, anchors and emergency access.", fields: [
            A("alert_recipients", "lines", "Email addresses, one per line.", "ops@example.test"),
            A("alert_digest_hour", "number", "0–23: medium-severity alerts arrive in one daily digest at this hour."),
        ] },
    { title: "Administrator visibility", fields: [
            A("audit_show_personal_titles", "bool", "Show titles of people’s personal records in the audit log."),
            A("search_quality_query_texts", "bool", "Show frequent queries with no results on the Search quality page."),
        ] },
    { title: "Reading on behalf of people", hint: "Services permitted to read on behalf of a person.", fields: [
            { category: "access", key: "obo_read_consent", kind: "enum", hint: "“Consent required” asks the person to give consent in the workspace for the period below." },
            { category: "access", key: "obo_read_consent_days", kind: "number", hint: "1–365 days." },
            { category: "access", key: "obo_read_alert_people_day", kind: "number", hint: "Alert when a service reads on behalf of more than this many people in one day." },
        ] },
    { title: "External audit log delivery", hint: "Copy the audit log to external storage (SIEM).", fields: [
            { category: "observability", key: "audit_ship_mode", kind: "enum" },
            { category: "observability", key: "audit_ship_target", kind: "json", hint: "{\"file_dir\": \"/path\"} for files (testing); {\"host\", \"port\", \"ca_cert\", \"tls_server_name\"} for syslog over TLS." },
            { category: "observability", key: "audit_ship_batch", kind: "number", hint: "50–5000 events per batch." },
            { category: "observability", key: "audit_ship_interval_sec", kind: "number", hint: "5–300 seconds." },
            { category: "observability", key: "audit_ship_lag_sec", kind: "number", hint: "30–900 seconds: alert if delivery falls further behind." },
        ] },
];

export const TEXT = {
  openRequest: "Open request",
  signBy: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Sign by ${value1} (${value2})`,
  request: (value1: string | number | null | undefined): string => `Request: ${value1}`,
};
