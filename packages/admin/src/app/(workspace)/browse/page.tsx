import { rich } from "@/i18n/rich";
import { texts as M } from "@/messages/ws-browse";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icons";
import { CursorPager, LocalPager } from "@/components/pager";
import { NewProjectCard, SpaceCard } from "@/components/space-card";
import { SpaceSearch } from "@/components/space-search";
import { Badge, Empty, LoadError, PageHead } from "@/components/ui";
import { PLAIN, canAdd, emptySpaceText, formatDay, roleLine, SPACE_README, spaceLook } from "@/lib/plain";
import { ORG_RECENT_TYPES, recentArgs } from "@/lib/home";
import { backHref } from "@/lib/memory-link";
import { isMeetingsPath, SELECTION_TEXT, meetingsBlock, personSelectionHref, selectionCountLine, selectionFallbackName, selectionLook, selectionSearch, selectionTitle } from "@/lib/selection";
import { COLLEAGUES_MESSAGES } from "@/lib/colleagues";
import { callTool, type McpResult } from "@/lib/mcp";
import { requireWorkspace } from "@/lib/me";
import { meGw, type MeResult } from "@/lib/me-api";
import { profileOn, publicProfileOf, publicProfilePath } from "@/lib/my-profile";
import { navSummary } from "@/lib/nav";
import { PublicProfileBlock } from "@/components/public-profile";
import { ARCHIVE_MESSAGES } from "@/lib/archive";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import { asMeSpace, browseHref, hubGroups, projectRecordsHref, type HubGroup } from "@/lib/spaces";
import { canExportSpace } from "@/lib/export";
import { readmeMissing, readmeOn, readmeTemplateOf } from "@/lib/space-readme";
import type { ListEntry, ListResult, Me, MeSpace, MySpace, MySpacesPage, PublicProfile, SearchResult, SpaceReadmeConfig } from "@/lib/types";
import { updateReadmeAction } from "../projects/actions";
import { ReadmeForm, ReadmeNudge } from "../projects/readme-parts";
import { BackLink, ClassTag, RoleChip, SpaceHeader } from "./space-parts";
import { ExportSpaceButton } from "./export-button";
import { SpaceListing } from "./space-records";


export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const raw = param(await searchParams, "path");
  if (!raw) return { title: M.spacesAndProjects };
  try {
    const { me } = await requireWorkspace();
    const segs = (pathOf(raw, me.spaces, me.spaces.find((s) => s.kind === "personal") ?? me.spaces[0] ?? null) ?? "").split("/").filter(Boolean);
    return { title: (segs[0] === "spaces" ? me.spaces.find((s) => s.slug === segs[1])?.name : null) ?? M.spacesAndProjects };
  } catch {
    return { title: M.spacesAndProjects };
  }
}


const GROUP_ICON: Record<HubGroup["key"], "home" | "users" | "layers"> = { base: "home", teams: "users", projects: "layers" };
const ROOT_RECENT_LIMIT = 10;
const HUB_PROJECTS_PAGE = 24, ARCHIVE_LIMIT = 20;

function pathOf(raw: string, spaces: MeSpace[], home: MeSpace | null): string | null {
  const valid = raw.length <= 512 && !raw.startsWith("//") && /^\/(me|org|spaces|entities|people)?(\/[^/\s]+)*\/?$/.test(raw)
    && !raw.split("/").some((seg) => seg === "." || seg === "..");
  const segs = valid ? raw.split("/").filter(Boolean) : [];
  const alias = segs[0] === "me" ? spaces.find((s) => s.kind === "personal") : segs[0] === "org" ? spaces.find((s) => s.kind === "org") : undefined;
  if (alias) return `/spaces/${[alias.slug, ...segs.slice(1)].join("/")}`;
  if (segs.length < 2 || segs[0] === "me" || segs[0] === "org") return home ? `/spaces/${home.slug}` : null;
  return `/${segs.join("/")}`;
}

async function hub({ me, sessionKey, preview, archivedOpen, pp, acur }: { me: Me; sessionKey: string; preview: boolean; archivedOpen: boolean; pp: string; acur: string }) {
  const hasArchive = (me.archived_spaces ?? 0) > 0 || Boolean(acur);
  const arch = hasArchive && archivedOpen ? await meGw<MySpacesPage>(sessionKey, "/api/v1/me/spaces", { query: { archived: "true", limit: ARCHIVE_LIMIT, cursor: acur || undefined } }) : null;
  const keep = { ...(pp ? { pp } : {}), ...(archivedOpen ? { archived: "1" } : {}) };
  return (
    <>
      <PageHead title={M.spacesAndProjects2} lead={M.sharedMemoryFoldersEachHasItsOwn}
        actions={preview ? null : <Link href="/projects/new" prefetch={false} className="btn sm primary">{rich(M.newProjectLine, { tag1: () => <Icon name="plus" /> })}</Link>} />
      {!me.spaces.length ? <Empty icon="layers">{M.youDoNotHaveAnySpacesYet}</Empty> : null}
      {hubGroups(me.spaces).map((g) => {
        if (!g.spaces.length && g.key !== "projects") return null;
        const page = g.key === "projects" ? slicePage(g.spaces, pp, HUB_PROJECTS_PAGE) : null;
        const shown = page ? page.items : g.spaces;
        return (
          <section className="sp-group" key={g.key} id={`sp-group-${g.key}`} aria-labelledby={`sp-${g.key}`}>
            <h2 className="sp-group-title" id={`sp-${g.key}`}><Icon name={GROUP_ICON[g.key]} />{g.title}</h2>
            {g.spaces.length || !preview ? (
              <div className="sc-grid">
                {shown.map((s) => <SpaceCard key={s.slug} s={s} preview={preview} />)}
                {g.key === "projects" && !preview && (!page || page.page === page.pages) ? <NewProjectCard /> : null}
              </div>
            ) : <p className="sp-none">{M.noProjectsYet}</p>}
            {page && page.pages > 1 ? <LocalPager path="/browse" params={{ ...keep, pp: "" }} pageName="pp" page={page} anchor="sp-group-projects" /> : null}
          </section>
        );
      })}
      {hasArchive ? (
        archivedOpen ? (
          <section className="sp-group" id="archive" aria-labelledby="sp-archive">
            <div className="sp-group-head">
              <h2 className="sp-group-title" id="sp-archive">{rich(M.projectArchiveLine, { tag1: () => <Icon name="archive" /> })}</h2>
              <Link href="/browse" prefetch={false} className="sp-link">{M.hideArchive}</Link>
            </div>
            <p className="sp-line">{M.completedProjectsAndTeamsReadOnly}</p>
            <details className="sp-more-info"><summary>{M.whatYouCanDoWithArchivedRecords}</summary><p>{ARCHIVE_MESSAGES.completedProjectsAndTeamSpacesYouCan}</p></details>
            {!arch ? null : !arch.ok ? <LoadError result={arch} what={M.archive} /> : !arch.data.items.length ? (acur ? <Empty>{M.nothingFurther}</Empty> : <Empty icon="archive">{M.theArchiveIsEmpty}</Empty>) : (
              <div className="sc-grid">
                {arch.data.items.map((s) => (
                  <SpaceCard key={s.slug} s={asMeSpace(s)} archived href={`/projects/${encodeURIComponent(s.slug)}`}
                    note={s.archived_at ? <>{rich(M.archivedSinceLine, null, { value1: formatDay(s.archived_at), value2: s.archived_by ? M.archivedBy(s.archived_by.display_name || s.archived_by.login) : "" })}</> : null} />
                ))}
              </div>
            )}
            {arch?.ok && (acur || arch.data.next_cursor) ? (
              <CursorPager path="/browse" params={{ ...keep, acur }} cursorName="acur" cursor={acur} nextCursor={arch.data.next_cursor}
                prevCursor={acur ? String(Math.max(0, Number(acur) - ARCHIVE_LIMIT)) : null} shown={arch.data.items.length} anchor="archive" />
            ) : null}
          </section>
        ) : (
          <p className="sp-foot"><Link href="/browse?archived=1#archive" prefetch={false} className="sp-link">{rich(M.projectArchiveLine2, { tag1: () => <Icon name="archive" />, tag2: () => <Icon name="chevron" /> })}</Link></p>
        )
      ) : null}
    </>
  );
}

function SpaceHead({ s, preview }: { s: MeSpace; preview: boolean }) {
  const look = spaceLook(s), role = roleLine(s);
  const add = canAdd(s) && !preview;
  const exportable = canExportSpace(s, preview);   // the owner exports the space from here
  return (
    <SpaceHeader icon={look.icon} tone={look.tone} kind={look.kind} name={s.name} who={look.audience} whoKind={s.kind}
      role={s.kind === "personal" ? null : <RoleChip label={role.label} owner={s.role === "owner"} />}
      tags={s.kind === "personal" ? null : <ClassTag cls={s.default_class} />}
      hint={role.hint} about={s.description}
      actions={add || s.kind === "project" || exportable ? (
        <>
          {add ? <Link href={`/materials?space=${encodeURIComponent(s.slug)}#upload`} prefetch={false} className="btn primary"><Icon name="plus" />{PLAIN.addHere}</Link> : null}
          {s.kind === "project" ? <Link href={`/projects/${encodeURIComponent(s.slug)}`} prefetch={false} className="btn">{rich(M.projectPageLine, { tag1: () => <Icon name="layers" /> })}</Link> : null}
          <ExportSpaceButton slug={s.slug} role={s.role} preview={preview} />
        </>
      ) : null} />
  );
}

function SelectionHead({ path, readme, count, more }: { path: string; readme: string | null; count: number; more: boolean }) {
  const look = selectionLook(path), name = selectionTitle(readme) ?? selectionFallbackName(path), find = selectionSearch(name);
  const meetings = isMeetingsPath(path), login = path.split("/").filter(Boolean)[1] ?? "";
  return (
    <SpaceHeader icon={look.icon} tone={look.tone} kind={look.kind} name={name} who={selectionCountLine(name, count, more, meetings)} whoKind="selection"
      hint={meetings ? SELECTION_TEXT.meetingsHint : SELECTION_TEXT.selectionHint} actions={(
        <>
          <Link href={find.href} prefetch={false} className="btn"><Icon name="search" />{find.label}</Link>
          {meetings && login ? <Link href={personSelectionHref(login)} prefetch={false} className="btn"><Icon name="user" />{SELECTION_TEXT.personRecordsLink}</Link> : null}
        </>
      )} />
  );
}

function MeetingsBlock({ e, name, back }: { e: ListEntry; name: string; back: string }) {
  const b = meetingsBlock(name, e.count ?? 0);
  return (
    <section className="sp-group" aria-labelledby="sp-meetings">
      <h2 className="sp-group-title" id="sp-meetings"><Icon name="mic" />{b.title}</h2>
      <p className="sp-line">{b.line} <Link href={browseHref(e.path, null, back)} prefetch={false} className="sp-link">{b.link}<Icon name="chevron" /></Link></p>
    </section>
  );
}

async function orgReadmeBlock(sessionKey: string, slug: string) {
  let card: MeResult<MySpace> | null = null;
  try { card = await meGw<MySpace>(sessionKey, `/api/v1/me/spaces/${encodeURIComponent(slug)}`); } catch { card = null; }
  if (!card?.ok || !readmeOn(card.data) || card.data.role !== "owner") return null;
  const empty = readmeMissing(card.data);
  let template: string | null = null;
  if (empty) { try { template = readmeTemplateOf(await meGw<SpaceReadmeConfig>(sessionKey, "/api/v1/me/space-readme")); } catch { template = null; } }
  return (
    <section className="sp-group" id="readme" aria-labelledby="sp-readme">
      <h2 className="sp-group-title" id="sp-readme"><Icon name="text" />{SPACE_README.orgTitle}</h2>
      <p className="sp-line">{SPACE_README.orgHint}</p>
      {empty ? <ReadmeNudge /> : null}
      <details className="sp-more-info" open={empty}>
        <summary>{empty ? SPACE_README.fill : SPACE_README.orgEdit}</summary>
        <ReadmeForm action={updateReadmeAction} slug={slug} readme={card.data.readme ?? null} template={template} />
      </details>
    </section>
  );
}

// the owner may still export an archived space (read-only data), so the export button is shown here too.
function ArchivedHead({ s, preview }: { s: MySpace; preview: boolean }) {
  const look = spaceLook(asMeSpace(s));
  const exportable = canExportSpace(s, preview);
  return (
    <SpaceHeader icon="archive" tone="gray" kind={look.kind} name={s.name} who={look.audience} whoKind={s.kind}
      tags={<Badge tone="muted">{M.archived}</Badge>} hint={ARCHIVE_MESSAGES.theSpaceIsArchivedReadOnlySearch} about={s.description}
      actions={s.kind === "project" || exportable ? (
        <>
          {s.kind === "project" ? <Link href={`/projects/${encodeURIComponent(s.slug)}`} prefetch={false} className="btn">{rich(M.projectPageLine2, { tag1: () => <Icon name="layers" /> })}</Link> : null}
          <ExportSpaceButton slug={s.slug} role={s.role} preview={preview} />
        </>
      ) : null} />
  );
}

export default async function BrowsePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const preview = Boolean(session.preview);
  const raw = param(sp, "path");
  const acur = /^\d{1,7}$/.test(param(sp, "acur")) ? param(sp, "acur") : "";
  if (!raw) return hub({ me, sessionKey: session.key, preview, archivedOpen: param(sp, "archived") === "1" || Boolean(acur), pp: param(sp, "pp"), acur });

  const personal = me.spaces.find((s) => s.kind === "personal") ?? null;
  const home = personal ?? me.spaces[0] ?? null;
  const path = pathOf(raw, me.spaces, home);
  const cursor = param(sp, "cursor");
  const segs = path ? path.split("/").filter(Boolean) : [];
  const current = segs[0] === "spaces" ? me.spaces.find((s) => s.slug === segs[1]) ?? null : null;
  if ((current?.kind === "project" || current?.kind === "team") && path) redirect(projectRecordsHref(current.slug, path, cursor));
  const rootOf = current && segs.length === 2 && !cursor ? current.slug : null;
  const recentOpts = current?.kind === "org" ? { types: ORG_RECENT_TYPES } : {};
  const archList = (me.archived_spaces ?? 0) > 0 && segs[0] === "spaces" && !current
    ? await meGw<MySpacesPage>(session.key, "/api/v1/me/spaces", { query: { archived: "true", limit: 100 } }) : null;
  const archivedCurrent = segs[0] === "spaces" && !current && archList?.ok ? archList.data.items.find((s) => s.slug === segs[1]) ?? null : null;
  if ((archivedCurrent?.kind === "project" || archivedCurrent?.kind === "team") && path) redirect(projectRecordsHref(archivedCurrent.slug, path, cursor));
  const aboutPath = segs[0] === "people" && segs.length === 2 && !preview && profileOn(await navSummary(session.key).then((r) => r.data, () => null))
    ? publicProfilePath(segs[1]) : null;
  const [res, recent, aboutRes] = await Promise.all([
    path ? callTool<ListResult>(session.key, "memory_list", { path, limit: 100, ...(cursor ? { cursor } : {}) }) : null,
    rootOf ? callTool<SearchResult>(session.key, "memory_search", recentArgs(rootOf, ROOT_RECENT_LIMIT, undefined, recentOpts)) : null,
    aboutPath ? meGw<PublicProfile>(session.key, aboutPath) : null,
  ]);
  const about = publicProfileOf(aboutRes);
  const named = current ?? archivedCurrent;
  const selection = segs[0] === "entities" || segs[0] === "people";
  const orgRoot = current?.kind === "org" && segs.length === 2;
  const orgReadme = orgRoot && current?.role === "owner" && !preview && !cursor ? await orgReadmeBlock(session.key, current.slug) : null;
  const all = res?.ok ? res.data.entries : [];
  const profilesHidden = orgRoot && all.some((e) => e.kind === "folder" && e.type === "profile");
  const entries = profilesHidden ? all.filter((e) => !(e.kind === "folder" && e.type === "profile")) : all;
  const shown = res?.ok && profilesHidden ? { ...res, data: { ...res.data, entries } } : res;
  const meetingsEntry = selection ? entries.find((e) => e.kind === "folder" && isMeetingsPath(e.path)) ?? null : null;
  const records = entries.filter((e) => e.kind !== "folder");
  const from = backHref(param(sp, "from"));
  const hrefOf = (p: string, c?: string | null) => browseHref(p, c, c ? from : null);

  return (
    <>
      <BackLink href={from ?? "/browse"}>{from ? M.back : M.spacesAndProjects3}</BackLink>
      {current ? <><SpaceHead s={current} preview={preview} /><SpaceSearch slug={current.slug} name={current.name} />{orgReadme}</>
        : archivedCurrent ? <><ArchivedHead s={archivedCurrent} preview={preview} /><SpaceSearch slug={archivedCurrent.slug} name={archivedCurrent.name} /></>
        : selection && res?.ok ? (
          <><SelectionHead path={path!} readme={res.data.readme ?? null} count={records.length} more={Boolean(res.data.next_cursor || cursor)} />
            {about ? <PublicProfileBlock p={about} /> : null}</>
        ) : <h1 className="vis-hidden">{M.spacesAndProjects4}</h1>}
      {!shown || !path ? <Empty icon="layers">{M.youDoNotHaveAnySpacesYet}</Empty> : (
        <SpaceListing res={shown} recent={recent as McpResult<SearchResult> | null} path={path} name={named?.name ?? null} hrefOf={hrefOf}
          skipFolder={meetingsEntry ? (e) => e === meetingsEntry : undefined}
          extra={<>
            {profilesHidden ? <p className="sp-line">{rich(M.openColleaguesLine, { tag1: () => <Icon name="users" />, tag3: (children) => <Link href="/colleagues" prefetch={false}>{children}</Link>, tag2: (children) => <span>{children}</span> }, { value1: COLLEAGUES_MESSAGES.colleagueCardsAreInColleaguesSearchBy })}</p> : null}
            {meetingsEntry && res?.ok ? <MeetingsBlock e={meetingsEntry} name={selectionTitle(res.data.readme) ?? selectionFallbackName(path)} back={browseHref(path, null, from)} /> : null}
          </>}
          empty={current ? emptySpaceText(current, { preview }) : PLAIN.emptySelectionText} />
      )}
    </>
  );
}
