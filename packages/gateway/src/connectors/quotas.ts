// The connector's own daily quota: items written into memory and their bytes per connector
// and day of the instance time zone, counted at delivery. Limits: the connector's `policy.daily_items` / `policy.daily_mb`,
// by default integrations.connectors_daily_items / connectors_daily_mb (1000 / 1024 — below the run-as person's
// limits.upload_daily of 2000 / 5120, which upload() and acceptMeeting() count on their own and which the person shares
// with their own uploads).
//
// The counter is a row of connector_daily_usage (17 [CONN]): check and add in one statement, so two gateway processes
// never pass the limit together. A delivery takes its place right before the write function and gives it back when the
// item did not become a record (held, failed, skipped, retried, waiting): an item is counted once, when it is delivered —
// a changed document delivered again as a new version is a new delivery and counts again. A process that dies between
// the take and the outcome leaves the place taken (counted, never under-counted).
import { instanceTz, log, uploadDay } from "@memory/shared";
import type { App } from "../context.ts";

const MIB = 1024 * 1024;
/** Counter rows older than this many days are removed by the gateway (at most once an hour per process). */
const KEEP_DAYS = 35;
let swept = 0;

export interface ConnectorDailyLimit { items: number; mib: number }

const positive = (v: unknown, max: number): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : null;

/** The daily limits of a connector: its policy, else the settings, else the built-in defaults. */
export function connectorDailyLimit(app: App, policy: Record<string, unknown> | null | undefined): ConnectorDailyLimit {
  const p = policy ?? {};
  return {
    items: positive(p.daily_items, 10_000_000) ?? positive(app.settings.get<number>("integrations.connectors_daily_items", 1000), 10_000_000) ?? 1000,
    mib: positive(p.daily_mb, 10_000_000) ?? positive(app.settings.get<number>("integrations.connectors_daily_mb", 1024), 10_000_000) ?? 1024,
  };
}

/** The quota stops this item: wait until the next day, or never fits (the item alone is larger than the whole day). */
export class ConnectorQuotaError extends Error {
  constructor(readonly kind: "wait" | "over", readonly seconds: number) { super(kind === "wait" ? "connector_daily" : "over_connector_daily"); }
}

/** A place taken in the connector's daily quota: release() gives it back (the item did not become a record). */
export interface ConnectorDailyTake { day: string; release(): Promise<void> }

/** Takes one item and its bytes in the connector's daily quota; ConnectorQuotaError when it does not fit today. */
export async function takeConnectorDaily(app: App, c: { id: string; policy: Record<string, unknown> | null }, bytes: number): Promise<ConnectorDailyTake> {
  const limit = connectorDailyLimit(app, c.policy);
  const { day, resetSec } = uploadDay(Date.now(), instanceTz(app.settings));
  sweep(app, day);
  const size = Math.max(0, Math.floor(bytes));
  if (size > limit.mib * MIB) throw new ConnectorQuotaError("over", resetSec);
  const { rows } = await app.db.control.query(
    `INSERT INTO connector_daily_usage AS u (connector_id, day, items, bytes, updated_at)
     SELECT $1, $2::date, 1, $3::bigint, now() WHERE 1 <= $4 AND $3::bigint <= $5::bigint
     ON CONFLICT (connector_id, day) DO UPDATE SET items = u.items + 1, bytes = u.bytes + EXCLUDED.bytes, updated_at = now()
      WHERE u.items + 1 <= $4 AND u.bytes + EXCLUDED.bytes <= $5::bigint
     RETURNING items`,
    [c.id, day, size, limit.items, limit.mib * MIB]);
  if (!rows.length) throw new ConnectorQuotaError("wait", resetSec);
  return {
    day,
    release: async () => {
      await app.db.control.query(
        "UPDATE connector_daily_usage SET items = GREATEST(items - 1, 0), bytes = GREATEST(bytes - $3::bigint, 0), updated_at = now() WHERE connector_id = $1 AND day = $2::date",
        [c.id, day, size]).catch((e: Error) => log.warn("connector_daily_release_failed", { connector_id: c.id, error: e.message.slice(0, 160) }));
    },
  };
}

/** What the connector delivered today (the admin page and the pull runs read the same row). */
export async function connectorDailyUsage(app: App, connectorId: string): Promise<{ day: string; items: number; bytes: number }> {
  const { day } = uploadDay(Date.now(), instanceTz(app.settings));
  const r = (await app.db.control.query("SELECT items, bytes FROM connector_daily_usage WHERE connector_id = $1 AND day = $2::date", [connectorId, day])).rows[0] as
    { items: number; bytes: string | number } | undefined;
  return { day, items: Number(r?.items ?? 0), bytes: Number(r?.bytes ?? 0) };
}

/** Removes counter rows older than KEEP_DAYS days — at most once an hour, in the background. */
function sweep(app: App, day: string): void {
  const now = Date.now();
  if (now - swept < 3_600_000) return;
  swept = now;
  void app.db.control.query("DELETE FROM connector_daily_usage WHERE day < $1::date - $2::int", [day, KEEP_DAYS])
    .catch((e: Error) => log.warn("connector_daily_sweep_failed", { error: e.message.slice(0, 160) }));
}
