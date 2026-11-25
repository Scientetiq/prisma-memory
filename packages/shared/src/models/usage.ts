// Usage of the model roles and its money. Every exchange with a chat, embeddings or
// rerank model is reported by its adapter (`ModelIo.report`) and counted here, in addition to the stage tokens of
// `Platform.onUsage` (night and day caps), which keep their own meaning.
//
// One `UsageRecorder` per process aggregates in memory under the key "instance, day (UTC), role, endpoint (host[:port]),
// model, stage" and flushes every 10 s and on shutdown with one upsert that adds to the stored sums, so two processes that
// flush the same key concurrently lose nothing. A flush that fails is retried with the next one, except a row the database
// refuses for its data (SQLSTATE class 22 or 23), which is dropped with a warning so that it never blocks the others; every
// count of one call is clamped to `USAGE_CALL_MAX` and the stored sums saturate at the top of `bigint`. Nothing here ever
// fails a model call. A database without the table (a test sandbox that does not apply schema file 17, a database after the
// rollback of its part [MU]) switches the recorder off with one warning. The numbers come from the provider's answer; when
// the answer has none, the adapter estimates them from the sizes (characters / 4) and the call is counted as estimated.
// Tokens and search units (Cohere-style rerank billing) are kept apart and never summed.
//
// Money: `models.prices` — prices typed by the administrator (there is no built-in price list: it would go stale and name
// vendors in the defaults), per million tokens and per search unit, all in one currency. A cost the provider reports
// (OpenRouter's `usage.cost`) is taken instead of the price. A call with usage and neither — `unpriced_calls`, cost 0.
import { log } from "../log.ts";
import type { ModelConnection, ModelRole, ModelUsageReport } from "./types.ts";

/** How often the recorder writes its sums. */
export const USAGE_FLUSH_MS = 10_000;
/** Keys held in memory at most; the usage of a new key beyond it is dropped (and logged) until the next flush. */
export const USAGE_MAX_KEYS = 10_000;
/** Default of `models.usage_retention_days`. */
export const USAGE_RETENTION_DAYS = 400;
/** Bounds of `models.usage_retention_days`. */
export const USAGE_RETENTION_RANGE: readonly [number, number] = [1, 3650];
/** Entries of `models.prices` at most. */
export const PRICES_MAX = 500;
/** How often the gateway's recorder deletes expired days. */
const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;
/** Longest model name and stage kept in a key (longer ones are cut: a key is never refused). */
const NAME_MAX = 200;
const STAGE_MAX = 64;
/** Rows per upsert statement. */
const FLUSH_CHUNK = 500;
/**
 * The most one call adds to any column: tokens, search units and money (in millionths). A provider that reports more
 * (1e19 tokens, a cost of 1e13 credits) is clamped to it, so a single absurd answer can never produce a number PostgreSQL
 * refuses as `bigint` and stop the writing of the whole process.
 */
export const USAGE_CALL_MAX = 1e12;
/** The most a sum held in memory reaches (it stays an exact integer in a double); the table saturates at bigint's top. */
const SUM_MAX = Number.MAX_SAFE_INTEGER;

/** One entry of `models.prices`: prices per million tokens and per search unit, all entries in one currency. */
export interface ModelPrice {
  /** host[:port] of the model's base URL; absent — any address. An entry with the address wins over one without. */
  endpoint?: string;
  model: string;
  input_per_mtok: number;
  /** Cached input tokens; absent — the price of input tokens. */
  cached_input_per_mtok?: number;
  output_per_mtok: number;
  per_search_unit?: number;
}

const PRICE_FIELDS = new Set(["endpoint", "model", "input_per_mtok", "cached_input_per_mtok", "output_per_mtok", "per_search_unit"]);
const ENDPOINT = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::([1-9]\d{0,4}))?$/i;
/** The port of a valid `endpoint` (1–65535, no leading zero), or why it can never match a row's endpoint. */
function endpointProblem(v: unknown): "form" | "default_port" | null {
  if (typeof v !== "string") return "form";
  const m = ENDPOINT.exec(v);
  if (!m) return "form";
  if (m[1] !== undefined && Number(m[1]) > 65535) return "form";
  // the endpoint of a row is the URL's origin, which drops the scheme's default port, so such an entry would never match
  // (a server on the other scheme's default port — http on 443 — is priced by an entry of its model without an address)
  if (m[1] === "443" || m[1] === "80") return "default_port";
  return null;
}
const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const price = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9;

function priceProblems(e: unknown, i: number): string[] {
  const at = `entry ${i + 1}`;
  if (!plainObject(e)) return [`${at}: an object {"model": …, "input_per_mtok": …, "output_per_mtok": …} is expected`];
  const out: string[] = [];
  const extra = Object.keys(e).filter((k) => !PRICE_FIELDS.has(k));
  if (extra.length) out.push(`${at}: unknown fields ${extra.join(", ")}`);
  if (typeof e.model !== "string" || !e.model.trim() || e.model !== e.model.trim() || e.model.length > NAME_MAX) out.push(`${at}: model — a name without spaces at the ends`);
  const ep = e.endpoint === undefined ? null : endpointProblem(e.endpoint);
  if (ep === "form") out.push(`${at}: endpoint — the host and optional port of the base URL, for example api.example.com or model-server:8000`);
  if (ep === "default_port") out.push(`${at}: endpoint — write the host without the default port (${String(e.endpoint).replace(/:\d+$/, "")})`);
  for (const k of ["input_per_mtok", "output_per_mtok"]) if (!price(e[k])) out.push(`${at}: ${k} — a number, 0 or more`);
  for (const k of ["cached_input_per_mtok", "per_search_unit"]) if (e[k] !== undefined && !price(e[k])) out.push(`${at}: ${k} — a number, 0 or more`);
  return out;
}

/** A retention in days within `USAGE_RETENTION_RANGE`. */
const retentionValid = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= USAGE_RETENTION_RANGE[0] && (v as number) <= USAGE_RETENTION_RANGE[1];

/** Why a value of `models.prices`, `models.usage_retention_days` or `models.budget` would not be saved (empty — it would). */
export function usageSettingProblems(path: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (path === "models.budget") return budgetProblems(value);
  if (path === "models.prices") {
    if (!Array.isArray(value)) return ['a list of prices [{"model": …, "input_per_mtok": …, "output_per_mtok": …}] is expected'];
    if (value.length > PRICES_MAX) return [`at most ${PRICES_MAX} entries`];
    return value.flatMap(priceProblems);
  }
  if (path === "models.usage_retention_days")
    return retentionValid(value) ? [] : [`a whole number of days from ${USAGE_RETENTION_RANGE[0]} to ${USAGE_RETENTION_RANGE[1]}`];
  return [];
}

// ---------------------------------------------------------------- the money budget
//
// `models.budget` — {currency, daily, monthly, warn_ratio, search}: limits on the money spent on model calls per UTC day and
// per UTC month, in the currency of `models.prices`; null — no limit. The spent amount is the sum of `cost_micros` of
// `model_usage_daily` for the installation (every process of it) plus what this process counted and has not flushed yet,
// read at most every `BUDGET_CACHE_MS`; with no limit set nothing is read. The limit is soft: there is no reservation, a call
// is checked before it starts ("spent ≥ limit" stops it), so the overshoot is bounded by the calls already running when the
// limit was reached. Only priced calls count (a price of `models.prices` or a cost the provider reports). Without the usage
// table the budget cannot be enforced: calls go on (`budgetState().enforced` is false). The token night cap stays the hard guard.

/** The value of `models.budget`. Amounts in currency units (not millionths). */
export interface ModelBudget {
  currency: string;
  daily: number | null;
  monthly: number | null;
  /** The share of a limit from which a warning is logged (once per period and process). */
  warn_ratio: number;
  /** Search after exhaustion: `degrade` — without the models (full-text, the order without a reranker), `allow` — it keeps paying. */
  search: "degrade" | "allow";
}
/** Seed default and code fallback of `models.budget`: no limit. */
export const BUDGET_DEFAULT: Readonly<ModelBudget> = Object.freeze({ currency: "USD", daily: null, monthly: null, warn_ratio: 0.8, search: "degrade" });
/** How long the spent amount read from the table is used before it is read again. */
export const BUDGET_CACHE_MS = 10_000;
/** The highest limit accepted, in currency units. */
export const BUDGET_MAX = 1e9;
/** The stage of the "test connection" probe: never stopped by the budget, always counted. */
export const PROBE_STAGE = "probe";
/** Which limit is spent. */
export type BudgetPeriod = "daily" | "monthly";

const BUDGET_FIELDS = new Set(["currency", "daily", "monthly", "warn_ratio", "search"]);
/** A currency as a three-letter code (ISO 4217 style): the panel shows it next to the amounts. */
const CURRENCY = /^[A-Z]{3}$/;
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= BUDGET_MAX;
const ratio = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;

function budgetProblems(v: unknown): string[] {
  if (!plainObject(v)) return ['an object {"currency": "USD", "daily": null, "monthly": null, "warn_ratio": 0.8, "search": "degrade"} is expected'];
  const out: string[] = [];
  const extra = Object.keys(v).filter((k) => !BUDGET_FIELDS.has(k));
  if (extra.length) out.push(`unknown fields ${extra.join(", ")}`);
  if (v.currency !== undefined && (typeof v.currency !== "string" || !CURRENCY.test(v.currency))) out.push("currency — a three-letter code in capitals, for example USD or EUR");
  for (const k of ["daily", "monthly"]) if (v[k] !== undefined && v[k] !== null && !amount(v[k])) out.push(`${k} — null (no limit) or an amount from 0 to ${BUDGET_MAX}`);
  if (v.warn_ratio !== undefined && !ratio(v.warn_ratio)) out.push("warn_ratio — a share above 0 and at most 1, for example 0.8");
  if (v.search !== undefined && v.search !== "degrade" && v.search !== "allow") out.push('search — "degrade" or "allow"');
  return out;
}

/**
 * The budget in force: `models.budget` with the fields of the default for what is absent or not valid; null when neither a
 * daily nor a monthly limit is set — then nothing is checked and nothing is read.
 */
export function readBudget(settings: { get<T>(path: string, fallback: T): T }): ModelBudget | null {
  const raw = settings.get<unknown>("models.budget", BUDGET_DEFAULT);
  if (!plainObject(raw)) return null;
  const daily = amount(raw.daily) ? raw.daily : null, monthly = amount(raw.monthly) ? raw.monthly : null;
  if (daily === null && monthly === null) return null;
  return {
    currency: typeof raw.currency === "string" && CURRENCY.test(raw.currency) ? raw.currency : BUDGET_DEFAULT.currency,
    daily, monthly,
    warn_ratio: ratio(raw.warn_ratio) ? raw.warn_ratio : BUDGET_DEFAULT.warn_ratio,
    search: raw.search === "allow" ? "allow" : "degrade",
  };
}

/** A stage of search (`search_query`, `search_rerank`): it pays after exhaustion only with `search: "allow"`. */
export const isSearchStage = (stage: string | undefined): boolean => stage === "search" || (stage?.startsWith("search_") ?? false);

/** The text of a call the budget stopped (`PlatformError("budget_exhausted")`). */
export function budgetExhaustedText(period: BudgetPeriod, b: Pick<ModelBudget, "currency" | "daily" | "monthly">): string {
  const limit = period === "daily" ? b.daily : b.monthly;
  return `model budget exhausted: the ${period} limit of ${limit} ${b.currency} is spent; model calls wait until the limit is raised or the next UTC ${period === "daily" ? "day" : "month"} starts`;
}

/** What the budget looks like now (for health and the panel). Amounts in currency units. */
export interface BudgetState {
  /**
   * false — the limit is not enforced: the usage table is missing, or no read of the spent amount succeeded this UTC day
   * (`unenforced` says which); calls are not stopped (unless this process's own money alone is over the limit).
   */
  enforced: boolean;
  /** Why the limit is not enforced; absent while it is. */
  unenforced?: "table_missing" | "read_failed";
  exhausted: BudgetPeriod | null;
  /** A limit whose `warn_ratio` share is reached (and that is not spent yet). */
  warning: BudgetPeriod | null;
  currency: string;
  daily: number | null;
  monthly: number | null;
  /** The UTC day the amounts are of. */
  day: string;
  spent_day: number;
  spent_month: number;
  /** When the table was last read; null — not yet (only this process's own count is known). */
  read_at: string | null;
}

/** Where the facade asks about the budget: the process's usage recorder (or a stand-in in tests). */
export interface BudgetSource {
  /** The spent limit from the cached amount, without waiting (a stale amount is read again in the background). */
  budgetBlock(): BudgetPeriod | null;
  /** The same after reading the table when the cached amount is older than `BUDGET_CACHE_MS`. */
  budgetFresh(): Promise<BudgetPeriod | null>;
  /** What the budget looks like now, without waiting; null — no limit set. */
  budgetState?(): BudgetState | null;
}

/** host[:port] of a connection: its origin without the scheme (no path, no key). */
export function usageEndpoint(c: Pick<ModelConnection, "endpoint">): string {
  return c.endpoint.origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").toLowerCase();
}

/**
 * The price of a pair from `models.prices`: the entry with this address and model, else the entry of the model without an
 * address; invalid entries are skipped. null — no price.
 */
export function priceFor(prices: unknown, endpoint: string, model: string): ModelPrice | null {
  if (!Array.isArray(prices)) return null;
  let any: ModelPrice | null = null;
  const host = endpoint.toLowerCase();
  for (let i = 0; i < prices.length; i++) {
    const e = prices[i];
    if (priceProblems(e, i).length) continue;
    const p = e as ModelPrice;
    if (p.model !== model) continue;
    if (p.endpoint !== undefined) { if (p.endpoint.toLowerCase() === host) return p; }
    else any ??= p;
  }
  return any;
}

/** The counts of one call or of a key's sum. `costMicros` may be fractional in memory; it is rounded when written. */
export interface UsageCounts {
  calls: number; failedCalls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; searchUnits: number;
  estimatedCalls: number; costMicros: number; unpricedCalls: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), USAGE_CALL_MAX) : 0);

/**
 * The counts of one reported exchange and its cost under `p`: input tokens include the cached ones (OpenAI, OpenRouter and
 * the Anthropic sum report them so); cached tokens are priced at their own price, else at the input price. A reported
 * provider cost (in currency units) wins over the price. A call with usage and no cost source is unpriced, and so is one
 * billed in search units whose price entry has no `per_search_unit` (its tokens keep their price). Every count and the
 * cost are clamped to `USAGE_CALL_MAX`.
 */
export function usageCounts(u: ModelUsageReport, p: ModelPrice | null): UsageCounts {
  const input = count(u.inputTokens), cached = Math.min(count(u.cachedInputTokens), input), output = count(u.outputTokens), units = count(u.searchUnits);
  const used = input + output + units > 0;
  const reported = typeof u.providerCost === "number" && Number.isFinite(u.providerCost) && u.providerCost >= 0 ? u.providerCost : null;
  let cost = 0, unpriced = 0;
  if (reported !== null) cost = reported * 1e6;
  else if (p && used) {
    cost = (input - cached) * p.input_per_mtok + cached * (p.cached_input_per_mtok ?? p.input_per_mtok)
         + output * p.output_per_mtok + units * (p.per_search_unit ?? 0) * 1e6;
    if (units > 0 && p.per_search_unit === undefined) unpriced = 1;
  }
  else if (used) unpriced = 1;
  return { calls: 1, failedCalls: u.ok ? 0 : 1, inputTokens: input, cachedInputTokens: cached, outputTokens: output, searchUnits: units,
           estimatedCalls: u.estimated && used ? 1 : 0, costMicros: Math.min(cost, USAGE_CALL_MAX), unpricedCalls: unpriced };
}

/**
 * Where the facade reports usage: one recorder per process, or a stand-in in tests. Never throws into a model call. A sink
 * that also knows the budget (the recorder) is asked before every paid request; one without is never in the way.
 */
export interface UsageSink extends Partial<BudgetSource> { record(c: ModelConnection, u: ModelUsageReport): void }

/** What the recorder reads from the database: `pg.Pool` or a client. */
export interface UsageDb { query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null; rows?: any[] }> }

/** A key of the table and its sums. */
interface Entry { day: string; role: ModelRole; endpoint: string; model: string; stage: string; n: UsageCounts }

const COLUMNS = ["calls", "failed_calls", "input_tokens", "cached_input_tokens", "output_tokens", "search_units", "estimated_calls", "cost_micros", "unpriced_calls"] as const;
const FIELDS: ReadonlyArray<keyof UsageCounts> = ["calls", "failedCalls", "inputTokens", "cachedInputTokens", "outputTokens", "searchUnits", "estimatedCalls", "costMicros", "unpricedCalls"];

/** The top of `bigint`: a stored sum saturates there instead of failing the statement. */
const BIGINT_MAX = "9223372036854775807";
const UPSERT = `INSERT INTO model_usage_daily AS u (instance_id, day, role, endpoint, model, stage, ${COLUMNS.join(", ")})
SELECT $1, k.day, k.role, k.endpoint, k.model, k.stage, ${COLUMNS.map((c) => `k.${c}`).join(", ")}
  FROM unnest($2::date[], $3::text[], $4::text[], $5::text[], $6::text[], ${COLUMNS.map((_, i) => `$${i + 7}::bigint[]`).join(", ")})
       AS k(day, role, endpoint, model, stage, ${COLUMNS.join(", ")})
ON CONFLICT (instance_id, day, role, endpoint, model, stage) DO UPDATE SET ${COLUMNS.map((c) => `${c} = LEAST(u.${c}::numeric + EXCLUDED.${c}, ${BIGINT_MAX})::bigint`).join(", ")}`;

/**
 * The money spent by the installation today and this month (UTC), in millionths: every process's flushed rows. The month is
 * read from its first day to `$2` (a row of a later day, from a clock ahead, is not counted twice).
 */
const SPENT_SQL = `SELECT COALESCE(sum(cost_micros) FILTER (WHERE day = $2::date), 0)::text AS day_micros, COALESCE(sum(cost_micros), 0)::text AS month_micros
  FROM model_usage_daily WHERE instance_id = $1 AND day >= $3::date AND day <= $2::date`;
/** After a failed read of the spent amount, the next one waits this long (a broken database is not asked on every call). */
const SPENT_RETRY_MS = BUDGET_CACHE_MS;

const sqlState = (e: unknown): string => { const c = (e as { code?: unknown } | null)?.code; return typeof c === "string" ? c : ""; };
/** SQLSTATE 42P01: the table does not exist. */
const tableMissing = (e: unknown): boolean => sqlState(e) === "42P01";
/** SQLSTATE classes 22 (data exception) and 23 (integrity constraint): a row that will never be written, however often retried. */
const rowRefused = (e: unknown): boolean => /^2[23]/.test(sqlState(e));
const errText = (e: unknown): string => ((e as Error)?.message ?? String(e)).slice(0, 200);
/** A model name or stage as a key part: no NUL (PostgreSQL text cannot hold it), cut at `max`. */
const keyText = (v: unknown, max: number): string => String(v ?? "").replace(/\u0000/g, "").slice(0, max);
const keyOf = (e: Omit<Entry, "n">): string => JSON.stringify([e.day, e.role, e.endpoint, e.model, e.stage]);
function add(to: UsageCounts, n: UsageCounts): void { for (const f of FIELDS) to[f] = Math.min(to[f] + n[f], SUM_MAX); }

export interface UsageRecorderOptions {
  db: UsageDb;
  instanceId: string;
  /** The settings cache: `models.prices`, `models.usage_retention_days`. */
  settings: { get<T>(path: string, fallback: T): T };
  /** Delete days older than `models.usage_retention_days` once a day (one process does it: the gateway). */
  retention?: boolean;
  flushMs?: number;
  maxKeys?: number;
  /** Wall clock in ms (the day of a call is its UTC date). */
  now?: () => number;
}

/** The spent amount read from the table, with this process's flushed amounts at the moment the read started. */
interface Spent { at: number; day: string; dayMicros: number; monthMicros: number; base: Map<string, number> }

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** In-process aggregation of model usage → `model_usage_daily` (see the head of the file); the budget check. */
export class UsageRecorder implements UsageSink, BudgetSource {
  private readonly o: Required<Omit<UsageRecorderOptions, "retention">> & { retention: boolean };
  private sums = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private off = false;
  private dropped = 0;
  private sweptAt: number | null = null;
  /** Money this process counted, per UTC day (flushed or not), and the part of it written to the table — in millionths. */
  private recorded = new Map<string, number>();
  private flushedCost = new Map<string, number>();
  private spent: Spent | null = null;
  private spentFailedAt: number | null = null;
  private reading: Promise<void> | null = null;
  /** Periods already warned about in the log (`kind:period:day-or-month`). */
  private told = new Set<string>();

  constructor(o: UsageRecorderOptions) {
    this.o = { flushMs: USAGE_FLUSH_MS, maxKeys: USAGE_MAX_KEYS, now: () => Date.now(), retention: false, ...o };
  }

  /** false after the table was found missing: nothing is counted until the process restarts. */
  get enabled(): boolean { return !this.off; }

  /** Count one exchange of `c`. Synchronous; never throws. */
  record(c: ModelConnection, u: ModelUsageReport): void {
    if (this.off) return;
    try {
      const endpoint = usageEndpoint(c), model = keyText(c.model, NAME_MAX);
      const n = usageCounts(u, priceFor(this.o.settings.get<unknown>("models.prices", []), endpoint, c.model));
      const k = { day: new Date(this.o.now()).toISOString().slice(0, 10), role: c.role, endpoint, model, stage: keyText(u.stage, STAGE_MAX) };
      // the money counts for the budget at once, also when the key cap drops the row: it was spent
      if (n.costMicros > 0) this.recorded.set(k.day, Math.min((this.recorded.get(k.day) ?? 0) + n.costMicros, SUM_MAX));
      const id = keyOf(k);
      const hit = this.sums.get(id);
      if (hit) { add(hit.n, n); return; }
      if (this.sums.size >= this.o.maxKeys) {
        // full: write now rather than in up to 10 s; this call's usage is dropped and counted in the next warning
        if (this.dropped++ === 0) void this.flush().catch(() => undefined);
        return;
      }
      this.sums.set(id, { ...k, n });
    } catch (e) {
      log.warn("model_usage_record_failed", { error: errText(e) });
    }
  }

  /** Flush every `flushMs` (the timer does not keep the process alive). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush().catch(() => undefined), this.o.flushMs);
    this.timer.unref?.();
  }

  /** Stop the timer and write what is left (process shutdown). */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }

  /** Write the sums held in memory. One flush at a time: a call during a flush waits for it and flushes again. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    this.flushing = this.write().finally(() => { this.flushing = null; });
    await this.flushing;
  }

  private async write(): Promise<void> {
    if (this.dropped) {
      log.warn("model_usage_keys_dropped", { calls: this.dropped, max_keys: this.o.maxKeys });
      this.dropped = 0;
    }
    if (this.off) return;
    if (this.sums.size) {
      const batch = this.sums;
      this.sums = new Map();
      // one lock order for every process: two flushes of the same keys never wait on each other in a cycle
      const rows = [...batch.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
      for (let done = 0; done < rows.length; done += FLUSH_CHUNK) {
        const chunk = rows.slice(done, done + FLUSH_CHUNK);
        try { await this.upsert(chunk); this.flushedOf(chunk); continue; }
        catch (e) {
          if (tableMissing(e)) { this.disable(); return; }
          if (!rowRefused(e)) { this.putBack(rows.slice(done), e); return; }
        }
        // a row of this chunk is refused for its data: write the chunk row by row so that only that row is lost
        for (let i = 0; i < chunk.length; i++) {
          const row = chunk[i]!;
          try { await this.upsert([row]); this.flushedOf([row]); }
          catch (e) {
            if (tableMissing(e)) { this.disable(); return; }
            if (!rowRefused(e)) { this.putBack([...chunk.slice(i), ...rows.slice(done + FLUSH_CHUNK)], e); return; }
            log.warn("model_usage_row_dropped", { error: errText(e), code: sqlState(e), role: row.role, endpoint: row.endpoint, day: row.day, calls: row.n.calls });
          }
        }
      }
    }
    await this.sweep();
  }

  /** The money of rows now in the table: no longer this process's own unflushed amount once the table is read again. */
  private flushedOf(rows: Entry[]): void {
    for (const r of rows) if (r.n.costMicros > 0) this.flushedCost.set(r.day, Math.min((this.flushedCost.get(r.day) ?? 0) + Math.round(r.n.costMicros), SUM_MAX));
  }

  // ------------------------------------------------------------ the budget

  /** The spent limit by the cached amount; a stale amount is read again in the background. No limit set — nothing is read. */
  budgetBlock(): BudgetPeriod | null {
    const b = readBudget(this.o.settings);
    if (!b || this.off) return null;
    if (this.stale()) void this.readSpent().catch(() => undefined);
    return this.evaluate(b).exhausted;
  }

  /** The spent limit after reading the table when the cached amount is older than `BUDGET_CACHE_MS`. No limit — no read. */
  async budgetFresh(): Promise<BudgetPeriod | null> {
    const b = readBudget(this.o.settings);
    if (!b || this.off) return null;
    if (this.stale()) await this.readSpent();
    if (this.off) return null;
    return this.evaluate(b).exhausted;
  }

  /** The budget now, for health and the panel; null — no limit set. Does not wait: a stale amount is read in the background. */
  budgetState(): BudgetState | null {
    const b = readBudget(this.o.settings);
    if (!b) return null;
    if (!this.off && this.stale()) void this.readSpent().catch(() => undefined);
    if (this.off) return { enforced: false, unenforced: "table_missing", exhausted: null, warning: null, currency: b.currency, daily: b.daily, monthly: b.monthly, day: dayOf(this.o.now()), spent_day: 0, spent_month: 0, read_at: null };
    return this.evaluate(b);
  }

  /** The cached amount is missing, older than the cache time, from a clock set back, or of another UTC day. */
  private stale(): boolean {
    const now = this.o.now();
    if (this.spentFailedAt !== null && now - this.spentFailedAt >= 0 && now - this.spentFailedAt < SPENT_RETRY_MS) return false;
    const s = this.spent;
    return !s || now - s.at < 0 || now - s.at >= BUDGET_CACHE_MS || s.day !== dayOf(now);
  }

  /** One read of the table at a time; a failure keeps the last amount and is not repeated for `SPENT_RETRY_MS`. */
  private readSpent(): Promise<void> {
    this.reading ??= this.queryTable().finally(() => { this.reading = null; });
    return this.reading;
  }

  private async queryTable(): Promise<void> {
    const now = this.o.now(), day = dayOf(now), month = `${day.slice(0, 7)}-01`;
    // the flushed amounts at the start of the read: a flush that ends during the read may be counted twice until the next
    // read (more, never less: the limit errs on the side of stopping)
    const base = new Map(this.flushedCost);
    try {
      const r = await this.o.db.query(SPENT_SQL, [this.o.instanceId, day, month]);
      const row = r.rows?.[0] ?? {};
      const dayMicros = Number(row.day_micros ?? 0), monthMicros = Number(row.month_micros ?? 0);
      this.spent = { at: now, day, dayMicros: Number.isFinite(dayMicros) ? dayMicros : 0, monthMicros: Number.isFinite(monthMicros) ? monthMicros : 0, base };
      this.spentFailedAt = null;
      // days before this month are of no budget any more
      for (const m of [this.recorded, this.flushedCost, this.spent.base]) for (const d of [...m.keys()]) if (d < month) m.delete(d);
      for (const t of [...this.told]) { const [, period, at] = t.split(":"); if (at !== (period === "daily" ? day : day.slice(0, 7))) this.told.delete(t); }
    } catch (e) {
      if (tableMissing(e)) { this.disable(); return; }
      this.spentFailedAt = now;
      log.warn("model_budget_read_failed", { error: errText(e) });
    }
  }

  /** The spent amounts (table + own unflushed money) against the limits; logs a warning once per period. */
  private evaluate(b: ModelBudget): BudgetState {
    const now = this.o.now(), day = dayOf(now), month = day.slice(0, 7);
    const s = this.spent;
    let ownDay = 0, ownMonth = 0;
    for (const [d, v] of this.recorded) {
      if (!d.startsWith(month)) continue;
      const own = Math.max(0, v - (s?.base.get(d) ?? 0));
      ownMonth += own;
      if (d === day) ownDay += own;
    }
    const dayMicros = (s && s.day === day ? s.dayMicros : 0) + ownDay;
    const monthMicros = (s && s.day.startsWith(month) ? s.monthMicros : 0) + ownMonth;
    const spentMonth = monthMicros / 1e6, spentDay = dayMicros / 1e6;
    const over = (spentAmount: number, limit: number | null) => limit !== null && spentAmount >= limit;
    const near = (spentAmount: number, limit: number | null) => limit !== null && spentAmount >= limit * b.warn_ratio;
    const exhausted: BudgetPeriod | null = over(spentMonth, b.monthly) ? "monthly" : over(spentDay, b.daily) ? "daily" : null;
    const warning: BudgetPeriod | null = exhausted ? null : near(spentMonth, b.monthly) ? "monthly" : near(spentDay, b.daily) ? "daily" : null;
    // the last read failed and none of this UTC day succeeded: the installation's amount is unknown, so the limit is not
    // enforced (only this process's own money can still stop a call) — told in health, not only in the log
    const unread = this.spentFailedAt !== null && (!s || s.day !== day) && !exhausted;
    const st: BudgetState = { enforced: !unread, ...(unread ? { unenforced: "read_failed" as const } : {}), exhausted, warning, currency: b.currency,
                              daily: b.daily, monthly: b.monthly, day, spent_day: spentDay, spent_month: spentMonth, read_at: s ? new Date(s.at).toISOString() : null };
    const flag = exhausted ? "exhausted" : warning ? "warning" : null, period = exhausted ?? warning;
    if (flag && period) {
      const key = `${flag}:${period}:${period === "daily" ? day : month}`;
      if (!this.told.has(key)) {
        this.told.add(key);
        log.warn(flag === "exhausted" ? "model_budget_exhausted" : "model_budget_warning",
                 { period, limit: period === "daily" ? b.daily : b.monthly, spent: period === "daily" ? spentDay : spentMonth, currency: b.currency, day });
      }
    }
    return st;
  }

  /** The rows not written come back and go with the next flush (a failure that may pass: connection, lock, permission). */
  private putBack(rows: Entry[], e: unknown): void {
    for (const r of rows) this.merge(r);
    log.warn("model_usage_flush_failed", { error: errText(e), keys: rows.length });
  }

  /** The table is missing: one warning, nothing held, nothing counted from now on. */
  private disable(): void {
    if (this.off) return;
    this.off = true;
    this.sums.clear();
    log.warn("model_usage_table_missing", { hint: "model usage is not counted: apply contracts/schema/17-basic-tails.sql (part [MU])" });
  }

  /** A row that comes back: added to its key, or kept as a new key while the cap allows (else dropped and counted). */
  private merge(r: Entry): void {
    const id = keyOf(r);
    const hit = this.sums.get(id);
    if (hit) add(hit.n, r.n);
    else if (this.sums.size < this.o.maxKeys) this.sums.set(id, r);
    else this.dropped += r.n.calls;
  }

  private async upsert(rows: Entry[]): Promise<void> {
    const params: unknown[] = [this.o.instanceId, rows.map((r) => r.day), rows.map((r) => r.role), rows.map((r) => r.endpoint), rows.map((r) => r.model), rows.map((r) => r.stage)];
    for (const f of FIELDS) params.push(rows.map((r) => String(Math.round(r.n[f]))));
    await this.o.db.query(UPSERT, params);
  }

  /** The gateway's recorder: days older than `models.usage_retention_days` (UTC) are deleted at most once a day. */
  private async sweep(): Promise<void> {
    if (!this.o.retention) return;
    const now = this.o.now();
    if (this.sweptAt !== null && now - this.sweptAt >= 0 && now - this.sweptAt < RETENTION_EVERY_MS) return;
    this.sweptAt = now;
    const days = this.o.settings.get<unknown>("models.usage_retention_days", USAGE_RETENTION_DAYS);
    const keep = retentionValid(days) ? days : USAGE_RETENTION_DAYS;
    try {
      await this.o.db.query("DELETE FROM model_usage_daily WHERE instance_id = $1 AND day < $2::date - $3::int",
                            [this.o.instanceId, new Date(now).toISOString().slice(0, 10), keep]);
    } catch (e) {
      if (tableMissing(e)) { this.disable(); return; }
      this.sweptAt = null;
      log.warn("model_usage_retention_failed", { error: errText(e) });
    }
  }
}
