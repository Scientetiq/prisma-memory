import type { EdgeGroup } from "../../lib/edge-form";
type Stage = "P0" | "1a" | "1b" | "1c" | "1d" | "1e" | "1f" | "S2-3" | "4" | "E2" | "5";

export const GROUPS_BY_STAGE: Readonly<Record<Stage, readonly EdgeGroup[]>> = {

  P0: [],

  "1a": [],

  "1b": [
    { title: "Edge export", hint: "The edge is a read-only external copy of open records. Enable it through an administrator’s personal session (with a second signature in advanced mode), only with a working exporter and passed network gates.", fields: [
      { key: "export_enabled", kind: "bool", label: "Send open records to the edge", category: "edge" },
      { key: "bridge_url", kind: "text", label: "Edge bridge URL", placeholder: "https://bridge.example.test",
        hint: "The bridge receives the copy and revocations; its address is pinned in the internal network anchors. In basic mode use https://memory-relay:8445 (a service on this VM, set by deployment); in advanced mode use the bridge VM’s address.", category: "edge" },
      { key: "originals_max_mib", kind: "number", label: "Largest original file on the edge, MiB", hint: "1–20: larger files are available internally only.", category: "edge" },
    ] },
    { title: "Freshness and revocation", hint: "The edge stops serving data if contact with memory is lost for too long; record revocations should arrive within seconds.", fields: [
      { key: "deadman_theta_sec", kind: "number", label: "Seconds without contact before the edge stops serving data", hint: "60–600, within the anchor limits.", category: "edge" },
      { key: "revoke_lag_warn_sec", kind: "number", label: "Warn if revocation takes longer than, s", hint: "5–300.", category: "edge" },
      { key: "revoke_lag_alarm_sec", kind: "number", label: "Alarm if revocation takes longer than, s", hint: "30–900.", category: "edge" },
    ] },
    { title: "Reconciliation and permissions", fields: [
      { key: "reconcile_light_min", kind: "number", label: "Edge reconciliation interval, minutes", hint: "5–60.", category: "edge" },
      { key: "reconcile_full_hour", kind: "number", label: "Hour of nightly full reconciliation", hint: "0–23, in server time.", category: "edge" },
      { key: "projection_refresh_sec", kind: "number", label: "Full edge permission refresh interval, s", hint: "60–3600; permission reductions are sent immediately.", category: "edge" },
    ] },
    { title: "Agent connections", fields: [
      { key: "max_concurrent_per_connection", kind: "number", label: "Concurrent requests per connection", hint: "1–8.", category: "edge" },
      { key: "connection_expiry_warn_days", kind: "number", label: "Days before connection expiry to warn", hint: "1–14.", category: "edge" },
    ] },
  ],

  "1c": [
    { title: "Directory channel for external sign-in", hint: "The authentication service sends external sign-in passwords to the directory over the channel configured in “Sign-in and LDAP”. Basic mode allows unencrypted traffic (with risk acknowledgement) or StartTLS, with a gate warning. Advanced mode requires LDAPS.", fields: [
      { category: "edge", key: "ldap_require_ldaps", kind: "bool", label: "Verify external sign-in passwords only over LDAPS", hint: "Reject StartTLS and unencrypted sign-in. Off by default in basic mode; mandatory in advanced mode, where turning it off requires a second signature. While external sign-in is open, changes require an administrator’s personal session." },
    ] },
  ],

  "1d": [
    { title: "Daily quotas", hint: "What one person can do externally each day, across all connections and programs. Initially observe only: over-quota calls are logged but allowed. The quota report in Alerts and the morning summary show who would have been refused. In basic mode an administrator or agent can enable enforcement; beyond a pilot, external sign-in requires enforcement. Returning to observation or changing quotas requires a second signature in advanced mode; in basic mode it is immediate and raises a high alert.", fields: [
      { category: "edge", key: "quota_mode", kind: "text", label: "Quota mode", hint: "observe — log only; enforce — reject over-quota calls with a message explaining when the quota resets and whom to contact." },
      { category: "edge", key: "quota_daily", kind: "json", label: "Daily quotas per person",
        hint: "search, read, list — calls; text_tokens — text delivered; originals and originals_mib — files and MiB; c2_items and c2_mib — write requests and MiB; tz — daily time zone." },
    ] },
    { title: "Connection alerts", hint: "An alert, not a block: the connection continues and the administrator receives an email.", fields: [
      { category: "edge", key: "max_new_connections_alert_day", kind: "number", label: "Alert if new connections per person per day exceed", hint: "1–100." },
      { category: "edge", key: "geo_alert_enabled", kind: "bool", label: "Alert on a new country or provider network" },
      { category: "edge", key: "geoip_db_path", kind: "text", label: "Country and network database file", placeholder: "/var/lib/memory/geoip/country-asn.mmdb", hint: "Full server path. Empty alerts on a change of /16 network." },
    ] },
    { title: "Alert emails", fields: [
      { category: "admin", key: "alert_work_hours", kind: "json", label: "Working hours for daytime-only alerts", hint: "weekdays — “09:00-19:00” on weekdays; tz — time zone." },
      { category: "admin", key: "alert_cooldown_min", kind: "number", label: "Delay between repeats of the same alert, minutes", hint: "5–1440." },
    ] },
    { title: "Probe and synthetic sign-in", hint: "External checks that the edge responds and sign-in works. Enable only while the probe runs as a system service or container.", fields: [
      { category: "edge", key: "probe_base_url", kind: "text", label: "External probe URL", placeholder: "https://memory-edge.example.test", hint: "HTTPS only, using the edge host in the anchors: the synthetic sign-in password and code are sent there. Changes require a second signature in advanced mode; in basic mode they are immediate and raise a high alert. Empty disables probe requests." },
      { category: "edge", key: "probe_connect_addr", kind: "text", label: "Shared proxy’s external listener", placeholder: "203.0.113.10:443",
        hint: "Address and port of the shared proxy’s external listener (IT worksheet row B13). The edge hostname is sent in SNI and Host and used to verify the certificate. Use neither an internal address nor a trusted proxy address. Empty means the proxy has no external address and disables the probe." },
      { category: "edge", key: "probe_inner_hosts", kind: "lines", label: "Internal hostnames to check at the external address", placeholder: "memory.example.test",
        hint: "One per line, up to 20: memory, panel, employee sign-in and other services. Each must receive a proxy 404 or TLS rejection at the external address. The probe adds a random hostname in the edge domain itself." },
      { category: "edge", key: "probe_interval_min", kind: "number", label: "Probe interval, minutes", hint: "1–60." },
      { category: "edge", key: "synthetic_login_account", kind: "text", label: "Synthetic sign-in account", placeholder: "probe-login@example.test", hint: "Service account email or login; its password and code secret live in the service key directory. Changes require a second signature in advanced mode; in basic mode they are immediate and raise a high alert." },
      { category: "edge", key: "synthetic_login_interval_min", kind: "number", label: "Synthetic sign-in interval, minutes", hint: "15–1440." },
      { category: "edge", key: "probe_enabled", kind: "bool", label: "External address probe is enabled" },
      { category: "edge", key: "synthetic_login_enabled", kind: "bool", label: "Synthetic sign-in is enabled" },
    ] },
  ],

  "1e": [
    { title: "Who can enable External access", hint: "People enable it themselves in the workspace from the company network. An empty group list allows nobody.", fields: [
      { category: "edge", key: "login_groups", kind: "lines", label: "AD groups allowed to enable access", placeholder: "CN=memory-external,OU=Groups,DC=example,DC=test",
        hint: "One DN or group name per line, up to 50." },
      { category: "edge", key: "deny_groups", kind: "lines", label: "Groups denied external sign-in", hint: "Deny takes priority over allow." },
      { category: "edge", key: "deny_admin_count", kind: "bool", label: "Deny accounts with the adminCount flag" },
      { category: "edge", key: "optin_first_confirm", kind: "text", label: "First activation", hint: "office_or_support — from the office network or with support confirmation; none — no confirmation." },
      { category: "edge", key: "office_networks", kind: "lines", label: "Office networks (not VPN)", placeholder: "192.0.2.0/24", hint: "No broader than /16 for IPv4 or /48 for IPv6. Empty requires support for first activation." },
      { category: "edge", key: "optin_fresh_login_min", kind: "number", label: "Sign-in freshness for activation, minutes", hint: "1–60." },
      { category: "edge", key: "optin_idle_days", kind: "number", label: "Disable access after days without external sign-in", hint: "14–365; email sent 7 days before." },
    ] },
    { title: "Directory and passwords", hint: "External passwords are not checked at all while the AD lockout threshold is unknown (−1).", fields: [
      { category: "edge", key: "ad_lockout_threshold", kind: "number", label: "AD lockout threshold", hint: "−1 — unknown; 0 — no lockout; 1–999." },
      { category: "edge", key: "ad_lockout_window_min", kind: "number", label: "AD bad-password counter window, minutes", hint: "−1 — unknown; 1–1440." },
      { category: "edge", key: "ad_pdc", kind: "text", label: "Primary domain controller (PDC emulator)", placeholder: "pdc.example.test", hint: "Its bad-password counter is read. Use the same hostname or IP as a controller in “Sign-in and LDAP”: the service will not contact another address, and external passwords will not be checked. Empty also prevents checks. Directory discovery uses the controllers in “Sign-in and LDAP”." },
      { category: "edge", key: "login_domain", kind: "text", label: "Email domain for short logins", placeholder: "example.test", hint: "Empty requires a full email address." },
      { category: "edge", key: "badpwd_reserve_min", kind: "number", label: "Attempts reserved for internal sign-in", hint: "2–10." },
      { category: "edge", key: "password_failures_per_window", kind: "number", label: "External bad passwords per window", hint: "1–3." },
      { category: "edge", key: "password_window_min", kind: "number", label: "Budget window, minutes", hint: "15–1440." },
      { category: "edge", key: "password_failures_per_day", kind: "number", label: "External failures per account per day", hint: "1–20." },
      { category: "edge", key: "global_binds_per_min", kind: "number", label: "Directory password checks per minute", hint: "5–600." },
      { category: "edge", key: "ad_sweep_min", kind: "number", label: "Directory discovery interval, minutes", hint: "1–60." },
      { category: "edge", key: "ad_state_max_age_hours", kind: "number", label: "Maximum AD information age, hours", hint: "1–72." },
      { category: "edge", key: "ad_pso_visible", kind: "bool", label: "IT confirmed: password policies (PSO) are visible", hint: "Without IT confirmation, invisible PSOs remain a risk. Enabling this weakens protection against directory lockout; signature rules match those for the AD lockout threshold." },
      { category: "edge", key: "decoy_guids", kind: "lines", label: "Trap accounts (objectGUID)", hint: "Up to 10; sign-in with one raises an alert." },
    ] },
    { title: "Password guessing and limits", fields: [
      { category: "edge", key: "spray_alert_accounts_10min", kind: "number", label: "Alert: failures across people in 10 minutes" },
      { category: "edge", key: "spray_pause_accounts_10min", kind: "number", label: "Automatic pause: failures across people in 10 minutes", hint: "At least the alert threshold." },
      { category: "edge", key: "spray_auto_pause", kind: "bool", label: "Automatic 15-minute pause" },
      { category: "edge", key: "login_ip_limits", kind: "json", label: "Limits by address and login" },
      { category: "edge", key: "nat_cidrs", kind: "lines", label: "Company shared NAT addresses", placeholder: "198.51.100.0/24", hint: "Up to 50 networks, no broader than /16 for IPv4 or /48 for IPv6; higher per-address limits apply to these." },
      { category: "edge", key: "login_step_floor_ms", kind: "number", label: "Minimum sign-in step response time, ms", hint: "500–10000." },
      { category: "edge", key: "login_check_timeout_sec", kind: "number", label: "Password check timeout, seconds", hint: "2–20." },
      { category: "edge", key: "check_unhealthy_queue", kind: "number", label: "Check queue length before unhealthy status", hint: "10–200." },
    ] },
    { title: "Program connections", fields: [
      { category: "edge", key: "mfa_mode", kind: "text", label: "Second factor", hint: "off — disabled, optional — by choice, required — mandatory; never below the edge anchor limit. Weakening is immediate in basic mode (personal session only while external sign-in is open) and requires a second signature in advanced mode. Before requiring it, check coverage on the “Second factor” page." },
      { category: "edge", key: "access_token_min", kind: "number", label: "Access token lifetime, minutes", hint: "5–60." },
      { category: "edge", key: "connection_idle_days", kind: "number", label: "Connection idle timeout, days", hint: "1–30." },
      { category: "edge", key: "connection_max_days", kind: "number", label: "Maximum connection lifetime, days", hint: "1–30." },
      { category: "edge", key: "max_active_connections", kind: "number", label: "Connections per person", hint: "1–20." },
      { category: "edge", key: "login_session_hours", kind: "number", label: "Sign-in session with a factor, hours", hint: "1–24." },
      { category: "edge", key: "login_session_hours_no_mfa", kind: "number", label: "Sign-in session without a factor, hours", hint: "1–12." },
      { category: "edge", key: "grant_ttl_min", kind: "number", label: "Authorization lifetime before code exchange, minutes", hint: "1–30." },
      { category: "edge", key: "refresh_reuse_grace_sec", kind: "number", label: "Repeated refresh window, seconds", hint: "0–60." },
      { category: "edge", key: "refresh_reuse_action", kind: "text", label: "On refresh token reuse", hint: "revoke_connection — revoke the connection; reject_only — reject only." },
      { category: "edge", key: "account_page_enabled", kind: "bool", label: "“My connections” page outside the company network" },
      { category: "edge", key: "disabled_clients", kind: "lines", label: "Disabled programs (client_id)" },
    ] },
    { title: "External sign-in", hint: "New external sign-ins. Existing connections work even while sign-in is off, until they expire or are revoked.", fields: [
      { category: "edge", key: "login_enabled", kind: "bool", label: "External sign-in is enabled" },
    ] },
  ],

  "1f": [
    { title: "Second factor", hint: "The mode itself (“Second factor” under “Program connections”) is off by default. Weakening the mode or protections requires a second signature in advanced mode; in basic mode it is immediate and raises a high alert.", fields: [
      { category: "edge", key: "mfa_provider", kind: "text", label: "Second factor kind", hint: "totp — a code app on a phone." },
      { category: "edge", key: "mfa_required_grace_days", kind: "number", label: "Grace period for connections without a factor after requiring it, days", hint: "0–60." },
      { category: "edge", key: "mfa_issuer_label", kind: "text", label: "Name in the code app", hint: "1–40 characters, without a colon." },
      { category: "edge", key: "mfa_fresh_login_min", kind: "number", label: "Sign-in freshness for factor setup, minutes", hint: "2–60. Increasing requires a second signature in advanced mode; in basic mode it is immediate and raises a high alert." },
      { category: "edge", key: "mfa_pending_ttl_min", kind: "number", label: "Timeout for first setup code, minutes", hint: "5–60. Increasing requires a second signature in advanced mode; in basic mode it is immediate and raises a high alert." },
      { category: "edge", key: "recovery_low_threshold", kind: "number", label: "Remind when recovery codes remaining are at most", hint: "0–5; 0 disables reminders." },
    ] },
    { title: "Incorrect codes", hint: "Above the limit, code sign-in is locked and the person receives an email. Allowing more incorrect codes or shortening the window or lock requires a second signature in advanced mode; in basic mode it is immediate and raises a high alert.", fields: [
      { category: "edge", key: "code_failures_per_window", kind: "number", label: "Maximum incorrect codes per window", hint: "1–20." },
      { category: "edge", key: "code_failures_window_min", kind: "number", label: "Incorrect-code window, minutes", hint: "5–120." },
      { category: "edge", key: "code_failures_per_day", kind: "number", label: "Maximum incorrect codes per day", hint: "5–100." },
      { category: "edge", key: "code_lock_min", kind: "number", label: "Code sign-in lock duration, minutes", hint: "15–1440." },
    ] },
  ],

  "S2-3": [],

  "4": [],

  E2: [],

  "5": [],
};
