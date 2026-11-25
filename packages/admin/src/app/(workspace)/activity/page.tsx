import { pageText as M } from "@/messages/ws-activity";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Badge, Empty, LoadError, PageHead } from "@/components/ui";
import { DEFAULT_FEED_VIEW, FEED_TYPES, FEED_VIEWS, feedEntries, feedFailed, feedRecords, feedType, feedView, feedWhat, feedWho, goneText, moreText, refusedWhat, repeatText, shownText, type FeedEntry, type FeedView } from "@/lib/activity-feed";
import { AUDIT_EVENT_TYPES, CLAIMED_SOURCE_TITLES, claimedTitle } from "@/lib/labels";
import { meGw } from "@/lib/me-api";
import { requireWorkspace } from "@/lib/me";
import { hrefWith, param, type SearchParams } from "@/lib/paging";
import { DERIVED_PLAIN, EXTENDED_OPEN_PLAIN } from "@/lib/plain";
import type { MyAuditEvent } from "@/lib/types";

export function generateMetadata(): Metadata { return { title: M.myActions }; }
const LIMIT = 50;



const VIA_ICON: Record<string, IconName> = { workplace: "user", agent: "bot", service: "mic", system: "server", other_person: "users" };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  const sp = await searchParams;
  const cursor = param(sp, "cursor");
  const view = feedView(param(sp, "view"), param(sp, "auto"));
  const type = feedType(param(sp, "type"), AUDIT_EVENT_TYPES);
  const res = await meGw<{ items: MyAuditEvent[]; next_cursor: string | null }>(session.key, "/api/v1/me/audit", {
    query: { limit: LIMIT, cursor: cursor || undefined, event_type: type || undefined, view, titles: true },
  });
  const params = { view: view === DEFAULT_FEED_VIEW ? "" : view, type, cursor };
  const to = (over: Record<string, string | null>) => hrefWith("/activity", params, { cursor: null, ...over });
  const entries = res.ok ? feedEntries(res.data.items, view) : [];

  return (
    <>
      <PageHead title={M.myActions} lead={M.whatYouAndYourAgentsDid} />
      <nav className="act-chips" aria-label={M.whatToShow}>
        <ul aria-label={M.whoseActions}>
          {FEED_VIEWS.map((v) => (
            <li key={v.id}><Link href={to({ view: v.id === DEFAULT_FEED_VIEW ? null : v.id })} prefetch={false} className={v.id === view ? "on" : undefined} aria-current={v.id === view ? "true" : undefined}>{v.title}</Link></li>
          ))}
        </ul>
        <ul aria-label={M.actionType}>
          {FEED_TYPES.map((t) => (
            <li key={t.id}><Link href={to({ type: t.id === type ? null : t.id })} prefetch={false} className={t.id === type ? "on" : undefined} aria-current={t.id === type ? "true" : undefined}>{t.id === type ? <Icon name="check" /> : null}{t.title}</Link></li>
          ))}
        </ul>
      </nav>
      {!res.ok ? <LoadError result={res} what={M.auditLog} /> : !res.data.items.length ? (
        cursor ? <Empty>{rich(M.noMoreActions, null)}</Empty>
          : type || view !== DEFAULT_FEED_VIEW
            ? <Empty icon="activity" action={<Link href="/activity" className="btn" prefetch={false}>{rich(M.showHighlights, null)}</Link>}>{rich(M.noMatchingActions, null)}</Empty>
            : <Empty icon="activity" action={<Link href="/connect" className="btn" prefetch={false}>{rich(M.connectAnAgent, { tag0: () => <Icon name="plug" /> })}</Link>}>{rich(M.noActionsYetUploadAFile, null)}</Empty>
      ) : (
        <>
          <ol className="act-feed">
            {entries.map((e, i) => <FeedItem key={`${e.a.at}-${i}`} e={e} view={view} />)}
          </ol>
          <nav className="pager" aria-label={M.pages}>
            <span className="muted small">{shownText(entries.length, res.data.items.length)}</span>
            <span className="pager-links">
              {cursor ? <Link href={hrefWith("/activity", params, { cursor: null })} prefetch={false}>{rich(M.backToTheStart, null)}</Link> : null}
              {res.data.next_cursor ? <Link href={hrefWith("/activity", params, { cursor: res.data.next_cursor })} prefetch={false}>{rich(M.earlier, null)}</Link> : null}
            </span>
          </nav>
        </>
      )}
    </>
  );
}

function FeedItem({ e, view }: { e: FeedEntry; view: FeedView }) {
  const a: MyAuditEvent = e.a;
  const recs = feedRecords(a);
  const failed = feedFailed(a);
  const limited = a.event_type === "rate_limited";
  return (
    <li className={`act-item${a.auto ? " auto" : ""}${failed ? " failed" : ""}`}>
      <span className={`ichip sm tone-${failed ? "amber" : a.via === "agent" ? "violet" : "gray"}`} aria-hidden="true"><Icon name={VIA_ICON[a.via ?? ""] ?? "activity"} /></span>
      <div className="act-main">
        <p className="act-phrase"><b>{feedWho(a)}</b> · {feedWhat(a)}{limited ? <> — {refusedWhat(a)}</> : null}</p>
        {recs ? (
          <p className="act-recs">
            {recs.count !== null ? <span className="muted">{rich(M.records, null, { value0: recs.count })}</span> : <>
              {recs.shown.map((r, i) => <span key={r.id}>{i ? ", " : ""}{r.kind} <Link href={`/records/${r.id}`} prefetch={false}>«{r.title}»</Link></span>)}
              {recs.gone ? <span className="muted">{recs.shown.length ? "; " : ""}{goneText(recs.gone)}</span> : null}
              {recs.more ? <span className="muted"> {moreText(recs.more)}</span> : null}
            </>}
          </p>
        ) : null}
        <p className="act-meta">
          {e.repeat > 1 ? <span className="act-repeat">{rich(M.last, null, { value0: repeatText(e) })}</span> : null}<LocalTime iso={a.at} short />
          {a.extended_open ? <> <Badge tone="warn" title={EXTENDED_OPEN_PLAIN.badgeHint}>{EXTENDED_OPEN_PLAIN.activity}</Badge></> : null}
          {a.widened_by_human ? <> <Badge tone="warn">{DERIVED_PLAIN.activity}</Badge></> : null}
          {a.auto && view === "all" ? <> <Badge tone="muted" title={M.theWorkspaceLoadedThisAutomaticallyWhen}>{M.automatic}</Badge></> : null}
        </p>
        {a.tool || a.client || a.result_count !== null && a.result_count !== undefined ? (
          <details className="act-more">
            <summary>{rich(M.details, null)}</summary>
            <dl>
              {a.tool ? <><dt>{rich(M.tool, null)}</dt><dd><code className="code">{a.tool}</code></dd></> : null}
              {a.client ? <><dt>{rich(M.program, null)}</dt><dd title={M.sourceTheProgramSuppliesItsOwn(CLAIMED_SOURCE_TITLES[a.client.source] ?? a.client.source)}>{claimedTitle(a.client)}</dd></> : null}
              {a.result_count !== null && a.result_count !== undefined ? <><dt>{rich(M.results, null)}</dt><dd>{a.result_count}</dd></> : null}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}
