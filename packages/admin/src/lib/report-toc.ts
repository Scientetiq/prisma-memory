import { derivedList } from "../i18n/runtime";
import { tocText } from "../messages/report-toc";
import { backupView } from "./backup-report";
import type { Report } from "./types";

export type ReportGroupKey = "processing" | "search" | "access" | "open_check" | "spaces" | "dismissed" | "backups" | "test";
export interface ReportSectionRef { id: string; title: string }
export interface ReportGroup { key: ReportGroupKey; title: string; sections: readonly ReportSectionRef[] }

export const REPORT_GROUPS: readonly ReportGroup[] = derivedList(() => [
  { key: "processing", title: tocText.processing, sections: [{ id: "by-type", title: tocText.byRecordType }, { id: "night-cap", title: tocText.nightProcessing }, { id: "verifier", title: tocText.quoteVerifier },
    { id: "project-tags", title: tocText.projectLinks }, { id: "manual-time", title: tocText.occurredAtTimesSavedBeforeTheFix }] },
  { key: "search", title: tocText.searchAndAdoption, sections: [{ id: "search-quality", title: tocText.weeklySearchQuality }, { id: "rollout", title: tocText.adoption }] },
  { key: "access", title: tocText.accessAndRoles, sections: [
    { id: "wide-grants", title: tocText.broadRoleAssignments }, { id: "obo", title: tocText.accessOnBehalfOfPeople }, { id: "extended-open", title: tocText.extendedAccessAndOpenRecords },
    { id: "client-mismatch", title: tocText.keyProgramAndReportedClient }, { id: "group-binds", title: tocText.aDGroupBindings }, { id: "group-sync", title: tocText.aDGroupSync }] },
  { key: "open_check", title: tocText.openCheck, sections: [{ id: "open-check", title: tocText.openCheck2 }, { id: "org-review", title: tocText.companyKnowledgeCuratorReview },
    { id: "space-meta", title: tocText.spaceNamesWithFindings }] },
  { key: "spaces", title: tocText.spaces, sections: [{ id: "new-spaces", title: tocText.newSpaces }, { id: "orphans", title: tocText.spacesWithoutAnActiveOwner },
    { id: "dept-no-head", title: tocText.departmentsWithoutAnActiveHead }] },
  { key: "dismissed", title: tocText.departedEmployees, sections: [{ id: "dismissed-no-custodian", title: tocText.departedEmployeesWithoutACustodian },
    { id: "dismissed-manual", title: tocText.custodiansAssignedOutsideTheOrgTable }, { id: "dismissed-stuck", title: tocText.meetingsNotTransferringToTheCustodian },
    { id: "dismissed-operator", title: tocText.custodianIsTheMemoryAdministrator }] },
  { key: "backups", title: tocText.backups, sections: [{ id: "backups", title: tocText.serverBackups }] },
  { key: "test", title: tocText.testData, sections: [{ id: "test-leftovers", title: tocText.testLeftovers }, { id: "test-purge", title: tocText.permanentTestCleanup }] },
]);

const n = (v: number | null | undefined): number => (typeof v === "number" && v > 0 ? v : 0);

export function sectionProblems(r: Report): Record<string, number | undefined> {
  const failed = Object.values(r.by_type ?? {}).reduce((a, t) => a + n(t.failed), 0);
  const tl = r.test_leftovers, tp = r.test_purge;
  const blocked = (tp?.blocked ?? []).filter((c) => !(c === "S10" && tp?.mode === "off")).length;
  const orv = r.org_review;
  return {
    "by-type": failed,
    "night-cap": r.night_cap === undefined ? undefined : r.night_cap === null ? 1 : r.night_cap.last_night.capped ? 1 : 0,
    verifier: 0,
    "project-tags": r.project_tags === undefined ? undefined : n(r.project_tags?.collisions),
    "search-quality": r.search_quality === undefined ? undefined : r.search_quality === null ? 1 : 0,
    rollout: r.rollout === undefined ? undefined : r.rollout === null ? 1 : 0,
    "wide-grants": r.wide_grants_24h ? n(r.wide_grants_24h.count) : undefined,
    obo: r.obo ? r.obo.paused_keys.length + r.obo.unbound_obo_keys.length + n(r.obo.extended_unbound) + n(r.obo.obo_read_long_keys) + n(r.obo.admin_person_keys) : undefined,
    "extended-open": r.extended_open ? n(r.extended_open.written) : undefined,
    "client-mismatch": r.client_mismatch ? n(r.client_mismatch.warn) : undefined,
    "group-binds": r.group_binds ? 0 : undefined,
    "group-sync": r.group_sync ? (r.group_sync.last?.ok === false ? 1 : 0) + r.group_sync.problems.length : undefined,
    "open-check": r.open_check ? 0 : undefined,
    "org-review": orv ? n(orv.held) + (orv.enabled && !orv.curators.count ? 1 : 0) : undefined,
    "space-meta": r.space_meta_findings ? n(r.space_meta_findings.count) : undefined,
    "new-spaces": r.new_spaces ? n(r.new_spaces.open) : undefined,
    orphans: r.spaces_without_owner ? n(r.spaces_without_owner.count) : undefined,
    "dept-no-head": r.department_spaces_without_head ? n(r.department_spaces_without_head.unmanaged ?? r.department_spaces_without_head.count) : undefined,
    "dismissed-no-custodian": r.dismissed ? n(r.dismissed.without_custodian.count) : undefined,
    "dismissed-manual": r.dismissed ? n(r.dismissed.manual.count) : undefined,
    "dismissed-stuck": r.dismissed ? n(r.dismissed.meetings_stuck.count) : undefined,
    "dismissed-operator": r.dismissed?.by_operator ? n(r.dismissed.by_operator.count) : undefined,
    "manual-time": r.manual_time_review === undefined ? undefined : r.manual_time_review === null ? 1 : n(r.manual_time_review.count),
    backups: r.backups === undefined ? undefined : backupView(r.backups).problems,
    "test-leftovers": tl === undefined ? undefined : !tl ? 0
      : (tl.error ? 1 : 0) + n(tl.active_test?.older_than_24h) + n(tl.kept?.count),
    "test-purge": tp ? blocked + n(tp.smoke.overdue) : undefined,
  };
}

export interface ReportGroupStatus { key: ReportGroupKey; title: string; problems: number; sections: Array<ReportSectionRef & { problems: number }> }

export function reportGroupsStatus(r: Report): ReportGroupStatus[] {
  const p = sectionProblems(r);
  return REPORT_GROUPS.map((g) => {
    const sections = g.sections.filter((s) => p[s.id] !== undefined).map((s) => ({ ...s, problems: p[s.id] ?? 0 }));
    return { key: g.key, title: g.title, problems: sections.reduce((a, s) => a + s.problems, 0), sections };
  }).filter((g) => g.sections.length > 0);
}

export const groupStateText = (problems: number): string => (problems ? tocText.needsAction(problems) : tocText.allClear);

export function countedText(kind: "people" | "all", includeTest: boolean): string {
  if (kind === "all") return tocText.countsAllAccountsIncludingTestAccounts;
  return includeTest ? tocText.countsAllAccountsIncludingTestAccountsAs : tocText.countsEmployeesExcludingTestAccountsAndRole;
}

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { REPORT_TOC_TEXT } from "../messages/report-toc";
