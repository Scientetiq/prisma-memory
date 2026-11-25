import {
  CATEGORY_TITLES, CATEGORY_HINTS, CHECK_TITLES, EFFECT_TITLES,
  EFFECT_HINTS, ORIGIN_TITLES, SCOPE_TITLES, SCOPE_REF_HINTS,
  BASIS_TITLES, PROVENANCE_TITLES, SERVICE_KIND_TITLES, CLIENT_KIND_TITLES, LABELS_TEXT,
  CLAIMED_SOURCE_TITLES, CLIENT_MISMATCH_TITLES, CLIENT_KIND_PANEL_HINTS, PERSONAL_CLASS_REASON_TITLES,
  KEY_KIND_TITLES, SESSION_SOURCE_TITLES, SPACE_KIND_TITLES, CREATED_VIA_TITLES,
  GROUP_STATUS_TITLES, CLASS_TITLES, AUDIT_EVENT_TITLES, RECORD_TYPE_TITLES,
  SPACE_ROLE_TITLES, SPACE_ROLE_YOU, SPACE_ROLE_HINTS, VIA_TITLES,
  EVENT_KIND_TITLES, ORIGIN_RECORD_TITLES, SOURCE_KIND_TITLES, SEARCH_MODE_TITLES,
  SEARCH_MODE_HINTS, CONVERSION_STATUS_TITLES, CONVERSION_ERROR_TITLES, AGENT_FILE_WHY_TEXT,
  QUEUE_LANE_TITLES, QUEUE_LANE_HINTS, KEY_STATUS_TITLES, SOURCE_TITLES,
  RELATION_TITLES, SPACE_STATUS_TITLES, PEOPLE_STATUS_TITLES, LEFTOVERS_SCOPE_TITLES,
  LEFTOVERS_SKIPPED_TITLES, LEFTOVERS_KEPT_TITLES, TEST_PURGE_MODE_TITLES, TEST_PURGE_STOP_TITLES,
  TEST_PURGE_BACKLOG_TITLES, LEFTOVERS_KIND_TITLES, OBO_DENIAL_TITLES, OPEN_CHECK_KIND_TITLES,
  MOVE_VIA_TITLES, MOVE_CONFIRMATION_TITLES, OPEN_CHECK_FIELD_TITLES,
  OPEN_CHECK_UNCHECKED_TITLES, OPEN_REFUSED_TITLES, ROLE_TITLES, KEY_OPEN_WRITE_TITLES,
  EXTENDED_ATTEMPT_TITLES, ENTITY_ROLE_TITLES, SEARCH_SLICE_TITLES, ROLLOUT_STEP_TITLES,
  CLAIMED_KIND_TITLES as CLAIMED_KIND_TITLES_MESSAGES, MY_AUDIT_TITLES as MY_AUDIT_TITLES_MESSAGES, AUDIT_ACTION_TITLES as AUDIT_ACTION_TITLES_MESSAGES, SEARCH_SLICE_DIMS as SEARCH_SLICE_DIMS_MESSAGES,
  OPEN_CHECK_VIA_TITLES as OPEN_CHECK_VIA_MESSAGES
} from "../messages/labels";
export {
  CATEGORY_TITLES, CATEGORY_HINTS, CHECK_TITLES, EFFECT_TITLES,
  EFFECT_HINTS, ORIGIN_TITLES, SCOPE_TITLES, SCOPE_REF_HINTS,
  BASIS_TITLES, PROVENANCE_TITLES, SERVICE_KIND_TITLES, CLIENT_KIND_TITLES, LABELS_TEXT,
  CLAIMED_SOURCE_TITLES, CLIENT_MISMATCH_TITLES, CLIENT_KIND_PANEL_HINTS, PERSONAL_CLASS_REASON_TITLES,
  KEY_KIND_TITLES, SESSION_SOURCE_TITLES, SPACE_KIND_TITLES, CREATED_VIA_TITLES,
  GROUP_STATUS_TITLES, CLASS_TITLES, AUDIT_EVENT_TITLES, RECORD_TYPE_TITLES,
  SPACE_ROLE_TITLES, SPACE_ROLE_YOU, SPACE_ROLE_HINTS, VIA_TITLES,
  EVENT_KIND_TITLES, ORIGIN_RECORD_TITLES, SOURCE_KIND_TITLES, SEARCH_MODE_TITLES,
  SEARCH_MODE_HINTS, CONVERSION_STATUS_TITLES, CONVERSION_ERROR_TITLES, QUEUE_LANE_TITLES,
  QUEUE_LANE_HINTS, KEY_STATUS_TITLES, SOURCE_TITLES, RELATION_TITLES,
  SPACE_STATUS_TITLES, PEOPLE_STATUS_TITLES, LEFTOVERS_SCOPE_TITLES, LEFTOVERS_SKIPPED_TITLES,
  LEFTOVERS_KEPT_TITLES, TEST_PURGE_MODE_TITLES, TEST_PURGE_STOP_TITLES, TEST_PURGE_BACKLOG_TITLES,
  LEFTOVERS_KIND_TITLES, OBO_DENIAL_TITLES, OPEN_CHECK_KIND_TITLES, MOVE_VIA_TITLES,
  MOVE_CONFIRMATION_TITLES, OPEN_CHECK_FIELD_TITLES, OPEN_CHECK_UNCHECKED_TITLES,
  OPEN_REFUSED_TITLES, ROLE_TITLES, KEY_OPEN_WRITE_TITLES, EXTENDED_ATTEMPT_TITLES,
  ENTITY_ROLE_TITLES, SEARCH_SLICE_TITLES, ROLLOUT_STEP_TITLES
};
import { derived, derivedList } from "../i18n/runtime";

/** A stored approver (grant) or key basis: the gateway's own codes get a label, a value an administrator typed is shown as is. */
export function provenanceTitle(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t: unknown = (PROVENANCE_TITLES as Record<string, unknown>)[v];
  return typeof t === "string" ? t : v;
}
import { mimePlain } from "./mime-plain";
import type { ClaimedKind, ClaimedSource, ClientKind, Conversion, LeftoverCount, MemoryEffect, Person, PersonalClassReason } from "./types";
import { VERSIONS_TEXT } from "./versions.messages";

export const MIN_ADMIN_PASSWORD = 12;

export const EFFECT_ORDER: MemoryEffect[] = ["base", "space_owner", "space_reader", "admin", "audit", "none"];

export const SCOPE_KINDS = ["own", "org_unit", "org_branch", "company", "space", "objects", "catalog"] as const;

export const SCOPE_NEEDS_REF: ReadonlySet<string> = new Set(["org_unit", "org_branch", "space", "objects"]);


export const BASIS_SOURCES = ["request", "manual", "org_table", "directory", "bitrix", "sap"] as const;


export const GRANT_ACTIONS = ["view", "download", "edit", "run_tool", "moderate", "manage_rights", "share", "delete", "approve", "upload", "review", "reveal", "export", "apply_changes", "other"] as const;

export const SERVICE_KINDS = ["transcriber", "chat", "meeting_assistant", "converter", "audio_agent", "pipeline", "other"] as const;

export const SERVICE_OPS = ["search", "read", "list", "me", "remember", "upload", "process_now", "ingest_transcripts", "ingest_documents", "status", "original", "directory", "correct", "llm_gate"] as const;
export const TIERS = ["T0", "T1"] as const;
export const TRANSCRIBER_OPS = ["ingest_transcripts", "status", "directory"] as const;

export const KEY_KINDS = ["personal", "service", "extended"] as const;
export const PERSON_KEY_MAX_DAYS = 90;
export const KEY_EXPIRY_WARN_DAYS = 14;
export const PERSONAL_KEY_DEFAULT_DAYS = 90;
export const EXTENDED_KEY_DEFAULT_DAYS = 30;
export const EXTENDED_KEY_MAX_DAYS = PERSON_KEY_MAX_DAYS;
export const CLIENT_KINDS = ["claude_code", "codex", "cursor", "cloud_other", "script"] as const satisfies readonly ClientKind[];

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */

export const isClientKind = (v: unknown): v is ClientKind => typeof v === "string" && (CLIENT_KINDS as readonly string[]).includes(v);
export const clientKindTitle = (v: string | null | undefined): string => (isClientKind(v) ? CLIENT_KIND_TITLES[v] : v ? v : LABELS_TEXT.clientKindNone);
export const CLAIMED_KIND_TITLES: Record<ClaimedKind, string> = derived(() => ({ ...CLIENT_KIND_TITLES, ...CLAIMED_KIND_TITLES_MESSAGES }));


export const claimedTitle = (c: { name: string; version?: string; kind?: ClaimedKind | null }): string => {
  const sent = c.version ? `${c.name} ${c.version}` : c.name;
  return c.kind && c.kind !== "transport" ? `${CLAIMED_KIND_TITLES[c.kind]} · ${sent}` : sent;
};

export { STAGE_STATUS_TITLES, STAGE_TITLES } from "./stages";

export const AUDIT_EVENT_TYPES = ["read", "search", "list", "write", "promote", "open", "forget", "extended_key_use", "t1_fallback", "confirmation", "admin", "processing", "auth_failure", "rate_limited", "class_move", "purge", "directory", "external"] as const;






export const conversionLine = (c: Partial<Conversion> | null | undefined, withheld = false): string | null => {
  if (!c?.status) return null;
  const head = CONVERSION_STATUS_TITLES[c.status] ?? c.status;
  const why = c.error_kind === "open_check" && c.extraction_state === "partial" ? LABELS_TEXT.conversionOpenPartial
    : c.error_kind ? CONVERSION_ERROR_TITLES[c.error_kind] ?? c.error_kind
    : c.status === "done" && c.extraction_state === "unavailable" ? LABELS_TEXT.conversionTextNotFound
    : c.status === "done" && c.extraction_state === "partial" ? (withheld ? LABELS_TEXT.conversionOpenPartialKept : LABELS_TEXT.conversionTextPartial) : "";
  return LABELS_TEXT.conversionLine(head, why);
};
export const conversionFailedWhy = (c: Partial<Conversion> | null | undefined): string | null => {
  const why = conversionFailedReason(c);
  return why ? LABELS_TEXT.failedWhy(why) : null;
};
export const conversionFailedReason = (c: Partial<Conversion> | null | undefined): string | null => {
  if (c?.status !== "failed" || !c.error_kind) return null;
  return (c.error_kind === "open_check" && c.extraction_state === "partial" ? LABELS_TEXT.conversionOpenPartial : CONVERSION_ERROR_TITLES[c.error_kind]) ?? null;
};

export const originalWithheld = (cls: string | null | undefined, c: Partial<Conversion> | null | undefined): string | null => {
  if (cls !== "open" || c?.status !== "done") return null;
  return c.extraction_state === "partial" ? LABELS_TEXT.originalPartial
    : c.extraction_state === "unavailable" ? LABELS_TEXT.originalUnavailable
    : null;
};

const AGENT_FILE_WHY_ORDER = ["office", "images", "pictures_skipped", "pdf_hidden_parts", "active_content", "table_truncated", "other_format"];
export const agentFileLine = (cls: string | null | undefined, c: Partial<Conversion> | null | undefined): string | null => {
  if (cls !== "open" || c?.status !== "done" || c.agent_file !== false) return null;
  if (c.extraction_state === "partial" || c.extraction_state === "unavailable") return null;
  const codes = (c.agent_file_why ?? []).filter((w) => w !== "ocr" && w !== "no_text");
  const known = AGENT_FILE_WHY_ORDER.filter((w) => codes.includes(w)).map((w) => AGENT_FILE_WHY_TEXT[w]!);
  const reasons = [...new Set(known)];
  return LABELS_TEXT.agentFileLine(reasons);
};

export const mimeTitle = (m: string): string => mimePlain(m);


export const queueLine = (lane?: string | null, etaSec?: number | null): string =>
  LABELS_TEXT.queueLine(lane ? QUEUE_LANE_TITLES[lane] ?? lane : null, lane ? QUEUE_LANE_HINTS[lane] ?? "" : "",
    typeof etaSec === "number" && etaSec > 0 ? Math.ceil(etaSec / 60) : null);

export const RECORD_TYPES = ["document", "transcript", "event", "summary", "profile", "note"] as const;
export const EVENT_KINDS = ["decision", "action", "question_risk", "fact"] as const;
export const MY_AUDIT_TITLES: Record<string, string> = derived(() => ({ ...AUDIT_EVENT_TITLES, ...MY_AUDIT_TITLES_MESSAGES }));

export interface DeactivationPolicy { personal: "keep" | "delete"; meetings: "transfer" | "wait"; after_days: number }
const DEACTIVATION_POLICY_DEFAULT: DeactivationPolicy = { personal: "keep", meetings: "transfer", after_days: 7 };

export function deactivationEffects(policy?: Partial<DeactivationPolicy> | null): string {
  return LABELS_TEXT.deactivationEffects({ ...DEACTIVATION_POLICY_DEFAULT, ...(policy ?? {}) });
}

export function isTestLogin(login: string): boolean {
  const domain = (login.split("@")[1] ?? "").toLowerCase();
  return domain === "corp.test" || domain === "test" || domain.endsWith(".test");
}
export const isTestPerson = (p: Pick<Person, "login" | "attrs">): boolean => p.attrs?.demo !== true && (p.attrs?.test === true || isTestLogin(p.login));

export type SpaceStatus = keyof typeof SPACE_STATUS_TITLES;

export type PeopleStatus = keyof typeof PEOPLE_STATUS_TITLES;


export const testPurgeTotal = (totals: Record<string, number> | null | undefined): number =>
  totals ? Object.values(totals).reduce((a, n) => a + (typeof n === "number" ? n : 0), 0) : 0;

export const leftoverCount = (v: LeftoverCount | null | undefined): number =>
  typeof v === "number" ? v : v ? Object.values(v).reduce((a, n) => a + (typeof n === "number" ? n : 0), 0) : 0;
export const leftoverKinds = (v: LeftoverCount | null | undefined): Array<[string, number]> =>
  v && typeof v === "object" ? Object.entries(v).filter(([, n]) => typeof n === "number" && n > 0).map(([k, n]) => [LEFTOVERS_KIND_TITLES[k] ?? SPACE_KIND_TITLES[k] ?? k, n]) : [];
export function graceTitle(minutes: number): string { return LABELS_TEXT.graceTitle(minutes); }


export const OPEN_CHECK_EXTRA_KINDS = ["secret", "pii", "money", "contract", "custom"] as const;

// The contract validator reads the declared code keys here. Request-time getters supply all display text.
export const OPEN_CHECK_VIA_TITLES: Record<string, string> = {
  remember: "",
  upload: "",
  promote: "",
  open: "",
  convert: "",
  move: "",
  derive: "",
  space: "",
  open_word: "",
  link: "",
  correct: "",
  handover: "",
  nda_recheck: "",
};
for (const code of Object.keys(OPEN_CHECK_VIA_TITLES)) {
  Object.defineProperty(OPEN_CHECK_VIA_TITLES, code, { enumerable: true, get: () => OPEN_CHECK_VIA_MESSAGES[code] });
}



export const AUDIT_ACTION_TITLES: Record<string, string> = derived(() => ({ ...AUDIT_ACTION_TITLES_MESSAGES, ...OBO_DENIAL_TITLES }));



export function parseCidrs(raw: string): string[] {
  return raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).map((x) => (x.includes("/") ? x : `${x}/${x.includes(":") ? 128 : 32}`));
}


export function searchSliceTitle(dim: "channel" | "mode" | "key_kind" | "client_kind" | "closed_seen", value: string): string {
  if (value === "other") return LABELS_TEXT.searchSliceOther;
  if (dim === "client_kind") return value === "none" ? LABELS_TEXT.clientKindNone : clientKindTitle(value);
  if (dim === "mode") return SEARCH_MODE_TITLES[value] ?? LABELS_TEXT.unknown;
  return SEARCH_SLICE_TITLES[dim][value] ?? LABELS_TEXT.unknown;
}
export const SEARCH_SLICE_DIMS: ReadonlyArray<{ dim: "channel" | "mode" | "key_kind" | "client_kind" | "closed_seen"; title: string }> = derivedList(() => [
  { dim: "channel", title: SEARCH_SLICE_DIMS_MESSAGES[0].title }, { dim: "mode", title: SEARCH_SLICE_DIMS_MESSAGES[1].title }, { dim: "key_kind", title: SEARCH_SLICE_DIMS_MESSAGES[2].title },
  { dim: "client_kind", title: SEARCH_SLICE_DIMS_MESSAGES[3].title }, { dim: "closed_seen", title: SEARCH_SLICE_DIMS_MESSAGES[4].title },
]);


// Compare known converter reasons by code; do not search localized prose for action words.
const CONVERSION_ADVICE_CODES = ["converter_auth", "converter_no_text", "converter_http", "converter_network",
  "converter_fail_retryable", "converter_cancelled", "converter_stuck", "converter_deadline", "converter_result_missing",
  "converter_copies_limit", "converter_doc_error", "converter_encrypted", "converter_malformed", "converter_unexpected",
  "converter_patience", "converter_assurance_conflict", "original_changed", "original_missing", "open_check"];
export function conversionHasAdvice(why: string): boolean {
  return CONVERSION_ADVICE_CODES.some((error_kind) => why === conversionFailedWhy({ status: "failed", error_kind }))
    || why === conversionFailedWhy({ status: "failed", error_kind: "open_check", extraction_state: "partial" });
}
