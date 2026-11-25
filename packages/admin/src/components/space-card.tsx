import { SPACE_CARD_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { VisibilityBadge } from "@/components/visibility-badge";
import { canAdd, formatCount, kindInName, PLAIN, roleLine, spaceLook } from "@/lib/plain";
import { whoIcon } from "@/lib/spaces";
import type { MeSpace } from "@/lib/types";

export const spaceHref = (s: Pick<MeSpace, "kind" | "slug">): string =>
  s.kind === "project" || s.kind === "team" ? `/projects/${encodeURIComponent(s.slug)}` : `/browse?path=${encodeURIComponent(`/spaces/${s.slug}`)}`;

export function SpaceCard({ s, archived = false, href, note }: { s: MeSpace; preview?: boolean; archived?: boolean; href?: string; note?: ReactNode }) {
  const look = spaceLook(s), role = roleLine(s);
  const n = s.counts?.records ?? 0, busy = s.counts?.unprocessed ?? 0;
  return (
    <article className={`sc${archived ? " sc-archived" : ""}`}>
      <div className="sc-top">
        <span className={`ichip tone-${archived ? "gray" : look.tone}`}><Icon name={archived ? "archive" : look.icon} /></span>
        {kindInName(look.kind, s.name) ? null : <span className="sc-kind">{look.kind}</span>}
        {s.kind === "personal" ? null : <span className="sc-role">{role.label}</span>}
      </div>
      <h3 className="sc-name"><Link href={href ?? spaceHref(s)} prefetch={false} className="cover">{s.name}</Link></h3>
      <p className="sc-who"><Icon name={whoIcon(s.kind)} />{look.audience}</p>
      {note ? <p className="sc-note">{note}</p> : null}
      <div className="sc-foot">
        <span className="sc-num">{s.counts ? <><b>{formatCount(n)}</b> {SPACE_CARD_TEXT.recordNoun(n)}</> : <span className="muted">{SPACE_CARD_TEXT.noData}</span>}</span>
        {archived ? <span className="sc-tag closed">{rich(SPACE_CARD_TEXT.archived, null, { value1: <Icon name="archive" /> })}</span> : null}
        {busy && !archived ? <Link href={canAdd(s) ? `/materials?space=${encodeURIComponent(s.slug)}#records` : href ?? spaceHref(s)} prefetch={false} className="sc-tag busy above"><Icon name="hourglass" />{SPACE_CARD_TEXT.processingCount(busy)}</Link> : null}
        {s.default_class === "closed" && s.kind !== "personal" && !archived ? <VisibilityBadge cls="closed" prefix={PLAIN.newRecordsPlain} /> : null}
      </div>
    </article>
  );
}

export function NewProjectCard() {
  return (
    <Link href="/projects/new" prefetch={false} className="sc sc-new">
      <span className="ichip tone-violet"><Icon name="plus" /></span>
      <b>{SPACE_CARD_TEXT.newProject}</b>
      <span className="muted">{SPACE_CARD_TEXT.newProjectHint}</span>
    </Link>
  );
}
