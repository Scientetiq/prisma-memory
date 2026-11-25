// Settings of "What my agent sees": the class of new records a person adds to the personal space in the
// workspace. The instance default stays closed; open means "visible to agents after the open check". The bulk
// "show to agents" switch: a person in the workspace opens many own hidden records through one plan.
export const UPLOAD_DEFAULTS = ["closed", "open"] as const;
export type UploadDefault = (typeof UPLOAD_DEFAULTS)[number];
export const PERSONAL_UPLOAD_DEFAULT_SETTING = "access.personal_upload_default";
export const PERSONAL_UPLOAD_DEFAULT_CHOICE_SETTING = "access.personal_upload_default_choice";

export const BULK_OPEN_SETTING = "access.bulk_open";
/** The seed value of access.bulk_open; the reader's fallback is the same literal (the registry generator reads it). */
export const BULK_OPEN_DEFAULT = { enabled: true, max_items: 500 } as const;
const BULK_OPEN_FIELDS = ["enabled", "max_items"];
const BULK_OPEN_MAX = 2000;

export const isUploadDefault = (v: unknown): v is UploadDefault => typeof v === "string" && (UPLOAD_DEFAULTS as readonly string[]).includes(v);

/** Problems of a value of the two keys at save time (settings.ts); an empty list — the value is fine. Other paths — none. */
export function agentViewSettingProblems(path: string, value: unknown): string[] {
  if (value === null) return [];
  if (path === PERSONAL_UPLOAD_DEFAULT_SETTING) return isUploadDefault(value) ? [] : [`one of: ${UPLOAD_DEFAULTS.join(", ")}`];
  if (path === PERSONAL_UPLOAD_DEFAULT_CHOICE_SETTING) return typeof value === "boolean" ? [] : ["true or false"];
  if (path === BULK_OPEN_SETTING) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return ["an object {enabled, max_items}"];
    const o = value as Record<string, unknown>, out: string[] = [];
    const extra = Object.keys(o).filter((k) => !BULK_OPEN_FIELDS.includes(k));
    if (extra.length) out.push(`unknown fields: ${extra.join(", ")}`);
    if (typeof o.enabled !== "boolean") out.push("enabled — true or false");
    if (!isBulkLimit(o.max_items)) out.push(`max_items — an integer from 1 to ${BULK_OPEN_MAX}`);
    return out;
  }
  return [];
}

const isBulkLimit = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= BULK_OPEN_MAX;

interface SettingsLike { get<T>(path: string, fallback: T): T }

/**
 * access.bulk_open as the gateway reads it. Fails closed: on only when enabled is exactly true; a limit that is not an
 * integer from 1 to 2000 reads as 500 (limits.plan_max_items bounds it further, in the gateway).
 */
export function bulkOpenSettings(s: SettingsLike): { enabled: boolean; maxItems: number } {
  const v = s.get<unknown>("access.bulk_open", { enabled: true, max_items: 500 });
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { enabled: o.enabled === true, maxItems: isBulkLimit(o.max_items) ? o.max_items : BULK_OPEN_DEFAULT.max_items };
}
