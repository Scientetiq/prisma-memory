import { text as M } from "../messages/show-anyway";
import { derivedList } from "../i18n/runtime";
import type { ClassMove, DespiteReport, OpenPreview, OpenPreviewFinding, SettingItem, ShowAnywayToggles } from "./types";

export const STALE_REASONS = ["changed", "more_found", "audience", "expired", "consent_required", "consent_invalid"] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

export const showAnywayHref = (id: string, stale?: StaleReason | null): string =>
  `/records/${encodeURIComponent(id)}?show=anyway${stale ? `&stale=${stale}` : ""}#access`;

export const staleParam = (raw: string | null | undefined): StaleReason | null =>
  (STALE_REASONS as readonly string[]).includes(raw ?? "") ? (raw as StaleReason) : null;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function despiteStale(f: { code: string; details?: unknown }): StaleReason | null {
  const d = obj(f.details);
  if (f.code === "open_check") {
    const s = obj(d?.open_check)?.stale;
    return typeof s === "string" && (["changed", "more_found", "audience", "expired"] as const).includes(s as never) ? (s as StaleReason) : null;
  }
  if (f.code === "invalid_argument" && (d?.reason === "consent_required" || d?.reason === "consent_invalid")) return d.reason as StaleReason;
  return null;
}

export function openCheckFound(f: { code: string; details?: unknown }): boolean {
  if (f.code !== "open_check") return false;
  const unchecked = obj(obj(f.details)?.open_check)?.unchecked;
  return !(typeof unchecked === "string" && unchecked) || unchecked === "partial_text";
}

export const openCheckScans = (f: { code: string; details?: unknown }): boolean =>
  f.code === "open_check" && obj(obj(f.details)?.open_check)?.unchecked === "partial_text";

export const foundLine = (f: Pick<OpenPreviewFinding, "reason" | "count" | "more">): string =>
  M.finding(f.reason, f.count, f.more);

export function foundWhere(f: Pick<OpenPreviewFinding, "in_record" | "in_extracted">): string {
  return M.findingWhere(f.in_record, f.in_extracted);
}

export const neverReasons = (never: ReadonlyArray<{ kind: string; reason: string }> | undefined): string =>
  M.neverReasons(never ?? []);

export function audienceWho(a: NonNullable<OpenPreview["audience"]>): string {
  const names = a.spaces.filter((s) => s.kind !== "personal").map((s) => s.name);
  return M.audience(names, a.other_spaces, a.people, a.total);
}

export function editOf(m: { id: string; type: string; space: string }): { kind: "note" | "file"; href: string } | null {
  if (m.type === "note") return { kind: "note", href: `/materials?space=${encodeURIComponent(m.space)}#note` };
  if (m.type === "document") return { kind: "file", href: `/materials?space=${encodeURIComponent(m.space)}#upload` };
  return null;
}

export function despiteHere(t: ShowAnywayToggles | null | undefined, spaceKind: string | null | undefined): boolean {
  if (!t) return true;
  return t.enabled !== false && (t.projects !== false || spaceKind === "personal");
}

export const EDIT_HELPS = new Set(["never_rule", "sensitive_pii", "org_space", "org_placement", "disabled", "projects_disabled"]);

export const DESPITE_SETTING_KEYS = { enabled: "despite_enabled", projects: "despite_projects", scansText: "despite_scans_text" } as const;
export type DespiteToggle = keyof typeof DESPITE_SETTING_KEYS;

export function despiteToggles(items: readonly SettingItem[]): Record<DespiteToggle, boolean | null> {
  const one = (key: string): boolean | null => {
    const it = items.find((i) => i.category === "open_check" && i.key === key);
    if (!it) return null;
    if (!it.isSet || it.value === null || it.value === undefined) return true;
    return it.value === true;
  };
  return { enabled: one(DESPITE_SETTING_KEYS.enabled), projects: one(DESPITE_SETTING_KEYS.projects), scansText: one(DESPITE_SETTING_KEYS.scansText) };
}

export const DESPITE_REFUSED_TITLES: ReadonlyArray<readonly [keyof DespiteReport["refused"], string]> = derivedList(() => ([
  ["changed", M.changed], ["audience", M.audienceChanged], ["no_write", M.noPermission], ["disabled", M.disabled],
  ["found", M.newFinding], ["never_open", M.neverOpen], ["other", M.other],
]));
export const DESPITE_SHOWN_TITLES: ReadonlyArray<readonly ["solo" | "personal_shared" | "team" | "project", string]> = derivedList(() => ([
  ["solo", M.onlyYou], ["personal_shared", M.personalAlsoVisibleToOthers], ["team", M.teams], ["project", M.projects],
]));

export const despiteRefused = (m: Pick<ClassMove, "confirmation" | "accepted_rules" | "text_only" | "error" | "accepted_scope">): boolean =>
  m.confirmation === "human_workplace" && (Boolean(m.accepted_rules?.length) || m.text_only === true)
  && (Boolean(m.error?.startsWith("open_check")) || Boolean(m.error?.startsWith("never_open:")) || m.accepted_scope === null);
