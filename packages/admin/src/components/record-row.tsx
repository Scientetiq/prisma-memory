import { RECORD_ROW_TEXT } from "../messages/components";
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { recordKind, type RecordState } from "@/lib/home";
import { Icon, recordIcon, type IconName } from "./icons";
import { LocalTime } from "./local-time";
import { VisibilityBadge } from "./visibility-badge";

export function StateBadge({ state, done }: { state: RecordState | null | undefined; done?: boolean }) {
  if (!state || (state.state === "done" && !done)) return null;
  return <span className={`st ${state.tone}`} title={state.detail}><Icon name={state.icon} /><span className="st-l">{state.label}</span></span>;
}

export interface RecordRowProps {
  href?: string | null;
  type?: string | null;
  eventKind?: string | null;
  title?: string | null;
  hiddenTitle?: string;
  kind?: boolean;
  date?: string | null;
  where?: ReactNode;
  meta?: ReactNode;
  snippet?: ReactNode;
  cls?: string | null;
  state?: RecordState | null;
  showDone?: boolean;
  badges?: ReactNode;
  actions?: ReactNode;
  recordId?: string | null;
  className?: string;
  icon?: IconName;
}

function dotted(parts: ReactNode[]): ReactNode[] {
  return parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "").map((p, i) => <Fragment key={i}>{i ? " · " : null}{p}</Fragment>);
}

export function RecordRow({ href, type, eventKind, title, hiddenTitle, kind = true, date, where, meta, snippet, cls, state, showDone, badges, actions, recordId, className, icon }: RecordRowProps) {
  const name = hiddenTitle ?? (title?.trim() || RECORD_ROW_TEXT.untitled);
  const line = dotted([kind && type ? recordKind(type, eventKind) : null, date ? <LocalTime iso={date} short /> : null, where, meta]);
  const sideInline = !badges;
  const cn = ["mt-row", hiddenTitle ? "is-hidden" : "", sideInline ? "side-inline" : "", className ?? ""].filter(Boolean).join(" ");
  const link = hiddenTitle ? null : href;
  return (
    <li className={cn} data-record-id={recordId ?? undefined}>
      <span className="ichip sm tone-gray"><Icon name={icon ?? (hiddenTitle ? "lock" : recordIcon(type, eventKind))} /></span>
      <span className="mt-main">
        {link ? <Link href={link} prefetch={false} className="mt-title">{name}</Link> : <span className="mt-title">{name}</span>}
        {snippet ? <span className="mt-snip">{snippet}</span> : null}
        {line.length ? <small>{line}</small> : null}
      </span>
      <span className="mt-side">
        {badges}
        <VisibilityBadge cls={cls} iconOnly />
        <StateBadge state={state} done={showDone} />
        {actions}
      </span>
    </li>
  );
}
