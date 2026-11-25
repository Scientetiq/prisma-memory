import { ActionForm } from "@/components/action-form";
import { Badge, Section } from "@/components/ui";
import { meGw } from "@/lib/me-api";
import { recheckKeepAction } from "./recheck-actions";
import { RECHECK_BLOCK, type RecordRecheck } from "./recheck-view";

export async function recheckOf(key: string, id: string, preview: boolean): Promise<RecordRecheck | null> {
  if (preview) return null;
  const res = await meGw<RecordRecheck>(key, `/api/v1/records/${id}/recheck`);
  return res?.ok && res.data?.held ? res.data : null;
}

export function RecheckBlock({ id, v }: { id: string; v: RecordRecheck | null }) {
  if (!v?.held) return null;
  const badge = v.state === "kept" ? RECHECK_BLOCK.kept : v.state === "on_restore" ? RECHECK_BLOCK.onRestore : RECHECK_BLOCK.held;
  return (
    <Section title={RECHECK_BLOCK.title} id="recheck" icon="shield" hint={RECHECK_BLOCK.hint}>
      <p><Badge tone="warn">{badge}</Badge></p>
      {v.text ? <p className="hint">{v.text}</p> : null}
      {v.state === "kept" ? <p className="hint">{RECHECK_BLOCK.keptLine}</p> : null}
      {v.can_keep ? (
        <ActionForm action={recheckKeepAction} submitLabel={RECHECK_BLOCK.keep} pendingLabel="…" quiet confirm={RECHECK_BLOCK.keepConfirm}>
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      ) : null}
    </Section>
  );
}
