// Limits: in-memory gateway counters per key and per person; the values are settings of the limits category.
// process_now is counted per person, including service calls on their behalf.
// Upload limits — below the Limiter class: a daily volume per person
// (a counter in the database, not in process memory) and a stop of file intake by free disk space.
import { statfs } from "node:fs/promises";
import { DISK_FREE_KEY, DISK_GUARD_FAULT_SETTING, DISK_LOW_REFUSAL, DISK_MIN_FREE_PERCENT, diskGuardPaths, diskGuardPathValid, instanceTz, log, MemoryError, parseDiskGuardFault, raiseAlert, rateLimited,
         testHooksEnabled, UPLOAD_DAILY_REFUSAL, uploadDailyOf, uploadDay, withTimeout, type Settings } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";

/** refused — refusals in this window: the log writes only the first (a stream over the limit does not flood audit_events). */
interface Window { start: number; count: number; refused?: number }
// memory_open — open by a person's word (a cloud agent) and REST open-class in the workplace — one bucket;
// me_spaces — managing a space in the workplace (name, ownership transfer, directory groups)
// handover — hand over to a project: an owner's action on someone else's readers, bucket owner_ops
const OWNER_TOOLS = new Set(["memory_space_create", "memory_space_add_member", "memory_space_remove_member", "memory_promote", "memory_open", "memory_close", "memory_delete", "memory_apply", "me_spaces", "org_review_decide", "handover"]);
// defaults of buckets added later: on a running instance the setting value was set earlier and has no new bucket.
// spaces_view — the card, groups and members of a space on the project page: the owner's page asks for them at
// every show and after every form action — on the memory_me bucket the owner hit the limit within a few minutes of work
// memory_correct — 30 a minute; corrections_view — corrections on the record page and the workplace's record edits page
// org_review — the useful and wrong marks, the record check view and the shared knowledge check queue; curator decisions — owner_ops
// handover_view — the hand-over form: choosing a project requests it again, the hand-over itself would hit owner_ops
// Workplace service loads: session_me — the profile (memory_me, GET /me) that the workplace session
// asks for on every page; me_keys_view — the lists of keys and agent connections by the session (overview,
// the connect page polled every 15 s, the keys page); nav — the menu summary GET /me/nav. Before, they went to memory_me and
// me_keys at 30 a minute, and the site hit the limit itself. Agents' memory_me, key issue and revoke as before. GET /me/access,
// /me/trash (ME_LISTS) — still memory_me, also for a session: only the profile moves to session_me.
// open_preview — make available to agents: what the check found and who will see the record. Each show checks the text of
// the tree (up to 9 passes), so 30 a minute per person and not owner_ops: the preview does not eat the limit of the show itself.
// show_anyway — the show switches of the record page (GET /me/show-anyway): asked at every show
// of a record, as nav at every page; in memory_me (session_me for a session) they shared the window with the frame profile.
// export — space export in the workplace: each call streams a whole space, so 6 a minute per person.
const BUCKET_DEFAULTS: Record<string, number> = { memory_plan: 20, plans_view: 120, directory: 30, deletion_requests: 120, meetings: 120, spaces_view: 120, memory_correct: 30, corrections_view: 120, org_review: 120,
                                                  handover_view: 120, session_me: 120, me_keys_view: 120, nav: 120, open_preview: 30, show_anyway: 120,
                                                  agent_view: 60, export: 6 };

/**
 * The REST bucket name for GET /me/access and /me/trash: window and limit are memory_me for all (also a session), no own setting.
 * Needed so that the workplace session moves only the profile to session_me, while these lists stay at the old 30 a minute.
 */
export const ME_LISTS = "me_lists";

/**
 * The bucket of a call. A workplace session: the profile in its own session_me, not in the agents' memory_me.
 * Not a session (agent by key, service, preview): me_keys_view — the old me_keys, one window with issuing and revoking keys
 * — agent limits do not change. ME_LISTS — memory_me for all.
 */
export function bucketOf(caller: Pick<Caller, "keyKind">, tool: string): string {
  if (tool === ME_LISTS) return "memory_me";
  if (caller.keyKind === "session") return tool === "memory_me" ? "session_me" : tool;
  return tool === "me_keys_view" ? "me_keys" : tool;
}

export class Limiter {
  private readonly windows = new Map<string, Window>();
  constructor(private readonly settings: Settings) {}

  private hit(bucket: string, limit: number, windowMs: number, consume: boolean, cost = 1): { remaining: number; retryAfter: number; firstRefusal: boolean } {
    const now = Date.now();
    let w = this.windows.get(bucket);
    if (!w || now - w.start >= windowMs) { w = { start: now, count: 0 }; this.windows.set(bucket, w); }
    if (w.count + cost > limit) {
      if (consume) w.refused = (w.refused ?? 0) + 1;
      return { remaining: 0, retryAfter: (w.start + windowMs - now) / 1000, firstRefusal: w.refused === 1 };
    }
    if (consume) w.count += cost;
    return { remaining: limit - w.count, retryAfter: 0, firstRefusal: false };
  }

  private limitFor(caller: Caller, tool: string): number {
    const table = this.settings.get<Record<string, number>>("limits.personal_per_minute", {});
    const bucket = OWNER_TOOLS.has(tool) ? "owner_ops" : bucketOf(caller, tool);
    const base = table[bucket] ?? BUCKET_DEFAULTS[bucket] ?? 120;
    return caller.principalType === "service" ? base * this.settings.get("limits.service_key_multiplier", 5) : base;
  }

  /**
   * Keyless windows pile up one per client address or link signature, and the browser address at an identity provider sign-in
   * comes in a header and may change with each request: with many windows the expired ones (all are a minute long)
   * are swept — at most once per 10 seconds. An expired window and a missing one count the same — limits do not change.
   */
  private anonSwept = 0;
  private sweepAnonymous(now: number): void {
    if (this.windows.size < 50_000 || now - this.anonSwept < 10_000) return;
    this.anonSwept = now;
    for (const [k, w] of this.windows) if (k.startsWith("anon:") && now - w.start >= 60_000) this.windows.delete(k);
  }
  /** Windows in memory — to check the sweep. */
  get windowCount(): number { return this.windows.size; }

  /**
   * A keyless limit: a signed link to an original is shown without Authorization, the window is counted by the signature itself
   * (downloading originals was unlimited before); an identity provider sign-in — by the browser address.
   */
  checkAnonymous(bucket: string, id: string, fallback = 120): void {
    const r = this.takeAnonymous(bucket, id, fallback);
    if (r) throw rateLimited(r.retryAfter);
  }

  /**
   * The same window without throwing: null — within the limit (counted), else seconds until allowed and whether it is the first
   * refusal in the window (the identity provider sign-in logs only the first: else a stream over the limit is a log row per request).
   * The limit is limits.personal_per_minute[bucket], no entry — fallback.
   */
  takeAnonymous(bucket: string, id: string, fallback = 120): { retryAfter: number; firstRefusal: boolean } | null {
    this.sweepAnonymous(Date.now());
    const table = this.settings.get<Record<string, number>>("limits.personal_per_minute", {});
    const r = this.hit(`anon:${bucket}:${id}`, table[bucket] ?? fallback, 60_000, true);
    return r.retryAfter > 0 ? { retryAfter: r.retryAfter, firstRefusal: r.firstRefusal } : null;
  }

  /** Throws rate_limited with an integer retry_after. */
  check(caller: Caller, tool: string, cost = 1): void {
    if (tool === "memory_process_now") {
      const who = caller.person?.id ?? caller.keyId;
      const r = this.hit(`pn:${who}`, this.settings.get("limits.process_now_per_hour", 10), 3_600_000, true);
      if (r.retryAfter > 0) throw rateLimited(r.retryAfter);
      return;
    }
    const r = this.hit(`${caller.keyId}:${bucketOf(caller, tool)}`, this.limitFor(caller, tool), 60_000, true, cost);
    if (r.retryAfter > 0) throw rateLimited(r.retryAfter);
  }

  /** The limits in force with what is left — for memory_me. */
  snapshot(caller: Caller, tools: string[]): Record<string, { limit: number; remaining: number; window: "minute" | "hour" }> {
    const out: Record<string, { limit: number; remaining: number; window: "minute" | "hour" }> = {};
    for (const t of tools) {
      if (t === "memory_process_now") {
        const limit = this.settings.get("limits.process_now_per_hour", 10);
        out[t] = { limit, remaining: this.hit(`pn:${caller.person?.id ?? caller.keyId}`, limit, 3_600_000, false).remaining, window: "hour" };
      } else {
        const limit = this.limitFor(caller, t);
        out[t] = { limit, remaining: this.hit(`${caller.keyId}:${bucketOf(caller, t)}`, limit, 60_000, false).remaining, window: "minute" };
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ daily upload volume (limits.upload_daily)

/** Rows older than this many days the gateway removes itself (at most once an hour per process). */
const DAILY_KEEP_DAYS = 35;
const MIB = 1024 * 1024;
let dailySwept = 0;

/** The place taken for a file: release — return it if the file was not saved. */
export interface UploadDailyTake { day: string; release(): Promise<void> }

/**
 * Take one file and its bytes in a person's daily volume. The counter is a database row (17-basic-tails.sql) per (instance,
 * person, day): all keys, agents and sessions of a person share one row; a gateway restart does not reset it. Check and add —
 * in one query: two files at once do not both slip past the limit. Over the limit — rate_limited with the reason
 * upload_daily and a pause until the start of the next day in the memory time zone; the text is in plain words.
 */
export async function takeUploadDaily(app: App, caller: Caller, bytes: number): Promise<UploadDailyTake> {
  const personId = caller.person?.id;
  if (!personId) throw new MemoryError("forbidden", "Uploads can only be made on behalf of a person");
  const limit = uploadDailyOf(app.settings);
  const { day, resetSec } = uploadDay(Date.now(), instanceTz(app.settings));
  sweepDaily(app, day);
  const { rows } = await app.db.control.query(
    `INSERT INTO upload_daily_usage AS u (instance_id, person_id, day, files, bytes, updated_at)
     SELECT $1, $2, $3::date, 1, $4::bigint, now() WHERE $4::bigint <= $6::bigint
     ON CONFLICT (instance_id, person_id, day) DO UPDATE SET files = u.files + 1, bytes = u.bytes + EXCLUDED.bytes, updated_at = now()
      WHERE u.files + 1 <= $5 AND u.bytes + EXCLUDED.bytes <= $6::bigint
     RETURNING files`,
    [app.instanceId, personId, day, bytes, limit.files, limit.mib * MIB]);
  if (!rows.length) {
    // the limit is used up: by file count or by volume — for the log and the hint
    const cur = (await app.db.control.query("SELECT files, bytes FROM upload_daily_usage WHERE instance_id = $1 AND person_id = $2 AND day = $3::date",
                                            [app.instanceId, personId, day])).rows[0] as { files: number; bytes: string | number } | undefined;
    const kind: "files" | "mib" = cur && Number(cur.files) + 1 > limit.files ? "files" : "mib";
    await noteDailyExceeded(app, caller, personId, day, kind);
    throw new MemoryError("rate_limited", UPLOAD_DAILY_REFUSAL(limit),
      { retry_after: resetSec, hint: "Do not try again today. Tell the person they can continue tomorrow or ask the memory administrator to raise limits.upload_daily",
        details: { reason: "upload_daily", kind, files_limit: limit.files, mib_limit: limit.mib } });
  }
  return {
    day,
    release: async () => {
      await app.db.control.query(
        "UPDATE upload_daily_usage SET files = GREATEST(files - 1, 0), bytes = GREATEST(bytes - $4::bigint, 0), updated_at = now() WHERE instance_id = $1 AND person_id = $2 AND day = $3::date",
        [app.instanceId, personId, day, bytes]).catch((e: Error) => log.warn("upload_daily_release_failed", { error: e.message.slice(0, 160) }));
    },
  };
}

/** Run fn with a place taken in the daily volume: if fn fails, the place returns, the error stays. */
export async function withUploadDaily<T>(app: App, caller: Caller, bytes: number, fn: () => Promise<T>): Promise<T> {
  const take = await takeUploadDaily(app, caller, bytes);
  try { return await fn(); }
  catch (e) { await take.release(); throw e; }
}

/**
 * The event upload_daily_exceeded (audit-codes.json, info) — one per person per day, not per refusal: the mark
 * noted_at is in the same counter row, so the event is one after a restart and with several gateway processes too.
 */
async function noteDailyExceeded(app: App, caller: Caller, personId: string, day: string, kind: "files" | "mib"): Promise<void> {
  const first = await app.db.control.query(
    `INSERT INTO upload_daily_usage AS u (instance_id, person_id, day, noted_at) VALUES ($1, $2, $3::date, now())
     ON CONFLICT (instance_id, person_id, day) DO UPDATE SET noted_at = now() WHERE u.noted_at IS NULL RETURNING 1`,
    [app.instanceId, personId, day]).catch((e: Error) => { log.warn("upload_daily_note_failed", { error: e.message.slice(0, 160) }); return { rows: [] }; });
  if (first.rows.length) await audit(app, caller, { event_type: "rate_limited", details: { code: "upload_daily_exceeded", reason: "upload_daily", kind } });
}

/** The last cleanup of old days — a test waits for it, an upload does not. */
let dailySweep: Promise<void> = Promise.resolve();

/** Remove rows older than DAILY_KEEP_DAYS days — at most once an hour, in the background: it does not delay the upload. */
function sweepDaily(app: App, day: string): void {
  const now = Date.now();
  if (now - dailySwept < 3_600_000) return;
  dailySwept = now;
  dailySweep = app.db.control.query("DELETE FROM upload_daily_usage WHERE instance_id = $1 AND day < $2::date - $3::int", [app.instanceId, day, DAILY_KEEP_DAYS])
    .then(() => undefined, (e: Error) => log.warn("upload_daily_sweep_failed", { error: e.message.slice(0, 160) }));
}

/** For tests: the next upload starts the cleanup of old days; done — wait for the cleanup it started. */
export const uploadDailySweepForTests = { reset(): void { dailySwept = 0; }, done: (): Promise<void> => dailySweep };

// ------------------------------------------------------------------ stop of file intake by free space

/**
 * What one path shows: free (percent), the path cannot be read, or it is set wrong (not from "/": a typo, a "~/…" path — statfs
 * does not check it, and it cannot be silently dropped — the volume would stay unprotected).
 */
export interface DiskProbe { path: string; ok: boolean; reason?: "low" | "unreadable" | "invalid"; freePercent?: number; freeBytes?: number; totalBytes?: number }
export interface DiskState { configured: boolean; probes: DiskProbe[] }

type StatFsResult = { bavail: number | bigint; blocks: number | bigint; bsize?: number | bigint };
type StatFs = (path: string) => Promise<StatFsResult>;
const realStatFs: StatFs = (path) => statfs(path);
let statImpl: StatFs = realStatFs;
let diskCache: { at: number; key: string; state: DiskState } | null = null;
/** How many milliseconds a statfs answer is reused: a stream of uploads does not go to the disk for each file. */
const DISK_CACHE_MS = 5_000;
/** A path that did not answer in this time (a hung network disk) counts as unreadable: intake is closed. */
const STATFS_TIMEOUT_MS = 3_000;
/** Seconds before retrying an upload after a refusal by space: space will not appear by itself, but waiting forever is no use. */
const DISK_RETRY_SEC = 600;
const alertsRaised = new Set<string>();
let alertsDay = "";
/**
 * At most one statfs in flight per path. A timeout only stops waiting: a hung statfs (a network disk in
 * state D) holds a libuv pool thread until the kernel answers. If every check (cache 5 s, health every 15 s)
 * started a new one, four hung ones would take the whole pool, and file reads, DNS for new database connections and password
 * checks would stall — reading and search. Until the path's last statfs returns, none starts: a check waits for the same answer
 * (the usual case — simultaneous uploads), and past STATFS_TIMEOUT_MS the path is unreadable at once.
 */
const statfsInFlight = new Map<string, { at: number; promise: Promise<StatFsResult> }>();

function statfsOnce(path: string): Promise<StatFsResult> {
  const cur = statfsInFlight.get(path);
  if (cur) {
    const left = STATFS_TIMEOUT_MS - (Date.now() - cur.at);
    return left > 0 ? withTimeout(cur.promise, left, "disk space") : Promise.reject(new Error("statfs has not returned for the path yet"));
  }
  const promise = statImpl(path);
  const entry = { at: Date.now(), promise };
  statfsInFlight.set(path, entry);
  // the entry is removed only when statfs itself returned — not by the timeout
  const clear = () => { if (statfsInFlight.get(path) === entry) statfsInFlight.delete(path); };
  promise.then(clear, clear);
  return withTimeout(promise, STATFS_TIMEOUT_MS, "disk space");
}

/** For tests: replace statfs (null — the real one) and reset the cache, the alert marks and the statfs in flight. */
export function setStatFsForTests(f: StatFs | null): void { statImpl = f ?? realStatFs; diskCache = null; alertsRaised.clear(); statfsInFlight.clear(); }

/** Stop paths by space — from MEMORY_DISK_GUARD_PATHS (database and storage data, mounted into the gateway read-only). */
export const diskGuardList = (): string[] => diskGuardPaths(process.env.MEMORY_DISK_GUARD_PATHS);

/**
 * Free space on each path of the list. Less than 10 % free or the path unreadable (missing, no rights, statfs hung) — the path
 * is bad. The test hook processing.disk_guard_fault replaces the answer — only with MEMORY_TEST_HOOKS=1 and only with a set
 * list. An empty list — configured: false (health warns), intake is not closed.
 */
export async function diskState(app: Pick<App, "settings"> & Partial<Pick<App, "db" | "instanceId">>, force = false): Promise<DiskState> {
  const paths = diskGuardList();
  const fault = testHooksEnabled() ? parseDiskGuardFault(app.settings.get<unknown>(DISK_GUARD_FAULT_SETTING, {})) : null;
  const key = `${paths.join("\n")}|${JSON.stringify(fault)}`;
  if (!force && diskCache && diskCache.key === key && Date.now() - diskCache.at < DISK_CACHE_MS) return diskCache.state;
  const probes = await Promise.all(paths.map(async (path): Promise<DiskProbe> => {
    // an entry not from "/" is a wrong deployment setting: intake is closed (fail closed), the path is not dropped from the list
    if (!diskGuardPathValid(path)) return { path, ok: false, reason: "invalid" };
    if (fault && (!fault.path || fault.path === path)) {
      if (fault.unreadable) return { path, ok: false, reason: "unreadable" };
      const free = fault.free_percent!;
      return free < DISK_MIN_FREE_PERCENT ? { path, ok: false, reason: "low", freePercent: free } : { path, ok: true, freePercent: free };
    }
    try {
      const st = await statfsOnce(path);
      const blocks = Number(st.blocks), avail = Number(st.bavail), bsize = Number(st.bsize);
      if (!(blocks > 0) || !(avail >= 0)) return { path, ok: false, reason: "unreadable" };
      const free = (avail / blocks) * 100;
      const bytes = bsize > 0 ? { freeBytes: avail * bsize, totalBytes: blocks * bsize } : {};
      return free < DISK_MIN_FREE_PERCENT ? { path, ok: false, reason: "low", freePercent: free, ...bytes } : { path, ok: true, freePercent: free, ...bytes };
    } catch {
      return { path, ok: false, reason: "unreadable" };
    }
  }));
  const state = { configured: paths.length > 0, probes };
  diskCache = { at: Date.now(), key, state };
  return state;
}

/** How often the free space of the database volume is written for the worker (rebuild head-room). */
export const DISK_REPORT_EVERY_MS = 60_000;

/**
 * The worker cannot see the database volume; the gateway can. The smallest free space among the measured paths goes to
 * maintenance_state `disk_free` ({free_bytes, total_bytes, at}), for the head-room check of a rebuild;
 * with no path guarded (MEMORY_DISK_GUARD_PATHS empty) — {configured: false, at}, so that the default
 * processing.rebuild_disk = auto lets a stock install rebuild. Written by the gateway's own timer
 * (`startDiskReport`), never on a request: a request that is refused (write space, authorization) writes no state before
 * its refusal. A test hook's answer is never reported (it has no bytes); nothing measured
 * on a guarded path — nothing written; a failed write is a log line.
 */
export async function reportDiskFree(app: Pick<App, "settings" | "db" | "instanceId">): Promise<void> {
  if (testHooksEnabled() && parseDiskGuardFault(app.settings.get<unknown>(DISK_GUARD_FAULT_SETTING, {}))) return;
  const state = await diskState(app, true);
  const measured = state.probes.filter((p) => p.freeBytes !== undefined && p.totalBytes !== undefined && p.totalBytes > 0);
  if (state.configured && !measured.length) return;
  const at = new Date(Date.now()).toISOString();
  const value = state.configured
    ? (() => { const worst = measured.reduce((a, b) => (b.freeBytes! < a.freeBytes! ? b : a)); return { free_bytes: worst.freeBytes, total_bytes: worst.totalBytes, at }; })()
    : { configured: false, at };
  await app.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [app.instanceId, DISK_FREE_KEY, JSON.stringify(value)])
    .catch((e: unknown) => { log.warn("disk_free_report_failed", { error: (e as Error).message.slice(0, 120) }); });
}

/** The gateway's timer of `reportDiskFree`: once at start, then every DISK_REPORT_EVERY_MS (unref: it never holds the process). */
export function startDiskReport(app: Pick<App, "settings" | "db" | "instanceId">): void {
  const tick = () => void reportDiskFree(app).catch((e: unknown) => log.warn("disk_free_report_failed", { error: ((e as Error)?.message ?? "").slice(0, 120) }));
  tick();
  setInterval(tick, DISK_REPORT_EVERY_MS).unref();
}

/**
 * Raise the alert disk_low (audit-codes.json, high) — one per path, reason and day: repeated refusals and health
 * checks breed no new alerts. The alert has the path's number in the list, the reason and the percent, no paths or file names.
 * The alert-exists mark in process memory is set only after a successful write: raiseAlert does not throw on a write failure
 * but only logs it: with the mark set before the write, one database failure would mute the alert all day while intake is closed.
 * A repeated write gives no duplicate: in the database the same dedupe key holds the unique index admin_alerts_dedupe_idx.
 */
export async function alertDiskLow(app: App, state: DiskState): Promise<void> {
  const bad = state.probes.map((p, i) => ({ p, i })).filter(({ p }) => !p.ok);
  if (!bad.length) return;
  const { day } = uploadDay(Date.now(), instanceTz(app.settings));
  if (alertsDay !== day) { alertsRaised.clear(); alertsDay = day; }
  for (const { p, i } of bad) {
    const dedupe = `disk_low:${day}:${i + 1}:${p.reason}`;
    if (alertsRaised.has(dedupe)) continue;
    const where = `path ${i + 1} of ${state.probes.length} in MEMORY_DISK_GUARD_PATHS`;
    const summary = p.reason === "low"
      ? `${Math.floor(p.freePercent ?? 0)} % free (${where}), below ${DISK_MIN_FREE_PERCENT} %. File uploads are blocked. Reading and search still work`
      : p.reason === "invalid"
        ? `Invalid path: it must start with “/” (${where}). File uploads are blocked. Reading and search still work`
        : `Could not check disk space (${where}). File uploads are blocked. Reading and search still work`;
    // the write failed, seen only here: raiseAlert catches the database error itself and returns inserted: false, as on a repeat
    let failed = false;
    const control = { query: (sql: string, args?: unknown[]) => app.db.control.query(sql, args).catch((e: unknown) => { failed = true; throw e; }) };
    await raiseAlert({ control, audit: app.db.audit }, {
      instanceId: app.instanceId, level: "high", code: "disk_low", summary, dedupeKey: dedupe,
      details: p.reason === "low" ? { reason: "low", count: Math.floor(p.freePercent ?? 0) } : { reason: p.reason ?? "unreadable" },
    });
    if (!failed) alertsRaised.add(dedupe);
  }
}

/**
 * Before taking a file (a document, a meeting transcript): on some path space is low or the path is unreadable — a refusal
 * rate_limited with the reason disk_low, in plain words, and an alert to administrators. Reading and search are untouched. Path
 * list empty — the stop is not set up, intake goes on (health warns).
 */
export async function checkDiskForUpload(app: App): Promise<void> {
  const state = await diskState(app);
  if (state.probes.every((p) => p.ok)) return;
  await alertDiskLow(app, state);
  throw new MemoryError("rate_limited", DISK_LOW_REFUSAL,
    { retry_after: DISK_RETRY_SEC, hint: "Do not retry the upload. Tell the person to let the memory administrator know that memory is nearly full. Reading and search still work",
      details: { reason: "disk_low" } });
}

/**
 * The health line disk_guard: an empty list — ok with a warning that the stop by space is not set up; a bad path — not ok (intake
 * closed, status degraded) and an alert; otherwise — ok with the free space per path.
 */
export async function diskGuardHealth(app: App): Promise<{ ok: boolean; level?: "ok" | "warn" | "fail"; detail: string }> {
  const state = await diskState(app, true);
  if (!state.configured)
    return { ok: true, level: "warn", detail: "the disk space guard is not configured: MEMORY_DISK_GUARD_PATHS is empty. The memory will keep accepting files if the disk fills up" };
  const bad = state.probes.filter((p) => !p.ok);
  const free = state.probes.map((p, i) => `path ${i + 1}: ${p.ok || p.reason === "low" ? `${Math.floor(p.freePercent ?? 0)} % free` : p.reason === "invalid" ? "invalid (path must start with “/”)" : "could not read"}`).join("; ");
  if (bad.length) {
    await alertDiskLow(app, state);
    const why = bad.some((p) => p.reason === "invalid") ? "path in MEMORY_DISK_GUARD_PATHS is invalid"
      : bad.some((p) => p.reason === "unreadable") ? "could not read the path" : `less than ${DISK_MIN_FREE_PERCENT} % free`;
    return { ok: false, level: "fail", detail: `file uploads are blocked — ${why}; reading and search still work (${free})` };
  }
  return { ok: true, detail: free };
}
