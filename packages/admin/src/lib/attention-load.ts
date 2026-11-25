import "server-only";
import { tryGw } from "./api";
import { attentionExtras, type AttentionInput } from "./attention";
import type { AdminDeletionRequests } from "./deletion-requests";
import type { AdminUserRow, Page, Space } from "./types";

export async function loadAttentionExtras(): Promise<Pick<AttentionInput, "notReady" | "orgNoOwner" | "deletionMeetings">> {
  const [orgSpaces, admins, deletion] = await Promise.all([
    tryGw<Page<Space>>("/api/v1/admin/spaces", { query: { kind: "org", status: "active", limit: 5 } }),
    tryGw<{ items: AdminUserRow[] }>("/api/v1/admin/admin-users"),
    tryGw<AdminDeletionRequests>("/api/v1/admin/deletion-requests", { query: { limit: 1 } }),
  ]);
  return attentionExtras({ orgSpaces: orgSpaces.ok ? orgSpaces.data : null, admins: admins.ok ? admins.data : null, deletion: deletion.ok ? deletion.data : null });
}
