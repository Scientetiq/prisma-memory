export const CHECK_LINKS: Record<string, { label: string }> = {settings: {label: "Settings"}, origin_allowlist: {label: "Settings"}, t1_gate: {label: "Settings"}, platform: {label: "Settings"}, models: {label: "Settings"}, embedder: {label: "Settings"}, storage: {label: "Settings"}, test_hooks: {label: "Settings"}, ldap: {label: "Sign-in and LDAP"}, oidc: {label: "Single sign-on"}, smtp: {label: "Mail"}, oauth: {label: "Settings"}, group_sync: {label: "group bindings in the report"}, open_check: {label: "open check"}, llm: {label: "Processing"}, converter: {label: "Processing"}, edge_export: {label: "Edge export"}, class_consistency: {label: "data class moves"}, external_channel: {label: "Settings"}, alert_channel: {label: "Alerts"}};

export const CHECK_EFFECTS: Record<string, string> = {
    platform: "processing stages that need the model are waiting to retry",
    models: "processing stages that need a model are waiting for a connection or an allowance",
    embedder: "new records are not being prepared for semantic search",
    storage: "original files are not being saved or served",
    llm: "model requests are paused or queued",
    converter: "PDF documents are waiting for text conversion",
    edge_export: "edge export stopped automatically: the edge is not receiving records",
    ldap: "company-account sign-in is unavailable",
    oidc: "sign-in through the identity provider is unavailable",
    smtp: "emails are not being sent",
    group_sync: "directory group membership is not being synced to spaces",
    test_hooks: "acceptance test hooks are enabled",
    open_check: "open records are not being checked",
    class_consistency: "incomplete data class moves remain",
    origin_allowlist: "protection against browser origin spoofing is weakened",
    t1_gate: "some models cannot be called",
};

export const text = {
  off: "disabled",
  offDetail: (detail: string): string => `disabled: ${detail}`,
  versionUnknown: "version unknown",
  version: (value: string): string => `version ${value}`,
  banner: (parts: readonly string[]): string => {
    if (!parts.length) return "Some checks failed — see Overview for details.";
    const text = parts.join("; ");
    return `${text[0]!.toUpperCase()}${text.slice(1)}. Everything else is working.`;
  },
};
