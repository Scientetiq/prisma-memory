"use client";
import { useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Notice } from "@/components/ui";
import { DERIVED_PLAIN, PROMOTE_PLAIN, promoteAudienceLine, promoteConfirm } from "@/lib/plain";
import type { MeSpace } from "@/lib/types";
import { promoteAction } from "../../actions";

export type PromoteTarget = Pick<MeSpace, "slug" | "name" | "kind" | "org_unit">;

export function PromoteForm({ id, cls, targets, retelling, meeting = false, label = PROMOTE_PLAIN.button }: { id: string; cls: "open" | "closed"; targets: readonly PromoteTarget[]; retelling: boolean; meeting?: boolean;
  label?: string }) {
  const [slug, setSlug] = useState("");
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => setSlug(select.current?.value ?? ""), []);
  const target = targets.find((t) => t.slug === slug) ?? null;
  return (
    <ActionForm action={promoteAction} submitLabel={label} pendingLabel="…" quiet
      confirm={target ? promoteConfirm(target, cls, meeting) : undefined}
      ask={retelling ? undefined : { name: "confirm_wider", label: DERIVED_PLAIN.confirm }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="to_name" value={target?.name ?? ""} />
      <label className="field"><span className="field-label">{PROMOTE_PLAIN.field}</span>
        <select name="to_space" required ref={select} onChange={(e) => setSlug(e.target.value)}>
          <option value="">{PROMOTE_PLAIN.choose}</option>
          {targets.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
        </select>
      </label>
      <p className="hint" aria-live="polite">{promoteAudienceLine(target, cls)}</p>
      {retelling ? (
        <>
          <Notice tone="warn">{DERIVED_PLAIN.promoteWarning(null)}</Notice>
          <label className="check"><input type="checkbox" name="confirm_wider" /> {DERIVED_PLAIN.confirm}</label>
        </>
      ) : null}
    </ActionForm>
  );
}
