// The workers' process wiring that logs a failure: the general timer `every` and the catch
// handler of the one-shot calls of the entry (queue errors, the first backfill, the first archive pass). They live here and
// not in src/index.ts, which starts the whole worker and cannot be imported: a test runs these as the worker runs them.
// A failure line carries the event and a class of failure.ts — never the error's message, name, code, cause or stack.
import { failureClass } from "@memory/connectors";
import { log } from "@memory/shared";

/** How a timer is scheduled: setInterval of the process, or a test's capture. */
export type Schedule = (cb: () => void, ms: number) => unknown;
export type Every = (ms: number, name: string, fn: () => Promise<unknown>) => unknown;

/** The catch handler of a failure line: a warning `event` with the class of failure.ts and nothing of the error. */
export const failureLine = (event: string) => (e: unknown): void => { log.warn(event, { error: failureClass(e) }); };

/** The general timer: `fn` every `ms`; a run that fails is the failure line `<name>_failed`. */
export const timerEvery = (schedule: Schedule = setInterval): Every =>
  (ms, name, fn) => schedule(() => void fn().catch(failureLine(`${name}_failed`)), ms);
