export const CALLED_COOKIE = "mem_project_called";
export const CREATE_INVITES_MAX = 20;

export function missedOf(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { missed?: unknown };
    return Array.isArray(v.missed) ? v.missed.filter((x): x is string => typeof x === "string" && /^[^\s@]+@[^\s@]+$/.test(x)).slice(0, 50) : [];
  } catch { return []; }
}
