import { ownerActionsText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import type { ConfirmSpec } from "@/components/confirm-dialog";
import { Notice } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { ARCHIVE_TEXT } from "@/lib/archive";
import { ACCESS_ACTION, HIDE_AGENTS_SPEC, CLOSED_CLASS_TEXT, SHOW_AGENTS_LINES, SHOW_AGENTS_SPEC, CLOSED_CLASS_COPY } from "@/lib/closed-class";
import { Icon } from "@/components/icons";
import { DERIVED_PLAIN } from "@/lib/plain";
import { showAnywayHref } from "@/lib/show-anyway";
import { closeAction, deleteAction, openAction, processNowAction } from "../../actions";

export function OwnerGroup({ title, className, id, children }: { title: string; className?: string; id?: string; children: ReactNode }) {
  return (
    <div className={`owner-group${className ? ` ${className}` : ""}`} id={id}>
      <h3 className="owner-group-title">{title}</h3>
      {children}
    </div>
  );
}

function DespiteLink({ id, reopen }: { id: string; reopen: boolean }) {
  return (
    <>
      <p className="hint">{reopen ? CLOSED_CLASS_COPY.openAcceptedReopen : CLOSED_CLASS_COPY.openCheckOpenRefuses}</p>
      <Link href={showAnywayHref(id)} prefetch={false} className="btn primary"><Icon name="unlock" />{CLOSED_CLASS_COPY.openDespiteButton}</Link>
    </>
  );
}

export function AccessBlock({ id, cls, parentId, canHide, canShow, despite, despiteOff, panel, notAuthor, openCheckClosed, archived, retelling }: {
  id: string; cls: "open" | "closed"; parentId: string | null; canHide: boolean; canShow: boolean; despite?: { reopen: boolean } | null; despiteOff?: boolean; panel?: ReactNode;
  notAuthor?: boolean; openCheckClosed: boolean; archived: boolean; retelling: boolean;
}) {
  const derivedHint = (hidden: boolean) => rich(M.derivedHint(hidden), { link: children => <Link href={`/records/${parentId}`} prefetch={false}>{children}</Link> });
  let body: ReactNode = null;
  if (cls === "open") {
    body = parentId ? <p className="hint">{derivedHint(true)}</p>
      : canHide ? (
        <>
          <p className="hint">{CLOSED_CLASS_COPY.hideAgentsLine}</p>
          <ActionForm action={closeAction} submitLabel={ACCESS_ACTION.hide} pendingLabel="…" danger icon="lock" confirm={HIDE_AGENTS_SPEC} notify>
            <input type="hidden" name="id" value={id} />
          </ActionForm>
        </>
      ) : null;
  } else if (panel && canShow) {
    body = parentId ? <p className="hint">{derivedHint(false)}</p> : panel;
  } else if (despite && canShow && !parentId) {
    body = <DespiteLink id={id} reopen={despite.reopen} />;
  } else if (canShow) {
    body = parentId ? <p className="hint">{derivedHint(false)}</p> : (
      <>
        <dl className="why-lines">
          {SHOW_AGENTS_LINES.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {openCheckClosed ? <p className="hint">{CLOSED_CLASS_COPY.openCheckRecheck}</p> : null}
        {archived ? <p className="hint">{ARCHIVE_TEXT.openInArchive}</p> : null}
        {retelling ? <p className="hint">{DERIVED_PLAIN.openLine}</p> : null}
        <details className="more-text">
          <summary>{ACCESS_ACTION.more}</summary>
          <Notice tone="warn"><strong>{CLOSED_CLASS_TEXT.openClassLead}</strong> {CLOSED_CLASS_TEXT.openClassWarning}</Notice>
        </details>
        <ActionForm action={openAction} submitLabel={ACCESS_ACTION.show} pendingLabel="…" icon="unlock" confirm={SHOW_AGENTS_SPEC} notify>
          <input type="hidden" name="id" value={id} />
          {despiteOff ? <input type="hidden" name="despite" value="off" /> : <input type="hidden" name="from" value="record" />}
          <label className="check ack-fallback">{rich(M.iUnderstandTheConsequences, { tag0: () => <input type="checkbox" name="confirm" /> })}</label>
        </ActionForm>
      </>
    );
  } else if (notAuthor) {
    body = <p className="hint">{CLOSED_CLASS_COPY.showAnywayNotAuthor}</p>;
  }
  return (
    <OwnerGroup title={ACCESS_ACTION.title} className="access-block" id="access">
      <p className="access-state"><VisibilityBadge cls={cls} /></p>
      {body}
    </OwnerGroup>
  );
}

export function ProcessNowButton({ id, label = M.processNow }: { id: string; label?: string }) {
  return (
    <ActionForm action={processNowAction} submitLabel={label} pendingLabel="…" quiet icon="refresh">
      <input type="hidden" name="id" value={id} />
    </ActionForm>
  );
}

export function DeleteBlock({ id, confirm, label = M.deleteRecord }: { id: string; confirm: string | ConfirmSpec; label?: string }) {
  return (
    <div className="owner-group owner-delete">
      <ActionForm action={deleteAction} submitLabel={label} pendingLabel="…" danger icon="trash" confirm={confirm}>
        <input type="hidden" name="id" value={id} />
      </ActionForm>
    </div>
  );
}
