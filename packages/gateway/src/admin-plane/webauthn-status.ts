import type { App } from "../context.ts";

export async function adminWebauthnStatus(app: App, personId: string): Promise<{ active_keys: number }> {
  const r = await app.db.control.query("SELECT active_keys FROM v_admin_webauthn_status WHERE instance_id = $1 AND person_id = $2", [app.instanceId, personId]);
  return { active_keys: Number(r.rows[0]?.active_keys ?? 0) };
}
