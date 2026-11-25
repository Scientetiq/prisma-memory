// The search's reranker sends the title and the passage of every record of its pool to a model. Before
// the POST — the transport asks `beforeDispatch` after the budget guard, the host check and the class policy (modelGuard),
// with no await between it and fetch — the pool is judged by the record rule of the chat stages and the embeddings
// senders (`modelSourceHeld`, @memory/shared model-source.ts: live current row of its class, locator of this class, no class
// move in flight for it or a record above it). One record that may not go stops the whole call: nothing is sent, the
// search keeps the RRF order with its note. The refusal carries no record id and no text, and nothing is logged here.
// The query typed by the person is not a record: it goes with the call's class (rerankClassOf), the class policy judges it.
// An unlocked read, like the chat stages' check; a rerank result is never written.
import { modelSourceHeld, PlatformError, type BeforeModelDispatch, type ClassScope, type DataClass } from "@memory/shared";
import type { App } from "./context.ts";

/**
 * A record of the reranker's pool may not go to a model now: a policy refusal before anything was sent. Its kind stays
 * `policy_denied` (the search's note is the T1 gate's, with no cause); the trace and the audit name it `record_held`
 * (search.ts rerankFailureOf).
 */
export class RerankSourceHeld extends PlatformError {
  constructor() { super("policy_denied", "the reranker was not called: a record of the pool may not go to a model now"); this.name = "RerankSourceHeld"; }
}

/**
 * The rule could not read its rows (a lost connection, a time-out): nothing was sent and the model did nothing, so it is
 * not «model unreachable»: kind `aborted`, `fake` — no request was made.
 */
export class RerankSourceUnchecked extends PlatformError {
  constructor(cause: unknown) {
    super("aborted", "the reranker was not called: the records of the pool could not be checked before the send");
    this.name = "RerankSourceUnchecked";
    this.fake = true;
    (this as { cause?: unknown }).cause = cause;
  }
}

/** The check at the send of a rerank call over `pool` (records of the classes of `scope`). */
export function rerankFence(app: Pick<App, "db">, scope: ClassScope, pool: ReadonlyArray<{ rec: { id: string }; cls: DataClass }>): BeforeModelDispatch {
  return async () => {
    for (const cls of ["open", "closed"] as const) {
      const ids = [...new Set(pool.filter((s) => s.cls === cls).map((s) => s.rec.id))];
      if (!ids.length) continue;
      let held: Set<string>;
      try { held = await modelSourceHeld(app, app.db.records(cls, scope), cls, ids); }
      catch (e) { throw e instanceof PlatformError ? e : new RerankSourceUnchecked(e); }
      if (held.size) throw new RerankSourceHeld();
    }
    return async () => {};
  };
}
