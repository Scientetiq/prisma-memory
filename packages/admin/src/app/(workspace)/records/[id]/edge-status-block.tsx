import { edgeStatusBlockText as M } from "@/messages/ws-records";
import { ActionForm } from "@/components/action-form";
import { Badge, Section } from "@/components/ui";
import { EDGE_SHOW, edgeRecordView, type RecordEdgeStatus } from "@/lib/edge-status";
import { meGw } from "@/lib/me-api";
import { edgeShowAction } from "./edge-actions";

export async function edgeStatusOf(key: string, id: string, preview: boolean): Promise<RecordEdgeStatus | null> {
  if (preview) return null;
  const res = await meGw<RecordEdgeStatus>(key, `/api/v1/records/${id}/edge-status`);
  return res?.ok ? res.data : null;
}

export function EdgeStatusBlock({ id, v }: { id: string; v: RecordEdgeStatus | null }) {
  const view = edgeRecordView(v);
  if (!view) return null;
  return (
    <Section title={M.externalCopy} id="edge" icon="globe" hint={M.theExternalCopyContainsOpenRecords}>
      <p><Badge tone={view.tone}>{view.title}</Badge></p>
      {view.lines.map((l, i) => <p key={i} className="hint">{l}</p>)}
      {view.button ? (
        <ActionForm action={edgeShowAction} submitLabel={EDGE_SHOW.button} pendingLabel="…" quiet confirm={EDGE_SHOW.confirm}>
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      ) : null}
    </Section>
  );
}
