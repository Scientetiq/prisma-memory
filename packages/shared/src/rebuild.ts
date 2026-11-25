// Rebuild on a filled database: the shared words and pure rules of every rebuild that converts the
// stored form of each chunk while search keeps working — the re-embedding (kind `embed`) and the full-text
// language (kind `fts`), and the later tasks that reuse them. Read by the worker, health and the admin page.
//
// The phase is never stored: it is derived from the columns the readers already read (the registry rows of
// memory_control.embedders; the one retrieval_config row of each records database). What IS stored, one
// maintenance_state row per kind under `rebuild:<kind>`, is progress — counters, a cursor of convenience, the parked
// units and the last stop. Losing that row costs a re-count, never a wrong switch: a switch re-proves "nothing left"
// inside its own transaction.
import type { DataClass } from "./db.ts";

export type RebuildKind = "embed" | "fts";
/**
 * `prepared` — the new form is declared and every reader can read it, nothing is stored in it; `filling` — every write
 * produces the new form and a job converts the rest; `ready` — the query "units without the new form" returns 0;
 * `switched` — readers use the new form, the old one is kept; `retiring` — the old form is being deleted (no way back).
 */
export type RebuildPhase = "idle" | "prepared" | "filling" | "ready" | "switched" | "retiring";
export const REBUILD_PHASES: readonly RebuildPhase[] = ["idle", "prepared", "filling", "ready", "switched", "retiring"];

/** Why a run stopped short of its work. `detail` ≤ 200 characters, never content. A budget wait is not a stop. */
export type RebuildStop = { reason: "provider" | "config" | "disk" | "lock" | "stalled"; detail: string; since: string };
/** The longest `detail` of a stop. */
export const REBUILD_STOP_DETAIL_MAX = 200;
/** Parked units per kind at most: one more stops the rebuild (`stalled`) — it does not go on by parking. */
export const REBUILD_PARKED_MAX = 200;

/** One records database of a rebuild: live units, units in the new form, units the policy keeps out, parked units. */
/**
 * `waiting` (kind `embed`, only when > 0): chunks without the target's vector whose record may not go to a model
 * now (a class move in flight, the locator elsewhere — embed-source.ts) — skipped by the last run, filled after the move.
 * `stale` (kind `embed`, only when > 0): chunks with a vector of another source only, not recomputed until
 * the operator allows it (`retrieval.reembed.recompute_stale`) — neither done nor work left.
 */
export interface RebuildDb { chunks: number; done: number; not_included: number; parked: number; cursor: string | null; index_valid: boolean | null; waiting?: number; held_long?: number; stale?: number }
export interface RebuildProgress {
  kind: RebuildKind; phase: RebuildPhase; from: string | null; to: string | null; at: string; need_bytes: number;
  databases: Partial<Record<DataClass, RebuildDb>>; parked_ids: string[]; stop: RebuildStop | null;
  /**
   * Kind `embed`: databases where a retired embedder has no vector left (`<embedder id>:<class>`), so that a finished
   * purge is not probed again (a probe of a dropped embedder scans chunk_embeddings). Not state: a lost list costs one
   * probe per database.
   */
  purged?: string[];
  /**
   * Kind `embed`: retained models whose retention is over but whose vectors are kept, because the search model lacks
   * `chunks` of them and no switch confirmed leaving those keyword-only (0 — there is no search model).
   */
  purge_held?: Array<{ id: string; chunks: number }>;
  /** Kind `embed`: inputs of the target cut to its model's input limit so far (counted, never parked). */
  truncated?: number;
}

export const rebuildStateKey = (kind: RebuildKind): string => `rebuild:${kind}`;
/** maintenance_state key the gateway writes with the free space of the database volume (smallest of its paths). */
export const DISK_FREE_KEY = "disk_free";
/** A disk report older than this is not trusted. */
export const DISK_REPORT_MAX_AGE_MS = 10 * 60_000;
/** Share of the volume that stays free after a rebuild's estimated growth. */
export const DISK_KEEP_FREE_RATIO = 0.15;
/** The setting that decides whether the head-room check is required. */
export const REBUILD_DISK_SETTING = "processing.rebuild_disk";

/** A client or pool: one query at a time. */
export type Tx = { query(sql: string, args?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export interface DiskReport { free_bytes: number; total_bytes: number; at: string }
/** The gateway's report that it guards no disk path (MEMORY_DISK_GUARD_PATHS empty): nothing is measured. */
export interface DiskUnguarded { configured: false; at: string }

/** A stop with its detail cut to the limit. */
export function rebuildStop(reason: RebuildStop["reason"], detail: string, since: Date | string = new Date()): RebuildStop {
  return { reason, detail: detail.slice(0, REBUILD_STOP_DETAIL_MAX), since: typeof since === "string" ? since : since.toISOString() };
}

/** The progress row of a kind, or null (none yet, or not a progress row). */
export async function readRebuildProgress(q: Tx, instanceId: string, kind: RebuildKind): Promise<RebuildProgress | null> {
  const v = (await q.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [instanceId, rebuildStateKey(kind)])).rows[0]?.value;
  if (!v || typeof v !== "object" || v.kind !== kind || !REBUILD_PHASES.includes(v.phase)) return null;
  return { ...v, databases: v.databases ?? {}, parked_ids: Array.isArray(v.parked_ids) ? v.parked_ids : [], stop: v.stop ?? null } as RebuildProgress;
}

/** The disk report of the gateway (measured, or "no path guarded"), or null when there is none or it is not one. */
export async function readDiskReport(q: Tx, instanceId: string): Promise<DiskReport | DiskUnguarded | null> {
  const v = (await q.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [instanceId, DISK_FREE_KEY])).rows[0]?.value;
  if (v && v.configured === false && typeof v.at === "string") return { configured: false, at: v.at };
  if (!v || !Number.isFinite(Number(v.free_bytes)) || !(Number(v.total_bytes) > 0) || typeof v.at !== "string") return null;
  return { free_bytes: Number(v.free_bytes), total_bytes: Number(v.total_bytes), at: v.at };
}

const gib = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GiB`;

/** The values of processing.rebuild_disk: `auto` — the default. */
export type RebuildDiskMode = "require" | "skip" | "auto";
const UNGUARDED = "free space not checked: the gateway guards no disk path (MEMORY_DISK_GUARD_PATHS is empty)";

/**
 * May a rebuild that will grow the database by `needBytes` start or go on? With a measured report younger than ten
 * minutes it passes when the free space minus that growth still leaves 15 % of the volume. No report, or an old one, is
 * never "enough space". The gateway that guards no disk path says so (`configured: false`): `auto` (the default) then
 * passes and says the space was not checked, `require` refuses and says what to set. `skip` passes without a report.
 */
export function headroom(o: { needBytes: number; report: DiskReport | DiskUnguarded | null; mode: RebuildDiskMode; now: number }): { ok: boolean; detail: string } {
  if (o.mode === "skip") return { ok: true, detail: "free space not checked (processing.rebuild_disk = skip)" };
  const need = Math.max(0, Number(o.needBytes) || 0);
  if (!o.report) return { ok: false, detail: "no free-space report of the database volume yet (is the gateway running?); processing.rebuild_disk = skip runs without one" };
  const age = o.now - Date.parse(o.report.at);
  if (!Number.isFinite(age) || age > DISK_REPORT_MAX_AGE_MS)
    return { ok: false, detail: `the free-space report of the database volume is older than ${DISK_REPORT_MAX_AGE_MS / 60_000} minutes (is the gateway running?)` };
  if ("configured" in o.report) {
    if (o.mode === "auto") return { ok: true, detail: UNGUARDED };
    return { ok: false, detail: "processing.rebuild_disk = require, but the gateway guards no disk path: set MEMORY_DISK_GUARD_PATHS for the gateway, or set processing.rebuild_disk to auto" };
  }
  const left = o.report.free_bytes - need, keep = DISK_KEEP_FREE_RATIO * o.report.total_bytes;
  if (left < keep)
    return { ok: false, detail: `not enough free space: ${gib(o.report.free_bytes)} free, the rebuild needs about ${gib(need)} and ${Math.round(DISK_KEEP_FREE_RATIO * 100)} % of ${gib(o.report.total_bytes)} must stay free` };
  return { ok: true, detail: `${gib(o.report.free_bytes)} free, about ${gib(need)} needed` };
}

/** The setting `processing.rebuild_disk`: `auto` when unset; `require` or `skip` as written; any other value — `require`. */
export const rebuildDiskMode = (settings: { get<T>(k: string, d: T): T }): RebuildDiskMode => {
  const v = settings.get<unknown>(REBUILD_DISK_SETTING, "auto");
  return v === "skip" || v === "auto" ? v : "require";
};

// ---------------------------------------------------------------- the vector source of a registry row

/**
 * maintenance_state `embedder_source:<id>`, written by the worker only (workers embedders.ts followVectorSources):
 * - `print` — the vector source its connection gives now (embedder.ts vectorSource);
 * - `adopted` — the source the vectors without a source (stored before) were taken for, or null — none: they are
 *   stale. Set ONCE, at the first sight, and only when the row has no labelled vector and generation 0 (
 *   on); `adopted_at` and `adopted_vectors` say when and how many, for audit and health;
 * - after a change: `from`, `changed_at`, `stale` (the vectors not of the new source at that moment);
 * - `recompute_for` — the source whose stale vectors an operator agreed to recompute (the worker
 *   writes it from the one-shot lever `retrieval.reembed.recompute_stale`, with
 *   `word_at` — the moment of the setting it came from); `adoption_seen_at` — the
 *   acknowledgement of the adoption line; `adoption_ended_at` — the worker found no adopted vector without a source left
 *   (the line ends by itself).
 */
export type VectorSourceState = {
  print: string; adopted: string | null; adopted_at?: string; adopted_vectors?: number;
  from?: string; changed_at?: string; stale?: number | null; recompute_for?: string; word_at?: string; adoption_seen_at?: string;
  adoption_ended_at?: string;
};
export const vectorSourceKey = (id: string): string => `embedder_source:${id}`;
type SettingsGet = { get<T>(k: string, d: T): T };

/**
 * `retrieval.reembed.recompute_stale`. Off (the
 * default) — no automatic recomputation after a source change: stale vectors are not searched and not recomputed, health
 * shows their count and this lever. The lever is ONE-SHOT: the worker turns it into the operator's word
 * for the vectors that are stale when it is set (`recompute_for` = each row's source then, with the moment of the setting,
 * `word_at`); the backfill recomputes those, the adopted ones included, and the worker turns the lever off when none is
 * left. A later source change needs a new word. Readers decide by `recompute_for` only, never by the setting.
 */
export const recomputeStaleOn = (settings: SettingsGet): boolean =>
  (settings.get<Record<string, unknown> | null>("retrieval.reembed", {}) ?? {}).recompute_stale === true;

/**
 * `retrieval.reembed.adoption_seen` — an
 * administrator says «seen» to the adoption line of health; replaces it by `adoption_seen_at`.
 */
export const adoptionSeen = (settings: SettingsGet): boolean =>
  (settings.get<Record<string, unknown> | null>("retrieval.reembed", {}) ?? {}).adoption_seen === true;

/** The adoption line of a row is shown — adopted, not acknowledged, not ended, no word to recompute them. */
export const adoptionShown = (v: Partial<VectorSourceState> | null | undefined, settings: SettingsGet): boolean =>
  typeof v?.adopted_at === "string" && typeof v.print === "string" && v.adopted === v.print && !v.adoption_seen_at && !v.adoption_ended_at
  && v.recompute_for !== v.print && !adoptionSeen(settings);

/** Whether the vectors without a source of a row count as `source` now (readers: search, the backfill, health). */
/**
 * The vectors of row `id` left of an old source are not all recomputed yet — the vector source changed
 * (`changed_at`) and no backfill run after the change has found every chunk of the row with a vector of its source.
 * Health (`embedding_index`) and search (the answer's note) read the same rule.
 */
export const sourceRebuilding = (id: string, v: Partial<VectorSourceState> | null | undefined, p: RebuildProgress | null): boolean => {
  if (typeof v?.changed_at !== "string") return false;
  const after = !!p && p.to === id && Date.parse(p.at) > Date.parse(v.changed_at);
  return !(after && Object.values(p!.databases).every((d) => !d || d.done + d.parked + d.not_included >= d.chunks));
};
// the operator's word (`recompute_for`), not the lever itself, decides — an adopted vector without a
// source counts until a word covers its source; the settings argument stays for the callers' shape
export const nullVectorsCount = (st: Partial<VectorSourceState> | null | undefined, source: string, _settings?: SettingsGet): boolean =>
  typeof st?.adopted === "string" && st.adopted === source && st.recompute_for !== source;

/** Whether the backfill may recompute the stale vectors of a row whose source is `source` now (the operator's word). */
export const staleRecomputeAllowed = (st: Partial<VectorSourceState> | null | undefined, source: string, _settings?: SettingsGet): boolean =>
  st?.recompute_for === source;
