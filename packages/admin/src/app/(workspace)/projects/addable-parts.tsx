import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Block } from "@/components/block";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { ADDABLE_PLAIN } from "@/lib/plain";
import { ADDABLE_CURSOR, type AddableView } from "@/lib/space-addable";
import { addableMoveAction } from "./actions";

export function AddableBlock({ view, slug, kind, path, params, cursor }: {
  view: AddableView; slug: string; kind: "project" | "team";
  path: string; params: Record<string, string>; cursor: string;
}) {
  if (view.kind === "hidden") return null;
  const days = view.kind === "list" ? view.data.days : 90;
  return (
    <Block id="addable" icon="plus" title={ADDABLE_PLAIN.title} hint={ADDABLE_PLAIN.hint(kind, days)}>
      {view.kind === "failed" ? <p className="sp-line">{ADDABLE_PLAIN.failed}: {view.message}</p>
        : !view.data.items.length ? <p className="sp-line">{ADDABLE_PLAIN.empty}</p>
        : (
          <ActionForm action={addableMoveAction} submitLabel={ADDABLE_PLAIN.move} pendingLabel={ADDABLE_PLAIN.moving}>
            <input type="hidden" name="space" value={slug} />
            <ul className="ad-list">
              {view.data.items.map((m) => (
                <li key={m.id} className="ad-row">
                  <label className="ad-pick">
                    <input type="checkbox" name="ids" value={m.id} aria-label={ADDABLE_PLAIN.pick(m.title)} />
                    <span className="ad-main">
                      <span className="ad-title">{m.title}</span>
                      <small><LocalTime iso={m.occurred_at} short /> · {ADDABLE_PLAIN.share(m.in_space, m.people, kind)}</small>
                    </span>
                  </label>
                  <Link href={`/records/${m.id}`} prefetch={false} className="sp-link ad-open">{ADDABLE_PLAIN.open}</Link>
                </li>
              ))}
            </ul>
            <p className="sp-line">{ADDABLE_PLAIN.note}</p>
          </ActionForm>
        )}
      {view.kind === "list" && (cursor || view.data.next_cursor) ? (
        <CursorPager path={path} params={params} cursorName={ADDABLE_CURSOR} cursor={cursor} nextCursor={view.data.next_cursor}
          shown={view.data.items.length} anchor="addable" noun={ADDABLE_PLAIN.noun} />
      ) : null}
    </Block>
  );
}
