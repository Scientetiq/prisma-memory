import { recordTrailText as M } from "@/messages/ws-records";
import { derived } from "@/i18n/runtime";
import { Fragment } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { NavHere } from "@/components/nav-here";
import type { RecordTrail } from "@/lib/record-nav";



export function RecordPath({ trail, back, at }: { trail?: RecordTrail | null; back: string | null; at?: string }) {
  if (!trail && !back) return null;
  const arrow = <Icon name="arrow-left" />;
  return (
    <div className="rec-path">
      {back ? <Link href={back} prefetch={false} className="rec-back">{arrow}{RECORD_TRAIL_COPY.searchBack}</Link> : null}
      {back && trail ? <span className="rec-sep" aria-hidden="true">·</span> : null}
      {trail ? (
        <nav className="rec-trail" aria-label={M.recordLocation}>
          {trail.crumbs.map((c, i) => (
            <Fragment key={c.href}>
              {i ? <span className="rec-sep" aria-hidden="true">›</span> : null}
              <Link href={c.href} prefetch={false}>{!back && i === 0 ? arrow : null}{c.label}</Link>
            </Fragment>
          ))}
        </nav>
      ) : null}
      {trail && at ? <NavHere path={trail.navHref} at={at} /> : null}
    </div>
  );
}

export const RECORD_TRAIL_COPY = derived(() => ({
  searchBack: M.backToSearchResults,
}));
