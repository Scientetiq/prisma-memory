import { currentLocale, derived } from "../i18n/runtime";
import { SETTING_LABEL_TEXT, SETTING_PAGE_TITLES } from "../messages/setting-pages";
import { fieldCategory, LDAP_FIELDS, type LdapField } from "./ldap-form";
import { OIDC_FIELDS } from "./oidc-form";
import { SMTP_FIELDS } from "./smtp-form";
import { SETTING_LABELS_RU } from "../messages/setting-labels/ru";

export interface SettingOption { value: string; title: string }
export interface SettingLabel { label: string; options?: readonly SettingOption[] }

/** A line of a locale overlay (`messages/setting-labels/<locale>.ts`): the label and option titles by value. */
export interface SettingLabelText { label: string; options?: Readonly<Record<string, string>> }

const L = (label: string, options?: readonly SettingOption[]): SettingLabel => (options ? { label, options } : { label });

export const SETTING_LABELS: Readonly<Record<string, SettingLabel>> = {
  "models.gateway_base_url": L("Model gateway address"),
  "models.gateway_api_key": L("Memory key for the model gateway"),
  "models.llm_model": L("Record processing model"),
  "models.wire_fragment": L("Model request parameters"),
  "models.timeout_sec": L("Model response timeout, seconds"),
  "models.repair_retries": L("Retries for a malformed model response"),
  "models.schema_unsupported_keywords": L("Response schema keywords to remove for the model"),
  "models.t0_aliases": L("Models hosted within the company (no longer read: access is in models.allow_closed and models.allow_open)"),
  // the two embeddings connections
  "models.embeddings_provider": L("Embedding model, connection 1: API", [{ value: "", title: "not chosen" }, { value: "openai-compatible", title: "OpenAI-compatible" }, { value: "voyage", title: "Voyage" }, { value: "cohere", title: "Cohere" }, { value: "gemini", title: "Gemini" }, { value: "none", title: "switched off" }]),
  "models.embeddings_base_url": L("Embedding model, connection 1: address"),
  "models.embeddings_api_key": L("Embedding model, connection 1: key"),
  "models.embeddings_model": L("Embedding model, connection 1: model name"),
  "models.embeddings_params": L("Embedding model, connection 1: profile overrides"),
  "models.embeddings_b_provider": L("Embedding model, connection 2: API", [{ value: "", title: "not chosen" }, { value: "openai-compatible", title: "OpenAI-compatible" }, { value: "voyage", title: "Voyage" }, { value: "cohere", title: "Cohere" }, { value: "gemini", title: "Gemini" }, { value: "none", title: "switched off" }]),
  "models.embeddings_b_base_url": L("Embedding model, connection 2: address"),
  "models.embeddings_b_api_key": L("Embedding model, connection 2: key"),
  "models.embeddings_b_model": L("Embedding model, connection 2: model name"),
  "models.embeddings_b_params": L("Embedding model, connection 2: profile overrides"),
  // model connections of chat and rerank
  "models.chat_provider": L("Chat model: provider", [
    { value: "", title: "Platform gateway (legacy keys)" },
    { value: "openai-compatible", title: "OpenAI-compatible API" },
    { value: "anthropic", title: "Anthropic" },
    { value: "gemini", title: "Gemini" },
    { value: "none", title: "Off" },
  ]),
  "models.chat_base_url": L("Chat model: base address"),
  "models.chat_api_key": L("Chat model: API key"),
  "models.chat_model": L("Chat model: model name"),
  "models.chat_params": L("Chat model: preset and capabilities"),
  "models.rerank_provider": L("Reranker: provider", [
    { value: "", title: "Platform gateway (legacy keys)" },
    { value: "cohere", title: "Cohere-compatible API" },
    { value: "voyage", title: "Voyage" },
    { value: "jina", title: "Jina" },
    { value: "tei", title: "Text Embeddings Inference" },
    { value: "openrouter", title: "OpenRouter" },
    { value: "none", title: "Off" },
  ]),
  "models.rerank_base_url": L("Reranker: base address"),
  "models.rerank_api_key": L("Reranker: API key"),
  "models.rerank_model": L("Reranker: model name"),
  "models.rerank_params": L("Reranker: preset and capabilities"),
  // data policy on the pair "base URL + model"
  "models.allow_closed": L("Models allowed to receive closed records"),
  "models.allow_open": L("Models allowed to receive open records only"),
  "models.health_strict": L("Strict model health check"),
  "models.audit_calls": L("Audit of model calls", [
    { value: "hourly", title: "One event per hour" },
    { value: "each", title: "Every call" },
  ]),
  // usage of the model roles and prices
  "models.prices": L("Model prices"),
  "models.usage_retention_days": L("Keep model usage, days"),
  // money budget of the model calls
  "models.budget": L("Model budget"),
  "retrieval.embeddings_model": L("Semantic search model"),
  "retrieval.rerank_model": L("Search reranking model"),
  "retrieval.batch": L("Chunks per embedding request"),
  "retrieval.max_tokens": L("Maximum embedding chunk length, tokens"),
  "retrieval.rerank_top": L("Candidates to rerank"),
  "retrieval.retry_429_sec": L("Retry delay when the embedding model is busy, seconds"),
  "retrieval.tuning": L("Search tuning: candidate counts, fusion weights, vector index parameters"),
  "retrieval.reembed": L("Re-embedding: batch, run size, sweep, automatic switch, rollback days"),
  "retrieval.query_cache": L("Query vector cache: maximum entries and lifetime in seconds"),
  "storage.s3_endpoint": L("File storage address"),
  "storage.s3_endpoint_closed": L("Closed file storage address"),
  "storage.s3_region": L("Storage region"),
  "storage.bucket_open": L("Open files bucket"),
  "storage.bucket_closed": L("Closed files bucket"),
  "storage.access_key_open": L("Access key for the open files bucket"),
  "storage.secret_key_open": L("Secret key for the open files bucket"),
  "storage.access_key_closed": L("Access key for the closed files bucket"),
  "storage.secret_key_closed": L("Secret key for the closed files bucket"),
  "storage.inbox_prefix": L("Incoming documents folder in storage"),
  "storage.backup_retention_days": L("Server backup retention, days"),
  "integrations.converter_url": L("Document converter address"),
  "integrations.converter_login": L("Converter login"),
  "integrations.converter_password": L("Converter password"),
  "integrations.converter_profile": L("Converter mode", [{ value: "fast-extraction", title: "Fast" }]),
  "integrations.converter_classification": L("Document classification for the converter"),
  "integrations.converter_timeout_sec": L("Document processing timeout, seconds"),
  "integrations.converter_poll_sec": L("Converter polling interval, seconds"),
  "integrations.converter_request_timeout_sec": L("Converter response timeout, seconds"),
  "integrations.converter_result_max_bytes": L("Maximum converter text response, bytes"),
  "integrations.converter_text_max_bytes": L("Maximum document text from the converter, bytes"),
  "integrations.converter_max_reruns": L("Document reruns after converter failures"),
  "integrations.converter_window": L("Documents processed by the converter at once"),
  "integrations.converter_run_deadline_hours": L("Maximum time for one conversion, hours"),
  "integrations.converter_accepted_suspect_min": L("Minutes before an unstarted document is considered stuck"),
  "integrations.converter_accepted_rerun_min": L("Minutes before resubmitting a stuck document"),
  "integrations.converter_ocr_rerun_delay_min": L("Minutes before retrying unrecognized pages"),
  "integrations.converter_doc_error_max": L("Retries for a document the converter cannot return"),
  "integrations.converter_patience_hours": L("Wait for an unavailable converter, hours (0 — unlimited)"),
  "integrations.converter_dedup": L("Resubmitting the same file to the converter", [
    { value: "document", title: "Find an existing submission with the same content" },
    { value: "off", title: "Submit again every time" },
  ]),
  "integrations.converter_formats": L("Document formats accepted for text conversion"),
  "integrations.converter_office_test_hook": L("Office documents from test accounts — tests only"),
  "integrations.connectors_enabled": L("Connectors run"),
  "integrations.webhooks_enabled": L("Accept connector webhooks"),
  "integrations.webhooks_shared_secret_enabled": L("Accept a bearer push token instead of a signature"),
  "integrations.webhooks_max_body_mb": L("Largest webhook request, MiB"),
  "integrations.webhooks_tolerance_sec": L("Allowed clock difference of signed webhooks, seconds"),
  "integrations.connectors_packs": L("Optional connector packs"),
  "integrations.connectors_private_networks": L("Private networks connectors may reach"),
  "integrations.connectors_folder_roots": L("Directories folder connectors may read"),
  "integrations.connectors_daily_items": L("Daily items per connector"),
  "integrations.connectors_daily_mb": L("Daily data per connector, MiB"),
  "integrations.connectors_max_failures": L("Failed runs before a connector stops"),
  "integrations.connectors_sync_concurrency": L("Connector runs at the same time"),
  "processing.night_window": L("Processing night window"),
  "processing.chunk": L("Text chunking"),
  "processing.budgets": L("Text budgets for the model"),
  "processing.events": L("Extracting events from meetings"),
  "processing.concurrency": L("Concurrent model requests"),
  "processing.llm_gate": L("Protection against excess model requests"),
  "processing.llm_retry": L("Retries when the model times out"),
  "processing.retries": L("Job retries"),
  "processing.daytime_token_cap": L("Daytime processing limit, tokens"),
  "processing.documents_lane": L("When uploaded documents are processed", [
    { value: "now", title: "Right after upload" },
    { value: "night", title: "In the night window" },
  ]),
  "processing.nighttime_token_cap": L("Nightly model limit, tokens per night"),
  "processing.entity_linking": L("Linking to companies and deals"),
  "processing.prompts": L("Prompt versions"),
  "processing.backfill_per_night": L("Records recalculated per night"),
  "processing.profiles_sync_at": L("Time to build colleague profiles"),
  "processing.report_at": L("Morning report time"),
  "processing.class_move_fault": L("Record class move failure — tests only"),
  "processing.links_test_hook": L("Links for test accounts — tests only"),
  "processing.llm_fault": L("Model failure — tests only"),
  "processing.open_check_fault": L("Open check failure — tests only"),
  "processing.conversion_fault": L("Conversion failure — tests only"),
  "processing.disk_guard_fault": L("Low disk space — tests only"),
  "processing.rebuild_disk": L("Free-space check before a search data rebuild"),
  "processing.scheduler_interval_sec": L("Processing interval, seconds"),
  "processing.reclaim_running_on_start": L("Resume interrupted processing at startup"),
  "processing.converter_holds": L("Document conversion pause", [
    { value: "", title: "No pause" },
    { value: "new", title: "New documents wait" },
    { value: "all", title: "Pause all processing" },
  ]),
  "oauth.enabled": L("Agent sign-in with company accounts"),
  "oauth.issuer": L("Identity provider address for agents (issuer)"),
  "oauth.resource_url": L("Memory address for agents (resource)"),
  "oauth.ca_cert": L("Identity provider root certificate (PEM)"),
  "oauth.allowed_clients": L("Allowed applications"),
  "oauth.scope": L("Required access scope"),
  "oauth.timeout_sec": L("Identity provider timeout, seconds"),
  "oauth.connection_days": L("Agent connection lifetime, days"),
  "agent_auth.mode": L("Who signs agents in through the browser", [
    { value: "external", title: "Company identity provider (Agent sign-in (OAuth) section)" },
    { value: "builtin", title: "Memory itself: colleague sign-in in the workspace" },
    { value: "off", title: "Nobody: personal keys only" },
  ]),
  "agent_auth.clients": L("Preregistered applications (client IDs and redirect addresses)"),
  "agent_auth.cimd_hosts": L("Application identity document sources (host and path prefix)"),
  "agent_auth.cimd_any_https": L("Accept application identity documents from any HTTPS address"),
  "agent_auth.dcr_enabled": L("Automatic application registration (DCR)"),
  "agent_auth.dcr_limits": L("Automatic registration limits (per_day_trusted — daily allowance for cloud application egress networks)"),
  "agent_auth.dcr_trusted_egress": L("Cloud application egress networks (CIDR): shared per_day_trusted allowance instead of a per-network limit"),
  "agent_auth.connection_days": L("Agent connection lifetime with built-in sign-in, days"),
  "agent_auth.idle_days": L("Days of inactivity before disconnecting an agent"),
  "limits.personal_per_minute": L("Requests per minute per personal key"),
  "limits.process_now_per_hour": L("Process now requests per hour per person"),
  "limits.directory_cache_sec": L("Directory response cache lifetime, seconds"),
  "limits.personal_keys_max": L("Personal keys per person"),
  "limits.projects_per_person": L("Spaces a person can create"),
  "limits.service_key_multiplier": L("Service key rate limit multiplier"),
  "limits.upload_max_bytes": L("Maximum upload size, bytes"),
  "limits.upload_daily": L("Daily uploads per person: files and MiB"),
  "limits.remember_max_tokens": L("Maximum record length from an agent, tokens"),
  "limits.read_default_tokens": L("Default text returned to an agent, tokens"),
  "limits.read_max_tokens": L("Maximum text per read, tokens"),
  "limits.plan_max_items": L("Maximum records in a bulk changes plan"),
  "limits.preauth": L("Request limits before key validation"),
  "search.domains": L("Topic dictionary (domain tags)"),
  "search.boosts": L("Ranking adjustments"),
  "search.current_space_boost": L("Current space priority"),
  "search.max_per_parent": L("Candidate chunks from one record"),
  "search.snippet_window": L("Snippet window", [{ value: "density", title: "where the query words are densest" }, { value: "first", title: "at the earliest query word (earlier versions)" }]),
  "search.fts_configs": L("Keyword search languages (text search configurations)"),
  "search.org_unreviewed_factor": L("Ranking penalty for unreviewed Company knowledge records"),
  "search.derivation_order_enabled": L("Show retellings immediately after their source in search"),
  "search.derivation_factor": L("Retelling ranking factor (0.1 to 1)"),
  "access.origin_allowlist": L("Allowed sites for browser agents (Origin)"),
  "access.t1_providers": L("Trusted external providers"),
  "access.original_link_ttl_sec": L("Original file link lifetime, seconds"),
  "access.link_signing_key": L("Link signing key"),
  "access.public_base_url": L("Memory address on the company network"),
  "access.cloud_agent_base_url": L("Memory address for cloud agents"),
  "access.org_spaces_auto_create": L("Create department spaces"),
  "access.obo_external_identities": L("Accept on-behalf-of requests from external identities"),
  "access.acl_stale_days": L("Days before access information becomes stale"),
  "access.obo_denial_pause": L("Key pause after repeated on-behalf-of denials"),
  "access.trash_days": L("Trash retention, days"),
  "access.workplace_peers": L("Workspace server"),
  "access.test_sessions": L("Test sessions — tests only"),
  "access.author_rule": L("When search finds a record for its author", [
    { value: "legacy", title: "As before: if the author can read its space" },
    { value: "always", title: "Always, in search and lists" },
  ]),
  "access.personal_upload_default": L("Default for new records in a personal space", [
    { value: "closed", title: "hidden from agents" },
    { value: "open", title: "visible to agents after the secrets check" },
  ]),
  "access.personal_upload_default_choice": L("People choose their own default for new personal records"),
  "access.bulk_open": L("Bulk \"show to agents\" in the workspace"),
  "access.trusted_proxies": L("Trusted proxies"),
  "access.external_hosts": L("External agent hostnames"),
  "access.agent_hosts": L("Agent hostnames"),
  "access.internal_networks": L("Internal company networks"),
  "access.system_key_networks": L("Networks allowed to use the system key"),
  "access.obo_service_keys": L("Issue on-behalf-of service keys"),
  "access.require_department_code": L("Require department codes in the org table"),
  "access.dismissed_personal": L("Personal space of a former colleague", [
    { value: "keep", title: "Keep indefinitely (previously selected policy)" },
    { value: "delete", title: "Delete after the retention period: from the next run, delete personal spaces of everyone whose departure exceeds the limit" },
  ]),
  "access.dismissed_meetings": L("Meetings of a former colleague", [
    { value: "transfer", title: "Transfer to the custodian, who becomes the organizer" },
    { value: "wait", title: "Keep with the former colleague, as in earlier versions; return meetings already transferred" },
  ]),
  "access.dismissed_custody_after_days": L("Days after departure before the custodian receives meetings and access"),
  "access.dismissed_custody_test": L("Custodian access and meeting handover for test accounts — test environment only"),
  "access.dismissed_retention_days": L("Days before deleting a test account’s personal space"),
  "access.dismissed_custody": L("What the custodian can read in a former colleague’s personal space", [
    { value: "all", title: "All records; closed records require confirmation and an audit log event" },
    { value: "open", title: "Open records only; show only the count of closed records" },
    { value: "off", title: "Nothing: keep the personal space, but nobody can read it" },
  ]),
  "access.mass_deactivation_share": L("Confirmation threshold for a full org table import, fraction"),
  "access.space_invite_days": L("Project invitation lifetime, days"),
  "access.test_leftovers_scope": L("Where to delete records from disabled test accounts", [
    { value: "off", title: "Nowhere" },
    { value: "org", title: "In Company knowledge only" },
    { value: "all", title: "In all their spaces" },
  ]),
  "access.test_leftovers_grace_minutes": L("Grace period before deleting test records, minutes"),
  "access.test_purge": L("Permanently delete disabled test data", [
    { value: "off", title: "No" },
    { value: "auto", title: "Yes, hourly" },
  ]),
  "access.test_purge_after_hours": L("Hours before permanently deleting test data"),
  "access.test_purge_max": L("Maximum objects of one type per run"),
  "access.plan_agent_max_items": L("Change plan steps an agent can apply without a person"),
  "access.plan_ttl_minutes": L("Bulk changes plan lifetime, minutes"),
  // an agent's move to a team, a project or the organisation and an agent adding a space member need a person
  "access.promote_confirmation": L("Who confirms an agent's move to a shared space", [
    { value: "human", title: "A person in the workplace" },
    { value: "off", title: "Nobody: the agent moves at once" },
  ]),
  "access.promote_confirmation_ttl_hours": L("How long an agent's move request waits, hours"),
  "access.agent_member_add": L("Who adds members to a space", [
    { value: "workplace", title: "Only the owner in the workplace" },
    { value: "allow", title: "The owner's agent too" },
  ]),
  "access.correct_non_participant": L("Corrections from read-only readers", [
    { value: "proposed", title: "Propose: the author or owner confirms" },
    { value: "deny", title: "Deny" },
  ]),
  "access.org_review_enabled": L("Curator review of Company knowledge"),
  "access.org_review_days": L("Days before unreviewed records return to the queue"),
  "access.org_review_queue_limit": L("Records per Company knowledge review page"),
  "access.org_review_community_teams": L("Departments needed for community confirmation"),
  "access.org_review_digest": L("Weekly email to curators"),
  "access.morning_note": L("Personal morning note by e-mail"),
  "access.profile_enabled": L("Colleague work profiles"),
  "access.profile": L("Work profile limits"),
  "access.space_guide_enabled": L("How we work map"),
  "access.space_guide": L("How we work map limit"),
  // space export
  "access.export_space_enabled": L("Export of a space from the workplace"),
  "access.export_space_role": L("Who may export a team or project space"),
  "limits.export_daily": L("Space exports per person in 24 hours"),
  // marking of instruction-like lines of record text in MCP answers
  "access.instruction_marking": L("Marking of instruction-like lines for agents", [
    { value: "inline", title: "Server line and line prefix" },
    { value: "notice", title: "Server line only" },
    { value: "off", title: "Off" },
  ]),
  // output schemas of the MCP tools in tools/list
  "access.mcp_output_schemas": L("Output schemas of the agent tools", [
    { value: "open", title: "Tolerant of upgrades" },
    { value: "strict", title: "Strict, as in the contract" },
    { value: "none", title: "Not sent" },
  ]),
  // tools listed to agents in tools/list
  "access.mcp_tools_profile": L("Tools listed to agents", [
    { value: "core", title: "Core tools and two dispatchers" },
    { value: "full", title: "Every tool" },
  ]),
  // how much the structured answers of the agent tools carry
  "access.mcp_response_detail": L("Detail of the structured answers to agents", [
    { value: "lean", title: "Lean: without service fields" },
    { value: "full", title: "Full, as REST returns it" },
  ]),
  "onboarding.readme_templates_enabled": L("Space descriptions from templates"),
  "onboarding.space_overview_enabled": L("Space overview"),
  "onboarding.addable_enabled": L("Suggest adding your meetings to a project"),
  "meetings.consent_version": L("Consent text version"),
  "meetings.consent_text": L("Participant consent text"),
  "meetings.upload_ticket_ttl_sec": L("Meeting upload link lifetime, seconds"),
  "meetings.upload_max_mb": L("Maximum transcript size, MB"),
  "meetings.notify_participants": L("Email participants about the meeting"),
  "open_check.enabled": L("Open check for records"),
  "open_check.disabled_rules": L("Disabled rules"),
  "open_check.packs": L("Rule packs"),
  "open_check.extra_rules": L("Custom patterns"),
  "open_check.nda_customers": L("Customers under NDA"),
  "open_check.timeout_sec": L("Check timeout per record, seconds"),
  "open_check.despite_enabled": L("Make available to agents: enabled"),
  "open_check.despite_projects": L("Make available to agents in teams and projects"),
  "open_check.despite_scans_text": L("Scans as text only"),
  "security.mode": L("Security mode", [{ value: "basic", title: "basic — no human signers" }, { value: "advanced", title: "advanced — second signatures and security keys" }]),
  "security.downgrade_delay_hours": L("Delay before returning to basic, hours"),
  "admin.webauthn_aaguids": L("Device-bound security key models (AAGUID)"),
  "open_check.recheck_on_nda_change": L("Recheck open records when the NDA list grows"),
  "open_check.recheck_batch": L("Records per recheck step"),
  "observability.otlp_endpoint": L("Metrics collection address (OTLP)"),
  "observability.log_level": L("Log verbosity"),
  "observability.outcomes": L("Search outcomes"),
  "observability.audit_open_reads": L("Audit of open reads when the log is down", [{ value: "spool", title: "Keep the event in the outbox and serve" }, { value: "strict", title: "Refuse when the event is lost" }]),
  // language of what agents see over MCP: the panel itself stays Russian until its catalog
  "locale.mcp_language": L("MCP tool language for agents", [
    { value: "en", title: "English" },
    { value: "ru", title: "Russian" },
  ]),
  // language and time zone of the installation
  "locale.language": L("Language of the installation", [
    { value: "en", title: "English" },
    { value: "ru", title: "Russian" },
  ]),
  "locale.timezone": L("Time zone of the installation"),
  "locale.legacy_charset": L("Legacy text encoding", ["windows-1250", "windows-1251", "windows-1252", "windows-1253", "windows-1254", "windows-1255",
    "windows-1256", "windows-1257", "windows-1258"].map((value) => ({ value, title: value }))),
  "admin.sso_login_enabled": L("Administrator sign-in through the identity provider"),
  "admin.oidc_client_id": L("Identity provider client for the admin panel"),
  "admin.oidc_client_secret": L("Identity provider client secret for the admin panel"),
  "admin.oidc_redirect_uri": L("Admin panel redirect address"),
  "admin.ad_admin_group": L("AD administrator group (optional)"),
  "admin.oidc_username_form": L("Administrator username format at the identity provider", [{ value: "any", title: "Short username or full UPN" }, { value: "account", title: "Short username only (sAMAccountName)" }, { value: "upn", title: "Full UPN with domain only" }]),
  "admin.networks": L("Networks allowed to open the admin panel"),
  "admin.webauthn_rp_id": L("Admin panel name for security keys (RP ID)"),
  "admin.webauthn_origins": L("Admin panel origins"),
  "admin.webauthn_uv": L("User verification on the security key", [{ value: "required", title: "Required (PIN or fingerprint)" }, { value: "preferred", title: "Preferred" }]),
  "admin.webauthn_required": L("Require a security key to sign in"),
  "admin.webauthn_min_keys": L("Minimum security keys per administrator"),
  "admin.stepup_max_min": L("Maximum age of a touch for signing, minutes"),
  "admin.session_max_min": L("Administrator session lifetime, minutes (maximum 60 in advanced)"),
  "admin.session_idle_min": L("Administrator inactivity timeout, minutes (maximum 15 in advanced)"),
  "admin.tool_sessions": L("Tool sessions"),
  "admin.tool_session_max_min": L("Tool session lifetime, minutes"),
  "admin.second_signature": L("Second signature (set by security mode)", [{ value: "off", title: "Off — ignored in basic" }, { value: "on", title: "On — always in advanced" }]),
  "admin.second_signature_ttl_hours": L("Second signature request lifetime, hours"),
  "admin.system_key_admin": L("System key access to the admin API"),
  "admin.local_login": L("admin@local sign-in", [{ value: "open", title: "Open (as before)" }, { value: "breakglass", title: "Emergency access only" }, { value: "off", title: "Closed" }]),
  "admin.local_totp_required": L("Second factor required for local administrators"),
  "admin.auditor_key_access": L("Auditor access to the audit log with an agent key"),
  "admin.service_keys_by_fingerprint": L("Service keys by fingerprint only"),
  "admin.breakglass_max_hours": L("Emergency access, hours"),
  "admin.bastion_cidrs": L("Bastion addresses"),
  "admin.alert_recipients": L("Alert email recipients"),
  "admin.alert_digest_hour": L("Daily digest hour"),
  "admin.audit_show_personal_titles": L("Personal record titles in the audit log"),
  "admin.search_quality_query_texts": L("Frequent searches with no results"),
  "access.obo_read_consent": L("Reading on behalf of people", [{ value: "legacy", title: "As before — no consent" }, { value: "consent", title: "With the person’s consent only" }, { value: "off", title: "Off for everyone" }]),
  "access.obo_read_consent_days": L("On-behalf-of reading consent lifetime, days"),
  "access.obo_read_alert_people_day": L("Alert: on-behalf-of reads for this many people per day"),
  "observability.audit_ship_mode": L("Forward the audit log externally", [{ value: "off", title: "Off" }, { value: "file", title: "To files (test environment)" }, { value: "syslog_tls", title: "Syslog over TLS" }]),
  "observability.audit_ship_target": L("Audit log forwarding destination"),
  "observability.audit_ship_batch": L("Audit log events per batch"),
  "observability.audit_ship_interval_sec": L("Audit log forwarding interval, seconds"),
  "observability.audit_ship_lag_sec": L("Audit log read delay, seconds"),
  "observability.audit_archive_mode": L("Audit log archive", [{ value: "off", title: "Off: the log keeps every month" }, { value: "export", title: "Export old months, keep them in the log" }, { value: "export_and_drop", title: "Export old months, then remove them from the log" }]),
  "observability.audit_retention_months": L("Months the audit log keeps before the archive"),
  "observability.audit_archive_keep_months": L("Months the archive keeps a month after the log (0 — forever)"),
  "edge.export_enabled": L("Send open records to the edge"),
  "edge.deadman_theta_sec": L("Seconds without contact before the edge stops serving data"),
  "edge.revoke_lag_warn_sec": L("Warn when revocation is delayed beyond, seconds"),
  "edge.revoke_lag_alarm_sec": L("Alert when revocation is delayed beyond, seconds"),
  "edge.reconcile_light_min": L("Edge reconciliation interval, minutes"),
  "edge.reconcile_full_hour": L("Full nightly reconciliation hour"),
  "edge.projection_refresh_sec": L("Full edge permissions refresh interval, seconds"),
  "edge.originals_max_mib": L("Maximum original file size on the edge, MiB"),
  "edge.max_concurrent_per_connection": L("Concurrent requests per connection"),
  "edge.connection_expiry_warn_days": L("Days before connection expiry to warn"),
  "edge.bridge_url": L("Edge bridge address"),
  "edge.ldap_require_ldaps": L("Require LDAPS for external sign-in passwords (reject StartTLS and no encryption; off by default in basic)"),
  "access.https_port": L("Gateway HTTPS port (0 — off)"),
  "edge.quota_mode": L("Daily external quotas", [
    { value: "observe", title: "Observe" },
    { value: "enforce", title: "Enforce" },
  ]),
  "edge.quota_daily": L("Daily quotas per person"),
  "edge.max_new_connections_alert_day": L("Alert: new connections per person per day exceed"),
  "edge.geo_alert_enabled": L("Alert about a connection from a new country or network"),
  "edge.probe_enabled": L("External address probe"),
  "edge.probe_base_url": L("External address to probe"),
  "edge.probe_connect_addr": L("Shared proxy external listener for the probe"),
  "edge.probe_inner_hosts": L("Internal hostnames that must not appear at the external address"),
  "edge.probe_interval_min": L("Probe interval, minutes"),
  "edge.synthetic_login_enabled": L("Synthetic sign-in"),
  "edge.synthetic_login_account": L("Synthetic sign-in account"),
  "edge.synthetic_login_interval_min": L("Synthetic sign-in interval, minutes"),
  "edge.geoip_db_path": L("Country and network database file"),
  "admin.alert_work_hours": L("Working hours for daytime-only alerts"),
  "admin.alert_cooldown_min": L("Delay between repeated alerts, minutes"),
  "edge.login_enabled": L("External sign-in enabled"),
  "edge.login_groups": L("AD groups eligible for External access (empty — nobody)"),
  "edge.deny_groups": L("Groups denied external sign-in"),
  "edge.deny_admin_count": L("Deny accounts with adminCount set"),
  "edge.decoy_guids": L("Decoy accounts"),
  "edge.login_domain": L("Email domain for short usernames"),
  "edge.optin_fresh_login_min": L("Maximum sign-in age for enabling access, minutes"),
  "edge.optin_idle_days": L("Days without external sign-in before access expires"),
  "edge.optin_first_confirm": L("First activation of External access", [
    { value: "office_or_support", title: "From the office or with support confirmation" },
    { value: "none", title: "Without confirmation" },
  ]),
  "edge.office_networks": L("Office networks (excluding VPN)"),
  "edge.ad_lockout_threshold": L("AD lockout threshold (−1 — unknown: passwords are not checked)"),
  "edge.ad_lockout_window_min": L("AD failed password counter window, minutes"),
  "edge.ad_pdc": L("Primary domain controller (PDC emulator): a Sign-in and LDAP controller with the same hostname or IP"),
  "edge.ad_state_max_age_hours": L("Maximum AD information age, hours"),
  "edge.ad_sweep_min": L("Directory sweep interval, minutes"),
  "edge.ad_pso_visible": L("IT confirmed: password policies (PSO) are visible"),
  "edge.badpwd_reserve_min": L("Minimum password attempts reserved for a person"),
  "edge.password_failures_per_window": L("Maximum failed password budget per window"),
  "edge.password_window_min": L("Minimum password budget window, minutes"),
  "edge.password_failures_per_day": L("Failed external sign-ins per account per day"),
  "edge.global_binds_per_min": L("External sign-in password checks per minute"),
  "edge.spray_alert_accounts_10min": L("Alert: failures across different accounts in 10 minutes"),
  "edge.spray_pause_accounts_10min": L("Automatic pause: failures across different accounts in 10 minutes"),
  "edge.spray_auto_pause": L("Automatic pause during password spraying"),
  "edge.login_step_floor_ms": L("Minimum sign-in step response time, ms"),
  "edge.login_check_timeout_sec": L("Password check timeout, seconds"),
  "edge.check_unhealthy_queue": L("Queued checks before sign-in is unhealthy"),
  "edge.login_ip_limits": L("Sign-in page limits by address and username"),
  "edge.nat_cidrs": L("Shared company NAT addresses (higher limits)"),
  "edge.mfa_mode": L("Second factor", [
    { value: "off", title: "Off" },
    { value: "optional", title: "Optional" },
    { value: "required", title: "Required" },
  ]),
  "edge.access_token_min": L("Access token lifetime, minutes"),
  "edge.connection_idle_days": L("Inactivity before disconnecting, days"),
  "edge.connection_max_days": L("Maximum connection lifetime, days"),
  "edge.max_active_connections": L("Connections per person"),
  "edge.login_session_hours": L("Sign-in session with a second factor, hours"),
  "edge.login_session_hours_no_mfa": L("Sign-in session without a second factor, hours"),
  "edge.grant_ttl_min": L("Grant lifetime before code exchange, minutes"),
  "edge.refresh_reuse_grace_sec": L("Refresh retry window, seconds"),
  "edge.refresh_reuse_action": L("Action on refresh token reuse", [
    { value: "revoke_connection", title: "Revoke the connection" },
    { value: "reject_only", title: "Reject and warn only" },
  ]),
  "edge.account_page_enabled": L("My connections page outside the company network"),
  "edge.disabled_clients": L("Disabled applications"),
  "edge.mfa_provider": L("Second factor type", [{ value: "totp", title: "Authenticator application" }]),
  "edge.mfa_required_grace_days": L("Grace period for connections without a required second factor, days"),
  "edge.code_failures_per_window": L("Maximum invalid codes per window"),
  "edge.code_failures_per_day": L("Maximum invalid codes per day"),
  "edge.code_failures_window_min": L("Invalid code window, minutes"),
  "edge.code_lock_min": L("Lockout after invalid codes, minutes"),
  "edge.mfa_fresh_login_min": L("Maximum sign-in age for second factor setup, minutes"),
  "edge.mfa_pending_ttl_min": L("First code timeout during setup, minutes"),
  "edge.mfa_issuer_label": L("Name in the code application"),
  "edge.recovery_low_threshold": L("Remind when recovery codes remaining do not exceed"),
  // [S2-3]
  // [4]
  // [E2]
  // [5]
  // Labels shared with the dedicated sign-in and mail forms.
  "ldap.servers": L("Directory controllers"),
  "ldap.port": L("Port"),
  "ldap.connect_timeout_sec": L("Connection timeout, s"),
  "ldap.timeout_sec": L("Operation timeout, s"),
  "ldap.tls_mode": L("Mode"),
  "ldap.insecure_ack": L("I understand: without encryption, people’s passwords, including external sign-in passwords, travel over the network as plain text"),
  "ldap.ca_cert": L("Directory root certificate (PEM)"),
  "ldap.tls_server_name": L("Certificate host name"),
  "ldap.bind_dn": L("Service account DN"),
  "ldap.bind_password": L("Service account password"),
  "ldap.base_dn": L("Where to find people (base DN)"),
  "ldap.user_filter": L("Person search filter"),
  "ldap.attributes": L("Attribute names"),
  "ldap.login_groups": L("Access groups"),
  "ldap.nested_groups": L("Include nested groups"),
  "ldap.domains": L("Allowed sign-in domains"),
  "ldap.group_sync_minutes": L("Group verification interval, minutes"),
  "ldap.group_stale_hours": L("Membership expires without verification, hours"),
  "ldap.group_max_members": L("Maximum group size"),
  "ldap.project_groups_base": L("Group branch for spaces"),
  "access.session_days": L("Sign-in lifetime, days"),
  "access.session_idle_hours": L("Idle timeout, hours"),
  "access.support_contact": L("Support contact"),
  "ldap.failure_window_minutes": L("Failed sign-in window, minutes"),
  "ldap.max_failures_per_login": L("Per account"),
  "ldap.max_failures_per_ip": L("Per address"),
  "ldap.enabled": L("Company account workspace sign-in is enabled"),
  "oidc.issuer": L("Issuer (issuer)"),
  "oidc.ca_cert": L("Identity provider root certificate (PEM)"),
  "oidc.timeout_sec": L("Timeout, s"),
  "oidc.private_networks": L("Provider private networks"),
  "oidc.client_id": L("Client ID"),
  "oidc.client_secret": L("Client secret"),
  "oidc.redirect_uri": L("Return URL"),
  "oidc.scopes": L("Scopes"),
  "oidc.login_groups": L("Access groups"),
  "oidc.claims": L("Claim names"),
  "oidc.enabled": L("Workspace sign-in through the identity provider is enabled"),
  "smtp.host": L("Mail server"),
  "smtp.port": L("Port"),
  "smtp.security": L("Encryption"),
  "smtp.insecure_ack": L("I understand: without encryption, the login, password and messages travel over the network as plain text"),
  "smtp.ca_cert": L("Server root certificate (PEM)"),
  "smtp.timeout_sec": L("Timeout, s"),
  "smtp.username": L("Login"),
  "smtp.password": L("Password"),
  "smtp.from_address": L("From address"),
  "smtp.from_name": L("From name"),
  "access.workplace_url": L("Workspace URL for links"),
  "smtp.admin_email": L("Administrator notification email"),
  "smtp.max_attempts": L("Attempts per message"),
  "smtp.retry_base_sec": L("Initial retry delay, s"),
  "smtp.keep_days": L("Mail log retention, days"),
  "smtp.enabled": L("Mail sending is enabled"),
};

export const OWN_PAGES: Readonly<Record<string, { href: string; title: string }>> = derived(() => ({
  ldap: { href: "/admin/ldap", title: SETTING_PAGE_TITLES.ldap },
  oidc: { href: "/admin/sso", title: SETTING_PAGE_TITLES.oidc },
  smtp: { href: "/admin/smtp", title: SETTING_PAGE_TITLES.smtp },
  open_check: { href: "/admin/open-check", title: SETTING_PAGE_TITLES.open_check },
}));

function pageFields(): Array<[string, LdapField[]]> { return [["ldap", LDAP_FIELDS], ["oidc", OIDC_FIELDS], ["smtp", SMTP_FIELDS]]; }

export const OWNED_ELSEWHERE: ReadonlyMap<string, { href: string; page: string; label: string }> = new Proxy(
  new Map<string, { href: string; page: string; label: string }>(), {
    get(_target, key) {
      // Build the small routing map in the caller's locale, never in the locale of the first import.
      const map = new Map(pageFields().flatMap(([page, fields]) => fields.filter((f) => fieldCategory(f) !== page)
        .map((f) => [`${fieldCategory(f)}.${f.key}`, {
          href: OWN_PAGES[page]!.href,
          get page() { return OWN_PAGES[page]!.title; },
          get label() { return f.label; },
        }] as const)));
      const value: unknown = Reflect.get(map, key, map);
      return typeof value === "function" ? value.bind(map) : value;
    },
  },
);

const OWN_FIELD_LABELS = derived(() => Object.fromEntries(
  pageFields().flatMap(([, fields]) => fields.map((f) => [`${fieldCategory(f)}.${f.key}`, f.label] as const)),
));

/** Label of a setting: the Russian overlay line first, then the table, then the form field; an unknown key is the key itself. */
export function settingLabel(category: string, key: string): string {
  const path = `${category}.${key}`;
  const label = (currentLocale() === "ru" ? overlayText(SETTING_LABELS_RU[path]?.label) : undefined)
    ?? SETTING_LABELS[path]?.label;
  return label ? SETTING_LABEL_TEXT.text(label) : OWN_FIELD_LABELS[path] ?? key;
}

/** Characters that show nothing: format characters (zero-width space, joiners, soft hyphen, BOM), spaces, and the Hangul
 * fillers and the braille blank, which Unicode counts as a letter or a symbol. */
const INVISIBLE = /[\p{Cf}\p{Z}\sᅟᅠㅤﾠ⠀]/gu;

/** An overlay text without a visible letter or digit (empty, spaces, invisible characters) counts as missing, so the
 * table's text is shown instead of a blank. */
function overlayText(text: unknown): string | undefined {
  return typeof text === "string" && /[\p{L}\p{N}]/u.test(text.replace(INVISIBLE, "")) ? text : undefined;
}

/** Fixed values of a setting for a choice (values and order from the table, titles from the overlay where it has them); null — a plain field. */
export function settingOptions(category: string, key: string): readonly SettingOption[] | null {
  const path = `${category}.${key}`;
  const options = SETTING_LABELS[path]?.options;
  if (!options) return null;
  const titles = currentLocale() === "ru" ? SETTING_LABELS_RU[path]?.options : undefined;
  return options.map((o) => ({ value: o.value, title: SETTING_LABEL_TEXT.text(overlayText(titles?.[o.value]) ?? o.title) }));
}

export const MERGED_TABS: Readonly<Record<string, string>> = { retrieval: "search" };
export const settingsTabOf = (category: string): string => MERGED_TABS[category] ?? category;

export const settingAnchor = (category: string, key: string): string => `set-${category}-${key}`;

export function settingHref(category: string, key: string): string {
  const elsewhere = OWNED_ELSEWHERE.get(`${category}.${key}`);
  if (elsewhere) return elsewhere.href;
  const own = OWN_PAGES[category];
  if (own) return own.href;
  return `/admin/settings?cat=${encodeURIComponent(settingsTabOf(category))}#${settingAnchor(category, key)}`;
}

export interface SettingIndexEntry { label: string; path: string; section: string; href: string }

export function settingsIndex(items: ReadonlyArray<{ category: string; key: string }>, sectionTitle: (category: string) => string): SettingIndexEntry[] {
  return items.map((i) => {
    const elsewhere = OWNED_ELSEWHERE.get(`${i.category}.${i.key}`);
    return { label: settingLabel(i.category, i.key), path: `${i.category}.${i.key}`,
             section: elsewhere?.page ?? OWN_PAGES[i.category]?.title ?? sectionTitle(i.category), href: settingHref(i.category, i.key) };
  });
}

const fold = (s: string): string => s.toLowerCase().replace(/ё/g, "е");
export function searchSettings(index: readonly SettingIndexEntry[], query: string, limit = 12): SettingIndexEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return index.filter((e) => { const hay = fold(`${e.label} ${e.path}`); return words.every((w) => hay.includes(w)); }).slice(0, limit);
}
