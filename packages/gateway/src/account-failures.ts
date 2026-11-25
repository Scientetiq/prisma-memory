// Failures per directory entry survive a gateway restart. The failure window lives in
// process memory (failure-window.ts), while AD does not reset its bad-password counter when the gateway restarts: a deploy,
// a crash or a VM reboot in the middle of a series gave another max_failures_per_login attempts, AD got twice the limit
// in a row, and the rule T − R stopped holding. So the failure marks of directory entries (keys account:…, ldap-login.ts)
// go to maintenance_state after each write and reset (entry ldap_account_failures: the row and rights exist for the gateway,
// the schema does not change) and return to the window at start, before requests are taken.
//  - Directory entries only: their count protects the account from an AD lockout, and there are as many entries as people.
//    Typed names and addresses count from zero after a restart, as before: there may be any number of made-up names.
//  - The hash of objectGUID (or DN) is used: neither the identifier nor the full name from the DN is in the database.
//  - One save at a time: failures that arrive during it go in the next one (no queue per failure).
//  - A database failure does not block login, it is logged; unread at start: counting starts from zero, as without saving.
import { clientText, log } from "@memory/shared";
import type pg from "pg";
import type { FailureWindow } from "./failure-window.ts";

/** Name of the maintenance_state row. */
export const ACCOUNT_FAILURES_STATE = "ldap_account_failures";
/** Prefix of the window entries for directory records (ldap-login.ts, directoryAccountKey). */
export const ACCOUNT_KEY_PREFIX = "account:";

type Q = Pick<pg.Pool, "query">;
interface Stored { v: 1; keys: Record<string, number[]> }

/** Write the failure marks of directory entries (all younger than the window retention). Returns how many were saved. */
export async function saveAccountFailures(q: Q, instanceId: string, w: FailureWindow, now = Date.now()): Promise<number> {
  const value: Stored = { v: 1, keys: w.snapshot(ACCOUNT_KEY_PREFIX, now) };
  await q.query(`INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
                 ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                [instanceId, ACCOUNT_FAILURES_STATE, JSON.stringify(value)]);
  return Object.keys(value.keys).length;
}

/** Put the saved marks back into the window (at start); foreign entries and non-numbers are dropped. Returns the count taken. */
export async function loadAccountFailures(q: Q, instanceId: string, w: FailureWindow, now = Date.now()): Promise<number> {
  const row = (await q.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [instanceId, ACCOUNT_FAILURES_STATE])).rows[0] as { value?: unknown } | undefined;
  const keys = (row?.value as Partial<Stored> | null | undefined)?.keys;
  if (!keys || typeof keys !== "object") return 0;
  const clean: Record<string, number[]> = {};
  for (const [k, xs] of Object.entries(keys))
    if (k.startsWith(ACCOUNT_KEY_PREFIX) && Array.isArray(xs)) clean[k] = xs.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return w.restore(clean, now);
}

/** Save after a write or reset of a directory entry failure: one at a time, one arriving during it goes next. */
export class AccountFailuresSaver {
  private running: Promise<void> | null = null;
  private dirty = false;
  constructor(private readonly q: Q, private readonly instanceId: string, private readonly w: FailureWindow) {}
  touch(): void {
    this.dirty = true;
    if (this.running) return;
    this.running = this.loop().finally(() => {
      this.running = null;
      if (this.dirty) this.touch();       // a mark came after the loop exited but before it let go of the slot
    });
  }
  private async loop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try { await saveAccountFailures(this.q, this.instanceId, this.w); }
      catch (e) { log.warn("ldap_account_failures_save_failed", { error: clientText(e) }); return; }
    }
  }
  /** Wait for the save (gateway stop, checks). */
  async flush(): Promise<void> { while (this.running) await this.running; }
}
