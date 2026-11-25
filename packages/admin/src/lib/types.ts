export type HealthStatus = "ok" | "degraded" | "fail_closed";
export interface HealthCheck { ok: boolean; detail?: string }
export interface Health { status: HealthStatus; version?: string; instance?: string; checks: Record<string, HealthCheck> }

export const CATEGORY_ORDER = ["models", "retrieval", "storage", "integrations", "processing", "limits", "search", "access", "oauth", "agent_auth", "meetings", "onboarding", "topics", "approvals", "open_check", "observability", "locale"] as const;
export type Category = string;

export interface SettingItem {
  category: Category;
  key: string;
  value: unknown;
  secret: boolean;
  required: boolean;
  description: string | null;
  isSet: boolean;
}
export interface SettingsResponse { items: SettingItem[]; missing_required: string[] }
export interface SettingsUpdateResponse { updated: number; missing_required: string[] }
export interface ConverterCheck { ok: boolean; url: string; user?: string; roles?: string[]; missing_roles?: string[]; latency_ms?: number; error?: string }

export interface PersonIdentity { system: string; external_id: string; verified?: boolean }
export interface PersonAttrs { department_code?: string; unit_relation?: "head" | "deputy"; identities?: PersonIdentity[]; demo?: boolean; demo_role?: "employee" | "head"; [k: string]: unknown }
export interface Person {
  id: string;
  login: string;
  employee_id?: string | null;
  display_name: string;
  department: string | null;
  manager_login: string | null;
  role: string | null;
  active: boolean;
  personal_space: string | null;
  attrs: PersonAttrs | null;
}
export interface Page<T> { items: T[]; next_cursor: string | null }

export interface AccessSummary { spaces_created: string[]; added: number; removed: number; orphaned_spaces?: string[] }
export interface PeopleRowNote { row?: number; login: string; message: string;
  reason?: "reactivation_confirm" }
export interface CustodyCounts { assigned: number; changed: number; ended: number; waiting: number }
export interface PersonCustody {
  custodian: { login: string; display_name: string | null } | null;
  basis: "manager" | "department_head" | "admin" | "manual"; levels: number; since: string | null; active_from: string | null;
  meetings_moved: number; meetings_waiting: number; busy_passes: number; assigned_by: string | null; reason: string | null; manual_off_rule: boolean;
  closed_opened?: number | null;
  space?: string | null;
  late_manager?: { login: string; display_name: string | null } | null;
}
export interface CustodyPolicyView { personal: "keep" | "delete"; meetings: "transfer" | "wait"; after_days: number;
  retention_days?: number }
export interface DeactivationPreview { will_deactivate: number; active_total: number; sample: Array<{ login: string; display_name: string }>; share?: number; needs_confirmation?: boolean }
export interface PeopleUpsertResponse { created: number; updated: number; deactivated: number; renamed?: number; errors?: PeopleRowNote[]; row_warnings?: PeopleRowNote[]; warnings?: string[]; keys_revoked?: number; org_owner?: { login: string | null; source: string }; access: AccessSummary;
  custody?: CustodyCounts;
  identities_verified_ignored?: number }
export interface OrgUnit { code: string; name: string; parent_code: string | null; active: boolean; space: string | null; heads: string[] | null; members: number; demo?: boolean }
export interface OrgUnitsUpsertResponse { updated: number; access: AccessSummary; warnings?: string[]; org_owner?: { login: string | null; source: string } }

export type MemoryEffect = "none" | "base" | "space_owner" | "space_reader" | "admin" | "audit";
export type ClientKind = "claude_code" | "codex" | "cursor" | "cloud_other" | "script";
export type ClaimedKind = ClientKind | "transport" | "internal";
export type ClaimedSource = "meta" | "initialize" | "user_agent";
export interface ClaimedClient { name: string; version?: string; source: ClaimedSource; ua?: string; rev?: string }
export interface ClientView { name: string; version?: string; source: ClaimedSource; kind: ClaimedKind | null }
export interface ClientMismatchReport {
  checked_keys: number; count: number; warn: number; info: number;
  unknown: Array<{ name: string; kind: "transport" | null; events: number; keys: number }>;
  items: Array<{ key_id: string; key_prefix: string | null; person: string | null; key_client_kind: ClientKind | null; sent: ClaimedClient; sent_kind: ClaimedKind;
                 severity: "warn" | "info"; events: number; last_at: string }>;
}
export type PersonalClassReason = "notebook" | "notebook_off" | "script" | "reads_closed" | "service";
export interface Role { code: string; name: string; description: string | null; origin: string; memory_effect: MemoryEffect; derived: boolean; active: boolean }
export interface Grant {
  id: string;
  login: string;
  display_name?: string;
  person_active?: boolean;
  role_code: string;
  actions: string[];
  scope_kind: string;
  scope_ref: string | null;
  basis_source: string;
  basis_ref: string | null;
  approved_by: string | null;
  valid_from: string;
  valid_to: string | null;
  revoked_at: string | null;
  effective: boolean;
  wide?: boolean;
}
export interface GrantCreateResponse { id: string; memory_effect: MemoryEffect; access: AccessSummary }

export interface Service {
  id: string; name: string; kind: string; obo_allowed: boolean; obo_read?: boolean; allowed_ops: string[]; tier: string; active: boolean; created_at?: string;
  write_space?: string | null;
}
export type ServicePatchResponse = Service & { keys_revoked?: number };
export interface ApiKey {
  id: string;
  key_prefix: string;
  principal_type: "person" | "service" | "system";
  principal: string | null;
  kind: string;
  tier: string;
  client_label: string | null;
  client_kind?: ClientKind | null;
  preview?: boolean;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  net_cidrs?: string[] | null;
  last_used_ip?: string | null;
  paused_until?: string | null;
  service_obo?: boolean | null;
  open_write?: boolean;
}
export interface ClassMove { id: string; record_id: string; status: "pending" | "copying" | "verifying" | "done" | "failed"; error: string | null; from_class: string; to_class: string; requested_at: string; finished_at: string | null;
  via?: string;
  accepted_rules?: string[] | null; confirmation?: "agent_relayed" | "human_workplace" | null;
  text_only?: boolean; accepted_scope?: "solo" | "shared" | null }
export interface KeyIssueResponse { key: ApiKey; secret: string }
export interface KeyIssueResult { key: ApiKey; secret: string | null; registered_by_fingerprint?: boolean }

export interface Space {
  slug: string;
  kind: string;
  name: string;
  description: string | null;
  owner: string | null;
  default_class: "open" | "closed";
  org_unit: string | null;
  members_count: number;
  records_count: number;
  created_at: string;
  archived_at?: string | null;
  created_by?: string | null;
  created_via?: string | null;
  groups_count?: number;
  owner_name?: string | null;
}
export interface SpacesPage extends Page<Space> { totals?: { active: number; archived: number } }

export interface SpaceMember { login: string; display_name: string; role: string; source: string; grant_id: string | null; expires_at: string | null; added_by: string | null;
  groups?: string[];
  added_by_name?: string | null }
export interface SpaceDetail { slug: string; title: string; kind: string; owner: { login: string; display_name: string } | null; archived_at: string | null; records_count: number; members: SpaceMember[];
  archived_by?: string | null;
  default_class?: "open" | "closed"; description?: string | null; org_unit?: string | null; created_by?: string | null; created_via?: string | null; created_at?: string; groups?: SpaceGroup[] }
export interface MySpaceMember { login: string; display_name: string; role: string; source: string; expires_at: string | null;
  groups?: string[];
  department?: string | null; title?: string | null; self?: boolean }
export interface MySpaceReaderMember { display_name: string; department: string | null; role: string; self?: boolean }
export interface MySpaceInvite { login: string; display_name: string | null; department: string | null; role: "member" | "reader"; invited_at: string; expires_at: string }
export type MySpaceMembers =
  | { view?: "owner"; count?: number; members: MySpaceMember[]; invited?: MySpaceInvite[] }
  | { view: "reader"; count: number; members: MySpaceReaderMember[] }
  | { view: "count"; count: number | null; members: never[] };
export interface SpaceCallResult { status: "added" | "already" | "invited"; login: string; role: string; display_name: string | null; expires_at?: string }

export interface MySpace {
  slug: string; path: string; name: string; description: string | null; kind: string; default_class: "open" | "closed";
  role: "owner" | "member" | "reader"; via: string;
  readme?: string | null;
  guide_enabled?: boolean;
  owner: { login: string; display_name: string; active: boolean } | null;
  org_unit: string | null;
  created_at: string;
  archived_at?: string | null;
  archived_by?: { login: string; display_name: string } | null;
  members_count?: number | null;
  counts?: { records: number };
}
export interface SpaceReadmeConfig { enabled: boolean; template: string | null; max_chars: number }
export type GuideSection = "tasks" | "docs" | "sources" | "glossary" | "people" | "rhythm";
export type GuideSections = Partial<Record<GuideSection, string>>;
export interface SpaceGuideProposal {
  id: string; at: string; by_role: CorrectionRole; origin: "human" | "agent"; by: { login: string; display_name: string } | null;
  mine: boolean; stale: boolean; sections: GuideSections; unplaced: string | null; tokens: number;
  can: { apply: boolean; reject: boolean; withdraw: boolean };
}
export interface SpaceGuideVersion {
  id: string; version: number; at: string; current: boolean; by: { login: string; display_name: string } | null;
  changed: GuideSection[]; proposal: "human" | "agent" | null;
}
export interface SpaceGuide {
  space: string; id: string | null; version: number | null; path: string | null; updated_at: string | null; class: "open" | "closed" | null;
  sections: GuideSections; tokens: number; max_tokens: number; can_edit: boolean;
  proposals?: SpaceGuideProposal[]; proposals_more?: boolean; proposals_next?: string | null; history?: SpaceGuideVersion[]; history_more?: boolean;
  proposal?: SpaceGuideProposal | null;
}
export interface SpaceGuideSaved { already_known: boolean; changed: GuideSection[]; guide: SpaceGuide }
export interface SpaceAddableItem { id: string; path: string; title: string; occurred_at: string; class: "open" | "closed"; people: number; in_space: number }
export interface SpaceAddable { items: SpaceAddableItem[]; next_cursor: string | null; days: number }
export type WorkProfileSection = "role" | "focus" | "expertise" | "work_with_me" | "agent";
export type WorkProfilePublicSection = Exclude<WorkProfileSection, "agent">;
export interface MyProfileSection { text: string; updated_at: string; source: "person" | "agent_on_behalf"; stale?: true; extended_write?: true }
export interface PublicProfileSection { text: string; updated_at: string }
export interface MyProfile {
  id: string | null; version: number | null; updated_at: string | null; path: string | null; hidden: boolean;
  sections: Partial<Record<WorkProfileSection, MyProfileSection>>;
  public: WorkProfilePublicSection[];
  public_preview: { sections: Partial<Record<WorkProfilePublicSection, PublicProfileSection>>; updated_at: string | null };
  limits: { max_tokens: number; section_max_tokens: number; focus_fresh_days: number };
}
export interface MyProfileSaved { already_known: boolean; changed: WorkProfileSection[]; profile: MyProfile }
export interface MyProfileHistoryItem { id: string; version: number; at: string; source: "person" | "agent_on_behalf" | null; sections_changed: WorkProfileSection[]; public_changed?: true }
export interface MyProfileHistory { items: MyProfileHistoryItem[]; next_cursor: string | null }
export interface PublicProfile { login: string; id: string; path: string; updated_at: string; sections: Partial<Record<WorkProfilePublicSection, PublicProfileSection>> }
export interface SpaceOverviewRow { id: string; path: string; title: string; occurred_at: string; due?: string; overdue?: boolean }
export interface SpaceOverviewBlock { items: SpaceOverviewRow[]; next_cursor: string | null; omitted?: true }
export interface SpaceOverviewCount { key: string; title: string; count: number; href: string }
export interface SpaceOverviewWeekGroup { count: number; items: SpaceOverviewRow[] }
export interface SpaceOverview {
  decisions: SpaceOverviewBlock; risks: SpaceOverviewBlock; due_this_week: SpaceOverviewBlock;
  directions: SpaceOverviewCount[]; entities: SpaceOverviewCount[];
  week: { meetings: SpaceOverviewWeekGroup; documents: SpaceOverviewWeekGroup; notes: SpaceOverviewWeekGroup };
  generated_at: string;
}
export interface SpaceOverviewPage { block: "decisions" | "risks" | "due_this_week"; items: SpaceOverviewRow[]; next_cursor: string | null; generated_at: string }
export interface MySpacesPage { items: MySpace[]; next_cursor: string | null }
export interface MySpaceCreated { slug: string; path: string; name: string; kind: "project"; default_class: "open" | "closed"; members_added: string[]; members_unknown: string[] }
export interface SpaceGroup {
  id: string; group_dn: string; display_name: string; role: "member" | "reader";
  status: "pending" | "ok" | "missing" | "too_large" | "error";
  members_seen: number | null; members_matched: number | null; synced_at: string | null; missing_since: string | null; last_error: string | null;
  added_by: string | null; created_at: string;
  /** Not verified for ldap.group_stale_hours — its members lost the membership until the directory answers. */
  stale?: boolean;
  /** Until when the membership holds without a new verification; null — no term (expiry 0 or the periodic sync off). */
  valid_until?: string | null;
}
export interface SpaceGroups { ldap_enabled: boolean; items: SpaceGroup[] }
export interface SpaceGroupUnbound { id: string; members_removed: number }
export interface GroupSyncRun {
  at: string; ok: boolean; error_code: string | null; trigger: "timer" | "admin" | "owner" | "bind"; space: string | null;
  groups: number; members_added: number; members_removed: number; missing: number; too_large: number;
}
export interface GroupSyncState {
  last: GroupSyncRun | null; bindings: number;
  problems: Array<{ slug: string; name?: string; group: string; status: "missing" | "too_large" | "error"; since: string | null }>;
}
export interface DirectoryGroupSearch { items: Array<{ dn: string; name: string }>; truncated: boolean }

export interface StageState { stage: string; status: string; attempts: number; last_error: string | null;
  terminal?: boolean;
  retry_at?: string | null; busy_retries?: number; slow_retries?: number; first_busy_at?: string | null }

export interface LlmGateState {
  checked_at: string; floor_required: boolean; stub: boolean;
  slot: { limit: number; in_flight: number; holder: { purpose: string | null; stage: string | null; lane: string | null; since: string | null } | null; dirty_until: string | null };
  timeouts: { timeout_sec: number; after_abort_hold_sec: number };
  holds: Array<{ owner: string; reason: "floor" | "test" | "admin"; note: string | null; until: string; set_at: string }>; paused_until: string | null;
  lease: { owner: string; until: string } | null;
  arbiter: { owner: string; until: string } | null;
  breaker: { open: boolean; reason: null | "busy" | "slow" | "config"; open_until: string | null; busy_streak: number; slow_streak: number; last_success_at: string | null };
  waiting: { due_now_lane: number | null; due_night_lane: number | null; waiting_model: number; now_lane: number; night_lane: number; too_slow: number;
             next_retry_at: string | null; oldest_since: string | null; oldest_now_since: string | null };
  can_call_now: boolean; blocked_by: "hold" | "floor" | "breaker" | "dirty" | "slot_busy" | null; blocked_until: string | null;
  fault_probe?: { active: number; max: number; calls: number };
}
export interface UnprocessedItem { id: string; path: string; type: string; class: "open" | "closed"; owner: string; space: string | null; ingested_at: string; stages: StageState[] }
export interface UnprocessedResponse { counts: Record<string, number>; items: UnprocessedItem[]; next_cursor?: string | null;
  reasons?: Array<{ stage: string; code: string; terminal: boolean; count: number }>; failed_terminal?: number;
  waiting_converter?: WaitingConverterGroup }

export type ConverterWaitKind = "queue" | "at_converter" | "doc_error" | "unavailable" | "config" | "hold" | "ocr_rerun" | "shaky" | "storage" | "other";
export interface WaitingConverterGroup { total: number; oldest_since: string | null; kinds: Array<{ kind: ConverterWaitKind; title: string; count: number; codes: string[] }> }

export interface ConverterState {
  checked_at: string; configured: boolean; missing: string[];
  gate: { state: "closed" | "open" | "half_open"; reason: "unavailable" | "config" | "locked" | null; why: string | null; text: string;
    opened_at: string | null; open_until: string | null; streak: number; last_ok_at: string | null; last_result_at: string | null; health_ok_at: string | null;
    recovering: boolean; new_block: "mismatch" | null; mismatch_code: string | null; stalled_ignore_until: string | null;
    principal_known: boolean; principal_hold: boolean; principal_acked: boolean };
  holds: "new" | "all" | null;
  caps: { fast_lane: boolean; version: string | null; checked_at: string } | null;
  window: { k: number; k_eff: number; block: "hold_new" | "mismatch" | "stalled" | "gate" | null; in_flight: number; suspect: number; stalled: boolean };
  queue: { waiting: number; oldest_since: string | null; by_kind: Array<{ kind: ConverterWaitKind; title: string; count: number }> };
  recent: Array<{ id: string; class: "open" | "closed"; type: string; stage_status: string; terminal: boolean; code: string | null; wait: ConverterWaitKind | null;
    conv_status: string | null; phase: string | null; dc_status: string | null; since: string | null; updated_at: string; reruns: number; new_runs: number }>;
  uploads_30d: { count: number; bytes: number } | null;
  orphan_runs: { count: number; days: number; items: Array<{ at: string; record_id: string | null; run_id: string | null; document_id: string | null; why: string | null }> } | null;
  health: { ok: boolean; level: "ok" | "warn" | "fail"; detail: string };
}

export interface ConverterProbeResponse { ok: boolean; outcome: "ok" | "needs_confirm" | "not_configured" | "unavailable" | "rejected" | "locked" | "failed"; text: string;
  missing_roles?: string[]; principal_changed?: boolean; confirmed?: boolean; woken?: number; latency_ms: number }
export interface ConverterCheckNowResponse { woken: number; kicked: number; left: number }

export interface LookupStageCounts { done: number; total: number; failed: number }
export interface AdminLookup {
  records: Array<{ id: string; path: string; type: string; class: "open" | "closed"; space: string; owner: string; created_at: string | null;
    stages: LookupStageCounts | null }>;
  people: Array<{ login: string; display_name: string; active: boolean }>;
  spaces: Array<{ slug: string; title: string; kind: string; owner: string | null }>;
  keys: Array<{ id: string; prefix: string; kind: string; principal_type: "person" | "service" | "system"; principal: string | null; client_label: string | null; client_kind?: ClientKind | null; expires_at: string | null; revoked_at: string | null }>;
}
export const LOOKUP_LIMIT = 20;

export interface ReportTypeRow { accepted: number; processed: number; failed: number; queued: number }
export interface VerifierStats { input: number; exact: number; fuzzy: number; quote_not_found: number; duplicate: number; over_limit: number; kept: number; suppressed_by_correction?: number; transcripts: number; quote_verified_share: number | null }
export interface WideGrant { id: string; role: string; person: string; scope_kind: string; created_at: string }
export interface OboReport {
  denials: Record<string, number>;
  paused_keys: Array<{ id: string; key_prefix: string; principal: string | null; paused_until: string }>;
  unbound_obo_keys: Array<{ id: string; key_prefix: string; service: string; last_used_ip: string | null; last_used_at: string | null }>;
  extended_unbound?: number;
  obo_read_long_keys?: number;
  admin_person_keys?: number;
}
export const OBO_READ_KEY_MAX_DAYS = 30;
export interface OpenCheckReport {
  refused: number;
  by_kind: Record<string, number>;
  by_via: Record<string, number>;
  items: Array<{ at: string; via: string | null; kinds: string[]; rules: string[]; unchecked?: string; space: string | null; by: string | null; record_ids: string[] }>;
  fallback?: { total: number; by_kind: Record<string, number>; by_via: Record<string, number> };
}
export interface OpenCheckMark {
  result: "passed" | "closed" | "pending"; via?: "remember" | "upload" | "convert" | "nda_recheck"; at?: string; kinds?: string[];
  findings?: Array<{ rule: string; kind: string; reason: string; field: string; at?: number }>; openable?: boolean; text_checked?: boolean; unchecked?: "empty_text" | "partial_text";
  by_word?: boolean;
}
export interface NewSpaceRow { slug: string; name: string; kind: string; default_class: "open" | "closed"; owner: string | null; created_by: string | null; created_via: string | null; created_at: string; members_count: number; groups_count: number }
export interface GroupBindRow { at: string; slug: string; group: string; role: "member" | "reader"; by: string | null; members_matched: number | null }
export interface SpaceMetaFinding { slug: string; kind: string; default_class: "open" | "closed"; findings: Array<{ field: string; rule: string; kind: string }> }
export type LeftoverCount = number | Record<string, number>;
export interface LeftoverKeptSpace { name: string; slug: string; kind: string; reason: string; staff_records: number; staff_members: number }
export interface TestLeftoversState {
  at: string; scope: "off" | "org" | "all"; grace_minutes: number; more: boolean;
  pass?: { retired?: LeftoverCount; trash_expired?: LeftoverCount; archived?: LeftoverCount; orphans?: LeftoverCount };
  total?: { since?: string | null; retired?: LeftoverCount; archived?: LeftoverCount };
  waiting?: Record<string, LeftoverCount>;
  skipped?: Record<string, LeftoverCount>;
  kept?: { count: number; items: LeftoverKeptSpace[] };
  outside_their_spaces?: LeftoverCount;
  attr_test_other_domain?: LeftoverCount;
  attr_test_other_domain_logins?: string[];
  active_test?: { count: number; older_than_24h: number };
  error?: string;
}
export interface TestPurgeState {
  mode: "off" | "auto"; after_hours: number; at: string | null; blocked: string[];
  progress: { plan_sha: string; stage: string; done: number } | null;
  last_auto: { at: string; totals: Record<string, number>; busy: number } | null;
  last_manual: { at: string; plan: string; totals: Record<string, number> } | null;
  backlog: Record<string, number> | null;
  kept: Record<string, number> | null;
  smoke: { overdue: number };
}
export interface ManualTimeReview { since: string; count: number; items: Array<{ id: string; author: string | null; created_at: string }> }
export interface SpaceClassChangeRow { at: string; slug: string | null; name: string | null; from: "open" | "closed"; to: "open" | "closed"; by: string | null }
export interface DismissedReport {
  without_custodian: { count: number; items: Array<{ login: string; display_name: string | null; since: string | null }> };
  manual: { count: number; items: Array<{ login: string; display_name: string | null; custodian: { login: string; display_name: string | null }; reason: string | null; at: string | null }> };
  meetings_stuck: { count: number; items: Array<{ login: string; display_name: string | null; waiting: number; busy_passes: number }> };
  by_operator?: { count: number; items: Array<{ login: string; display_name: string | null; custodian: { login: string; display_name: string | null }; by: string; at: string | null }> };
}
export interface Report { window_hours?: number; generated_at?: string; by_type: Record<string, ReportTypeRow>; processed_share: number | null; verifier: VerifierStats; wide_grants_24h?: { count: number; items: WideGrant[] }; obo?: OboReport; open_check?: OpenCheckReport;
  class_moves?: { failed: number; in_progress: number; by_word?: { agent_relayed: number; human_workplace: number; refused: number; despite?: DespiteReport } };
  new_spaces?: { count: number; open: number; by_via: Record<string, number>; items: NewSpaceRow[] };
  group_binds?: { count: number; items: GroupBindRow[] };
  group_sync?: GroupSyncState;
  spaces_without_owner?: { count: number; items: Array<{ slug: string; name: string; kind: string; owner: string }> };
  dismissed?: DismissedReport;
  department_spaces_without_head?: { count: number; unmanaged?: number; items: Array<{ slug: string; name: string; managers: string[]; former_head: string | null; former_head_active: boolean | null; members: number }> };
  space_meta_findings?: { checked: number; count: number; unchecked?: boolean; items: SpaceMetaFinding[] };
  space_class_changes?: { count: number; unavailable?: boolean; items: SpaceClassChangeRow[] };
  project_tags?: { entities: number; collisions: number; tagged_open: number; tagged_closed: number; at: string } | null;
  client_mismatch?: ClientMismatchReport;
  test_leftovers?: TestLeftoversState | null;
  test_purge?: TestPurgeState;
  extended_open?: ExtendedOpenReport;
  org_review?: OrgReviewReport;
  search_quality?: SearchQualitySummary | null;
  rollout?: RolloutReport | null;
  manual_time_review?: ManualTimeReview | null;
  night_cap?: NightCapReport | null;
  backups?: BackupsReport | null }

export interface BackupsLast {
  at: string; by: "db-dump" | "deploy" | "daily" | "manual"; retention_days: number; copies: number; consistent: number;
  removed: string[]; removed_count: number; freed_bytes: number; kept_count: number;
  unknown_age: string[]; unknown_age_count: number; skipped: string[]; skipped_count: number; skipped_overdue: number;
  marked: string[]; marked_count: number; failed: string[]; failed_count: number;
  newest_consistent_at: string | null; oldest_kept_days: number | null; blocked: "no_fresh_consistent" | "invalid_setting" | null;
  held: boolean; timer: "enabled" | "disabled" | "missing" | "unknown"; stale: boolean;
  traces: Array<{ path: string; days: number | null }>; traces_overdue: boolean;
  unverified_count?: number; waiting?: string[]; waiting_count?: number; waiting_bytes?: number;
  unreadable?: string[]; unreadable_count?: number;
}
export interface BackupsDaily { at: string; ok: boolean; reason: "deploy_busy" | "disk_low" | "dump_failed" | null; encrypted: boolean | null }
export interface BackupsReport { retention_days: number; last: BackupsLast | null; daily: BackupsDaily | null }

export interface NightCapReport { cap: number; last_night: { window_start: string; tokens: number; capped: boolean; capped_at: string | null }; waiting: number }

export interface SearchBuildState { at: string; lag_sec: number; caught_up: boolean; skipped: number; rules_changed_at: string | null }
export interface SearchQualityWeek {
  week_start: string; week_end: string; current: boolean; small: boolean; rules_changed: boolean; corrections_complete: boolean;
  searches?: number; zero_share?: number | null; read1_share?: number | null; read3_share?: number | null; read10_share?: number | null; no_read_share?: number | null;
  reformulated_share?: number | null; wrote_after_share?: number | null; avg_first_read_rank?: number | null; explicit_link_share?: number | null;
  corrected_share?: number | null; outdated_share?: number | null; useful_share?: number | null;
}
export interface SearchQualitySummary { enabled: boolean; min_group: number; last_build: SearchBuildState | null; week: SearchQualityWeek | null; previous: SearchQualityWeek | null;
  pooled?: SearchQualityPooled | null }
export type SearchQualityPooled = Omit<SearchQualityWeek, "week_start" | "week_end" | "current" | "small"> & { from: string; to: string; weeks: number };
export interface SearchSliceRow { value: string; searches: number; zero_share: number | null; read3_share: number | null; no_read_share: number | null }
export type SearchSliceDim = "channel" | "mode" | "key_kind" | "client_kind" | "closed_seen";
export interface SearchQuality {
  enabled: boolean; min_group: number; tz: string; last_build: SearchBuildState | null; weeks: SearchQualityWeek[];
  slices: ({ from: string; to: string; weeks_used: number; stale: boolean } & Record<SearchSliceDim, SearchSliceRow[] | null>) | null;
  empty_queries: { shown: Array<{ text: string; people: number; searches: number }>; hidden_searches: number; texts?: "shown" | "panel_only"; from: string; to: string } | null;
  pooled?: SearchQualityPooled | null;
}
export interface RolloutCount { spaces: number; notes: number; new_week: number }
export interface RolloutReport {
  week_start: string; week_end: string; min_group: number;
  sessions: { small: boolean; total?: number; with_query?: number; found_past_by_query?: number; read_past?: number; found_colleague_notes?: number; overview_found_past?: number } | null;
  open_check: { agent_notes: number; agent_refused: number; agent_saved_closed: number; other_by_via: Record<string, number> } | null;
  notes_by_space: { personal: RolloutCount; small: RolloutCount; items: Array<{ slug: string; name: string; kind: "team" | "project" | "org"; archived: boolean; notes: number; new_week: number }> };
  funnel: { catalog: number; steps: Array<{ step: number; people: number }>; median_days_first_login_to_read: number | null };
}
export interface ExtendedOpenReport {
  written: number; denied: number;
  keys_allowed: Array<{ id: string; key_prefix: string; principal: string | null; expires_at: string | null }>;
  items: Array<{ at: string | null; outcome: "written" | "denied"; attempt: string | null; record_id: string | null; space: string | null; by: string | null }>;
}

export interface OpenCheckRuleView { name: string; kind: string; reason: string; pattern: string; builtin: boolean; active: boolean }
export interface OpenCheckExtraRule { name: string; kind: string; pattern: string; reason: string }
export interface OpenCheckView {
  enabled: boolean;
  rules: OpenCheckRuleView[];
  disabled_rules: string[];
  extra_rules: OpenCheckExtraRule[];
  nda_customers: string[];
  timeout_sec?: number;
  refused_24h: { total: number; by_kind: Record<string, number> };
}
export interface OpenCheckFinding { rule: string; kind: string; reason: string; field: string; at: number }
export interface OpenCheckTestResult { enabled: boolean; findings: OpenCheckFinding[]; timeout?: boolean }

export interface AuditEvent {
  id: string;
  at: string;
  event_type: string;
  actor: string;
  on_behalf_of: string | null;
  tier: string | null;
  class: string | null;
  space: string | null;
  record_ids: string[] | null;
  result_count: number | null;
  has_query_text: boolean;
  client_label: string | null;
  key_id: string | null;
  client_kind?: ClaimedKind | null;
  details: Record<string, unknown> | null;
  actor_id?: string | null; actor_name?: string | null; on_behalf_of_id?: string | null; on_behalf_of_name?: string | null;
  auto?: boolean; service?: boolean; records?: AuditRecordRef[];
}
export interface AuditRecordRef { id: string; type: string | null; class: "open" | "closed" | null; space: string | null; space_name: string | null;
  owner: string | null; owner_name: string | null; created_at: string | null; deleted: boolean; title?: string | null }
export interface AuditPage { items: AuditEvent[]; next_cursor: string | null; people?: Array<{ id: string; login: string; display_name: string; active: boolean }>; hidden_service?: number }
export interface LoginSourceStatus { last_check: { at: string; ok: boolean; failed: string[]; failed_steps: string[] } | null; last_login_at: string | null; logins_24h: number; refusals_24h: number }
export interface LoginStatus { ldap: LoginSourceStatus; oidc: LoginSourceStatus;
  smtp: { last_test: { at: string; via: string | null; ok: boolean | null; code: string | null } | null; last_settings_change: { at: string; by: string | null } | null; last_sent_at: string | null } }

export interface RetryResponse { reset: number; records: number; kicked: number; waiting?: number;
  waiting_converter?: number }

export interface AccessSpace { slug: string; kind: string; name: string; role: string; via: string; default_class: "open" | "closed"; grant_id: string | null; expires_at: string | null
  archived?: true }
export interface AccessGrant { id: string; role_code: string; name: string; memory_effect: MemoryEffect; actions: string[]; scope_kind: string; scope_ref: string | null; basis_source: string; basis_ref: string | null; approved_by: string | null; valid_from: string; valid_to: string | null }
export interface AccessKey { id: string; key_prefix: string; kind: string; tier: string; client_label: string | null; client_kind?: ClientKind | null; basis: string | null; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null }
export interface PersonAccess {
  person: { login: string; display_name: string; department: string | null; role: string | null; active: boolean; demo: boolean; updated_at: string };
  classes_readable: string[];
  closed_via?: Array<{ key_id: string; basis: string | null; expires_at: string | null }>;
  spaces: AccessSpace[];
  owned_spaces?: Array<{ slug: string; name: string; kind: string }>;
  org_units: Array<{ code: string; name: string; relation: string; source: string }>;
  grants: AccessGrant[];
  keys: AccessKey[];
  records: Array<{ space: string | null; type: string; class: string; n: number }>;
  oauth_connections?: number;
  custody?: { of_person: PersonCustody | null; holds: Array<{ login: string; display_name: string | null; since: string | null }>; policy: CustodyPolicyView };
}

export interface Stage { stage: string; status: string; version?: string | null; attempts?: number; last_error?: string | null; updated_at?: string;
  terminal?: boolean }
export interface Queue { lane: "now" | "night"; position?: number | null; eta_sec?: number | null;
  reason?: string | null; retry_at?: string | null }
export interface MeSpace { slug: string; kind: "personal" | "team" | "org" | "project"; name: string; role: "owner" | "member" | "reader"; default_class: "open" | "closed"; counts?: { records: number; unprocessed?: number };
  description?: string | null;
  hidden_closed?: number;
  org_unit?: string;
  guide_path?: string | null }
export interface Me {
  person: { login: string; display_name: string; department?: string | null; role?: string | null; instance: string;
    given_name?: string };
  key: { id?: string; kind: string; tier: string; client_label?: string | null; expires_at?: string | null; on_behalf_of?: string | null;
    client_kind?: ClientKind | null; personal_class?: "open" | "closed"; personal_class_reason?: PersonalClassReason;
    preview?: boolean;
    expires_warning?: string | null;
    open_write_mode?: "allowed" | "denied" | "marked" };
  upload?: { accepted_mime?: string[]; max_bytes?: number; converter_configured?: boolean;
    accepted_formats?: Array<{ ext: string; kind: "pdf" | "word" | "powerpoint" | "excel" | "text" }> };
  spaces: MeSpace[];
  public_base_url?: string | null;
  cloud_agent_base_url?: string | null;
  notebook?: boolean;
  limits: Record<string, { limit: number; remaining: number; window: "minute" | "hour" }>;
  recent_actions: MeRecentAction[];
  archived_spaces?: number;
}
export interface MyAuditEvent { at: string; event_type: string; actor: string; client_label?: string | null; tool?: string | null;
  action?: string | null; record_ids?: string[]; result_count?: number | null; class?: string | null; space?: string | null;
  client?: ClientView | null;
  extended_open?: true;
  widened_by_human?: true;
  auto?: true;
  via?: "workplace" | "agent" | "service" | "system" | "other_person";
  records?: Array<{ id: string; title: string | null; type: string }>;
  refusal?: "changed" | "audience" | "no_write" | "disabled" | "found" | "never_open" | "unchecked" | "consent_needed" | "other";
  reasons?: string[] }
export type MeRecentAction = Omit<MyAuditEvent, "client" | "via" | "records" | "refusal" | "reasons"> & { client?: string };
export interface MyAccess { classes_readable: string[]; key: { kind: string; tier: string }; spaces: Array<{ slug: string; kind: string; role: string; via: string; grant_id: string | null; expires_at: string | null }>; grants: AccessGrant[] }
export interface MyKey { id: string; key_prefix: string; kind: string; tier: string; client_label: string | null;
  client_kind?: ClientKind | null;
  created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; current: boolean;
  basis?: string | null;
  preview?: boolean;
  issued_by?: "self" | "admin";
  open_write?: boolean }
export interface MyKeysPage { items: MyKey[]; next_cursor: string | null }
export interface MySession { id: string; source: string; created_at: string; last_seen_at: string | null; expires_at: string; ip: string | null; user_agent: string | null; current: boolean }
export interface MySessionsPage { items: MySession[] }
export interface MyKeyIssue { key: { id: string; key_prefix: string; kind: string; tier: string; client_label: string | null; client_kind?: ClientKind; expires_at: string | null }; secret: string }
export interface MyKeyKind { id: string; client_kind: "script" }
export interface MyKeyOpenWrite { id: string; open_write: false }

export interface ListEntry { path: string; kind: "folder" | "record"; type?: string | null; title: string; summary_line?: string | null; occurred_at?: string | null; token_count?: number | null; count?: number | null; origin?: string | null; confirmed?: boolean | null;
  id?: string; class?: "open" | "closed"; hidden?: boolean; created_at?: string | null; space?: string | null;
  owner?: string | null;
  archived?: true;
  org_review?: OrgReviewViewName }
export interface ListResult { path: string; readme?: string | null; entries: ListEntry[]; next_cursor: string | null;
  hidden_closed?: number }
export interface Locator { page?: number; page_to?: number; section?: string; anchor?: string; time_from?: number; time_to?: number }
export interface Hit { id: string; path: string; type: string; event_kind?: string | null; title: string; snippet: string; locator?: Locator | null; occurred_at: string; ingested_at: string; space: string; class: "open" | "closed"; origin: string; confirmed: boolean; confidence?: number | null; score?: number; token_count?: number; original_url?: string | null;
  space_archived?: true;
  extended_write?: true;
  org_review?: OrgReviewViewName;
  derivation?: Derivation }
export interface SearchResult { search_id: string; hits: Hit[]; total_estimate: number; applied_filters: Record<string, unknown>; mode: string; notes?: string[] }
export interface RecordCore {
  id: string; path: string; type: string; event_kind?: string | null; title: string; summary_line?: string | null; space: string; class: "open" | "closed"; audience?: string; owner: string;
  source_kind?: string; source_ref?: string | null; parent_id?: string | null; locator?: Locator | null; method?: string; origin: string; confirmed: boolean; confidence?: number | null;
  occurred_at: string; ingested_at: string; domain_tags?: string[]; entities?: Array<{ ref: string; display_name: string; role: string }>; people?: string[]; token_count?: number; version?: number; is_current?: boolean;
  original?: { mime: string; bytes: number; pages: number | null; duration_sec: number | null; url: string | null }; stages?: Stage[];
  access?: { restricted_by_source?: boolean };
  hidden?: boolean;
  conversion?: Conversion | null;
  created_at?: string;
  open_check?: OpenCheckMark;
  open_check_accepted?: OpenAccepted;
  space_archived?: true;
  extended_write?: { op: "remember" | "upload" | "correct"; at: string };
  org_review?: { state: OrgReviewViewName; return_after: string | null };
  correction?: {
    kind: "extraction_error" | "wrong" | "outdated" | "own_note"; by?: string; by_role: "author" | "space_owner" | "participant" | "space_member" | "reader";
    confirmed_by?: string; at: string; origin: "human" | "agent"; quote_checked: boolean | null;
  };
}
export interface OpenAccepted { at: string; confirmation: "agent_relayed" | "human_workplace"; rules: string[]; reasons: string[] }
export interface TocEntry { anchor: string; title: string; level: number; page?: number | null; time_from?: number | null; token_offset?: number }
export interface ReadRange { section?: string; anchor?: string; page_from?: number; page_to?: number; time_from?: number; time_to?: number; offset?: number }
export interface ReadResult { content: string; metadata: RecordCore; toc?: TocEntry[]; truncated: boolean; next_range?: ReadRange | null; derived?: Array<{ id: string; type: string; event_kind?: string | null; title: string }>;
  derivation?: Derivation }
export interface PromoteResult { id: string; path: string; space: string; class: "open" | "closed"; derived_moved: number; placements_left?: number; unchanged?: true; parent_left?: string;
  widened_by_human?: true }
export interface RecordDerivation { kind: "retelling" | "synthesis" | null; declared: number; widened_by_human: boolean }
export interface DerivationSource { id: string; path: string; title: string; occurred_at: string }
export interface Derivation { kind: "retelling" | "synthesis" | "echo"; sources: DerivationSource[]; note: string; basis_changed?: string }
export interface RecordDerivationSources { kind: "retelling" | "synthesis" | "echo" | null; sources: Array<Omit<DerivationSource, "title"> & { title: string | null }>; note: string | null }
export interface ReaderSpace { name: string | null; kind: "personal" | "team" | "org" | "project"; members: number | null }
export interface RecordReaders {
  class: "open" | "closed"; audience: "space" | "people"; home: ReaderSpace;
  people: Array<{ login: string; display_name: string | null; owner?: true }>; people_more: number;
  meeting: boolean; pending: number; placements: ReaderSpace[];
  owner_in_spaces?: boolean;
  agents: "readers" | "none" | "held"; owner_extended?: true;
  copied_from?: { login: string; display_name: string | null; at: string | null } | null;
}

export interface HandoverForm {
  allowed: boolean;
  reason: "not_meeting_decision" | "not_participant" | "not_current" | "no_projects" | null;
  current_id: string | null;
  source: { id: string; title: string | null; event_kind: string | null; occurred_at: string; statement: string | null; due: string | null } | null;
  targets: Array<{ slug: string; name: string; class: "open" | "closed" }>;
  preview: { slug: string; class: "open" | "closed"; wider: boolean; already: Array<{ id: string; at: string }> } | null;
  done: Array<{ id: string; space: string; space_name: string; at: string }>;
}
export interface HandoverResult { id: string; path: string; space: string; class: "open" | "closed"; already_known: boolean; widened_by_human: boolean; linked: number }
export interface WriteResult { id: string; path: string; type: string; space: string; class: "open" | "closed"; origin?: string; stages?: Stage[]; already_known?: boolean; bytes?: number; queue?: Queue; entities_unresolved?: string[];
  open_check?: OpenCheckMark }
export interface Conversion { status: "done" | "pending" | "failed"; error_kind?: string; profile?: string; export_profile?: string; verdict?: string;
  extraction_state?: "ready" | "partial" | "unavailable"; run_id?: string; document_id?: string; export_id?: string; converted_at?: string; certified?: boolean;
  agent_file?: boolean | null; agent_file_why?: string[];
  phase?: "queued" | "uploading" | "at_converter" | "retry_later" | null; since?: string | null; position?: number | null }
export interface StatusResult { id: string; path: string; type: string; class: string; stages: Stage[]; queue: Queue; derived: Array<{ id: string; type: string; event_kind?: string | null; title: string }>;
  conversion?: Conversion | null;
  access?: { restricted_by_source?: boolean };
  title?: string | null; occurred_at?: string;
  open_check?: OpenCheckMark;
  /** Version of a document that has earlier versions (absent for version 1); a converted new version still waiting for the worker. */
  version?: number; version_pending?: "processing" | "failed" }
export interface StatusBatch { items: StatusResult[] }
export interface ProcessNowResult { id: string; stages: Stage[]; queue: Queue; priority_raised: boolean }
/** A converted version waiting for the worker: `processing`, or `failed` with the reason and a text for the author. */
export interface VersionPendingView { state: "processing" | "failed"; reason: string | null; note: string | null }
/** One version of a document (GET /api/v1/records/{id}/versions): newest first; `by` — login of the uploader. */
export interface VersionItem { id: string; version: number; is_current: boolean; ingested_at: string; by: string | null; title: string | null; bytes: number | null; filename: string | null;
  pending?: VersionPendingView }
export interface RecordVersions { items: VersionItem[] }
/** POST /api/v1/ingest/documents with `replaces`: the upload answer with the real version facts. */
export interface VersionUploadResult extends WriteResult { version: number; supersedes_id: string | null; version_pending?: boolean; note?: string | null }

export interface TrashItem {
  id: string; type: string; class: "open" | "closed"; title: string | null;
  space: { slug: string; name: string;
    archived?: boolean;
    kind?: "personal" | "team" | "project" | "org" };
  owner: { login: string; display_name: string | null }; author_is_me: boolean;
  deleted_at: string; purge_after: string | null; deleted_by: { login: string; display_name: string | null } | null;
  held?: "transferred_meeting";
  deleted_by_me: boolean; deleted_by_space_owner: boolean; affected: number;
  restorable?: boolean;
  event_kind?: string | null;
  created_at?: string | null;
  deleted_reason?: "deletion_request" | "automatic" | null;
  kept_days?: number;
  derived?: Record<string, number>;
}
export interface TrashPage { items: TrashItem[]; next_cursor: string | null;
  trash_days?: number }
export interface TrashRestore { id: string; restored: number; type?: string; space?: { slug: string; name: string; kind: string }; closed_on_restore?: true }

export interface AdminUserRow {
  login: string; created_at: string; last_login_at: string | null; disabled: boolean; ready: boolean;
  person: { login: string; display_name: string | null; department: string | null; active: boolean; demo: boolean; directory_linked: boolean } | null;
}

export interface DirectoryHit { display_name: string; login: string; department: string | null; title: string | null; in_memory: boolean }
export interface DirectorySearch { source: "ldap" | "memory"; items: DirectoryHit[]; truncated: boolean; ldap_error?: string }
export type PlanOp = "delete" | "close" | "promote" | "move_space" | "purge" | "correct_bulk" | "open";
export type PlanStatus = "pending" | "applying" | "applied" | "partially_applied" | "expired" | "cancelled";
export interface PlanApplyResult {
  plan_id: string; status: "applied" | "partially_applied" | "applying";
  done: number; skipped: number; excluded: number; remaining: number;
  items: Array<{ id: string; outcome: "done" | "skipped" | "excluded"; reason?: string | null; status?: "applied" | "proposed" | null }>;
  trash_url?: string | null;
}
export interface PlanSummary {
  id: string; op: PlanOp; status: PlanStatus; created_via: "mcp" | "workplace";
  created_at: string; expires_at: string; started_at: string | null; applied_at: string | null;
  totals: { items: number; cascade: number; spaces: number };
  counts: { pending: number; excluded: number; done: number; skipped: number; proposed: number };
  apply_via: "mcp" | "workplace"; apply_reason: string | null; workplace_url: string | null;
  key: { label: string | null; client_kind: string | null } | null;
  result: PlanApplyResult | null;
  target?: { name: string; kind: string } | null;
}
export interface PlanItem {
  id: string; ord: number; title: string | null; type: string | null; space: string | null;
  class: "open" | "closed"; effect: string; status: "pending" | "excluded" | "done" | "skipped";
  reason: string | null; unavailable: boolean;
  correction_status: "applied" | "proposed" | null;
  space_name?: string | null; space_kind?: string | null; event_kind?: string | null;
}
export interface PlansPage { items: PlanSummary[]; next_cursor: string | null; pending: number }
export interface PlanDetail extends PlanSummary { items: PlanItem[]; next_cursor: string | null; open_preview?: PlanOpenPreview }
/** Op open (bulk "show to agents", /): who will be able to read the plan's records, per space — numbers only. */
export interface PlanOpenPreview { spaces: Array<{ slug: string; name: string; kind: string; records: number; readers: { kind: "self" | "list" | "all"; count: number | null } }> }
export interface PlanCompose { plan_id?: string; op: PlanOp; status: "pending" | "empty"; expires_at?: string; workplace_url?: string | null;
                              skipped?: Array<{ reason: string; count: number }> }

export type CorrectionKind = "extraction_error" | "wrong" | "outdated" | "own_note";
export type CorrectionStatus = "planned" | "proposed" | "applied" | "rejected" | "withdrawn" | "superseded" | "cancelled";
export type CorrectionRole = "author" | "space_owner" | "participant" | "space_member" | "reader";
export type CorrectionEffect = "new_version" | "annotation" | "link";
export interface CorrectionFields { title?: string; statement?: string; due?: string | null; actors?: string[] }
export interface EventFields { title: string; statement: string; due: string | null; actors: string[] }
export interface CorrectionView {
  id: string; kind: CorrectionKind; status: CorrectionStatus; origin: "human" | "agent"; via: "mcp" | "workplace" | "plan"; by_role: CorrectionRole; created_at: string;
  by: { login: string; display_name: string } | null;
  target: { id: string; type: string; title: string | null; space: string; event_kind?: string | null };
  text: string | null; fields: CorrectionFields | null; quote: string | null; quote_checked: boolean;
  newer: { id: string; title: string | null } | null; result_id: string | null;
  link_status: "proposed" | "active" | "confirmed" | "rejected" | "orphaned" | null; decided_at: string | null;
  decided_by_role?: CorrectionRole | null;
  can: { confirm: boolean; reject: boolean; withdraw: boolean };
  effect: CorrectionEffect;
  space_guide?: true;
}
export interface CorrectionPage { items: CorrectionView[]; next_cursor: string | null }
export interface CorrectionKindOption { kind: CorrectionKind; mode: "apply" | "propose"; closed_result: boolean }
export interface RecordCorrections {
  items: CorrectionView[]; can_apply_directly: boolean; role: CorrectionRole;
  kinds: CorrectionKindOption[];
  current_state: "current" | "visible" | "hidden" | "none";
  current: { id: string; title: string | null } | null;
  fragment: { meeting_id: string; time_from: number; time_to: number } | null;
  event_fields: EventFields | null;
}
export interface CorrectionsSummary { to_confirm: number }
export interface MyNavSummary {
  meetings: { new: number; asked: number };
  plans_pending: number;
  corrections_to_confirm: number;
  org_review_waiting: number | null;
  expiring_keys: Array<{ id: string; client_label: string | null; key_prefix: string; expires_at: string }>;
  oauth_expiring: boolean;
  oauth_enabled: boolean;
  custody?: number;
  incomplete?: Array<"meetings" | "plans_pending" | "corrections_to_confirm" | "org_review_waiting" | "expiring_keys" | "oauth_expiring" | "custody">;
  profile_enabled?: true;
  profile_focus_stale?: string;
}
export interface CorrectResult {
  correction_id: string; id: string; kind: CorrectionKind; status: "applied" | "proposed"; effect: CorrectionEffect;
  result_id: string | null; result_path: string | null; quote_checked: boolean; already_known: boolean; by_role: CorrectionRole; workplace_url: string | null;
}

export type OrgReviewViewName = "unreviewed" | "confirmed" | "community" | "disputed";
export type OrgReviewState = "unreviewed" | "confirmed" | "community" | "exempt" | "returned" | "deleted" | "left" | "superseded";
export type OrgWrongReason = "wrong" | "not_for_all";
export interface OrgWrongMark { login: string; name: string; reason: OrgWrongReason | string; at: string }
export interface OrgReviewSummary { curator: boolean; waiting?: number; held?: number }
export interface OrgReviewItem {
  id: string; type: string; class: "open" | "closed"; title: string | null; author: { login: string; name: string; active: boolean };
  event_kind?: string | null;
  state: OrgReviewState; view: string | null; held: boolean; disputed: boolean; entered_at: string; return_after: string | null; overdue: boolean;
  useful: number; wrong: number; wrong_marks: OrgWrongMark[]; extended: boolean; returns: number; cycle: number;
  from: { slug: string; name: string; kind: string } | { hidden: true; kind: string } | null;
  no_target: boolean;
  restricted?: true;
}
export interface OrgReviewQueue { items: OrgReviewItem[]; total: number; held: number; oldest_entered_at: string | null; limit: number; next_cursor: string | null }
export interface RecordOrgReview {
  record_id: string; in_org: boolean; on_review: boolean; unit_id: string | null;
  state: OrgReviewState | null; view: OrgReviewViewName | null; held: boolean; disputed: boolean;
  entered_at: string | null; return_after: string | null; cycle: number | null; returns: number;
  exempt: string | null; extended: boolean; author: boolean; curator: boolean;
  returns_to: string | null;
  marks: { useful: number; useful_teams: number; wrong: number; mine: { useful: boolean; wrong: OrgWrongReason | null } };
  wrong_marks?: OrgWrongMark[];
  can: { useful: boolean; wrong: boolean; confirm: boolean; return: boolean; delete: boolean };
}
export interface OrgReviewDecision { id: string; state: OrgReviewState; message: string; space?: string | null; deleted?: boolean; author_dismissed?: boolean }
export interface OrgReviewAdmin {
  enabled: boolean; org: string | null; mail_enabled: boolean; waiting: number; new_week: number; held: number; due_week: number; oldest_entered_at: string | null;
  curators: Array<{ login: string; display_name: string | null; test: boolean }>;
  settings: { days: number; queue_limit: number; community_teams: number; unreviewed_factor: number; digest: { enabled: boolean; weekday: number; time: string; tz: string } };
  last_run: Record<string, unknown> | null;
}
export interface OrgReviewReport {
  enabled: boolean; org: string | null; waiting: number; new_week: number; held: number; due_week: number; oldest_entered_at: string | null;
  returned: { count: number; auto: number; curator: number; author: number; narrowed?: number }; confirmed: number; community: number; deleted: number; digests: number;
  curators: { count: number; logins: string[] };
  wrong_marks: { count: number; items: Array<{ at: string | null; record_id: string; by: string | null; reason: string | null }> };
  last_run: Record<string, unknown> | null;
}

export type OpenPreviewState = "clean" | "show_anyway" | "never" | "not_allowed" | "unchecked" | "open" | "in_progress";
export interface OpenPreviewFinding { rule: string; kind: string; reason: string; count: number; more: boolean; in_record: number; in_extracted: number }
export interface OpenPreview {
  state: OpenPreviewState;
  /** not_allowed: org_space, org_placement, other_spaces, meeting, archived, no_write, disabled, projects_disabled; never: never_rule,
   *  sensitive_pii, empty_text, too_large, scans_disabled; unchecked: conversion_pending, busy, check_failed. */
  reason?: string; scope?: "solo" | "shared"; space?: { slug: string; name: string; kind: string };
  findings?: OpenPreviewFinding[]; never?: Array<{ rule: string; kind: string; reason: string }>;
  audience?: { total: number; spaces: Array<{ slug: string; name: string; kind: string }>; other_spaces: number; people: number };
  tree?: { extracted: number; marks: number }; text_only?: boolean; consent?: string; expires_at?: string;
}
export interface DespiteReport {
  solo: number; personal_shared: number; team: number; project: number; text_only: number;
  refused: Record<"changed" | "audience" | "no_write" | "disabled" | "found" | "never_open" | "other", number>;
  recent: Array<{ record_id: string; space_slug: string | null; space_kind: string | null; author_login: string | null; at: string | null; rules: string[]; text_only: boolean; scope: string | null }>;
}
export interface DespiteShown { record_id: string; space_slug: string | null; space_kind: string | null; author_login: string | null; shown_at: string | null; rules: string[]; text_only: boolean }
export interface DespiteShownList { items: DespiteShown[]; next_cursor: string | null; total: number | null; in_trash?: number; showing?: number }
export interface DespiteHideResult { queued: number; busy: string[]; left: number }
export interface ShowAnywayToggles { enabled: boolean; projects: boolean; scans_text: boolean }

export type CustodyBasis = "manager" | "department_head" | "admin" | "manual";
export interface CustodyPeople {
  items: Array<{ slug: string; person: { login: string; display_name: string | null }; since: string; basis: CustodyBasis; levels: number;
                 records: { open: number; closed: number; deleted: number } }>;
  read?: "all" | "open";
}
export interface CustodyRecordItem { id: string; title: string | null; type: string; event_kind?: string | null; class: "open" | "closed"; occurred_at: string; ingested_at: string;
  deleted_at: string | null; copyable: boolean }
export interface CustodyRecords {
  person: { login: string; display_name: string | null }; since: string; basis: CustodyBasis; read: "all" | "open";
  items: CustodyRecordItem[]; closed_hidden: number; next_cursor: string | null;
}
export interface CustodyDerived { id: string; title: string | null; type: string }
export interface CustodyRecordView {
  id: string; title: string | null; type: string; event_kind?: string | null; class: "open" | "closed"; occurred_at: string; deleted_at: string | null;
  text: string | null; confirm_required: boolean; original: boolean; original_url: string | null; derived: CustodyDerived[]; copyable: boolean;
  truncated?: boolean;
  person: { login: string; display_name: string | null };
  transcript_id?: string | null;
}
export interface CustodyReadResult {
  id: string; title: string | null; text: string; original_url: string | null; derived: CustodyDerived[]; transcript_id?: string | null;
  truncated?: boolean;
}
/** POST …/copy. */
export interface CustodyCopyResult { id: string; path: string; title: string | null; already_known: boolean }
