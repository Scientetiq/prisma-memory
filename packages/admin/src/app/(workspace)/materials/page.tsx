import { rich } from "@/i18n/rich";
import { texts as M } from "@/messages/ws-materials";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon, TYPE_ICON } from "@/components/icons";
import { ListHead } from "@/components/list-head";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { RecordRow } from "@/components/record-row";
import { Code, Empty, Field, Notice, PageHead } from "@/components/ui";
import { TzField } from "@/components/tz-field";
import { CLOSED_EXPLAIN_ANCHOR, CLOSED_CLASS_TEXT, ACCESS_ACTION, OPEN_CLASS_SPEC, readsClosed } from "@/lib/closed-class";
import { COLLEAGUES_MESSAGES } from "@/lib/colleagues";
import { HOME_TEXT, MATERIALS_RECENT_LIMIT, materialsLead, ORG_RECENT_TYPES, recentArgs, recordKind } from "@/lib/home";
import { EVENT_KIND_TITLES, EVENT_KINDS, RECORD_TYPES } from "@/lib/labels";
import { callTool, toolErrorMessage } from "@/lib/mcp";
import { meGw } from "@/lib/me-api";
import { personalSpace, requireWorkspace, uploadLimits, writableSpaces } from "@/lib/me";
import { formatCount, RECORD_TYPE_FOLDERS, SECTION_TITLES, spaceLook, visibilityOf, type Visibility } from "@/lib/plain";
import { hrefWith, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { NAV_ICONS } from "@/lib/nav-icons";
import { TRASH_TEXT } from "@/lib/trash";
import type { ListEntry, ListResult, MeSpace, SearchResult, StatusBatch } from "@/lib/types";
import { deleteAction, openAction, processNowAction, rememberAction } from "../actions";
import { BackLink } from "../browse/space-parts";
import { SaveTo, type TargetSpace } from "./save-to";
import { ProcessNowGate, StageChips, StagesLive, type ConversionsMap, type QueuesMap, type StagesMap } from "./stage-chips";
import { AddFold } from "./add-fold";
import { UploadZone } from "./upload-zone";
import { VersionBadge } from "../records/[id]/versions-block";
import { versionBadge } from "@/lib/versions";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.materials }; }

const idOf = (e: ListEntry): string => e.id ?? (/^[0-9a-f-]{36}$/i.test(e.path.split("/").pop() ?? "") ? e.path.split("/").pop()! : "");

const targetOf = (s: MeSpace): TargetSpace => {
  const look = spaceLook(s);
  return { slug: s.slug, name: s.name, defaultClass: s.default_class, personal: s.kind === "personal", icon: look.icon, tone: look.tone, kind: s.kind };
};

export default async function MaterialsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const preview = Boolean(session.preview);
  const writable = writableSpaces(me);
  const personal = personalSpace(me);
  const asked = param(sp, "space");
  const current = writable.find((s) => s.slug === asked) ?? personal ?? writable[0] ?? null;
  const askedType = param(sp, "type");
  const type = (RECORD_TYPES as readonly string[]).includes(askedType) ? askedType : "";
  const cursor = param(sp, "cursor");
  const deleted = param(sp, "deleted") === "1";
  const params = { space: current?.slug ?? "", type, cursor };

  const root = current ? await callTool<ListResult>(session.key, "memory_list", { path: `/spaces/${current.slug}`, limit: 100 }) : null;
  const inOrg = current?.kind === "org";
  const allFolders = root?.ok ? root.data.entries.filter((e) => e.kind === "folder" && e.type) : [];
  const profilesHidden = inOrg && allFolders.some((f) => f.type === "profile");
  const folders = profilesHidden ? allFolders.filter((f) => f.type !== "profile") : allFolders;
  const hiddenClosed = root?.ok ? root.data.hidden_closed ?? 0 : 0;

  const listing = current && type ? await callTool<ListResult>(session.key, "memory_list", { path: `/spaces/${current.slug}/${type}`, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }) : null;
  const recent = current && !type ? await callTool<SearchResult>(session.key, "memory_search", recentArgs(current.slug, MATERIALS_RECENT_LIMIT, undefined, inOrg ? { types: ORG_RECENT_TYPES } : {})) : null;

  const rows: Array<{ id: string; title: string; path: string; type: string; snippet: string; occurred_at: string | null; cls: Visibility; hidden: boolean; eventKind: string | null }> =
    listing?.ok
      ? listing.data.entries.filter((e) => e.kind === "record").map((e) => ({
          id: idOf(e), title: e.title ?? "", path: e.path, type: e.type ?? type, snippet: e.summary_line ?? "",
          occurred_at: e.occurred_at ?? e.created_at ?? null, cls: e.hidden ? "closed" : visibilityOf(e.class), hidden: e.hidden === true, eventKind: null,
        }))
      : recent?.ok
        ? recent.data.hits.map((h) => ({ id: h.id, title: h.title, path: h.path, type: h.type, snippet: h.snippet, occurred_at: h.occurred_at, cls: h.class, hidden: false, eventKind: h.event_kind ?? null }))
        : [];

  const statusIds = rows.filter((r) => !r.hidden && r.id).map((r) => r.id).slice(0, PAGE_SIZE);
  const batch = statusIds.length ? await meGw<StatusBatch>(session.key, "/api/v1/records/status", { query: { ids: statusIds.join(","), derived: false, with: "version" }, timeoutMs: 20_000 }) : null;
  const initialStages: StagesMap = {}, initialQueues: QueuesMap = {}, initialConversions: ConversionsMap = {};
  // a document with earlier versions, or a new version still being processed — a badge on its row (with=version:
  // the gateway gives the version facts only on request, to the workspace session, and only for an uploaded document)
  const versionBadges = new Map<string, NonNullable<ReturnType<typeof versionBadge>>>();
  if (batch?.ok) for (const it of batch.data.items ?? []) {
    initialStages[it.id] = it.stages ?? []; initialQueues[it.id] = it.queue ?? null; initialConversions[it.id] = it.conversion ?? null;
    const b = versionBadge(it);
    if (b) versionBadges.set(it.id, b);
  }
  const snapshotAt = Date.now();

  const hiddenRows = rows.filter((r) => r.hidden);
  const firstVisit = current?.kind === "personal" && (current.counts?.records ?? 0) === 0 && !hiddenClosed;
  const closedSpace = current?.default_class === "closed" && me.key.tier === "T2";
  const listError = listing && !listing.ok ? listing : recent && !recent.ok ? recent : null;
  const limits = uploadLimits(me);
  const target = current ? targetOf(current) : null;

  return (
    <>
      <BackLink href="/">{SECTION_TITLES.overview}</BackLink>
      <PageHead title={HOME_TEXT.materialsTitle} lead={materialsLead(target ? { name: target.name, personal: target.personal, defaultClass: target.defaultClass, org: current?.kind === "org" } : null)} />
      {deleted ? <Notice tone="ok">{rich(M.recordDeletedItDisappearedFromSearchLine, { tag1: (children) => <Link href="/trash" prefetch={false}>{children}</Link> })}</Notice> : null}
      {preview ? <Notice tone="info">{M.previewIsReadOnlyYouCannotUpload}</Notice> : null}

      {writable.length > 1 ? (
        <nav className="mt-spaces" aria-label={M.space}>
          {writable.map((s) => {
            const look = spaceLook(s), on = current?.slug === s.slug;
            return (
              <Link key={s.slug} href={`/materials?space=${encodeURIComponent(s.slug)}`} prefetch={false} className="mt-space" aria-current={on ? "true" : undefined}>
                <span className={`ichip xs tone-${look.tone}`}><Icon name={look.icon} /></span>
                <span className="mt-space-name">{s.name}</span>
                {s.counts ? <span className="mt-count">{rich(M.recordsLine, { tag1: (children) => <span className="vis-hidden">{children}</span> }, { value1: formatCount(s.counts.records) })}</span> : null}
                {on ? <Icon name="check" className="ic mt-on" /> : null}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {!preview && target ? (
        <AddFold>
          <section className="mt-card" id="upload" aria-labelledby="upload-title">
            <div className="mt-card-head"><span className="ichip tone-green"><Icon name="upload" /></span><h2 id="upload-title">{M.uploadAFile2}</h2></div>
            <UploadZone space={target} accepted={limits.accepted} maxBytes={limits.maxBytes} converter={limits.converter} exact={limits.exact} />
            <p className="mt-aside">{rich(M.meetingsWithMeLine, { tag1: () => <Icon name="mic" />, tag3: (children) => <Link href="/meetings" prefetch={false}>{children}</Link>, tag2: (children) => <span>{children}</span> }, { value1: HOME_TEXT.transcripts })}</p>
          </section>
          <section className="mt-card" id="note" aria-labelledby="note-title">
            <div className="mt-card-head"><span className="ichip tone-blue"><Icon name="pencil" /></span><h2 id="note-title">{M.writeANote2}</h2></div>
            <SaveTo space={target} />
            <ActionForm action={rememberAction} submitLabel={M.writeANote3} pendingLabel={M.savingNote} resetOnSuccess className="form full mt-note" draft={`note:${target.slug}`}>
              <input type="hidden" name="space" value={target.slug} />
              <textarea name="text" rows={4} required minLength={3} aria-labelledby="note-title"
                placeholder={M.forExampleAgreedWithExampleCorpTo} />
              <details className="mt-more">
                <summary>{rich(M.moreFieldsLine, { tag1: () => <Icon name="chevron-down" /> })}</summary>
                <div className="form-grid">
                  <Field label={M.kind}>
                    <select name="kind" defaultValue="note">
                      <option value="note">{M.note}</option>
                      {EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_KIND_TITLES[k]}</option>)}
                    </select>
                  </Field>
                  <Field label={M.title} hint={M.leaveBlankToUseTheBeginningOf}>
                    <input type="text" name="title" maxLength={200} />
                  </Field>
                  <Field label={M.whenItHappened} hint={M.leaveBlankToUseTheCurrentTime}>
                    <input type="datetime-local" name="occurred_at" />
                    <TzField />
                  </Field>
                </div>
              </details>
            </ActionForm>
          </section>
        </AddFold>
      ) : null}

      <section className="mt-records" id="records" aria-labelledby="records-title">
        <ListHead id="records-title" icon={NAV_ICONS.materials} title={M.records2} />
        {closedSpace ? <Notice tone="info">{rich(M.newRecordsInThisSpaceAreLine, null, { value1: CLOSED_CLASS_TEXT.closedSpaceNotice })}</Notice> : null}

        {current && folders.length ? (
          <nav className="mt-types" aria-label={M.recordType}>{rich(M.recentLine, { tag2: () => <Icon name="clock" />, tag3: (children) => <span>{children}</span>, tag1: (children) => <Link href={`${hrefWith("/materials", params, { type: null, cursor: null })}#records`} prefetch={false} className="mt-type" aria-current={type ? undefined : "true"}>{children}</Link> }, { value1: folders.map((f) => (
              <Link key={f.path} href={`${hrefWith("/materials", params, { type: f.type!, cursor: null })}#records`} prefetch={false} className="mt-type" aria-current={type === f.type ? "true" : undefined}>
                <Icon name={TYPE_ICON[f.type!] ?? "file"} /><span>{RECORD_TYPE_FOLDERS[f.type!] ?? f.type}</span>{typeof f.count === "number" ? <span className="mt-count">{formatCount(f.count)}</span> : null}
              </Link>
            )) })}</nav>
        ) : null}
        {profilesHidden ? <p className="mt-hint">{rich(M.openColleaguesLine, { tag1: () => <Icon name="users" />, tag2: (children) => <Link href="/colleagues" prefetch={false}>{children}</Link> }, { value1: COLLEAGUES_MESSAGES.colleagueCardsAreInColleaguesSearchBy })}</p> : null}

        {!current ? <Empty icon="folder-open" action={<Link href="/browse" className="btn" prefetch={false}>{M.spacesAndProjects}</Link>}>{M.youHaveNoSpaceYouCanWrite}</Empty>
          : listError ? <Notice tone="danger">{rich(M.listCouldNotBeLoadedLine, { tag1: (children) => <strong>{children}</strong> }, { value1: toolErrorMessage(listError) })}</Notice>
          : !rows.length ? (
            firstVisit ? (
              <div className="mt-empty">
                <span className="ichip tone-green"><Icon name="sparkles" /></span>
                <p>{rich(M.nothingHereYetLine, { tag1: (children) => <b>{children}</b> }, { value1: preview ? null : <span>{M.dropAFileOrWriteANote}</span> })}</p>
              </div>
            ) : hiddenClosed ? (
              <Notice tone="info">{rich(M.noVisibleRecordsHereButTheLine, { tag1: (children) => <strong>{children}</strong>, tag2: (children) => <Link href={`#${CLOSED_EXPLAIN_ANCHOR}`} prefetch={false}>{children}</Link> }, { value1: CLOSED_CLASS_TEXT.closedHiddenLabel, value2: hiddenClosed })}</Notice>
            ) : (
              <div className="mt-empty">
                <span className="ichip tone-gray"><Icon name="folder-open" /></span>
                <p><b>{cursor ? M.noRecordsOnThisPage : type ? M.noRecordsOfThisType : M.noRecordsYet}</b></p>
              </div>
            )
          ) : (
            <StagesLive key={statusIds.join(",")} initial={initialStages} queues={initialQueues} conversions={initialConversions} now={snapshotAt}>
              <ul className="mt-list">
                {rows.map((r) => r.hidden ? (
                  <RecordRow key={r.id || r.path} hiddenTitle={M.closedRecordTitleHidden} type={r.type} date={r.occurred_at}
                    actions={<Link href={`#${CLOSED_EXPLAIN_ANCHOR}`} prefetch={false} className="mt-link">{M.whatYouCanDo}</Link>} />
                ) : (
                  <RecordRow key={r.id || r.path} recordId={r.id} href={`/records/${r.id}`} type={r.type} eventKind={r.eventKind} title={r.title} snippet={r.snippet}
                    date={r.occurred_at} cls={r.cls}
                    badges={versionBadges.has(r.id) ? <VersionBadge b={versionBadges.get(r.id)!} /> : undefined}
                    actions={<><StageChips id={r.id} />{!preview ? <ProcessNowGate id={r.id} action={processNowAction} /> : null}</>} />
                ))}
              </ul>
            </StagesLive>
          )}

        {listing?.ok ? (
          <CursorPager path="/materials" params={params} cursorName="cursor" cursor={cursor} nextCursor={listing.data.next_cursor} shown={rows.length} anchor="records" />
        ) : recent?.ok && recent.data.total_estimate > rows.length ? (
          <p className="mt-hint">{rich(M.showingTheMostRecentFindTheLine, { tag1: (children) => <Link href="/search" prefetch={false}>{children}</Link> }, { value1: rows.length })}</p>
        ) : null}

        {current?.default_class === "closed" && readsClosed(me.key) && !closedSpace ? (
          <details className="mt-more mt-closed">
            <summary>{rich(M.whoCanSeeClosedRecordsLine, { tag1: () => <Icon name="lock" />, tag2: () => <Icon name="chevron-down" /> })}</summary>
            <p>{CLOSED_CLASS_TEXT.closedSessionLine}</p>
          </details>
        ) : null}
      </section>

      {current && (hiddenClosed || !readsClosed(me.key)) ? (
        <section className="mt-hidden" id={CLOSED_EXPLAIN_ANCHOR} aria-labelledby="closed-title">
          <ListHead id="closed-title" icon="lock" title={CLOSED_CLASS_TEXT.closedExplainTitle} />
          <p className="mt-hidden-lead">{rich(M.inLine, { tag1: () => <Icon name="eye" />, tag3: (children) => <b className="hidden-count">{children}</b>, tag2: (children) => <span>{children}</span> }, { value1: current.name, value2: CLOSED_CLASS_TEXT.closedHiddenLabel, value3: hiddenClosed, value4: CLOSED_CLASS_TEXT.closedHiddenHint })}</p>
          <details className="mt-more">
            <summary>{rich(M.moreDetailsLine, { tag1: () => <Icon name="chevron-down" /> })}</summary>
            <p>{CLOSED_CLASS_TEXT.closedSpaceNotice}</p>
            {hiddenClosed ? <p>{CLOSED_CLASS_TEXT.closedHiddenActions}</p> : null}
          </details>
          {hiddenClosed && !type ? <p className="mt-hint">{M.hiddenRecordIdsAndActionsAreIn}</p> : null}
          {hiddenRows.length ? (
            <ul className="hidden-list">
              {hiddenRows.map((r) => (
                <li key={r.id}>
                  <Code title={M.recordId}>{r.id}</Code>
                  <span className="when">{r.occurred_at ? <LocalTime iso={r.occurred_at} /> : M.dateUnknown}</span>
                  <span className="muted small">{recordKind(r.type)}</span>
                  {preview ? <span className="acts muted small">{M.actionsDisabledInPreview}</span> : (
                    <span className="acts">
                      <ActionForm action={deleteAction} submitLabel={M.delete} pendingLabel="…" compact danger confirm={TRASH_TEXT.deleteConfirm}>
                        <input type="hidden" name="id" value={r.id} />
                      </ActionForm>
                    </span>
                  )}
                  {preview ? null : (
                    <details>
                      <summary>{ACCESS_ACTION.show}</summary>
                      <Notice tone="warn">{rich(M.youWillNotSeeTheRecordLine, { tag1: (children) => <strong>{children}</strong> }, { value1: CLOSED_CLASS_TEXT.openClassLead, value2: CLOSED_CLASS_TEXT.openClassWarning })}</Notice>
                      <ActionForm action={openAction} submitLabel={ACCESS_ACTION.show} pendingLabel="…" danger confirm={OPEN_CLASS_SPEC}>
                        <input type="hidden" name="id" value={r.id} />
                        <label className="check ack-fallback"><input type="checkbox" name="confirm" /> {M.iUnderstandTheConsequences}</label>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
