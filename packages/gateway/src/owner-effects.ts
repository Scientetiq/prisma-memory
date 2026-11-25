import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "@memory/shared";
import type { App } from "./context.ts";

interface Effects { active: boolean; pending: Array<() => Promise<unknown>> }
const committedEffects = new AsyncLocalStorage<Effects>();

/** true — the effect is queued after the commits; false — an ordinary single action, run it now. */
export function deferCommittedOwnerEffect(effect: () => Promise<unknown>): boolean {
  const context = committedEffects.getStore();
  if (!context?.active) return false;
  context.pending.push(effect);
  return true;
}

function effectsApp(app: App): App {
  const queue = new Proxy(app.queue, { get: (target, key) => {
    const value = Reflect.get(target, key);
    if (key === "kick" || key === "wake") return async (...args: unknown[]) => {
      // The job is fixed at queuing: the caller cannot change the payload before the transaction ends.
      const captured = structuredClone(args);
      if (deferCommittedOwnerEffect(() => Reflect.apply(value, target, captured))) return true;
      return Reflect.apply(value, target, captured);
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...app, queue };
}

/**
 * fn spans the records snapshot AND the outer control transaction of owner locks. Only a successful exit after both
 * COMMITs allows journaling the success and waking the worker; an error at any step drops these effects. Reads and
 * refusals are written by audit.ts at once. A nested boundary joins the outer one and sends nothing by itself.
 */
export async function withCommittedOwnerEffects<T>(app: App, fn: (effectsApp: App) => Promise<T>): Promise<T> {
  if (committedEffects.getStore()?.active) return fn(effectsApp(app));
  const context: Effects = { active: true, pending: [] };
  let out: T;
  try { out = await committedEffects.run(context, () => fn(effectsApp(app))); }
  catch (error) { context.active = false; context.pending.length = 0; throw error; }
  context.active = false;
  // As audit and JobQueue outside a plan: a failure of the outer journal/queue does not turn an applied action into an error.
  for (const effect of context.pending) {
    try { await effect(); }
    catch (error) { log.warn("owner_effect_failed", { error: String((error as Error)?.message ?? error).slice(0, 200) }); }
  }
  context.pending.length = 0;
  return out;
}
