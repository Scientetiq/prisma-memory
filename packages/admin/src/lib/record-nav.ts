import { text as M } from "../messages/record-nav";
import { derived } from "../i18n/runtime";
import { isSlug } from "./form";
import { EVENT_KINDS, RECORD_TYPES } from "./labels";
import { RECORD_TYPE_FOLDERS, SECTION_TITLES } from "./plain";
import { SEARCH_LABEL_PARAM, searchPick } from "./space-overview";
import { browseHref, projectRecordsHref } from "./spaces";
import type { MeSpace } from "./types";

export interface Crumb { href: string; label: string }
export interface RecordTrail { crumbs: Crumb[]; navHref: string }
export type TrailSpace = Pick<MeSpace, "slug" | "name"> & { kind: string };

const MEETINGS: Crumb = derived(() => ({ href: "/meetings", label: M.meetingsWithMe }));
const folderOf = (type: string): string => RECORD_TYPE_FOLDERS[type] ?? M.records;

export function recordTrail(m: { type: string; space: string; parent_id?: string | null }, spaces: readonly TrailSpace[]): RecordTrail {
  const here = spaces.find((s) => s.slug === m.space) ?? null;
  const derived = m.type === "summary" || m.type === "event";
  const folder = (href: string): Crumb => ({ href, label: folderOf(m.type) });
  if (here && here.kind !== "personal") {
    if (here.kind === "project" || here.kind === "team")
      return { crumbs: [{ href: `/projects/${encodeURIComponent(here.slug)}`, label: here.name }, folder(projectRecordsHref(here.slug, `/spaces/${here.slug}/${m.type}`))], navHref: "/browse" };
    return { crumbs: [{ href: browseHref(`/spaces/${here.slug}`), label: here.name }, folder(browseHref(`/spaces/${here.slug}/${m.type}`))], navHref: "/browse" };
  }
  if (m.type === "transcript" || (derived && m.parent_id)) return { crumbs: [MEETINGS], navHref: "/meetings" };
  if (here) {
    const known = (RECORD_TYPES as readonly string[]).includes(m.type);
    return { crumbs: [{ href: "/materials", label: SECTION_TITLES.materials }, ...(known ? [folder(`/materials?type=${m.type}`)] : [])], navHref: "/materials" };
  }
  return { crumbs: [{ href: "/", label: M.overview }], navHref: "/" };
}

const BACK_MODES = ["hybrid", "keyword", "semantic", "recent"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const BACK_Q_MAX = 200;

export function searchBackParam(query: string, pageQuery: string): string | null {
  return query.length > BACK_Q_MAX ? null : pageQuery;
}

export function searchBackHref(raw: string): string | null {
  if (!raw || raw.length > 2000) return null;
  let p: URLSearchParams;
  try { p = new URLSearchParams(raw.replace(/^\?/, "")); } catch { return null; }
  const out = new URLSearchParams();
  const q = (p.get("q") ?? "").trim();
  if (q && q.length <= BACK_Q_MAX) out.set("q", q);
  const mode = p.get("mode") ?? "";
  if (BACK_MODES.includes(mode) && mode !== "hybrid") out.set("mode", mode);
  if (!out.has("q") && mode !== "recent") return null;
  const space = p.get("space") ?? "";
  if (isSlug(space)) out.set("space", space);
  if (p.get("archived") === "1") out.set("archived", "1");
  for (const k of ["from", "to"]) { const v = p.get(k) ?? ""; if (DAY.test(v)) out.set(k, v); }
  for (const t of new Set(p.getAll("type"))) if ((RECORD_TYPES as readonly string[]).includes(t)) out.append("type", t);
  for (const k of new Set(p.getAll("kind"))) if ((EVENT_KINDS as readonly string[]).includes(k)) out.append("kind", k);
  const pick = searchPick((n) => p.get(n) ?? "");
  if (pick.domain) out.set("domain", pick.domain);
  if (pick.entity) out.set("entity", pick.entity);
  if (pick.what) out.set(SEARCH_LABEL_PARAM, pick.what);
  const page = p.get("page") ?? "";
  if (/^[2-5]$/.test(page)) out.set("page", page);
  return `/search?${out.toString()}`;
}
