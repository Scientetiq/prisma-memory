import type { MeResult } from "./me-api";
import type { MySpace, SpaceAddable } from "./types";

export const ADDABLE_MAX = 20;
export const ADDABLE_CURSOR = "acur";

export type AddableView = { kind: "hidden" } | { kind: "list"; data: SpaceAddable } | { kind: "failed"; message: string };

export const addableAsked = (s: Pick<MySpace, "kind" | "role" | "archived_at">, o: { tab: string; preview: boolean }): boolean =>
  o.tab === "overview" && (s.kind === "project" || s.kind === "team") && (s.role === "owner" || s.role === "member") && !s.archived_at && !o.preview;

export function addablePath(slug: string, cursor: string): string {
  const base = `/api/v1/me/spaces/${encodeURIComponent(slug)}/addable`;
  return /^[A-Za-z0-9_-]{1,200}$/.test(cursor) ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

export function addableView(r: MeResult<SpaceAddable> | null | undefined): AddableView {
  if (!r) return { kind: "hidden" };
  if (r.ok) return r.data && Array.isArray(r.data.items) ? { kind: "list", data: r.data } : { kind: "hidden" };
  if (r.code === "not_found" || r.code === "forbidden" || r.code === "unauthorized" || r.code === "gateway_unreachable") {
    return { kind: "hidden" };
  }
  return { kind: "failed", message: r.message };
}

export function pickedIds(form: FormData): string[] {
  const out: string[] = [];
  for (const v of form.getAll("ids")) {
    const id = String(v).trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
