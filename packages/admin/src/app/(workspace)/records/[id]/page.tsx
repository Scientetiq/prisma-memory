import { pageText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { ActionForm } from "@/components/action-form";
import { Icon, recordIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { RetryLater } from "@/components/retry-later";
import { Badge, Code, Empty, Notice, PageHead, Section } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { ENTITY_ROLE_TITLES, EVENT_KIND_TITLES, SOURCE_KIND_TITLES, SPACE_ROLE_YOU, agentFileLine, conversionFailedWhy, conversionLine, originalWithheld } from "@/lib/labels";
import { CLOSED_CLASS_TEXT, despiteOffered, keptNotice, openCheckAdviceText, openCheckLead, openCheckReason, readsClosed, CLOSED_CLASS_COPY } from "@/lib/closed-class";
import { fmtTime, isPlainTextMime, renderMarkdown } from "@/lib/markdown";
import { callTool, toolErrorMessage, type McpResult } from "@/lib/mcp";
import { meGw } from "@/lib/me-api";
import { meetingParticipants, meetingState, personName, type MeetingParticipants, type MeetingReason } from "@/lib/meetings";
import { param, type SearchParams } from "@/lib/paging";
import { publicOrigin, requireWorkspace } from "@/lib/me";
import { CUSTODY_PLAIN, formatDay, PROFILE_PLAIN } from "@/lib/plain";
import { EXTENDED_OPEN_PLAIN, HANDOVER_PLAIN, MEETING_PROMOTE, mimePlain, MOVING_PLAIN, PROMOTE_PLAIN, RETURN_PERSONAL, SECTION_TITLES, promoteTargetSpaces, removeAskerConfirm, spaceName } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import { isMoving } from "@/lib/record-moving";
import { isPublicCopyRecord, isWorkProfileRecord } from "@/lib/work-profile";
import { MY_PROFILE_HREF, profileOn, publicProfileOf, publicProfilePath } from "@/lib/my-profile";
import { navSummary } from "@/lib/nav";
import { PublicProfileBlock } from "@/components/public-profile";
import { retryable } from "@/lib/retry";
import { personSelectionHref, selectionSearch } from "@/lib/selection";
import { publicGatewayUrl } from "@/lib/snippets";
import { employeeStatus, failedFinal, processNowLabel, processNowOffer, stillProcessing, summarizeStages, stagesAdvice } from "@/lib/stages";
import { StateWhy } from "../../materials/stage-chips";
import type { MySpace, OpenCheckMark, OpenPreview, PublicProfile, ReadResult, RecordCore, RecordReaders, SearchResult, ShowAnywayToggles, StatusBatch, StatusResult } from "@/lib/types";
import { ARCHIVE_TEXT } from "@/lib/archive";
import { keepMeetingAction, meetingParticipantAction, returnToPersonalAction } from "../../actions";
import { TRASH_TEXT, meetingDeleteConfirm } from "@/lib/trash";
import { DELETION_REQUESTS_TEXT, myDeletionRequests, REQUESTER_GONE, type IncomingRequest } from "@/lib/deletion-requests";
import { OLD_VERSION } from "@/lib/corrections";
import { noteDigest } from "@/lib/corrections-api";
import type { MeetingDecisions } from "@/lib/decisions";
import { dueCheckNotice, dueLooksPast } from "@/lib/due-check";
import { recordKind, recordState } from "@/lib/home";
import { firstWords, meetingTimeHref, parseRecordRange, rangeHref, renderedIds, tocHref, transcriptLines } from "@/lib/record-range";
import { dayWords, ingestedDiffers, originText, ownerName, peopleNames, profileShown, recordTabTitle, summaryLineShown, type ParentRef } from "@/lib/record-view";
import type { HandoverForm, RecordCorrections, RecordDerivation, RecordDerivationSources, RecordOrgReview } from "@/lib/types";
import { BulkActorForm } from "./bulk-actor-form";
import { CopyLink } from "./copy-link";
import { CorrectLink } from "./correct-link";
import { CorrectBlock, type NewerSearch } from "./correct-block";
import { CorrectionsBlock } from "./corrections-block";
import { DecisionsList } from "./decisions-list";
import { EdgeStatusBlock, edgeStatusOf } from "./edge-status-block";
import { RecheckBlock, recheckOf } from "./recheck-block";
import { basedOnOf, DerivationBlock } from "./derivation-block";
import { HandoverBlock } from "./handover-block";
import { MeetingProject } from "./meeting-project";
import { MovingWait } from "./moving-wait";
import { OrgReviewBlock } from "./org-review-block";
import { AccessBlock, DeleteBlock, OwnerGroup, ProcessNowButton } from "./owner-actions";
import { MeetingComposition, ParticipantsBlock } from "./participants-block";
import { PromoteForm } from "./promote-form";
import { ShowAnywayPanel } from "./show-anyway-panel";
import { despiteHere, editOf, staleParam } from "@/lib/show-anyway";
import { WhoSeesBlock } from "./who-sees";
import { recordTrail, searchBackHref } from "@/lib/record-nav";
import { RecordPath } from "./record-trail";
import { VersionPendingNotice, VersionsBlock } from "./versions-block";
import { VersionUpload } from "./version-upload";
import { canUploadVersion, deleteConfirmWithVersions, ownPending, versionsShown } from "@/lib/versions";
import { recordVersions } from "@/lib/versions-api";
import { VERSIONS_TEXT } from "@/lib/versions.messages";
import { TranscriptJump } from "./transcript-jump";
import { ORG_DONE, ORG_REVIEW_TEXT } from "@/lib/org-review";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_MAX_TOKENS = 64_000;

const readRecord = cache(async (key: string, id: string, range: string, sid: string) =>
  callTool<ReadResult>(key, "memory_read", { id, max_tokens: READ_MAX_TOKENS, ...(range ? { range: JSON.parse(range) } : {}), ...(sid ? { search_id: sid } : {}) }));

function readArgs(sp: SearchParams): { range: string; sid: string } {
  const r = parseRecordRange(sp), sid = param(sp, "sid");
  return { range: r ? JSON.stringify(r) : "", sid: UUID.test(sid) ? sid.toLowerCase() : "" };
}

export async function generateMetadata({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: M.record };
  const { session } = await requireWorkspace();
  const a = readArgs(await searchParams);
  const res = await readRecord(session.key, id, a.range, a.sid);
  if (!res.ok) return { title: M.record };
  const data = res.data as ReadResult & { hidden?: boolean };
  return { title: recordTabTitle(data.hidden ? (data as unknown as RecordCore) : data.metadata, { hidden: data.hidden }) };
}

function ItDetails({ m, conversion }: { m: RecordCore; conversion: string | null }) {
  return (
    <details className="it-details">
      <summary>{rich(M.detailsForIt, null)}</summary>
      <div className="kv-list">
        <div className="kv"><span>{rich(M.path, null)}</span><Code>{m.path}</Code></div>
        <div className="kv"><span>{rich(M.recordNumber, null)}</span><Code>{m.id}</Code></div>
        {m.source_kind ? <div className="kv"><span>{rich(M.source, null)}</span><span>{M.sourceDetails(m.source_kind, m.source_ref ?? null)}</span></div> : null}
        {typeof m.token_count === "number" ? <div className="kv"><span>{rich(M.sizeInTokens, null)}</span><span>{m.token_count}</span></div> : null}
        {m.version ? <div className="kv"><span>{rich(M.version, null)}</span><span>{m.version}</span></div> : null}
        {m.original?.mime ? <div className="kv"><span>{rich(M.fileFormat, null)}</span><span>{mimePlain(m.original.mime)} · <Code>{m.original.mime}</Code></span></div> : null}
        {conversion ? <div className="kv"><span>{rich(M.fileConversion, null)}</span><span>{conversion}</span></div> : null}
      </div>
    </details>
  );
}

function ArchivedNotice() {
  return <Notice tone="warn"><strong>{rich(M.thisRecordSSpaceIsArchived, null)}</strong> {ARCHIVE_TEXT.archivedReadonly}</Notice>;
}

function OpenCheckNotice({ mark, source, origin, where, offered }: { mark: OpenCheckMark; source?: string | null; origin?: string | null;
                           where: { personal?: boolean; space?: string | null; kind?: string | null }; offered?: boolean }) {
  const kept = keptNotice(mark, source, where);
  if (kept) return (
    <Notice tone="warn">
      <strong>{M.keptHeader}</strong> {kept.why} {openCheckAdviceText(mark, { offered })}
    </Notice>
  );
  return (
    <Notice tone="warn">{rich(M.checkHeader(Boolean(mark.at)), { tag0: (children) => <strong>{children}</strong> }, { at: mark.at ? <LocalTime iso={mark.at} /> : null })} {M.checkBody(mark, source ?? null, origin ?? null, where.personal !== false, where.space ?? null, offered !== false, despiteOffered(mark))}</Notice>
  );
}

function ProcessingState({ stages, advice }: { stages: Parameters<typeof recordState>[0]; advice: string | null }) {
  const st = recordState(stages);
  const s = summarizeStages(stages);
  if (!st) return <span className="muted">{s.label}</span>;
  return (
    <span className="st-line">
      <span className={`st ${st.tone}`}><Icon name={st.icon} /><span className="st-l">{st.label}</span></span>
      {st.state !== "done" && !finalRefusal(s) ? <StateWhy detail={st.detail} advice={advice} /> : null}
    </span>
  );
}

const finalRefusal = (s: ReturnType<typeof summarizeStages>): boolean => s.state === "failed" && s.terminal && !s.tooSlow;

function despiteOf(m: RecordCore): { reopen: boolean } | null {
  if (m.class !== "closed") return null;
  if (m.open_check?.result === "closed") return despiteOffered(m.open_check) ? { reopen: false } : null;
  if (m.open_check_accepted) return { reopen: true };
  return null;
}

const isDirectoryCard = (m: Pick<RecordCore, "source_kind" | "source_ref" | "type" | "hidden">, inOrg: boolean): boolean =>
  (m.source_kind === "pipeline" && Boolean(m.source_ref?.startsWith("people:"))) || (Boolean(m.hidden) && m.type === "profile" && inOrg);

function askerGone(r: IncomingRequest, people: MeetingParticipants | null): "left" | "removed" | null {
  if (r.requester_gone) return r.requester_gone;
  if (!people) return null;
  const login = r.requester.login.toLowerCase();
  if ([...people.participants, ...people.pending].some((p) => p.login.toLowerCase() === login)) return null;
  return (people.left ?? []).some((p) => p.login.toLowerCase() === login) ? "left" : "removed";
}

const cardName = (title: string | null | undefined): string | null => title?.split(" — ")[0]?.trim() || null;

function ReturnPersonal({ m, where, listed }: { m: RecordCore; where: string | null; listed: number }) {
  return (
    <>
      {m.parent_id ? (
        <>
          <p className="hint">{M.returnExplanation(where, true, m.type === "transcript" && Boolean(listed), m.class === "open")}</p>
          <p className="hint">{rich(M.returnParent, { link: children => <Link href={`/records/${m.parent_id}`} prefetch={false}>{children}</Link> })}</p>
        </>
      ) : <p className="hint">{M.returnExplanation(where, false, m.type === "transcript" && Boolean(listed), m.class === "open")}</p>}
      <ActionForm action={returnToPersonalAction} submitLabel={RETURN_PERSONAL.button} pendingLabel="…" quiet confirm={RETURN_PERSONAL.confirm}>
        <input type="hidden" name="id" value={m.id} />
        <input type="hidden" name="listed" value={String(listed)} />
      </ActionForm>
    </>
  );
}

function ReturnVersions({ id, listed }: { id: string; listed: number }) {
  return (
    <details>
      <summary>{RETURN_PERSONAL.versions}</summary>
      <p className="hint">{RETURN_PERSONAL.versionsHint}</p>
      <ActionForm action={returnToPersonalAction} submitLabel={RETURN_PERSONAL.button} pendingLabel="…" quiet confirm={RETURN_PERSONAL.versionsConfirm}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="listed" value={String(listed)} />
      </ActionForm>
    </details>
  );
}

async function recordCorrections(key: string, id: string): Promise<{ data: RecordCorrections | null; fragment: McpResult<ReadResult> | null }> {
  const r = await meGw<RecordCorrections>(key, `/api/v1/records/${id}/corrections`);
  if (!r.ok) return { data: null, fragment: null };
  const f = r.data.kinds.some((k) => k.kind === "extraction_error") ? r.data.fragment : null;
  return { data: r.data, fragment: f ? await callTool<ReadResult>(key, "memory_read", { id: f.meeting_id, range: { time_from: f.time_from, time_to: f.time_to }, max_tokens: 2000 }) : null };
}

export default async function RecordPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const { id } = await params;
  if (!UUID.test(id)) return <><PageHead title={M.recordUnavailable} /><Empty icon="link" action={<UnavailableActions />}>{rich(M.theRecordLinkIsInvalidIt, null)}</Empty></>;
  const sp0 = await searchParams;
  const ra = readArgs(sp0);
  const range = parseRecordRange(sp0);
  const toSearch = searchBackHref(param(sp0, "back"));
  const [res, origin] = await Promise.all([readRecord(session.key, id, ra.range, ra.sid), publicOrigin(me)]);

  if (!res.ok && isMoving(res)) {
    return (
      <>
        <RecordPath back={toSearch} />
        <PageHead title={M.record} />
        <div className="notice info" role="status" data-moving="">
          <strong>{MOVING_PLAIN.lead}</strong> — <MovingWait />
        </div>
      </>
    );
  }

  if (!res.ok) {
    const maybeClosed = res.code === "not_found" && me.key.tier === "T2" && !session.preview;
    const unavailable = res.code === "not_found";
    return (
      <>
        <RecordPath back={toSearch} />
        <PageHead title={unavailable ? M.recordUnavailable : M.record} />
        {res.code === "class_denied" ? (
          <Notice tone="warn">{rich(M.thisIsAClosedRecordOnly, { tag0: (children) => <strong>{children}</strong> })}</Notice>
        ) : unavailable && readsClosed(me.key) ? (
          <Notice tone="info">{rich(M.theRecordWasDeletedOrMoved, { tag0: (children) => <Link href="/trash" prefetch={false}>{children}</Link> })}</Notice>
        ) : unavailable ? (
          <Notice tone="info">{rich(M.theRecordWasDeletedOrMoved2, null)}</Notice>
        ) : res.code === "rate_limited" ? (
          <Notice tone="info"><strong>{rich(M.theRecordHasNotOpenedYet, null)}</strong> <RetryLater seconds={res.retryAfter ?? null} limited /></Notice>
        ) : (
          <div className="notice danger" role="alert" data-error-code={res.code}>
            <strong>{rich(M.theRecordCouldNotBeOpened, null)}</strong> {toolErrorMessage(res)}{" "}
            {retryable(res.code, res.status) ? <RetryLater seconds={res.retryAfter ?? null} /> : null}
          </div>
        )}
        <UnavailableActions />
        <details className="it-details">
          <summary>{rich(M.details, null)}</summary>
          <span className="muted small">
            {rich(M.recordNumberLine, { code: (children) => <Code>{children}</Code> }, { id })}{unavailable ? M.memoryDeliberatelyGivesTheSameResponse : ""}
            {!unavailable && res.code !== "class_denied" ? <>{rich(M.errorCode, { code: (children) => <Code>{children}</Code> }, { code: res.code })}</> : null}
          </span>
        </details>

        {maybeClosed ? (
          <Section title={M.ownerActions} id="owner-actions" icon="settings" hint={CLOSED_CLASS_TEXT.closedHiddenActions}>
            <p className="hint">{rich(M.ifThisIsNotYourRecord, null)}</p>
            <div className="owner-actions">
              <AccessBlock id={id} cls="closed" parentId={null} canHide={false} canShow openCheckClosed={false} archived={false} retelling={false} />
              <DeleteBlock id={id} confirm={TRASH_TEXT.deleteConfirm} />
            </div>
          </Section>
        ) : res.code === "not_found" && !readsClosed(me.key) ? <Empty>{CLOSED_CLASS_COPY.closedRecordHint}</Empty> : null}
      </>
    );
  }

  const data = res.data as ReadResult & { hidden?: boolean };
  const m: RecordCore = data.hidden ? (data as unknown as RecordCore) : data.metadata;
  const { content, toc = [], derived = [], truncated } = data;
  const isOwner = m.owner === me.person.login;
  const isParticipant = !isOwner && Boolean(m.people?.includes(me.person.login));
  const archived = m.space_archived === true;
  const archCard = archived && !me.spaces.some((s) => s.slug === m.space)
    ? await meGw<MySpace>(session.key, `/api/v1/me/spaces/${encodeURIComponent(m.space)}`) : null;
  const spaces = archCard?.ok ? [...me.spaces, { slug: archCard.data.slug, name: archCard.data.name }] : me.spaces;
  const trailSpaces = archCard?.ok ? [...me.spaces, { slug: archCard.data.slug, name: archCard.data.name, kind: archCard.data.kind }] : me.spaces;
  const trail = recordTrail(m, trailSpaces);
  const spaceRole = me.spaces.find((s) => s.slug === m.space)?.role ?? (archCard?.ok ? archCard.data.role : undefined);
  const here = me.spaces.find((s) => s.slug === m.space);
  const orgColleague = here?.kind === "org" && !isOwner;
  const profileCopy = isPublicCopyRecord(m);
  const canDelete = (isOwner || spaceRole === "owner") && !orgColleague && !profileCopy;
  const canAct = canDelete && !session.preview;
  const card = isDirectoryCard(m, here?.kind === "org");
  const staysPut = card || isWorkProfileRecord(m);
  const promoteTargets = staysPut || archived ? [] : promoteTargetSpaces(me.spaces, m.space);
  const inPersonal = here?.kind === "personal";
  const canReturn = isOwner && !staysPut && !session.preview && !inPersonal;
  const canReturnVersions = isOwner && !staysPut && !session.preview && inPersonal && (m.version ?? 1) > 1;
  const listedOthers = (m.people ?? []).filter((p) => p !== m.owner).length;
  const returnForm = <ReturnPersonal m={m} where={here?.name ?? null} listed={listedOthers} />;
  const first = summarizeStages(m.stages);
  const isMeetingRec = m.type === "transcript";
  const status = (isMeetingRec && !derived.some((d) => d.type === "summary")) || stillProcessing(first) || (first.state === "failed" && !first.terminal)
    ? await meGw<StatusResult>(session.key, `/api/v1/records/${m.id}/status`) : null;
  const live = status?.ok && status.data.stages?.length ? status.data.stages : m.stages;
  const stages = status?.ok ? summarizeStages(live) : first;
  const queue = status?.ok ? status.data.queue : null;
  const offer = processNowOffer(live, { queue });
  const advice = stagesAdvice(stages, offer, conversionFailedWhy(m.conversion));
  const withheld = m.original && !m.original.url ? originalWithheld(m.class, m.conversion) : null;
  const conversion = conversionLine(m.conversion, Boolean(withheld));
  const showAnyway = param(sp0, "show") === "anyway";
  const panelWanted = showAnyway && isOwner && m.class === "closed" && !session.preview && !m.parent_id;
  const previewRes = panelWanted ? await meGw<OpenPreview>(session.key, `/api/v1/records/${m.id}/open/preview`, { method: "POST", body: {} }) : null;
  const spaceKind = here?.kind ?? (archCard?.ok ? archCard.data.kind : undefined);
  const despiteMark = despiteOf(m);
  const wantsToggles = (despiteMark !== null || m.open_check?.result === "closed") && isOwner && !session.preview;
  const toggles = wantsToggles ? await meGw<ShowAnywayToggles>(session.key, "/api/v1/me/show-anyway") : null;
  const despiteOn = despiteHere(toggles?.ok ? toggles.data : null, spaceKind);
  const despite = despiteOn ? despiteMark : null;
  const spaceTitle = spaces.find((s) => s.slug === m.space)?.name ?? null;
  const panel = panelWanted ? <ShowAnywayPanel id={m.id} preview={previewRes?.ok ? previewRes.data : null} stale={staleParam(param(sp0, "stale"))}
    edit={editOf(m)} spaceName={spaceTitle} /> : undefined;
  const notAuthor = showAnyway && !isOwner && m.class === "closed";
  const markWhere = { personal: spaceKind === undefined ? undefined : spaceKind === "personal", space: spaceTitle, kind: spaceKind ?? null };

  if (data.hidden) {
    return (
      <>
        <RecordPath trail={trail} back={toSearch} at={`/records/${id}`} />
        <PageHead title={M.closedRecord}
          actions={<div className="chips">
            <Badge tone="neutral"><Icon name={recordIcon(m.type, m.event_kind)} /> {recordKind(m.type, m.event_kind)}</Badge>
            <VisibilityBadge cls="closed" />
          </div>} />
        <WhoSeesBlock cls="closed" readers={null} me={me.person.login} />
        {archived ? <ArchivedNotice /> : null}
        {m.open_check?.result === "closed" ? <OpenCheckNotice mark={m.open_check} source={m.source_kind} origin={m.origin} where={markWhere} offered={despiteOn} /> : null}
        <Notice tone="info"><strong>{rich(M.theContentsOfThisRecordAre, null)}</strong> {CLOSED_CLASS_TEXT.closedHiddenHint}</Notice>
        <div className="record-cols">
          <article>
            <Section title={M.knownRecordDetails} icon="info" hint={M.recordDetailsOnlyWithoutTextThis}>
              <div className="kv-list">
                <div className="kv"><span>{rich(M.type, null)}</span><span>{recordKind(m.type, m.event_kind)}</span></div>
                <div className="kv"><span>{rich(M.space, null)}</span><Link href={`/browse?path=${encodeURIComponent(`/spaces/${m.space}`)}`} prefetch={false}>{spaceName(spaces, m.space)}</Link></div>
                <div className="kv"><span>{rich(M.owner, null)}</span><span>{ownerName(m.owner, { me: me.person })}</span></div>
                <div className="kv"><span>{rich(M.when, null)}</span><LocalTime iso={m.created_at ?? m.occurred_at} minutes /></div>
                <div className="kv"><span>{rich(M.processing, null)}</span><ProcessingState stages={live} advice={advice} /></div>
              </div>
              {finalRefusal(stages) && advice ? <p className="hint">{advice}</p> : null}
              <ItDetails m={m} conversion={conversion} />
            </Section>
          </article>
          <aside className="record-aside">
            {canAct ? (
              <Section title={M.ownerActions} id="owner-actions" icon="settings" hint={CLOSED_CLASS_TEXT.closedHiddenActions}>
                <div className="owner-actions">
                  {offer ? <ProcessNowButton id={m.id} label={processNowLabel(offer, stages)} /> : null}
                  <AccessBlock id={m.id} cls="closed" parentId={m.parent_id ?? null} canHide={false} canShow={isOwner} despite={despite} despiteOff={!despiteOn} panel={panel}
                    openCheckClosed={m.open_check?.result === "closed"} archived={archived} retelling={false} />
                  {canReturn ? <OwnerGroup title={M.location}>{returnForm}</OwnerGroup> : null}
                  <DeleteBlock id={m.id} confirm={TRASH_TEXT.deleteConfirm} />
                </div>
              </Section>
            ) : <Section title={M.ownerActions} icon="settings"><p className="hint">{session.preview ? PREVIEW_TEXT.previewDeniedHint : M.thisIsNotYourRecordOnly}</p></Section>}
          </aside>
        </div>
      </>
    );
  }

  const meeting = m.type === "transcript" && !session.preview && (isOwner || isParticipant);
  const deletion = meeting ? await myDeletionRequests(session.key) : null;
  const askedHere = deletion?.incoming.filter((r) => r.record_id === m.id) ?? [];
  const mineHere = deletion?.outgoing.find((r) => r.record_id === m.id) ?? null;
  const isMeeting = m.type === "transcript";
  const summaryRef = isMeeting ? derived.find((d) => d.type === "summary") ?? null : null;
  const decisions = isMeeting ? derived.filter((d) => d.type === "event") : [];
  const canHandOver = isMeeting && (isOwner || isParticipant) && !session.preview && m.is_current !== false;
  const sp = sp0;
  const newerQ = !session.preview ? param(sp, "newer_q").trim().slice(0, 200) : "";
  const inOrg = here?.kind === "org";
  const isDecision = m.type === "event" && Boolean(m.parent_id) && !session.preview;
  const handoverTo = isDecision ? param(sp, "to").slice(0, 100) : "";
  const basisMore = data.derivation && data.derivation.sources.length >= 5 && !session.preview;
  const profileEnabled = !session.preview && profileOn(await navSummary(session.key).then((r) => r.data, () => null));
  const aboutPath = profileEnabled && isDirectoryCard(m, here?.kind === "org") ? publicProfilePath(m.owner) : null;
  // versions of an uploaded document — history with a converted version still waiting; only a
  // root document, not in preview (the key of "view as" reads, it does not upload versions)
  const versionable = m.type === "document" && !m.parent_id && !session.preview;
  const [people, summaryRead, corr, orgReview, derivationRes, handoverRes, readersRes, decisionsRes, parentRes, newerRes, basisRes, aboutRes, edgeStatus, recheck, versionsRes] = await Promise.all([
    meeting ? meetingParticipants(session.key, m.id) : null,
    summaryRef ? callTool<ReadResult>(session.key, "memory_read", { id: summaryRef.id, max_tokens: 6000 }) : null,
    session.preview ? null : recordCorrections(session.key, m.id),
    inOrg && !session.preview ? meGw<RecordOrgReview>(session.key, `/api/v1/records/${m.id}/org-review`) : null,
    isOwner && !session.preview ? meGw<RecordDerivation>(session.key, `/api/v1/records/${m.id}/derivation`) : null,
    isDecision ? meGw<HandoverForm>(session.key, `/api/v1/records/${m.id}/handover${handoverTo ? `?to=${encodeURIComponent(handoverTo)}` : ""}`) : null,
    session.preview ? null : meGw<RecordReaders>(session.key, `/api/v1/records/${m.id}/readers`),
    decisions.length && !session.preview ? meGw<MeetingDecisions>(session.key, `/api/v1/records/${m.id}/decisions`) : null,
    m.parent_id && !session.preview ? meGw<StatusBatch>(session.key, `/api/v1/records/status?ids=${encodeURIComponent(m.parent_id)}&with=title`) : null,
    newerQ.length >= 3 ? callTool<SearchResult>(session.key, "memory_search", { query: newerQ, limit: 10 }) : null,
    basisMore ? meGw<RecordDerivationSources>(session.key, `/api/v1/records/${m.id}/derivation/sources`) : null,
    aboutPath ? meGw<PublicProfile>(session.key, aboutPath) : null,
    edgeStatusOf(session.key, m.id, Boolean(session.preview)),
    m.class === "closed" ? recheckOf(session.key, m.id, Boolean(session.preview)) : null,
    versionable ? recordVersions(session.key, m.id) : null,
  ]);
  // an old gateway without the route, or a failure: no block, the page works as before
  const versions = versionsRes?.ok ? versionsRes.data.items : null;
  const versionPending = ownPending(versions, m.id);
  const versionPendingOf = versionPending ? versions?.find((x) => x.id !== m.id && x.is_current && !x.pending)?.id ?? null : null;
  const versionUpload = versionable && canUploadVersion({ type: m.type, parentId: m.parent_id ?? null, sourceKind: m.source_kind ?? null, isCurrent: m.is_current,
    mayAct: canAct && (isOwner || (spaceRole === "owner" && here?.kind !== "org" && here?.kind !== "personal")), preview: Boolean(session.preview), archived, moving: false, pending: Boolean(versionPending) });
  const about = publicProfileOf(aboutRes);
  const basedOn = basedOnOf(basisRes?.ok ? basisRes.data : null, data.derivation);
  const parentRow = parentRes?.ok ? parentRes.data.items.find((x) => x.id === m.parent_id) ?? null : null;
  const parent: ParentRef | null = parentRow ? { id: parentRow.id, type: parentRow.type, title: parentRow.title ?? null, occurred_at: parentRow.occurred_at ?? null } : null;
  const meetingParent = parent?.type === "transcript" ? parent : null;
  const newer: NewerSearch | null = newerQ ? { q: newerQ, items: newerRes?.ok ? newerRes.data.hits.filter((x) => x.id !== m.id).map((x) => ({ id: x.id, title: x.title, type: x.type, event_kind: x.event_kind, occurred_at: x.occurred_at })) : newerQ.length < 3 ? [] : null } : null;
  const readers = readersRes?.ok ? readersRes.data : null;
  const retelling = !!derivationRes?.ok && (derivationRes.data.declared > 0 || derivationRes.data.kind !== null);
  const org = orgReview?.ok && orgReview.data.in_org ? orgReview.data : null;
  const orgWhere = org?.returns_to ? me.spaces.find((s) => s.slug === org.returns_to)?.name ?? null : null;
  const stageOf = (name: string) => { const x = live?.find((s) => s.stage === name); return x ? employeeStatus(x) : null; };
  const pending = meetingState({ stages: { summary: stageOf("summary"), events: stageOf("events"), indexed: stageOf("indexed") }, lane: queue?.lane ?? "now",
                                 reason: (queue?.reason ?? null) as MeetingReason | null, retry_at: queue?.retry_at ?? null, failed_final: failedFinal(live) });
  const fixes = corr?.data ?? null;
  const keep = Object.fromEntries(Object.entries(sp).flatMap(([k, v]) => k === "cp" || k === "decided" ? [] : typeof v === "string" ? [[k, v]] : Array.isArray(v) && v[0] ? [[k, v[0]]] : []));
  const here$ = `/records/${m.id}`;
  const tags = (m.entities ?? []).filter((e) => !(people?.ok && e.role === "participant" && e.ref.startsWith("person:")));
  const cardOf = card && !session.preview ? { login: m.owner, name: cardName(m.title) ?? m.owner } : null;
  const correctOpen = param(sp, "correct") === "1";
  const correctHref = `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(keep).filter(([k]) => k !== "sid" && k !== "correct")), correct: "1" })}#correct`;
  const oldVersion = m.is_current === false && fixes && fixes.current_state !== "current" ? fixes : null;
  const meetingPart = !isMeeting && (Boolean(readers?.meeting) || (handoverRes?.ok === true && handoverRes.data.reason !== "not_meeting_decision"));
  const wholeMeeting = m.type === "transcript" && !m.parent_id;
  const promoteForm = <PromoteForm id={m.id} cls={m.class} targets={promoteTargets} retelling={retelling} meeting={wholeMeeting} label={wholeMeeting ? MEETING_PROMOTE.button : undefined} />;

  const partial = truncated || range !== null;
  const lines = isMeeting ? transcriptLines(content) : new Map<number, string>();
  const marks = [...lines.keys()];
  const firstMark = marks.length ? Math.min(...marks) : null, lastMark = marks.length ? Math.max(...marks) : null;
  const shown = isMeeting ? { marks: new Set(marks), first: firstMark, last: lastMark === null ? null : truncated ? lastMark : Number.POSITIVE_INFINITY } : null;
  const toMeeting = meetingParent ? (sec: number) => meetingTimeHref(meetingParent.id, sec) : null;
  const html = renderMarkdown(m.type === "profile" ? profileShown(content) : content, m.type, {
    frontmatter: false, dropTitle: m.title, occurredAt: m.occurred_at, shift: 2, plain: isPlainTextMime(m.original?.mime),
    ...(m.type === "summary" || m.type === "event" ? { timeLink: toMeeting } : {}),
  });
  const ids = renderedIds(html);
  const next = truncated ? data.next_range ?? null : null;
  const known = new Map<string, string>([
    ...(m.entities ?? []).flatMap((e) => (e.ref.startsWith("person:") && e.display_name ? [[e.ref.slice("person:".length), e.display_name] as [string, string]] : [])),
    ...(readers?.people ?? []).flatMap((p) => (p.display_name ? [[p.login, p.display_name] as [string, string]] : [])),
    ...(people?.ok ? [people.data.owner, ...people.data.participants, ...people.data.pending] : []).flatMap((p) => (p.display_name ? [[p.login, p.display_name] as [string, string]] : [])),
  ]);
  const named = isMeeting ? { names: [], more: 0 } : peopleNames(m.people, known);
  const namedPeople = isMeeting ? [] : (m.people ?? []).flatMap((l) => { const n = known.get(l)?.trim(); return n ? [{ login: l, name: n }] : []; });
  const summaryLine = summaryLineShown(m.summary_line, content);
  const decisionItems = decisionsRes?.ok ? decisionsRes.data.items : null;
  const participantNames = people?.ok ? [...people.data.participants, ...people.data.pending].map((p) => personName(p)) : null;
  const spaceWide = here?.kind !== "personal" && readers?.audience !== "people" ? { name: here?.name ?? null } : null;
  const deleteConfirm = wholeMeeting ? meetingDeleteConfirm({ summary: Boolean(summaryRef), decisions: decisions.length, participants: participantNames, space: spaceWide })
    // a document with earlier versions — "with N previous versions"; the page of a new version still being
    // processed or not accepted deletes only that upload
    : versionPending ? VERSIONS_TEXT.deletePendingConfirm : deleteConfirmWithVersions(TRASH_TEXT.deleteConfirm, versions);
  return (
    <>
      <RecordPath trail={trail} back={toSearch} at={`/records/${id}`} />
      <PageHead title={m.title || M.untitled}
        actions={<div className="head-tools">
          <div className="chips">
            <Badge tone="neutral"><Icon name={recordIcon(m.type, m.event_kind)} /> {recordKind(m.type, m.event_kind)}</Badge>
            <VisibilityBadge cls={m.class} />
          </div>
          <div className="head-buttons">
            {fixes?.kinds.length ? <CorrectLink href={correctHref} /> : null}
            <CopyLink />
            {canAct ? <a className="btn sm owner-jump" href="#owner-actions">{rich(M.actions, null)}</a> : null}
          </div>
        </div>} />
      {meetingParent && !isMeeting ? (
        <p className="from-meeting"><Link href={`/records/${meetingParent.id}`} prefetch={false}>{rich(M.meetingSource(Boolean(meetingParent.title?.trim()), Boolean(meetingParent.occurred_at)), { tag0: () => <Icon name="mic" /> }, { title: meetingParent.title?.trim() ?? "", day: meetingParent.occurred_at ? dayWords(meetingParent.occurred_at) : "" })}</Link></p>
      ) : null}

      <WhoSeesBlock cls={m.class} readers={readers} me={me.person.login} />
      {readers?.copied_from ? (
        <p className="from-meeting custody-copied">{CUSTODY_PLAIN.copiedFrom(readers.copied_from.display_name || readers.copied_from.login,
          readers.copied_from.at ? formatDay(readers.copied_from.at) : null)}</p>
      ) : null}
      {basedOn ? <DerivationBlock v={basedOn} /> : null}
      {people?.ok ? <MeetingComposition people={people.data} me={me.person.login} /> : null}

      <div className="record-cols">
        <article>
          {archived ? <ArchivedNotice /> : null}
          {versionPending ? <VersionPendingNotice pending={versionPending} of={versionPendingOf} /> : null}
          {oldVersion ? (
            <Notice tone="warn">{oldVersion.current_state === "visible" && oldVersion.current
              ? <>{rich(M.oldVersion(Boolean(oldVersion.current.title)), { link: children => <Link href={`/records/${oldVersion.current!.id}`} prefetch={false}>{children}</Link> }, { title: oldVersion.current.title ?? "" })}</>
              : oldVersion.current_state === "none" ? OLD_VERSION.none : OLD_VERSION.hidden}</Notice>
          ) : null}
          {m.class === "closed" ? (
            <Notice tone="info">{rich(M.closedNotice(isOwner, isParticipant), { tag0: (children) => <strong>{children}</strong>, tag1: (children) => <Link href="/activity" prefetch={false}>{children}</Link> })}</Notice>
          ) : null}
          {m.class === "closed" && m.open_check?.result === "closed" ? <OpenCheckNotice mark={m.open_check} source={m.source_kind} origin={m.origin} where={markWhere} offered={despiteOn} /> : null}
          {isOwner && profileEnabled && isWorkProfileRecord(m) ? (
            <Notice tone="info">{profileCopy ? PROFILE_PLAIN.copyRecord : PROFILE_PLAIN.ownRecord} <Link href={MY_PROFILE_HREF} prefetch={false}>{PROFILE_PLAIN.toProfile}</Link></Notice>
          ) : !isOwner && profileCopy ? <Notice tone="info">{PROFILE_PLAIN.copyOther}</Notice> : null}
          {notAuthor && !canAct ? <Notice tone="info">{CLOSED_CLASS_COPY.showAnywayNotAuthor}</Notice> : null}
          {isOwner && askedHere.length ? (
            <Notice tone="warn">
              <strong>{rich(M.participantsHaveAskedToDeleteThis, null)}</strong>{" "}
              {askedHere.map((r, i) => <span key={r.id}>{i ? ", " : ""}{r.requester.display_name || r.requester.login} (<LocalTime iso={r.created_at} />)</span>)}.{" "}
              {M.deleteOrKeepMeeting}
              <div className="actions-col">
                {askedHere.map((r) => (
                  <ActionForm key={r.id} action={keepMeetingAction} submitLabel={M.keepMeeting(r.requester.display_name || r.requester.login)} pendingLabel="…" quiet confirm={DELETION_REQUESTS_TEXT.keepConfirm}>
                    <input type="hidden" name="request" value={r.id} />
                  </ActionForm>
                ))}
                {askedHere.map((r) => {
                  const name = r.requester.display_name || r.requester.login;
                  const gone = askerGone(r, people?.ok ? people.data : null);
                  return gone ? <p key={`rm-${r.id}`} className="hint">{rich(M.requesterStatus, null, { name, status: REQUESTER_GONE[gone] })}</p> : (
                    <ActionForm key={`rm-${r.id}`} action={meetingParticipantAction} submitLabel={M.removeFromParticipants(name)} pendingLabel="…" quiet confirm={removeAskerConfirm(name)}>
                      <input type="hidden" name="id" value={m.id} /><input type="hidden" name="op" value="remove" /><input type="hidden" name="who" value={r.requester.login} />
                      <input type="hidden" name="name" value={name} />
                    </ActionForm>
                  );
                })}
              </div>
            </Notice>
          ) : null}
          {partial ? (
            <Notice tone="info">
              {isMeeting
                ? <>{rich(M.transcriptPart(firstMark !== null && Boolean(range), truncated && lastMark !== null), null, { from: firstMark !== null ? fmtTime(firstMark) : "", to: lastMark !== null ? fmtTime(lastMark) : "" })}</>
                : <>{rich(M.showingPartOfTheRecord, null)}</>}
              {next ? <> <Link href={rangeHref(m.id, next, isMeeting ? "transcript" : undefined)} prefetch={false}>{rich(M.readMore, null)}</Link></> : null}
              {range ? <> <Link href={`/records/${m.id}${isMeeting ? "#transcript" : ""}`} prefetch={false}>{rich(M.fromTheStart, null)}</Link></> : null}
            </Notice>
          ) : null}
          {stages.state === "failed" ? <Notice tone={stages.terminal ? "danger" : "warn"}><strong>{stages.label}.</strong> {advice}</Notice> : null}
          {m.type === "event" && fixes?.event_fields?.due && dueLooksPast(fixes.event_fields.due, meetingParent?.occurred_at ?? m.occurred_at)
            ? <Notice tone="warn">{dueCheckNotice(fixes.event_fields.due)}</Notice> : null}
          {isMeeting ? (
            <>
              <Section title={M.summary} id="summary" icon="text">
                {summaryRead?.ok ? <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(summaryRead.data.content, "summary", {
                    frontmatter: false, dropTitle: summaryRef?.title ?? null, occurredAt: m.occurred_at, shift: 2, timeLink: (sec) => meetingTimeHref(m.id, sec, shown) }) }} />
                  : summaryRead ? <Notice tone="warn"><strong>{rich(M.theSummaryCouldNotBeOpened, null)}</strong> {toolErrorMessage(summaryRead)}</Notice>
                  : <p className="hint"><Badge tone={pending.tone}>{pending.label}</Badge></p>}
              </Section>
              <Section title={M.decisionsAndAgreements} id="decisions" icon="gavel" hint={M.whatMemoryExtractedFromTheMeeting}>
                {decisions.length && decisionItems ? (
                  <DecisionsList items={decisionItems} occurredAt={m.occurred_at} canHandOver={canHandOver} />
                ) : decisions.length ? (
                  <ul className="derived">
                    {decisions.map((d) => <li key={d.id}><Link href={`/records/${d.id}`} prefetch={false}><Icon name={recordIcon(d.type, d.event_kind)} /> {d.title || M.untitled}</Link>{d.event_kind ? <span className="muted small">{M.eventKindSuffix(d.event_kind)}</span> : null}
                      {canHandOver ? <> · <Link href={`/records/${d.id}#handover`} prefetch={false} className="small">{HANDOVER_PLAIN.link}</Link></> : null}</li>)}
                  </ul>
                ) : stageOf("events") === "done" ? <p className="hint">{rich(M.noDecisionsOrAgreementsWereFound, null)}</p>
                  : stageOf("events") === "failed" ? <p className="hint"><Badge tone="danger">{rich(M.decisionsCouldNotBeExtracted, null)}</Badge></p>
                  : <p className="hint">{rich(M.theseWillAppearWithTheSummary, null)}</p>}
                {decisions.length && !session.preview && m.is_current !== false && !archived ? <BulkActorForm meetingId={m.id} /> : null}
              </Section>
              {!archived && m.is_current !== false ? <MeetingProject meetingId={m.id} decisions={decisions} mark={people?.ok ? people.data.project_mark ?? null : null}
                handTo={canHandOver ? me.spaces.filter((s) => s.kind === "project" && s.role !== "reader") : []}
                markTo={isOwner && !session.preview ? me.spaces.filter((s) => s.kind === "project") : null} /> : null}
              <TranscriptJump truncated={Boolean(truncated)} />
              <details className="transcript sec sec-fold" id="transcript" open={!summaryRef || range !== null}>
                <summary><h2 className="sec-title">{rich(M.transcript, { tag0: () => <Icon name="text" /> })}</h2></summary>
                <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
              </details>
            </>
          ) : <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />}
          {about ? <PublicProfileBlock p={about} /> : null}
          {handoverRes?.ok ? <HandoverBlock id={m.id} form={handoverRes.data} own={isOwner} /> : null}
          {fixes?.kinds.length ? (
            <CorrectBlock id={m.id} kinds={fixes.kinds} eventFields={fixes.event_fields} type={m.type} eventKind={m.event_kind ?? null}
              fragmentHtml={corr?.fragment?.ok ? renderMarkdown(corr.fragment.data.content, "transcript") : null}
              note={{ title: m.title ?? "", text: partial ? null : content, digest: !partial && fixes.kinds.some((k) => k.kind === "own_note") ? noteDigest(content) : null }}
              resetNotice={m.type === "event" && Boolean(m.parent_id)} openKept={isOwner && inPersonal && m.class === "open"} newer={newer} open={Boolean(newerQ) || correctOpen} />
          ) : null}
          {fixes?.items.length ? <CorrectionsBlock recordId={m.id} items={fixes.items} page={param(sp, "cp")} params={keep} decided={param(sp, "decided")} /> : null}
        </article>

        <aside className="record-aside">
          {people?.ok ? <ParticipantsBlock id={m.id} people={people.data} me={me.person.login} isParticipant={meeting && isParticipant} archived={archived}
            orgHint={org ? (org.on_review && org.state !== "exempt" ? ORG_REVIEW_TEXT.orgNarrowHint : ORG_REVIEW_TEXT.orgNarrowStayHint) : null} mine={mineHere} back={here$} /> : null}
          <Section title={M.aboutThisRecord} icon="info">
            <div className="kv-list">
              <div className="kv"><span>{rich(M.when, null)}</span><LocalTime iso={m.occurred_at} minutes /></div>
              {ingestedDiffers(m.occurred_at, m.ingested_at) ? <div className="kv"><span>{rich(M.addedToMemory, null)}</span><LocalTime iso={m.ingested_at} minutes /></div> : null}
              <div className="kv"><span>{rich(M.space, null)}</span><span><Link href={`/browse?path=${encodeURIComponent(`/spaces/${m.space}`)}`} prefetch={false}>{spaceName(spaces, m.space)}</Link>
                {readers?.meeting ? <span className="muted">{rich(M.visibleToMeetingParticipants, null)}</span> : null}</span></div>
              <div className="kv"><span>{rich(M.owner, null)}</span><span>{ownerName(m.owner, { me: me.person, readers, meetingOwner: people?.ok ? people.data.owner : null })}{!isOwner && spaceRole ? <span className="muted">{M.roleSuffix(spaceRole)}</span> : null}</span></div>
              <div className="kv"><span>{rich(M.origin, null)}</span><span>{originText(m, parent)}{parent && !meetingParent ? <> · <Link href={`/records/${parent.id}`} prefetch={false}>{parent.title?.trim() || M.sourceRecord}</Link></> : null}</span></div>
              {summaryLine ? <div className="kv"><span>{rich(M.summary, null)}</span><span>{summaryLine}</span></div> : null}
              <div className="kv"><span>{rich(M.processing, null)}</span><span><ProcessingState stages={live} advice={advice} />{stages.terminal ? <span className="muted small">{rich(M.retryingWillReceiveTheSameRefusal, null)}</span> : null}</span></div>
              {m.access?.restricted_by_source ? <div className="kv"><span>{rich(M.access, null)}</span><span>{rich(M.limitedByTheSystemTheRecord, null)}</span></div> : null}
              {m.extended_write ? <div className="kv"><span>{rich(M.recorded, null)}</span><span title={EXTENDED_OPEN_PLAIN.badgeHint}>{EXTENDED_OPEN_PLAIN.badge}</span></div> : null}
            </div>
            {named.names.length || named.more ? (
              <div className="kv-block"><span className="kv-label">{rich(M.people, null)}</span>
                <div className="tags">{namedPeople.map((p) => <Link key={p.login} href={personSelectionHref(p.login, here$)} prefetch={false} className="tag" title={M.recordsInvolvingThisPerson}>{p.name}</Link>)}{named.more ? <span className="muted small">{M.peopleCount(named.more, named.names.length > 0)}</span> : null}</div></div>
            ) : null}
            {tags.length ? (
              <div className="kv-block"><span className="kv-label">{rich(M.mentions, null)}</span>
                <div className="tags">{tags.map((e) => <Link key={e.ref} href={`/browse?path=${encodeURIComponent(`/entities/${e.ref}`)}&from=${encodeURIComponent(here$)}`} prefetch={false} className="tag" title={ENTITY_ROLE_TITLES[e.role] ?? e.role}>{e.display_name}</Link>)}</div></div>
            ) : null}
            {m.domain_tags?.length ? <div className="kv-block"><span className="kv-label">{rich(M.topics, null)}</span><div className="tags">{m.domain_tags.map((t) => <span key={t} className="tag">{t}</span>)}</div></div> : null}
            {cardOf ? (
              <div className="form-actions">
                <Link href={personSelectionHref(cardOf.login, here$)} prefetch={false} className="btn sm">{rich(M.recordsInvolving, { tag0: () => <Icon name="file" /> }, { value0: cardOf.name })}</Link>
                <Link href={selectionSearch(cardOf.name).href} prefetch={false} className="btn sm">{rich(M.findWithSearch, { tag0: () => <Icon name="search" /> })}</Link>
              </div>
            ) : null}
            <ItDetails m={m} conversion={conversion} />
          </Section>

          {org ? <OrgReviewBlock id={m.id} v={org} whereName={orgWhere} done={param(sp, "org")} preview={Boolean(session.preview)} card={card} old={m.is_current === false} />
            : param(sp, "org") === "return" ? <div id="org-review"><Notice tone="ok">{ORG_DONE.return}</Notice></div> : null}
          <EdgeStatusBlock id={m.id} v={edgeStatus} />
          <RecheckBlock id={m.id} v={recheck} />

          {toc.length > 1 ? (
            <Section title={M.contents} icon="list">
              <ul className="toc">
                {toc.map((t, i) => <li key={`${t.anchor}-${i}`} className={t.level >= 3 ? "l3" : t.level === 2 ? "l2" : undefined}>
                  {isMeeting && typeof t.time_from === "number"
                    ? <><a href={tocHref(m.id, t, ids)}>{fmtTime(t.time_from)}</a>{lines.has(t.time_from) ? <span className="muted small"> {firstWords(lines.get(t.time_from))}</span> : null}</>
                    : <><a href={tocHref(m.id, t, ids)}>{t.title}</a>{t.page ? <span className="muted small">{rich(M.p, null, { value0: t.page })}</span> : null}</>}</li>)}
              </ul>
            </Section>
          ) : null}

          {derived.length && !isMeeting ? (
            <Section title={M.extractedFromThisRecord} icon="sparkles" hint={M.summariesDecisionsAndTasksThatMemory}>
              <ul className="derived">
                {derived.map((d) => <li key={d.id}><Link href={`/records/${d.id}`} prefetch={false}><Icon name={recordIcon(d.type, d.event_kind)} /> {d.title}</Link>{d.event_kind ? <span className="muted small">{M.eventKindSuffix(d.event_kind)}</span> : null}</li>)}
              </ul>
            </Section>
          ) : null}

          {m.original ? (
            <Section title={M.original} icon="file">
              <div className="kv-list">
                <div className="kv"><span>{rich(M.format, null)}</span><span>{mimePlain(m.original.mime)}</span></div>
                <div className="kv"><span>{rich(M.size, null)}</span><span>{rich(M.originalSize(m.original.pages ?? 0, Boolean(m.original.duration_sec)), null, { kb: (m.original.bytes / 1024).toFixed(0), duration: m.original.duration_sec ? fmtTime(m.original.duration_sec) : "" })}</span></div>
              </div>
              {m.original.url ? <p className="dl-line"><a className="btn sm" href={publicGatewayUrl(origin, m.original.url)} target="_blank" rel="noopener noreferrer">{rich(M.downloadFile, { tag0: () => <Icon name="download" /> })}</a> <span className="muted small">{rich(M.thisLinkExpiresSoon, null)}</span></p> : <p className="muted small">{withheld ?? M.fileLinkUnavailable}</p>}
              {m.class === "open" && m.original.url && m.conversion?.extraction_state === "partial" ? <p className="hint">{CLOSED_CLASS_COPY.showAnywayTextOnly}</p> : null}
              {agentFileLine(m.class, m.conversion) ? <p className="hint">{agentFileLine(m.class, m.conversion)}</p> : null}
              {/* a single version — "Upload new version" next to its file; with a history — in the "Versions" block */}
              {versionUpload && !(versions && versionsShown(versions)) ? <VersionUpload replaces={m.id} /> : null}
            </Section>
          ) : null}

          {/* a single version without a kept original has no "Original" section — the form stands on its own */}
          {versionUpload && !m.original && !(versions && versionsShown(versions)) ? <VersionUpload replaces={m.id} /> : null}
          {versions ? <VersionsBlock id={m.id} items={versions} names={known} upload={versionUpload} /> : null}

          {canDelete && session.preview ? (
            <Section title={M.ownerActions} icon="settings"><Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></Section>
          ) : null}

          {canAct ? (
            <Section title={M.ownerActions} id="owner-actions" icon="settings">
              <div className="owner-actions">
                {offer ? <ProcessNowButton id={m.id} label={processNowLabel(offer, stages)} /> : null}
                <AccessBlock id={m.id} cls={m.class} parentId={m.parent_id ?? null} canHide canShow={isOwner} despite={isOwner ? despite : null} despiteOff={!despiteOn} panel={panel}
                  notAuthor={notAuthor} openCheckClosed={m.open_check?.result === "closed"} archived={archived} retelling={retelling} />
                {canReturn || canReturnVersions || (isOwner && promoteTargets.length) ? (
                  <OwnerGroup title={M.location}>
                    {canReturn ? returnForm : null}
                    {canReturnVersions ? <ReturnVersions id={m.id} listed={listedOthers} /> : null}
                    {isOwner && promoteTargets.length ? (
                      meetingPart ? (
                        <details className="promote-more">
                          <summary>{PROMOTE_PLAIN.more}</summary>
                          <p className="hint">{PROMOTE_PLAIN.moreHint}{handoverRes?.ok && handoverRes.data.allowed ? <> {PROMOTE_PLAIN.moreHandover}</> : null}</p>
                          {promoteForm}
                        </details>
                      ) : wholeMeeting ? (
                        <details className="promote-more">
                          <summary>{MEETING_PROMOTE.more}</summary>
                          <p className="hint">{MEETING_PROMOTE.warning(m.class)}</p>
                          {promoteForm}
                        </details>
                      ) : promoteForm
                    ) : null}
                  </OwnerGroup>
                ) : null}
                {canDelete ? <DeleteBlock id={m.id} confirm={deleteConfirm} label={wholeMeeting ? M.deleteMeeting : M.deleteRecord} /> : null}
              </div>
            </Section>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function UnavailableActions() {
  return (
    <div className="missing-actions">
      <Link href="/search" className="btn primary" prefetch={false}>{rich(M.findInMemory, { tag0: () => <Icon name="search" /> })}</Link>
      <Link href="/materials" className="btn" prefetch={false}>{SECTION_TITLES.materials}</Link>
      <Link href="/meetings" className="btn" prefetch={false}>{rich(M.meetingsWithMe, null)}</Link>
      <Link href="/" className="btn" prefetch={false}>{rich(M.overview, { tag0: () => <Icon name="home" /> })}</Link>
    </div>
  );
}
