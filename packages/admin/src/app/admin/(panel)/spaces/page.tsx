import { derivedList } from "@/i18n/runtime";
import { spacesPage } from "@/messages/panel-spaces";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { guardAuditorPage } from "@/lib/admin-guard";
import { CursorPager } from "@/components/pager";
import { Badge, Code, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { tryGw } from "@/lib/api";
import { CLOSED_CLASS_TEXT } from "@/lib/closed-class";
import { CREATED_VIA_TITLES, SPACE_KIND_TITLES, SPACE_STATUS_TITLES, type SpaceStatus } from "@/lib/labels";
import { hrefWith, offsetOf, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { formatCount } from "@/lib/plain";
import type { SpacesPage } from "@/lib/types";
import { createSpaceAction } from "./actions";

export function generateMetadata(): Metadata { return { title: spacesPage.spaces }; }

const KINDS = ["personal", "team", "project", "org"] as const;
const ALL_KINDS = "all";
const STATUSES = derivedList(() => Object.keys(SPACE_STATUS_TITLES) as SpaceStatus[]);


export default async function SpacesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const asked = param(sp, "kind"), cursor = param(sp, "cursor");
  const kind = (KINDS as readonly string[]).includes(asked) || asked === ALL_KINDS ? asked : "";
  const askedQ = param(sp, "q").replace(/\s+/g, " ").trim().slice(0, 100);
  const q = askedQ.length >= 2 ? askedQ : "";
  const sort = param(sp, "sort") === "created" ? "created" : "";
  const owner = param(sp, "owner") === "inactive" ? "inactive" : "";
  const askedStatus = param(sp, "status");
  const status: SpaceStatus = !owner && (STATUSES as string[]).includes(askedStatus) ? askedStatus as SpaceStatus : "active";
  const params = { q, kind, sort, owner, status: status === "active" ? "" : status, cursor };
  const offset = offsetOf(cursor);

  const spaces = await tryGw<SpacesPage>("/api/v1/admin/spaces", { query: { kind: kind === ALL_KINDS ? undefined : kind, exclude: kind ? undefined : "personal", q: q || undefined,
                                                                         status, sort: sort || undefined, owner: owner || undefined, limit: PAGE_SIZE, cursor: offset || undefined } });
  const archivedTotal = spaces.ok && status === "active" && !owner ? spaces.data.totals?.archived ?? 0 : 0;
  const empty = cursor ? spacesPage.noSpacesOnThisPage : q ? spacesPage.noResultsFor(q, Boolean(kind))
    : owner ? spacesPage.noSpacesWithoutAnActiveOwner
    : status === "archived" ? spacesPage.noArchivedSpaces : status === "all" ? spacesPage.noSpaces : spacesPage.noActiveSpaces;

  return (
    <PageFrame title={spacesPage.spaces} lead={spacesPage.aSpaceDefinesWhoCanSeeIts}>
      <Section title={spacesPage.spaceList} id="spaces" icon="layers" hint={spacesPage.openASpaceSNameForIts}>
        <form method="get" action="/admin/spaces" className="filter-form">
          <label className="field grow">
            <span className="field-label">{spacesPage.find}</span>
            <input type="search" name="q" defaultValue={q} placeholder={spacesPage.nameAddressOrOwner} maxLength={100} />
          </label>
          <label className="field">
            <span className="field-label">{spacesPage.kind}</span>
            <select name="kind" defaultValue={kind}>
              <option value="">{spacesPage.allExceptPersonal}</option>
              <option value={ALL_KINDS}>{spacesPage.allIncludingPersonal}</option>
              {KINDS.map((k) => <option key={k} value={k}>{SPACE_KIND_TITLES[k]}</option>)}
            </select>
          </label>
          {owner ? null : (
            <label className="field">
              <span className="field-label">{spacesPage.show}</span>
              <select name="status" defaultValue={status}>
                {STATUSES.map((s) => <option key={s} value={s}>{SPACE_STATUS_TITLES[s]}</option>)}
              </select>
            </label>
          )}
          <label className="check">{rich(spacesPage.newestFirst, {  }, { value0: <input type="checkbox" name="sort" value="created" defaultChecked={sort === "created"} /> })}</label>
          <label className="check" title={spacesPage.ownerHasLeftOrIsDeactivatedExcludes}>{rich(spacesPage.withoutAnActiveOwner, {  }, { value0: <input type="checkbox" name="owner" value="inactive" defaultChecked={owner === "inactive"} /> })}</label>
          <button type="submit" className="btn">{spacesPage.showLabel}</button>
          {q || kind || sort || owner || params.status ? <Link href="/admin/spaces" prefetch={false} className="quiet">{spacesPage.reset}</Link> : null}
        </form>
        {archivedTotal ? (
          <p className="hint">{rich(spacesPage.archivedCount(archivedTotal), { link: (children) => <Link href={hrefWith("/admin/spaces", { q, kind, sort }, { status: "archived" })} prefetch={false}>{children}</Link> }, { count: formatCount(archivedTotal) })}</p>
        ) : null}

        {!spaces.ok ? <LoadError result={spaces} what={spacesPage.spacesToLoad} /> : !spaces.data.items.length ? (
          <>
            <Empty icon="layers">{empty}</Empty>
            {cursor ? <CursorPager path="/admin/spaces" params={params} cursorName="cursor" cursor={cursor} nextCursor={null} prevCursor={String(Math.max(0, offset - PAGE_SIZE))} shown={0} anchor="spaces" /> : null}
          </>
        ) : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead>
                  <tr><th>{spacesPage.name}</th><th>{spacesPage.kind}</th><th>{spacesPage.owner}</th><th>{spacesPage.newRecordsDataClass}</th><th>{spacesPage.orgUnit}</th><th className="num">{spacesPage.members}</th><th className="num">{spacesPage.records}</th><th>{spacesPage.created}</th></tr>
                </thead>
                <tbody>
                  {spaces.data.items.map((s) => (
                    <tr key={s.slug} className={s.archived_at ? "off" : undefined}>
                      <td data-label={spacesPage.name}>
                        <Link href={`/admin/spaces/${encodeURIComponent(s.slug)}`} prefetch={false} title={spacesPage.spaceCardOwnerMembersAndADGroups} className="cell-main">{s.name || s.slug}</Link>
                        <div className="cell-sub muted">{s.slug}</div>
                        {s.description ? <div className="cell-sub">{s.description}</div> : null}
                        {s.archived_at ? <div><Badge tone="muted">{spacesPage.archived}</Badge></div> : null}
                      </td>
                      <td data-label={spacesPage.kind}>{SPACE_KIND_TITLES[s.kind] ?? s.kind}</td>
                      <td data-label={spacesPage.owner}>{s.owner ? <Link href={`/admin/people/${encodeURIComponent(s.owner)}`} prefetch={false} title={s.owner}>{s.owner_name || s.owner}</Link> : <Badge tone="warn">{spacesPage.noOwnerAssigned}</Badge>}</td>
                      <td data-label={spacesPage.newRecordsDataClass}><VisibilityBadge cls={s.default_class} tech /></td>
                      <td data-label={spacesPage.orgUnit}>{s.org_unit ? <Code>{s.org_unit}</Code> : <span className="muted">—</span>}</td>
                      <td className="num" data-label={spacesPage.members}>{s.members_count}{s.groups_count ? <div className="cell-sub">{rich(spacesPage.aDGroups, {  }, { value0: s.groups_count })}</div> : null}</td>
                      <td className="num" data-label={spacesPage.records}>{s.records_count}</td>
                      <td data-label={spacesPage.created}>
                        <LocalTime iso={s.created_at} />
                        {s.created_by || s.created_via ? (
                          <div className="cell-sub">
                            {s.created_by ? <Link href={`/admin/people/${encodeURIComponent(s.created_by)}`} prefetch={false}>{s.created_by}</Link> : null}
                            {s.created_by && s.created_via ? " · " : null}
                            {s.created_via ? CREATED_VIA_TITLES[s.created_via] ?? s.created_via : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/spaces" params={params} cursorName="cursor" cursor={cursor} nextCursor={spaces.data.next_cursor}
              prevCursor={offset ? String(Math.max(0, offset - PAGE_SIZE)) : null} shown={spaces.data.items.length} anchor="spaces" />
          </>
        )}
      </Section>

      <Section title={spacesPage.newSpace} icon="plus" hint={spacesPage.aProjectIsTheProjectTeamS}>
        <ActionForm action={createSpaceAction} submitLabel={spacesPage.createSpace} pendingLabel={spacesPage.creating} resetOnSuccess>
          <div className="form-grid">
            <Field label={spacesPage.kind}>
              <select name="kind" defaultValue="team">
                <option value="team">{spacesPage.teamTeam}</option>
                <option value="project">{spacesPage.projectProject}</option>
                <option value="org">{spacesPage.companyKnowledgeOrg}</option>
              </select>
            </Field>
            <Field label={spacesPage.name}>
              <input type="text" name="name" placeholder={spacesPage.forExampleWarehouseProject} required />
            </Field>
            <Field label={spacesPage.slugLabel} hint={spacesPage.optionalOtherwiseGeneratedFromTheNameLatin}>
              <input type="text" name="slug" placeholder={spacesPage.slugExample} pattern="[a-z0-9][a-z0-9-]{1,62}" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={spacesPage.ownerLogin}>
              <input type="text" name="owner" placeholder={spacesPage.ownerExample} autoCapitalize="none" spellCheck={false} required />
            </Field>
            <Field label={spacesPage.defaultDataClass} hint={spacesPage.openDataCanBeProcessedByExternal}>
              <select name="default_class" defaultValue="">
                <option value="">{spacesPage.byKindTeamClosedProjectAndCompany}</option>
                <option value="closed">{spacesPage.closedClosed}</option>
                <option value="open">{spacesPage.openOpen}</option>
              </select>
            </Field>
            <Field label={spacesPage.description} wide>
              <input type="text" name="description" placeholder={spacesPage.optional} />
            </Field>
            <Field label={spacesPage.membersLabel} hint={spacesPage.separateLoginsWithCommasSpacesOrNew} wide>
              <textarea name="members" rows={3} placeholder={spacesPage.membersExample} spellCheck={false} />
            </Field>
          </div>
          <Notice tone="warn"><strong>{spacesPage.projectsAndCompanyKnowledgeAreOpenBy}</strong> {CLOSED_CLASS_TEXT.openSpaceWarning}</Notice>
        </ActionForm>
      </Section>

      <p className="hint">{spacesPage.changeTheOwnerAndMembersOnThe}</p>
    </PageFrame>
  );
}
