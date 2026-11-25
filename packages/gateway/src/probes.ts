// Liveness and readiness probes for container orchestration.
//
// GET /livez answers 200 while the process can serve HTTP at all: the handler loads no settings and opens no database
// connection (the channel gate before it works on the settings already in memory), so a gateway that is not configured
// yet, or whose database is down, is still "alive" — a container healthcheck on it does not restart a process that only
// waits for its configuration.
// GET /readyz answers 200 unless the health state is fail_closed (the gateway refuses to serve memory), then 503; a
// health computation that throws (the control pool is exhausted, the settings cannot be loaded) is "not ready" as well.
// Neither probe reads a key or returns details: the body is only { status }. /api/v1/health is unchanged.
//
// Both are mounted in http.ts after the channel gate and are not in the external channel's allowlist, so the external
// address answers 404. They are outside /api/v1, so the "unknown API path" 404 of a separate admin listener does not
// hide them on the main listener.
import { Hono } from "hono";
import type { App } from "./context.ts";
import { healthState } from "./health.ts";

/** Probe answers must never be cached by a proxy between the orchestrator and the gateway. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export function probeRoutes(app: App): Hono {
  const r = new Hono();
  r.get("/livez", (c) => c.json({ status: "ok" }, 200, NO_STORE));
  r.get("/readyz", async (c) => {
    let status: string;
    try {
      status = (await healthState(app)).status;
    } catch {
      return c.json({ status: "unavailable" }, 503, NO_STORE);
    }
    return c.json({ status }, status === "fail_closed" ? 503 : 200, NO_STORE);
  });
  return r;
}
