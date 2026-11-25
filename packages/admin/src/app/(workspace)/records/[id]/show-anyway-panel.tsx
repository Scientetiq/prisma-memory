import { showAnywayPanelText as M } from "@/messages/ws-records";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Notice } from "@/components/ui";
import { ACCESS_ACTION, OPEN_CLASS_SPEC, CLOSED_CLASS_TEXT, SHOW_ANYWAY_LINES, SHOW_ANYWAY_NEVER, SHOW_ANYWAY_NOT_ALLOWED, SHOW_ANYWAY_STALE, showAnywayMarks, CLOSED_CLASS_COPY } from "@/lib/closed-class";
import { OPEN_CHECK_MEDIA_NOTE } from "@/lib/open-check-form";
import { audienceWho, EDIT_HELPS, foundLine, foundWhere, neverReasons } from "@/lib/show-anyway";
import type { OpenPreview } from "@/lib/types";
import { openAction, openDespiteAction } from "../../actions";

export interface ShowAnywayEdit { kind: "note" | "file"; href: string }

function neverText(p: OpenPreview): string {
  switch (p.reason) {
    case "sensitive_pii": return SHOW_ANYWAY_NEVER.sensitive_pii;
    case "empty_text": return SHOW_ANYWAY_NEVER.empty_text;
    case "too_large": return SHOW_ANYWAY_NEVER.too_large;
    case "scans_disabled": return SHOW_ANYWAY_NEVER.scans_disabled;
    default: return SHOW_ANYWAY_NEVER.never_rule(neverReasons(p.never));
  }
}

function EditAction({ reason, edit }: { reason?: string; edit: ShowAnywayEdit | null }) {
  if (!edit || !reason || !EDIT_HELPS.has(reason)) return null;
  return <Link href={edit.href} prefetch={false} className="btn">{edit.kind === "note" ? CLOSED_CLASS_COPY.showAnywayNewNote : CLOSED_CLASS_COPY.showAnywayReupload}</Link>;
}

function CleanForm({ id }: { id: string }) {
  return (
    <>
      <p className="sa-title"><strong>{OPEN_CLASS_SPEC.question}</strong></p>
      <p className="hint">{OPEN_CLASS_SPEC.change}</p>
      <p className="hint">{OPEN_CLASS_SPEC.undo}</p>
      {/* the open check reads text only */}
      <p className="hint">{OPEN_CHECK_MEDIA_NOTE}</p>
      <ActionForm action={openAction} submitLabel={ACCESS_ACTION.show} pendingLabel="…" icon="unlock" notify>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="from" value="record" />
        <label className="check"><input type="checkbox" name="confirm" /> {OPEN_CLASS_SPEC.ack?.label ?? M.iUnderstandTheConsequences}</label>
      </ActionForm>
    </>
  );
}

function ShowAnywayForm({ id, p }: { id: string; p: OpenPreview }) {
  const findings = p.findings ?? [];
  const scans = p.text_only ? <Notice tone="info">{CLOSED_CLASS_COPY.showAnywayScans}</Notice> : null;
  return (
    <>
      <p className="sa-title"><strong>{CLOSED_CLASS_COPY.showAnywayTitle}</strong></p>
      {findings.length ? <p className="hint">{CLOSED_CLASS_COPY.showAnywayLead}</p> : scans}
      <dl className="why-lines sa-lines">
        {findings.length ? (
          <div>
            <dt>{SHOW_ANYWAY_LINES.found}</dt>
            <dd>
              <ul className="sa-found">
                {findings.map((f) => {
                  const where = foundWhere(f);
                  return <li key={f.rule}>{foundLine(f)}{where ? <span className="sa-where">{where}</span> : null}</li>;
                })}
              </ul>
              <p className="hint">{CLOSED_CLASS_COPY.showAnywayCountNote}</p>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{SHOW_ANYWAY_LINES.who}</dt>
          <dd>
            {p.scope === "shared" && p.audience ? audienceWho(p.audience) : CLOSED_CLASS_COPY.showAnywayWhoSolo}
            {p.tree?.marks ? <> {showAnywayMarks(p.tree.marks)}</> : null} {CLOSED_CLASS_COPY.showAnywayCloud}
          </dd>
        </div>
        <div><dt>{SHOW_ANYWAY_LINES.undo}</dt><dd>{CLOSED_CLASS_COPY.showAnywayUndo}</dd></div>
        <div><dt>{SHOW_ANYWAY_LINES.scope}</dt><dd>{CLOSED_CLASS_COPY.showAnywayScope}</dd></div>
      </dl>
      {findings.length ? scans : null}
      {/* the open check reads text only */}
      <p className="hint">{OPEN_CHECK_MEDIA_NOTE}</p>
      <ActionForm action={openDespiteAction} submitLabel={CLOSED_CLASS_COPY.openDespiteButton} pendingLabel="…" danger icon="unlock" notify>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="consent" value={p.consent ?? ""} />
        <label className="check"><input key={p.consent ?? ""} type="checkbox" name="confirm" /> {CLOSED_CLASS_COPY.showAnywayAck}</label>
      </ActionForm>
      <p className="sa-after">
        <Link href={`/records/${id}`} prefetch={false}>{CLOSED_CLASS_COPY.showAnywayCancel}</Link>
        <span className="muted small">{CLOSED_CLASS_COPY.showAnywayRefresh}</span>
      </p>
    </>
  );
}

export function ShowAnywayPanel({ id, preview, stale, edit, spaceName }: {
  id: string; preview: OpenPreview | null; stale: string | null; edit: ShowAnywayEdit | null; spaceName: string | null;
}) {
  const plaque = stale && SHOW_ANYWAY_STALE[stale] ? <Notice tone="warn">{SHOW_ANYWAY_STALE[stale]}</Notice> : null;
  let body: ReactNode;
  if (!preview) body = <Notice tone="warn">{CLOSED_CLASS_COPY.showAnywayFailed}</Notice>;
  else switch (preview.state) {
    case "clean": body = <CleanForm id={id} />; break;
    case "show_anyway": body = <ShowAnywayForm id={id} p={preview} />; break;
    case "never": body = <><Notice tone="warn">{neverText(preview)}</Notice><EditAction reason={preview.reason} edit={edit} /></>; break;
    case "not_allowed": {
      const text = SHOW_ANYWAY_NOT_ALLOWED[preview.reason ?? ""]?.(preview.space?.name ?? spaceName ?? null) ?? CLOSED_CLASS_COPY.showAnywayUnchecked;
      body = <><Notice tone="warn">{text}</Notice><EditAction reason={preview.reason} edit={edit} /></>;
      break;
    }
    case "unchecked": body = <Notice tone="info">{preview.reason === "conversion_pending" ? CLOSED_CLASS_COPY.showAnywayConversion : CLOSED_CLASS_COPY.showAnywayUnchecked}</Notice>; break;
    case "open": body = <p className="hint">{CLOSED_CLASS_TEXT.showAnywayOpen}</p>; break;
    case "in_progress": body = <Notice tone="info">{CLOSED_CLASS_TEXT.showAnywayInProgress}</Notice>; break;
    default: body = <Notice tone="warn">{CLOSED_CLASS_COPY.showAnywayFailed}</Notice>;
  }
  return <div className="show-anyway" data-state={preview?.state ?? "failed"}>{plaque}{body}</div>;
}
