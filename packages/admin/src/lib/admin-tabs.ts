import { derivedList } from "../i18n/runtime";
import {
  PEOPLE_TABS as PEOPLE_TABS_MESSAGES, SERVICES_TABS as SERVICES_TABS_MESSAGES, ROLES_TABS as ROLES_TABS_MESSAGES, UNPROCESSED_TABS as UNPROCESSED_TABS_MESSAGES,
  SPACE_TABS as SPACE_TABS_MESSAGES, ADMIN_PLANE_PAGES as ADMIN_PLANE_PAGES_MESSAGES, EDGE_EXPORT_TABS as EDGE_EXPORT_TABS_MESSAGES
} from "../messages/admin-tabs";

export interface TabSpec<T extends string = string> { id: T; title: string; anchors?: readonly string[]; /** A tab that is a page of its own: the tab links to this address, and the address parameter tab never selects it. */ href?: string }

export function pickTab<T extends string>(raw: string | null | undefined, tabs: ReadonlyArray<TabSpec<T>>, fallback: T): T {
  return tabs.some((t) => t.id === raw && !t.href) ? (raw as T) : fallback;
}

export function tabHref(path: string, tab: string, fallback: string, keep: Record<string, string | null | undefined> = {}, anchor?: string): string {
  const q = new URLSearchParams();
  if (tab !== fallback) q.set("tab", tab);
  for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}${anchor ? `#${anchor}` : ""}`;
}

export function tabOfAnchor<T extends string>(anchor: string, tabs: ReadonlyArray<TabSpec<T>>): T | null {
  const a = anchor.replace(/^#/, "");
  return a ? tabs.find((t) => t.anchors?.includes(a))?.id ?? null : null;
}

export function anchorIndex(tabs: ReadonlyArray<TabSpec>): Record<string, string> {
  return Object.fromEntries(tabs.flatMap((t) => (t.anchors ?? []).map((a) => [a, t.id] as const)));
}

export type PeopleTab = "people" | "units" | "import" | "local";
export const PEOPLE_TABS: ReadonlyArray<TabSpec<PeopleTab>> = derivedList(() => [
  { id: "people", title: PEOPLE_TABS_MESSAGES[0].title, anchors: ["people"] },
  { id: "units", title: PEOPLE_TABS_MESSAGES[1].title, anchors: ["org-units"] },
  { id: "import", title: PEOPLE_TABS_MESSAGES[2].title, anchors: ["upload", "org-units-upload"] },
  { id: "local", title: PEOPLE_TABS_MESSAGES[3].title, href: "/admin/people/local" },
]);

export type ServicesTab = "services" | "keys" | "issue";
export const SERVICES_TABS: ReadonlyArray<TabSpec<ServicesTab>> = derivedList(() => [
  { id: "services", title: SERVICES_TABS_MESSAGES[0].title, anchors: ["services", "transcriber", "new-service"] },
  { id: "keys", title: SERVICES_TABS_MESSAGES[1].title, anchors: ["keys"] },
  { id: "issue", title: SERVICES_TABS_MESSAGES[2].title, anchors: ["issue"] },
]);

export function issueKeyHref(principal?: string, kind: "service" | "personal" = "service"): string {
  return tabHref("/admin/services", "issue", "services", principal ? { kind, principal } : {}, "issue");
}

export type RolesTab = "grants" | "special" | "catalog";
export const ROLES_TABS: ReadonlyArray<TabSpec<RolesTab>> = derivedList(() => [
  { id: "grants", title: ROLES_TABS_MESSAGES[0].title, anchors: ["grants", "broad", "new-grant"] },
  { id: "special", title: ROLES_TABS_MESSAGES[1].title, anchors: ["auditor", "curators"] },
  { id: "catalog", title: ROLES_TABS_MESSAGES[2].title, anchors: ["catalog"] },
]);

export type UnprocessedTab = "records" | "moves" | "retry";
export const UNPROCESSED_TABS: ReadonlyArray<TabSpec<UnprocessedTab>> = derivedList(() => [
  { id: "records", title: UNPROCESSED_TABS_MESSAGES[0].title, anchors: ["items", "stages", "reasons"] },
  { id: "moves", title: UNPROCESSED_TABS_MESSAGES[1].title, anchors: ["moves"] },
  { id: "retry", title: UNPROCESSED_TABS_MESSAGES[2].title, anchors: ["retry"] },
]);

export type SpaceTab = "members" | "settings" | "archive";
export const SPACE_TABS: ReadonlyArray<TabSpec<SpaceTab>> = derivedList(() => [
  { id: "members", title: SPACE_TABS_MESSAGES[0].title, anchors: ["people", "members", "groups"] },
  { id: "settings", title: SPACE_TABS_MESSAGES[1].title, anchors: ["meta", "owner"] },
  { id: "archive", title: SPACE_TABS_MESSAGES[2].title, anchors: ["archive"] },
]);

export interface AdminPlanePage { href: string; title: string; auditor: boolean; part: "B" | "C" | "E" }
export const ADMIN_PLANE_PAGES: ReadonlyArray<AdminPlanePage> = derivedList(() => [
  { href: "/admin/webauthn", title: ADMIN_PLANE_PAGES_MESSAGES[0].title, auditor: true, part: "B" },
  { href: "/admin/approvals", title: ADMIN_PLANE_PAGES_MESSAGES[1].title, auditor: true, part: "C" },
  { href: "/admin/anchors", title: ADMIN_PLANE_PAGES_MESSAGES[2].title, auditor: true, part: "C" },
  { href: "/admin/readiness", title: ADMIN_PLANE_PAGES_MESSAGES[3].title, auditor: true, part: "C" },
  { href: "/admin/security-mode", title: ADMIN_PLANE_PAGES_MESSAGES[4].title, auditor: true, part: "C" },
  { href: "/admin/admins", title: ADMIN_PLANE_PAGES_MESSAGES[5].title, auditor: true, part: "C" },
  { href: "/admin/breakglass", title: ADMIN_PLANE_PAGES_MESSAGES[6].title, auditor: true, part: "C" },
  { href: "/admin/alerts", title: ADMIN_PLANE_PAGES_MESSAGES[7].title, auditor: true, part: "E" },
  { href: "/admin/audit-ship", title: ADMIN_PLANE_PAGES_MESSAGES[8].title, auditor: true, part: "E" },
  { href: "/admin/obo-consents", title: ADMIN_PLANE_PAGES_MESSAGES[9].title, auditor: false, part: "E" },
  { href: "/admin/factor", title: ADMIN_PLANE_PAGES_MESSAGES[10].title, auditor: true, part: "C" },
]);

export type EdgeExportTab = "export" | "canaries";
export const EDGE_EXPORT_TABS: ReadonlyArray<TabSpec<EdgeExportTab>> = derivedList(() => [
  { id: "export", title: EDGE_EXPORT_TABS_MESSAGES[0].title, anchors: ["export", "queues", "reconcile", "services"] },
  { id: "canaries", title: EDGE_EXPORT_TABS_MESSAGES[1].title, anchors: ["canaries", "kill", "holds"] },
]);
