// Replacing the current version of a record by a new one: the SQL that `createRecord` ran inline, extracted so that
// the gateway and the worker that finishes a converted document version run the same statements.
import type pg from "pg";

/** Reason stored on the skipped stages of a replaced version (`record_stages.last_error`); the "superseded:" prefix classifies it. */
export const SUPERSEDED_STAGE_NOTE = "superseded: a newer version is being processed";
/** Reason stored on the skipped stages of a version a person's correction replaced. */
export const CORRECTED_STAGE_NOTE = "superseded: corrected by a person";

/** All descendants of record `$1` along parent_id (CTE `d`, without the record itself): a new version retires the whole subtree. */
export const DESCENDANTS_SQL = "WITH RECURSIVE d AS (SELECT id FROM records WHERE parent_id = $1 UNION SELECT r.id FROM records r JOIN d ON r.parent_id = d.id)";

/**
 * Inside the caller's transaction: record `id` replaces `prevId`. The previous version and its descendants stop being
 * current but stay readable by id; their unfinished stages become `skipped` with `staleNote` as the reason (the worker's
 * scheduler only sees current records, so they would stay pending forever). Stale chunks of the previous version are
 * removed by the worker at the `indexed` stage of the new one — the gateway role has no DELETE on chunks.
 */
export async function supersedeInTx(c: Pick<pg.PoolClient, "query">, a: { id: string; prevId: string; staleNote: string }): Promise<void> {
  await c.query("UPDATE records SET is_current = false, superseded_by_id = $1 WHERE id = $2", [a.id, a.prevId]);
  await c.query(`${DESCENDANTS_SQL} UPDATE records SET is_current = false WHERE id IN (SELECT id FROM d)`, [a.prevId]);
  await c.query(`${DESCENDANTS_SQL} UPDATE record_stages SET status = 'skipped', last_error = $2, updated_at = now()
                 WHERE status IN ('pending','failed') AND (record_id = $1 OR record_id IN (SELECT id FROM d))`, [a.prevId, a.staleNote]);
}

// ---------------------------------------------------------------- two-phase versions of converted documents
// A PDF or office file has no text until the worker's `converted` stage and its open check. Its new version is written as a
// record of its own with `attrs.version_pending = {of, places}` (`supersedes_id` empty): the previous version stays current
// and searchable. The worker replaces the head in the same transaction that completes `converted` (doc-version-finish.ts)
// — or, when the head was deleted, moved or changed meanwhile (or a newer version landed after this file had failed to
// convert and was retried), refuses: the text is not published, `final: true` with the reason, the record stays a failed
// upload of its own visible only to its author and uploader.

/** Why a pending version did not replace the current one. */
export const VERSION_PENDING_REASONS = ["conversion_failed", "open_check", "head_gone", "head_moved", "head_changed", "head_newer"] as const;
export type VersionPendingReason = (typeof VERSION_PENDING_REASONS)[number];

/** The state of a pending version as the workspace and the history show it. */
export interface VersionPending {
  /** The version the file was uploaded on top of (the head at upload time). */
  of: string;
  /** Spaces the uploader could still write to at upload time: the head's placements there move to the new version. */
  places: string[];
  /** processing — the worker has not decided yet; failed — the file did not replace the current version. */
  state: "processing" | "failed";
  reason: VersionPendingReason | null;
  /** The worker's own refusal (head gone, moved, changed, newer): final, a retried conversion refuses again. */
  final: boolean;
}

/**
 * "Process now" on a pending version whose `converted` stage failed: marks `version_pending.retried`, whatever failed the
 * stage — the converter (then `conversion.status` says failed as well), the scheduler's sweep of a stuck pass, or a lost
 * failure mark (both leave `conversion` as it was). The worker's finisher reads the mark (versionRetried): a version added
 * after this file failed stays current (`head_newer`). Run by the gateway BEFORE the stage is reset to pending ($1 = record id).
 */
export const MARK_VERSION_RETRIED_SQL =
  `UPDATE records SET attrs = jsonb_set(attrs, '{version_pending,retried}', 'true'::jsonb)
    WHERE id = $1 AND jsonb_typeof(attrs -> 'version_pending') = 'object'
      AND EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = $1 AND s.stage = 'converted' AND s.status = 'failed')`;

/** The mark of MARK_VERSION_RETRIED_SQL: this pending version's conversion failed once and was started again. */
export function versionRetried(attrs: unknown): boolean {
  const v = attrs && typeof attrs === "object" ? (attrs as { version_pending?: unknown }).version_pending : null;
  return !!v && typeof v === "object" && (v as { retried?: unknown }).retried === true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `attrs.version_pending` of a record, read defensively; null when the record is not a pending version. A failed
 * conversion or a refusal of the open check shows as `failed` without a mark of its own: the conversion state says so
 * (`attrs.conversion.status = failed`), and a retried conversion that succeeds still replaces the head — unless a newer
 * version landed meanwhile (the worker refuses then with `head_newer`).
 */
export function versionPendingOf(attrs: unknown): VersionPending | null {
  const a = attrs && typeof attrs === "object" ? attrs as { version_pending?: unknown; conversion?: unknown } : null;
  const v = a?.version_pending && typeof a.version_pending === "object" ? a.version_pending as Record<string, unknown> : null;
  if (!v || typeof v.of !== "string" || !UUID_RE.test(v.of)) return null;
  const places = Array.isArray(v.places) ? v.places.filter((s): s is string => typeof s === "string" && UUID_RE.test(s)) : [];
  const reason = (VERSION_PENDING_REASONS as readonly unknown[]).includes(v.reason) ? v.reason as VersionPendingReason : null;
  if (v.final === true) return { of: v.of, places, state: "failed", reason: reason ?? "head_gone", final: true };
  const conversion = a?.conversion && typeof a.conversion === "object" ? a.conversion as { status?: unknown; error_kind?: unknown } : null;
  if (conversion?.status === "failed")
    return { of: v.of, places, state: "failed", reason: conversion.error_kind === "open_check" ? "open_check" : "conversion_failed", final: false };
  return { of: v.of, places, state: "processing", reason: null, final: false };
}
