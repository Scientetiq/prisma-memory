// Read models of the existing connector admin API. The panel never loads connector implementation code.
export type Schema = Record<string, unknown>;
export interface ConnectorKind {
  kind: string; title: string; description: string; verified: "live" | "mock_only";
  scopes: Array<"instance" | "person">; produces: string[];
  capabilities: { pull?: boolean; webhook?: string; entity_lookup?: string[] };
  config: Schema; secrets: Array<{ name: string; title: string; required: boolean }>;
  limits: { minIntervalSec: number };
}
export interface ConnectorView {
  id: string; kind: string; pack: string | null; name: string; scope: "instance" | "person";
  owner: { id: string; login: string; name: string } | null;
  target_space_id: string | null; data_class: "closed" | "space"; status: string;
  config: Record<string, unknown>; policy: Record<string, unknown>;
  consent: { version: string; at: string } | null;
  last_run_at: string | null; next_run_at: string | null; last_ok_at: string | null; last_error: string | null;
  failures: number; webhook_path: string | null;
  secrets: Array<{ name: string; set: boolean; fingerprint: string | null; updated_at: string | null }>;
}
export interface ConnectorRun {
  id: string; kind: string; status: string; created_at: string; started_at: string | null; finished_at: string | null;
  seen: number; staged: number; error: string | null;
}
export interface ConnectorItem { external_id: string; type: string; status: string; reason?: string; record_id?: string; version: number }
export interface KindsResponse { kinds: ConnectorKind[]; presets: Array<{ id: string; kind: string; title: string }> }
export interface ConnectorsResponse { connectors: ConnectorView[]; next_cursor?: string }
export interface RunsResponse { runs: ConnectorRun[]; next_cursor?: string }
export interface ItemsResponse { items: ConnectorItem[]; next_cursor?: string }
export const ITEM_STATUSES = ["staged", "delivering", "delivered", "unchanged", "held", "skipped", "failed", "deleted_at_source"] as const;
export const CONNECTORS_API = "/api/v1/admin/connectors";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isConnectorId = (id: string): boolean => UUID.test(id);
export function connectorPath(id: string, suffix = ""): string {
  if (!isConnectorId(id) || !/^[a-z0-9_/-]*$/.test(suffix)) throw new Error("connector_id");
  return `${CONNECTORS_API}/${id}${suffix ? `/${suffix}` : ""}`;
}
export function webhookAddress(base: string | null, path: string): string | null {
  if (!base || !/^\/api\/v1\/hooks\/[a-z0-9-]+$/.test(path)) return null;
  try {
    const u = new URL(base);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? `${u.origin}${path}` : null;
  } catch { return null; }
}
export function runCounters(runs: ReadonlyArray<Pick<ConnectorRun, "kind" | "created_at" | "seen" | "staged">>, now = Date.now()) {
  return runs.filter((r) => r.kind !== "test" && Date.parse(r.created_at) >= now - 86_400_000 && Date.parse(r.created_at) <= now)
    .reduce((n, r) => ({ seen: n.seen + r.seen, staged: n.staged + r.staged }), { seen: 0, staged: 0 });
}

/** Scan the newest run pages until the whole 24-hour window is covered; bound load even with a broken cursor. */
export async function loadRunCounters(load: (cursor?: string) => Promise<RunsResponse>, now = Date.now(), maxPages = 20) {
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const total = { seen: 0, staged: 0, complete: false };
  for (let page = 0; page < maxPages; page++) {
    const r = await load(cursor);
    const fresh = r.runs.filter((run) => { if (!run.id) return true; if (ids.has(run.id)) return false; ids.add(run.id); return true; });
    const n = runCounters(fresh, now);
    total.seen += n.seen; total.staged += n.staged;
    if (!r.next_cursor || r.runs.some((run) => Date.parse(run.created_at) < now - 86_400_000)) return { ...total, complete: true };
    if (!r.runs.length || cursors.has(r.next_cursor)) break;
    cursors.add(r.next_cursor); cursor = r.next_cursor;
  }
  return total;
}
