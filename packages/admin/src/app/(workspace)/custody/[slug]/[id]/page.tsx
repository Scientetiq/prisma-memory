import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { LoadError, Notice, PageHead } from "@/components/ui";
import { TranscriptJump } from "../../../records/[id]/transcript-jump";
import { custodyHref, custodyKind, custodyName, custodyRefusal, custodyRenderOptions, isCustodySlug } from "@/lib/custody-read";
import { isId } from "@/lib/form";
import { renderMarkdown } from "@/lib/markdown";
import { publicOrigin, requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { CUSTODY_PLAIN, formatDay, SECTION_TITLES } from "@/lib/plain";
import { publicGatewayUrl } from "@/lib/snippets";
import type { CustodyRecordView } from "@/lib/types";
import { copyCustodyAction } from "../../actions";
import { ClosedReader } from "./closed-reader";
import { WS_CUSTODY_MESSAGES } from "@/messages/ws-custody";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.custody }; }

export default async function CustodyRecordPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { session, me } = await requireWorkspace();
  const { slug: rawSlug, id } = await params;
  const slug = decodeURIComponent(rawSlug).toLowerCase();
  const res = isCustodySlug(slug) && isId(id)
    ? await meGw<CustodyRecordView>(session.key, `/api/v1/me/custody/${encodeURIComponent(slug)}/records/${encodeURIComponent(id)}`)
    : { ok: false as const, status: 404, code: "not_found", message: CUSTODY_PLAIN.gone };
  if (!res.ok) {
    const r = custodyRefusal(res);
    return (
      <>
        <PageHead title={SECTION_TITLES.custody} actions={<Link href="/custody" className="btn sm" prefetch={false}><Icon name="archive" />{CUSTODY_PLAIN.back}</Link>} />
        {r.off || r.gone ? <Notice tone="info">{r.text}</Notice> : <LoadError result={res} what={WS_CUSTODY_MESSAGES.record} />}
      </>
    );
  }
  const d = res.data, name = custodyName(d.person), preview = Boolean(session.preview);
  const origin = await publicOrigin(me);
  const meta = [custodyKind(d.type), formatDay(d.occurred_at), ...(d.deleted_at ? [CUSTODY_PLAIN.deletedMark(formatDay(d.deleted_at))] : [])].join(" · ");
  const back = <Link href={custodyHref(slug)} className="btn sm" prefetch={false}><Icon name="archive" />{CUSTODY_PLAIN.backPerson(name)}</Link>;
  if (d.confirm_required) return (
    <>
      <PageHead title={CUSTODY_PLAIN.closedTitle} lead={meta} actions={back} />
      <ClosedReader slug={slug} id={d.id} type={d.type} copyable={d.copyable} preview={preview} origin={origin} />
    </>
  );
  return (
    <>
      <PageHead title={d.title?.trim() || CUSTODY_PLAIN.untitled} lead={meta} actions={back} />
      <article className="custody-read">
        <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.text ?? "", d.type, custodyRenderOptions(slug, d.type, d.transcript_id)) }} />
        {d.truncated ? <Notice tone="info">{CUSTODY_PLAIN.truncated(Boolean(d.original_url))}</Notice> : null}
        {d.type === "transcript" ? <TranscriptJump truncated={d.truncated === true} /> : null}
        {d.original_url ? <p className="dl-line"><a className="btn sm" href={publicGatewayUrl(origin, d.original_url)} target="_blank" rel="noopener noreferrer"><Icon name="download" />{CUSTODY_PLAIN.download}</a></p> : null}
        {d.derived.length ? (
          <>
            <h3>{CUSTODY_PLAIN.derivedTitle}</h3>
            <ul>{d.derived.map((x) => <li key={x.id}><Link href={custodyHref(slug, x.id)} prefetch={false}>{x.title?.trim() || CUSTODY_PLAIN.untitled}</Link></li>)}</ul>
          </>
        ) : null}
      </article>
      {preview ? null : d.copyable ? (
        <ActionForm action={copyCustodyAction} submitLabel={CUSTODY_PLAIN.copy} pendingLabel={WS_CUSTODY_MESSAGES.copying2} quiet confirm={CUSTODY_PLAIN.confirmCopy}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={d.id} />
        </ActionForm>
      ) : <p className="hint">{d.type !== "note" && d.type !== "event" ? CUSTODY_PLAIN.notCopyable : (d.text ?? "").trim() ? CUSTODY_PLAIN.tooBig : CUSTODY_PLAIN.emptyText}</p>}
    </>
  );
}
