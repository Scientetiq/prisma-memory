import type { DeactivationPolicy } from "../../lib/labels";
import { pluralEn } from "../../i18n/core";
import { formatCount } from "../../i18n/format";
const DEACTIVATION_EFFECTS_DELETE = "Space memberships are removed. All of the person’s keys are revoked permanently: reactivation requires new keys. Their personal space is frozen, and its records are deleted after the configured retention period (access.dismissed_retention_days, 90 days by default). Records they moved to projects, teams and Company knowledge stay there. A file uploaded both to personal space and to a project or team passes to the team or project where it was first placed. A file uploaded only to personal space and Company knowledge passes to Company knowledge for curator review, unless curators previously removed it there (in which case it is deleted with personal space). Reactivation before the retention period ends unfreezes the space. For test accounts (addresses at corp.test or in the .test domain), records are deleted immediately from the company-wide space and after one hour from their other spaces (access.test_leftovers_grace_minutes); access.test_leftovers_scope controls whether this runs. When the profile has the test flag (also set by checks), records in the company-wide space are deleted immediately regardless of the address.";
import type { ClaimedKind, ClaimedSource, ClientKind, MemoryEffect, PersonalClassReason } from "../../lib/types";
export const CATEGORY_TITLES: Record<string, string> = {
    models: "Models and gateway",
    retrieval: "Semantic search",
    storage: "Storage",
    integrations: "Integrations",
    processing: "Processing",
    limits: "Limits",
    search: "Search",
    access: "Access",
    meetings: "Meetings",
    open_check: "open check",
    observability: "Observability",
    ldap: "Sign-in and LDAP",
    oidc: "Single sign-on (OpenID Connect)",
    oauth: "Agent sign-in (OAuth)",
    agent_auth: "Agent sign-in (built-in)",
    smtp: "Mail (SMTP)",
    onboarding: "Getting started",
    topics: "Topics",
    approvals: "Action approvals",
    edge: "External access",
    admin: "Administrators",
    security: "Security",
    locale: "Language",
};

export const CATEGORY_HINTS: Record<string, string> = {
    models: "Platform gateway, processing model, model timeouts and retries.",
    retrieval: "Semantic search model and reranker on the platform gateway.",
    storage: "S3-compatible storage for original files: separate buckets and credentials for each data class.",
    integrations: "Connectors to external systems (company and deal lookup, data intake) and the document converter.",
    processing: "Night window, chunking, model budgets, job retries and prompt versions.",
    limits: "Per-key request limits and upload sizes.",
    search: "Topic dictionary and search ranking adjustments.",
    access: "Memory URLs, trusted providers, signed links, roles, workspace server, trash, Company knowledge review, test cleanup and permanent deletion. Session duration and idle timeout are on “Sign-in and LDAP”; the workspace URL is on “Mail”. They are read-only here.",
    meetings: "Meeting participant consent: the text the sender confirms with a checkbox, and its version. A new version takes effect immediately; the previous version is no longer accepted.",
    oauth: "Connect MCP agents through your company’s identity provider (OpenID Connect): resource URL, allowed programs and connection lifetime. No client secret is needed. When enabled, “Connect an agent” opens company-account sign-in; Overview and “Keys and agents” link there too. A personal key remains available on the “With a personal key” tab. Turning this off returns to key-only connections.",
    agent_auth: "Agent sign-in without a separate identity provider: the agent opens a browser, and you sign in to the workspace and approve the connection. Use external for the company’s identity provider (“Agent sign-in (OAuth)”), builtin for memory’s own sign-in, or off for personal keys only. This section also covers preregistered programs, Client ID Metadata Documents (CIMD) and Dynamic Client Registration (DCR). Built-in sign-in requires HTTPS for both the agent and workspace URLs.",
    observability: "OTLP collector, log level and search outcomes.",
    onboarding: "First steps for people and teams: space descriptions, Overview, “You can add”, folder uploads, progress steps and past meetings.",
    topics: "Space topics and how they are assigned. Empty for now.",
    approvals: "Action approval cards for agents. Empty for now.",
    edge: "Access memory over the internet: external sign-in and the external server (edge) that receives published records.",
    admin: "Administrator sign-in, keys and sessions, second signatures, emergency access and alerts.",
    locale: "The language agents see in memory tools: tool names and descriptions, connection instructions, MCP resources and prompts. Tool identifiers and schemas stay the same. Agents receive updated text within 5 minutes or after restarting the session.",
};

export const CHECK_TITLES: Record<string, string> = {
    origin_allowlist: "allowed Origin list",
    t1_gate: "T1 gate (T1 providers)",
    settings: "required settings",
    db_open: "open-data database",
    db_closed: "closed-data database",
    audit_append_only: "append-only audit log",
    embedder: "embedding service",
    embedder_model: "semantic search model",
    fts_index: "word search language",
    embedding_index: "semantic search re-embedding",
    platform: "platform gateway",
    models: "models: connections and record access",
    storage: "object storage",
    storage_isolation: "storage separation by class",
    original_storage: "storage of original files",
    database: "main database",
    schema: "database schema",
    ldap: "directory sign-in (LDAP)",
    oidc: "single sign-on (OpenID Connect)",
    oauth: "agent sign-in with a company account (OAuth)",
    smtp: "mail (SMTP)",
    llm: "model: pause, load and waiting",
    converter: "document converter: connection and queue",
    edge_export: "edge export (external access)",
    test_hooks: "acceptance test hooks",
    open_check: "open check for records",
    class_consistency: "data class consistency across databases",
    group_sync: "directory group sync (space membership)",
    external_channel: "external URL and agent URLs",
    external_login: "external sign-in: verification service and pause",
    disk_guard: "disk space: file intake",
    audit_outbox: "audit log outbox",
    alert_channel: "external sign-in alert emails",
    tls_links: "links without TLS (connection encryption)",
    secrets_source: "service keys: credential sources",
    local_admin_factor: "local administrator’s second factor",
    deploy_profile: "deployment profile",
    proxy_trust: "untrusted proxy: client addresses are lost",
};

export const EFFECT_TITLES: Record<MemoryEffect, string> = {
    base: "Basic access",
    space_owner: "Owner of spaces in scope",
    space_reader: "Read spaces in scope",
    admin: "Administration without reading content",
    audit: "Read the audit log",
    none: "No effect in memory",
};

export const EFFECT_HINTS: Record<MemoryEffect, string> = {
    base: "Active employee: your records, Company knowledge, your teams and your department’s space.",
    space_owner: "A manager owns their department’s space; an assigned curator owns Company knowledge.",
    space_reader: "Read spaces in scope without writing; requires an explicit assignment.",
    admin: "People, services, keys, spaces and settings — record content is unavailable.",
    audit: "Audit log: request facts without record content.",
    none: "Company portal, service and source-system roles. Kept for completeness; they do NOT extend access to memory data.",
};

export const ORIGIN_TITLES: Record<string, string> = { memory: "memory", hub: "portal", service: "service", source_system: "source system" };

export const SCOPE_TITLES: Record<string, string> = {
    own: "your own",
    org_unit: "department",
    org_branch: "department branch",
    company: "company",
    space: "space",
    objects: "objects",
    catalog: "directory",
};

export const SCOPE_REF_HINTS: Record<string, string> = {
    org_unit: "department code",
    org_branch: "root department code for the branch",
    space: "space slug",
    objects: "object identifiers",
};

export const BASIS_TITLES: Record<string, string> = {
    request: "request",
    manual: "manual decision",
    org_table: "org table",
    directory: "directory (LDAP)",
    bitrix: "CRM connector",
    sap: "SAP",
};

/** Stored provenance codes of grants (approved_by) and keys (basis) written by the gateway itself. */
export const PROVENANCE_TITLES: Record<string, string> = {
    installation_code: "installation code",
    self_service: "self-service",
};

export const SERVICE_KIND_TITLES: Record<string, string> = {
    transcriber: "transcriber",
    chat: "chat",
    meeting_assistant: "meeting assistant",
    converter: "converter",
    audio_agent: "audio agent",
    pipeline: "pipeline",
    other: "other",
};

export const CLIENT_KIND_TITLES: Record<ClientKind, string> = {
    claude_code: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    cloud_other: "Other cloud agent",
    script: "Script or local program",
};

export const LABELS_TEXT = {
    clientKindNone: "not specified (cloud)",
    clientKindHint: "A cloud agent (Claude Code, Codex, Cursor and others) writes notes and documents to your personal space as open records while agent records in personal space are open (see “Agent records in personal space” on this page). Your agents can find them; colleagues cannot see them. A record with open check findings (phone numbers, passwords, NDA…) is saved as closed; meetings there are always closed. A script or local program uploads without the model: everything it writes to personal space is closed, and this switch does not affect it. You can show a record to agents here in the workspace.",
    searchSliceOther: "other",
    unknown: "unknown",
    conversionTextPartial: "some pages are scans: their text was read automatically without verification, or was not read — check the original",
    conversionOpenPartial: "some pages are scans and could not be checked: this file cannot be accepted into a shared space — upload it to a closed team space",
    conversionOpenPartialKept: "some pages are scans and cannot be checked, so the file itself is unavailable; recognised text is on this page",
    conversionTextNotFound: "no text found in the file — the record cannot be found by words in the document; it appears to contain scans or photos of pages: upload a PDF with text you can select and copy",
    failedWhy: (why: string): string => `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
    conversionLine: (head: string, why: string): string => why ? `${head}: ${why}` : head,
    originalPartial: "The file itself is unavailable: some pages are scans and cannot be checked. Recognised text is on this page.",
    originalUnavailable: "The file itself is unavailable: its text was not recognised, and scanned pages cannot be checked.",
    agentFileLine: (reasons: readonly string[]): string => `The text is available to agents. The file itself is for people only: ${reasons.length ? reasons.join("; ") : "it contains material missing from the text that was not checked"}.`,
    queueLine: (lane: string | null | undefined, hint: string, minutes: number | null): string => `${lane ? `Queue: ${lane}` : "Processing queue"}. ${lane ? hint : "Stages update automatically."}${minutes !== null ? ` Estimated wait: ${formatCount(minutes)} ${pluralEn(minutes, "minute", "minutes")}.` : ""}`.trim(),
    graceTitle: (minutes: number): string => {
      if (minutes === 60) return "an hour";
      if (minutes > 0 && minutes % 1440 === 0) { const n = minutes / 1440; return `${formatCount(n)} ${pluralEn(n, "day", "days")}`; }
      if (minutes > 0 && minutes % 60 === 0) { const n = minutes / 60; return `${formatCount(n)} ${pluralEn(n, "hour", "hours")}`; }
      return `${formatCount(minutes)} ${pluralEn(minutes, "minute", "minutes")}`;
    },
    deactivationEffects: (p: DeactivationPolicy): string => {
      if (p.personal === "delete") return DEACTIVATION_EFFECTS_DELETE;
      const meetings = p.meetings === "wait"
        ? "The employee’s meetings stay with them as before: participants can see them, but they have no organiser."
        : `${p.after_days > 0 ? `After ${formatCount(p.after_days)} ${pluralEn(p.after_days, "day", "days")}` : "Immediately after departure"} (access.dismissed_custody_after_days), the employee’s meetings with other participants pass to the custodian. The custodian becomes the organiser; participants see the meetings as before.`;
      return "Space memberships are removed. All of the person’s keys are revoked permanently: reactivation requires new keys. "
        + "The employee’s personal space is frozen and retained indefinitely: nothing is deleted, including trash. "
        + "The custodian is the employee’s manager in the org table, then the department head if no manager is listed, or someone you assign in the person’s profile if neither is available. "
        + "The custodian can read the employee’s personal space in the workspace; the custodian’s agents cannot see these records. "
        + `${meetings} Reactivation unfreezes the space and returns the employee’s meetings. `
        + "For test accounts (addresses at corp.test or in the .test domain), records are deleted immediately from the company-wide space and after one hour from their other spaces (access.test_leftovers_grace_minutes); access.test_leftovers_scope controls whether this runs. "
        + "Their personal space is deleted after the configured retention period (access.dismissed_retention_days, 90 days by default). "
        + "When the profile has the test flag (also set by checks), records in the company-wide space are deleted immediately regardless of the address.";
    },

};

export const CLAIMED_KIND_TITLES: Record<"script" | "transport" | "internal", string> = {
    script: "Script",
    transport: "HTTP library (unrecognised)",
    internal: "Checks and memory workspace",
};

export const CLAIMED_SOURCE_TITLES: Record<ClaimedSource, string> = {
    meta: "clientInfo on every request",
    initialize: "clientInfo at connection (initialize)",
    user_agent: "User-Agent header",
};

export const CLIENT_MISMATCH_TITLES: Record<"warn" | "info", string> = { warn: "mismatch", info: "for information" };

export const CLIENT_KIND_PANEL_HINTS: Record<"personal" | "extended", string> = {
    personal: "client_kind: where the person will use the key. A cloud agent writes notes and documents to their personal space as open records until they make agent records closed (“Keys and agents” → “Agent records in personal space”). Records with open check findings are closed. A script or local program writes closed records because it uploads without the model. Meetings in personal space are always closed, regardless of the program. The person sees the program in “Keys and agents”.",
    extended: "client_kind: where the person will use the key. An extended key can read closed records, so its records in personal space are closed for every program. Here the program is a label for the person and the audit log; it does not affect the data class. The person sees the program in “Keys and agents”.",
};

export const PERSONAL_CLASS_REASON_TITLES: Record<PersonalClassReason, string> = {
    notebook: "agent records in personal space are open",
    notebook_off: "the person made agent records in personal space closed",
    script: "script or local program key",
    reads_closed: "the key can read closed records",
    service: "service key",
};

export const KEY_KIND_TITLES: Record<string, string> = {
    personal: "personal",
    service: "service",
    extended: "extended",
    system: "system",
    session: "workspace session",
};

export const SESSION_SOURCE_TITLES: Record<string, string> = { ldap: "AD account", oidc: "single sign-on", test: "acceptance test sign-in" };

export const SPACE_KIND_TITLES: Record<string, string> = { personal: "personal space", team: "team space", org: "Company knowledge", project: "project" };

export const CREATED_VIA_TITLES: Record<string, string> = { workplace: "workspace", mcp: "agent (MCP)", admin: "admin panel", org_table: "org table", unknown: "not recorded" };

export const GROUP_STATUS_TITLES: Record<string, string> = {
    pending: "not synced yet", ok: "synced", missing: "not in the directory — membership unchanged", too_large: "over the limit — membership frozen", error: "directory error",
};

export const CLASS_TITLES: Record<string, string> = { open: "open", closed: "closed" };

export const AUDIT_EVENT_TITLES: Record<string, string> = {
    read: "read",
    search: "search",
    list: "list",
    write: "write",
    promote: "move between spaces",
    open: "show to agents",
    forget: "deletion and trash",
    extended_key_use: "extended key",
    t1_fallback: "T1 fallback",
    confirmation: "confirmation",
    admin: "administration",
    processing: "processing",
    auth_failure: "sign-in refused",
    rate_limited: "rate limit exceeded",
    class_move: "access change (open/closed)",
    purge: "purge",
    directory: "directory search",
    external: "external access",
};

export const RECORD_TYPE_TITLES: Record<string, string> = { document: "document", transcript: "meeting", event: "decision or task", summary: "meeting summary", profile: "profile", note: "note" };

export const SPACE_ROLE_TITLES: Record<string, string> = { owner: "owner", member: "member", reader: "read-only" };

export const SPACE_ROLE_YOU: Record<string, string> = { owner: "you are the owner", member: "you are a member", reader: "you have read-only access" };

export const SPACE_ROLE_HINTS: Record<string, string> = {
    owner: "reads everything in the space, writes records, promotes their own records, deletes space records and manages manual members",
    member: "reads everything in the space and writes to it; can promote and delete their own records",
    reader: "reads space records only",
};

export const VIA_TITLES: Record<string, string> = { personal: "personal space", org_unit: "org table: department", grant: "role assignment", manual: "added manually", org: "all company employees", group: "AD group" };

export const EVENT_KIND_TITLES: Record<string, string> = { decision: "decision", action: "task", question_risk: "risk or question", fact: "fact", note: "note" };

export const ORIGIN_RECORD_TITLES: Record<string, string> = { document: "from a document", human: "said by a person", model: "created automatically", agent: "agent record" };

export const SOURCE_KIND_TITLES: Record<string, string> = {
    upload: "file upload", agent: "via MCP — agent or workspace", ingest: "received from a source system",
    transcript: "meeting transcript", email: "email", promote: "promoted from another space",
    correction: "correction provided by a person",
};

export const SEARCH_MODE_TITLES: Record<string, string> = { hybrid: "standard", keyword: "exact words", semantic: "by meaning", recent: "recent" };

export const SEARCH_MODE_HINTS: Record<string, string> = { hybrid: "ask in your own words: searches by words and meaning", keyword: "codes, abbreviations and exact names", semantic: "similar meaning, even with different words", recent: "new records matching the filters, without a query" };

export const CONVERSION_STATUS_TITLES: Record<string, string> = { pending: "conversion in progress", done: "conversion complete", failed: "conversion failed" };

export const CONVERSION_ERROR_TITLES: Record<string, string> = {
    converter_too_large: "the file exceeds the document converter’s size limit",
    converter_unsupported: "the converter does not support this format",
    converter_auth: "the converter rejected the credentials — contact your administrator",
    converter_timeout: "the converter did not respond in time",
    converter_rejected: "the converter refused to process the file",
    converter_no_text: "no text found in the file — it appears to contain scans or photos of pages; upload a PDF with text you can select and copy",
    converter_run_gone: "the conversion run was lost — upload the file again",
    converter_http: "conversion failed: the converter returned an error — an administrator can retry",
    converter_network: "the converter did not respond — an administrator can retry",
    converter_fail_retryable: "the converter could not process the file — you can click “Process now”",
    converter_cancelled: "processing was stopped by the converter — you can click “Process now”",
    converter_stuck: "the converter never started processing the document — you can click “Process now”",
    converter_deadline: "the converter exceeded the deadline — you can click “Process now”",
    converter_result_missing: "the converter did not return the completed result — an administrator will investigate",
    converter_copies_limit: "the converter repeatedly lost the upload — an administrator can retry",
    converter_doc_error: "the converter is not returning this document’s result — an administrator will investigate",
    converter_encrypted: "the file is password-protected — remove the password and upload it again",
    converter_malformed: "the file is damaged — save it again and upload it",
    converter_gave_up: "the converter could not process the document",
    converter_unexpected: "processing failed — an administrator will investigate",
    converter_patience: "the converter did not respond for a long time — an administrator can retry",
    converter_assurance_conflict: "the converter did not provide text for this run — an administrator will investigate",
    original_changed: "the file in storage has changed — upload it again",
    original_missing: "the original was not saved — upload it again",
    open_check: "the document text did not pass the check for a shared space — upload it to a closed team space",
    open_check_fallback_failed: "the move to closed access after a finding failed repeatedly — the document is hidden and no one can download the file (the original is retained in a team or project); “Retry” under “Data class moves” will move it to closed access, where conversion will continue automatically",
    version_refused: "the new version was not added to the document",
};

export const AGENT_FILE_WHY_TEXT: Readonly<Record<string, string>> = {
    images: "it contains images that were not checked",
    pictures_skipped: "it contains images that were not checked",
    pdf_hidden_parts: "it contains comments, attachments or form fields missing from the text",
    office: "the file may contain material missing from the text: images, comments or hidden slides",
    table_truncated: "the table is truncated in the text",
    active_content: "it contains macros or other content that was not checked",
    other_format: "files in this format are not provided to agents",
};

export const QUEUE_LANE_TITLES: Record<string, string> = { now: "now", day: "day queue", night: "night queue" };

export const QUEUE_LANE_HINTS: Record<string, string> = {
    now: "processed first — usually within minutes.",
    day: "processed during the day.",
    night: "processing runs at night: records will be searchable by morning. Need them sooner? “Process now” raises their priority.",
};

export const MY_AUDIT_TITLES: Record<string, string> = { admin: "management" };

export const KEY_STATUS_TITLES = { current: "this session", active: "active", revoked: "revoked", expired: "expired" } as const;

export const SOURCE_TITLES: Record<string, string> = { org_table: "org table", directory: "directory", manual: "manual", grant: "assignment", org: "org structure", group: "AD group" };

export const RELATION_TITLES: Record<string, string> = { head: "manager", deputy: "deputy", member: "employee" };

export const SPACE_STATUS_TITLES = { active: "active", archived: "archived", all: "all" } as const;

export const PEOPLE_STATUS_TITLES = { true: "active", false: "deactivated (archived)", all: "all" } as const;

export const LEFTOVERS_SCOPE_TITLES: Record<string, string> = { off: "off", org: "company-wide space only", all: "all their spaces" };

export const LEFTOVERS_SKIPPED_TITLES: Record<string, string> = {
    read_by_staff: "employees read the record",
    placed_by_staff: "an employee placed the document",
    staff_participants: "a meeting participant is an employee",
    pending_participants: "the meeting is waiting for participants to sign in",
    unresolved_participants: "meeting participants were not found in the directory",
    foreign_owner: "another person’s materials are linked to the record",
};

export const LEFTOVERS_KEPT_TITLES: Record<string, string> = {
    staff_records: "contains employee records",
    staff_members: "has employee members",
    skipped_records: "contains records that cannot be deleted",
    service_space: "a service writes here",
    unit_active: "the department is active",
};

export const TEST_PURGE_MODE_TITLES: Record<string, string> = { off: "off", auto: "automatically, every hour" };

export const TEST_PURGE_STOP_TITLES: Record<string, string> = {
    S1: "the plan contains data that must never be deleted",
    S2: "records failed the rules check",
    S3: "the per-run limit was exceeded",
    S4: "records are still being processed",
    S5: "no verified backup",
    S6: "the independent plan check did not match",
    S7: "the plan is outdated or damaged",
    S8: "the employee or active-space count did not match expectations",
    S9: "the audit log rejected the event",
    S10: "disabled — purge mode or test cleanup",
    S11: "record cleanup is not progressing",
    S12: "the meeting list does not match the approved list",
    S13: "the database rejected data the plan marked for deletion",
    S14: "non-test data was affected",
    S15: "an approved meeting appears to be real",
    S16: "other connections are active during the maintenance window",
    S17: "department approval is required",
    S18: "record cleanup has been busy for over 5 minutes",
};

export const TEST_PURGE_BACKLOG_TITLES: Record<string, string> = {
    people: "accounts", spaces: "spaces", keys: "keys", sessions: "sessions", org_units: "departments", services: "services", entities: "entities",
};

export const LEFTOVERS_KIND_TITLES: Record<string, string> = { org: "company-wide", personal: "personal", team: "teams", project: "projects", dep: "departments" };

export const OBO_DENIAL_TITLES: Record<string, string> = {
    obo_not_allowed: "the service is not allowed to act on behalf of people",
    obo_unknown_person: "the person is unknown or inactive",
    obo_demo_person: "demo person in the role showcase",
    obo_key_paused: "the key is paused",
};

export const OPEN_CHECK_KIND_TITLES: Record<string, string> = { secret: "secrets", pii: "personal data", money: "amounts", contract: "contracts", nda: "NDA", custom: "custom", unchecked: "unchecked", never_open: "“never open”" };

export const MOVE_VIA_TITLES: Record<string, string> = {
    person: "person or administrator", open_check_fallback: "memory: open check finding (personal space or a file in a team or project)",
    agent_relayed: "agent on the person’s instruction", human_workplace: "person: make available to agents",
    despite_rollback: "administrator: undo sharing in teams and projects",
    resume_refused: "memory: returned to closed access — sharing failed the repeat check",
    nda_recheck: "memory: recheck against the NDA list",
};

export const MOVE_CONFIRMATION_TITLES: Record<string, string> = { agent_relayed: "person’s instruction through an agent", human_workplace: "person in the workspace" };

export const OPEN_CHECK_VIA_TITLES: Record<string, string> = {
    remember: "remember", upload: "upload", promote: "move", open: "show to agents", convert: "PDF after conversion", move: "data class move", derive: "generated by the model",
    space: "space name",
    open_word: "open on a person’s instruction",
    link: "record link",
    correct: "correction",
    handover: "hand over a meeting decision to a project",
    nda_recheck: "recheck against the NDA list",
};

export const OPEN_CHECK_FIELD_TITLES: Record<string, string> = {
    text: "text", title: "title", filename: "filename", source: "source", summary: "summary", entities: "entities", original: "original", derived: "derived record",
    participants: "meeting participants",
    name: "space name", description: "space description", readme: "“More about this space”", slug: "space identifier",
    quote: "quote", rationale: "rationale",
};

export const OPEN_CHECK_UNCHECKED_TITLES: Record<string, string> = {
    timeout: "timed out", conversion_pending: "still converting", conversion_failed: "conversion failed", empty_text: "no text",
    partial_text: "some pages are scans",
    original_unavailable: "original not read", original_too_large: "original too large", check_failed: "check failed",
    busy: "check server busy",
    tree_too_large: "edit history too long",
};

export const OPEN_REFUSED_TITLES: Readonly<Record<string, string>> = {
    changed: "not shown to agents: the record changed after your consent — open it and review it again",
    audience: "not shown to agents: who can see the record has changed — open it and review it again",
    no_write: "not shown to agents: you can no longer edit records in this space",
    disabled: "not shown to agents: the administrator disabled sharing",
    found: "not shown to agents: the check found something new — open the record and review it again",
    never_open: "not shown to agents: the administrator forbids sharing these records with agents",
    unchecked: "not shown to agents: memory could not check the record in time — try sharing it again in a few minutes",
    consent_needed: "not shown to agents: your consent predates a memory update — open the record and confirm sharing again",
};

export const AUDIT_ACTION_TITLES: Record<string, string> = {
    plan: "bulk action plan created",
    plan_apply: "change plan applied",
    plan_cancel: "change plan cancelled",
    plan_view: "change plan viewed",
    // space export in the workplace: the download started and ended — the archive itself is not kept
    export: "space export started",
    export_done: "space export ended",
    correct: "corrected in memory",
    correct_proposed: "correction proposed",
    correct_confirm: "correction confirmed",
    correct_reject: "correction rejected",
    correct_withdraw: "correction withdrawn",
    link_confirm: "confirmed: replaced or corrected",
    corrections_view: "corrections viewed",
    suppressed_by_correction: "event not restored by re-extraction: a person corrected it",
    move_space: "moved between spaces",
    return: "returned to personal space",
    delete: "moved to trash",
    restore: "restored from trash",
    trash_purge: "deleted permanently from trash",
    purge_now: "deleted permanently",
    close: "hidden from agents",
    close_failed: "not hidden: the move failed — agents can find the record again; click “Hide from agents” again",
    open: "shown to agents",
    key_issue_self: "personal key issued",
    key_revoke_self: "personal key revoked",
    key_client_kind_set: "personal key marked as a script key",
    session_end: "workspace session ended",
    sessions_end_all: "all workspace sessions ended",
    login: "signed in to the workspace",
    person_created: "profile created at first sign-in",
    person_login_changed: "login changed (email in directory)",
    oidc_check: "identity provider check",
    smtp_test: "test email",
    operator_linked: "administrator linked to a person",
    mail_retry: "email retried",
    mail_cancel: "email cancelled",
    hidden_locator: "closed record locator",
    section_candidates: "section titles shown to an agent: several sections match; no text was provided",
    placement: "placement",
    open_check_refused: "rejected by the open check",
    open_check_fallback: "saved as closed by the open check",
    open_check_fallback_failed: "move to closed access after the open check failed",
    open_relayed: "shown to agents on your instruction through an agent",
    open_despite: "shown by you to agents despite a finding",
    open_refused: "not shown to agents: the record or its readers changed, sharing was disabled or the check found something new — open the record and review it again",
    open_failed: "not shown to agents: the move failed — ask to share it again",
    open_done: "shown to agents on your instruction: memory checked again and moved the record to open access",
    open_word_denied: "an agent asked to share a record with agents — only you can do this in the workspace",
    close_rollback: "hidden from agents by an administrator: sharing despite findings in teams and projects was undone",
    convert_refused: "file not reprocessed: agents see only its text — hide the record first",
    space_archive: "space archived",
    space_unarchive: "space unarchived",
    extended_open_denied: "an agent with extended access was not allowed to create an open record",
    derived_refused: "agent did not save the retelling: it would be visible to people who cannot see the source",
    handover: "meeting decision handed over to a project",
    handover_form: "“Hand over to a project” form opened",
    meeting_participant_left: "removed themselves from meeting participants",
    obo_consent_grant: "you allowed the service to search and read memory on your behalf",
    obo_consent_revoke: "permission for the service to read on your behalf ended",
    obo_read_no_consent: "a service requested access on your behalf without consent — reading was refused",
    key_open_write_on: "administrator allowed the key to create open records",
    key_open_write_off: "the key cannot create open records",
    key_issue: "administrator issued a key",
    key_update: "administrator changed a key",
    org_useful: "marked “Useful” in Company knowledge",
    org_unuseful: "“Useful” mark removed",
    org_wrong: "marked “Wrong / not for everyone” — agents cannot find the record until a curator decides",
    org_unwrong: "“Wrong / not for everyone” mark removed",
    org_confirm: "confirmed by a Company knowledge curator",
    org_return: "returned from Company knowledge",
    org_return_auto: "returned from Company knowledge automatically: no curator confirmation within the deadline",
    org_delete: "deleted by a Company knowledge curator (returned, then moved to trash)",
    org_digest: "email to Company knowledge curators",
    org_review_now: "Company knowledge review job started",
    org_review_expire: "record review deadline moved (test hook)",
    my_meetings: "“Meetings with me” list shown",
    trash: "trash shown",
    deletion_requests: "deletion requests shown",
    participants: "meeting participants shown",
    status_derived: "information extracted from the record shown",
    derivation_sources: "retelling sources shown",
    deletion_requested: "participant requested meeting deletion",
    deletion_declined: "owner kept the meeting",
    deletion_kept: "administrator kept the meeting",
    deletion_request_keep: "administrator kept the meeting after a deletion request",
    deletion_request_delete: "administrator deleted the meeting on request",
    organizer_transfer: "meeting handed over to you: the previous organiser has left the company",
    organizer_return: "meeting returned to the previous organiser",
    organizer_return_reactivated: "meeting returned to the previous organiser: they rejoined the company",
    organizer_return_wait: "meeting returned to the previous organiser: configured by an administrator",
    close_organizer_transfer: "hidden from agents: the meeting has a new organiser",
    organizer_return_trashed: "meeting from trash returned to the previous organiser: placed in their trash with a new retention period",
    close_nda_recheck: "hidden from agents: a customer name from the updated NDA list was found",
    open_nda_recheck: "available to agents again: the recheck found no issues",
    open_recheck_held: "hidden from agents by a recheck: a customer name from the NDA list was found",
    open_recheck_on_restore: "record is in trash: restoring it will keep it hidden from agents",
    close_nda_recheck_rules: "hidden from agents: the recheck found content that cannot be open",
    close_nda_recheck_unchecked: "hidden from agents: the recheck failed three times",
    open_recheck_held_rules: "hidden from agents by a recheck: content that cannot be open was found",
    open_recheck_held_unchecked: "hidden from agents: the recheck failed three times",
    open_recheck_on_restore_rules: "record is in trash: the recheck found content that cannot be open — restoring it will keep it hidden from agents",
    open_recheck_on_restore_unchecked: "record is in trash: the recheck failed — restoring it will keep it hidden from agents",
    open_recheck_kept: "kept hidden from agents",
    open_recheck_start: "open record recheck against the NDA list started",
    open_recheck_done: "open record recheck against the NDA list finished",
    custody_assign: "custodian assigned to a former employee’s personal space",
    custody_change: "custodian of a former employee’s personal space changed",
    custody_end: "custody of personal space ended",
    custody_set: "administrator assigned a custodian",
    custody_manager_detached: "former employee’s manager link ignored: their email now belongs to another employee",
    custody_read: "former employee’s record read",
    custody_read_closed: "former employee’s closed record read",
    custody: "former employee’s record list shown",
    custody_copy: "former employee’s record copied to your personal space",
    profile: "work profile changed",
    profile_refused: "work profile not saved: private-life information was found in the text",
    profile_view: "work profile hidden from agents opened",
    profile_public: "what colleagues see in the profile changed",
    profile_public_off: "profile removed from Company knowledge",
    space_guide: "“How we work” guide changed",
    space_guide_view: "“How we work” guide opened",
    optin_enabled: "external access enabled",
    optin_disabled: "external access disabled",
    revoke_all: "all external connections disabled",
    optin_confirm_requested: "support request sent to enable external access for the first time"
};

export const ROLE_TITLES: Record<string, string> = {
    employee: "Employee", unit_head: "Department head", unit_deputy: "Deputy head", company_management: "Company management",
    branch_reader: "Department branch reader", memory_admin: "Memory administrator", security_auditor: "Security auditor", org_curator: "Company knowledge curator",
    domain_owner: "Domain owner", champion: "Champion", effect_owner: "Outcome owner", pm_kam: "Project manager / key account manager", legal_specialist: "Legal / domain specialist",
    tender_decision: "Tender decision-maker", office_booking_user: "Office booking user", travel_assistant: "Travel assistant recipient",
    contract_digest: "Contract digest recipient",
};

export const KEY_OPEN_WRITE_TITLES: Record<"allowed" | "denied" | "marked", string> = {
    allowed: "as usual",
    denied: "cannot create open records",
    marked: "open records are marked",
};

export const EXTENDED_ATTEMPT_TITLES: Record<string, string> = {
    remember: "remember", upload: "upload", placement: "file placement", promote: "move", correct: "correction", link: "“replaced” link", space_meta: "space description",
};

export const ENTITY_ROLE_TITLES: Record<string, string> = {
    mentioned: "mention", participant: "participant", customer: "customer", deal: "deal", owner: "owner", author: "author", space: "project space",
};

export const SEARCH_SLICE_TITLES: Record<"channel" | "key_kind" | "closed_seen", Record<string, string>> = {
    channel: { agent: "AI agents", workplace: "people in the workspace" },
    key_kind: { personal: "personal agent key", extended: "extended access", connection: "company-account sign-in", obo: "service on behalf of an employee",
        service: "service", session: "workspace", unknown: "unknown" },
    closed_seen: { open: "open only", closed: "included closed records" },
};

export const SEARCH_SLICE_DIMS: ReadonlyArray<{ title: string }> = [{title: "Who searched"},
    {title: "Search mode"},
    {title: "Connection method"},
    {title: "Program"},
    {title: "Results shown"}];

export const ROLLOUT_STEP_TITLES: Record<number, string> = {
    1: "Visited the workspace", 2: "Connected an AI agent", 3: "Agent found something in memory", 4: "Agent opened a result",
    5: "Have a note of their own", 6: "Have a meeting in memory", 7: "Members of a project space",
};
