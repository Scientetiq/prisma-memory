import { ATTENTION_TEXT } from "../messages/attention";
import { CHECK_LINKS, formatDetailTimes, type EnabledFlags, type PlaceLink } from "./checks";
import { instanceTz } from "../i18n/runtime";
import { CHECK_TITLES, leftoverCount } from "./labels";
import { formatCount } from "./plain";
import type { AdminUserRow, HealthCheck, Report, Space } from "./types";

export type AttentionLevel = "urgent" | "info";
export interface AttentionItem { key: string; level: AttentionLevel; text: string; links: PlaceLink[]; fromReport?: boolean }

export interface AttentionInput {
  checks?: Record<string, HealthCheck> | null;
  flags?: EnabledFlags | null;
  missing?: readonly string[];
  notReady?: ReadonlyArray<{ login: string; person: string | null }>;
  orgNoOwner?: number;
  deletionMeetings?: number;
  report?: Report | null;
  tz?: string;
}

export interface AttentionSources {
  orgSpaces: { items: Space[] } | null;
  admins: { items: AdminUserRow[] } | null;
  deletion: { open: number; declined: number } | null;
}

export function attentionExtras(src: AttentionSources): Pick<AttentionInput, "notReady" | "orgNoOwner" | "deletionMeetings"> {
  return {
    notReady: (src.admins?.items ?? []).filter((u) => !u.disabled && !u.ready).map((u) => ({ login: u.login, person: u.person?.login ?? null })),
    orgNoOwner: (src.orgSpaces?.items ?? []).filter((x) => !x.owner).length,
    deletionMeetings: src.deletion ? src.deletion.open + src.deletion.declined : 0,
  };
}

const AUDITOR_PAGES = ["/admin/report", "/admin/audit", "/admin/search-quality"];
const auditorLink = (l: PlaceLink): boolean => AUDITOR_PAGES.some((p) => l.href === p || l.href.startsWith(`${p}#`) || l.href.startsWith(`${p}?`));

const REPORT = (anchor: string, label = ATTENTION_TEXT.report): PlaceLink => ({ href: `/admin/report#${anchor}`, label });

export function attentionItems(input: AttentionInput, opts: { auditor?: boolean } = {}): AttentionItem[] {
  const out: AttentionItem[] = [];
  const push = (item: AttentionItem) => { if (!out.some((x) => x.key === item.key)) out.push(item); };
  const r = input.report ?? null;
  const checks = input.checks ?? {};
  const flags = input.flags ?? null;

  if (flags && flags.ldap === false && flags.oidc === false)
    push({ key: "no_login", level: "urgent", text: ATTENTION_TEXT.noLogin,
           links: [{ href: "/admin/ldap", label: ATTENTION_TEXT.ldap }, { href: "/admin/sso", label: ATTENTION_TEXT.sso }] });
  const missing = input.missing ?? [];
  if (missing.length)
    push({ key: "settings", level: "urgent", text: ATTENTION_TEXT.missing(missing), links: [CHECK_LINKS.settings!] });
  const tz = input.tz ?? instanceTz();
  const failedCheck = (k: string, c: HealthCheck) => ATTENTION_TEXT.failedCheck(CHECK_TITLES[k] ?? k, c.detail ? formatDetailTimes(c.detail, tz) : "");
  const syncLinks = [REPORT("group-binds", ATTENTION_TEXT.groupBinds), { href: "/admin/ldap#groups", label: ATTENTION_TEXT.ldap }];
  const syncCheck = checks.group_sync;
  if (syncCheck && !syncCheck.ok) push({ key: "group_sync", level: "urgent", text: failedCheck("group_sync", syncCheck), links: syncLinks });
  else if (r?.group_sync?.last?.ok === false)
    push({ key: "group_sync", level: "urgent", fromReport: true,
           text: ATTENTION_TEXT.groupSyncFailed, links: syncLinks });
  for (const [k, c] of Object.entries(checks)) {
    if (c.ok) continue;
    push({ key: k, level: "urgent", text: failedCheck(k, c), links: CHECK_LINKS[k] ? [CHECK_LINKS[k]!] : [] });
  }
  for (const u of input.notReady ?? [])
    push({ key: `operator:${u.login}`, level: "urgent",
           text: ATTENTION_TEXT.operator(u),
           links: [{ href: "/admin/operator", label: ATTENTION_TEXT.assign }] });
  if (input.orgNoOwner)
    push({ key: "org_owner", level: "urgent", text: ATTENTION_TEXT.orgNoOwner,
           links: [{ href: "/admin/spaces?kind=org", label: ATTENTION_TEXT.assignSpaces }] });
  const leftovers = r?.test_leftovers ?? null;
  if (leftovers?.error)
    push({ key: "leftovers_failed", level: "urgent", fromReport: true, text: ATTENTION_TEXT.leftoversFailed,
           links: [REPORT("test-leftovers")] });

  if (input.deletionMeetings)
    push({ key: "deletion", level: "info", text: ATTENTION_TEXT.deletion(input.deletionMeetings),
           links: [{ href: "/admin/deletion-requests", label: ATTENTION_TEXT.deletionRequests }] });
  const openNew = r?.new_spaces?.open ?? 0;
  if (openNew)
    push({ key: "open_new", level: "info", fromReport: true, text: ATTENTION_TEXT.openNew(openNew),
           links: [REPORT("new-spaces")] });
  const orphans = r?.spaces_without_owner?.count ?? 0;
  if (orphans)
    push({ key: "orphans", level: "info", fromReport: true, text: ATTENTION_TEXT.orphans(orphans),
           links: [REPORT("orphans")] });
  const dnh = r?.department_spaces_without_head;
  const noHead = dnh ? dnh.unmanaged ?? dnh.count : 0;
  if (noHead)
    push({ key: "dept_no_head", level: "info", fromReport: true,
           text: ATTENTION_TEXT.noHead(noHead),
           links: [REPORT("dept-no-head")] });
  const staleTest = leftovers?.active_test?.older_than_24h ?? 0;
  if (staleTest)
    push({ key: "stale_test", level: "info", fromReport: true,
           text: ATTENTION_TEXT.staleTest(staleTest),
           links: [{ href: "/admin/people?test=true", label: ATTENTION_TEXT.testPeople }, REPORT("test-leftovers")] });
  const keptTest = leftovers?.kept?.count ?? 0;
  if (keptTest)
    push({ key: "kept_test", level: "info", fromReport: true, text: ATTENTION_TEXT.keptTest(keptTest),
           links: [REPORT("test-leftovers")] });
  const markedStaff = leftoverCount(leftovers?.attr_test_other_domain);
  if (markedStaff)
    push({ key: "marked_staff", level: "info", fromReport: true, text: ATTENTION_TEXT.markedStaff(markedStaff),
           links: [REPORT("test-leftovers")] });

  const sorted = [...out.filter((x) => x.level === "urgent"), ...out.filter((x) => x.level === "info")];
  if (!opts.auditor) return sorted;
  return sorted.filter((x) => x.fromReport).map((x) => ({ ...x, links: x.links.filter(auditorLink) }));
}
