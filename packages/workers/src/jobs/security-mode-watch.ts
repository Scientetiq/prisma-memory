// Security mode watch. Hourly, alerts at most once a day
// (repeat key with date):
//   - advanced and fewer than two memory admins with valid keys bound to a device (flag BE cleared explicitly; NULL — not
//     proven, as at sign-in and on the Readiness page) — high security_admins_short: nobody would sign the return to basic;
//   - advanced and Completion not done (mode floor in the anchors, service trust roots — people's keys, machine keys
//     of basic destroyed, host closed — people's confirmations) — high security_mode_incomplete once a day, 14 days after
//     the switch-on — page level (page). Items and their conditions are shared with Readiness (advancedCompletion; without
//     the roots item the reminder went quiet while Readiness stayed red);
//   - an open request to return to basic — high security_mode_downgrade_pending once a day while it waits;
//   - mode setting basic but the inner anchors floor advanced — high security_mode_floor_mismatch once a
//     day: advanced applies, yet someone changed the DB mode past the function.
// Completion, five items: the floor — security_mode_floor() (only a row the workers confirmed lifts the floor;
// a leave document gives no floor), the fifth — confirmation release_signers_human. Switch-on days count from
// the earlier advanced source: history rows (setting) and the floor streak start in anchors (advancedSince, same
// lowering as in security_mode_floor).
// Mode from the DB (security_mode()): so authcheck and deploy scripts see it.
// A no only by the DB's answer: schema older (function or table missing) —
// only codes 42883 and 42P01, then basic and no alert; any other refusal — the strict side (mode advanced, floor advanced
// for the Completion check) and medium alert security_mode_watch_failed once a day; retry — next pass. Switch-on age
// not read — days are not 0: the reminder is high, without a day count, and the same medium alert.
//   - SQL floor basic, but the document this process's loader checked by signatures needs advanced (the floor
//     row was deleted or a rollback left it without columns) — high security_mode_floor_mismatch once a day.
import { advancedCompletion, DEVICE_BOUND_SQL, FLOOR_BUTTON_TEXT, loaderSecurityFloor, log, raiseAlert, type AlertLevel } from "@memory/shared";
import type { DbCtx } from "../ctx.ts";

/** DB refusal of an older schema (no function or table), not a fault: then a no is lawful. */
const schemaOlder = (e: unknown): boolean => { const c = (e as { code?: string })?.code; return c === "42883" || c === "42P01"; };

/** After how many days an unfinished switch-on becomes a page alert. */
export const INCOMPLETE_PAGE_DAYS = 14;
const DAY_MS = 86_400_000;

export interface SecurityModeWatchResult { mode: "basic" | "advanced"; alerts: string[] }

export async function securityModeWatch(ctx: DbCtx, o: { now?: Date } = {}): Promise<SecurityModeWatchResult> {
  const now = o.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const ctl = ctx.db.control;
  const failed: string[] = [];   // not read (not schema-older) — to the medium alert security_mode_watch_failed
  const fail = (what: string, e: unknown): void => {
    failed.push(what);
    log.warn("security_mode_watch_read_failed", { what, code: (e as { code?: string })?.code ?? null, error: ((e as Error)?.message ?? "").slice(0, 160) });
  };
  const mode = await ctl.query("SELECT security_mode($1) AS m", [ctx.instanceId]).then((r) => (r.rows[0]?.m === "advanced" ? "advanced" : "basic") as "basic" | "advanced",
    (e: unknown) => { if (schemaOlder(e)) return "basic" as const; fail("security_mode", e); return "advanced" as const; });
  const alerts: string[] = [];
  const raise = async (code: string, level: AlertLevel, summary: string, details: Record<string, unknown>) => {
    const a = await raiseAlert({ control: ctl, audit: ctx.db.audit }, { instanceId: ctx.instanceId, level, code, summary, details, dedupeKey: `${code}:${day}` });
    if (a.inserted) alerts.push(code);
  };
  const done = async (): Promise<SecurityModeWatchResult> => {
    if (failed.length)
      await raise("security_mode_watch_failed", "medium", `The security mode monitor could not read these values from the database: ${failed.join(", ")}. It applied the stricter mode and will check again in an hour`,
        { failed }).catch(() => undefined);
    if (alerts.length) log.warn("security_mode_watch", { mode, alerts });
    return { mode, alerts };
  };

  // a return request waits — in any mode (after a return none stay open)
  const pending = (await ctl.query(
    `SELECT id::text AS id, not_before, approved_at IS NOT NULL AS approved FROM security_mode_pending
      WHERE instance_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL LIMIT 1`, [ctx.instanceId]).catch(() => ({ rows: [] }))).rows[0] as
    { id: string; not_before: Date; approved: boolean } | undefined;
  if (pending)
    await raise("security_mode_downgrade_pending", "high",
      `A request to return to basic is pending${pending.approved ? " (signed)" : " a signature"}: it can be applied no earlier than ${new Date(pending.not_before).toISOString().slice(0, 16).replace("T", " ")} UTC. Cancel it if you did not request it`,
      { pending: pending.id });

  // anchors floor and mode setting: no functions (older schema) — no alert; another refusal — floor advanced
  const fl = await ctl.query("SELECT security_mode_floor($1) AS f, security_mode_setting($1) AS s", [ctx.instanceId])
    .then((r) => r.rows[0] as { f?: string; s?: string } | undefined,
          (e: unknown) => { if (schemaOlder(e)) return undefined; fail("security_mode_floor", e); return { f: "advanced", s: undefined } as { f?: string; s?: string }; });
  if (fl?.f === "advanced" && fl.s !== undefined && fl.s !== "advanced")
    await raise("security_mode_floor_mismatch", "high", `The database shows basic, but the signed internal anchors require advanced. The active mode is advanced. ${FLOOR_BUTTON_TEXT} — check who changed the mode outside the normal procedure and how`,
      { setting: fl.s, floor: "advanced" });
  // SQL floor basic, but the document this process checked by signatures says advanced: the floor row in the DB
  // vanished or lost its columns (a rollback and reapply) — advanced applies by the process floor
  if (fl && fl.f !== "advanced" && loaderSecurityFloor() === "advanced")
    await raise("security_mode_floor_mismatch", "high", `The signed internal anchors require advanced, but the database shows a basic floor. The anchor row is missing or has lost its floor. The active mode is advanced. ${FLOOR_BUTTON_TEXT}`,
      { sql_floor: "basic", loader_floor: "advanced" });

  if (mode !== "advanced") return done();

  const adminsRow = (await ctl.query(
    `SELECT count(DISTINCT g.person_id)::int AS n FROM role_grants g JOIN people p ON p.id = g.person_id AND p.active
      WHERE g.instance_id = $1 AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now())
        AND EXISTS (SELECT 1 FROM admin_webauthn_credentials w WHERE w.person_id = g.person_id AND w.instance_id = $1 AND w.disabled_at IS NULL AND w.${DEVICE_BOUND_SQL})`,
    [ctx.instanceId]).catch((e: unknown) => { log.warn("security_mode_watch_admins_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); return { rows: [] }; })).rows[0] as
    { n: number } | undefined;
  const admins = adminsRow ? Number(adminsRow.n) : null;   // not read — no alert (false is worse than a missed hour)
  if (admins !== null && admins < 2)
    await raise("security_admins_short", "high", `In advanced mode, fewer than two memory administrators have keys (${admins}). No one can sign the return to basic`, { count: admins });

  // Completion — the same rule as Readiness (advancedCompletion): mode floor in anchors, service trust roots,
  // human confirmations
  const att = ((await ctl.query("SELECT DISTINCT kind, subject FROM security_attestations WHERE instance_id = $1 AND kind IN ('machine_keys_destroyed', 'host_hardened', 'human_signer', 'release_signers_human')",
    [ctx.instanceId]).catch(() => ({ rows: [] }))).rows as Array<{ kind: string; subject: string }>);
  const roots = ((await ctl.query("SELECT service, detail->>'anchors_root_sha256' AS root FROM service_heartbeats WHERE instance_id = $1", [ctx.instanceId])
    .catch(() => ({ rows: [] }))).rows as Array<{ service: string; root: string | null }>);
  // floor not read — for Completion the floor item is not done (reminder — the strict side)
  const floor = fl?.f === "advanced" && !failed.includes("security_mode_floor");
  const missing = advancedCompletion({ floorAdvanced: floor, roots, humanSigners: new Set(att.filter((a) => a.kind === "human_signer").map((a) => a.subject)),
                                       attested: new Set(att.map((a) => a.kind)) }).filter((x) => !x.ok).map((x) => x.missing);
  if (missing.length) {
    const since = await advancedSince(ctx, { setting: fl?.s === "advanced" || fl?.s === undefined, floor });
    if (since === "failed") {
      // age not read — not 0 days (else the page level would never come): a reminder without a count
      fail("advanced_since", null);
      await raise("security_mode_incomplete", "high", `The active mode is advanced and “Completion” is pending: ${missing.join(", ")}. Could not read when the mode was enabled`, { days: null, missing });
    } else {
      const days = since ? Math.floor((now.getTime() - since.getTime()) / DAY_MS) : 0;
      // page level: alert registry (admin_alerts.level page); the level type knows only high and medium
      const level = (days >= INCOMPLETE_PAGE_DAYS ? "page" : "high") as AlertLevel;
      await raise("security_mode_incomplete", level, `The memory switched to advanced mode ${days} days ago and “Completion” is pending: ${missing.join(", ")}`, { days, missing });
    }
  }
  return done();
}

/**
 * Since when advanced applies (for the Completion day count). Two sources: switch-on by the setting (the last
 * history row in advanced) and the inner anchors floor (it writes no history row: without this, with floor advanced
 * and setting basic, days stay 0 and the reminder never pages). Floor: from the first row of the current streak, rows
 * with floor advanced after the last lowering. Lowering — by the same rule as security_mode_floor():
 * only a row without floor or a leave document that the workers confirmed (confirming their own row — number, sha256, write
 * time); rows with a floor after it by number or written after its confirmation — the streak. An unconfirmed row without
 * floor (the gateway may have put it) does not end the streak: else the floor holds and days stay 0. No confirmations
 * table (older schema) — lowering is any row without a floor, as before. Both sources apply — the earlier is taken.
 */
async function advancedSince(ctx: DbCtx, o: { setting: boolean; floor: boolean }): Promise<Date | null | "failed"> {
  const ctl = ctx.db.control;
  let failed = false;
  // a query refusal is not read, not no source: else days are 0 and the page level never comes
  const at = async (sql: string) => ((await ctl.query(sql, [ctx.instanceId]).catch(() => { failed = true; return { rows: [] }; })).rows[0]?.at as Date | null | undefined) ?? null;
  const fromSetting = o.setting ? await at("SELECT max(at) AS at FROM security_mode_changes WHERE instance_id = $1 AND to_mode = 'advanced'") : null;
  let fromFloor: Date | null = null;
  if (o.floor) {
    const confirmed = await ctl.query("SELECT to_regclass('anchors_inner_confirmations') IS NOT NULL AS ok")
      .then((r) => r.rows[0]?.ok === true, () => { failed = true; return false; });
    fromFloor = failed ? null : await at(confirmed
      ? `WITH low AS (SELECT k.serial, k.confirmed_at FROM anchors_inner_confirmations k
                        JOIN anchors_applied b ON b.instance_id = k.instance_id AND b.kind = 'inner' AND b.serial = k.serial AND b.sha256 = k.sha256
                                              AND b.applied_at = k.row_applied_at
                       WHERE k.instance_id = $1 AND (b.retire_target IS NOT NULL OR b.security_mode_min IS DISTINCT FROM 'advanced')
                       ORDER BY k.serial DESC LIMIT 1)
         SELECT min(a.applied_at) AS at FROM anchors_applied a LEFT JOIN low ON true
          WHERE a.instance_id = $1 AND a.kind = 'inner' AND a.security_mode_min = 'advanced' AND a.retire_target IS NULL
            AND (low.serial IS NULL OR a.serial > low.serial OR a.applied_at > low.confirmed_at)`
      : `SELECT min(a.applied_at) AS at FROM anchors_applied a
          WHERE a.instance_id = $1 AND a.kind = 'inner' AND a.security_mode_min = 'advanced' AND a.retire_target IS NULL
            AND a.serial > COALESCE((SELECT max(b.serial) FROM anchors_applied b WHERE b.instance_id = $1 AND b.kind = 'inner'
                                       AND (b.security_mode_min IS DISTINCT FROM 'advanced' OR b.retire_target IS NOT NULL)), 0)`);
  }
  if (failed) return "failed";
  const all = [fromSetting, fromFloor].filter((d): d is Date => d !== null).map((d) => new Date(d));
  return all.length ? new Date(Math.min(...all.map((d) => d.getTime()))) : null;
}
