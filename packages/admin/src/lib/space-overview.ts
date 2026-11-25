import type { MeResult } from "./me-api";
import type { MySpace, SpaceOverview, SpaceOverviewBlock, SpaceOverviewCount, SpaceOverviewPage } from "./types";

export const OVERVIEW_BLOCKS = ["decisions", "risks", "due_this_week"] as const;
export type OverviewBlockCode = (typeof OVERVIEW_BLOCKS)[number];
export const OVERVIEW_CURSOR: Record<OverviewBlockCode, string> = { decisions: "dcur", risks: "rcur", due_this_week: "ducur" };
export const OVERVIEW_ANCHOR: Record<OverviewBlockCode, string> = { decisions: "ov-decisions", risks: "ov-risks", due_this_week: "ov-due" };

const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;

export const overviewAsked = (s: Pick<MySpace, "kind">, o: { tab: string }): boolean =>
  o.tab === "overview" && (s.kind === "project" || s.kind === "team");

export function overviewPaged(param: (name: string) => string): OverviewPagedAt | null {
  for (const block of OVERVIEW_BLOCKS) {
    const cursor = param(OVERVIEW_CURSOR[block]);
    if (CURSOR_RE.test(cursor)) return { block, cursor };
  }
  return null;
}

export type OverviewPagedAt = { block: OverviewBlockCode; cursor: string };

export function overviewPath(slug: string, paged?: OverviewPagedAt | null, omit?: OverviewBlockCode | null): string {
  const base = `/api/v1/me/spaces/${encodeURIComponent(slug)}/overview`;
  if (paged && CURSOR_RE.test(paged.cursor)) return `${base}?${new URLSearchParams({ block: paged.block, cursor: paged.cursor })}`;
  return omit && (OVERVIEW_BLOCKS as readonly string[]).includes(omit) ? `${base}?${new URLSearchParams({ omit })}` : base;
}

export function pageUsable(paged: OverviewPagedAt | null, page: MeResult<SpaceOverviewPage> | null | undefined): page is { ok: true; status: number; data: SpaceOverviewPage } {
  return Boolean(paged && page && page.ok && page.data?.block === paged.block && Array.isArray(page.data.items) && page.data.items.length > 0);
}

export async function loadOverview(get: (path: string) => Promise<MeResult<unknown>>, slug: string, paged: OverviewPagedAt | null):
    Promise<{ overview: MeResult<SpaceOverview>; page: MeResult<SpaceOverviewPage> | null }> {
  if (!paged) return { overview: await get(overviewPath(slug)) as MeResult<SpaceOverview>, page: null };
  const page = await get(overviewPath(slug, paged)) as MeResult<SpaceOverviewPage>;
  const omit = pageUsable(paged, page) ? paged.block : null;
  return { overview: await get(overviewPath(slug, null, omit)) as MeResult<SpaceOverview>, page };
}

const isBlock = (b: unknown): b is SpaceOverviewBlock => Boolean(b) && Array.isArray((b as SpaceOverviewBlock).items);
const isWeek = (w: unknown): boolean =>
  Boolean(w) && ["meetings", "documents", "notes"].every((k) => Array.isArray((w as Record<string, { items?: unknown }>)[k]?.items));
export const isOverview = (d: unknown): d is SpaceOverview => {
  const o = d as SpaceOverview | null | undefined;
  return Boolean(o) && isBlock(o!.decisions) && isBlock(o!.risks) && isBlock(o!.due_this_week)
    && Array.isArray(o!.directions) && Array.isArray(o!.entities) && isWeek(o!.week);
};

export type OverviewView = { kind: "hidden" } | { kind: "data"; data: SpaceOverview } | { kind: "failed"; message: string };

export function overviewView(r: MeResult<SpaceOverview> | null | undefined): OverviewView {
  if (!r) return { kind: "hidden" };
  if (r.ok) return isOverview(r.data) ? { kind: "data", data: r.data } : { kind: "hidden" };
  if (r.code === "not_found" || r.code === "forbidden" || r.code === "unauthorized") return { kind: "hidden" };
  return { kind: "failed", message: r.message };
}

export interface BlockShown { items: SpaceOverviewBlock["items"]; next: string | null; cursor: string }

export function blockShown(o: SpaceOverview, code: OverviewBlockCode, paged: OverviewPagedAt | null,
                           page: MeResult<SpaceOverviewPage> | null | undefined): BlockShown {
  if (paged && paged.block === code && pageUsable(paged, page))
    return { items: page.data.items, next: page.data.next_cursor ?? null, cursor: paged.cursor };
  return { items: o[code].items, next: o[code].next_cursor ?? null, cursor: "" };
}

/** Entity kind by its key (`ext:<system>:deal:<id>`, `ext:<system>:company:<id>`, `project:<slug>`); unknown — null. */
export function entityKindOf(key: string): "deal" | "company" | "project" | null {
  if (/^ext:[a-z][a-z0-9_]{1,31}:deal:/.test(key)) return "deal";
  if (/^ext:[a-z][a-z0-9_]{1,31}:company:/.test(key)) return "company";
  if (/^project:/.test(key)) return "project";
  return null;
}

export const SEARCH_LABEL_PARAM = "what";
export const SEARCH_LABEL_MAX = 120;

export function countHref(c: Pick<SpaceOverviewCount, "href" | "title">, entity: boolean): string | null {
  if (typeof c.href !== "string" || !c.href.startsWith("/search?")) return null;
  if (!entity) return c.href;
  const q = new URLSearchParams(c.href.slice("/search?".length));
  q.set(SEARCH_LABEL_PARAM, c.title.trim().slice(0, SEARCH_LABEL_MAX));
  return `/search?${q}`;
}

export function countsFrom(o: Pick<SpaceOverview, "directions" | "entities">): string | null {
  for (const c of [...o.directions, ...o.entities]) {
    const from = typeof c.href === "string" && c.href.startsWith("/search?") ? new URLSearchParams(c.href.slice(8)).get("from") : null;
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) return from;
  }
  return null;
}

export const overviewEmpty = (o: SpaceOverview): boolean =>
  !o.decisions.items.length && !o.risks.items.length && !o.due_this_week.items.length && !o.directions.length && !o.entities.length
  && !o.week.meetings.count && !o.week.documents.count && !o.week.notes.count;

export interface SearchPick { domain: string; entity: string; what: string }
const ENTITY_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[a-z0-9]+:[^\s:]+(:[^\s]+)?)$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export function searchPick(param: (name: string) => string): SearchPick {
  const d = param("domain").trim(), e = param("entity").trim();
  const domain = d && d.length <= 64 && !CONTROL_RE.test(d) ? d : "";
  const entity = e && e.length <= 200 && ENTITY_RE.test(e) ? e : "";
  const w = entity ? param(SEARCH_LABEL_PARAM).replace(/\s+/g, " ").trim().slice(0, SEARCH_LABEL_MAX) : "";
  return { domain, entity, what: w };
}
