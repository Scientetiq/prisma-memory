import { productName } from "@/i18n/brand";
import { rich } from "@/i18n/rich";
import { derived } from "@/i18n/runtime";
import { TAB_SHORT, OPEN_SPACE_SPEC as OPEN_SPACE_SPEC_LABELS } from "@/messages/ws-projects";
import { texts as M } from "@/messages/ws-projects";
import type { Metadata } from "next";
import { cache } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Block } from "@/components/block";
import type { ConfirmSpec } from "@/components/confirm-dialog";
import { FindField } from "@/components/find-field";
import { Icon, type IconName } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { GroupValidity } from "@/components/group-validity";
import { MeetingRow, MEETING_ROW_TEXT } from "@/components/meeting-row";
import { LocalPager } from "@/components/pager";
import { PeoplePicker } from "@/components/people-picker";
import { Badge, Empty, Field, LoadError, Notice, PageHead } from "@/components/ui";
import { ARCHIVE_TEXT, archiveSpec, TRANSFER_SPEC, transferSpec, ARCHIVE_MESSAGES } from "@/lib/archive";
import { CLOSED_CLASS_TEXT, readsClosed } from "@/lib/closed-class";
import { isSlug, PROJECT_DESCRIPTION_MAX, PROJECT_NAME_MAX } from "@/lib/form";
import { recentArgs } from "@/lib/home";
import { GROUP_STATUS_TITLES } from "@/lib/labels";
import { callTool, toolErrorMessage } from "@/lib/mcp";
import { meGw } from "@/lib/me-api";
import { myMeetings } from "@/lib/meetings";
import { oauthAgentConfig, oauthAgentsOn, ownedSpaces, requireWorkspace } from "@/lib/me";
import { hrefWith, param, slicePage, type SearchParams } from "@/lib/paging";
import { PLAIN, canAdd, CLASS_CHOICE, emptySpaceText, OVERVIEW_PLAIN, roleLine, SPACE_README, spaceLook } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import { readmeHref, readmeMissing, readmeOn, readmeTemplateOf } from "@/lib/space-readme";
import { ADDABLE_CURSOR, addableAsked, addablePath, addableView } from "@/lib/space-addable";
import { loadOverview, overviewAsked, overviewPaged, overviewView } from "@/lib/space-overview";
import { CALLED_COOKIE, missedOf } from "@/lib/project-flash";
import { faces, peopleCount, PICK_ROLE_TITLES, whoSees, PROJECT_PEOPLE_MESSAGES } from "@/lib/project-people";
import { repoLine } from "@/lib/snippets";
import { guideHref, guideTabShown, ownerPowers, pickTab, PROJECT_TAB_TITLES, projectPathOf, projectRecordsHref, projectTabs, tabHref, type ProjectTab } from "@/lib/spaces";
import type { DirectoryGroupSearch, ListResult, MeSpace, MySpace, MySpaceInvite, MySpaceMember, MySpaceMembers, MySpaceReaderMember, SearchResult, SpaceAddable, SpaceGroup, SpaceGroups, SpaceReadmeConfig } from "@/lib/types";
import { addMemberAction } from "../../actions";
import { BackLink, ClassTag, RecentRows, RoleChip, SpaceHeader } from "../../browse/space-parts";
import { ExportSpaceButton } from "../../browse/export-button";
import { canExportSpace } from "@/lib/export";
import { SpaceListing } from "../../browse/space-records";
import { archiveProjectAction, bindGroupAction, changeClassAction, syncGroupsAction, transferOwnerAction, unarchiveProjectAction, unbindGroupAction, updateProjectAction, updateReadmeAction } from "../actions";
import { Faces, InviteRow, MemberRow, ReaderRow, type PlaceFields } from "../people-parts";
import { AddableBlock } from "../addable-parts";
import { OverviewBlocks } from "../overview-parts";
import { ReadmeForm, ReadmeNudge } from "../readme-parts";
import { RecordActions } from "../record-actions";
import { RepoLine } from "../repo-line";

const spaceCard = cache((key: string, slug: string) => meGw<MySpace>(key, `/api/v1/me/spaces/${encodeURIComponent(slug)}`));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).slug).toLowerCase();
  if (!isSlug(slug)) return { title: M.project };
  try {
    const { session } = await requireWorkspace();
    const card = await spaceCard(session.key, slug);
    return { title: card.ok ? card.data.name : M.project2 };
  } catch {
    return { title: M.project3 };
  }
}

const TAB_ICON: Record<ProjectTab, IconName> = { overview: "grid", records: "folder", members: "users", repo: "code", settings: "settings" };

const RECENT_LIMIT = 6, MEETINGS_LIMIT = 5, ROOT_RECENT_LIMIT = 10, LIST_LIMIT = 100;
const count = (v: string): number => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };



function boundLines(g: SpaceGroup, again: boolean): string[] {
  return [
    M.groupMembers(g.role === "reader" ? M.readOnly : M.readAndAddRecords),
    ...(g.members_seen !== null ? [M.theGroupHasPeopleOfWhomHave(peopleCount(g.members_seen), again ? "" : M.now, g.members_matched ?? 0, productName())] : []),
    M.joiningTheGroupJoinsTheProjectLeaving,
  ];
}

type People =
  | { view: "owner"; count: number; members: MySpaceMember[]; invited: MySpaceInvite[] }
  | { view: "reader"; count: number; members: MySpaceReaderMember[] }
  | { view: "count"; count: number | null };
function peopleOf(d: MySpaceMembers): People {
  if (d.view === "reader") return { view: "reader", count: d.count, members: d.members };
  if (d.view === "count") return { view: "count", count: d.count };
  return { view: "owner", count: d.count ?? d.members.length, members: d.members, invited: d.invited ?? [] };
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const slug = decodeURIComponent((await params).slug).toLowerCase();
  const sp = await searchParams;
  const toHub = <BackLink href="/browse">{M.spacesAndProjects3}</BackLink>;
  if (!isSlug(slug)) return <>{toHub}<PageHead title={M.project4} /><Empty>{M.invalidSpaceAddress2}</Empty></>;

  const card = await spaceCard(session.key, slug);
  if (!card.ok) {
    return (
      <>
        {toHub}
        <PageHead title={M.projectCouldNotBeOpened} />
        {card.code === "not_found"
          ? <Empty>{rich(M.thisSpaceDoesNotExistOrLine, { tag1: (children) => <Link href="/browse" prefetch={false}>{children}</Link> })}</Empty>
          : <LoadError result={card} what={M.space2} />}
      </>
    );
  }
  const s = card.data;
  const kind = s.kind as MeSpace["kind"];
  const owner = s.role === "owner";
  const look = spaceLook({ kind, org_unit: s.org_unit ?? undefined }), role = roleLine({ kind, role: s.role, org_unit: s.org_unit ?? undefined });
  const place: PlaceFields = { space: s.slug, space_name: s.name, space_kind: s.kind };
  const myTeams = ownedSpaces(me).filter((x) => x.kind === "team");
  const back = s.kind === "team" && owner && myTeams.length > 1 ? <BackLink href="/team">{M.myTeams}</BackLink> : toHub;
  const people = s.kind === "project" || s.kind === "team";
  const powers = ownerPowers(s);
  const ownerOfRecord = s.owner?.login === me.person.login;
  const edit = powers.members && !session.preview;
  const editManage = powers.manage && !session.preview;
  const archived = Boolean(s.archived_at);
  const grow = edit && !archived;
  const line = s.kind === "personal" || archived ? null : (() => { try { return repoLine(s.slug); } catch { return null; } })();
  const visible = me.spaces.find((x) => x.slug === s.slug)?.counts?.records ?? null;
  const here = `/projects/${encodeURIComponent(s.slug)}`;
  const tabs = projectTabs({ records: people, members: people, repo: s.kind !== "personal", manage: powers.manage });
  const tab = pickTab(param(sp, "tab"), tabs);

  const gfind = param(sp, "gfind").slice(0, 100);
  const boundId = param(sp, "bound");
  const root = `/spaces/${s.slug}`;
  const recPath = projectPathOf(s.slug, param(sp, "path"));
  const recCursor = tab === "records" ? param(sp, "cursor").slice(0, 200) : "";
  const meetingsOn = tab === "overview" && s.kind === "project" && readsClosed(me.key) && !session.preview;
  const readmeShown = readmeOn(s) && !archived && powers.manage;
  const addableOn = addableAsked(s, { tab, preview: Boolean(session.preview) });
  const addCursor = addableOn ? param(sp, ADDABLE_CURSOR).slice(0, 200) : "";
  const overviewOn = overviewAsked(s, { tab });
  const ovPaged = overviewOn ? overviewPaged((n) => param(sp, n)) : null;
  const [members, groups, oauthConfig, recent, meetings, listing, rootRecent, readmeConfig, addable, ov] = await Promise.all([
    people && (tab === "overview" || tab === "members" || (tab === "settings" && ownerOfRecord && !archived))
      ? meGw<MySpaceMembers>(session.key, `/api/v1/me/spaces/${encodeURIComponent(s.slug)}/members`) : Promise.resolve(null),
    powers.manage && (tab === "members" || boundId) ? meGw<SpaceGroups>(session.key, `/api/v1/me/spaces/${encodeURIComponent(s.slug)}/groups`) : Promise.resolve(null),
    tab === "repo" && line && !session.preview ? oauthAgentConfig(session.key) : Promise.resolve(null),
    tab === "overview" ? callTool<SearchResult>(session.key, "memory_search", recentArgs(s.slug, RECENT_LIMIT)) : Promise.resolve(null),
    meetingsOn ? myMeetings(session.key, "", MEETINGS_LIMIT, { space: s.slug }) : Promise.resolve(null),
    tab === "records" ? callTool<ListResult>(session.key, "memory_list", { path: recPath, limit: LIST_LIMIT, ...(recCursor ? { cursor: recCursor } : {}) }) : Promise.resolve(null),
    tab === "records" && recPath === root && !recCursor ? callTool<SearchResult>(session.key, "memory_search", recentArgs(s.slug, ROOT_RECENT_LIMIT)) : Promise.resolve(null),
    tab === "settings" && readmeShown && editManage && readmeMissing(s) ? meGw<SpaceReadmeConfig>(session.key, "/api/v1/me/space-readme") : Promise.resolve(null),
    addableOn ? meGw<SpaceAddable>(session.key, addablePath(s.slug, addCursor)) : Promise.resolve(null),
    overviewOn ? loadOverview((path) => meGw<unknown>(session.key, path), s.slug, ovPaged) : Promise.resolve(null),
  ]);
  const oauthOn = oauthAgentsOn(oauthConfig);
  const ldapOn = groups?.ok ? groups.data.ldap_enabled : false;
  const foundGroups = tab === "members" && grow && powers.manage && ldapOn && gfind.length >= 3
    ? await meGw<DirectoryGroupSearch>(session.key, `/api/v1/directory/groups?q=${encodeURIComponent(gfind)}`) : null;
  const crowd = members?.ok ? peopleOf(members.data) : null;
  const membersFail = members && !members.ok ? members : null;
  const keep = { tab: "members", gfind, mp: param(sp, "mp"), gp: param(sp, "gp") };
  const ownerView = crowd?.view === "owner" ? crowd : null;
  const readerView = crowd?.view === "reader" ? crowd : null;
  const ownerPage = ownerView ? slicePage(ownerView.members, keep.mp) : null;
  const readerPage = readerView ? slicePage(readerView.members, keep.mp) : null;
  const memberPage = ownerPage ?? readerPage;
  const bound = groups?.ok ? groups.data.items : [];
  const groupPage = slicePage(bound, keep.gp);
  const justBound = bound.find((g) => g.id === boundId) ?? null, again = param(sp, "again") === "1";
  const unbound = /^\d{1,7}$/.test(param(sp, "unbound")) ? Number(param(sp, "unbound")) : null;
  const created = param(sp, "created") === "1", called = count(param(sp, "called")), invited = count(param(sp, "invited")), missed = count(param(sp, "missed"));
  const missedList = created && missed ? missedOf((await cookies()).get(CALLED_COOKIE)?.value) : [];
  const transferred = param(sp, "transferred") === "1" && !ownerOfRecord;
  const justArchived = param(sp, "archived") === "1" && archived, justUnarchived = param(sp, "unarchived") === "1" && !archived;
  const groupsOpen = Boolean(justBound || unbound !== null || gfind || param(sp, "gp"));
  const groupsShown = powers.manage && (!groups?.ok || ldapOn || bound.length > 0);
  const ownerGone = s.owner && !s.owner.active ? s.owner : null;
  const goneHint = !ownerGone ? null : (
    <>{rich(M.ownerHasLeftLine, null, { value1: ownerGone.display_name, value2: s.org_unit
        ? M.theNewDepartmentManagerWillOwnIts
        : M.theMemoryAdministratorAppointsANewOwner })}</>
  );
  const add = canAdd(s) && !archived && !session.preview;
  const exportable = canExportSpace(s, Boolean(session.preview));   // an archived space too (read-only data)
  const whoLine = whoSees(s, look.audience);
  const asPicked = (m: MySpaceMember) => ({ login: m.login, display_name: m.display_name || null, department: m.department ?? null, title: m.title ?? null });
  const guideTab = guideTabShown(s);

  return (
    <>
      {back}
      <SpaceHeader icon={archived ? "archive" : look.icon} tone={archived ? "gray" : look.tone} kind={look.kind} name={s.name} who={whoLine} whoKind={s.kind}
        whoHref={people && tab !== "members" ? `${tabHref(here, "members")}#members` : null}
        role={s.kind === "personal" ? null : <RoleChip label={role.label} owner={owner} />}
        tags={<>{s.kind !== "personal" && !archived ? <ClassTag cls={s.default_class} /> : null}{archived ? <Badge tone="muted">{M.archived}</Badge> : null}</>}
        hint={role.hint} about={s.description}
        actions={(add || exportable) && tab === "overview" ? (
          <>
            {add ? <Link href={`/materials?space=${encodeURIComponent(s.slug)}#upload`} prefetch={false} className="btn primary"><Icon name="plus" />{PLAIN.addHere}</Link> : null}
            <ExportSpaceButton slug={s.slug} role={s.role} preview={Boolean(session.preview)} />
          </>
        ) : null} />

      {archived ? (
        <Notice tone="warn">{rich(M.archivedSinceLine, { tag2: () => <LocalTime iso={s.archived_at} short relative={false} />, tag1: (children) => <strong>{children}</strong> }, { value1: s.kind === "project" ? M.project5 : M.space3, value2: s.archived_by ? M.archivedBy(s.archived_by.display_name || s.archived_by.login) : "", value3: ARCHIVE_TEXT.archivedReadonly })}</Notice>
      ) : null}
      {created ? (
        <Notice tone="ok">{rich(M.projectCreatedYouAreItsOwnerLine, { tag1: (children) => <strong>{children}</strong>, tag2: (children) => <Link href={`${tabHref(here, "members")}#call`} prefetch={false}>{children}</Link> }, { value1: called ? M.invited(called) : "", value2: invited ? M.willJoinTheProjectOnTheirFirst(invited, productName()) : "", value3: missed ? <> {M.couldNotInvite}{missed}{missedList.length ? ` — ${missedList.join(", ")}` : ""}{M.tryAgainOnTheMembersTab}</> : null })}</Notice>
      ) : null}
      {transferred ? (
        <Notice tone="ok">
          {ownerGone
            ? <>{rich(M.ownershipTransferredYouLine, { tag1: (children) => <strong>{children}</strong> }, { value1: s.role === "reader" ? M.remainInTheSpaceWithReadOnly : M.remainAMember, value2: goneHint })}</>
            : <>{rich(M.ownershipTransferredYouTheNewOwnerLine, { tag1: (children) => <strong>{children}</strong> }, { value1: s.owner ? M.theOwnerIsNow(s.owner.display_name) : "", value2: s.role === "reader" ? M.remainInTheSpaceWithReadOnly2 : M.remainAMember2 })}</>}
        </Notice>
      ) : null}
      {justArchived ? <Notice tone="ok"><strong>{ARCHIVE_MESSAGES.projectArchived}</strong> {ARCHIVE_MESSAGES.anyProjectRecordsRemainMembersCanRead}</Notice> : null}
      {justUnarchived ? <Notice tone="ok"><strong>{ARCHIVE_MESSAGES.projectActiveAgain}</strong> {ARCHIVE_MESSAGES.membersAgentsCanWriteHereAgainAnd}</Notice> : null}
      {unbound !== null ? (
        <Notice tone="ok">{rich(M.groupUnlinkedLine, { tag1: (children) => <strong>{children}</strong> }, { value1: M.membershipBasedOnlyOnThisGroupWas(peopleCount(unbound)) })}</Notice>
      ) : null}
      {justBound ? (
        <Notice tone="ok">
          <strong>{M.group(justBound.display_name, again ? M.wasAlreadyLinked : M.isNowLinked)}</strong>
          <ul className="lines">{boundLines(justBound, again).map((l) => <li key={l}>{l}</li>)}</ul>
        </Notice>
      ) : null}

      {tabs.length > 1 || guideTab ? (
        <nav className="sp-tabs" aria-label={M.sections}>
          {tabs.map((t) => (
            <Link key={t} href={tabHref(here, t)} prefetch={false} className={[t === tab ? "on" : "", TAB_SHORT[t] ? "has-short" : ""].filter(Boolean).join(" ") || undefined} aria-current={t === tab ? "page" : undefined}>
              <Icon name={TAB_ICON[t]} />{TAB_SHORT[t] ? <span className="tab-short" aria-hidden="true">{TAB_SHORT[t]}</span> : null}{PROJECT_TAB_TITLES[t]}
            </Link>
          ))}
          {guideTab ? <Link href={guideHref(s.slug)} prefetch={false}><Icon name="book-open" />{OVERVIEW_PLAIN.guideTab}</Link> : null}
        </nav>
      ) : null}

      {tab === "overview" ? (
        <>
          {readmeShown && editManage && readmeMissing(s) ? <ReadmeNudge href={readmeHref(s.slug)} /> : null}
          <Block id="recent" icon="clock" title={M.recentRecords}
            aside={<Link href={people ? projectRecordsHref(s.slug) : `/browse?path=${encodeURIComponent(root)}`} prefetch={false} className="sp-link">{rich(M.allRecordsLine, { tag1: () => <Icon name="chevron" /> })}</Link>}>
            {!recent ? null : !recent.ok ? <p className="sp-line">{rich(M.listCouldNotBeLoadedLine, null, { value1: toolErrorMessage(recent) })}</p> : !recent.data.hits.length ? (
              <div className="sp-empty">
                <span className="ichip tone-gray"><Icon name="folder-open" /></span>
                <p>{emptySpaceText({ kind, role: s.role, org_unit: s.org_unit ?? undefined, default_class: s.default_class }, { preview: !add })}</p>
              </div>
            ) : <RecentRows hits={recent.data.hits} />}
          </Block>

          {overviewOn ? (
            <OverviewBlocks view={overviewView(ov?.overview)} page={ov?.page ?? null} paged={ovPaged} slug={s.slug} kind={s.kind === "team" ? "team" : "project"}
              path={here} keep={addCursor ? { [ADDABLE_CURSOR]: addCursor } : {}} />
          ) : null}

          {people ? (
            <Block id="people" icon="users" title={<>{s.kind === "project" ? M.projectMembers : M.teamMembers}{crowd?.count ? <span className="sp-n">{crowd.count}</span> : null}</>}
              aside={<Link href={`${tabHref(here, "members")}#${grow ? "call" : "members"}`} prefetch={false} className="sp-link">{grow ? M.inviteAColleague : M.allMembers}<Icon name="chevron" /></Link>}>
              {membersFail ? <p className="sp-line">{rich(M.membersCouldNotBeLoadedLine, null, { value1: toolErrorMessage(membersFail) })}</p> : !crowd ? null
                : crowd.view === "count" ? (crowd.count ? <p className="sp-line">{rich(M.everyoneInTheDepartmentLine, null, { value1: peopleCount(crowd.count) })}</p> : null)
                : (() => {
                  const names = crowd.view === "owner" ? crowd.members.map((m) => m.display_name || m.login) : crowd.members.map((m) => m.display_name);
                  const f = faces(names);
                  return f.shown.length ? <Faces names={f.shown} more={f.more} /> : <p className="sp-line">{M.onlyTheOwnerSoFar}</p>;
                })()}
              <p className="sp-line">
                {owner ? (archived ? M.colleaguesCannotBeInvitedWhileTheProject : M.youAreTheOwnerInviteAndRemove)
                  : ownerGone ? <>{rich(M.needAColleagueContactTheMemoryLine, null, { value1: goneHint, value2: s.kind === "project" ? M.inTheProject : M.inTheTeam })}</>
                  : s.org_unit && !s.owner ? M.theDepartmentHasNoManagerAtPresent
                  : s.org_unit ? M.departmentColleaguesCanSeeItsRecordsAutomatically(s.owner ? ` — ${s.owner.display_name}` : "")
                  : M.theOwnerCanInviteAColleague(s.owner ? ` — ${s.owner.display_name}` : "")}
              </p>
            </Block>
          ) : (
            <Block id="who" icon="badge-check" title={M.whoManagesThisSpace}>
              <p className="sp-line">{s.kind === "org" ? M.theMemoryAdministratorManagesCompanyKnowledge : M.yourPersonalSpaceIsYoursAlone}</p>
            </Block>
          )}

          {addableOn ? (
            <AddableBlock view={addableView(addable)} slug={s.slug} kind={s.kind === "team" ? "team" : "project"}
              path={here} params={addCursor ? { [ADDABLE_CURSOR]: addCursor } : {}} cursor={addCursor} />
          ) : null}

          {meetingsOn ? (
            <Block id="meetings" icon="mic" title={M.projectMeetings}
              aside={<Link href={`/meetings?space=${encodeURIComponent(s.slug)}`} prefetch={false} className="sp-link">{rich(M.allProjectMeetingsLine, { tag1: () => <Icon name="chevron" /> })}</Link>}>
              {!meetings ? null : !meetings.ok ? <p className="sp-line">{rich(M.meetingsCouldNotBeLoadedLine, null, { value1: toolErrorMessage(meetings) })}</p>
                : !meetings.data.items.length ? <p className="sp-line">{MEETING_ROW_TEXT.noProjectMeetings}</p>
                : <ul className="mt-list">{meetings.data.items.map((m) => <MeetingRow key={m.id} m={m} projects={false} />)}</ul>}
            </Block>
          ) : null}

          <Block id="find" icon="search" title={s.kind === "project" ? M.searchThisProject : M.searchThisSpace}>
            <FindField className="find-project" action="/search" hidden={{ space: s.slug }}
              label={s.kind === "project" ? M.whatToFindInThisProject : M.whatToFindInThisSpace}
              placeholder={M.forExampleMigrationDeadlines} maxLength={500} autoComplete="off" />
          </Block>
        </>
      ) : null}

      {tab === "records" ? (
        <section className="sp-records" id="records" aria-label={M.records}>
          <SpaceListing res={listing!} recent={rootRecent} path={recPath} name={s.name}
            hrefOf={(path, cursor) => projectRecordsHref(s.slug, path, cursor)}
            empty={emptySpaceText({ kind, role: s.role, org_unit: s.org_unit ?? undefined, default_class: s.default_class }, { preview: true })}
            notFound={<>{rich(M.goToRecordsOfTheLine, { tag1: (children) => <Link href={projectRecordsHref(s.slug)} prefetch={false}>{children}</Link> }, { value1: s.kind === "project" ? M.project6 : M.team })}</>}
            rowActions={edit ? (e, id) => <RecordActions e={e} id={id} mine={(e.owner ?? "") === me.person.login} /> : undefined} />
        </section>
      ) : null}

      {tab === "members" ? (
        <>
          {grow ? (
            <Block id="call" icon="user-plus" title={M.inviteAColleague2} hint={PROJECT_PEOPLE_MESSAGES.invitedColleaguesCanReadRecordsCanAdd(productName())}>
              <PeoplePicker mode="act" name="login" self={me.person.login} allowWaiting
                exclude={[...(ownerView?.members.map((m) => m.login) ?? []), ...(ownerView?.invited.map((i) => i.login) ?? [])]}
                act={{ action: addMemberAction, fields: { ...place }, roles: true }}
                hint={M.startTypingANameOrEmailAddress(s.kind === "project" ? M.toTheProject : M.toTheTeam, PICK_ROLE_TITLES.member, PICK_ROLE_TITLES.reader)} />
              <noscript>
                <style>{".pp{display:none}"}</style>
                <ActionForm action={addMemberAction} submitLabel={M.invite} pendingLabel="…" quiet resetOnSuccess className="form full mb-add">
                  {Object.entries(place).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                  <Field label={M.colleagueSEmail}><input type="email" name="login" placeholder={M.colleagueEmailExample} autoCapitalize="none" spellCheck={false} required /></Field>
                  <Field label={M.permissions}>
                    <select name="as" defaultValue="member">
                      <option value="member">{PICK_ROLE_TITLES.member}</option>
                      <option value="reader">{PICK_ROLE_TITLES.reader}</option>
                    </select>
                  </Field>
                </ActionForm>
              </noscript>
            </Block>
          ) : null}

          <Block id="members" icon="users" title={<>{ownerView ? (s.kind === "project" ? M.currentlyInTheProject : M.currentlyInTheTeam) : M.members}{crowd?.count ? <span className="sp-n">{crowd.count}</span> : null}</>}
            hint={archived && ownerView ? ARCHIVE_MESSAGES.roleAndMembershipBasisWhileTheProject : ownerView ? null : readerView ? PROJECT_PEOPLE_MESSAGES.thesePeopleCanReadTheProjectS : null}>
            {powers.members && !edit ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : null}
            {membersFail ? <LoadError result={membersFail} what={s.kind === "project" ? M.projectMembers2 : M.teamMembers2} /> : !crowd ? null
              : crowd.view === "count" ? (
                <p className="sp-line">{rich(M.theCompanyDirectoryManagesDepartmentMembershipLine, null, { value1: crowd.count ? M.everyoneInTheDepartment2(peopleCount(crowd.count)) : "", value2: s.owner ? M.theOwnerCanInviteAColleagueFrom(s.owner.display_name) : "" })}</p>
              ) : !memberPage!.total ? <Empty icon="users">{M.onlyTheOwnerSoFar2}</Empty> : (
                <>
                  <ul className="mb-list">
                    {ownerPage ? ownerPage.items.map((m) => <MemberRow key={m.login} m={m} place={place} edit={edit} archived={archived} />)
                      : readerPage ? readerPage.items.map((m, i) => <ReaderRow key={`${m.display_name}-${i}`} m={m} />) : null}
                  </ul>
                  {ownerPage && ownerPage.pages > 1 ? <LocalPager path={here} params={keep} pageName="mp" page={ownerPage} anchor="members" /> : null}
                  {readerPage && readerPage.pages > 1 ? <LocalPager path={here} params={keep} pageName="mp" page={readerPage} anchor="members" /> : null}
                </>
              )}
            {ownerView?.invited.length ? (
              <>
                <h3 className="sp-sub" id="invited">{rich(M.awaitingFirstSignInLine, { tag1: (children) => <span className="sp-n">{children}</span> }, { value1: ownerView.invited.length })}</h3>
                <ul className="mb-list">{ownerView.invited.map((i) => <InviteRow key={i.login} i={i} place={place} edit={edit} />)}</ul>
              </>
            ) : null}
          </Block>

          {groupsShown ? (
            <details className="sp-card sp-fold" id="groups" open={groupsOpen}>
              <summary>{rich(M.colleagueGroupsFromTheCompanyDirectoryLine, { tag1: () => <Icon name="users" />, tag2: (children) => <span className="sp-fold-title">{children}</span>, tag3: () => <Icon name="chevron-down" className="ic sp-fold-mark" /> }, { value1: bound.length ? <span className="sp-n">{bound.length}</span> : null })}</summary>
              <p className="sp-line">{archived ? ARCHIVE_MESSAGES.archivedGroupsHint : M.linkAGroupToGiveItsColleagues}</p>
              {!groups || !groups.ok ? <LoadError result={groups ?? { code: "unknown", message: M.noResponse }} what={M.colleagueGroups} /> : (
                <>
                  {!ldapOn ? (
                    <Notice tone="info">{M.theCompanyDirectoryIsNotConnectedLinked}</Notice>
                  ) : null}
                  {bound.length ? (
                    <>
                      <ul className="mb-list">
                        {groupPage.items.map((g) => (
                          <li key={g.id} className="mb-row">{rich(M.membersLine, { tag2: () => <Icon name="users" />, tag1: (children) => <span className="mb-ava grp" aria-hidden="true">{children}</span>, tag4: (children) => <b>{children}</b>, tag3: (children) => <span className="mb-who">{children}</span>, tag6: (children) => <span className="chip">{children}</span>, tag7: (children) => <Badge tone={g.status === "ok" ? "ok" : g.status === "pending" ? "muted" : "warn"}>{children}</Badge>, tag8: (children) => <small title={M.alreadySignedInAndMembersTotalIn(productName())}>{children}</small>, tag9: () => <GroupValidity g={g} short />, tag5: (children) => <span className="mb-meta">{children}</span> }, { value1: g.display_name, value2: g.role === "reader" ? PICK_ROLE_TITLES.reader : PICK_ROLE_TITLES.member, value3: GROUP_STATUS_TITLES[g.status] ?? g.status, value4: g.members_matched ?? "—", value5: g.members_seen !== null ? M.of(g.members_seen) : "", value6: g.synced_at ? <small>{M.checked}<LocalTime iso={g.synced_at} short /></small> : null, value7: g.last_error ? <small className="danger-text">{g.last_error}</small> : null, value8: editManage ? (
                              <span className="mb-act">
                                <ActionForm action={unbindGroupAction} submitLabel={M.unlink} pendingLabel="…" compact danger confirm={M.unlinkGroupMembershipThroughThisGroupWill(g.display_name)}>
                                  <input type="hidden" name="space" value={s.slug} />
                                  <input type="hidden" name="id" value={g.id} />
                                </ActionForm>
                              </span>
                            ) : null })}</li>
                        ))}
                      </ul>
                      {groupPage.pages > 1 ? <LocalPager path={here} params={keep} pageName="gp" page={groupPage} anchor="groups" /> : null}
                    </>
                  ) : ldapOn ? <p className="sp-none">{M.noGroupsLinked}</p> : null}
                  {grow && editManage && ldapOn ? (
                    <>
                      {bound.length ? (
                        <ActionForm action={syncGroupsAction} submitLabel={M.refreshNow} pendingLabel={M.checking} quiet>
                          <input type="hidden" name="space" value={s.slug} />
                          <span className="sp-line">{M.checkGroupsAgainstTheDirectoryWithoutWaiting}</span>
                        </ActionForm>
                      ) : null}
                      <div className="directory-find" id="gfind">
                        <form method="get" action={`${here}#gfind`} className="filter-form" role="search">
                          <input type="hidden" name="tab" value="members" />
                          <label className="field grow">
                            <span className="field-label">{M.findAGroupInTheDirectory}</span>
                            <input type="search" name="gfind" defaultValue={gfind} minLength={3} maxLength={100} placeholder={M.partOfAGroupName} autoComplete="off" spellCheck={false} />
                          </label>
                          <button type="submit" className="btn">{M.find}</button>
                          {gfind ? <Link href={hrefWith(here, keep, { gfind: null })} prefetch={false} className="quiet">{M.clear}</Link> : null}
                        </form>
                        {gfind && gfind.length < 3 ? <Notice tone="warn">{M.enterAtLeast3CharactersOfThe}</Notice> : null}
                        {!foundGroups ? null : !foundGroups.ok ? <LoadError result={foundGroups} what={M.directoryGroups} /> : !foundGroups.data.items.length ? (
                          <Empty>{M.thisGroupIsNotInTheDirectory}</Empty>
                        ) : (
                          <>
                            <ul className="mb-list">
                              {foundGroups.data.items.map((g) => (
                                <li key={g.dn} className="mb-row">
                                  <span className="mb-ava grp" aria-hidden="true"><Icon name="users" /></span>
                                  <span className="mb-who"><b>{g.name}</b></span>
                                  <span className="mb-act">{bound.some((b) => b.group_dn.toLowerCase() === g.dn.toLowerCase()) ? <span className="muted small">{M.alreadyLinked}</span> : (
                                    <ActionForm action={bindGroupAction} submitLabel={M.link} pendingLabel="…" compact>
                                      <input type="hidden" name="space" value={s.slug} />
                                      <input type="hidden" name="group_dn" value={g.dn} />
                                      <select name="role" defaultValue="member" aria-label={M.groupMembersPermissions}>
                                        <option value="member">{PICK_ROLE_TITLES.member}</option>
                                        <option value="reader">{PICK_ROLE_TITLES.reader}</option>
                                      </select>
                                    </ActionForm>
                                  )}</span>
                                </li>
                              ))}
                            </ul>
                            {foundGroups.data.truncated ? <p className="sp-line">{rich(M.showingTheFirstRefineTheGroupLine, null, { value1: foundGroups.data.items.length })}</p> : null}
                          </>
                        )}
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </details>
          ) : null}
        </>
      ) : null}

      {tab === "repo" ? (
        <Block id="repo" icon="code" title={M.connectARepository}
          hint={archived ? ARCHIVE_MESSAGES.theProjectIsArchivedAgentsCannotWrite : M.withThisLineAnAiAgentClaude}>
          {line ? (
            <>
              <RepoLine line={line} />
              <ol className="repo-steps">
                <li>{rich(M.pasteThisAsASeparateLineLine, { tag1: (children) => <code className="code">{children}</code>, tag2: (children) => <code className="code">{children}</code> })}</li>
                {oauthOn
                  ? <li>{rich(M.eachMemberSAgentMustBeLine, { tag1: (children) => <Link href="/connect" prefetch={false}>{children}</Link> })}</li>
                  : <li>{rich(M.theAgentNeedsAMemoryKeyLine, null, { value1: session.preview ? M.createOneInKeysAndAgents : <><Link href="/keys" prefetch={false}>{M.keysAndAgents}</Link>{M.whereReadyToUseConnectionCommandsAre}</> })}</li>}
                <li>{M.youCanSafelyPutThisLineIn}</li>
              </ol>
              {s.default_class === "closed" ? <Notice tone="warn">{rich(M.peopleOnlyWithoutAgentsLine, { tag1: (children) => <strong>{children}</strong> }, { value1: CLOSED_CLASS_TEXT.repoClosedWarning })}</Notice> : null}
              {s.role === "reader" ? <Notice tone="warn">{rich(M.readOnlyLine, { tag1: (children) => <strong>{children}</strong> }, { value1: CLOSED_CLASS_TEXT.repoReaderWarning })}</Notice> : null}
            </>
          ) : null}
        </Block>
      ) : null}

      {tab === "settings" ? (
        <>
          {archived ? <Notice tone="info">{ARCHIVE_MESSAGES.whileTheProjectIsArchivedYouCannot}</Notice> : null}
          {archived ? null : (
            <Block id="meta" icon="pencil" title={M.nameAndDescription} hint={M.membersAiAgentsCanSeeTheseThe}>
              {!editManage ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : (
                <ActionForm action={updateProjectAction} submitLabel={M.save} pendingLabel={M.saving} quiet>
                  <input type="hidden" name="space" value={s.slug} />
                  <div className="form-grid">
                    <Field label={M.name}><input type="text" name="name" defaultValue={s.name} maxLength={PROJECT_NAME_MAX} required /></Field>
                    <Field label={M.whatToSaveHere} wide hint={M.leaveBlankToRemoveTheDescription}><textarea name="description" rows={3} defaultValue={s.description ?? ""} maxLength={PROJECT_DESCRIPTION_MAX} /></Field>
                  </div>
                </ActionForm>
              )}
            </Block>
          )}
          {readmeShown ? (
            <Block id="readme" icon="text" title={SPACE_README.label} hint={SPACE_README.hint}>
              {!editManage ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice>
                : <ReadmeForm action={updateReadmeAction} slug={s.slug} readme={s.readme ?? null} template={readmeTemplateOf(readmeConfig)} />}
            </Block>
          ) : null}
          {ownerOfRecord && !archived ? (
            <Block id="owner" icon="user" title={M.transferOwnership} hint={M.forExampleWhenYouLeaveTheProject(productName())}>
              {!editManage ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : (
                <ActionForm action={transferOwnerAction} submitLabel={M.transferOwnership2} pendingLabel={M.transferring} danger resetOnSuccess confirm={transferSpec(s.name)}>
                  <input type="hidden" name="space" value={s.slug} />
                  <PeoplePicker mode="single" name="login" self={me.person.login} label={M.newOwner}
                    current={ownerView ? ownerView.members.filter((m) => !m.self && m.login !== me.person.login).map(asPicked) : []} />
                  <noscript>
                    <style>{".pp{display:none}"}</style>
                    <Field label={M.newOwnerSEmail}><input type="email" name="login" placeholder={M.colleagueEmailExample} autoCapitalize="none" spellCheck={false} required /></Field>
                  </noscript>
                  <label className="check ack-fallback"><input type="checkbox" name="confirm" /> {TRANSFER_SPEC.ack!.label}</label>
                </ActionForm>
              )}
            </Block>
          ) : null}
          {archived ? null : (
            <Block id="class" icon={s.default_class === "open" ? "bot" : "lock"} title={M.whoCanSeeNewRecords} hint={PLAIN.newRecordsHelp}>
              <div className="sp-class-now">
                <b>{CLASS_CHOICE[s.default_class].title}</b>
                <span className="sp-line">{CLASS_CHOICE[s.default_class].hint}</span>
              </div>
              {!editManage ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : s.default_class === "closed" ? (
                <>
                  <p className="sp-line">{CLOSED_CLASS_TEXT.openSpaceWarning}</p>
                  <ActionForm action={changeClassAction} submitLabel={M.showNewRecordsToAiAgentsToo} pendingLabel={M.saving2} danger confirm={OPEN_SPACE_SPEC}>
                    <input type="hidden" name="space" value={s.slug} />
                    <input type="hidden" name="default_class" value="open" />
                    <label className="check ack-fallback"><input type="checkbox" name="open_ack" /> {OPEN_SPACE_SPEC.ack!.label}</label>
                  </ActionForm>
                </>
              ) : (
                <ActionForm action={changeClassAction} submitLabel={M.newRecordsForPeopleOnly} pendingLabel={M.saving3} quiet confirm={M.newRecordsForPeopleOnlyWithoutAgents}>
                  <input type="hidden" name="space" value={s.slug} />
                  <input type="hidden" name="default_class" value="closed" />
                </ActionForm>
              )}
            </Block>
          )}
          {s.kind === "project" ? (
            <Block id="archive" icon="archive" title={M.archive} hint={archived ? ARCHIVE_MESSAGES.theProjectWillBecomeActiveAgainMembers : ARCHIVE_MESSAGES.theProjectIsFinishedArchiveItRecords}>
              {!editManage ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : archived ? (
                <ActionForm action={unarchiveProjectAction} submitLabel={M.restoreFromArchive} pendingLabel={M.restoring} quiet confirm={ARCHIVE_MESSAGES.unarchiveConfirm}>
                  <input type="hidden" name="space" value={s.slug} />
                </ActionForm>
              ) : (
                <ActionForm action={archiveProjectAction} submitLabel={M.archiveProject} pendingLabel={M.sending} danger confirm={archiveSpec(s.name, visible)}>
                  <input type="hidden" name="space" value={s.slug} />
                  <label className="check ack-fallback"><input type="checkbox" name="confirm" /> {ARCHIVE_MESSAGES.theProjectIsFinishedAgentsNoLonger}</label>
                </ActionForm>
              )}
            </Block>
          ) : archived ? (
            <Block id="archive" icon="archive" title={M.archive2}><p className="sp-line">{M.theMemoryAdministratorCanRestoreATeam}</p></Block>
          ) : null}
        </>
      ) : null}
    </>
  );
}


const OPEN_SPACE_SPEC: ConfirmSpec = derived(() => ({ ...OPEN_SPACE_SPEC_LABELS, ack: { name: "open_ack", label: OPEN_SPACE_SPEC_LABELS.ack.label } }));
