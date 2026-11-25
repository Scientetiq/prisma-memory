// Settings of the space export: the switch, who may export a team/project/company space, and the daily limit
// per person. Checked when saved (settings.ts) — a typo must neither switch the export on for readers nor lift the limit.

export const EXPORT_SPACE_ENABLED_SETTING = "access.export_space_enabled";
export const EXPORT_SPACE_ROLE_SETTING = "access.export_space_role";
export const EXPORT_DAILY_SETTING = "limits.export_daily";

export const EXPORT_SPACE_ROLES = ["owner", "member"] as const;
export type ExportSpaceRole = (typeof EXPORT_SPACE_ROLES)[number];
export const EXPORT_DAILY_DEFAULT = 5;
export const EXPORT_DAILY_MAX = 1000;

/** Problems of a value of one of the export settings; an empty list — the value is fine. Other keys — always empty. */
export function exportSettingProblems(path: string, value: unknown): string[] {
  if (value === null) return [];
  switch (path) {
    case EXPORT_SPACE_ENABLED_SETTING: return typeof value === "boolean" ? [] : ["true or false"];
    case EXPORT_SPACE_ROLE_SETTING: return (EXPORT_SPACE_ROLES as readonly unknown[]).includes(value) ? [] : [`one of: ${EXPORT_SPACE_ROLES.join(", ")}`];
    case EXPORT_DAILY_SETTING:
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= EXPORT_DAILY_MAX ? [] : [`a whole number from 1 to ${EXPORT_DAILY_MAX}`];
    default: return [];
  }
}

/** The role setting as read: an unknown value is the strict one (owner). */
export const exportSpaceRole = (v: unknown): ExportSpaceRole => (v === "member" ? "member" : "owner");
