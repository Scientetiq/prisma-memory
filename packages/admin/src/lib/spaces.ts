import { MONTHS, PROJECT_TAB_TITLES } from "../messages/spaces";
import { spaces as M } from "../messages/spaces";
import type { IconName } from "@/components/icons";
import { RECORD_TYPE_FOLDERS, SPACE_ORDER } from "./plain";
import { compareText } from "../i18n/format";
import type { MeSpace, MySpace } from "./types";

export const whoIcon = (kind: string): IconName => (kind === "personal" ? "user" : kind === "org" ? "globe" : kind === "selection" ? "file" : "users");

export const browseHref = (path: string, cursor?: string | null, from?: string | null): string =>
  `/browse?path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${from ? `&from=${encodeURIComponent(from)}` : ""}`;

export function projectRecordsHref(slug: string, path?: string | null, cursor?: string | null): string {
  const q = new URLSearchParams({ tab: "records" });
  const root = `/spaces/${slug}`;
  if (path && path.replace(/\/+$/, "") !== root) q.set("path", path);
  if (cursor) q.set("cursor", cursor);
  return `/projects/${encodeURIComponent(slug)}?${q}`;
}

export function projectPathOf(slug: string, raw: string): string {
  const root = `/spaces/${slug}`;
  const ok = raw.length <= 512 && (raw === root || raw.startsWith(`${root}/`)) && /^(\/[^/\s]+)+\/?$/.test(raw) && !raw.split("/").some((x) => x === "." || x === "..");
  return ok ? raw.replace(/\/+$/, "") : root;
}

export function projectsListRedirect(o: { acur?: string; page?: string; archived?: string }): string {
  const q = new URLSearchParams();
  const acur = /^\d{1,7}$/.test(o.acur ?? "") ? o.acur! : "";
  if (acur || o.archived === "1") q.set("archived", "1");
  if (acur) q.set("acur", acur);
  if (/^\d{1,5}$/.test(o.page ?? "") && Number(o.page) > 1) q.set("pp", o.page!);
  const qs = q.toString();
  return !qs ? "/browse" : `/browse?${qs}${acur || o.archived === "1" ? "#archive" : "#sp-group-projects"}`;
}

export const spaceRecordsHref = (slug: string, kind?: string): string =>
  kind === undefined || kind === "project" || kind === "team" ? projectRecordsHref(slug) : browseHref(`/spaces/${slug}`);



export function crumbLabel(seg: string, depth: number, spaceName: string): string {
  if (depth === 0) return spaceName;
  if (depth === 1) return RECORD_TYPE_FOLDERS[seg] ?? seg;
  if (depth === 3 && /^\d{1,2}$/.test(seg)) {
    const m = Number(seg);
    if (m >= 1 && m <= 12) return MONTHS[m - 1]!;
  }
  return seg;
}

const ROLE_ORDER: Record<string, number> = { owner: 0, member: 1, reader: 2 };
export const byRoleThenName = (a: Pick<MeSpace, "role" | "name">, b: Pick<MeSpace, "role" | "name">): number =>
  (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || compareText(a.name, b.name);

/** Order of the space cards of the overview: personal, teams, projects, the whole company; then by name in the locale. */
export const bySpaceKindThenName = (a: Pick<MeSpace, "kind" | "name">, b: Pick<MeSpace, "kind" | "name">): number =>
  SPACE_ORDER[a.kind] - SPACE_ORDER[b.kind] || compareText(a.name, b.name);

export interface HubGroup { key: "base" | "teams" | "projects"; title: string; spaces: MeSpace[] }

export function hubGroups(spaces: readonly MeSpace[]): HubGroup[] {
  const of = (k: MeSpace["kind"]) => spaces.filter((s) => s.kind === k);
  const teams = of("team").sort((a, b) => Number(Boolean(b.org_unit)) - Number(Boolean(a.org_unit)) || compareText(a.name, b.name));
  return [
    { key: "base", title: M.personalAndCompanyWide, spaces: [...of("personal"), ...of("org")] },
    { key: "teams", title: M.departmentAndTeams, spaces: teams },
    { key: "projects", title: M.projects, spaces: of("project").sort(byRoleThenName) },
  ];
}

export const myTeams = (spaces: readonly MeSpace[]): MeSpace[] =>
  spaces.filter((s) => s.kind === "team" && s.role === "owner")
    .sort((a, b) => Number(Boolean(b.org_unit)) - Number(Boolean(a.org_unit)) || compareText(a.name, b.name));

export const teamMenuTitle = (teams: number): string | null => (teams === 1 ? M.myTeam : teams > 1 ? M.myTeams : null);

const KINDS: ReadonlyArray<MeSpace["kind"]> = ["personal", "team", "org", "project"];
export const asMeSpace = (s: MySpace): MeSpace => ({
  slug: s.slug, kind: KINDS.includes(s.kind as MeSpace["kind"]) ? (s.kind as MeSpace["kind"]) : "team", name: s.name, role: s.role,
  default_class: s.default_class, description: s.description, ...(s.counts ? { counts: { records: s.counts.records } } : {}), ...(s.org_unit ? { org_unit: s.org_unit } : {}),
});

export type ProjectTab = "overview" | "records" | "members" | "repo" | "settings";
export { PROJECT_TAB_TITLES } from "../messages/spaces";

export function ownerPowers(s: { kind: string; role: string; org_unit?: string | null }): { members: boolean; manage: boolean } {
  const owner = s.role === "owner" && (s.kind === "project" || s.kind === "team");
  return { members: owner, manage: owner && !s.org_unit };
}

export function projectTabs(o: { records: boolean; members: boolean; repo: boolean; manage: boolean }): ProjectTab[] {
  return ["overview", ...(o.records ? ["records" as const] : []), ...(o.members ? ["members" as const] : []), ...(o.repo ? ["repo" as const] : []),
          ...(o.manage ? ["settings" as const] : [])];
}

export const pickTab = (raw: string, tabs: readonly ProjectTab[]): ProjectTab => (tabs as readonly string[]).includes(raw) ? (raw as ProjectTab) : "overview";

export const tabHref = (base: string, tab: ProjectTab): string => (tab === "overview" ? base : `${base}?tab=${tab}`);

export const guideTabShown = (s: Pick<MySpace, "kind" | "guide_enabled">): boolean =>
  s.guide_enabled === true && (s.kind === "project" || s.kind === "team");
export const guideHref = (slug: string): string => `/projects/${encodeURIComponent(slug)}/guide`;

export function initials(name: string): string {
  const words = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?").slice(0, 2);
}
