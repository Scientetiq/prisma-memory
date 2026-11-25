import { derived, derivedList } from "@/i18n/runtime";
import { peoplePage } from "@/messages/panel-people";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminTabs } from "@/components/admin-tabs";
import { mailBreak } from "@/components/mail-break";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { CursorPager, LocalPager } from "@/components/pager";
import { Badge, Chips, Code, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { PEOPLE_TABS, pickTab, tabHref } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import { policyFromSettings } from "@/lib/custody-view";
import { legacyCharsetFromSettings } from "@/lib/legacy-charset";
import { deactivationEffects, isTestPerson, PEOPLE_STATUS_TITLES, type PeopleStatus } from "@/lib/labels";
import { ORG_TABLE_SAMPLE_NAME, orgTableSampleHref } from "@/lib/org-sample";
import { CSV_COLUMNS } from "@/lib/people-csv";
import { hrefWith, offsetOf, PAGE_SIZE, param, slicePage, type SearchParams } from "@/lib/paging";
import type { OrgUnit, Page, Person, SettingsResponse } from "@/lib/types";
import { previewDeactivationAction, uploadOrgUnitsAction, uploadPeopleAction } from "./actions";
import { OrgUnitsUploadForm, PeopleUploadForm } from "./upload-forms";

export function generateMetadata(): Metadata { return { title: peoplePage.peopleAndOrganisation }; }

const RELATION_TITLES: Record<string, string> = derived(() => ({ head: peoplePage.head, deputy: peoplePage.deputy }));
const STATUSES = derivedList(() => Object.keys(PEOPLE_STATUS_TITLES) as PeopleStatus[]);

export default async function PeoplePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const tab = pickTab(param(sp, "tab"), PEOPLE_TABS, "people");
  const q = param(sp, "q"), cursor = param(sp, "cursor"), ouPage = param(sp, "ou");
  const asked = param(sp, "active");
  const active: PeopleStatus = (STATUSES as string[]).includes(asked) ? asked as PeopleStatus : "true";
  const test = param(sp, "test") === "true";
  const params = { tab: tab === "people" ? "" : tab, q, active: active === "true" ? "" : active, test: test ? "true" : "", cursor, ou: ouPage };
  const offset = offsetOf(cursor);

  const [people, units, settings] = await Promise.all([
    tab === "people" ? tryGw<Page<Person>>("/api/v1/admin/people", { query: { limit: PAGE_SIZE, cursor: offset || undefined, q, active: active === "all" ? undefined : active, test: test ? "true" : undefined } }) : null,
    tab === "units" ? tryGw<{ items: OrgUnit[] }>("/api/v1/admin/org-units") : null,
    tab === "import" ? tryGw<SettingsResponse>("/api/v1/admin/settings") : null,
  ]);
  const effects = deactivationEffects(policyFromSettings(settings?.ok ? settings.data.items : null));
  const legacyCharset = legacyCharsetFromSettings(settings?.ok ? settings.data.items : null);
  const unitsPage = units?.ok ? slicePage(units.data.items, ouPage) : null;
  const inArchive = people?.ok && !people.data.items.length && !cursor && active === "true"
    ? await tryGw<Page<Person>>("/api/v1/admin/people", { query: { limit: 1, q, active: "false", test: test ? "true" : undefined } }).then((r) => r.ok && r.data.items.length > 0)
    : false;
  const empty = cursor ? peoplePage.noPeopleOnThisPage : q ? peoplePage.noPeopleFound : test ? (active === "true" ? peoplePage.noEnabledTestAccounts : peoplePage.noTestAccounts) : active === "false" ? peoplePage.noDeactivatedPeople
    : active === "true" && inArchive ? peoplePage.noActivePeople : peoplePage.theOrgTableIsEmptyUploadIt;

  return (
    <PageFrame title={peoplePage.peopleAndOrganisation} lead={peoplePage.theOrgTableSuppliesPeopleDepartmentsAnd}>
      <AdminTabs path="/admin/people" tabs={PEOPLE_TABS} active={tab} fallback="people" label={peoplePage.peoplePageSections} />

      {people ? <Section title={peoplePage.people} id="people" icon="users" hint={peoplePage.openAPersonSNameToSee}>
        <form method="get" action="/admin/people" className="filter-form">
          <label className="field">
            <span className="field-label">{peoplePage.searchByLoginOrName}</span>
            <input type="search" name="q" defaultValue={q} placeholder={peoplePage.partOfALoginOrName} />
          </label>
          <label className="field">
            <span className="field-label">{peoplePage.status}</span>
            <select name="active" defaultValue={active}>
              {STATUSES.map((s) => <option key={s} value={s}>{PEOPLE_STATUS_TITLES[s]}</option>)}
            </select>
          </label>
          <label className="check">{rich(peoplePage.testAccountsOnly, {  }, { value0: <input type="checkbox" name="test" value="true" defaultChecked={test} /> })}</label>
          <button type="submit" className="btn">{peoplePage.find}</button>
          {q || params.active || test ? <Link href="/admin/people" prefetch={false} className="quiet">{peoplePage.reset}</Link> : null}
        </form>
        {test ? <p className="hint">{peoplePage.testAccountsUseExampleCorpOrA}</p> : null}

        {!people.ok ? <LoadError result={people} what={peoplePage.peopleList} /> : !people.data.items.length ? (
          <>
            <Empty icon="users">{empty}</Empty>
            {inArchive ? <p className="hint">{rich(peoplePage.thereAreDeactivatedShow, { link0: (children) => <Link href={hrefWith("/admin/people", { q, test: test ? "true" : "" }, { active: "false" })} prefetch={false}>{children}</Link> }, { value0: q ? peoplePage.matches : peoplePage.peopleLabel })}</p> : null}
            {cursor ? <CursorPager path="/admin/people" params={params} cursorName="cursor" cursor={cursor} nextCursor={null} prevCursor={String(Math.max(0, offset - PAGE_SIZE))} shown={0} anchor="people" /> : null}
          </>
        ) : (
          <>
            <TableWrap cards>
              <table className="board people-board">
                <thead>
                  <tr><th>{peoplePage.person}</th><th>{peoplePage.status}</th><th>{peoplePage.department}</th><th>{peoplePage.manager}</th><th>{peoplePage.jobTitle}</th><th>{peoplePage.personalSpace}</th><th>{peoplePage.externalAccounts}</th></tr>
                </thead>
                <tbody>
                  {people.data.items.map((p) => {
                    const rel = p.attrs?.unit_relation ? RELATION_TITLES[p.attrs.unit_relation] : null;
                    const identities = (p.attrs?.identities ?? []).map((i) => peoplePage.message(i.system, i.external_id, i.verified === true ? "" : peoplePage.unverified));
                    return (
                      <tr key={p.id} className={p.active ? undefined : "off"}>
                        <td data-label={peoplePage.person}>
                          <Link href={`/admin/people/${encodeURIComponent(p.login)}`} prefetch={false} title={peoplePage.permissionsAndVisibility} className="cell-main">{p.display_name || p.login}</Link>
                          {p.attrs?.demo === true ? <> <Badge tone="violet">{peoplePage.demo}</Badge></> : null}
                          {isTestPerson(p) ? <> <Badge tone="muted" title={peoplePage.testAccountATestMarkerExampleCorp}>{peoplePage.test}</Badge></> : null}
                          <div className="cell-sub"><Code>{mailBreak(p.login)}</Code>{p.employee_id ? peoplePage.employeeNo(p.employee_id) : null}</div>
                        </td>
                        <td data-label={peoplePage.status}>{p.active ? <Badge tone="ok">{peoplePage.active}</Badge> : <Badge tone="muted">{peoplePage.deactivated}</Badge>}</td>
                        <td data-label={peoplePage.department}>
                          {p.department ?? <span className="muted">—</span>}
                          {p.attrs?.department_code ? <div className="cell-sub">{rich(peoplePage.code, {  }, { value0: p.attrs.department_code })}</div> : null}
                          {rel ? <div><Badge tone="info">{rel}</Badge></div> : null}
                        </td>
                        <td data-label={peoplePage.manager}>{p.manager_login ? <Code>{mailBreak(p.manager_login)}</Code> : <span className="muted">—</span>}</td>
                        <td data-label={peoplePage.jobTitle}>{p.role ?? <span className="muted">—</span>}</td>
                        <td data-label={peoplePage.personalSpace}>{p.personal_space ? <Code>{p.personal_space}</Code> : <span className="muted">—</span>}</td>
                        <td data-label={peoplePage.externalAccounts}><Chips items={identities} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/people" params={params} cursorName="cursor" cursor={cursor} nextCursor={people.data.next_cursor}
              prevCursor={offset ? String(Math.max(0, offset - PAGE_SIZE)) : null} shown={people.data.items.length} anchor="people" />
          </>
        )}
      </Section> : null}

      {tab === "import" ? <>
      <Section title={peoplePage.uploadOrgTable} id="upload" hint={<>{rich(peoplePage.anHRFileCSVFromExcelOr, { code0: (children) => <Code>{children}</Code>, code1: (children) => <Code>{children}</Code>, code2: (children) => <Code>{children}</Code>, code3: (children) => <Code>{children}</Code>, code4: (children) => <Code>{children}</Code>, code5: (children) => <Code>{children}</Code>, code6: (children) => <Code>{children}</Code> }, { value0: CSV_COLUMNS.join(", ") })}</>}>
        <details className="how-details"><summary>{peoplePage.forIntegrators}</summary><p>{rich(peoplePage.theSameUploadViaTheAPISend, { code0: (children) => <Code>{children}</Code> })}</p></details>
        <p className="form-row"><a className="btn" href={orgTableSampleHref()} download={ORG_TABLE_SAMPLE_NAME}>{peoplePage.downloadSampleCSV}</a> <span className="hint">{peoplePage.firstTeamDepartmentCodesEmployeeNumbersAnd}</span></p>
        <PeopleUploadForm action={uploadPeopleAction} preview={previewDeactivationAction} effects={effects} legacyCharset={legacyCharset} />
      </Section>

      <Section title={peoplePage.uploadOrgUnits} id="org-units-upload" hint={<>{rich(peoplePage.jSONEachUnitHasCodeAndName, { code0: (children) => <Code>{children}</Code>, code1: (children) => <Code>{children}</Code>, code2: (children) => <Code>{children}</Code>, code3: (children) => <Code>{children}</Code>, code4: (children) => <Code>{children}</Code> })}</>}>
        <details className="how-details"><summary>{peoplePage.forIntegrators}</summary><p>{rich(peoplePage.theSameUploadViaTheAPIPUT, { code0: (children) => <Code>{children}</Code> })}</p></details>
        <OrgUnitsUploadForm action={uploadOrgUnitsAction} legacyCharset={legacyCharset} />
      </Section>
      </> : null}

      {units ? <Section title={peoplePage.departments} id="org-units" hint={<>{rich(peoplePage.departmentsWithTheirParentManagersAndSpace, { link0: (children) => <Link href={tabHref("/admin/people", "import", "people")} prefetch={false}>{children}</Link> })}</>}>
        {!units.ok ? <LoadError result={units} what={peoplePage.orgUnits} /> : !unitsPage?.total ? <Empty>{peoplePage.noOrgUnitsYet}</Empty> : (
          <>
            <TableWrap>
              <table className="board">
                <thead>
                  <tr><th>{peoplePage.codeLabel}</th><th>{peoplePage.name}</th><th>{peoplePage.parent}</th><th>{peoplePage.managers}</th><th className="num">{peoplePage.members}</th><th>{peoplePage.space}</th><th>{peoplePage.status}</th></tr>
                </thead>
                <tbody>
                  {unitsPage.items.map((u) => (
                    <tr key={u.code} className={u.active ? undefined : "off"}>
                      <td><Code>{u.code}</Code></td>
                      <td>{u.name}{u.demo ? <> <Badge tone="violet" title={peoplePage.roleShowcaseOrgUnitFictionalPeopleAnd}>{peoplePage.demo}</Badge></> : null}</td>
                      <td>{u.parent_code ? <Code>{u.parent_code}</Code> : <span className="muted">—</span>}</td>
                      <td><Chips items={u.heads} empty={peoplePage.notDetermined} /></td>
                      <td className="num">{u.members}</td>
                      <td>{u.space ? <Code>{u.space}</Code> : <span className="muted">{peoplePage.none}</span>}</td>
                      <td>{u.active ? <Badge tone="ok">{peoplePage.activeLabel}</Badge> : <Badge tone="muted">{peoplePage.inactive}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LocalPager path="/admin/people" params={params} pageName="ou" page={unitsPage} anchor="org-units" />
          </>
        )}
      </Section> : null}
    </PageFrame>
  );
}
