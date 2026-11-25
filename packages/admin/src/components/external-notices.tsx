import { EXTERNAL_NOTICES_TEXT } from "../messages/components";
import "server-only";
import { ActionForm } from "@/components/action-form";
import { Notice } from "@/components/ui";
import type { ExternalNotice } from "@/lib/external-access";
import { meGw } from "@/lib/me-api";
import { seenExternalNoticesAction } from "@/app/(workspace)/external/actions";

const SHOWN = 3;
const WARN = new Set(["connection_new", "connection_revoked_reuse", "refresh_reuse_rejected", "budget_exhausted"]);

export async function loadExternalNotices(sessionKey: string, unseen: unknown): Promise<ExternalNotice[]> {
  if (!(Number(unseen) > 0)) return [];
  const res = await meGw<{ items: ExternalNotice[] }>(sessionKey, "/api/v1/me/external/notices");
  return res.ok && Array.isArray(res.data.items) ? res.data.items.slice(0, SHOWN) : [];
}

export function ExternalNotices({ items }: { items: readonly ExternalNotice[] }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((n) => (
        <Notice key={n.id} tone={WARN.has(n.kind) ? "warn" : "info"} role="status">
          <strong>{n.title}.</strong> {n.text}
          <ActionForm action={seenExternalNoticesAction} submitLabel={EXTERNAL_NOTICES_TEXT.dismiss} pendingLabel="…" compact quiet>
            <input type="hidden" name="id" value={n.id} />
          </ActionForm>
        </Notice>
      ))}
    </>
  );
}
