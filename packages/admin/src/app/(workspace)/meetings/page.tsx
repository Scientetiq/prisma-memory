import { derived } from "@/i18n/runtime";
import { pageText as M } from "@/messages/ws-meetings";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { FindField } from "@/components/find-field";
import { Icon } from "@/components/icons";
import { ListHead } from "@/components/list-head";
import { MeetingRow, MEETING_ROW_TEXT } from "@/components/meeting-row";
import { RecordRow } from "@/components/record-row";
import { CursorPager } from "@/components/pager";
import { Badge, LoadError, Notice, PageHead, Section } from "@/components/ui";
import { readsClosed } from "@/lib/closed-class";
import { isSlug } from "@/lib/form";
import { requireWorkspace } from "@/lib/me";
import { MEETINGS_Q_MAX, MEETINGS_Q_MIN, myMeetings, type MeetingsQuery } from "@/lib/meetings";
import { NAV_ICONS } from "@/lib/nav-icons";
import { hrefWith, param, type SearchParams } from "@/lib/paging";
import { MEETINGS_PLAIN, removeAskerConfirm } from "@/lib/plain";
import { myDeletionRequests, REQUESTER_GONE } from "@/lib/deletion-requests";
import { meetingParticipantAction } from "../actions";

export function generateMetadata(): Metadata { return { title: M.meetingsWithMe }; }

const LIMIT = 30;

const SHOWS = ["", "new", "owner", "participant"] as const;
type Show = (typeof SHOWS)[number];
const SHOW_TITLES: Record<Show, string> = derived(() => ({ "": MEETINGS_PLAIN.filters.all, new: MEETINGS_PLAIN.filters.fresh, owner: MEETINGS_PLAIN.filters.owner, participant: MEETINGS_PLAIN.filters.participant }));

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const cursor = /^\d+$/.test(param(sp, "cursor")) ? param(sp, "cursor") : "";
  const rawQ = param(sp, "q").replace(/\s+/g, " ").trim().slice(0, MEETINGS_Q_MAX);
  const q = rawQ.length >= MEETINGS_Q_MIN ? rawQ : "";
  const show: Show = (SHOWS as readonly string[]).includes(param(sp, "show")) ? param(sp, "show") as Show : "";
  const space = isSlug(param(sp, "space").toLowerCase()) ? param(sp, "space").toLowerCase() : "";
  const filter: MeetingsQuery = { q, role: show === "owner" || show === "participant" ? show : "", fresh: show === "new", ...(space ? { space } : {}) };
  const filtered = Boolean(q || show);
  const [res, deletion] = session.preview ? [null, null] : await Promise.all([myMeetings(session.key, cursor, LIMIT, filter), space ? null : myDeletionRequests(session.key)]);
  const items = res?.ok ? res.data.items : [];
  const project = space && res?.ok ? res.data.project ?? null : null;
  const params: Record<string, string> = { ...(rawQ ? { q: rawQ } : {}), ...(show ? { show } : {}), ...(space ? { space } : {}) };
  const resetHref = `${space ? `/meetings?space=${encodeURIComponent(space)}` : "/meetings"}#meetings`;
  const paged = Boolean(cursor || (res?.ok && res.data.next_cursor));

  return (
    <>
      <PageHead title={M.meetingsWithMe} lead={MEETINGS_PLAIN.lead} />
      <details className="mt-more mtg-more">
        <summary><Icon name="info" />{MEETINGS_PLAIN.more}<Icon name="chevron-down" /></summary>
        <ul className="mtg-more-list">{MEETINGS_PLAIN.moreLines.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
      {readsClosed(me.key) ? null : <Notice tone="warn">{MEETINGS_PLAIN.previewNote}</Notice>}
      {param(sp, "left") === "1" ? <Notice tone="info">{MEETINGS_PLAIN.left}</Notice> : null}

      {deletion?.incoming.length ? (
        <Section title={M.requestsToDeleteYourMeetings} icon="file-x" hint={M.aParticipantAskedToDeleteA}>
          <ul className="mt-list">
            {deletion.incoming.map((r) => {
              const name = r.requester.display_name || r.requester.login;
              return (
                <RecordRow key={r.id} href={`/records/${r.record_id}`} type="transcript" kind={false} title={r.title || M.untitled} date={r.created_at}
                  meta={M.requestedBy(name)}
                  actions={r.requester_gone ? <span className="hint">{name} — {REQUESTER_GONE[r.requester_gone]}.</span> : (
                    <ActionForm action={meetingParticipantAction} submitLabel={M.removeFromParticipants(name)} pendingLabel="…" compact quiet confirm={removeAskerConfirm(name)}>
                      <input type="hidden" name="id" value={r.record_id} /><input type="hidden" name="op" value="remove" /><input type="hidden" name="who" value={r.requester.login} /><input type="hidden" name="name" value={name} />
                    </ActionForm>
                  )} />
              );
            })}
          </ul>
        </Section>
      ) : null}
      {deletion?.outgoing.length ? (
        <Section title={M.yourDeletionRequests} icon="file-x" hint={M.theMeetingOrganiserOrMemoryAdministrator}>
          <ul className="mt-list">
            {deletion.outgoing.map((r) => (
              <RecordRow key={r.id} href={r.title ? `/records/${r.record_id}` : null} hiddenTitle={r.title ? undefined : MEETINGS_PLAIN.hiddenMeeting}
                type="transcript" kind={false} title={r.title} date={r.created_at} meta={M.organiser(r.owner.display_name || r.owner.login)}
                badges={<Badge tone={r.status === "kept" ? "muted" : r.status === "declined" ? "warn" : "neutral"}>
                  {r.status === "kept" ? M.theAdministratorKeptTheMeeting : r.status === "declined" ? M.theOrganiserKeptItTheAdministrator : M.awaitingADecision}
                </Badge>} />
            ))}
          </ul>
        </Section>
      ) : null}

      <section className="mt-records" id="meetings" aria-labelledby="meetings-title">
        <ListHead id="meetings-title" icon={NAV_ICONS.meetings} title={space ? M.meetingsForThisProject : M.meetings}
          aside={space ? (
            <span className="chip mt-filter">
              {project ? <Link href={`/projects/${encodeURIComponent(project.slug)}`} prefetch={false}>{rich(M.project, null, { value0: project.name })}</Link> : M.projectNotFoundAmongYourSpaces}
              <Link href="/meetings" prefetch={false} className="mt-filter-x" aria-label={M.showAllMeetings} title={M.showAllMeetings}><Icon name="x" /></Link>
            </span>
          ) : null} />
        {space ? <p className="mt-hint">{rich(M.meetingsWhoseDecisionsWereHandedOver, null)}</p> : null}
        {session.preview ? null : (
          <>
            <FindField className="find-meetings" action="/meetings" hidden={{ ...(show ? { show } : {}), ...(space ? { space } : {}) }}
              label={MEETINGS_PLAIN.searchLabel} placeholder={MEETINGS_PLAIN.searchPlaceholder} defaultValue={rawQ} maxLength={MEETINGS_Q_MAX}
              autoComplete="off" spellCheck={false} submit={MEETINGS_PLAIN.searchSubmit} />
            {rawQ && !q ? <p className="mt-hint">{MEETINGS_PLAIN.searchShort}</p> : null}
            <nav className="mt-types" aria-label={M.whichMeetingsToShow}>
              {SHOWS.map((s) => (
                <Link key={s || "all"} href={`${hrefWith("/meetings", params, { show: s || null, cursor: null })}#meetings`} prefetch={false} className="mt-type" aria-current={show === s ? "true" : undefined}>
                  {SHOW_TITLES[s]}
                </Link>
              ))}
            </nav>
          </>
        )}
        {session.preview ? null : !res?.ok ? (
          res ? <LoadError result={res} what={M.meetingList} /> : null
        ) : res.data.new_unavailable ? (
          <Notice tone="warn">{MEETINGS_PLAIN.newUnavailable} <Link href={`${hrefWith("/meetings", params, { show: null })}#meetings`} prefetch={false}>{MEETINGS_PLAIN.filters.all}</Link></Notice>
        ) : !items.length ? (
          <div className="mt-empty">
            <span className="ichip tone-gray"><Icon name={filtered ? "search" : "mic"} /></span>
            <p><b>{cursor ? MEETINGS_PLAIN.emptyPage : q ? MEETINGS_PLAIN.emptyFiltered : show === "new" ? MEETINGS_PLAIN.emptyFresh : show ? MEETINGS_PLAIN.emptyFiltered : space ? MEETING_ROW_TEXT.noProjectMeetings : MEETINGS_PLAIN.empty}</b>
              {filtered ? <span><Link href={resetHref} prefetch={false}>{MEETINGS_PLAIN.reset}</Link></span> : null}</p>
            {filtered ? null : cursor
              ? <Link href={resetHref} className="btn" prefetch={false}>{rich(M.backToTheStartOfThe, null)}</Link>
              : <Link href="/search" className="btn" prefetch={false}>{rich(M.searchMemory, null)}</Link>}
          </div>
        ) : (
          <>
            <ul className="mt-list">
              {items.map((m) => <MeetingRow key={m.id} m={m} projects={!space} />)}
            </ul>
            {paged ? (
              <CursorPager path="/meetings" params={params} cursorName="cursor" cursor={cursor} nextCursor={res.data.next_cursor}
                prevCursor={cursor ? String(Math.max(0, Number(cursor) - LIMIT)) : undefined} shown={items.length} anchor="meetings" noun={MEETINGS_PLAIN.pagerNoun} />
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
