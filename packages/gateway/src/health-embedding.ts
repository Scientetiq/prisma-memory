// Health line `embedding_index`: the re-embedding as the worker last saw it. Reads
// only the registry (memory_control.embedders) and the worker's progress row `rebuild:embed` — the index-state helper of
// the records databases is granted to the worker alone, so the worker stores what it found (index_valid, counts, the
// stop). Degraded (`ok: false`) for the stops that need an administrator: `config`, `stalled`, `disk`. A warning for a
// rebuild in progress, chunks not included or parked (keyword-only), and the passing stops `provider` and `lock`.
// Counts and names only.
import { adoptionShown, readRebuildProgress, rebuildDiskMode, sourceRebuilding, vectorSourceKey, type RebuildDb, type VectorSourceState } from "@memory/shared";
import type { App } from "./context.ts";
import { diskGuardList } from "./limits.ts";

type Check = { ok: boolean; level?: "warn"; detail: string };

const dbLine = (cls: string, d: RebuildDb): string => {
  const parts = [`${cls} ${d.done}/${d.chunks}`];
  if (d.not_included) parts.push(`not included: ${d.not_included} chunks`);
  if (d.parked) parts.push(`parked: ${d.parked}`);
  if (d.waiting) parts.push(`waiting for a class move: ${d.waiting} chunks`);
  if (d.stale) parts.push(`vectors of an old source, not recomputed: ${d.stale} chunks`);
  if (d.index_valid === false) parts.push("vector index missing");
  return parts.join(", ");
};

// A change of a row's vector source — another address, model, space or vector
// generation (maintenance_state `embedder_source:<id>`, written by the worker with the vectors left of the old source) —
// is shown with that number and what search does meanwhile, until the backfill has recomputed them. A warning: search by
// meaning covers only the recomputed chunks until then. The backfill recomputes them only when the operator
// allowed it (`retrieval.reembed.recompute_stale`, until the admin page has its recompute button): the line names that lever.
// The one-time adoption of the vectors stored before this version is shown with its count and what to do if
// the connection had changed before the upgrade, until acknowledged (on the admin page) or recomputed.
// The lever is one-shot (it recomputes what is stale when it is set, then turns itself off); the adoption line
// ends when acknowledged (retrieval.reembed.adoption_seen until the admin page has it), recomputed, or no such vector is left
const LEVER = "to recompute them, press «Recompute vectors» on the admin page; until the page has it, set retrieval.reembed.recompute_stale to true (once: it turns itself off when those of current, visible records are recomputed)";
const SEEN = "if it was not, set retrieval.reembed.adoption_seen to true to hide this line";
const sourceText = (id: string, v: Partial<VectorSourceState>, lever: boolean): string => {
  const at = typeof v.changed_at === "string" ? ` since ${v.changed_at.slice(0, 16).replace("T", " ")} UTC` : "";
  const n = typeof v.stale === "number" ? `${v.stale} vectors` : "an unknown number of vectors";
  return `the vector source of ${id} changed${at} (address, model, space or a recompute): ${n} to recompute — search uses only vectors of the new source meanwhile, the other chunks are found by keyword; ${lever ? "the backfill recomputes them" : `they are not recomputed automatically: ${LEVER}`}`;
};
const adoptionText = (id: string, v: Partial<VectorSourceState>): string =>
  `${typeof v.adopted_vectors === "number" ? v.adopted_vectors : "the"} vectors of ${id} stored before this version were taken as made by its current embeddings connection; if that connection was changed before this upgrade without a recomputation, ${LEVER}; ${SEEN}`;

export async function embeddingIndexCheck(app: Pick<App, "db" | "instanceId" | "settings">): Promise<Check> {
  const rows = (await app.db.control.query(
    "SELECT e.id, e.active, e.candidate, e.retire_at, e.closed_at FROM embedders e WHERE e.active OR e.candidate OR (e.retire_at > now() AND e.closed_at IS NULL) ORDER BY e.id")).rows as Rows;
  const p = await readRebuildProgress(app.db.control, app.instanceId, "embed");
  const result = await indexLine(app, rows, p);
  const served = rows.filter((r) => r.active || r.candidate);
  if (!served.length) return result;
  const states = (await app.db.control.query(
    "SELECT key, value FROM maintenance_state WHERE instance_id = $1 AND key = ANY($2::text[]) ORDER BY key",
    [app.instanceId, served.map((r) => vectorSourceKey(r.id))])).rows as Array<{ key: string; value: Partial<VectorSourceState> | null }>;
  const notes: string[] = [];
  for (const st of states) {
    const id = st.key.slice("embedder_source:".length), v = st.value ?? {};
    if (adoptionShown(v, app.settings)) notes.push(adoptionText(id, v));
    // done once the backfill, after the change, found every chunk of the row with a vector of its source; «recomputed»
    // only by the operator's word for this source (the lever on alone is not the word yet)
    if (sourceRebuilding(id, v, p)) notes.push(sourceText(id, v, typeof v.print === "string" && v.recompute_for === v.print));
  }
  if (!notes.length) return result;
  return { ok: result.ok, ...(result.ok ? { level: "warn" as const } : {}), detail: `${result.detail}; ${notes.join("; ")}`.slice(0, 900) };
}

type Rows = Array<{ id: string; active: boolean; candidate: boolean; retire_at: string | Date | null; closed_at: string | Date | null }>;

async function indexLine(app: Pick<App, "db" | "instanceId" | "settings">, rows: Rows, p: Awaited<ReturnType<typeof readRebuildProgress>>): Promise<Check> {
  const active = rows.find((r) => r.active) ?? null, candidate = rows.find((r) => r.candidate) ?? null;
  const retained = rows.find((r) => !r.active && !r.candidate) ?? null;
  const notes: string[] = [];
  if (p?.stop) {
    const text = `${p.stop.reason}: ${p.stop.detail}`;
    if (p.stop.reason === "config" || p.stop.reason === "stalled" || p.stop.reason === "disk") return { ok: false, detail: `re-embedding stopped — ${text}` };
    notes.push(`re-embedding paused — ${text}`);
  }
  // the progress describes the target it names; one of another target (an older run) is not shown as its numbers
  const current = p && p.to === (candidate ?? active)?.id ? p : null;
  const dbs = current ? Object.entries(current.databases).filter((e): e is [string, RebuildDb] => !!e[1]) : [];
  const counts = dbs.map(([cls, d]) => dbLine(cls, d)).join("; ");
  if (candidate) notes.unshift(`re-embedding ${active?.id ?? "(none)"} → ${candidate.id}${counts ? `: ${counts}` : ""}; search stays on ${active?.id ?? "keyword"} until the switch`);
  else if (dbs.some(([, d]) => d.not_included > 0 || d.parked > 0)) notes.unshift(`keyword-only for part of the records: ${counts}`);
  else if (dbs.some(([, d]) => d.done + d.parked + d.not_included < d.chunks)) notes.unshift(`filling vectors of ${active?.id}: ${counts}`);
  // a retained model kept past its retention: the search model lacks some of its vectors and no switch confirmed that
  for (const h of p?.purge_held ?? [])
    notes.push(`the previous model ${h.id} is kept past its retention: ${h.chunks ? `${h.chunks} chunks have only its vectors` : "there is no search model"} and no switch confirmed leaving them keyword-only`);
  // a covered candidate the automatic switch may not take waits for a confirmation the panel has no control
  // for yet (the operator page comes later): say why, with the counts, instead of a silent stop
  if (candidate && current?.phase === "ready") {
    const left = dbs.reduce((n, [, d]) => n + d.not_included + d.parked, 0);
    if (left > 0) notes.push(`the switch to ${candidate.id} waits for an administrator's confirmation: ${left} chunks would stay keyword-only (not included or parked); the panel has no control for it yet`);
  }
  // records whose preparation for search has waited long for a class move (index_held_long): not searchable by
  // meaning until the move settles — the records and the move are on «Unprocessed» and «Class moves»
  const heldLong = dbs.reduce((n, [, d]) => n + (d.held_long ?? 0), 0);
  if (heldLong) notes.push(`${heldLong} ${heldLong === 1 ? "record waits" : "records wait"} long for a class move (index_held_long): not prepared for search until the move settles`);
  if (candidate && current?.truncated) notes.push(`${current.truncated} inputs cut to the input limit of ${candidate.id}`);
  // the disk is not guarded while vectors are being added: a visible note, not degraded
  const filling = !!candidate || dbs.some(([, d]) => d.done + d.parked + d.not_included < d.chunks);
  const mode = rebuildDiskMode(app.settings);
  if (filling && mode === "skip") notes.push("free space not checked (processing.rebuild_disk = skip)");
  else if (filling && mode === "auto" && diskGuardList().length === 0) notes.push("free space not checked: the gateway guards no disk path (MEMORY_DISK_GUARD_PATHS is empty)");
  if (notes.length) return { ok: true, level: "warn", detail: notes.join("; ").slice(0, 600) };
  if (retained) {
    const until = retained.retire_at ? ` until ${new Date(retained.retire_at).toISOString().slice(0, 10)}` : "";
    return { ok: true, detail: `${active?.id ?? "no model"} is the search model; the previous model ${retained.id} is kept${until} (rollback possible)` };
  }
  if (!active) return { ok: true, detail: "no embedding model: keyword search only" };
  return { ok: true, detail: counts ? `${active.id}: ${counts}` : `${active.id}: no re-embedding in progress` };
}
