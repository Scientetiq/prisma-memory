// "Export a space" — what goes into the archive and the download. The button "Export
// this space" on the space pages leads here: /export?space=<slug>. The numbers come from the gateway's preview (the same
// selection as the export itself) — no content, no audit event; the download is a plain form POST to /api/export
// (works without JavaScript; the browser saves the streamed archive as a file and this page stays open). A refusal of
// the download comes back as ?error=<code> from a fixed list. The gateway decides who may export: a person who opened
// this address without the button gets its refusal in words, and no form.
import type { Metadata } from "next";
import { Icon } from "@/components/icons";
import { Block } from "@/components/block";
import { Notice, PageHead } from "@/components/ui";
import { exportBackHref, exportPreviewLines, exportProblemOf, exportProblemText, EXPORT_ROUTE, isExportProblem, isExportSlug, type ExportPreview, type ExportProblem } from "@/lib/export";
import { exportText } from "@/lib/export.messages";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { param, type SearchParams } from "@/lib/paging";
import type { MySpace } from "@/lib/types";
import { BackLink } from "../browse/space-parts";

export const metadata: Metadata = { title: exportText("page.title_plain") };

/** Refusals of the preview after which no export can start either: no form, only the reason. */
const FINAL: ReadonlySet<ExportProblem> = new Set(["denied", "disabled", "not_found", "preview", "session", "bad_request"]);

export default async function ExportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const raw = param(sp, "space");
  const slug = isExportSlug(raw) ? raw : null;
  const problem = param(sp, "error");
  const known = me.spaces.find((s) => s.slug === slug) ?? null;

  const head = (name: string | null, kind: string | null) => (
    <>
      <BackLink href={slug ? exportBackHref(slug, kind) : "/browse"}>{name ? exportText("page.back", { name }) : exportText("page.back_plain")}</BackLink>
      <PageHead title={name ? exportText("page.title", { name }) : exportText("page.title_plain")} lead={exportText("page.lead")} />
    </>
  );
  // a preview reads as somebody else: no copy of that person's records, and not even the numbers are asked for
  if (session.preview) return <>{head(known?.name ?? null, known?.kind ?? null)}<Notice tone="info">{exportText("page.preview_denied")}</Notice></>;
  if (!slug) return <>{head(null, null)}<Notice tone="info">{exportText("page.bad_space")}</Notice></>;

  const enc = encodeURIComponent(slug);
  // the card names an archived space too (memory_me lists only active ones); the preview applies the export's own rules
  const [cardRes, previewRes] = await Promise.all([
    meGw<MySpace>(session.key, `/api/v1/me/spaces/${enc}`),
    meGw<ExportPreview>(session.key, `/api/v1/me/spaces/${enc}/export/preview`),
  ]);
  const card = cardRes.ok ? cardRes.data : null;
  const name = card?.name ?? known?.name ?? null;
  const kind = card?.kind ?? known?.kind ?? null;
  const refused: ExportProblem | null = previewRes.ok ? null : exportProblemOf(previewRes.status, { code: previewRes.code, details: previewRes.details });
  // the reason of a refused download, once: not when the same refusal is already the page's final word, and never
  // "session" — this page is rendered for a working session only (requireWorkspace), so that code is from before a new sign-in
  const shownFinal = refused && FINAL.has(refused) ? refused : null;
  const lastError = isExportProblem(problem) && problem !== "session" && problem !== shownFinal ? problem : null;

  return (
    <>
      {head(name, kind)}
      {lastError ? <Notice tone="danger">{exportProblemText(lastError)}</Notice> : null}
      {shownFinal ? <Notice tone="info">{exportProblemText(shownFinal)}</Notice> : (
        <>
          <Block id="export-what" icon="layers" title={exportText("page.what_title")}>
            {previewRes.ok ? (
              <ul className="sp-rows export-lines">
                {exportPreviewLines(previewRes.data).map((line) => <li key={line} className="sp-line">{line}</li>)}
              </ul>
            ) : <p className="sp-line">{exportText("page.preview_failed")}</p>}
          </Block>
          <Block id="export-how" icon="text" title={exportText("page.format_title")}>
            <p className="sp-line">{exportText("page.format_line")}</p>
            <p className="sp-line">{exportText("page.audit_line")}</p>
          </Block>
          <form method="post" action={EXPORT_ROUTE} className="export-form">
            <input type="hidden" name="space" value={slug} />
            {/* the route sends a refusal back to this page for its own form, also where browsers send no Sec-Fetch-Mode */}
            <input type="hidden" name="from" value="page" />
            <button type="submit" className="btn primary"><Icon name="download" />{exportText("page.download")}</button>
            <p className="sp-hint">{exportText("page.download_hint")}</p>
          </form>
        </>
      )}
    </>
  );
}
