"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { ActionForm, ResultLink } from "@/components/action-form";
import { ConfirmDialog, type ConfirmSpec } from "@/components/confirm-dialog";
import { Icon } from "@/components/icons";
import { TranscriptJump } from "../../../records/[id]/transcript-jump";
import { Notice } from "@/components/ui";
import { CUSTODY_PLAIN } from "@/lib/plain";
import { publicGatewayUrl, type PublicOrigin } from "@/lib/snippets";
import { copyCustodyAction, readCustodyAction, type CustodyReadOutcome } from "../../actions";
import { WS_CUSTODY_MESSAGES } from "@/messages/ws-custody";

export function ClosedReader({ slug, id, type, copyable, preview, origin }: { slug: string; id: string; type: string; copyable: boolean; preview: boolean; origin: PublicOrigin }) {
  const [asking, setAsking] = useState<ConfirmSpec | null>(null);
  const [got, setGot] = useState<CustodyReadOutcome | null>(null);
  const [pending, start] = useTransition();
  const open = () => start(async () => { setGot(await readCustodyAction(slug, id, type)); });

  if (got?.ok) return <ClosedOpened got={got} slug={slug} id={id} type={type} copyable={copyable} preview={preview} origin={origin} />;
  return (
    <>
      <Notice tone="info"><strong>{CUSTODY_PLAIN.closedTitle}.</strong> {CUSTODY_PLAIN.closedNote}</Notice>
      <p>
        <button type="button" className="btn primary" disabled={pending || preview} onClick={() => setAsking({ ...CUSTODY_PLAIN.confirmClosed })}>
          <Icon name="lock" />{pending ? WS_CUSTODY_MESSAGES.opening : CUSTODY_PLAIN.open}
        </button>
      </p>
      {got && !got.ok ? <ReadRefused got={got} /> : null}
      <ConfirmDialog spec={asking} onCancel={() => setAsking(null)} onConfirm={() => { setAsking(null); open(); }} />
    </>
  );
}

export function ClosedOpened({ got, slug, id, type, copyable, preview, origin }: {
  got: Extract<CustodyReadOutcome, { ok: true }>; slug: string; id: string; type: string; copyable: boolean; preview: boolean; origin: PublicOrigin;
}) {
  return (
    <article className="custody-read">
      <h2>{got.title}</h2>
      <div className="prose" dangerouslySetInnerHTML={{ __html: got.html }} />
      {got.truncated ? <Notice tone="info">{CUSTODY_PLAIN.truncated(Boolean(got.originalUrl))}</Notice> : null}
      {type === "transcript" ? <TranscriptJump truncated={got.truncated} /> : null}
      {got.originalUrl ? <p className="dl-line"><a className="btn sm" href={publicGatewayUrl(origin, got.originalUrl)} target="_blank" rel="noopener noreferrer"><Icon name="download" />{CUSTODY_PLAIN.download}</a></p> : null}
      {got.derived.length ? (
        <>
          <h3>{CUSTODY_PLAIN.derivedTitle}</h3>
          <ul>{got.derived.map((d) => <li key={d.id}><Link href={`/custody/${encodeURIComponent(slug)}/${d.id}`} prefetch={false}>{d.title?.trim() || CUSTODY_PLAIN.untitled}</Link></li>)}</ul>
        </>
      ) : null}
      {copyable && !preview ? (
        <ActionForm action={copyCustodyAction} submitLabel={CUSTODY_PLAIN.copy} pendingLabel={WS_CUSTODY_MESSAGES.copying} quiet confirm={CUSTODY_PLAIN.confirmCopy}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="closed" value="1" />
        </ActionForm>
      ) : null}
    </article>
  );
}

export function ReadRefused({ got }: { got: Extract<CustodyReadOutcome, { ok: false }> }) {
  return <Notice tone="danger">{got.message}<ResultLink state={got} inline /></Notice>;
}
