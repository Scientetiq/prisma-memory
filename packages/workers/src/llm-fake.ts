import { log, PlatformError, testHooksEnabled, type ChatJsonResult, type FaultKind, type LlmFault, type Platform } from "@memory/shared";
import { llmStageStore, recordsDb, type DbCtx } from "./ctx.ts";

export const FAKE_TEXT_EN = "answer without a model (check)";
export const FAKE_MODEL = "fault-fake";

// Canned answers, one per schema of a model stage (a schema is named as the version of the stage's prompt). A stage whose
// schema has none gets no canned answer: fakeAnswer returns null.
const FAKE_DATA: Record<string, unknown> = {
  "summary-v2": { headline: FAKE_TEXT_EN, topics: [], decisions: [], actions: [], questions_risks: [], mentions: [], language: "en" },
  "events-v4": { events: [] },
  "describe-v2": { summary_line: FAKE_TEXT_EN, description: `${FAKE_TEXT_EN}: the document was not described`, doc_type: "other", domain_tags: [], keywords: [],
                   mentions: [], language: "en", document_date: null },
};

export function fakeAnswer(schemaName: string): ChatJsonResult<unknown> | null {
  const data = FAKE_DATA[schemaName];
  return data === undefined ? null : { data: structuredClone(data), servedModel: FAKE_MODEL, promptTokens: 0, completionTokens: 0, repaired: false, ms: 0 };
}

export function fakeError(kind: FaultKind): PlatformError {
  const e = kind === "busy" ? new PlatformError("busy", "gateway busy (429) — check run without a model", 429)
    : kind === "unavailable" ? new PlatformError("http", "gateway unavailable (503) — check run without a model", 503)
    : kind === "network" ? new PlatformError("http", "gateway unavailable: no connection — check run without a model")
    : kind === "timeout" ? new PlatformError("timeout", "the model did not respond in time — check run without a model")
    : kind === "http_500" ? new PlatformError("http", "gateway error 500 — check run without a model", 500)
    : kind === "http_401" ? new PlatformError("http", "gateway denied access (401) — check run without a model", 401)
    : Object.assign(new PlatformError("http", "no such model in the gateway (400) — check run without a model", 400), { modelMissing: true });
  e.fake = true;
  return e;
}

export interface FaultHit { fail: FaultKind | null; fakeOk: boolean; holdMs: number }

export function faultApplies(f: LlmFault, title: string, c: { busy_retries: number; slow_retries: number }, hooks = testHooksEnabled()): FaultHit | null {
  if (!f?.title_contains || !title.includes(f.title_contains)) return null;
  const kind: FaultKind = f.kind ?? "busy";
  const fail = f.busy ? kind : (f.busy_times ?? 0) > c.busy_retries + c.slow_retries ? kind : null;
  return { fail, fakeOk: hooks && f.fake_ok === true, holdMs: hooks ? Math.max(0, Math.min(60_000, f.hold_ms ?? 0)) : 0 };
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
});

async function probe(ctx: DbCtx, delta: 1 | -1): Promise<void> {
  if (delta > 0) await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value) VALUES ($1, 'llm_fault_probe', jsonb_build_object('active', 1, 'max', 1, 'calls', 1, 'since', now()))
     ON CONFLICT (instance_id, key) DO UPDATE SET updated_at = now(), value = maintenance_state.value || jsonb_build_object(
       'active', COALESCE((maintenance_state.value->>'active')::int, 0) + 1,
       'max', GREATEST(COALESCE((maintenance_state.value->>'max')::int, 0), COALESCE((maintenance_state.value->>'active')::int, 0) + 1),
       'calls', COALESCE((maintenance_state.value->>'calls')::int, 0) + 1)`, [ctx.instanceId]);
  else await ctx.db.control.query(
    `UPDATE maintenance_state SET updated_at = now(), value = value || jsonb_build_object('active', GREATEST(COALESCE((value->>'active')::int, 0) - 1, 0))
     WHERE instance_id = $1 AND key = 'llm_fault_probe'`, [ctx.instanceId]);
}

export function installLlmHooks(ctx: DbCtx & { platform: Platform }, o: { stub: boolean; testHooks: boolean }): void {
  let warned = false;
  // stub mode is "chat ready" with no model connection at all: the dispatcher runs the stages, chatJson resolves no
  // connection and no data policy, and every answer comes from this hook
  ctx.platform.stubChat = o.stub;
  ctx.platform.beforeChat = async ({ schemaName, slot }) => {
    const st = llmStageStore.getStore();
    if (st && st.slot === slot) {
      const f = ((await ctx.db.control.query("SELECT value FROM settings WHERE instance_id = $1 AND category = 'processing' AND key = 'llm_fault'", [ctx.instanceId])).rows[0]?.value ?? {}) as LlmFault;
      if (f.title_contains) {
        if (!o.testHooks && (f.fake_ok || f.hold_ms) && !warned) {
          warned = true;
          log.warn("llm_fault_test_only_ignored", { fake_ok: Boolean(f.fake_ok), hold_ms: f.hold_ms ?? 0 });
        }
        const title = String((await recordsDb(ctx, st.job.class).query("SELECT title FROM records WHERE id = $1", [st.job.record_id])).rows[0]?.title ?? "");
        const hit = faultApplies(f, title, st.counters, o.testHooks);
        if (hit && (hit.fail || hit.fakeOk || hit.holdMs)) {
          await probe(ctx, 1);
          try {
            if (hit.holdMs) await sleep(hit.holdMs, slot.signal);
            if (hit.fail) throw fakeError(hit.fail);
            const a = hit.fakeOk ? fakeAnswer(schemaName) : null;
            if (a) return a;
          } finally { await probe(ctx, -1).catch(() => undefined); }
        }
      }
    }
    if (!o.stub) return null;
    const a = fakeAnswer(schemaName);
    if (a) return a;
    throw Object.assign(new PlatformError("bad_response", `the model is switched off (stub), and there is no canned response for schema ${schemaName}`), { fake: true });
  };
}
