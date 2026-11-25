// The public address the gateway last started with: maintenance_state key `public_url`, value { "url": <origin> }.
// MEMORY_PUBLIC_URL is the issuer and the address agents connect to while the settings leave them empty; when it changes
// between two starts (or is removed, or set again after a removal), the agents' connections and tokens issued for the old
// address stop matching — the start says so once with `public_url_changed` (origins only: the variable never carries a user
// name, deploy-guard.ts refuses it). A removal keeps the row as { "url": null } (the gateway's role may not DELETE there).
// The first start with an address writes silently; a start without one on a database that has no row writes nothing. A failure is logged and
// does not stop the start, like markWallTimeFix.
import type { App } from "./context.ts";
import { log, publicAddress } from "@memory/shared";

/** Key of maintenance_state with the last public address. */
export const PUBLIC_URL_STATE_KEY = "public_url";

/** Compare MEMORY_PUBLIC_URL with the address of the previous start; warn once on a change, then store the new one. */
export async function notePublicUrl(app: Pick<App, "db" | "instanceId">, url: string | null = publicAddress().url): Promise<void> {
  try {
    const ctl = app.db.control;
    const row = (await ctl.query("SELECT value->>'url' AS url FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, PUBLIC_URL_STATE_KEY])).rows[0] as
      { url: string | null } | undefined;
    const before = row ? (row.url ?? null) : undefined;
    // no row and no address (every installation that never set the variable) — nothing to compare, nothing to write
    if (before === url || (before === undefined && url === null)) return;
    if (before !== undefined) log.warn("public_url_changed", { from: before, to: url });
    // a removal is stored as { "url": null } with the same upsert: the gateway's role has no DELETE on maintenance_state
    await ctl.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, jsonb_build_object('url', $3::text), now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [app.instanceId, PUBLIC_URL_STATE_KEY, url]);
  } catch (e) {
    log.warn("public_url_note_failed", { error: (e as Error).message.slice(0, 200) });
  }
}
