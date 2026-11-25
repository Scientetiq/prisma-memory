import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon, recordIcon } from "@/components/icons";
import { RowMenu } from "@/components/row-menu";
import { Badge, Empty, LoadError, Notice, PageHead, Section } from "@/components/ui";
import { recordKind } from "@/lib/home";
import { meGw } from "@/lib/me-api";
import { requireWorkspace } from "@/lib/me";
import { isId } from "@/lib/form";
import { hrefWith, param, type SearchParams } from "@/lib/paging";
import { ACCESS_PAST_PLAIN, SECTION_TITLES } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import { ARCHIVE_TEXT } from "@/lib/archive";
import { RESTORE_PLAIN, TRASH_MESSAGES, deletedByLine, derivedLine, purgeIn, purgeQuestion, restoredPlace, restoredText, shortTermNote, shortTermShared, trashDay, trashLead, trashPlace } from "@/lib/trash";
import type { MeSpace, TrashItem, TrashPage } from "@/lib/types";
import { purgeAction, restoreAction } from "../actions";
import { WS_TRASH_MESSAGES } from "@/messages/ws-trash";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.trash }; }
const LIMIT = 50;

const who = (p: { login: string; display_name: string | null }): string => p.display_name || p.login;

function TrashCard({ t, trashDays, preview, now, sharedNotes }: { t: TrashItem; trashDays: number | null; preview: boolean; now: number; sharedNotes?: ReadonlySet<string> }) {
  const kind = recordKind(t.type, t.event_kind), left = purgeIn(t.purge_after, now), deleted = trashDay(t.deleted_at, now);
  const own = shortTermNote(t, trashDays), note = own && !sharedNotes?.has(own) ? own : null;
  const withLine = derivedLine(t), q = purgeQuestion(t.title, kind, deleted);
  return (
    <li className="trash-card" data-record-id={t.id}>
      <div className="trash-main">
        <p className="trash-title">
          {t.title ? <strong>{t.title}</strong> : <span className="muted">{t.class === "closed" ? WS_TRASH_MESSAGES.closedRecordTitleHidden : WS_TRASH_MESSAGES.untitled}</span>}
        </p>
        {withLine ? <p className="trash-with">{withLine}</p> : null}
        <p className="trash-meta">
          <span className="trash-kind"><Icon name={recordIcon(t.type, t.event_kind)} />{kind}</span>
          {t.class === "closed" ? <span className="trash-lock" title={ACCESS_PAST_PLAIN.closed}><Icon name="lock" /><span className="vis-hidden">{ACCESS_PAST_PLAIN.closed}</span></span> : null}
          <span>{trashPlace(t)}</span>
          {t.space.archived ? <Badge tone="muted">{WS_TRASH_MESSAGES.archived}</Badge> : null}
          {t.author_is_me ? null : <span>{rich(WS_TRASH_MESSAGES.author, null, { value1: who(t.owner) })}</span>}
          {t.created_at ? <span>{rich(WS_TRASH_MESSAGES.created, null, { value1: trashDay(t.created_at, now) })}</span> : null}
          <span>{rich(WS_TRASH_MESSAGES.deleted, null, { value1: deleted })}</span>
        </p>
        <p className="trash-meta">
          <span>{deletedByLine(t)}</span>
          <span className={left.soon ? "trash-soon" : undefined}>{left.text}</span>
        </p>
        {note ? <p className="trash-note">{note}</p> : null}
        {t.restorable === false ? <p className="trash-note">{ARCHIVE_TEXT.trashArchived}</p> : null}
        {t.held ? <p className="trash-note">{TRASH_MESSAGES.trashHeldNote}</p> : null}
      </div>
      {preview ? null : (
        <div className="trash-acts">
          {t.restorable === false ? null : (
            <ActionForm action={restoreAction} submitLabel={WS_TRASH_MESSAGES.restore} pendingLabel="…" compact quiet>
              <input type="hidden" name="id" value={t.id} />
            </ActionForm>
          )}
          {t.held ? null : (
            <RowMenu cancel={WS_TRASH_MESSAGES.cancel}>
              <p className="row-menu-q"><strong>{q.question}</strong> {q.change}</p>
              <ActionForm action={purgeAction} submitLabel={WS_TRASH_MESSAGES.deletePermanently} pendingLabel="…" compact danger>
                <input type="hidden" name="id" value={t.id} />
                <input type="hidden" name="confirm" value="on" />
              </ActionForm>
            </RowMenu>
          )}
        </div>
      )}
    </li>
  );
}

function RestoredNotice({ sp, spaces, preview }: { sp: SearchParams; spaces: readonly MeSpace[]; preview: boolean }) {
  if (param(sp, "undone") === "1") return <Notice tone="ok">{RESTORE_PLAIN.undone}.</Notice>;
  const id = param(sp, "restored");
  if (!isId(id)) return null;
  const n = Math.min(10_000, Math.max(1, Math.trunc(Number(param(sp, "n"))) || 1));
  return (
    <Notice tone="ok">
      <div className="trash-done">
        <strong>{restoredText(n, restoredPlace(param(sp, "in"), spaces))}.</strong> {param(sp, "closed") === "nda" ? RESTORE_PLAIN.closedNda : param(sp, "closed") === "organizer" ? RESTORE_PLAIN.closedOrganizer : param(sp, "closed") === "1" ? RESTORE_PLAIN.closed : RESTORE_PLAIN.visible}
        <div className="trash-done-acts">
          <Link href={`/records/${id}`} className="btn sm" prefetch={false}>{RESTORE_PLAIN.open}</Link>
          {preview ? null : (
            <ActionForm action={restoreAction} submitLabel={RESTORE_PLAIN.undo} pendingLabel="…" compact quiet>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="op" value="undo" />
            </ActionForm>
          )}
        </div>
      </div>
    </Notice>
  );
}

export default async function TrashPageView({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const cursor = param(sp, "cursor");
  const res = await meGw<TrashPage>(session.key, "/api/v1/me/trash", { query: { limit: LIMIT, cursor: cursor || undefined } });
  const trashDays = res.ok ? res.data.trash_days ?? null : null, now = Date.now();
  const short = shortTermShared(res.ok ? res.data.items : [], trashDays);

  return (
    <>
      <PageHead title={SECTION_TITLES.trash} lead={trashLead(trashDays)} />
      <RestoredNotice sp={sp} spaces={me?.spaces ?? []} preview={Boolean(session.preview)} />
      <details className="sp-more-info"><summary>{WS_TRASH_MESSAGES.moreDetails}</summary><p>{TRASH_MESSAGES.trashHint}</p></details>
      {session.preview ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : null}
      <Section title={WS_TRASH_MESSAGES.deletedRecords} icon="trash">
        {!res.ok ? <LoadError result={res} what={WS_TRASH_MESSAGES.trash} /> : !res.data.items.length ? <Empty icon="trash" action={cursor ? <Link href="/trash" className="btn" prefetch={false}>{WS_TRASH_MESSAGES.backToTheStartOf}</Link> : <Link href="/materials" className="btn" prefetch={false}>{SECTION_TITLES.materials}</Link>}>{cursor ? WS_TRASH_MESSAGES.nothingMoreHere : WS_TRASH_MESSAGES.trashIsEmptyThereAre}</Empty> : (
          <>
            {short.lines.map((l) => <p key={l} className="hint trash-shared-note">{l}</p>)}
            <ul className="trash-list">
              {res.data.items.map((t) => <TrashCard key={t.id} t={t} trashDays={trashDays} preview={Boolean(session.preview)} now={now} sharedNotes={short.shared} />)}
            </ul>
            <nav className="pager" aria-label={WS_TRASH_MESSAGES.pages}>
              <span className="muted small">{rich(WS_TRASH_MESSAGES.shown, null, { value1: res.data.items.length })}</span>
              <span className="pager-links">
                {cursor ? <Link href={hrefWith("/trash", { cursor }, { cursor: null })} prefetch={false}>{WS_TRASH_MESSAGES.backToStart}</Link> : null}
                {res.data.next_cursor ? <Link href={hrefWith("/trash", { cursor }, { cursor: res.data.next_cursor })} prefetch={false}>{WS_TRASH_MESSAGES.next}</Link> : null}
              </span>
            </nav>
          </>
        )}
      </Section>
    </>
  );
}
