import { Hono } from "hono";
import { testHooksEnabled } from "@memory/shared";

export const CLOCK_MAX_OFFSET_MS = 7 * 86_400_000;
let offsetMs = 0;

export function adminNow(): Date {
  return new Date(Date.now() + (testHooksEnabled() ? offsetMs : 0));
}

export function setClockOffset(ms: number): void {
  if (!testHooksEnabled()) throw new Error("the test clock requires MEMORY_TEST_HOOKS=1");
  if (!Number.isInteger(ms) || ms < 0 || ms > CLOCK_MAX_OFFSET_MS) throw new RangeError(`offset_ms must be an integer from 0 to ${CLOCK_MAX_OFFSET_MS}`);
  offsetMs = ms;
}

export const clockOffsetMs = (): number => (testHooksEnabled() ? offsetMs : 0);

export function testClockRoutes(): Hono {
  const r = new Hono();
  r.post("/api/v1/admin/internal/clock", async (c) => {
    const body = await c.req.json<{ offset_ms?: unknown }>().catch(() => ({} as { offset_ms?: unknown }));
    try { setClockOffset(Number(body.offset_ms)); }
    catch (e) { return c.json({ code: "invalid_argument", message: (e as Error).message }, 400); }
    return c.json({ offset_ms: clockOffsetMs() });
  });
  return r;
}
