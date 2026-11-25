export const PAGE_SIZE = 50;

export type SearchParams = Record<string, string | string[] | undefined>;

export function param(sp: SearchParams, name: string): string {
  const v = sp[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export function multiParam(sp: SearchParams, name: string, allowed: readonly string[]): string[] {
  const raw = sp[name];
  const parts = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((v) => v.split(","));
  return [...new Set(parts.map((v) => v.trim()).filter((v) => allowed.includes(v)))];
}

export function hrefWith(path: string, current: Record<string, string>, patch: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v !== null && v !== undefined && String(v) !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export interface LocalPage<T> { items: T[]; page: number; pages: number; total: number }

export function slicePage<T>(all: T[], pageParam: string, size: number = PAGE_SIZE): LocalPage<T> {
  const pages = Math.max(1, Math.ceil(all.length / size));
  const n = Number.parseInt(pageParam, 10);
  const page = Number.isFinite(n) ? Math.min(pages, Math.max(1, n)) : 1;
  return { items: all.slice((page - 1) * size, page * size), page, pages, total: all.length };
}

export function offsetOf(cursor: string): number {
  if (/\D/.test(cursor)) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function auditCursorOf(raw: string): string {
  if (!raw || raw.length > 512) return "";
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return Number.isNaN(Date.parse(raw)) ? "" : raw;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return "";
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const [at, id] = parts;
  return parts.length === 2 && at && id && !Number.isNaN(Date.parse(at)) && UUID.test(id) ? raw : "";
}
