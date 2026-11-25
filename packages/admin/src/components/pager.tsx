import { PAGER_TEXT, PAGER_COUNTS, cursorCountText } from "../messages/components";
import Link from "next/link";
import { hrefWith, type LocalPage } from "@/lib/paging";

interface CursorPagerProps {
  path: string;
  params: Record<string, string>;
  cursorName: string;
  cursor: string;
  nextCursor: string | null;
  prevCursor?: string | null;
  shown: number;
  anchor?: string;
  noun?: string;
}

export function CursorPager({ path, params, cursorName, cursor, nextCursor, prevCursor, shown, anchor, noun }: CursorPagerProps) {
  const hash = anchor ? `#${anchor}` : "";
  return (
    <div className="pager">
      <span className="muted">{cursorCountText(noun, shown)}</span>
      <span className="pager-links">
        {cursor ? <Link prefetch={false} href={hrefWith(path, params, { [cursorName]: null }) + hash}>{PAGER_TEXT.first}</Link> : null}
        {cursor && prevCursor && prevCursor !== "0" ? <Link prefetch={false} href={hrefWith(path, params, { [cursorName]: prevCursor }) + hash}>{PAGER_TEXT.back}</Link> : null}
        {nextCursor ? <Link prefetch={false} href={hrefWith(path, params, { [cursorName]: nextCursor }) + hash}>{PAGER_TEXT.next}</Link> : <span className="muted">{PAGER_TEXT.last}</span>}
      </span>
    </div>
  );
}

export function LocalPager<T>({ path, params, pageName, page, anchor, count, label = PAGER_TEXT.total }: { path: string; params: Record<string, string>; pageName: string; page: LocalPage<T>; anchor?: string; count?: number; label?: string }) {
  const hash = anchor ? `#${anchor}` : "";
  const total = count !== undefined && count > page.total ? count : page.total;
  return (
    <div className="pager">
      <span className="muted">{PAGER_COUNTS.local(label, total, page.total, page.page, page.pages)}</span>
      {page.pages > 1 ? (
        <span className="pager-links">
          {page.page > 1 ? <Link prefetch={false} href={hrefWith(path, params, { [pageName]: page.page - 1 <= 1 ? null : page.page - 1 }) + hash}>{PAGER_TEXT.back}</Link> : null}
          {page.page < page.pages ? <Link prefetch={false} href={hrefWith(path, params, { [pageName]: page.page + 1 }) + hash}>{PAGER_TEXT.next}</Link> : null}
        </span>
      ) : null}
    </div>
  );
}
