// Registration of embedders by reconciliation: the worker compares the two connection
// slots with the registry at start and after every settings reload and carries out one step at a time — probe a new
// model, register it (active on an empty install, candidate from the other slot), cancel a candidate whose slot was
// emptied, follow a change of the ops part. The decisions are planReconcile's (shared); this module reads the facts,
// talks to the model once per new space, makes the vector index in both records databases before the row exists, and
// writes the registry in one control transaction under an advisory lock: two worker processes never register twice.
// The embeddings facade serves every profile with the row's own connection, so a row is never refused or closed
// for what Platform.embed could not send.
//
// What it never does: touch a legacy active row whose slot has no keys of its own (an upgraded install stays exactly as
// it was — no row, no model call), bring back a closed row (tombstone), or register DDL anywhere but through the
// helpers of the schema.
import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import { nullVectorsCount, recomputeStaleOn, staleRecomputeAllowed, vectorSourceKey, type VectorSourceState } from "@memory/shared";
import { createHash } from "node:crypto";
import type pg from "pg";
import { canonicalProfileJson, embedderFor, EMBEDDERS_LOCK, log, planReconcile, probeConnection, rowConnection, slotConnection, type DataClass, type EmbedderDraft, type EmbedderRow, type EmbeddingSlot,
         type ModelConnection, type ProbeResult, type ReconcileFacts, type ReconcileStep } from "@memory/shared";
import { auditWorker, recordsDb, type Ctx, type DbCtx } from "../ctx.ts";
import { ensureEmbeddingIndex } from "./embedding-index.ts";

/** Advisory lock of the registration in memory_control (hashtext of this text): the lock of every registry move. */
export const RECONCILE_LOCK = EMBEDDERS_LOCK;
/** Steps of one run at most: probe, register, cancel and an ops update fit easily; a loop is a defect, not a reason to spin. */
export const RECONCILE_MAX_STEPS = 6;
/** A failed probe of the same connection and profile is not repeated sooner (a wrong key must not hit the provider every minute). */
export const PROBE_RETRY_MS = 10 * 60_000;
/** maintenance_state key with the last outcome (for health and the panel). */
export const RECONCILE_STATE_KEY = "embedders_reconcile";

const CLASSES: readonly DataClass[] = ["open", "closed"];
const ROW_COLUMNS = "id, model, dims, query_instruction, max_tokens, profile, connection_slot, active, candidate, retire_at, closed_at, vector_generation";

export interface ReconcileDeps {
  /** The dimension probe of a connection; default — the facade's probeConnection (through its guarded send). */
  probe?: (connection: ModelConnection, o: { profile: EmbedderDraft }) => Promise<ProbeResult>;
  now?: () => number;
}
export interface ReconcileOutcome { steps: ReconcileStep["do"][]; notes: string[]; probes: number }

/** Probe failures of this process: connection (address, model, a fingerprint of the key) + draft → time. */
const failedProbes = new Map<string, { at: number; error: string }>();
/** Said after a failed probe: the same words at every run, so the stored outcome is not rewritten each minute. */
const PROBE_REPEAT = "; the probe is repeated after ten minutes or when the connection changes";
export const resetProbeFailures = (): void => failedProbes.clear();

type Q = Pick<pg.PoolClient, "query">;

/**
 * What a remembered probe failure is about: slot, address, model, a fingerprint of the key (never the key itself) and
 * the draft. Another key, address or profile is a new connection and is probed at the next reload.
 */
function probeKey(step: Extract<ReconcileStep, { do: "probe" }>): string {
  const keyPrint = createHash("sha256").update(step.connection.apiKey ?? "").digest("hex").slice(0, 16);
  return JSON.stringify([step.slot, step.connection.baseUrl, step.connection.model, keyPrint, step.draft.space, step.draft.ops]);
}
/** The remembered failure of this probe, as a probe answer, while it is fresh (null — probe the model). */
function rememberedFailure(step: Extract<ReconcileStep, { do: "probe" }>, at: number): ProbeResult | null {
  const r = failedProbes.get(probeKey(step));
  return r && at - r.at < PROBE_RETRY_MS ? { ok: false, dims: null, normalized: null, latency_ms: 0, error: r.error } : null;
}
const readRows = async (q: Q): Promise<EmbedderRow[]> => (await q.query(`SELECT ${ROW_COLUMNS} FROM embedders ORDER BY id`)).rows as EmbedderRow[];

async function hasVectors(ctx: DbCtx, id: string): Promise<boolean> {
  for (const cls of CLASSES)
    if ((await recordsDb(ctx, cls).query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [id])).rows[0]?.ok === true) return true;
  return false;
}

/**
 * The outcome is written after every run with a step, and after a run without one only when its notes differ from the
 * stored ones: a reload without news writes nothing, and a state that changed without a step (a slot emptied after a
 * failed probe) does not leave the old note in place. Health shows these notes while no model is active.
 */
async function saveOutcome(q: Q, instanceId: string, at: number, out: ReconcileOutcome): Promise<void> {
  const value = { steps: out.steps, notes: out.notes.map((n) => n.slice(0, 300)) };
  if (!value.steps.length) {
    const stored = (await q.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [instanceId, RECONCILE_STATE_KEY])).rows[0]?.value as typeof value | undefined;
    if (canonicalProfileJson(stored?.notes ?? []) === canonicalProfileJson(value.notes)) return;
  }
  await q.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [instanceId, RECONCILE_STATE_KEY, JSON.stringify({ at: new Date(at).toISOString(), ...value })]);
}

async function dropIndexes(ctx: DbCtx, id: string): Promise<void> {
  for (const cls of CLASSES)
    await recordsDb(ctx, cls).query("SELECT memory_embedding_index_drop($1)", [id])
      .catch((e) => log.warn("embedder_index_drop_failed", { embedder: id, class: cls, error: (e as Error).message.slice(0, 160) }));
}

/**
 * One reconciliation run. Without any step to take (the usual case: nothing changed) it reads the registry once and
 * writes nothing. Errors of a step end the run with a note; the next settings reload tries again.
 */
export async function reconcileEmbedders(ctx: Pick<Ctx, "db" | "settings" | "instanceId" | "platform">, deps: ReconcileDeps = {}): Promise<ReconcileOutcome> {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? ((c: ModelConnection, o: { profile: EmbedderDraft }) => probeConnection({ platform: ctx.platform }, c, o));
  const slots = { a: slotConnection(ctx.settings, "a"), b: slotConnection(ctx.settings, "b") };
  const out: ReconcileOutcome = { steps: [], notes: [], probes: 0 };
  // a quick look without the lock: the steps that change nothing are answered here — the vector question and a probe
  // failure still remembered — so a reload with nothing to do takes no lock, opens no transaction, and the outcome is
  // written only when it changed
  const look: ReconcileFacts & { probes: Partial<Record<EmbeddingSlot, ProbeResult>> } = { rows: await readRows(ctx.db.control), slots, probes: {} };
  let first = planReconcile(look);
  for (let i = 0; i < RECONCILE_MAX_STEPS; i++) {
    const step = first.step;
    const remembered = step.do === "probe" && !look.probes[step.slot] ? rememberedFailure(step, now()) : null;
    if (step.do === "ask_vectors") look.activeHasVectors = await hasVectors(ctx, look.rows.find((r) => r.active)!.id);
    else if (step.do === "probe" && remembered) look.probes[step.slot] = remembered;
    else break;
    first = planReconcile(look);
  }
  if (first.step.do === "nothing") { out.notes = first.notes; await saveOutcome(ctx.db.control, ctx.instanceId, now(), out); return out; }

  const dropAfter: string[] = [];
  const cancelled: Array<{ id: string; reason: string }> = [];
  const client = await ctx.db.control.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [RECONCILE_LOCK]);
    const facts: ReconcileFacts & { probes: Partial<Record<EmbeddingSlot, ProbeResult>> } = { rows: await readRows(client), slots, probes: {} };
    for (let i = 0; i < RECONCILE_MAX_STEPS; i++) {
      const plan = planReconcile(facts);
      out.notes = plan.notes;
      const step = plan.step;
      if (step.do === "nothing") break;
      // the vector question and a remembered probe failure are no steps: no model call, nothing changes
      const remembered = step.do === "probe" ? rememberedFailure(step, now()) : null;
      if (step.do !== "ask_vectors" && !remembered) out.steps.push(step.do);
      if (step.do === "ask_vectors") {
        const active = facts.rows.find((r) => r.active)!;
        facts.activeHasVectors = await hasVectors(ctx, active.id);
      } else if (step.do === "probe") {
        const key = probeKey(step);
        if (remembered) {
          facts.probes[step.slot] = remembered;
        } else {
          out.probes++;
          const r = await probe(step.connection, { profile: step.draft });
          log.info("embedder_probe", { slot: step.slot, ok: r.ok, dims: r.dims, normalized: r.normalized, ms: r.latency_ms, ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
          if (r.ok) { failedProbes.delete(key); facts.probes[step.slot] = r; }
          else {
            const error = `${r.error ?? "no answer"}${PROBE_REPEAT}`;
            failedProbes.set(key, { at: now(), error });
            facts.probes[step.slot] = { ...r, error };
          }
        }
      } else if (step.do === "register") {
        // the index first, in both records databases: vectors go into a live index, and no row exists without one
        for (const cls of CLASSES) await ensureEmbeddingIndex(recordsDb(ctx, cls), { id: step.id, dims: step.profile.space.dims });
        if (step.close.length) {
          await client.query("UPDATE embedders SET active = false, candidate = false, closed_at = now() WHERE id = ANY($1::text[])", [step.close]);
          dropAfter.push(...step.close);
        }
        await client.query(
          `INSERT INTO embedders (id, model, dims, query_instruction, max_tokens, chunk_tokens, active, candidate, profile, connection_slot, activated_at)
           VALUES ($1, $2, $3, $4, $5, 480, $6, $7, $8::jsonb, $9, CASE WHEN $6 THEN now() END)`,
          [step.id, step.profile.space.model, step.profile.space.dims, step.profile.space.query_instruction, step.profile.ops.max_input_tokens,
           step.as === "active", step.as === "candidate", JSON.stringify(step.profile), step.slot]);
        log.info("embedder_registered", { embedder: step.id, slot: step.slot, as: step.as, dims: step.profile.space.dims, replaced: step.close });
        facts.rows = await readRows(client);
        delete facts.probes[step.slot];
      } else if (step.do === "cancel") {
        await client.query("UPDATE embedders SET candidate = false, closed_at = now() WHERE id = $1 AND candidate", [step.id]);
        log.info("embedder_candidate_cancelled", { embedder: step.id, reason: step.reason });
        cancelled.push({ id: step.id, reason: step.reason.slice(0, 200) });
        dropAfter.push(step.id);
        facts.rows = await readRows(client);
      } else if (step.do === "update_ops") {
        await client.query("UPDATE embedders SET profile = jsonb_set(profile, '{ops}', $2::jsonb), max_tokens = $3 WHERE id = $1",
                           [step.id, JSON.stringify(step.ops), step.ops.max_input_tokens]);
        log.info("embedder_ops_updated", { embedder: step.id });
        facts.rows = await readRows(client);
      }
    }
    await saveOutcome(client, ctx.instanceId, now(), out);
    await commitOrThrow(client);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  // a cancelled candidate is audited before its paid vectors go (the purge deletes them later)
  for (const c of cancelled) await auditWorker(ctx, { event_type: "admin", details: { op: "embedder_cancel", id: c.id, reason: c.reason } });
  // a tombstone has no index (its vectors are purged by the re-embedding job)
  for (const id of dropAfter) await dropIndexes(ctx, id);
  if (out.notes.length) log.info("embedders_reconcile_notes", { notes: out.notes.map((n) => n.slice(0, 300)) });
  return out;
}

/**
 * Legacy rows (profile NULL) are served with the model the setting names, not one of their own: a row whose
 * remembered model — the served name of its first vector, maintenance_state `embedder_alias:<id>` — is not the model its
 * connection names now must get no vector, no switch and no rollback, or vectors of two models would meet under its id.
 * The ids of such rows among `rows`, with both names.
 */
export async function legacyModelMoved(ctx: Pick<Ctx, "db" | "settings" | "instanceId">, rows: readonly EmbedderRow[]): Promise<Map<string, { was: string; now: string }>> {
  const out = new Map<string, { was: string; now: string }>();
  const legacy = rows.filter((r) => !r.profile && !r.closed_at);
  if (!legacy.length) return out;
  const aliases = new Map((await ctx.db.control.query("SELECT key, value FROM maintenance_state WHERE instance_id = $1 AND key = ANY($2::text[])",
    [ctx.instanceId, legacy.map((r) => `embedder_alias:${r.id}`)])).rows.map((r) => [String(r.key).slice("embedder_alias:".length), r.value?.model]));
  for (const r of legacy) {
    const was = aliases.get(r.id), st = rowConnection(ctx.settings, r);
    if (typeof was === "string" && st.state === "ready" && st.connection.model !== was) out.set(r.id, { was, now: st.connection.model });
  }
  return out;
}

export { vectorSourceKey, type VectorSourceState } from "@memory/shared";

/**
 * Which stored vectors of a row are of `source`: those that carry it, and those without one (stored before
 * vector sources) only while they were adopted for it (nullVectorsCount — once, at the first sight, never while
 * `recompute_stale` is on). No state yet — the worker has not followed the row: a vector without a source counts for
 * nothing (`followed` false; the backfill then does not fill the row, so nothing is recomputed before the decision).
 * `recompute` — the backfill may recompute the row's stale vectors (staleRecomputeAllowed).
 */
export type VectorView = { source: string; legacy: boolean; followed: boolean; recompute: boolean };
export async function vectorView(ctx: Pick<Ctx, "db" | "instanceId" | "settings">, id: string, source: string): Promise<VectorView> {
  const v = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, vectorSourceKey(id)])).rows[0]?.value as Partial<VectorSourceState> | undefined;
  return { source, legacy: nullVectorsCount(v, source, ctx.settings), followed: !!v && typeof v.print === "string", recompute: staleRecomputeAllowed(v, source, ctx.settings) };
}
/** SQL: the vector `e` is of the view whose source is parameter `$s` and whose NULL rule is parameter `$l` (boolean). */
export const OF_SOURCE = (e: string, s: string, l: string): string => `COALESCE(${e}.source = ${s}, ${l})`;

/** The vectors of row `id` in all records databases that are not of `view` (null — a database could not be counted). */
async function staleVectors(ctx: Pick<Ctx, "db" | "instanceId" | "settings">, id: string, view: Pick<VectorView, "source" | "legacy">): Promise<number | null> {
  try {
    let n = 0;
    for (const cls of CLASSES)
      n += Number((await recordsDb(ctx as DbCtx, cls).query(`SELECT count(*)::bigint AS n FROM chunk_embeddings e WHERE e.embedder_id = $1 AND NOT ${OF_SOURCE("e", "$2", "$3")}`,
        [id, view.source, view.legacy])).rows[0]?.n ?? 0);
    return n;
  } catch (e) {
    log.warn("embedder_vector_count_failed", { embedder: id, code: (e as { code?: unknown } | null)?.code ?? null });
    return null;
  }
}

/**
 * The vectors of row `id` in all records databases: without a source, labelled (with any source), and
 * labelled with another source than `source`; null — a database could not be counted.
 */
async function sourceCounts(ctx: Pick<Ctx, "db" | "instanceId" | "settings">, id: string, source: string): Promise<{ unlabelled: number; labelled: number; other: number } | null> {
  try {
    const out = { unlabelled: 0, labelled: 0, other: 0 };
    for (const cls of CLASSES) {
      const r = (await recordsDb(ctx as DbCtx, cls).query(
        `SELECT count(*) FILTER (WHERE e.source IS NULL)::bigint AS unlabelled, count(*) FILTER (WHERE e.source IS NOT NULL)::bigint AS labelled,
                count(*) FILTER (WHERE e.source IS DISTINCT FROM $2 AND e.source IS NOT NULL)::bigint AS other
           FROM chunk_embeddings e WHERE e.embedder_id = $1`, [id, source])).rows[0];
      out.unlabelled += Number(r?.unlabelled ?? 0); out.labelled += Number(r?.labelled ?? 0); out.other += Number(r?.other ?? 0);
    }
    return out;
  } catch (e) {
    log.warn("embedder_vector_count_failed", { embedder: id, code: (e as { code?: unknown } | null)?.code ?? null });
    return null;
  }
}

/**
 * Raises the vector generation of a registry row (only by the operator's
 * «Recompute vectors», its page and route): the generation is part of the vector source, so every stored vector
 * of the row stops being of its source — it is not reused, not searched, and the backfill recomputes it. Under the
 * registry lock; a closed row is not raised. Never silent: audit event `admin` op
 * `embedder_vector_generation_raised` with the number of the row's vectors, then the source change is followed at once
 * (followVectorSources: event `embedder_source_changed`, health). The new generation, or null (no such open row).
 */
export async function raiseVectorGeneration(ctx: Pick<Ctx, "db" | "instanceId" | "settings" | "platform">, id: string, why: string): Promise<number | null> {
  const c = await ctx.db.control.connect();
  let g: number | undefined;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [RECONCILE_LOCK]);
    g = (await c.query("UPDATE embedders SET vector_generation = vector_generation + 1 WHERE id = $1 AND closed_at IS NULL RETURNING vector_generation", [id])).rows[0]?.vector_generation as number | undefined;
    // a COMMIT the server turned into a rollback is an error — no audit event and no follow for a raise that is not stored
    await commitOrThrow(c);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  if (g === undefined) return null;
  const reason = why.slice(0, 120);
  log.info("embedder_vector_generation_raised", { embedder: id, generation: g, why: reason });
  let vectors: number | null = 0;
  for (const cls of CLASSES) {
    const n = await recordsDb(ctx as DbCtx, cls).query("SELECT count(*)::bigint AS n FROM chunk_embeddings WHERE embedder_id = $1", [id])
      .then((r) => Number(r.rows[0]?.n ?? 0), () => null);
    vectors = vectors === null || n === null ? null : vectors + n;
  }
  await auditWorker(ctx as DbCtx, { event_type: "admin", details: { op: "embedder_vector_generation_raised", id, generation: g, why: reason, vectors } });
  await followVectorSources(ctx).catch((e: unknown) => log.warn("embedders_vector_source_failed", { error: (e as Error).message.slice(0, 200) }));
  return g;
}

/**
 * Follows the vector source of every open row with a usable embedder: the source is in each vector, so a
 * process with an older settings copy stores its vectors under ITS source. A → B → A costs nothing only until the
 * backfill has replaced A's vectors; the backfill recomputes stale vectors only when the operator allowed
 * it (`retrieval.reembed.recompute_stale`, until acknowledged).
 * - The first sight writes the state. Vectors without a source (older ones) are ADOPTED as this connection's
 *   once and loudly — audit `admin` op `embedder_vectors_adopted` with the count, health line until acknowledged — only
 *   when the row has no labelled vector and generation 0; otherwise (a lost state row while labelled vectors exist, a
 *   raised generation) they are stale. It also remembers the model a legacy row is
 *   served with. A count that failed records nothing.
 * - A change — another address, model, space or generation — is audited (`admin` op `embedder_source_changed` with the
 *   number of vectors not of the new source) and kept for health; the stored vectors of the old source are no longer
 *   reused or searched.
 * - Event first, then state (two databases, no common transaction): a state without its event cannot happen; a crash
 *   between them, or two workers at once, can write the event twice — harmless.
 * The ids whose source changed.
 */
export async function followVectorSources(ctx: Pick<Ctx, "db" | "settings" | "instanceId" | "platform">): Promise<string[]> {
  const changed: string[] = [];
  // the one-shot lever is turned into the operator's word once per setting of it (its moment)
  // a word is withdrawn only while the STORED lever is off (`stored` null) — not by a process whose settings
  // copy is older than the operator's setting
  const stored = await leverWord(ctx), word = recomputeStaleOn(ctx.settings) ? stored : null;
  for (const row of (await readRows(ctx.db.control)).filter((r) => !r.closed_at)) {
    const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, row);
    if (st.state !== "ready") continue;
    const print = st.embedder.source;
    const key = vectorSourceKey(row.id);
    const before = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, key])).rows[0]?.value as Partial<VectorSourceState> | undefined;
    let next: VectorSourceState;
    const first = typeof before?.print !== "string";
    if (!first && before!.print === print) {
      if (word && before!.word_at !== word) await writeSourceState(ctx, key, await withWord(ctx, row.id, before as VectorSourceState, word));
      // the lever is off (turned off by the worker, or by hand) — a word that came from it is withdrawn
      else if (!stored && typeof before!.word_at === "string") await withdrawWord(ctx, row.id, key, before!.word_at);
      continue;
    }
    const at = new Date().toISOString();
    if (first) {
      // the vectors without a source are taken as this connection's ONCE and loudly — only
      // while the row has no labelled vector (a lost state row with labelled vectors is no first install) and generation 0
      // (the base knew a raised row's vectors to be of an old address). Otherwise they are stale. A count that failed
      // decides nothing: the row is looked at again on the next follow
      const n = await sourceCounts(ctx, row.id, print);
      if (!n) continue;
      // another look (a second slot, the backfill, another worker process) may have written the state while
      // this one counted — then a labelled vector stored after that state can be in this count, and deciding from it
      // would overwrite the adoption with «stale». A state that exists now stands; the next follow compares with it
      if (typeof (await readSourceState(ctx, key))?.print === "string") continue;
      if (!row.profile) await rememberEmbedderModel(ctx, row.id, st.embedder.profile.space.model);
      const adopt = n.unlabelled > 0 && n.labelled === 0 && Number(row.vector_generation) === 0;
      if (adopt) {
        next = { print, adopted: print, adopted_at: at, adopted_vectors: n.unlabelled };
        log.info("embedder_vectors_adopted", { embedder: row.id, vectors: n.unlabelled });
        await auditWorker(ctx as DbCtx, { event_type: "admin", details: { op: "embedder_vectors_adopted", id: row.id, vectors: n.unlabelled } });
      } else {
        const stale = n.unlabelled + n.other;
        next = { print, adopted: null, ...(stale ? { changed_at: at, stale } : {}) };
        if (stale) {
          changed.push(row.id);
          log.info("embedder_source_changed", { embedder: row.id, stale });
          await auditWorker(ctx as DbCtx, { event_type: "admin", details: { op: "embedder_source_changed", id: row.id, vectors: stale } });
        }
      }
    } else {
      // a word of the lever does not outlive it — with the lever off, A → B → A after a finished word
      // recomputes nothing without a new word
      const prev = !stored && typeof before!.word_at === "string" ? unworded(before as VectorSourceState) : before as VectorSourceState;
      const stale = await staleVectors(ctx, row.id, { source: print, legacy: nullVectorsCount(prev, print, ctx.settings) });
      next = { ...prev, print, adopted: prev.adopted ?? null, from: prev.print, changed_at: at, stale };
      changed.push(row.id);
      log.info("embedder_source_changed", { embedder: row.id, stale });
      await auditWorker(ctx as DbCtx, { event_type: "admin", details: { op: "embedder_source_changed", id: row.id, vectors: stale } });
    }
    if (word) next = await withWord(ctx, row.id, next, word);
    if (!first) { await writeSourceState(ctx, key, next); continue; }
    // the first sight never replaces a state (one compare-and-set statement: insert only while none exists).
    // Lost — another look wrote between the re-read above and here; it counted no vector stored after a state either,
    // so its decision is the same one, and its event is a harmless repeat
    if (!(await insertFirstSight(ctx, key, next))) {
      log.info("embedder_source_first_sight_lost", { embedder: row.id });
      const i = changed.indexOf(row.id);
      if (i >= 0) changed.splice(i, 1);
    }
  }
  return changed;
}

/** A state without the word of the lever (`recompute_for`, `word_at`). */
const unworded = (v: VectorSourceState): VectorSourceState => {
  const { recompute_for: _f, word_at: _w, ...rest } = v;
  return rest;
};

/**
 * The word of the lever leaves the row's state — one statement, only while the state still carries that
 * word (a new word or another write in between is kept). Logged; the audit has the turn-off (`embedder_recompute_done`)
 * or the operator's own write of the setting.
 */
async function withdrawWord(ctx: Pick<Ctx, "db" | "instanceId">, id: string, key: string, wordAt: string): Promise<void> {
  const r = await ctx.db.control.query(
    "UPDATE maintenance_state SET value = value - 'recompute_for' - 'word_at', updated_at = now() WHERE instance_id = $1 AND key = $2 AND value->>'word_at' = $3",
    [ctx.instanceId, key, wordAt]);
  if (r.rowCount) log.info("embedder_recompute_withdrawn", { embedder: id });
}

/** `adopted` becomes null — one statement, only while the state still carries that word over that source. */
async function endAdoption(ctx: Pick<Ctx, "db" | "instanceId">, id: string, key: string, wordAt: string, source: string): Promise<void> {
  const r = await ctx.db.control.query(
    `UPDATE maintenance_state SET value = jsonb_set(value, '{adopted}', 'null'::jsonb), updated_at = now()
      WHERE instance_id = $1 AND key = $2 AND value->>'word_at' = $3 AND value->>'adopted' = $4 AND value->>'print' = $4`,
    [ctx.instanceId, key, wordAt, source]);
  if (r.rowCount) log.info("embedder_adoption_recomputed", { embedder: id });
}

const readSourceState = async (ctx: Pick<Ctx, "db" | "instanceId">, key: string): Promise<Partial<VectorSourceState> | undefined> =>
  (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, key])).rows[0]?.value as Partial<VectorSourceState> | undefined;

/**
 * The first-sight state, written only if the row has none (a row without `print` — none written by this
 * module — counts as none). True — written.
 */
const insertFirstSight = async (ctx: Pick<Ctx, "db" | "instanceId">, key: string, value: VectorSourceState): Promise<boolean> => ((await ctx.db.control.query(
  `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
   ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE jsonb_typeof(maintenance_state.value->'print') IS DISTINCT FROM 'string'`,
  [ctx.instanceId, key, JSON.stringify(value)])).rowCount ?? 0) > 0;

const writeSourceState =(ctx: Pick<Ctx, "db" | "instanceId">, key: string, value: VectorSourceState) => ctx.db.control.query(
  `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
   ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, key, JSON.stringify(value)]);

/** The moment (text, as stored) of the setting `retrieval.reembed` while its lever `recompute_stale` is on, else null. */
async function leverWord(ctx: Pick<Ctx, "db" | "instanceId">): Promise<string | null> {
  return (await leverRow(ctx))?.at ?? null;
}
async function leverRow(ctx: Pick<Ctx, "db" | "instanceId">): Promise<{ at: string; value: Record<string, unknown> } | null> {
  const r = (await ctx.db.control.query(
    "SELECT value, updated_at::text AS at FROM settings WHERE instance_id = $1 AND category = 'retrieval' AND key = 'reembed'", [ctx.instanceId])).rows[0];
  return r && r.value && typeof r.value === "object" && r.value.recompute_stale === true ? { at: r.at as string, value: r.value as Record<string, unknown> } : null;
}

/**
 * The operator's word from the one-shot lever — the vectors of the row that are stale NOW (adopted ones
 * included) are to be recomputed: `recompute_for` = the row's source, `word_at` = the moment of the setting. With
 * something to recompute the row is «being rebuilt» (`changed_at`, `stale`): the search note and health say so.
 * Audit `admin` op `embedder_recompute_requested` with the count.
 */
async function withWord(ctx: Pick<Ctx, "db" | "instanceId" | "settings">, id: string, st: VectorSourceState, word: string): Promise<VectorSourceState> {
  const worded: VectorSourceState = { ...st, recompute_for: st.print, word_at: word };
  const stale = await staleVectors(ctx, id, { source: st.print, legacy: false });   // with the word no vector without a source counts
  log.info("embedder_recompute_requested", { embedder: id, stale });
  await auditWorker(ctx as DbCtx, { event_type: "admin", details: { op: "embedder_recompute_requested", id, vectors: stale, via: "retrieval.reembed.recompute_stale" } });
  return stale === 0 ? worded : { ...worded, changed_at: new Date().toISOString(), stale };
}

/**
 * What the backfill can still recompute of a row (embed-backfill.ts recomputable — its own selection): `stale`
 * — chunks it fills that carry a vector of the row and none of `source` (`legacy`: the NULL rule); `unlabelled` — the same
 * chunks that still carry a vector without a source. null — a database could not be counted.
 */
export type RecomputableLeft = (row: EmbedderRow, source: string, legacy: boolean) => Promise<{ stale: number; unlabelled: number } | null>;

/**
 * After a backfill run that left no work (embed-backfill.ts):
 * - a row whose adopted vectors without a source are all gone from what the backfill serves (recomputed, or their
 *   records re-indexed or purged) gets `adoption_ended_at` — the adoption line of health ends by itself;
 * - the lever `recompute_stale` turns itself off once every served row has the word of this setting and no
 *   vector of a worded row is stale any more — only the setting it came from (its moment), so a new setting by the
 *   operator in between is kept. Audit `admin` op `embedder_recompute_done` with the rows. A count that failed decides
 *   nothing (next run).
 * - «none left» is counted by `left` — over exactly what the backfill recomputes (live chunks of the active row
 *   and the candidate, of classes their connection may see, not parked). A vector it never touches (a hidden record or the
 *   hidden copy of a class move, a deleted record, an old version, a class the connection may not see, a parked chunk, a
 *   retained row) keeps neither the lever on nor the adoption line.
 * - with the lever off, the word it gave each row is withdrawn (`recompute_for`, `word_at`).
 * - A row whose word is finished over its adopted source loses the adoption (`adopted` null): a vector
 *   without a source left where the backfill does not reach is stale from then on, also when its record returns.
 */
export async function settleOperatorWords(ctx: Pick<Ctx, "db" | "settings" | "instanceId" | "platform">, left: RecomputableLeft): Promise<void> {
  const lever = recomputeStaleOn(ctx.settings) ? await leverRow(ctx) : null, word = lever?.at ?? null;
  let open = false;
  const worded: string[] = [];
  for (const row of (await readRows(ctx.db.control)).filter((r) => !r.closed_at)) {
    const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, row);
    if (st.state !== "ready") continue;
    const key = vectorSourceKey(row.id);
    const v = await readSourceState(ctx, key) as VectorSourceState | undefined;
    if (!v || typeof v.print !== "string") { open = true; continue; }
    const adopting = typeof v.adopted_at === "string" && v.adopted === v.print && !v.adoption_ended_at;
    const worded1 = !!word && v.word_at === word && v.recompute_for === v.print;
    if (!adopting && !word) continue;
    if (word && !worded1) { open = true; if (!adopting) continue; }
    const n = await left(row, v.print, nullVectorsCount(v, v.print, ctx.settings));
    if (adopting && n && n.unlabelled === 0) {
      log.info("embedder_adoption_ended", { embedder: row.id });
      await ctx.db.control.query(
        "UPDATE maintenance_state SET value = value || jsonb_build_object('adoption_ended_at', $3::text), updated_at = now() WHERE instance_id = $1 AND key = $2 AND jsonb_typeof(value->'print') = 'string'",
        [ctx.instanceId, key, new Date().toISOString()]);
    }
    if (!worded1) continue;
    if (!n || n.stale !== 0) { open = true; continue; }
    worded.push(row.id);
    // A finished word over the adopted source ends the adoption for good — the operator said those vectors
    // are to be recomputed; a left-over one the backfill never reached (a hidden or trashed record, an old version, a
    // parked chunk, a class not allowed) stays stale when its record comes back, and shows in the coverage count. Before
    // the turn-off, so a crash between them cannot bring the adoption back with the word gone
    if (v.adopted === v.print) await endAdoption(ctx, row.id, key, word!, v.print);
  }
  if (!lever || open) return;
  // only the setting the word came from (its moment): a new setting by the operator in between is kept
  const off = await ctx.db.control.query(
    "UPDATE settings SET value = $3::jsonb, updated_at = now(), updated_by = NULL WHERE instance_id = $1 AND category = 'retrieval' AND key = 'reembed' AND updated_at::text = $2",
    [ctx.instanceId, lever.at, JSON.stringify({ ...lever.value, recompute_stale: false })]);
  if (!off.rowCount) return;
  log.info("embedder_recompute_done", { embedders: worded });
  await auditWorker(ctx as DbCtx, { event_type: "admin", details: { op: "embedder_recompute_done", ids: worded, via: "retrieval.reembed.recompute_stale" } });
  // the word does not outlive the lever (a later return to this source recomputes nothing without a new word)
  for (const id of worded) await withdrawWord(ctx, id, vectorSourceKey(id), word!);
}

/** The model a legacy row's vectors were computed with (embedder_alias:<id>, written once; indexing.ts writes it too). */
async function rememberEmbedderModel(ctx: Pick<Ctx, "db" | "instanceId">, id: string, model: string): Promise<void> {
  if (!model) return;
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (instance_id, key) DO NOTHING`,
    [ctx.instanceId, `embedder_alias:${id}`, JSON.stringify({ model, at: new Date().toISOString(), adopted: true })]);
}

/**
 * The first look at a
 * row's vector source comes before the first vector any writer stores for it — a labelled vector stored before that
 * look would make the row's vectors from before the upgrade stale for ever (no adoption once `labelled > 0`). The ids of
 * `ids` that have no state are followed here (followVectorSources, the same look as at start and after every settings
 * reload); returned — the ids still without a state (a count or a read that failed): the caller stores no vector for
 * them now and waits.
 */
export async function unfollowedAfterLook(ctx: Pick<Ctx, "db" | "settings" | "instanceId" | "platform">, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const missing = async () => {
    const have = new Set((await ctx.db.control.query(
      "SELECT key FROM maintenance_state WHERE instance_id = $1 AND key = ANY($2::text[]) AND jsonb_typeof(value->'print') = 'string'",
      [ctx.instanceId, ids.map(vectorSourceKey)])).rows.map((r) => r.key as string));
    return new Set(ids.filter((id) => !have.has(vectorSourceKey(id))));
  };
  try {
    const before = await missing();
    if (!before.size) return before;
    await followVectorSources(ctx);
    return await missing();
  } catch (e) {
    log.warn("embedder_source_look_failed", { embedders: [...ids], code: (e as { code?: unknown } | null)?.code ?? null, error: String((e as Error)?.message ?? e).slice(0, 160) });
    return new Set(ids);
  }
}

/** Runs of this process one after another; a failure is a log line — the next settings reload tries again. */
let chain: Promise<unknown> = Promise.resolve();
export function scheduleReconcile(ctx: Pick<Ctx, "db" | "settings" | "instanceId" | "platform">): Promise<unknown> {
  chain = chain.catch(() => undefined).then(() => reconcileEmbedders(ctx))
    .catch((e) => log.warn("embedders_reconcile_failed", { error: (e as Error).message.slice(0, 200) }))
    .then(() => followVectorSources(ctx))
    .catch((e) => log.warn("embedders_vector_source_failed", { error: (e as Error).message.slice(0, 200) }));
  return chain;
}
