import { derivedList } from "@/i18n/runtime";
import { reportText } from "@/messages/panel-report";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { readAdminView } from "@/lib/view-as";
import { LocalPager } from "@/components/pager";
import { RolloutSection, SearchQualityWeekSection } from "@/components/report-quality";
import { AttentionList } from "@/components/attention-list";
import { DespiteReportBlock } from "@/components/report-despite";
import { Badge, Chips, Code, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { tryGw } from "@/lib/api";
import { attentionItems } from "@/lib/attention";
import { loadAttentionExtras } from "@/lib/attention-load";
import { enabledFlags, instanceTz } from "@/lib/checks";
import { formatShare } from "@/lib/format";
import { CLAIMED_KIND_TITLES, CLAIMED_SOURCE_TITLES, EXTENDED_ATTEMPT_TITLES, CLIENT_MISMATCH_TITLES, clientKindTitle, CREATED_VIA_TITLES, graceTitle, GROUP_STATUS_TITLES, LEFTOVERS_KEPT_TITLES, LEFTOVERS_SCOPE_TITLES, LEFTOVERS_SKIPPED_TITLES, leftoverCount, leftoverKinds, TEST_PURGE_BACKLOG_TITLES, TEST_PURGE_MODE_TITLES, TEST_PURGE_STOP_TITLES, testPurgeTotal, OBO_DENIAL_TITLES, OPEN_CHECK_FIELD_TITLES, OPEN_CHECK_KIND_TITLES, OPEN_CHECK_UNCHECKED_TITLES, OPEN_CHECK_VIA_TITLES, RECORD_TYPE_TITLES, ROLE_TITLES, SCOPE_TITLES, SPACE_KIND_TITLES, SPACE_ROLE_TITLES } from "@/lib/labels";
import { hrefWith, param, slicePage, type SearchParams } from "@/lib/paging";
import { formatCount, formatDay } from "@/lib/plain";
import { nightCapLines } from "@/lib/night-cap";
import { backupView } from "@/lib/backup-report";
import { countedText, groupStateText, reportGroupsStatus, sectionProblems } from "@/lib/report-toc";
import { custodyDay, DISMISSED_REPORT as DR } from "@/lib/custody-view";
import type { Health, OboReport, Report, SettingsResponse } from "@/lib/types";

const SPACE_ROWS = 25;

export function generateMetadata(): Metadata { return { title: reportText.report }; }

const WINDOWS = derivedList(() => [{ hours: 24, title: reportText.period24Hours }, { hours: 72, title: reportText.period3Days }, { hours: 168, title: reportText.period1Week }, { hours: 336, title: reportText.period2Weeks }] as const);

const VERIFIER_ROWS: ReadonlyArray<{ key: keyof Report["verifier"]; title: string; hint: string }> = derivedList(() => [
  { key: "transcripts", title: reportText.transcriptsWithEventExtraction, hint: reportText.transcriptsThatCompletedTheEventsStageIn },
  { key: "input", title: reportText.modelEventCandidates, hint: reportText.allCandidatesBeforeVerification },
  { key: "exact", title: reportText.exactQuoteMatches, hint: reportText.verbatimMatchesInTheTranscript },
  { key: "fuzzy", title: reportText.fuzzyQuoteMatches, hint: reportText.matchesAboveFuzzyThreshold },
  { key: "quote_not_found", title: reportText.quoteNotFound, hint: reportText.discardedEventsAreNeverSavedWithoutA },
  { key: "duplicate", title: reportText.duplicates, hint: reportText.discardedAsDuplicatesWithinTheDeduplicationWindow },
  { key: "over_limit", title: reportText.overTheLimit, hint: reportText.discardedUnderMaxPerTranscript },
  { key: "kept", title: reportText.eventsSaved, hint: reportText.totalAfterAllChecks },
  { key: "suppressed_by_correction", title: reportText.keptHiddenCorrectedByAPerson, hint: reportText.amongSavedEventsTheModelFoundAn },
]);

const LEGACY_KEY_ROWS: ReadonlyArray<{ key: "extended_unbound" | "obo_read_long_keys" | "admin_person_keys"; title: string; hint: string }> = derivedList(() => [
  { key: "extended_unbound", title: reportText.extendedKeysWithoutAnIPRestriction, hint: reportText.newKeysRequireAnIPRestrictionRestrict },
  { key: "obo_read_long_keys", title: reportText.serviceKeysThatReadOnBehalfOf, hint: reportText.newKeysExpireWithin30DaysRevoke },
  { key: "admin_person_keys", title: reportText.personalKeysIssuedByAnAdministrator, hint: reportText.personalAndExtendedKeysIssuedBySomeone },
]);
function LegacyKeys({ obo, auditor }: { obo: OboReport; auditor: boolean }) {
  const rows = LEGACY_KEY_ROWS.filter((r) => typeof obo[r.key] === "number");
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + (obo[r.key] ?? 0), 0);
  return (
    <>
      <TableWrap>
        <table className="board">
          <thead><tr><th>{reportText.legacyKeysStillValidButNoLonger}</th><th className="num">{reportText.count}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}><td title={r.key}>{r.title}<div className="cell-sub">{r.hint}</div></td><td className="num">{obo[r.key]}</td></tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {total ? <p className="hint">{auditor ? reportText.anAdministratorCanRestrictOrRevokeKeys : <>{rich(reportText.restrictOrRevokeKeysIn, null, { value1: (<Link href="/admin/services?tab=keys#keys" prefetch={false}>{reportText.servicesAndKeys}</Link>) })}</>}</p> : null}
    </>
  );
}

export default async function ReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const auditor = (await readAdminView()) === "auditor";
  const sp = await searchParams;
  const asked = Number.parseInt(param(sp, "hours"), 10);
  const hours = Number.isFinite(asked) && asked >= 1 && asked <= 336 ? asked : 24;

  const hook = { ...(param(sp, "include_test") === "true" ? { include_test: "true" } : {}), ...(param(sp, "current") === "true" ? { current: "true" } : {}) };
  const [res, settings, health, extras] = await Promise.all([
    tryGw<Report>("/api/v1/admin/report", { query: { hours, ...hook, manual_time: "true" } }),
    auditor ? Promise.resolve(null) : tryGw<SettingsResponse>("/api/v1/admin/settings"),
    auditor ? Promise.resolve(null) : tryGw<Health>("/api/v1/health"),
    auditor ? Promise.resolve(null) : loadAttentionExtras(),
  ]);
  const rows = res.ok ? Object.entries(res.data.by_type).sort(([a], [b]) => a.localeCompare(b)) : [];
  const keep = { hours: hours === 24 ? "" : String(hours), ...hook };
  const d = res.ok ? res.data : null;
  const newSpaces = d?.new_spaces ? slicePage(d.new_spaces.items, param(sp, "nsp"), SPACE_ROWS) : null;
  const binds = d?.group_binds ? slicePage(d.group_binds.items, param(sp, "gbp"), SPACE_ROWS) : null;
  const classChanges = d?.space_class_changes ? slicePage(d.space_class_changes.items, param(sp, "scp"), SPACE_ROWS) : null;
  const problems = d?.group_sync ? slicePage(d.group_sync.problems, param(sp, "gsp"), SPACE_ROWS) : null;
  const orphans = d?.spaces_without_owner ? slicePage(d.spaces_without_owner.items, param(sp, "wop"), SPACE_ROWS) : null;
  const noHead = d?.department_spaces_without_head ? slicePage(d.department_spaces_without_head.items, param(sp, "dhp"), SPACE_ROWS) : null;
  const metaFound = d?.space_meta_findings ? slicePage(d.space_meta_findings.items, param(sp, "smp"), SPACE_ROWS) : null;
  const dm = d?.dismissed ?? null;
  const dmNone = dm ? slicePage(dm.without_custodian.items, param(sp, "dnp"), SPACE_ROWS) : null;
  const dmManual = dm ? slicePage(dm.manual.items, param(sp, "dmp"), SPACE_ROWS) : null;
  const dmStuck = dm ? slicePage(dm.meetings_stuck.items, param(sp, "dsp"), SPACE_ROWS) : null;
  const dmOperator = dm?.by_operator ? slicePage(dm.by_operator.items, param(sp, "dop"), SPACE_ROWS) : null;
  const mismatch = d?.client_mismatch ? slicePage(d.client_mismatch.items, param(sp, "cmp"), SPACE_ROWS) : null;
  const xo = d?.extended_open ?? null;
  const xoItems = xo ? slicePage(xo.items, param(sp, "xop"), SPACE_ROWS) : null;
  const xoKeys = xo ? slicePage(xo.keys_allowed, param(sp, "xkp"), SPACE_ROWS) : null;
  const orv = d?.org_review ?? null;
  const orvMarks = orv ? slicePage(orv.wrong_marks.items, param(sp, "orp"), SPACE_ROWS) : null;
  const tl = d?.test_leftovers ?? null;
  const tlKept = tl?.kept ? slicePage(tl.kept.items, param(sp, "tlp"), SPACE_ROWS) : null;
  const tlSkipped = Object.entries(tl?.skipped ?? {}).map(([k, v]) => [k, leftoverCount(v)] as const).filter(([, n]) => n > 0);
  const tlWaiting = { people: leftoverCount(tl?.waiting?.people), records: leftoverCount(tl?.waiting?.records), spaces: leftoverCount(tl?.waiting?.spaces) };
  const tp = d?.test_purge ?? null;
  const tpBacklog = Object.entries(tp?.backlog ?? {}).filter(([, n]) => typeof n === "number" && n > 0);
  const tpBlocked = (tp?.blocked ?? []).filter((c) => !(c === "S10" && tp?.mode === "off"));
  const mtr = d?.manual_time_review;
  const mtrItems = mtr ? slicePage(mtr.items, param(sp, "mtp"), SPACE_ROWS) : null;
  const kinds = (v: Parameters<typeof leftoverKinds>[0]) => leftoverKinds(v).map(([k, n]) => `${k} — ${formatCount(n)}`).join(", ");
  const spaceLink = (slug: string) => auditor ? <Code>{slug}</Code> : <Link href={`/admin/spaces/${encodeURIComponent(slug)}`} prefetch={false}><Code>{slug}</Code></Link>;
  const personLink = (login: string) => auditor ? <Code>{login}</Code> : <Link href={`/admin/people/${encodeURIComponent(login)}`} prefetch={false}><Code>{login}</Code></Link>;
  const includeTest = param(sp, "include_test") === "true";
  const countedAll = <p className="hint">{countedText("all", includeTest)}</p>;
  const secProblems = d ? sectionProblems(d) : {};
  const groups = d ? reportGroupsStatus(d) : [];
  const fold = (id: string, pages: string[] = []) => ({ open: (secProblems[id] ?? 0) > 0 || pages.some((n) => !!param(sp, n)), state: groupStateText(secProblems[id] ?? 0) });
  const settingsData = settings?.ok && Array.isArray(settings.data?.items) ? settings.data : null;
  // zone of the installation for the times of the to-do list and the days of the dismissed sections (the gateway sends
  // moments in UTC); for an auditor the settings are not loaded and the zone the gateway sends applies
  const tz = instanceTz(settingsData);
  const checks = health?.ok && health.data?.checks && typeof health.data.checks === "object" ? health.data.checks : null;
  const todo = attentionItems(auditor ? { report: d }
    : { checks, flags: enabledFlags(settingsData), missing: settingsData?.missing_required ?? [], ...extras, report: d, tz }, { auditor });
  const total = rows.reduce((a, [, t]) => ({ accepted: a.accepted + t.accepted, processed: a.processed + t.processed, failed: a.failed + t.failed, queued: a.queued + t.queued }), { accepted: 0, processed: 0, failed: 0, queued: 0 });


  return (
    <PageFrame allowAuditor title={reportText.report2} lead={reportText.yourMorningAdminReportActionsForToday}>
      {!res.ok ? <LoadError result={res} what={reportText.report3} /> : (
        <>
          <Section title={reportText.toDo} id="todo" hint={auditor ? reportText.onlyIssuesVisibleInTheReportAn : reportText.theSameListAsNeedsAttentionOn}>
            {todo.length ? <AttentionList items={todo} /> : <Empty>{reportText.nothingNeedsAttention}</Empty>}
          </Section>

          {groups.length ? (
            <nav className="report-toc" aria-label={reportText.reportSections}>
              {groups.map((g) => (
                <div key={g.key} className="report-toc-group">
                  <div className="report-toc-head"><b>{g.title}</b> <span className={g.problems ? "warn-text" : "muted"}>{groupStateText(g.problems)}</span></div>
                  <ul>
                    {g.sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a>{s.problems ? <span className="warn-text"> · {s.problems}</span> : null}</li>)}
                  </ul>
                </div>
              ))}
            </nav>
          ) : null}

          <div className="report-part" id="period">
            <div className="report-part-head">
              <h2 className="report-part-title">{reportText.selectedPeriod}</h2>
              <nav className="tabs" aria-label={reportText.reportPeriod}>
                {WINDOWS.map((w) => (
                  <Link key={w.hours} prefetch={false} href={hrefWith("/admin/report", hook, { hours: w.hours === 24 ? null : w.hours }) + "#period"} className={w.hours === hours ? "on" : undefined} aria-current={w.hours === hours ? "page" : undefined}>
                    {w.title}
                  </Link>
                ))}
              </nav>
            </div>
          <div className="stat-tiles">
            <div className="stat-tile"><div className="v">{total.accepted}</div><div className="k">{rich(reportText.receivedInH, null, { value1: hours })}</div></div>
            <div className="stat-tile"><div className="v">{formatShare(res.data.processed_share)}</div><div className="k">{reportText.processedShare}</div></div>
            <div className="stat-tile"><div className="v">{total.failed}</div><div className="k">{reportText.failed}</div></div>
            <div className="stat-tile"><div className="v">{total.queued}</div><div className="k">{reportText.queued}</div></div>
            <div className="stat-tile"><div className="v">{formatShare(res.data.verifier.quote_verified_share)}</div><div className="k">{reportText.eventsWithAVerifiedQuote}</div></div>
          </div>

          <Section title={reportText.byRecordType} id="by-type" fold={fold("by-type")} hint={<>{rich(reportText.excludesRecordsCreatedByThePipelineItself, null, { value1: (<LocalTime iso={res.data.generated_at} />) })}</>}>
            {!rows.length ? <Empty>{reportText.noRecordsWereReceivedInThisPeriod}</Empty> : (
              <TableWrap>
                <table className="board">
                  <thead><tr><th>{reportText.type}</th><th className="num">{reportText.received}</th><th className="num">{reportText.processed}</th><th className="num">{reportText.failed2}</th><th className="num">{reportText.queued2}</th></tr></thead>
                  <tbody>
                    {rows.map(([type, t]) => (
                      <tr key={type}>
                        <td title={type}>{RECORD_TYPE_TITLES[type] ?? type}</td>
                        <td className="num">{t.accepted}</td>
                        <td className="num">{t.processed}</td>
                        <td className="num">{t.failed ? <span className="danger-text">{t.failed}</span> : 0}</td>
                        <td className="num">{t.queued}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="cell-main">{reportText.total}</td>
                      <td className="num cell-main">{total.accepted}</td>
                      <td className="num cell-main">{total.processed}</td>
                      <td className="num cell-main">{total.failed}</td>
                      <td className="num cell-main">{total.queued}</td>
                    </tr>
                  </tbody>
                </table>
              </TableWrap>
            )}
            {countedAll}
            {total.failed || total.queued ? <p className="hint">{rich(reportText.forRecordDetailsSee, null, { value1: auditor ? <>{reportText.processingUnavailableToAuditors}</> : <Link href="/admin/unprocessed" prefetch={false}>{reportText.processing}</Link> })}</p> : null}
          </Section>

          {d && d.night_cap !== undefined ? (
            <Section title={reportText.nightProcessing} id="night-cap" fold={fold("night-cap")} hint={reportText.theModelSNightlyTokenLimitCovers}>
              {nightCapLines(d.night_cap, tz).map((l, i) => <Notice key={i} tone={l.tone}>{l.text}</Notice>)}
            </Section>
          ) : null}

          <Section title={reportText.quoteVerifier} id="verifier" fold={fold("verifier")} hint={reportText.theLLMClassifiesCodeDecidesAnEvent}>
            <TableWrap>
              <table className="board">
                <thead><tr><th>{reportText.metric}</th><th className="num">{reportText.value}</th><th>{reportText.description}</th></tr></thead>
                <tbody>
                  {VERIFIER_ROWS.map((r) => (
                    <tr key={r.key}>
                      <td title={r.key}>{r.title}</td>
                      <td className="num">{res.data.verifier[r.key] ?? 0}</td>
                      <td className="muted">{r.hint}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="cell-main">{reportText.verifiedQuoteShare}</td>
                    <td className="num cell-main">{formatShare(res.data.verifier.quote_verified_share)}</td>
                    <td className="muted">{reportText.exactFuzzyMatchesModelEventCandidates}</td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
          </Section>

          {res.data.obo ? (
            <Section title={reportText.accessOnBehalfOfPeople} id="obo" fold={fold("obo")} hint={reportText.servicesActingOnBehalfOfPeopleRefusals}>
              {Object.keys(res.data.obo.denials).length ? (
                <TableWrap>
                  <table className="board">
                    <thead><tr><th>{reportText.refusalReason}</th><th className="num">{reportText.count2}</th></tr></thead>
                    <tbody>
                      {Object.entries(res.data.obo.denials).map(([reason, n]) => (
                        <tr key={reason}><td title={reason}>{OBO_DENIAL_TITLES[reason] ?? reason}</td><td className="num">{n}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : <Empty>{reportText.noRefusalsForAccessOnBehalfOf}</Empty>}
              {res.data.obo.paused_keys.length ? (
                <p className="hint">{rich(reportText.paused, null, { value1: res.data.obo.paused_keys.map((k) => `${k.key_prefix}…${k.principal ? ` (${k.principal})` : ""}`).join(", "), value2: auditor ? reportText.anAdministratorCanResumeTheKeys : <>{rich(reportText.resumeKeysIn, null, { value1: (<Link href="/admin/services?tab=keys#keys" prefetch={false}>{reportText.servicesAndKeys2}</Link>) })}</> })}</p>
              ) : null}
              {res.data.obo.unbound_obo_keys.length ? (
                <TableWrap>
                  <table className="board">
                    <thead><tr><th>{reportText.keyWithoutAnIPRestriction}</th><th>{reportText.service}</th><th>{reportText.lastRequestAddress}</th><th>{reportText.lastRequest}</th></tr></thead>
                    <tbody>
                      {res.data.obo.unbound_obo_keys.map((k) => (
                        <tr key={k.id}>
                          <td><Code>{k.key_prefix}…</Code></td>
                          <td><Code>{k.service}</Code></td>
                          <td>
                            {k.last_used_ip ? <Code>{k.last_used_ip}</Code> : <span className="muted">{k.last_used_at ? reportText.addressNotRecorded : reportText.neverUsed}</span>}
                            <div className="cell-sub">{auditor ? reportText.anAdministratorCanRestrictTheAddress
                              : <Link href={`/admin/services?tab=keys&principal=${encodeURIComponent(k.service)}#key-${k.id}`} prefetch={false}>{reportText.restrictAddress}</Link>}</div>
                          </td>
                          <td>{k.last_used_at ? <LocalTime iso={k.last_used_at} /> : <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : <p className="hint">{reportText.allServiceKeysActingOnBehalfOf}</p>}
              <LegacyKeys obo={res.data.obo} auditor={auditor} />
            </Section>
          ) : null}

          {xo && xoItems && xoKeys ? (
            <Section title={reportText.extendedAccessAndOpenRecords} id="extended-open" fold={fold("extended-open", ["xop", "xkp"])} hint={reportText.anAgentWithAnExtendedKeyCan}>
              <div className="stat-tiles">
                <div className="stat-tile"><div className={`v ${xo.written ? "warn" : ""}`}>{xo.written}</div><div className="k">{reportText.writtenWithPermission}</div></div>
                <div className="stat-tile"><div className="v">{xo.denied}</div><div className="k">{reportText.refused}</div></div>
                <div className="stat-tile"><div className="v">{xo.keys_allowed.length}</div><div className="k">{reportText.keysCurrentlyPermitted}</div></div>
              </div>
              {xo.keys_allowed.length ? (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.permittedKey}</th><th>{reportText.owner}</th><th>{reportText.expires}</th></tr></thead>
                      <tbody>
                        {xoKeys.items.map((k) => (
                          <tr key={k.id}>
                            <td><Code>{k.key_prefix}…</Code></td>
                            <td>{k.principal ? personLink(k.principal) : <span className="muted">—</span>}</td>
                            <td className="nowrap">{k.expires_at ? formatDay(k.expires_at) : <span className="muted">{reportText.noExpiry}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="xkp" page={xoKeys} anchor="extended-open" count={xo.keys_allowed.length} />
                  <p className="hint">{auditor ? reportText.anAdministratorCanWithdrawPermission : <>{rich(reportText.withdrawPermissionIn, null, { value1: (<Link href="/admin/services?tab=keys#keys" prefetch={false}>{reportText.servicesAndKeys3}</Link>) })}</>}</p>
                </>
              ) : <p className="hint">{reportText.noKeysCurrentlyHavePermissionToWrite}</p>}
              {!xo.items.length ? <Empty>{reportText.noOpenRecordsWereWrittenByAgents}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.when}</th><th>{reportText.result}</th><th>{reportText.what}</th><th>{reportText.space}</th><th>{reportText.record}</th><th>{reportText.who}</th></tr></thead>
                      <tbody>
                        {xoItems.items.map((x, i) => (
                          <tr key={`${x.at}-${x.record_id ?? i}`}>
                            <td className="nowrap">{x.at ? <LocalTime iso={x.at} /> : <span className="muted">—</span>}</td>
                            <td><Badge tone={x.outcome === "written" ? "warn" : "neutral"}>{x.outcome === "written" ? reportText.writtenAndMarked : reportText.refused2}</Badge></td>
                            <td>{x.attempt ? EXTENDED_ATTEMPT_TITLES[x.attempt] ?? x.attempt : <span className="muted">—</span>}</td>
                            <td>{x.space ? spaceLink(x.space) : <span className="muted">—</span>}</td>
                            <td>{x.record_id ? <Code>{x.record_id}</Code> : <span className="muted">—</span>}</td>
                            <td>{x.by ? personLink(x.by) : <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="xop" page={xoItems} anchor="extended-open" count={xo.items.length} />
                </>
              )}
              {countedAll}
            </Section>
          ) : null}

          {d?.client_mismatch && mismatch ? (
            <Section title={reportText.keyProgramAndReportedClient} id="client-mismatch" fold={fold("client-mismatch", ["cmp"])} hint={reportText.aKeyIssuedForACloudAgent}>
              <div className="stat-tiles">
                <div className="stat-tile"><div className={`v ${d.client_mismatch.warn ? "warn" : ""}`}>{d.client_mismatch.warn}</div><div className="k">{reportText.mismatches}</div></div>
                <div className="stat-tile"><div className="v">{d.client_mismatch.info}</div><div className="k">{reportText.forInformation}</div></div>
                <div className="stat-tile"><div className="v">{d.client_mismatch.checked_keys}</div><div className="k">{rich(reportText.keysWithAReportedProgramInH, null, { value1: hours })}</div></div>
              </div>
              {!d.client_mismatch.count ? <Empty>{reportText.keyProgramsMatchedTheReportedClientsThroughout}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.keyOwner}</th><th>{reportText.keyProgram}</th><th>{reportText.reportedClient}</th><th>{reportText.severity}</th><th className="num">{reportText.events}</th><th>{reportText.latest}</th></tr></thead>
                      <tbody>
                        {mismatch.items.map((x) => (
                          <tr key={`${x.key_id}-${x.sent.name}-${x.sent.source}`}>
                            <td>
                              <Link href={`/admin/audit?key_id=${encodeURIComponent(x.key_id)}`} prefetch={false} title={reportText.auditEventsForThisKey}><Code>{x.key_prefix ? `${x.key_prefix}…` : x.key_id.slice(0, 8)}</Code></Link>
                              {x.person ? <div className="cell-sub"><Code>{x.person}</Code></div> : null}
                            </td>
                            <td>{clientKindTitle(x.key_client_kind)}</td>
                            <td>
                              <Code>{x.sent.version ? `${x.sent.name} ${x.sent.version}` : x.sent.name}</Code>
                              <div className="cell-sub">{CLAIMED_KIND_TITLES[x.sent_kind] ?? x.sent_kind} · {CLAIMED_SOURCE_TITLES[x.sent.source] ?? x.sent.source}{x.sent.ua && x.sent.source !== "user_agent" ? reportText.userAgent(x.sent.ua) : ""}</div>
                            </td>
                            <td><Badge tone={x.severity === "warn" ? "warn" : "neutral"}>{CLIENT_MISMATCH_TITLES[x.severity] ?? x.severity}</Badge></td>
                            <td className="num">{x.events}</td>
                            <td className="nowrap"><LocalTime iso={x.last_at} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="cmp" page={mismatch} anchor="client-mismatch" count={d.client_mismatch.count} />
                  <p className="hint">{reportText.forAMismatchAskTheKeyOwner}</p>
                </>
              )}
              {countedAll}
              {d.client_mismatch.unknown.length ? (
                <p className="hint cell-wrap">{rich(reportText.unrecognisedNotAMismatch, null, { value1: d.client_mismatch.unknown.map((u) => reportText.clientSummary(u.name, u.kind === "transport", u.events, u.keys)).join("; ") })}</p>
              ) : null}
            </Section>
          ) : null}

          {orv && orvMarks ? (
            <Section title={reportText.companyKnowledgeCuratorReview} id="org-review" fold={fold("org-review", ["orp"])} hint={reportText.theCurrentCompanyKnowledgeReviewQueueAnd}>
              {!orv.enabled ? <Notice tone="info">{reportText.curatorReviewIsOffTheAccessCategory}</Notice> : null}
              <div className="stat-tiles">
                <div className="stat-tile"><div className={`v ${orv.waiting ? "warn" : ""}`}>{orv.waiting}</div><div className="k">{rich(reportText.awaitingADecision, null, { value1: orv.oldest_entered_at ? <>{rich(reportText.oldest, null, { value1: (<LocalTime iso={orv.oldest_entered_at} short />) })}</> : null })}</div></div>
                <div className="stat-tile"><div className={`v ${orv.held ? "warn" : ""}`}>{orv.held}</div><div className="k">{reportText.hiddenAsWrong}</div></div>
                <div className="stat-tile"><div className="v">{orv.returned.auto}</div><div className="k">{reportText.returnedWhenDue}</div></div>
                <div className="stat-tile"><div className="v">{orv.confirmed + orv.community}</div><div className="k">{rich(reportText.confirmedCuratorsCommunity, null, { value1: orv.confirmed, value2: orv.community })}</div></div>
                <div className="stat-tile"><div className="v">{orv.curators.count}</div><div className="k">{reportText.curators}</div></div>
              </div>
              <p className="hint">{rich(reportText.returnedInThisPeriodWhenDueBy, null, { value1: orv.returned.count, value2: orv.returned.auto, value3: orv.returned.curator, value4: orv.returned.author, value5: orv.returned.narrowed ? reportText.afterNarrowingTheAudience(orv.returned.narrowed) : "", value6: orv.deleted, value7: orv.digests, value8: orv.due_week })}</p>
              {!orv.curators.count ? <Notice tone="warn">{rich(reportText.noCuratorsAssignedNobodyReviewsCompanyKnowledge, null, { value1: auditor ? null : <Link href="/admin/roles?tab=special#curators" prefetch={false}>{reportText.assignCurators}</Link> })}</Notice>
                : <p className="hint">{rich(reportText.curators2, null, { value1: orv.curators.logins.map((l, i) => <span key={l}>{i ? ", " : ""}{personLink(l)}</span>), value2: orv.curators.count > orv.curators.logins.length ? reportText.andMore(orv.curators.count - orv.curators.logins.length) : "" })}</p>}
              {!orv.wrong_marks.items.length ? <Empty>{reportText.noWrongNotForEveryoneFeedbackIn}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.when2}</th><th>{reportText.feedback}</th><th>{reportText.record2}</th><th>{reportText.reportedBy}</th></tr></thead>
                      <tbody>
                        {orvMarks.items.map((x, i) => (
                          <tr key={`${x.at}-${x.record_id}-${i}`}>
                            <td className="nowrap">{x.at ? <LocalTime iso={x.at} /> : <span className="muted">—</span>}</td>
                            <td>{x.reason === "wrong" ? reportText.wrong : x.reason === "not_for_all" ? reportText.notForEveryone : "—"}</td>
                            <td><Code>{x.record_id}</Code></td>
                            <td>{x.by ? personLink(x.by) : <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="orp" page={orvMarks} anchor="org-review" count={orv.wrong_marks.count} />
                </>
              )}
              {countedAll}
            </Section>
          ) : null}

          {res.data.open_check ? (
            <Section title={reportText.openCheck} id="open-check" fold={fold("open-check")} hint={reportText.recordsRefusedAsOpenInTheSelected}>
              {res.data.open_check.fallback ? (
                <p className="hint">{rich(reportText.savedAsClosedByTheOpenCheck, null, { value1: hours, value2: (<strong>{res.data.open_check.fallback.total}</strong>), value3: res.data.open_check.fallback.total ? <>{rich(reportText.kinds, null, { value1: Object.entries(res.data.open_check.fallback.by_via).sort(([, a], [, b]) => b - a).map(([via, n], i) => (
                      <span key={via}>{i ? ", " : ""}{OPEN_CHECK_VIA_TITLES[via] ?? via} — {n}</span>
                    )), value2: Object.entries(res.data.open_check.fallback.by_kind).sort(([, a], [, b]) => b - a).map(([k, n], i) => (
                      <span key={k}>{i ? ", " : ""}{OPEN_CHECK_KIND_TITLES[k] ?? k} — {n}</span>
                    )) })}</> : "." })}</p>
              ) : null}
              {res.data.class_moves?.by_word ? (
                <p className="hint">{rich(reportText.openedOnAPersonSInstructionIn, null, { value1: hours, value2: (<strong>{res.data.class_moves.by_word.agent_relayed}</strong>), value3: (<strong>{res.data.class_moves.by_word.human_workplace}</strong>), value4: (<strong>{res.data.class_moves.by_word.refused}</strong>) })}</p>
              ) : null}
              {res.data.class_moves?.by_word?.despite ? <DespiteReportBlock d={res.data.class_moves.by_word.despite} hours={hours} /> : null}
              {!res.data.open_check.refused ? <Empty>{reportText.noOpenCheckRefusalsInThisPeriod}</Empty> : (
                <>
                  <div className="stat-tiles">
                    <div className="stat-tile"><div className="v warn">{res.data.open_check.refused}</div><div className="k">{rich(reportText.refusalsInH, null, { value1: hours })}</div></div>
                    {Object.entries(res.data.open_check.by_kind ?? {}).sort(([, a], [, b]) => b - a).map(([k, n]) => (
                      <div className="stat-tile" key={k}><div className="v">{n}</div><div className="k">{OPEN_CHECK_KIND_TITLES[k] ?? k}</div></div>
                    ))}
                  </div>
                  <p className="hint">{rich(reportText.byWritePath, null, { value1: Object.entries(res.data.open_check.by_via ?? {}).sort(([, a], [, b]) => b - a).map(([via, n], i) => (
                      <span key={via}>{i ? ", " : ""}{OPEN_CHECK_VIA_TITLES[via] ?? via} — {n}</span>
                    )) })}</p>
                  {res.data.open_check.items?.length ? (
                    <TableWrap>
                      <table className="board">
                        <thead><tr><th>{reportText.when3}</th><th>{reportText.path}</th><th>{reportText.rules}</th><th>{reportText.space2}</th><th>{reportText.who2}</th></tr></thead>
                        <tbody>
                          {res.data.open_check.items.map((it, i) => (
                            <tr key={`${it.at}-${i}`}>
                              <td><LocalTime iso={it.at} /></td>
                              <td title={it.via ?? undefined}>{it.via ? OPEN_CHECK_VIA_TITLES[it.via] ?? it.via : "—"}</td>
                              <td>
                                <Chips items={it.rules} />
                                {it.kinds?.length ? <div className="cell-sub">{it.kinds.map((k) => OPEN_CHECK_KIND_TITLES[k] ?? k).join(", ")}</div> : null}
                                {it.unchecked ? <Badge tone="warn" title={reportText.refusedWithoutFindingsNothingToCheckOr}>{OPEN_CHECK_UNCHECKED_TITLES[it.unchecked] ?? it.unchecked}</Badge> : null}
                              </td>
                              <td>{it.space ? <Code>{it.space}</Code> : <span className="muted">—</span>}</td>
                              <td>{it.by ? <Code>{it.by}</Code> : <span className="muted">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  ) : null}
                </>
              )}
              {countedAll}
              <p className="hint">{rich(reportText.rulesCustomersWithStrictNDAsAndThe, null, { value1: auditor ? <>{reportText.openCheckUnavailableToAuditors}</> : <Link href="/admin/open-check" prefetch={false}>{reportText.openCheck2}</Link> })}</p>
            </Section>
          ) : null}

          {d?.new_spaces && newSpaces ? (
            <Section title={reportText.newSpaces} id="new-spaces" fold={fold("new-spaces", ["nsp"])} hint={reportText.spacesCreatedInTheSelectedPeriodExcluding}>
              {!d.new_spaces.count ? <Empty>{reportText.noNewSpacesInThisPeriod}</Empty> : (
                <>
                  <div className="stat-tiles">
                    <div className="stat-tile"><div className="v">{d.new_spaces.count}</div><div className="k">{rich(reportText.newInH, null, { value1: hours })}</div></div>
                    <div className="stat-tile"><div className={`v ${d.new_spaces.open ? "warn" : ""}`}>{d.new_spaces.open}</div><div className="k">{reportText.ofWhichOpen}</div></div>
                    {Object.entries(d.new_spaces.by_via).sort(([, a], [, b]) => b - a).map(([via, n]) => (
                      <div className="stat-tile" key={via}><div className="v">{n}</div><div className="k">{CREATED_VIA_TITLES[via] ?? via}</div></div>
                    ))}
                  </div>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.space3}</th><th>{reportText.kind}</th><th>{reportText.visibility}</th><th>{reportText.owner2}</th><th>{reportText.createdByVia}</th><th>{reportText.when4}</th><th className="num">{reportText.members}</th><th className="num">{reportText.aDGroups}</th></tr></thead>
                      <tbody>
                        {newSpaces.items.map((x) => (
                          <tr key={x.slug}>
                            <td>{spaceLink(x.slug)}<div className="cell-sub cell-wrap">{x.name}</div></td>
                            <td>{SPACE_KIND_TITLES[x.kind] ?? x.kind}</td>
                            <td><VisibilityBadge cls={x.default_class} tech /></td>
                            <td>{x.owner ? personLink(x.owner) : <span className="muted">—</span>}</td>
                            <td>{x.created_by ? personLink(x.created_by) : <span className="muted">—</span>}<div className="cell-sub">{x.created_via ? CREATED_VIA_TITLES[x.created_via] ?? x.created_via : "—"}</div></td>
                            <td><LocalTime iso={x.created_at} /></td>
                            <td className="num">{x.members_count}</td>
                            <td className="num">{x.groups_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="nsp" page={newSpaces} anchor="new-spaces" count={d.new_spaces.count} />
                  {countedAll}
                  {d.new_spaces.count > d.new_spaces.items.length ? <p className="hint">{rich(reportText.showingTheLatestOfSeeTheRest, null, { value1: d.new_spaces.items.length, value2: d.new_spaces.count, value3: auditor ? reportText.spaces : <Link href="/admin/spaces?sort=created" prefetch={false}>{reportText.spaces2}</Link> })}</p> : null}
                </>
              )}
            </Section>
          ) : null}

          {d?.group_binds && binds ? (
            <Section title={reportText.aDGroupBindings} id="group-binds" fold={fold("group-binds", ["gbp"])} hint={reportText.directoryGroupsBoundToSpacesByTheir}>
              {!d.group_binds.count ? <Empty>{reportText.noGroupBindingsAddedInThisPeriod}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.space4}</th><th>{reportText.group}</th><th>{reportText.memberRole}</th><th>{reportText.who3}</th><th className="num">{reportText.groupMembers}</th><th>{reportText.when5}</th></tr></thead>
                      <tbody>
                        {binds.items.map((x, i) => (
                          <tr key={`${x.slug}-${x.group}-${i}`}>
                            <td>{spaceLink(x.slug)}</td>
                            <td className="cell-wrap">{x.group}</td>
                            <td>{SPACE_ROLE_TITLES[x.role] ?? x.role}</td>
                            <td>{x.by ? personLink(x.by) : <span className="muted">—</span>}</td>
                            <td className="num">{x.members_matched ?? "—"}</td>
                            <td><LocalTime iso={x.at} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="gbp" page={binds} anchor="group-binds" count={d.group_binds.count} />
                  {d.group_binds.count > d.group_binds.items.length ? <p className="hint">{rich(reportText.showingTheLatestOfSeeTheRest2, null, { value1: d.group_binds.items.length, value2: d.group_binds.count })}</p> : null}
                </>
              )}
            </Section>
          ) : null}
          </div>

          <div className="report-part" id="not-period">
            <div className="report-part-head">
              <h2 className="report-part-title">{reportText.independentOfTheSelectedPeriod}</h2>
              <p className="hint">{reportText.weeklyDailyOrCurrentFiguresEachSection}</p>
            </div>

          {d && d.search_quality !== undefined ? <SearchQualityWeekSection sq={d.search_quality} fold={fold("search-quality")} counted={countedText("people", includeTest)} /> : null}
          {d && d.rollout !== undefined ? (
            <RolloutSection ro={d.rollout} page={param(sp, "rsp")} keep={keep} fold={fold("rollout", ["rsp"])} counted={countedText("people", includeTest)}
                            rulesChanged={!!d.rollout && d.search_quality?.week?.week_start === d.rollout.week_start && d.search_quality.week.rules_changed} />
          ) : null}

          {res.data.wide_grants_24h ? (
            <Section title={reportText.broadRoleAssignmentsInTheLast24} id="wide-grants" fold={fold("wide-grants")} hint={reportText.assignmentsOfMemoryAdministratorAuditorOrCompany}>
              {!res.data.wide_grants_24h.count ? <Empty>{reportText.noBroadRoleAssignmentsInTheLast}</Empty> : (
                <TableWrap>
                  <table className="board">
                    <thead><tr><th>{reportText.assignedTo}</th><th>{reportText.role}</th><th>{reportText.scope}</th><th>{reportText.when6}</th></tr></thead>
                    <tbody>
                      {res.data.wide_grants_24h.items.map((g) => (
                        <tr key={g.id}>
                          <td>{personLink(g.person)}</td>
                          <td title={g.role}>{ROLE_TITLES[g.role] ?? g.role}</td>
                          <td title={g.scope_kind}>{SCOPE_TITLES[g.scope_kind] ?? g.scope_kind}</td>
                          <td><LocalTime iso={g.created_at} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              {countedAll}
              <p className="hint">{rich(reportText.forAllActiveBroadRoleAssignmentsSee, null, { value1: auditor ? <>{reportText.rolesUnavailableToAuditors}</> : <Link href="/admin/roles#broad" prefetch={false}>{reportText.roles}</Link> })}</p>
            </Section>
          ) : null}

          {d?.space_class_changes && classChanges ? (
            <Section title={reportText.newRecordVisibilityChangesByOwners} id="class-changes" hint={reportText.aProjectOrTeamOwnerChangedWho}>
              {d.space_class_changes.unavailable ? <Notice tone="warn">{reportText.theAuditLogIsUnavailableChangesFor}</Notice>
                : !d.space_class_changes.count ? <Empty>{reportText.noChangesInThisPeriod}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.space5}</th><th>{reportText.before}</th><th>{reportText.after}</th><th>{reportText.who4}</th><th>{reportText.when7}</th></tr></thead>
                      <tbody>
                        {classChanges.items.map((x, i) => (
                          <tr key={`${x.slug}-${x.at}-${i}`}>
                            <td>{x.slug ? spaceLink(x.slug) : <span className="muted">—</span>}{x.name ? <div className="cell-sub cell-wrap">{x.name}</div> : null}</td>
                            <td><VisibilityBadge cls={x.from} tech /></td>
                            <td><VisibilityBadge cls={x.to} tech /></td>
                            <td>{x.by ? <Code>{x.by}</Code> : <span className="muted">—</span>}</td>
                            <td><LocalTime iso={x.at} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="scp" page={classChanges} anchor="class-changes" count={d.space_class_changes.count} />
                </>
              )}
            </Section>
          ) : null}

          {d?.group_sync && problems ? (
            <Section title={reportText.aDGroupSync} id="group-sync" fold={fold("group-sync", ["gsp"])} hint={/* i18n */ reportText.groupSyncHint}>
              <p className="hint">{rich(reportText.groupBindings, null, { value1: d.group_sync.bindings, value2: !d.group_sync.last ? reportText.noSyncYet : d.group_sync.last.ok
                  ? <>{rich(reportText.lastSyncGroupsMembershipsAddedRemoved, null, { value1: (<LocalTime iso={d.group_sync.last.at} />), value2: d.group_sync.last.groups, value3: d.group_sync.last.members_added, value4: d.group_sync.last.members_removed })}</>
                  : <span className="danger-text" title={d.group_sync.last.error_code ?? undefined}>{rich(reportText.lastSyncFailedTheDirectoryDidNot, null, { value1: (<LocalTime iso={d.group_sync.last.at} />) })}</span>, value3: auditor ? reportText.anAdministratorCanSyncNowInSign : <>{rich(reportText.syncNowIn, null, { value1: (<Link href="/admin/ldap#groups" prefetch={false}>{reportText.signInAndLDAP}</Link>) })}</> })}</p>
              {problems.total ? (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.space6}</th><th>{reportText.group2}</th><th>{reportText.status}</th><th>{reportText.since}</th></tr></thead>
                      <tbody>
                        {problems.items.map((x, i) => (
                          <tr key={`${x.slug}-${x.group}-${i}`}>
                            <td>{spaceLink(x.slug)}</td>
                            <td className="cell-wrap">{x.group}</td>
                            <td><Badge tone="warn">{GROUP_STATUS_TITLES[x.status] ?? x.status}</Badge></td>
                            <td>{x.since ? <LocalTime iso={x.since} /> : <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="gsp" page={problems} anchor="group-sync" />
                </>
              ) : null}
            </Section>
          ) : null}

          {d?.spaces_without_owner && orphans ? (
            <Section title={reportText.spacesWithoutAnActiveOwner} id="orphans" fold={fold("orphans", ["wop"])} hint={reportText.theOwnerHasLeftOrIsDisabled}>
              {!d.spaces_without_owner.count ? <Empty>{reportText.noSuchSpaces}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.space7}</th><th>{reportText.kind2}</th><th>{reportText.formerOwner}</th></tr></thead>
                      <tbody>
                        {orphans.items.map((x) => (
                          <tr key={x.slug}>
                            <td>{spaceLink(x.slug)}<div className="cell-sub cell-wrap">{x.name}</div></td>
                            <td>{SPACE_KIND_TITLES[x.kind] ?? x.kind}</td>
                            <td>{personLink(x.owner)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="wop" page={orphans} anchor="orphans" count={d.spaces_without_owner.count} />
                  {d.spaces_without_owner.count > d.spaces_without_owner.items.length ? (
                    <p className="hint">{rich(reportText.showingTheFirstOfSeeAllIn, null, { value1: d.spaces_without_owner.items.length, value2: d.spaces_without_owner.count, value3: auditor ? reportText.spaces3 : <Link href="/admin/spaces?owner=inactive" prefetch={false}>{reportText.spaces4}</Link> })}</p>
                  ) : null}
                </>
              )}
            </Section>
          ) : null}

          {d?.department_spaces_without_head && noHead ? (
            <Section title={reportText.departmentsWithoutAnActiveHead} id="dept-no-head" fold={fold("dept-no-head", ["dhp"])} hint={reportText.theDepartmentHasActiveEmployeesButNo}>
              {!d.department_spaces_without_head.count ? <Empty>{reportText.noSuchDepartments}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.departmentSpace}</th><th>{reportText.currentManager}</th><th>{reportText.formerHead}</th><th className="num">{reportText.activeEmployees}</th></tr></thead>
                      <tbody>
                        {noHead.items.map((x) => (
                          <tr key={x.slug}>
                            <td>{spaceLink(x.slug)}<div className="cell-sub cell-wrap">{x.name}</div></td>
                            <td>{x.managers?.length ? x.managers.map((m) => <div key={m}><Code>{m}</Code></div>) : <span className="muted">{reportText.memoryAdministrator}</span>}</td>
                            <td>{x.former_head ? <><Code>{x.former_head}</Code><div className="cell-sub">{x.former_head_active === false ? reportText.departedOrDisabled : reportText.noOwnerPermissions}</div></> : <span className="muted">—</span>}</td>
                            <td className="num">{x.members}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="dhp" page={noHead} anchor="dept-no-head" count={d.department_spaces_without_head.count} />
                  {d.department_spaces_without_head.count > d.department_spaces_without_head.items.length ? (
                    <p className="hint">{rich(reportText.showingTheFirstOf, null, { value1: d.department_spaces_without_head.items.length, value2: d.department_spaces_without_head.count })}</p>
                  ) : null}
                </>
              )}
            </Section>
          ) : null}

          {dm && dmNone ? (
            <Section title={DR.withoutTitle} id="dismissed-no-custodian" fold={fold("dismissed-no-custodian", ["dnp"])} hint={DR.withoutHint}>
              {!dm.without_custodian.count ? <Empty>{reportText.none}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{DR.colPerson}</th><th>{DR.colSince}</th></tr></thead>
                      <tbody>
                        {dmNone.items.map((x) => (
                          <tr key={x.login}>
                            <td>{personLink(x.login)}{x.display_name ? <div className="cell-sub">{x.display_name}</div> : null}</td>
                            <td>{custodyDay(x.since, tz) ?? <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="dnp" page={dmNone} anchor="dismissed-no-custodian" count={dm.without_custodian.count} />
                  {dm.without_custodian.count > dm.without_custodian.items.length ? <p className="hint">{rich(reportText.showingTheFirstOf2, null, { value1: dm.without_custodian.items.length, value2: dm.without_custodian.count })}</p> : null}
                </>
              )}
            </Section>
          ) : null}

          {dm && dmManual ? (
            <Section title={DR.manualTitle} id="dismissed-manual" fold={fold("dismissed-manual", ["dmp"])} hint={DR.manualHint}>
              {!dm.manual.count ? <Empty>{reportText.none2}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{DR.colPerson}</th><th>{DR.colCustodian}</th><th>{DR.colReason}</th><th>{DR.colWhen}</th></tr></thead>
                      <tbody>
                        {dmManual.items.map((x) => (
                          <tr key={x.login}>
                            <td>{personLink(x.login)}{x.display_name ? <div className="cell-sub">{x.display_name}</div> : null}</td>
                            <td>{personLink(x.custodian.login)}{x.custodian.display_name ? <div className="cell-sub">{x.custodian.display_name}</div> : null}</td>
                            <td className="cell-wrap">{x.reason ?? <span className="muted">—</span>}</td>
                            <td>{custodyDay(x.at, tz) ?? <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="dmp" page={dmManual} anchor="dismissed-manual" count={dm.manual.count} />
                  {dm.manual.count > dm.manual.items.length ? <p className="hint">{rich(reportText.showingTheFirstOf3, null, { value1: dm.manual.items.length, value2: dm.manual.count })}</p> : null}
                </>
              )}
            </Section>
          ) : null}

          {dm && dmStuck ? (
            <Section title={DR.stuckTitle} id="dismissed-stuck" fold={fold("dismissed-stuck", ["dsp"])} hint={DR.stuckHint}>
              {!dm.meetings_stuck.count ? <Empty>{reportText.none3}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{DR.colPerson}</th><th className="num">{DR.colWaiting}</th><th className="num">{DR.colPasses}</th></tr></thead>
                      <tbody>
                        {dmStuck.items.map((x) => (
                          <tr key={x.login}>
                            <td>{personLink(x.login)}{x.display_name ? <div className="cell-sub">{x.display_name}</div> : null}</td>
                            <td className="num">{x.waiting}</td>
                            <td className="num">{x.busy_passes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="dsp" page={dmStuck} anchor="dismissed-stuck" count={dm.meetings_stuck.count} />
                  {dm.meetings_stuck.count > dm.meetings_stuck.items.length ? <p className="hint">{rich(reportText.showingTheFirstOf4, null, { value1: dm.meetings_stuck.items.length, value2: dm.meetings_stuck.count })}</p> : null}
                </>
              )}
            </Section>
          ) : null}

          {dm?.by_operator && dmOperator ? (
            <Section title={DR.operatorTitle} id="dismissed-operator" fold={fold("dismissed-operator", ["dop"])} hint={DR.operatorHint}>
              {!dm.by_operator.count ? <Empty>{reportText.none4}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{DR.colPerson}</th><th>{DR.colCustodian}</th><th>{DR.colUpload}</th><th>{DR.colWhen}</th></tr></thead>
                      <tbody>
                        {dmOperator.items.map((x) => (
                          <tr key={x.login}>
                            <td>{personLink(x.login)}{x.display_name ? <div className="cell-sub">{x.display_name}</div> : null}</td>
                            <td>{personLink(x.custodian.login)}{x.custodian.display_name ? <div className="cell-sub">{x.custodian.display_name}</div> : null}</td>
                            <td><Code>{x.by.replace(/^panel:/, "")}</Code></td>
                            <td>{custodyDay(x.at, tz) ?? <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="dop" page={dmOperator} anchor="dismissed-operator" count={dm.by_operator.count} />
                  {dm.by_operator.count > dm.by_operator.items.length ? <p className="hint">{rich(reportText.showingTheFirstOf5, null, { value1: dm.by_operator.items.length, value2: dm.by_operator.count })}</p> : null}
                </>
              )}
            </Section>
          ) : null}

          {d?.project_tags !== undefined ? (
            <Section title={reportText.projectLinks} id="project-tags" fold={fold("project-tags")} hint={reportText.theLatestCheckOfAllProjectsIncluding}>
              {d.project_tags === null ? <Empty>{reportText.projectLinksHaveNotBeenCheckedYet}</Empty> : (
                <>
                  <p className="hint">{rich(reportText.checkedProjectEntitiesRecordLinksAddedOpen, null, { value1: (<LocalTime iso={d.project_tags.at} />), value2: d.project_tags.entities, value3: d.project_tags.tagged_open, value4: d.project_tags.tagged_closed })}</p>
                  {d.project_tags.collisions ? (
                    <p className="danger-text">{rich(reportText.conflictingProjectsTheirIdentifiersAreAlreadyUsed, null, { value1: (<strong>{d.project_tags.collisions}</strong>) })}</p>
                  ) : <Empty>{reportText.noConflictsFound}</Empty>}
                </>
              )}
            </Section>
          ) : null}

          {d?.space_meta_findings && metaFound ? (
            <Section title={reportText.spaceNamesWithFindings} id="space-meta" fold={fold("space-meta", ["smp"])} hint={reportText.activeSpacesExcludingPersonalAndDepartmentSpaces}>
              {d.space_meta_findings.unchecked ? <p className="hint">{rich(reportText.theCheckTimedOutAfterCheckingSpaces, null, { value1: (<Badge tone="warn">{reportText.incompleteList}</Badge>), value2: d.space_meta_findings.checked })}</p> : null}
              {!d.space_meta_findings.count ? <Empty>{d.space_meta_findings.checked ? reportText.spacesCheckedNoFindings(d.space_meta_findings.checked) : reportText.openCheckIsOffOrThereAre}</Empty> : (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.space8}</th><th>{reportText.kindVisibility}</th><th>{reportText.findings}</th></tr></thead>
                      <tbody>
                        {metaFound.items.map((x) => (
                          <tr key={x.slug}>
                            <td>{spaceLink(x.slug)}</td>
                            <td>{SPACE_KIND_TITLES[x.kind] ?? x.kind} · <VisibilityBadge cls={x.default_class} tech /></td>
                            <td>{x.findings.map((f, i) => <div key={i} className={i ? "cell-sub" : undefined} title={reportText.rule(f.rule)}>{OPEN_CHECK_FIELD_TITLES[f.field] ?? f.field} — {OPEN_CHECK_KIND_TITLES[f.kind] ?? f.kind}</div>)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="smp" page={metaFound} anchor="space-meta" count={d.space_meta_findings.count} />
                  {d.space_meta_findings.count > d.space_meta_findings.items.length ? <p className="hint">{rich(reportText.showingTheFirstOfFixOrArchive, null, { value1: d.space_meta_findings.items.length, value2: d.space_meta_findings.count })}</p> : null}
                </>
              )}
            </Section>
          ) : null}

          {d && d.backups !== undefined ? (() => {
            const bv = backupView(d.backups, new Date(), tz);
            return (
              <Section title={reportText.serverBackups} id="backups" fold={fold("backups")} hint={reportText.memoryDatabaseBackupsOnTheServerCreated}>
                {bv.lines.map((l, i) => <Notice key={i} tone={l.tone}>{l.text}</Notice>)}
                {bv.names.map((g) => (
                  <p key={g.title} className="hint">{g.title}: {g.names.map((x, i) => <span key={x}>{i ? ", " : null}<Code>{x}</Code></span>)}{g.more ? <>{rich(reportText.andMore2, null, { value1: formatCount(g.more) })}</> : null}</p>
                ))}
              </Section>
            );
          })() : null}

          {d?.test_leftovers !== undefined ? (
            <Section title={reportText.testLeftovers} id="test-leftovers" fold={fold("test-leftovers", ["tlp"])} hint={reportText.recordsAndSpacesLeftByChecksUsing}>
              {!tl ? <Empty>{reportText.noRunYet}</Empty> : (
                <>
                  <p className="hint">{rich(reportText.lastRunModeGracePeriodAfterDisabling, null, { value1: (<LocalTime iso={tl.at} />), value2: LEFTOVERS_SCOPE_TITLES[tl.scope] ?? tl.scope, value3: tl.scope === "off" ? reportText.theJobDoesNotDeleteOrArchive : "", value4: graceTitle(tl.grace_minutes), value5: tl.more && !tl.error ? reportText.theRunHasMoreWorkTheNext : "" })}</p>
                  {tl.error ? <p className="danger-text">{reportText.theLastRunFailedDeletionAndArchiving}</p> : null}
                  <div className="stat-tiles">
                    <div className="stat-tile"><div className="v">{formatCount(leftoverCount(tl.pass?.retired))}</div><div className="k">{reportText.recordsDeletedThisRun}</div></div>
                    <div className="stat-tile"><div className="v">{formatCount(leftoverCount(tl.pass?.archived))}</div><div className="k">{reportText.spacesArchivedThisRun}</div></div>
                    <div className="stat-tile"><div className="v">{formatCount(leftoverCount(tl.total?.retired))}</div><div className="k">{rich(reportText.recordsDeleted, null, { value1: tl.total?.since ? <>{rich(reportText.since2, null, { value1: (<LocalTime iso={tl.total.since} short relative={false} />) })}</> : reportText.inTotal })}</div></div>
                    <div className="stat-tile"><div className="v">{formatCount(leftoverCount(tl.total?.archived))}</div><div className="k">{rich(reportText.spacesArchived, null, { value1: tl.total?.since ? <>{rich(reportText.since3, null, { value1: (<LocalTime iso={tl.total.since} short relative={false} />) })}</> : reportText.inTotal2 })}</div></div>
                    <div className="stat-tile"><div className={`v ${tlWaiting.people ? "warn" : ""}`}>{formatCount(tlWaiting.people)}</div><div className="k">{reportText.peopleAwaitingTheGracePeriod}</div></div>
                  </div>
                  {kinds(tl.pass?.retired) || kinds(tl.pass?.archived) ? (
                    <p className="hint">{[kinds(tl.pass?.retired) ? reportText.deletedThisRun(kinds(tl.pass?.retired)) : "", kinds(tl.pass?.archived) ? reportText.archivedThisRun(kinds(tl.pass?.archived)) : ""].filter(Boolean).join(" ")}</p>
                  ) : null}
                  {leftoverCount(tl.pass?.trash_expired) || leftoverCount(tl.pass?.orphans) ? (
                    <p className="hint">
                      {leftoverCount(tl.pass?.trash_expired) ? reportText.clearedFromCompanyKnowledgeTrash(formatCount(leftoverCount(tl.pass?.trash_expired))) : ""}
                      {leftoverCount(tl.pass?.orphans) ? reportText.removedLinksToDeletedRecords(formatCount(leftoverCount(tl.pass?.orphans))) : ""}
                    </p>
                  ) : null}
                  {tlWaiting.people || tlWaiting.records || tlWaiting.spaces ? (
                    <p className="hint">{rich(reportText.waitingPeopleAndRecordsUntilHasPassed, null, { value1: formatCount(tlWaiting.people), value2: formatCount(tlWaiting.records), value3: graceTitle(tl.grace_minutes), value4: formatCount(tlWaiting.spaces) })}</p>
                  ) : null}

                  {tlSkipped.length ? (
                    <>
                      <p className="hint">{reportText.testAccountRecordsThatTheJobAlways}</p>
                      <TableWrap>
                        <table className="board">
                          <thead><tr><th>{reportText.whyTheRecordWasKept}</th><th className="num">{reportText.records}</th></tr></thead>
                          <tbody>
                            {tlSkipped.map(([k, n]) => <tr key={k}><td>{LEFTOVERS_SKIPPED_TITLES[k] ?? k}</td><td className="num">{formatCount(n)}</td></tr>)}
                          </tbody>
                        </table>
                      </TableWrap>
                    </>
                  ) : null}

                  {tl.kept?.count && tlKept ? (
                    <>
                      <p className="hint">{reportText.testSpacesThatRemainActiveTheyCannot}</p>
                      <TableWrap>
                        <table className="board">
                          <thead><tr><th>{reportText.space9}</th><th>{reportText.kind3}</th><th>{reportText.whyItWasKept}</th><th className="num">{reportText.employeeRecords}</th><th className="num">{reportText.employeeMembers}</th></tr></thead>
                          <tbody>
                            {tlKept.items.map((x) => (
                              <tr key={x.slug}>
                                <td>{x.name}<div className="cell-sub">{spaceLink(x.slug)}</div></td>
                                <td>{SPACE_KIND_TITLES[x.kind] ?? x.kind}</td>
                                <td>{LEFTOVERS_KEPT_TITLES[x.reason] ?? x.reason}</td>
                                <td className="num">{formatCount(x.staff_records)}</td>
                                <td className="num">{formatCount(x.staff_members)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableWrap>
                      <LocalPager path="/admin/report" params={keep} pageName="tlp" page={tlKept} anchor="test-leftovers" count={tl.kept.count} />
                      {tl.kept.count > tl.kept.items.length ? <p className="hint">{rich(reportText.showingTheFirstOfTheRestWill, null, { value1: tl.kept.items.length, value2: tl.kept.count })}</p> : null}
                    </>
                  ) : null}

                  {leftoverCount(tl.outside_their_spaces) ? (
                    <p className="hint">{rich(reportText.testAccountRecordsInOtherPeopleS, null, { value1: formatCount(leftoverCount(tl.outside_their_spaces)) })}</p>
                  ) : null}
                  {leftoverCount(tl.attr_test_other_domain) ? (
                    <p className="hint">{rich(reportText.peopleMarkedTestWithRealAddressesChecks, null, { value1: formatCount(leftoverCount(tl.attr_test_other_domain)), value2: tl.attr_test_other_domain_logins?.length ? ":" : reportText.seePeople, value3: tl.attr_test_other_domain_logins?.length ? <>{" "}{tl.attr_test_other_domain_logins.map((l, i) => <span key={l}>{i ? ", " : ""}{personLink(l)}</span>)}{leftoverCount(tl.attr_test_other_domain) > tl.attr_test_other_domain_logins.length ? reportText.showingTheFirst(formatCount(tl.attr_test_other_domain_logins.length)) : ""}.</> : null })}</p>
                  ) : null}
                  {tl.active_test?.count ? (
                    <p className={tl.active_test.older_than_24h ? "danger-text" : "hint"}>{rich(reportText.activeTestAccounts, null, { value1: formatCount(tl.active_test.count), value2: tl.active_test.older_than_24h ? <>{rich(reportText.ofWhichActiveForOver24Hours, null, { value1: formatCount(tl.active_test.older_than_24h), value2: auditor ? null : <Link href="/admin/people?test=true" prefetch={false}>{reportText.testAccountsOnlyFilter}</Link> })}</> : reportText.usuallyACheckStillRunning })}</p>
                  ) : null}
                </>
              )}
            </Section>
          ) : null}

          {tp ? (
            <Section title={reportText.permanentTestCleanup} id="test-purge" fold={fold("test-purge")} hint={reportText.disabledTestAccountsTheirArchivedSpacesKeys(tp.after_hours)}>
              <p className="hint">{rich(reportText.mode, null, { value1: TEST_PURGE_MODE_TITLES[tp.mode] ?? tp.mode, value2: tp.mode === "off" ? reportText.nothingIsDeleted : "", value3: tp.last_auto ? <>{rich(reportText.lastRunDeleted, null, { value1: (<LocalTime iso={tp.last_auto.at} />), value2: formatCount(testPurgeTotal(tp.last_auto.totals)), value3: tp.last_auto.busy ? reportText.busyAndDeferred(formatCount(tp.last_auto.busy)) : "" })}</> : reportText.noAutomaticRunsYet, value4: tp.last_manual ? <>{rich(reportText.oneOffPlannedDeletionDeleted, null, { value1: (<LocalTime iso={tp.last_manual.at} />), value2: formatCount(testPurgeTotal(tp.last_manual.totals)) })}</> : null })}</p>
              {tpBlocked.length ? (
                <p className="danger-text">{rich(reportText.stoppedAutomaticDeletionWillStayStoppedUntil, null, { value1: tpBlocked.map((c, i) => <span key={c} title={c}>{i ? "; " : ""}{TEST_PURGE_STOP_TITLES[c] ?? reportText.seeTheWorkerLogForTheReason}</span>) })}</p>
              ) : null}
              {tpBacklog.length ? (
                <p className="hint">{rich(reportText.awaitingTheGracePeriodOrNextRun, null, { value1: tpBacklog.map(([k, n]) => `${TEST_PURGE_BACKLOG_TITLES[k] ?? k} — ${formatCount(n)}`).join(", ") })}</p>
              ) : tp.last_auto ? <p className="hint">{reportText.nothingAwaitingTheGracePeriod}</p> : null}
              {tp.smoke.overdue ? (
                <p className="danger-text">{rich(reportText.postDeploymentTestSpacesArchivedBeyondThe, null, { value1: formatCount(tp.smoke.overdue) })}</p>
              ) : null}
            </Section>
          ) : null}
          {d && mtr !== undefined ? (
            <Section title={reportText.occurredAtTimesSavedBeforeTheFix} id="manual-time" fold={fold("manual-time", ["mtp"])} hint={reportText.previouslyATimeEnteredManuallyInThe}>
              {!mtr ? <Notice tone="warn">{reportText.couldNotCalculateThisSectionOpenThe}</Notice>
                : !mtr.count ? <Empty>{reportText.noSuchRecordsToCheck}</Empty> : mtrItems ? (
                <>
                  <TableWrap>
                    <table className="board">
                      <thead><tr><th>{reportText.author}</th><th>{reportText.created}</th><th>{reportText.record3}</th></tr></thead>
                      <tbody>
                        {mtrItems.items.map((x) => (
                          <tr key={x.id}>
                            <td>{x.author ? personLink(x.author) : <span className="muted">—</span>}</td>
                            <td><LocalTime iso={x.created_at} /></td>
                            <td>{auditor ? <Code title={x.id}>{x.id}</Code> : <Link href={`/admin/search?q=${encodeURIComponent(x.id)}`} prefetch={false} title={reportText.recordDetails}><Code>{x.id}</Code></Link>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                  <LocalPager path="/admin/report" params={keep} pageName="mtp" page={mtrItems} anchor="manual-time" count={mtr.count} />
                  <p className="hint">{rich(reportText.askTheAuthorToCheckOccurredAt, null, { value1: (<LocalTime iso={mtr.since} relative={false} />) })}</p>
                </>
              ) : null}
            </Section>
          ) : null}

          </div>
        </>
      )}
    </PageFrame>
  );
}
