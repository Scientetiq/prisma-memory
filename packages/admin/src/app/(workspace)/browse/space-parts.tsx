import { spaceParts as M } from "@/messages/ws-browse";
import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { keepHyphenated } from "@/components/mail-break";
import { RecordRow as SharedRecordRow } from "@/components/record-row";
import { kindInName, PLAIN, NEW_RECORDS_TAG, type SpaceTone } from "@/lib/plain";
import { whoIcon } from "@/lib/spaces";
import type { Hit, MeSpace } from "@/lib/types";

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} prefetch={false} className="sp-back"><Icon name="arrow-left" />{children}</Link>;
}

export function ClassTag({ cls }: { cls: MeSpace["default_class"] }) {
  const open = cls === "open";
  return (
    <span className={`sp-class ${open ? "is-open" : "is-closed"}`}>
      <Icon name={open ? "bot" : "lock"} /><span>{keepHyphenated(NEW_RECORDS_TAG[open ? "open" : "closed"])}</span>
      <details className="sp-q">
        <summary aria-label={M.whatThisMeans} title={M.whatThisMeans2}><Icon name="circle-help" /></summary>
        <span className="sp-q-text">{PLAIN.newRecordsHelp}</span>
      </details>
    </span>
  );
}

export function SpaceHeader({ icon, tone, kind, name, who, whoKind, whoHref, role, tags, hint, about, actions }: {
  icon: IconName; tone: SpaceTone; kind: string; name: string; who: string; whoKind: string; role?: ReactNode; tags?: ReactNode;
  whoHref?: string | null;
  hint?: ReactNode; about?: string | null; actions?: ReactNode;
}) {
  return (
    <header className="sp-head">
      <span className={`ichip tone-${tone}`}><Icon name={icon} /></span>
      <div className="sp-head-text">
        {kindInName(kind, name) ? null : <p className="sp-kind">{kind}</p>}
        <h1>{name}</h1>
        <div className="sp-meta">
          {whoHref ? <Link href={whoHref} prefetch={false} className="sp-who sp-who-link"><Icon name={whoIcon(whoKind)} />{who}</Link>
            : <span className="sp-who"><Icon name={whoIcon(whoKind)} />{who}</span>}
          {role}{tags}
        </div>
        {hint ? <p className="sp-hint">{hint}</p> : null}
        {about ? <p className="sp-about">{about}</p> : null}
      </div>
      {actions ? <div className="sp-actions">{actions}</div> : null}
    </header>
  );
}

export function RoleChip({ label, owner }: { label: string; owner?: boolean }) {
  return <span className={owner ? "chip brand sp-role" : "chip sp-role"}>{owner ? <Icon name="badge-check" /> : null}{label}</span>;
}

export function RecordRow({ href, type, eventKind, cls, title, summary, date, note, id }: {
  href: string; type?: string | null; eventKind?: string | null; cls?: string | null; title: string; summary?: string | null; date?: string | null; note?: ReactNode; id?: string | null;
}) {
  return <SharedRecordRow href={href} type={type} eventKind={eventKind} cls={cls} title={title} snippet={summary} date={date} actions={note} recordId={id} />;
}

export function RecentRows({ hits }: { hits: readonly Hit[] }) {
  return (
    <ul className="mt-list sp-rows">
      {hits.map((h) => <RecordRow key={h.id} id={h.id} href={`/records/${h.id}`} type={h.type} eventKind={h.event_kind} cls={h.class} title={h.title} date={h.occurred_at} />)}
    </ul>
  );
}
