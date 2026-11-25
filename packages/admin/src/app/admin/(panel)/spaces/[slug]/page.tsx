import { spacePage } from "@/messages/panel-spaces";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { ActionForm } from "@/components/action-form";
import { AdminTabs } from "@/components/admin-tabs";
import { LocalTime } from "@/components/local-time";
import { GroupValidity } from "@/components/group-validity";
import { PageFrame } from "@/components/page-frame";
import { LocalPager } from "@/components/pager";
import { guardAuditorPage } from "@/lib/admin-guard";
import { Badge, Code, Empty, Field, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { pickTab, SPACE_TABS } from "@/lib/admin-tabs";
import { tryGw } from "@/lib/api";
import { counts } from "@/messages/plain";
import { isSlug, PROJECT_DESCRIPTION_MAX, PROJECT_NAME_MAX } from "@/lib/form";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import { CREATED_VIA_TITLES, GROUP_STATUS_TITLES, SOURCE_TITLES, SPACE_KIND_TITLES, SPACE_ROLE_HINTS, SPACE_ROLE_TITLES } from "@/lib/labels";
import { SPACE_MEMBERS_SPEC, spaceOwnerConfirm } from "@/lib/closed-class";
import { PersonSuggest } from "@/components/person-suggest";
import type { SpaceDetail } from "@/lib/types";
import { archiveSpaceAction, makeProjectAction, setSpaceOwnerAction, unarchiveSpaceAction, unbindGroupAdminAction, updateSpaceMembersAction, updateSpaceMetaAction } from "../actions";

const loadSpace = cache(async (slug: string) => {
  await guardAuditorPage();
  return tryGw<SpaceDetail>(`/api/v1/admin/spaces/${encodeURIComponent(slug)}`);
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).slug).toLowerCase();
  if (!isSlug(slug)) return { title: spacePage.space };
  const res = await loadSpace(slug);
  return { title: res.ok ? res.data.title || res.data.slug : spacePage.space };
}

export default async function SpacePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const slug = decodeURIComponent((await params).slug).toLowerCase();
  const sp = await searchParams;
  const back = <Link href="/admin/spaces" prefetch={false}>{spacePage.spaces}</Link>;
  if (!isSlug(slug)) return <PageFrame title={spacePage.space} lead={back}><Empty>{spacePage.invalidSpaceSlug}</Empty></PageFrame>;

  const res = await loadSpace(slug);
  if (!res.ok) {
    return (
      <PageFrame title={slug} lead={back}>
        {res.status === 404 ? <Empty>{rich(spacePage.spaceDoesNotExist, { code0: (children) => <Code>{children}</Code> }, { value0: slug })}</Empty> : <LoadError result={res} what={spacePage.spaceLabel} />}
      </PageFrame>
    );
  }
  const s = res.data;
  const archivable = s.kind === "team" || s.kind === "project";
  const groups = s.groups ?? [];
  const here = `/admin/spaces/${encodeURIComponent(s.slug)}`;
  const keep = { mp: param(sp, "mp"), gp: param(sp, "gp") };
  const memberPage = slicePage(s.members, keep.mp), groupPage = slicePage(groups, keep.gp);
  const unbound = /^\d{1,7}$/.test(param(sp, "unbound")) ? Number(param(sp, "unbound")) : null;
  const justArchived = param(sp, "archived") === "1" && Boolean(s.archived_at), justUnarchived = param(sp, "unarchived") === "1" && !s.archived_at;
  const editableMeta = s.kind !== "personal" && !s.org_unit;
  const tab = pickTab(param(sp, "tab") || (param(sp, "archived") || param(sp, "unarchived") ? "archive" : ""), SPACE_TABS, "members");

  return (
    <PageFrame title={s.title || s.slug} lead={<>{back} · <Code>{s.slug}</Code> · {SPACE_KIND_TITLES[s.kind] ?? s.kind}{s.archived_at ? spacePage.archived : ""}
      {" · "}<Link href={`/admin/audit?space=${encodeURIComponent(s.slug)}#events`} prefetch={false}>{spacePage.auditLogEvents}</Link></>}>
      <div className="stat-tiles">
        <div className="stat-tile"><div className="v">{s.members.length}</div><div className="k">{spacePage.members(s.members.length)}</div></div>
        <div className="stat-tile"><div className="v">{s.records_count}</div><div className="k">{counts.records(s.records_count)}</div></div>
        <div className="stat-tile"><div className={`v ${s.owner ? "" : "warn"}`}>{s.owner ? s.owner.display_name : spacePage.none}</div><div className="k">{spacePage.owner}</div></div>
        <div className="stat-tile"><div className={`v ${s.archived_at ? "bad" : "good"}`}>{s.archived_at ? spacePage.archivedLabel : spacePage.active}</div><div className="k">{spacePage.state}</div></div>
        {s.default_class ? <div className="stat-tile"><div className="v"><VisibilityBadge cls={s.default_class} tech /></div><div className="k">{spacePage.newRecordsDataClass}</div></div> : null}
      </div>

      <AdminTabs path={here} tabs={SPACE_TABS} active={tab} fallback="members" label={spacePage.spaceSections} keep={keep} />

      {tab === "members" ? <>

      <Section title={spacePage.details} icon="info" hint={spacePage.membersAgentsCanSeeTheNameAnd}>
        <div className="kv-list">
          <div className="kv"><span>{spacePage.description}</span><span className="pre-line">{s.description || <span className="muted">{spacePage.notSet}</span>}</span></div>
          {s.org_unit ? <div className="kv"><span>{spacePage.department}</span><span><Code>{s.org_unit}</Code> <span className="muted">{spacePage.theOrgTableSetsTheNameMembers}</span></span></div> : null}
          <div className="kv"><span>{spacePage.created}</span><span>{s.created_at ? <LocalTime iso={s.created_at} /> : <span className="muted">—</span>}</span></div>
          <div className="kv"><span>{spacePage.createdBy}</span><span>{s.created_by ? <Link href={`/admin/people/${encodeURIComponent(s.created_by)}`} prefetch={false}><Code>{s.created_by}</Code></Link> : <span className="muted">—</span>}{s.created_via ? <span className="muted"> · {CREATED_VIA_TITLES[s.created_via] ?? s.created_via}</span> : null}</span></div>
        </div>
      </Section>

      <Section title={spacePage.membersText} id="people" icon="users" hint={spacePage.roleMembershipBasisAndExpiryOrgTable}>
        {!s.members.length ? <Empty>{rich(spacePage.noMembers, {  }, { value0: s.owner ? spacePage.apartFromTheOwner : "" })}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead><tr><th>{spacePage.login}</th><th>{spacePage.name}</th><th>{spacePage.role}</th><th>{spacePage.basis}</th><th>{spacePage.validUntil}</th><th>{spacePage.addedBy}</th></tr></thead>
                <tbody>
                  {memberPage.items.map((m) => (
                    <tr key={m.login}>
                      <td data-label={spacePage.login}><Link href={`/admin/people/${encodeURIComponent(m.login)}`} prefetch={false} title={spacePage.permissionsAndVisibility}><Code>{m.login}</Code></Link></td>
                      <td data-label={spacePage.name}>{m.display_name}</td>
                      <td data-label={spacePage.role}><Badge tone={m.role === "owner" ? "brand" : m.role === "member" ? "info" : "neutral"} title={SPACE_ROLE_HINTS[m.role]}>{SPACE_ROLE_TITLES[m.role] ?? m.role}</Badge></td>
                      <td data-label={spacePage.basis}>
                        {SOURCE_TITLES[m.source] ?? m.source}{m.grant_id ? <div className="cell-sub">{rich(spacePage.grant, { code0: (children) => <Code>{children}</Code> }, { value0: m.grant_id.slice(0, 8) })}</div> : null}
                        {m.groups?.length ? <div className="cell-sub">{m.source === "group" ? spacePage.groups : spacePage.alsoInADGroup}: {m.groups.join(", ")}</div> : null}
                      </td>
                      <td data-label={spacePage.validUntil}>{m.expires_at ? <>{rich(spacePage.until, {  }, { value0: <LocalTime iso={m.expires_at} relative={false} /> })}</> : <span className="muted">{spacePage.noExpiry}</span>}</td>
                      <td data-label={spacePage.addedBy}>{m.added_by ? <span title={m.added_by}>{m.added_by_name || m.added_by}</span> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LocalPager path={here} params={keep} pageName="mp" page={memberPage} anchor="people" />
          </>
        )}
      </Section>

      <Section title={spacePage.changeMembership} id="members" icon="user-plus" hint={spacePage.membershipAddedHereIsManualOrgTable(SPACE_ROLE_TITLES.member, SPACE_ROLE_TITLES.reader)}>
        <ActionForm action={updateSpaceMembersAction} submitLabel={spacePage.apply} pendingLabel={spacePage.applying} resetOnSuccess confirm={SPACE_MEMBERS_SPEC}>
          <input type="hidden" name="slug" value={s.slug} />
          <div className="form-grid">
            <Field label={spacePage.roleForNewMembers}>
              <select name="role" defaultValue="member">
                <option value="member">{spacePage.memberCanWrite}</option>
                <option value="reader">{SPACE_ROLE_TITLES.reader}</option>
              </select>
            </Field>
            <Field label={spacePage.addLogins} wide hint={spacePage.separateLoginsWithCommasOrNewLines}><textarea name="add" rows={2} spellCheck={false} /></Field>
            <Field label={spacePage.removeLogins} wide hint={spacePage.useCommaSeparatedLoginsHereToo}><textarea name="remove" rows={2} spellCheck={false} /></Field>
          </div>
        </ActionForm>
      </Section>

      <Section title={spacePage.aDGroups} id="groups" icon="network" hint={spacePage.directoryGroupsBoundByTheOwnerTheir}>
        {unbound !== null ? (
          <Notice tone="ok"><strong>{spacePage.groupUnbound}</strong> {spacePage.membershipsRemovedOnlyHeldThroughThisGroup(unbound)}</Notice>
        ) : null}
        {!groups.length ? <Empty icon="network">{spacePage.noDirectoryGroupsBound}</Empty> : (
          <>
            <TableWrap>
              <table className="board">
                <thead><tr><th>{spacePage.group}</th><th>{spacePage.membersRole}</th><th>{spacePage.stateLabel}</th><th className="num">{spacePage.membersCaption}</th><th>{spacePage.boundBy}</th><th /></tr></thead>
                <tbody>
                  {groupPage.items.map((g) => (
                    <tr key={g.id}>
                      <td className="cell-wrap">{g.display_name}<div className="cell-sub">{g.group_dn}</div></td>
                      <td>{SPACE_ROLE_TITLES[g.role] ?? g.role}</td>
                      <td>
                        <Badge tone={g.status === "ok" ? "ok" : g.status === "pending" ? "muted" : "warn"}>{GROUP_STATUS_TITLES[g.status] ?? g.status}</Badge>
                        {g.synced_at ? <div className="cell-sub">{rich(spacePage.reconciled, {  }, { value0: <LocalTime iso={g.synced_at} /> })}</div> : null}
                        <GroupValidity g={g} as="div" className="cell-sub" />
                        {g.missing_since ? <div className="cell-sub">{rich(spacePage.missingFromDirectorySince, {  }, { value0: <LocalTime iso={g.missing_since} relative={false} /> })}</div> : null}
                        {g.last_error ? <div className="cell-sub"><Code>{g.last_error}</Code></div> : null}
                      </td>
                      <td className="num">{g.members_matched ?? "—"}{g.members_seen !== null ? <span className="muted">{rich(spacePage.of, {  }, { value0: g.members_seen })}</span> : null}</td>
                      <td>{g.added_by ? <Code>{g.added_by}</Code> : <span className="muted">—</span>}<div className="cell-sub"><LocalTime iso={g.created_at} /></div></td>
                      <td>
                        <ActionForm action={unbindGroupAdminAction} submitLabel={spacePage.unbind} pendingLabel="…" compact danger confirm={spacePage.unbindGroupFromMembershipsThroughItWill(g.display_name, s.slug)}>
                          <input type="hidden" name="slug" value={s.slug} />
                          <input type="hidden" name="id" value={g.id} />
                        </ActionForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LocalPager path={here} params={keep} pageName="gp" page={groupPage} anchor="groups" />
          </>
        )}
      </Section>

      </> : null}

      {tab === "settings" ? <>
      {editableMeta ? (
        <Section title={spacePage.nameAndDescription} id="meta" icon="pencil" hint={spacePage.forExampleCorrectAnUnsuitableNameChanges}>
          <ActionForm action={updateSpaceMetaAction} submitLabel={spacePage.save} pendingLabel={spacePage.saving} quiet>
            <input type="hidden" name="slug" value={s.slug} />
            <div className="form-grid">
              <Field label={spacePage.nameLabel}><input type="text" name="name" defaultValue={s.title} maxLength={PROJECT_NAME_MAX} required /></Field>
              <Field label={spacePage.description} wide hint={spacePage.blankClearsTheDescription}><textarea name="description" rows={3} defaultValue={s.description ?? ""} maxLength={PROJECT_DESCRIPTION_MAX} /></Field>
            </div>
          </ActionForm>
          {s.kind === "team" ? (
            <ActionForm action={makeProjectAction} submitLabel={spacePage.makeAProjectSpace} pendingLabel="…" quiet
              confirm={spacePage.convertToAProjectSpaceTheOwner(s.slug)}>
              <input type="hidden" name="slug" value={s.slug} />
              <span className="hint">{spacePage.theTeamSpaceBecomesAProjectThe}</span>
            </ActionForm>
          ) : null}
        </Section>
      ) : <p className="hint">{s.org_unit ? spacePage.theOrgTableSetsTheDepartmentSpace : spacePage.aPersonalSpaceSNameCannotBe}</p>}

      <Section title={spacePage.ownerLabel} id="owner" icon="user" hint={spacePage.theOwnerCanWriteToTheSpace}>
        <ActionForm action={setSpaceOwnerAction} submitLabel={s.owner ? spacePage.transferOwnership : spacePage.assignOwner} pendingLabel={spacePage.transferring} resetOnSuccess quiet confirm={spaceOwnerConfirm(s)}>
          <input type="hidden" name="slug" value={s.slug} />
          <Field label={spacePage.newOwner} hint={s.owner ? spacePage.currentOwnerChooseAMemberOrSearch(s.owner.display_name || s.owner.login) : spacePage.thereIsNoOwnerToDeleteOr}>
            <PersonSuggest textName="owner_login" pickedFields={{ login: "owner_login", name: "owner_name" }} label={spacePage.newOwner} placeholder={spacePage.nameOrLogin} required
              quick={s.members.filter((m) => m.login !== s.owner?.login).slice(0, 20).map((m) => ({ login: m.login, display_name: m.display_name ?? null }))} />
          </Field>
        </ActionForm>
      </Section>

      </> : null}

      {tab === "archive" ? (
      <Section title={spacePage.archive} id="archive" icon="archive" hint={spacePage.theArchiveIsReadOnlyRecordsRemain}>
        {justArchived ? (
          <Notice tone="ok">
            <strong>{spacePage.spaceArchived(s.slug)}</strong>{" "}
            {s.records_count
              ? spacePage.recordsRemainMembersCanReadThemAnd
              : spacePage.itHasDisappearedFromMembersListsAnd}
          </Notice>
        ) : null}
        {justUnarchived ? (
          <Notice tone="ok">{rich(spacePage.membersCanWriteHereAgainSearchIncludes, { strong0: (children) => <strong>{children}</strong> }, { value0: spacePage.spaceIsActiveAgain(s.slug) })}</Notice>
        ) : null}
        {!archivable ? (
          <Empty>{spacePage.onlyTeamAndProjectSpacesCanBe}</Empty>
        ) : s.archived_at ? (
          <>
            <p className="hint">{rich(spacePage.archivedSinceRecords, {  }, { value0: <LocalTime iso={s.archived_at} relative={false} />, value1: s.archived_by ? <>{rich(spacePage.archivedByOwnerInTheWorkspace, { code0: (children) => <Code>{children}</Code> }, { value0: s.archived_by })}</> : null, value2: s.records_count })}</p>
            <ActionForm action={unarchiveSpaceAction} submitLabel={spacePage.restoreFromArchive} pendingLabel={spacePage.restoring} quiet
              confirm={spacePage.restoreFromTheArchiveMembersWillBe(s.slug)}>
              <input type="hidden" name="slug" value={s.slug} />
            </ActionForm>
          </>
        ) : (
          <ActionForm action={archiveSpaceAction} submitLabel={spacePage.sendToArchive} pendingLabel={spacePage.sending} danger
            confirm={spacePage.sendSpaceToTheArchive(s.slug, s.records_count)}>
            <input type="hidden" name="slug" value={s.slug} />
            <Field label={spacePage.confirmation} hint={<>{rich(spacePage.enterTheSpaceSSlugToConfirm, { code0: (children) => <Code>{children}</Code> }, { value0: s.slug })}</>}>
              <input type="text" name="confirm_slug" autoCapitalize="none" spellCheck={false} required />
            </Field>
            {s.records_count ? (
              s.org_unit
                ? <p className="field-error">{rich(spacePage.recordsInThisSpaceADepartmentSpace, {  }, { value0: s.records_count })}</p>
                : <label className="check">{rich(spacePage.archiveWithRecords, {  }, { value0: <input type="checkbox" name="with_records" />, value1: s.records_count })}</label>
            ) : null}
          </ActionForm>
        )}
      </Section>
      ) : null}
    </PageFrame>
  );
}
