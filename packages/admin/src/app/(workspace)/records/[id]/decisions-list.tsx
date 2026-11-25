import { decisionsListText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { actorsLabel, DECISIONS_VISIBLE, dueLooksPast, dueText, groupDecisions, type MeetingDecision, DUE_CHECK_COPY } from "@/lib/decisions";
import { HANDOVER_PLAIN } from "@/lib/plain";

function Row({ d, occurredAt, canHandOver }: { d: MeetingDecision; occurredAt: string; canHandOver: boolean }) {
  const who = actorsLabel(d.event_kind, d.actors_role);
  const due = d.due ? dueText(d.due) : null;
  return (
    <li className="decision-row">
      <div className="decision-main">
        <Link href={`/records/${d.id}`} prefetch={false} className="decision-title">{d.title || M.untitled}</Link>
        {(who && d.actors.length) || due ? (
          <div className="decision-meta">
            {who && d.actors.length ? <span>{M.actorNames(d.event_kind, d.actors)}</span> : null}
            {due ? <span>{rich(M.dueLine(dueLooksPast(d.due, occurredAt)), { check: children => <span className="chip amber due-check" title={DUE_CHECK_COPY.dueCheckHint}>{children}</span> }, { date: due })}</span> : null}
          </div>
        ) : null}
      </div>
      {canHandOver ? (
        <Link href={`/records/${d.id}#handover`} prefetch={false} className="icon-btn" aria-label={M.handoverLabel(d.title || null)} title={HANDOVER_PLAIN.link}>
          <Icon name="send" />
        </Link>
      ) : null}
    </li>
  );
}

export function DecisionsList({ items, occurredAt, canHandOver }: { items: readonly MeetingDecision[]; occurredAt: string; canHandOver: boolean }) {
  return (
    <div className="decision-groups">
      {groupDecisions(items).map((g) => {
        const rows = g.items.map((d) => <Row key={d.id} d={d} occurredAt={occurredAt} canHandOver={canHandOver} />);
        const head = rich(M.groupHeading(g.kind, g.items.length), { count: children => <span className="count">{children}</span> });
        if (g.collapsed) return (
          <details key={g.kind} className="decision-group">
            <summary>{head}</summary>
            <ul className="derived decisions">{rows}</ul>
          </details>
        );
        return (
          <section key={g.kind} className="decision-group">
            <h3>{head}</h3>
            <ul className="derived decisions">{rows.slice(0, DECISIONS_VISIBLE)}</ul>
            {rows.length > DECISIONS_VISIBLE ? (
              <details className="decision-more">
                <summary>{rich(M.showAll, null, { value0: rows.length })}</summary>
                <ul className="derived decisions">{rows.slice(DECISIONS_VISIBLE)}</ul>
              </details>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
