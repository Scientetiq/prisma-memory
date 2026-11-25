// Registry of embedders: who is "the embeddings connection", what the worker registers, and what a settings save may
// change. Pure decisions here — the worker (jobs/embedders.ts) and the
// gateway (admin.ts) feed them the facts and carry the result out.
//
// Two fixed connection slots: a = models.embeddings_*, b = models.embeddings_b_*. A registry row names its slot. The
// slot of the active row is frozen while it has vectors; the next model goes into the other slot and becomes a
// candidate (the backfill fills and switches it). A cancelled candidate or a purged old model keeps its row with closed_at
// set — a tombstone: the settings of a slot outlive the row, and without it the worker would bring the same model back
// at the next settings reload.
import { canonicalProfileJson, embedderId, rowProfile, type EmbedderOps, type EmbedderProfile, type EmbedderRow } from "./profile.ts";
import { draftProfile, finishProfile, spaceMatches, type EmbedderDraft } from "./presets.ts";
import { resolveConnection } from "../connection.ts";
import type { ConnectionState, ModelConnection } from "../types.ts";
import type { ProbeResult } from "./probe.ts";
import type { DataClass } from "../../db.ts";
import type { RebuildPhase, Tx } from "../../rebuild.ts";

export type EmbeddingSlot = "a" | "b";
type SettingsView = { get<T>(path: string, fallback: T): T; str(path: string): string | null };

/** Key prefix of a slot. */
export const slotPrefix = (slot: EmbeddingSlot): string => (slot === "b" ? "models.embeddings_b_" : "models.embeddings_");
export const otherSlot = (slot: EmbeddingSlot): EmbeddingSlot => (slot === "a" ? "b" : "a");
export const EMBEDDINGS_CONNECTION_FIELDS = ["provider", "base_url", "api_key", "model", "params"] as const;
/** The ten embeddings connection keys (connection.ts reads them). */
export const EMBEDDINGS_CONNECTION_KEYS: readonly string[] = (["a", "b"] as const).flatMap((s) => EMBEDDINGS_CONNECTION_FIELDS.map((f) => `${slotPrefix(s)}${f}`));

/** The connection a slot resolves to (the rules of connection.ts; slot b never falls back to the legacy keys). */
export const slotConnection = (settings: SettingsView, slot: EmbeddingSlot): ConnectionState =>
  resolveConnection(settings, "embeddings", slot === "b" ? { slot: "b" } : {});

/** Row state as the panel and the notes name it. */
export function rowState(r: Pick<EmbedderRow, "active" | "candidate" | "retire_at" | "closed_at">): "active" | "candidate" | "retained" | "closed" | "idle" {
  return r.active ? "active" : r.candidate ? "candidate" : r.closed_at ? "closed" : r.retire_at ? "retained" : "idle";
}

/** The settings without the own keys of both slots: what a legacy row reads (the gateway keys only). */
function gatewayOnly(settings: SettingsView): SettingsView {
  const own = (k: string) => k.startsWith("models.embeddings_");
  return {
    get: <T>(k: string, d: T): T => (own(k) ? d : settings.get<T>(k, d)),
    str: (k: string) => (own(k) ? null : settings.str(k)),
  };
}

/** The live connection of the active row: the model connection state, or `mismatch` — the slot now names another space than the row. */
export type ActiveConnectionState = ConnectionState | { state: "mismatch"; detail: string };

/**
 * The live embeddings connection: the slot of the active row, with the profile that row is served with. null — no
 * active embedder (keyword-only search). The model health check, the probe button and usage attribution call this, not
 * resolveConnection("embeddings"): after a switch the active embedder lives in slot b.
 *  - a legacy row (profile NULL) is served by the gateway connection only — the slot's own keys never reach its vectors;
 *  - a profile row whose slot resolves to another space (another model, provider or profile than the row) has no live
 *    connection (`mismatch`): its vectors are never queried through a connection that would give other numbers.
 */
export async function activeEmbeddingsConnection(control: { query(sql: string, args?: unknown[]): Promise<{ rows: any[] }> }, settings: SettingsView):
    Promise<{ row: EmbedderRow; slot: EmbeddingSlot; profile: EmbedderProfile; connection: ActiveConnectionState } | null> {
  const row = (await control.query(
    "SELECT id, model, dims, query_instruction, max_tokens, profile, connection_slot, active, candidate, retire_at, closed_at, vector_generation FROM embedders WHERE active")).rows[0] as EmbedderRow | undefined;
  if (!row) return null;
  const slot: EmbeddingSlot = row.connection_slot === "b" ? "b" : "a";
  return { row, slot, profile: rowProfile(row, settings), connection: rowConnection(settings, row) };
}

/**
 * The live connection of one registry row (the row → connection part of activeEmbeddingsConnection, shared with
 * the embeddings facade `embedderFor`): a legacy row — the gateway connection only; a profile row — its slot, or
 * `mismatch` when the slot now resolves to another space than the row.
 */
export function rowConnection(settings: SettingsView, row: Pick<EmbedderRow, "id" | "profile" | "connection_slot">): ActiveConnectionState {
  const slot: EmbeddingSlot = row.connection_slot === "b" ? "b" : "a";
  if (!row.profile) return resolveConnection(gatewayOnly(settings), "embeddings");
  const state = slotConnection(settings, slot);
  if (state.state === "ready") {
    const d = draftProfile(state.connection);
    if (!d.draft || !spaceMatches(d.draft, row.profile.space))
      return { state: "mismatch", detail: `${connectionName(slot, "current")} names another model or profile than ${row.id}` };
  }
  return state;
}

/** How notes, health and the panel name a slot: by its role and its keys, never "slot a" / "slot b". */
export const connectionName = (slot: EmbeddingSlot, role: "current" | "next"): string => `${role}-model connection (${slotPrefix(slot)}*)`;

// ---------------------------------------------------------------- reconcile

export interface ReconcileFacts {
  rows: readonly EmbedderRow[];
  slots: Readonly<Record<EmbeddingSlot, ConnectionState>>;
  /** Whether the active row has vectors in either records database — given once a step asked for it. */
  activeHasVectors?: boolean;
  /** Probe answers of this run, by slot. */
  probes?: Partial<Record<EmbeddingSlot, ProbeResult>>;
}

export type ReconcileStep =
  | { do: "nothing" }
  | { do: "ask_vectors" }
  | { do: "probe"; slot: EmbeddingSlot; connection: ModelConnection; draft: EmbedderDraft }
  /** Insert a new row; `close` — ids that become tombstones in the same transaction (the active row it replaces). */
  | { do: "register"; slot: EmbeddingSlot; as: "active" | "candidate"; id: string; profile: EmbedderProfile; close: string[] }
  | { do: "cancel"; id: string; reason: string }
  | { do: "update_ops"; id: string; ops: EmbedderOps };

export interface ReconcilePlan { step: ReconcileStep; notes: string[] }

/** The usable connection of a slot for a new row: slot b always, slot a only through its own role keys when `own`. */
function usable(state: ConnectionState, own: boolean): ModelConnection | null {
  if (state.state !== "ready") return null;
  return own && state.connection.legacy ? null : state.connection;
}

/** A row with a profile whose space belongs to the draft. */
const matching = (rows: readonly EmbedderRow[], d: EmbedderDraft) => rows.find((r) => r.profile && spaceMatches(d, r.profile.space));

/**
 * Registration of a slot's connection: the probe first (once per run), then the final profile. Problems become notes.
 */
function registerFrom(f: ReconcileFacts, slot: EmbeddingSlot, c: ModelConnection, d: EmbedderDraft, as: "active" | "candidate", close: string[], notes: string[]): ReconcileStep {
  const name = connectionName(slot, as === "active" ? "current" : "next");
  const probe = f.probes?.[slot];
  if (!probe) return { do: "probe", slot, connection: c, draft: d };
  if (!probe.ok) { notes.push(`${name}: the probe of ${c.model} failed: ${probe.error ?? "no answer"}`); return { do: "nothing" }; }
  const fin = finishProfile(d, probe.dims);
  if (!fin.profile) { notes.push(`${name}: ${fin.problems.join("; ")}`); return { do: "nothing" }; }
  const id = embedderIdOf(fin.profile);
  if (f.rows.some((r) => r.id === id)) { notes.push(`${name}: ${id} is already in the registry`); return { do: "nothing" }; }
  return { do: "register", slot, as, id, profile: fin.profile, close };
}

const embedderIdOf = (p: EmbedderProfile): string => embedderId(p.space);

/**
 * The next step of the registration, from the registry rows and the two slots. The worker applies a step,
 * reads the facts again and asks for the next one, until "nothing". Rules:
 *  - no active row, slot a resolves (its own keys or the legacy ones) → probe, register active;
 *  - every profile can become the active row: the embeddings facade serves it with the row's own connection;
 *  - an active legacy row (profile NULL) with nothing set in its slot's own keys → left alone: no row, no model call;
 *  - the active slot names another model: refused at save while vectors exist; here — a note, the row stays;
 *    without vectors the row is replaced (a fresh install fixing its first model before any document); a space the
 *    registry already holds in any state is never probed again and never replaces the row (A → B → A stays at B);
 *  - the other slot resolves through its own keys to a space not in the registry in any state → the new candidate
 *    (an earlier candidate of another space is cancelled first); a registered space — nothing (a tombstone is final
 *    until the explicit "start" or another profile); the other slot empty → the candidate is cancelled;
 *  - other rows (neither active, candidate, retained nor closed — the old unused seed row) are ignored.
 */
export function planReconcile(f: ReconcileFacts): ReconcilePlan {
  const notes: string[] = [];
  const active = f.rows.find((r) => r.active), cand = f.rows.find((r) => r.candidate);
  if (!active) {
    const name = connectionName("a", "current");
    const c = usable(f.slots.a, false);
    if (!c) { notes.push("keyword-only: no embedding model configured"); return { step: { do: "nothing" }, notes }; }
    const d = draftProfile(c);
    if (!d.draft) { notes.push(`${name}: ${d.problems.join("; ")}`); return { step: { do: "nothing" }, notes }; }
    const m = matching(f.rows, d.draft);
    if (m) {
      // with no row active search is keyword-only, so the note says how vector search comes back
      const back = rowState(m) === "closed" ? "; search stays keyword-only — a closed model comes back only with another profile, such as a new space_tag in models.embeddings_params" : "";
      notes.push(`${name}: ${m.id} is ${rowState(m)} and is not made active again by a settings reload${back}`);
      return { step: { do: "nothing" }, notes };
    }
    return { step: registerFrom(f, "a", c, d.draft, "active", [], notes), notes };
  }
  const slot: EmbeddingSlot = active.connection_slot === "b" ? "b" : "a";
  const name = connectionName(slot, "current");
  // the active slot
  const state = f.slots[slot];
  if (active.profile && state.state === "off" && state.reason === "disabled")
    notes.push(`${name} is switched off (provider none); ${active.id} stays the search model until the connection is chosen again or another model replaces it`);
  const own = usable(state, active.profile === null);
  if (own) {
    const d = draftProfile(own);
    if (!d.draft) notes.push(`${name}: ${d.problems.join("; ")}`);
    else if (active.profile && spaceMatches(d.draft, active.profile.space)) {
      if (canonicalProfileJson(d.draft.ops) !== canonicalProfileJson(active.profile.ops)) return { step: { do: "update_ops", id: active.id, ops: d.draft.ops }, notes };
    } else {
      // a space the registry already holds (a closed one too) is decided without the model: never probed again
      const m = matching(f.rows, d.draft);
      if (m) notes.push(`${name}: ${own.model} is ${m.id}, which is ${rowState(m)}; ${active.id} stays the search model (a closed model comes back only with another profile, such as a new space_tag in params)`);
      else if (f.activeHasVectors === undefined) return { step: { do: "ask_vectors" }, notes };
      else if (f.activeHasVectors) notes.push(`${name} names another model than ${active.id}; it is not used while ${active.id} has vectors`);
      else {
        const step = registerFrom(f, slot, own, d.draft, "active", [active.id], notes);
        if (step.do !== "nothing") return { step, notes };
      }
    }
  }
  // the other slot
  const other = otherSlot(slot);
  const nextName = connectionName(other, "next");
  const next = usable(f.slots[other], true);
  if (!next) {
    // the other slot empty: only a slot that names no model of its own is empty and cancels the
    // candidate (whose paid vectors the backfill then purges). A switched-off provider, a cleared key or a refused value
    // keep it — the backfill shows the stop `config` until the slot is fixed or emptied.
    const st = f.slots[other];
    const empty = (st.state === "off" && st.reason === "not_configured" && st.missing.some((k) => k.endsWith("_model")))
      || (st.state === "ready" && st.connection.legacy);
    if (cand && empty) return { step: { do: "cancel", id: cand.id, reason: "the next-model connection is empty" }, notes };
    if (cand) notes.push(`${nextName} is not usable now; ${cand.id} is kept until the connection is fixed or emptied`);
    return { step: { do: "nothing" }, notes };
  }
  const d = draftProfile(next);
  if (!d.draft) { notes.push(`${nextName}: ${d.problems.join("; ")}`); return { step: { do: "nothing" }, notes }; }
  const m = matching(f.rows, d.draft);
  if (m) {
    if (m === cand && m.profile && canonicalProfileJson(d.draft.ops) !== canonicalProfileJson(m.profile.ops)) return { step: { do: "update_ops", id: m.id, ops: d.draft.ops }, notes };
    return { step: { do: "nothing" }, notes };
  }
  if (cand) return { step: { do: "cancel", id: cand.id, reason: "the next-model connection names another model" }, notes };
  return { step: registerFrom(f, other, next, d.draft, "candidate", [], notes), notes };
}

// ---------------------------------------------------------------- the frozen slot of the current model

/**
 * May this settings save change the slot of the active embedder? While the active row has vectors, the provider, model
 * and params of its slot may change only so far as the profile stays the same space (another batch size — yes, another
 * model — no); for a legacy row any change of provider, model, params or base address is refused (its wire profile is
 * today's). Address and key of a profile row's slot stay editable: key rotation, a moved server.
 * Returns the refused key and the message, or null.
 */
export function embeddingsSlotChangeProblem(o: {
  active: Pick<EmbedderRow, "id" | "dims" | "profile" | "connection_slot" | "query_instruction" | "max_tokens"> | null;
  hasVectors: boolean; before: SettingsView; after: SettingsView;
}): { key: string; message: string } | null {
  if (!o.active || !o.hasVectors) return null;
  const slot: EmbeddingSlot = o.active.connection_slot === "b" ? "b" : "a";
  const p = slotPrefix(slot), next = slotPrefix(otherSlot(slot));
  const fields = o.active.profile ? ["provider", "model", "params"] : ["provider", "model", "params", "base_url"];
  const read = (s: SettingsView, k: string) => canonicalProfileJson(k.endsWith("_params") ? s.get<unknown>(k, {}) ?? {} : s.str(k) ?? "");
  const changed = fields.map((f) => `${p}${f}`).filter((k) => read(o.before, k) !== read(o.after, k));
  if (!changed.length) return null;
  const message = (key: string) => `${key}: this connection serves the current search model (${o.active!.id}) and its stored vectors, so its model, provider `
    + `and profile do not change while vectors exist. Put the new model into the next-model connection (${next}provider, ${next}base_url, `
    + `${next}api_key, ${next}model, ${next}params): it gets vectors of its own before search uses it. `
    + (o.active!.profile ? "The address and the key of this connection can still be changed." : "The key of this connection can still be changed.");
  if (!o.active.profile) return { key: changed[0]!, message: message(changed[0]!) };
  const state = slotConnection(o.after, slot);
  if (state.state !== "ready") return { key: changed[0]!, message: message(changed[0]!) };
  const d = draftProfile(state.connection);
  if (!d.draft || !spaceMatches(d.draft, o.active.profile.space)) return { key: changed[0]!, message: message(changed[0]!) };
  return null;
}

// ---------------------------------------------------------------- moves of a re-embedding
//
// Each move is ONE transaction in memory_control: `tx` is a control client inside BEGIN; the first statement is the
// advisory lock of the registry (the same lock as the reconcile of jobs/embedders.ts, so registration, cancel, switch,
// rollback and the purge start serialise), then the rows that take part are read FOR UPDATE. The caller commits. No lock
// spans two databases: coverage is read from the records databases inside the lock, and what a writer adds between that
// read and the commit is left to the permanent sweep (write-time targeting).

/** Advisory lock of the embedder registry in memory_control (hashtext of this text); jobs/embedders.ts re-exports it. */
export const EMBEDDERS_LOCK = "memory_embedders_reconcile";

/** Coverage of one row in one records database: live chunks, chunks with its vector, parked chunks, its index. */
/** `stale` — chunks whose only vector of the row is of another source and that the backfill may not recompute now. */
export interface Coverage { class: DataClass; allowed: boolean; chunks: number; have: number; parked: number; indexValid: boolean; stale?: number }
/**
 * What the moves need from outside: the coverage of a row (records databases) and whether the data policy lets its
 * connection see a class (`embedderFor(…).embedder.allows`; an `off` row allows nothing). `offReason` — why the row has
 * no usable connection now (null — it has one): a rollback to a row whose connection no longer gives its space is
 * refused (`mismatch`).
 * `uncovered(from, to, cls, fromAllowed)` — live chunks of a class that `from` serves and `to` has no vector for: with
 * `fromAllowed` every live chunk `to` lacks, else only those `from` HAS a vector for. What a model serves is never read
 * from its connection alone: a connection switched off, removed, misconfigured or narrowed by the policy after the
 * vectors were written keeps the classes its vectors cover ("off" never means "saw nothing").
 * `to = null` — a model that may not embed the class now: none of its vectors there counts (it cannot embed the query
 * that would search them), so every chunk `from` serves is uncovered.
 */
export interface RegistryDeps {
  coverage(row: EmbedderRow): Promise<Coverage[]>;
  allows(row: EmbedderRow, cls: DataClass): boolean;
  /** Required: a caller that cannot say why a row is off would roll back to a row that serves another space. */
  offReason(row: EmbedderRow): "disabled" | "not_configured" | "mismatch" | null;
  uncovered(from: EmbedderRow, to: EmbedderRow | null, cls: DataClass, fromAllowed: boolean): Promise<number>;
}

/**
 * The confirmation that a switch may leave chunks keyword-only (maintenance_state `embed_confirmed:<previous active id>`,
 * written by the confirmed switch in its own transaction): the purge of that retained model goes ahead only with it when
 * the new model lacks vectors the old one has. Not a phase: losing the row holds the purge (the safe side).
 */
export const embedConfirmedKey = (fromId: string): string => `embed_confirmed:${fromId}`;
export interface EmbedConfirmation { to: string; not_included: number; parked: number; classes: DataClass[]; at: string }

/**
 * What moving search from `from` to `to` would narrow, by the coverage of `to`: the classes `to` may not see that `from`
 * serves — by its policy now or by its vectors, whatever its connection says — with `not_included` every live chunk
 * of them that `from` serves (keyword-only from the switch on; new records of those classes stay keyword-only too), and
 * the parked chunks of the classes `to` sees. Coverage is what `to` may serve NOW, never the rows that exist: vectors
 * `to` wrote before its permission for a class was revoked do not cover that class.
 */
export async function narrowing(deps: RegistryDeps, from: EmbedderRow | null, to: EmbedderRow, cov: readonly Coverage[]): Promise<{ not_included: number; parked: number; classes: DataClass[] }> {
  let notIncluded = 0, parked = 0;
  const classes: DataClass[] = [];
  for (const c of cov) {
    if (c.allowed) { parked += c.parked; continue; }
    if (!from) continue;
    const fromAllowed = deps.allows(from, c.class);
    const n = await deps.uncovered(from, null, c.class, fromAllowed);
    if (fromAllowed || n > 0) { notIncluded += n; classes.push(c.class); }
  }
  return { not_included: notIncluded, parked, classes };
}

export type MoveResult = { ok: true; from: string | null; to: string | null }
  | { ok: false; why: "no_candidate" | "coverage" | "index" | "policy" | "not_included" | "busy_candidate" | "retired" | "mismatch"; detail: string };

const MOVE_COLUMNS = "id, model, dims, query_instruction, max_tokens, profile, connection_slot, active, candidate, retire_at, closed_at, activated_at, vector_generation";
const refuse = (why: Extract<MoveResult, { ok: false }>["why"], detail: string): MoveResult => ({ ok: false, why, detail });

/** The lock, then the rows that take part in a move, FOR UPDATE. */
async function lockRows(tx: Tx): Promise<{ rows: EmbedderRow[]; active: EmbedderRow | null; candidate: EmbedderRow | null; now: Date }> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [EMBEDDERS_LOCK]);
  const rows = (await tx.query(`SELECT ${MOVE_COLUMNS} FROM embedders WHERE active OR candidate OR retire_at IS NOT NULL ORDER BY id FOR UPDATE`)).rows as EmbedderRow[];
  const now = new Date((await tx.query("SELECT now() AS now")).rows[0].now);
  return { rows, active: rows.find((r) => r.active) ?? null, candidate: rows.find((r) => r.candidate) ?? null, now };
}

const time = (v: string | Date | null): number => (v === null ? NaN : new Date(v).getTime());
/** A retained row: the previous active model, kept until its retire_at, not closed. */
const isRetained = (r: EmbedderRow, now: Date): boolean => !r.active && !r.candidate && r.closed_at === null && r.retire_at !== null && time(r.retire_at) > now.getTime();

/**
 * Explicit start: a closed or retained row becomes the candidate again (its vectors are filled by the backfill job; a
 * closed row whose vectors were purged starts from nothing). `busy_candidate` while another candidate exists.
 */
export async function startCandidate(tx: Tx, id: string): Promise<MoveResult> {
  const { active, candidate } = await lockRows(tx);
  if (candidate) return candidate.id === id ? { ok: true, from: active?.id ?? null, to: id } : refuse("busy_candidate", `${candidate.id} is being prepared; cancel it first`);
  const row = (await tx.query(`SELECT ${MOVE_COLUMNS} FROM embedders WHERE id = $1 FOR UPDATE`, [id])).rows[0] as EmbedderRow | undefined;
  if (!row) return refuse("no_candidate", `${id} is not in the registry`);
  if (row.active) return refuse("no_candidate", `${id} is the current search model`);
  if (row.closed_at === null && row.retire_at === null) return refuse("no_candidate", `${id} is neither retained nor closed`);
  await tx.query("UPDATE embedders SET candidate = true, closed_at = NULL, retire_at = NULL WHERE id = $1", [id]);
  return { ok: true, from: active?.id ?? null, to: id };
}

/** Why the coverage of a candidate does not allow a switch (null — it does), for every class it may see. */
function coverageProblem(cov: readonly Coverage[], id: string): Extract<MoveResult, { ok: false }> | null {
  const allowed = cov.filter((c) => c.allowed);
  if (!allowed.length) return { ok: false, why: "policy", detail: `the data policy lets ${id} see no class of records` };
  for (const c of allowed) if (!c.indexValid) return { ok: false, why: "index", detail: `the vector index of ${id} is missing or invalid in the ${c.class} records database` };
  for (const c of allowed) {
    const left = c.chunks - c.have - c.parked;
    if (left > 0) return { ok: false, why: "coverage", detail: `${left} of ${c.chunks} chunks of the ${c.class} records database have no vector of ${id} yet` };
  }
  return null;
}


/**
 * The switch, exactly: inside the lock the coverage of the candidate is read again; refused unless,
 * for every class it may see, every live chunk has its vector or is parked, its index is valid, and it may see at least
 * one class; when it would leave chunks without a vector of the new model that the active row serves — by its policy
 * or by its vectors, whatever its connection says now (`narrowing`) — or chunks are parked, only with
 * `confirmNotIncluded` (and `instanceId`: the confirmation is written in this transaction, `embedConfirmedKey`, and lets
 * the purge of the old model go ahead later). Then the old active row is retained for `retainDays` and the candidate
 * becomes active (in this order: the unique index of the one active row is not deferrable). No setting is written and
 * no key is copied.
 */
export async function switchEmbedder(tx: Tx, deps: RegistryDeps, o: { retainDays: number; confirmNotIncluded?: boolean; instanceId?: string }): Promise<MoveResult & { not_included?: number; parked?: number }> {
  const { active, candidate } = await lockRows(tx);
  if (!candidate) return refuse("no_candidate", "no next model is being prepared");
  const cov = await deps.coverage(candidate);
  const problem = coverageProblem(cov, candidate.id);
  if (problem) return problem;
  const lost = await narrowing(deps, active, candidate, cov);
  const narrows = lost.classes.length > 0 || lost.parked > 0;
  if (narrows && o.confirmNotIncluded !== true)
    return refuse("not_included", `after the switch ${lost.not_included + lost.parked} chunks are found by keyword only`
      + ` (${lost.not_included} of classes ${candidate.id} may not see, ${lost.parked} parked)`
      + `${lost.classes.length ? `, and new records of the ${lost.classes.join(" and ")} class too` : ""}: confirm to switch`);
  if (narrows && active && !o.instanceId)
    return refuse("not_included", "a switch that leaves chunks keyword-only is confirmed with the instance it belongs to (instanceId)");
  const days = Number.isFinite(o.retainDays) && o.retainDays >= 0 ? o.retainDays : 7;
  await tx.query("UPDATE embedders SET active = false, retire_at = now() + make_interval(days => $1::int) WHERE active", [Math.floor(days)]);
  await tx.query("UPDATE embedders SET active = true, candidate = false, activated_at = now(), retire_at = NULL WHERE id = $1", [candidate.id]);
  if (narrows && active) {
    const conf: EmbedConfirmation = { to: candidate.id, not_included: lost.not_included, parked: lost.parked, classes: lost.classes, at: new Date().toISOString() };
    await tx.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [o.instanceId, embedConfirmedKey(active.id), JSON.stringify(conf)]);
  }
  return { ok: true, from: active?.id ?? null, to: candidate.id, not_included: lost.not_included, parked: lost.parked };
}

/**
 * Rollback until the old model is purged: the retained row becomes the candidate again (retire_at cleared), the active
 * row does not change; the backfill fills what was written since, then the same switch — never a bare flip back.
 * `busy_candidate` while a candidate exists, `retired` once its retention ended (the purge may have started),
 * `mismatch` when its connection no longer gives its space.
 */
export async function rollbackEmbedder(tx: Tx, deps: RegistryDeps): Promise<MoveResult> {
  const { rows, active, candidate, now } = await lockRows(tx);
  if (candidate) return refuse("busy_candidate", `${candidate.id} is being prepared; cancel it first`);
  const kept = rows.filter((r) => isRetained(r, now)).sort((a, b) => time(b.retire_at) - time(a.retire_at))[0];
  if (!kept) {
    const gone = rows.some((r) => !r.active && !r.candidate);
    return gone ? refuse("retired", "the previous model's retention has ended: it is being purged or was purged; a change back is a new change with a full backfill")
      : refuse("no_candidate", "there is no previous model to go back to");
  }
  const off = deps.offReason(kept);
  if (off) return refuse("mismatch", `the connection of ${kept.id} no longer serves it (${off}): put its model back into that connection first`);
  await tx.query("UPDATE embedders SET candidate = true, retire_at = NULL WHERE id = $1", [kept.id]);
  return { ok: true, from: active?.id ?? null, to: kept.id };
}

/** Cancel the candidate: it becomes a tombstone (closed_at); its vectors are purged by the backfill job. */
export async function cancelCandidate(tx: Tx, reason: string): Promise<MoveResult> {
  const { active, candidate } = await lockRows(tx);
  if (!candidate) return refuse("no_candidate", "no next model is being prepared");
  await tx.query("UPDATE embedders SET candidate = false, closed_at = now() WHERE id = $1 AND candidate", [candidate.id]);
  void reason;
  return { ok: true, from: active?.id ?? null, to: candidate.id };
}

/**
 * The phase of the re-embedding, derived (never stored): a candidate without any vector — prepared, with every live
 * chunk of its classes covered — ready, else filling; no candidate and a retained row — switched; else idle. `retiring`
 * (closed rows with vectors left) needs the records databases and is said by the backfill job's progress.
 */
export function embedPhase(rows: readonly EmbedderRow[], coverage: readonly Coverage[], now: Date = new Date()): RebuildPhase {
  if (rows.some((r) => r.candidate)) {
    const allowed = coverage.filter((c) => c.allowed);
    if (allowed.length && allowed.every((c) => c.have + c.parked >= c.chunks && c.indexValid)) return "ready";
    return allowed.some((c) => c.have > 0) ? "filling" : "prepared";
  }
  return rows.some((r) => isRetained(r, now)) ? "switched" : "idle";
}

/** The re-embedding at a glance (health, the admin page, tests): rows, the candidate's coverage, the phase. */
export async function embedderStatus(control: Tx, deps: RegistryDeps): Promise<{ active: EmbedderRow | null; candidate: EmbedderRow | null; retained: EmbedderRow[]; coverage: Coverage[]; phase: RebuildPhase }> {
  const rows = (await control.query(`SELECT ${MOVE_COLUMNS} FROM embedders WHERE active OR candidate OR retire_at IS NOT NULL ORDER BY id`)).rows as EmbedderRow[];
  const now = new Date((await control.query("SELECT now() AS now")).rows[0].now);
  const candidate = rows.find((r) => r.candidate) ?? null;
  const coverage = candidate ? await deps.coverage(candidate) : [];
  return { active: rows.find((r) => r.active) ?? null, candidate, retained: rows.filter((r) => isRetained(r, now)), coverage, phase: embedPhase(rows, coverage, now) };
}
