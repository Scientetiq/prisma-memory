// "Versions" on the record page of a document: the chain newest first — number, date,
// who uploaded it, size, "current", a link to each version (its page has the file to download) — and "Upload new version"
// for the author or a space owner. A record without a chain lists only itself: the page shows no block. A converted new
// version waiting for the worker is listed as "being processed", one the worker did not accept — with its reason.
// Server component: the upload form is the only client part.
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Badge, Notice, Section } from "@/components/ui";
import type { VersionItem, VersionPendingView } from "@/lib/types";
import { currentVersion, sizeText, versionBadge, versionsShown } from "@/lib/versions";
import { VERSIONS_TEXT } from "@/lib/versions.messages";
import { VersionUpload } from "./version-upload";

const T = VERSIONS_TEXT;

/** The page of a converted new version itself: being processed, or not accepted with the reason. */
export function VersionPendingNotice({ pending, of }: { pending: VersionPendingView; of: string | null }) {
  if (pending.state === "processing") return <Notice tone="info"><strong>{T.pendingLead}</strong> {T.pendingText}</Notice>;
  return (
    <Notice tone="warn">
      <strong>{T.refusedLead}</strong> {pending.note ?? T.refusedFallback}
      {of ? <> <Link href={`/records/${of}`} prefetch={false}>{T.forDocument}</Link></> : null}
    </Notice>
  );
}

/** The badge of a row in "My records" (lib/versions.ts versionBadge): earlier versions, or a new version waiting. */
export function VersionBadge({ b }: { b: NonNullable<ReturnType<typeof versionBadge>> }) {
  return <Badge tone={b.tone} title={b.title}><Icon name="history" /> {b.text}</Badge>;
}

function stateBadge(v: VersionItem): ReactNode {
  if (v.pending?.state === "processing") return <Badge tone="info"><Icon name="hourglass" /> {T.processing}</Badge>;
  if (v.pending) return <Badge tone="warn">{T.notAccepted}</Badge>;
  if (v.is_current) return <Badge tone="ok"><Icon name="check" /> {T.current}</Badge>;
  return null;
}

export function VersionsBlock({ id, items, names, upload }: {
  /** The record of the page. */
  id: string;
  items: VersionItem[];
  /** Display names of uploaders by login, when the page knows them. */
  names?: ReadonlyMap<string, string>;
  /** Offer "Upload new version" (the page decides by canUploadVersion; the gateway checks again). */
  upload: boolean;
}) {
  // without a chain there is no block: "Upload new version" of a single version stands in the "Original" section (page.tsx)
  if (!versionsShown(items)) return null;
  const head = currentVersion(items);
  const older = head !== null && head.id !== id && items.some((x) => x.id === id && !x.pending);
  return (
    <Section title={T.title} icon="history" id="versions" hint={T.hint}>
      {older && head ? <p className="hint">{T.olderNotice} <Link href={`/records/${head.id}`} prefetch={false}>{T.openCurrent}</Link></p> : null}
      <ol className="versions">
        {items.map((v) => {
          const who = v.by ? names?.get(v.by) ?? v.by : null;
          return (
            <li key={v.id} className={v.id === id ? "here" : undefined}>
              <div className="version-head">
                <b>{T.version(v.version)}</b> {stateBadge(v)}
                {v.id === id ? <span className="muted small"> · {T.thisPage}</span> : <> · <Link href={`/records/${v.id}`} prefetch={false}>{T.open}</Link></>}
              </div>
              <div className="muted small">
                <LocalTime iso={v.ingested_at} short />{who ? <> · {T.by(who)}</> : null} · {sizeText(v.bytes)}{v.filename ? <> · {v.filename}</> : null}
              </div>
              {v.pending?.state === "failed" && v.pending.note ? <p className="hint">{v.pending.note}</p> : null}
            </li>
          );
        })}
      </ol>
      {upload ? <VersionUpload replaces={head?.id ?? id} /> : null}
    </Section>
  );
}
