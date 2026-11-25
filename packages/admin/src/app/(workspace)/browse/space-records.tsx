import { rich } from "@/i18n/rich";
import { spaceRecords as M } from "@/messages/ws-browse";
import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, TYPE_ICON } from "@/components/icons";
import { Badge, Notice } from "@/components/ui";
import { CLOSED_EXPLAIN_HREF, CLOSED_CLASS_TEXT } from "@/lib/closed-class";
import { toolErrorMessage, type McpResult } from "@/lib/mcp";
import { EVENT_KIND_FOLDERS, formatCount } from "@/lib/plain";
import { crumbLabel } from "@/lib/spaces";
import type { ListEntry, ListResult, SearchResult } from "@/lib/types";
import { RecordRow as SharedRecordRow } from "@/components/record-row";
import { RecentRows, RecordRow } from "./space-parts";

const recordId = (path: string): string | null => { const last = path.split("/").pop() ?? ""; return /^[0-9a-f-]{36}$/i.test(last) ? last : null; };

export type PathHref = (path: string, cursor?: string | null) => string;

function Folders({ entries, depth, space, hrefOf }: { entries: ListEntry[]; depth: number; space: string | null; hrefOf: PathHref }) {
  return (
    <nav className="sp-folders" aria-label={M.folders}>
      {entries.map((e) => (
        <Link key={e.path} href={hrefOf(e.path)} prefetch={false} className="sp-folder">
          <Icon name={e.type ? TYPE_ICON[e.type] ?? "folder" : "folder"} />
          <span className="lbl">{space !== null ? crumbLabel(e.path.split("/").pop() ?? e.title, depth + 1, space) : e.title}</span>
          {typeof e.count === "number" ? <span className="n">{formatCount(e.count)}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

function EventKindChips({ space }: { space: string }) {
  return (
    <nav className="sp-folders sp-kinds" aria-label={M.decisionTypes}>
      {Object.entries(EVENT_KIND_FOLDERS).map(([k, label]) => (
        <Link key={k} href={`/search?mode=recent&space=${encodeURIComponent(space)}&type=event&kind=${k}`} prefetch={false} className="sp-folder">
          <Icon name="search" /><span className="lbl">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function RecentBlock({ res }: { res: McpResult<SearchResult> }) {
  if (res.ok && !res.data.hits.length) return null;
  return (
    <section className="sp-group sp-recent" aria-labelledby="sp-recent">
      <h2 className="sp-group-title" id="sp-recent">{rich(M.recentRecordsLine, { tag1: () => <Icon name="clock" /> })}</h2>
      {!res.ok ? <p className="sp-line">{rich(M.listCouldNotBeLoadedLine, null, { value1: toolErrorMessage(res) })}</p> : (
        <>
          <RecentRows hits={res.data.hits} />
          {res.data.total_estimate > res.data.hits.length ? <p className="sp-line">{M.allRecordsAreInTheFoldersAbove}</p> : null}
        </>
      )}
    </section>
  );
}

export function SpaceListing({ res, recent, path, name, hrefOf, empty, notFound, rowActions, skipFolder, extra }: {
  res: McpResult<ListResult>; recent: McpResult<SearchResult> | null; path: string; name: string | null; hrefOf: PathHref; empty: ReactNode; notFound?: ReactNode;
  rowActions?: (e: ListEntry, id: string) => ReactNode;
  skipFolder?: (e: ListEntry) => boolean;
  extra?: ReactNode;
}) {
  const segs = path.split("/").filter(Boolean);
  const crumbs = name !== null && segs.length > 2 ? segs.slice(1).map((seg, i) => ({ label: crumbLabel(seg, i, name), path: `/${segs.slice(0, i + 2).join("/")}` })) : [];
  const depth = Math.max(0, segs.length - 2);
  const entries = res.ok ? res.data.entries : [];
  const folders = entries.filter((e) => e.kind === "folder" && !skipFolder?.(e)), records = entries.filter((e) => e.kind !== "folder");
  return (
    <>
      {crumbs.length ? (
        <nav className="sp-crumbs" aria-label={M.path}>
          {crumbs.map((c, i) => (
            <span key={c.path}>{i ? <Icon name="chevron" /> : null}{i === crumbs.length - 1
              ? <span aria-current="page">{c.label}</span>
              : <Link href={hrefOf(c.path)} prefetch={false}>{c.label}</Link>}</span>
          ))}
        </nav>
      ) : null}
      {!res.ok && res.code === "not_found" ? (
        <Notice tone="info">{rich(M.pageNotFoundTheLinkMayLine, { tag1: (children) => <strong>{children}</strong> }, { value1: notFound ?? <><Link href="/browse" prefetch={false} className="btn sm">{M.goToSpacesAndProjects}</Link>{" "}
            <Link href="/search" prefetch={false}>{M.search}</Link></> })}</Notice>
      ) : !res.ok ? (
        <Notice tone={res.code === "class_denied" ? "warn" : "danger"}>{rich(M.listCouldNotBeLoadedLine2, { tag1: (children) => <strong>{children}</strong> }, { value1: toolErrorMessage(res) })}</Notice>
      ) : (
        <>
          {res.data.hidden_closed ? (
            <p className="sp-note" title={CLOSED_CLASS_TEXT.closedHiddenHint}>{rich(M.whatThisMeansLine, { tag1: () => <Icon name="lock" />, tag3: (children) => <Link href={CLOSED_EXPLAIN_HREF} prefetch={false}>{children}</Link>, tag2: (children) => <span>{children}</span> }, { value1: CLOSED_CLASS_TEXT.closedHiddenLabel, value2: formatCount(res.data.hidden_closed) })}</p>
          ) : null}
          {folders.length ? <Folders entries={folders} depth={depth} space={name} hrefOf={hrefOf} /> : null}
          {name !== null && segs[0] === "spaces" && segs[2] === "event" ? <EventKindChips space={segs[1]!} /> : null}
          {extra}
          {recent ? <RecentBlock res={recent} /> : null}
          {!entries.length ? (
            <div className="sp-empty">
              <span className="ichip tone-gray"><Icon name="folder-open" /></span>
              <p>{res.data.hidden_closed
                ? <>{rich(M.noVisibleRecordsHereYourOwnLine, { tag1: (children) => <Link href="/materials" prefetch={false}>{children}</Link> }, { value1: CLOSED_CLASS_TEXT.closedHiddenLabel, value2: formatCount(res.data.hidden_closed) })}</>
                : empty}</p>
            </div>
          ) : null}
          {records.length ? (
            <ul className="mt-list sp-rows">
              {records.map((e) => {
                const id = e.id ?? recordId(e.path);
                if (e.hidden) return (
                  <SharedRecordRow key={e.path} hiddenTitle={M.closedRecordTitleHiddenHere} type={e.type} date={e.created_at}
                    actions={rowActions && id ? rowActions(e, id)
                      : <Link href={`/materials?space=${encodeURIComponent(e.space ?? "")}&type=${encodeURIComponent(e.type ?? "")}#closed-class`} prefetch={false} className="mt-link">{M.whatToDoWithIt}</Link>} />
                );
                return (
                  <RecordRow key={e.path} id={id} href={id ? `/records/${id}` : hrefOf(e.path)} type={e.type} cls={e.class} title={e.title} summary={e.summary_line} date={e.occurred_at}
                    note={<>{e.origin === "model" && e.confirmed === false ? <Badge tone="muted" title={M.generatedAutomaticallyPleaseCheck}>{M.generatedAutomatically}</Badge> : null}{rowActions && id ? rowActions(e, id) : null}</>} />
                );
              })}
            </ul>
          ) : null}
          {res.data.next_cursor ? <p className="sp-more"><Link href={hrefOf(path, res.data.next_cursor)} prefetch={false} className="btn sm">{rich(M.moreRecordsLine, { tag1: () => <Icon name="chevron" /> })}</Link></p> : null}
        </>
      )}
    </>
  );
}
