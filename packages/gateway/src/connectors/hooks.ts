// The hooks routes of connectors (contract `connectors` 1.0.0): external systems push items
// to a connector of the generic `webhook` kind, signed by the Standard Webhooks scheme (or, when the administrator
// switched it on, with a bearer push token). The routes are registered before the key middleware and have their own
// body limit; everything else under /api/v1/hooks answers the same 404.
//
//   POST /api/v1/hooks/{connector_id}                          1–50 items → staged (202), or a duplicate event (200)
//   GET  /api/v1/hooks/{connector_id}/items/{external_id}?type=  the state of one item, never its content
//
// Order of a POST (each step ends the request):
//  0. without the database: the switches, the shape of the id, the per-address limit;
//  1. the connector from a snapshot of active connectors (one statement, reloaded at most every 2 s on a miss and every
//     10 s otherwise: a flood of random ids costs no queries and the process keeps no per-id memory); a kind that takes
//     Standard Webhooks and has no vendor parser of its own; then the instance health;
//  2. the limit per (connector, address) before authentication — a stranger who knows the id cannot starve the sender;
//  3. the declared body size;
//  4. the signature (headers first, then the raw body read up to the limit, then the secrets), or the push token; the
//     limit per connector counts verified requests only;
//  5. replay: the event row (connector, webhook-id) is written only after a valid signature; `queued`/`done` → 200;
//     `received`/`failed` → processed again (a crash or a corrected body);
//  6. parsing and the contract schemas (at most five problems by JSON pointer, keywords in the JSON Schema spelling);
//     a string or key PostgreSQL cannot store (a NUL, a lone surrogate) is a problem too;
//  7. the backlog bound: staged and delivering items of the connector plus the record items of this request that would
//     add to them (a request that alone is over the ceiling → 400, it can never fit);
//  8. staging: record items through stageRecordItem (body to the closed bucket first, the row second), deletions of
//     record items marked deleted_at_source, entity items through one upsertEntityBatch, entity deletions through one
//     markEntitiesDeleted;
//  9. the event becomes `queued`, then 202 — a crash before that leaves it `received` and the sender's retry resumes.
//
// Answers carry fixed English texts and the codes of the contract only; audit events carry ids and codes; no secret,
// header value or body byte is logged. The handler catches everything itself: nothing reaches the router's error
// handler.
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  auditConnectorRun, auditWebhookRefused, builtinConnectors, checkWebhookHeaders, ConnectorSecretError, itemHashBytes, loadConnectorSecrets, markEntitiesDeleted,
  MAX_FILE_BYTES, PUSH_TOKEN_SECRET, stageRecordItem, upsertEntityBatch, validateItem, verifyPushToken, verifyStandardWebhook, WEBHOOK_SIGNING_SECRET,
  type ConnectorRef, type ConnectorRegistry, type EntityItem, type Problem, type RecordItem, type WebhookRefusalCode,
} from "@memory/connectors";
import { log } from "@memory/shared";
import { audit } from "../audit.ts";
import type { App } from "../context.ts";
import { healthState } from "../health.ts";
import { wakeDelivery } from "./deliver.ts";
import { connectorKeyring } from "./keyring.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIB = 1024 * 1024;
const RECORD_TYPES = new Set(["document", "meeting", "note"]);
const STATE_TYPES = new Set(["document", "meeting", "note", "entity"]);
/** Snapshot of active connectors: reloaded when older than this. */
export const HOOK_SNAPSHOT_MAX_AGE_MS = 10_000;
/** … and on an unknown id only when older than this. */
export const HOOK_SNAPSHOT_MISS_AGE_MS = 2_000;
/** Requests per minute: per source address, per (connector, address) before authentication, per connector after it. */
export const HOOK_LIMITS = { hook_ip: 120, hook_pre: 60, hook: 60, hook_audit: 10 } as const;
const MAX_PROBLEMS = 5;
const MAX_ITEMS = 50;

const NOT_FOUND = { code: "not_found", message: "Not found." } as const;
const UNAUTHORIZED = { code: "unauthorized", message: "The request is not authenticated." } as const;
const TOO_LARGE = { code: "too_large", message: "The request body is too large." } as const;
const UNAVAILABLE = { code: "internal", message: "The service is temporarily unavailable.", retry_after: 60 } as const;
const INVALID = "The request body does not match the connectors contract.";

/** Fault injection points of the tests (a crash between the steps). */
export type HookFaultPoint = "after_received" | "after_staged" | "before_queued";
export interface HookOptions {
  /** Clock of the snapshot and the signature window (tests). */
  now?: () => number;
  fault?: (at: HookFaultPoint) => void | Promise<void>;
}

// ---------------------------------------------------------------- snapshot of active connectors

interface HookConnector { id: string; kind: string; scope: string }
interface Snapshot { instance: string; at: number; byId: Map<string, HookConnector> }
let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
let generation = 0;

/** Forgets the snapshot (a connector was paused, resumed, revoked or deleted: the admin API calls this). */
export function invalidateHookConnectors(): void {
  snapshot = null;
  generation++;
}

/** Connectors in the snapshot (tests: the snapshot holds the active connectors only, never refused ids). */
export const hookSnapshotSize = (): number => snapshot?.byId.size ?? 0;

async function loadSnapshot(app: App, now: number): Promise<Snapshot> {
  if (loading) return loading;
  const gen = generation;
  loading = (async () => {
    const { rows } = await app.db.control.query("SELECT id, kind, scope FROM connectors WHERE instance_id = $1 AND status = 'active'", [app.instanceId]);
    const byId = new Map<string, HookConnector>();
    for (const r of rows as HookConnector[]) byId.set(String(r.id), { id: String(r.id), kind: String(r.kind), scope: String(r.scope) });
    // invalidated while loading: the rows may be older than the change — the next request loads again
    const s: Snapshot = { instance: app.instanceId, at: gen === generation ? now : -Infinity, byId };
    snapshot = s;
    return s;
  })().finally(() => { loading = null; });
  return loading;
}

async function activeConnector(app: App, id: string, now: number): Promise<HookConnector | null> {
  let s = snapshot;
  if (!s || s.instance !== app.instanceId || now - s.at >= HOOK_SNAPSHOT_MAX_AGE_MS || now < s.at) s = await loadSnapshot(app, now);
  const hit = s.byId.get(id);
  if (hit) return hit;
  if (now - s.at < HOOK_SNAPSHOT_MISS_AGE_MS) return null;
  return (await loadSnapshot(app, now)).byId.get(id) ?? null;
}

const registries = new Map<string, ConnectorRegistry>();
function registryFor(packs: unknown): ConnectorRegistry {
  const list = Array.isArray(packs) ? packs.filter((p): p is string => typeof p === "string") : [];
  const key = JSON.stringify(list);
  let r = registries.get(key);
  if (!r) {
    r = builtinConnectors(list);
    if (registries.size > 16) registries.clear();
    registries.set(key, r);
  }
  return r;
}

/** The kind takes Standard Webhooks and has no vendor parser (vendor events are a separate task). */
function eligible(app: App, c: HookConnector): boolean {
  const kind = registryFor(app.settings.get<unknown>("integrations.connectors_packs", [])).kinds.get(c.kind);
  return !!kind && kind.manifest.capabilities.webhook === "standard_webhooks" && typeof kind.parseWebhook !== "function";
}

// ---------------------------------------------------------------- helpers

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const bodyMax = (app: App): number => Math.floor(clamp(app.settings.get<unknown>("integrations.webhooks_max_body_mb", 8), 1, 32, 8) * MIB);
const toleranceSec = (app: App): number => Math.floor(clamp(app.settings.get<unknown>("integrations.webhooks_tolerance_sec", 300), 60, 900, 300));
const retrySec = (s: number): number => Math.max(1, Math.ceil(s));

function tooMany(c: Context, retryAfter: number, extra: Record<string, unknown> = {}): Response {
  const n = retrySec(retryAfter);
  return c.json({ code: "rate_limited", message: "Too many requests.", ...extra, retry_after: n }, 429, { "Retry-After": String(n) });
}
const notFound = (c: Context): Response => c.json(NOT_FOUND, 404);

/** The request body, at most max bytes: the declared length is checked before reading, the real one while reading. null — larger. */
async function readCapped(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

class Ended { constructor(readonly res: Response) {} }

let suppressed = 0;

// ---------------------------------------------------------------- the common front of both routes

interface Front { connector: HookConnector; ref: ConnectorRef; ip: string | null; mode: "signature" | "bearer"; eventId: string | null }

/**
 * Steps 0–4 shared by both routes. Throws Ended with the answer when the request stops; `readBody` — the POST reads the
 * raw body (signature over it), the GET verifies over the empty body and never reads the request body.
 */
async function front(app: App, c: Context, clientIp: (c: Context) => Promise<string | null>, now: () => number, readBody: boolean): Promise<Front & { body: Buffer }> {
  // 0. no database
  if (app.settings.get<unknown>("integrations.webhooks_enabled", false) !== true || app.settings.get<unknown>("integrations.connectors_enabled", true) === false)
    throw new Ended(notFound(c));
  const id = c.req.param("connector_id") ?? "";
  if (!UUID.test(id)) throw new Ended(notFound(c));
  const ip = await clientIp(c);
  const byIp = app.limiter.takeAnonymous("hook_ip", ip ?? "unknown", HOOK_LIMITS.hook_ip);
  if (byIp) {
    if (byIp.firstRefusal) log.warn("connector_hook_rate_limited", { scope: "address" });
    throw new Ended(tooMany(c, byIp.retryAfter));
  }
  // 1. the connector
  const connector = await activeConnector(app, id, now());
  if (!connector || !eligible(app, connector)) throw new Ended(notFound(c));
  if ((await healthState(app)).status === "fail_closed") throw new Ended(c.json(UNAVAILABLE, 503));
  const ref: ConnectorRef = { id: connector.id, kind: connector.kind, scope: connector.scope };
  // 2. per (connector, address), before authentication
  const pre = app.limiter.takeAnonymous("hook_pre", `${id}|${ip ?? "unknown"}`, HOOK_LIMITS.hook_pre);
  if (pre) throw new Ended(tooMany(c, pre.retryAfter));
  // 3. declared size
  const max = bodyMax(app);
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (readBody && Number.isFinite(declared) && declared > max) throw new Ended(c.json(TOO_LARGE, 413));

  const refuse = async (code: WebhookRefusalCode): Promise<never> => {
    // at most ten audit events per connector and minute: a flood of forged requests does not flood the journal
    if (!app.limiter.takeAnonymous("hook_audit", id, HOOK_LIMITS.hook_audit)) await audit(app, null, { ...auditWebhookRefused(ref, code), ip });
    else if (++suppressed % 100 === 1) log.warn("connector_hook_refusals_suppressed", { connector_id: id, count: suppressed });
    throw new Ended(c.json(UNAUTHORIZED, 401));
  };

  // 4a. mode and headers
  const signature = c.req.header("webhook-signature");
  let mode: "signature" | "bearer";
  let token: string | null = null;
  if (signature !== undefined) mode = "signature";
  else {
    const auth = c.req.header("authorization");
    // the scheme name is case-insensitive (RFC 9110 §11.1)
    const m = auth === undefined ? null : /^Bearer +([^\s]+)$/i.exec(auth);
    if (!m) return refuse("headers_missing");
    if (app.settings.get<unknown>("integrations.webhooks_shared_secret_enabled", false) !== true) return refuse("push_disabled");
    mode = "bearer";
    token = m[1]!;
  }
  const head = { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature, nowMs: now(), toleranceSec: toleranceSec(app) };
  if (mode === "signature") {
    const h = checkWebhookHeaders(head);
    if (!h.ok) return refuse(h.code);
  }
  // 4b. the raw body as received
  let body: Buffer = Buffer.alloc(0);
  if (readBody) {
    const b = await readCapped(c.req.raw, max);
    if (b === null) throw new Ended(c.json(TOO_LARGE, 413));
    body = b;
  }
  // 4c. secrets and verification
  let candidates: string[];
  try {
    candidates = (await loadConnectorSecrets(app.db.control, connectorKeyring(app), id)).candidates(mode === "signature" ? WEBHOOK_SIGNING_SECRET : PUSH_TOKEN_SECRET);
  } catch (e) {
    if (!(e instanceof ConnectorSecretError) || e.code !== "secret_unreadable") throw e;
    // Only an unreadable signing secret stops the connector: no signed delivery can verify without it. A bearer request
    // carries no credential checked yet, and the push token is the optional second mode — a damaged token row must not let
    // a stranger who knows the id stop a connector whose signed deliveries still work.
    if (mode === "bearer") {
      log.warn("connector_secret_unreadable", { connector_id: id, which: "push_token" });
      return refuse("secret_unreadable");
    }
    await app.db.control.query("UPDATE connectors SET status = 'error', last_error = 'secret_unreadable', updated_at = now() WHERE id = $1 AND status = 'active'", [id]);
    invalidateHookConnectors();
    log.warn("connector_secret_unreadable", { connector_id: id });
    return refuse("secret_unreadable");
  }
  if (candidates.length === 0) return refuse("secret_missing");
  let eventId: string | null = null;
  if (mode === "signature") {
    const v = verifyStandardWebhook({ ...head, secrets: candidates, body });
    if (!v.ok) return refuse(v.code);
    eventId = v.id;
  } else if (!verifyPushToken(candidates, token)) return refuse("push_token");
  // 4d. per connector, verified requests only
  const hit = app.limiter.takeAnonymous("hook", id, HOOK_LIMITS.hook);
  if (hit) {
    if (hit.firstRefusal) await audit(app, null, { event_type: "rate_limited", details: { op: "connector_webhook", connector_id: id }, ip });
    throw new Ended(tooMany(c, hit.retryAfter));
  }
  return { connector, ref, ip, mode, eventId, body };
}

// ---------------------------------------------------------------- one event at a time per (connector, event id)

const chains = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  try { return await run; } finally { if (chains.get(key) === tail) chains.delete(key); }
}

// ---------------------------------------------------------------- parsing

interface WireProblem { pointer: string; keyword: string }
type Parsed = { ok: true; items: Array<Record<string, unknown>> } | { ok: false; problems: WireProblem[] };

/** JSON Schema keywords by the lower-case form of the SDK's problem codes: answers use the spelling of the contract. */
const SCHEMA_KEYWORDS = new Map([
  "additionalItems", "additionalProperties", "allOf", "anyOf", "const", "contains", "dependentRequired", "dependentSchemas", "enum",
  "exclusiveMaximum", "exclusiveMinimum", "format", "if", "items", "maxContains", "maxItems", "maxLength", "maxProperties", "maximum",
  "minContains", "minItems", "minLength", "minProperties", "minimum", "multipleOf", "not", "oneOf", "pattern", "patternProperties",
  "prefixItems", "propertyNames", "required", "type", "unevaluatedItems", "unevaluatedProperties", "uniqueItems",
].map((k) => [k.toLowerCase(), k]));
const keywordOf = (code: string): string => {
  const k = code.includes(":") ? code.slice(code.indexOf(":") + 1) : code;
  return (SCHEMA_KEYWORDS.get(k) ?? k).slice(0, 64);
};
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pointerPart = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1");

/** Half of a surrogate pair without the other half (the JSON text may escape one: `"\ud800"`). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/**
 * The first string (or key) of a parsed item that PostgreSQL cannot store as text or jsonb: a NUL (`not`, as the
 * contract's one-line fields refuse control characters) or a lone surrogate (`surrogate`; stored, it would become
 * U+FFFD, so two ids that differ only there would merge into one item). null — none.
 */
function unstorable(v: unknown, at: string): WireProblem | null {
  const why = (s: string): string | null => (s.includes("\u0000") ? "not" : LONE_SURROGATE.test(s) ? "surrogate" : null);
  if (typeof v === "string") { const k = why(v); return k ? { pointer: at, keyword: k } : null; }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = unstorable(v[i], `${at}/${i}`); if (p) return p; }
    return null;
  }
  if (isPlain(v)) {
    for (const [key, x] of Object.entries(v)) {
      const here = `${at}/${pointerPart(key)}`, k = why(key);
      if (k) return { pointer: here, keyword: k };
      const p = unstorable(x, here);
      if (p) return p;
    }
  }
  return null;
}

function parseBody(body: Buffer, maxBytes: number): Parsed {
  let doc: unknown;
  try { doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return { ok: false, problems: [{ pointer: "", keyword: "json" }] }; }
  if (!isPlain(doc)) return { ok: false, problems: [{ pointer: "", keyword: "type" }] };
  const extra = Object.keys(doc).filter((k) => k !== "items");
  if (extra.length) return { ok: false, problems: extra.slice(0, MAX_PROBLEMS).map((k) => ({ pointer: `/${pointerPart(k)}`.slice(0, 512), keyword: "additionalProperties" })) };
  if (!("items" in doc)) return { ok: false, problems: [{ pointer: "", keyword: "required" }] };
  const items = doc.items;
  if (!Array.isArray(items)) return { ok: false, problems: [{ pointer: "/items", keyword: "type" }] };
  if (items.length < 1) return { ok: false, problems: [{ pointer: "/items", keyword: "minItems" }] };
  if (items.length > MAX_ITEMS) return { ok: false, problems: [{ pointer: "/items", keyword: "maxItems" }] };
  const problems: WireProblem[] = [];
  const keys = new Set<string>();
  items.forEach((item: unknown, i: number) => {
    if (problems.length >= MAX_PROBLEMS) return;
    const own: Problem[] = validateItem(item, { maxBytes });
    for (const p of own) problems.push({ pointer: `/items/${i}${p.path ?? ""}`.slice(0, 512), keyword: keywordOf(p.code) });
    if (own.length === 0 && isPlain(item)) {
      // the schemas passed (so the item is shallow and bounded): every string must also be storable
      const bad = unstorable(item, `/items/${i}`);
      if (bad) { problems.push({ pointer: bad.pointer.slice(0, 512), keyword: bad.keyword }); return; }
      const key = JSON.stringify([item.type === "delete" ? item.of : item.type, item.external_id]);
      if (keys.has(key)) problems.push({ pointer: `/items/${i}`, keyword: "duplicate" });
      keys.add(key);
    }
  });
  if (problems.length) return { ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
  return { ok: true, items: items as Array<Record<string, unknown>> };
}

// ---------------------------------------------------------------- staging

/**
 * Record items of a request that would add a row to the backlog (staged or delivering), by the rule of stageRecordItem:
 * an item whose row is already staged or being delivered is staged again in place, and the same content at a delivered
 * or unchanged item stays `unchanged` — neither adds to the backlog.
 */
async function joiningBacklog(app: App, connectorId: string, items: Array<Record<string, unknown>>): Promise<number> {
  if (items.length === 0) return 0;
  const { rows } = await app.db.control.query(
    "SELECT item_type, external_id, status, content_hash FROM connector_items WHERE connector_id = $1 "
    + "AND (item_type, external_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))",
    [connectorId, items.map((it) => String(it.type)), items.map((it) => String(it.external_id))]);
  const cur = new Map((rows as Array<{ item_type: string; external_id: string; status: string; content_hash: Buffer }>)
    .map((r) => [JSON.stringify([r.item_type, r.external_id]), r]));
  let n = 0;
  for (const it of items) {
    const r = cur.get(JSON.stringify([String(it.type), String(it.external_id)]));
    if (r && (r.status === "staged" || r.status === "delivering")) continue;
    if (r && (r.status === "delivered" || r.status === "unchanged")
        && Buffer.compare(Buffer.from(r.content_hash), itemHashBytes(it as unknown as RecordItem)) === 0) continue;
    n++;
  }
  return n;
}

interface ItemResult { external_id: string; type: string; status: string; reason?: string }

class StorageDown extends Error { constructor() { super("storage_unavailable"); } }

async function stageAll(app: App, connectorId: string, items: Array<Record<string, unknown>>, maxBytes: number):
    Promise<{ results: ItemResult[]; staged: number; entities: number; deleted: number }> {
  const results: Array<ItemResult | undefined> = new Array(items.length);
  let staged = 0, entities = 0, deleted = 0, changed = false;
  const put = async (key: string, body: Buffer): Promise<void> => {
    let ok: boolean;
    try { ok = await app.storage.put("closed", key, body, "application/octet-stream"); } catch { throw new StorageDown(); }
    if (!ok) throw new StorageDown();
  };
  const entityAt: number[] = [], entityItems: EntityItem[] = [];
  const entityDeleteAt: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const ext = String(item.external_id);
    if (RECORD_TYPES.has(String(item.type))) {
      const r = await stageRecordItem(app.db.control, put, connectorId, item as unknown as RecordItem, { maxBytes });
      if (!r.ok) { results[i] = { external_id: ext, type: String(item.type), status: "skipped", reason: "item_invalid" }; continue; }
      results[i] = { external_id: ext, type: String(item.type), status: r.status };
      if (r.changed) { staged++; changed = true; }
    } else if (item.type === "entity") {
      entityAt.push(i); entityItems.push(item as unknown as EntityItem);
    } else if (item.type === "delete" && item.of === "entity") {
      entityDeleteAt.push(i);
    } else if (item.type === "delete") {
      // what happens to the record is the connector's on_delete policy; here the item is only marked
      const { rows } = await app.db.control.query(
        "UPDATE connector_items SET status = 'deleted_at_source', reason = NULL, lease_until = NULL, next_attempt_at = NULL "
        + "WHERE connector_id = $1 AND item_type = $2 AND external_id = $3 RETURNING id", [connectorId, item.of, ext]);
      if (rows.length) { results[i] = { external_id: ext, type: String(item.of), status: "deleted_at_source" }; deleted++; }
      else results[i] = { external_id: ext, type: String(item.of), status: "skipped", reason: "unknown_item" };
    }
  }
  if (entityItems.length) {
    const r = await upsertEntityBatch(app.db.control, app.instanceId, connectorId, entityItems);
    r.items.forEach((o, n) => {
      results[entityAt[n]!] = { external_id: o.external_id, type: "entity", status: o.status, ...(o.reason ? { reason: o.reason } : {}) };
      if (o.status === "delivered") entities++;
    });
  }
  if (entityDeleteAt.length) {
    const ids = entityDeleteAt.map((i) => String(items[i]!.external_id));
    const r = await markEntitiesDeleted(app.db.control, app.instanceId, connectorId, ids);
    const known = r.refused ? new Set<string>() : new Set((await app.db.control.query(
      "SELECT external_id FROM connector_items WHERE connector_id = $1 AND item_type = 'entity' AND external_id = ANY($2::text[]) AND status = 'deleted_at_source'",
      [connectorId, ids])).rows.map((x: { external_id: string }) => x.external_id));
    for (const i of entityDeleteAt) {
      const ext = String(items[i]!.external_id);
      if (r.refused) results[i] = { external_id: ext, type: "entity", status: "skipped", reason: r.refused };
      else if (known.has(ext)) { results[i] = { external_id: ext, type: "entity", status: "deleted_at_source" }; deleted++; }
      else results[i] = { external_id: ext, type: "entity", status: "skipped", reason: "unknown_item" };
    }
  }
  if (changed) wakeDelivery();
  return { results: results as ItemResult[], staged, entities, deleted };
}

// ---------------------------------------------------------------- routes

/**
 * Registers the hooks routes (before the key middleware). `clientIp` — the client address of a request as the gateway
 * determines it (trusted proxies included).
 */
export function registerConnectorHooks(r: Hono<any>, app: App, clientIp: (c: Context) => Promise<string | null>, o: HookOptions = {}): void {
  const now = o.now ?? Date.now;
  const fault = async (at: HookFaultPoint): Promise<void> => { if (o.fault) await o.fault(at); };
  const guarded = (handler: (c: Context) => Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (e) {
      if (e instanceof Ended) return e.res;
      const code = e instanceof StorageDown ? "storage_unavailable" : typeof (e as { code?: unknown })?.code === "string" ? String((e as { code: string }).code).slice(0, 40) : "error";
      log.error("connector_hook_failed", { connector_id: UUID.test(c.req.param("connector_id") ?? "") ? c.req.param("connector_id") : "invalid", code });
      return c.json(UNAVAILABLE, 503);
    }
  };

  r.post("/api/v1/hooks/:connector_id", guarded(async (c) => {
    const f = await front(app, c, clientIp, now, true);
    const id = f.connector.id;
    const maxBytes = Math.min(app.settings.get<number>("limits.upload_max_bytes", 20_971_520), MAX_FILE_BYTES);
    const eventId = f.eventId ?? `push.${randomUUID()}`;
    const process = async (): Promise<Response> => {
      // 5. replay — signature mode only (a bearer request has no signed event id)
      if (f.mode === "signature") {
        const ins = await app.db.control.query(
          "INSERT INTO connector_events (connector_id, event_id, status) VALUES ($1, $2, 'received') ON CONFLICT DO NOTHING RETURNING status", [id, eventId]);
        if (!ins.rows.length) {
          const cur = (await app.db.control.query("SELECT status FROM connector_events WHERE connector_id = $1 AND event_id = $2", [id, eventId])).rows[0] as { status: string } | undefined;
          if (cur && (cur.status === "queued" || cur.status === "done")) return c.json({ event_id: eventId, duplicate: true }, 200);
        }
      }
      await fault("after_received");
      // 6. parse
      const parsed = parseBody(f.body, maxBytes);
      if (!parsed.ok) {
        if (f.mode === "signature")
          await app.db.control.query("UPDATE connector_events SET status = 'failed', last_error = 'invalid_argument' WHERE connector_id = $1 AND event_id = $2", [id, eventId]);
        return c.json({ code: "invalid_argument", message: INVALID, details: { problems: parsed.problems } }, 400);
      }
      // 7. backlog bound
      const joining = await joiningBacklog(app, id, parsed.items.filter((it) => RECORD_TYPES.has(String(it.type))));
      if (joining > 0) {
        const row = (await app.db.control.query(
          "SELECT (SELECT count(*) FROM connector_items WHERE connector_id = $1 AND status IN ('staged', 'delivering'))::int AS n, "
          + "(SELECT policy -> 'daily_items' FROM connectors WHERE id = $1) AS daily", [id])).rows[0] as { n: number; daily: unknown };
        const own = typeof row?.daily === "number" && Number.isSafeInteger(row.daily) && row.daily > 0 ? row.daily : null;
        const setting = app.settings.get<unknown>("integrations.connectors_daily_items", 1000);
        const ceiling = own ?? (typeof setting === "number" && Number.isFinite(setting) && setting > 0 ? Math.floor(setting) : 1000);
        // a request that alone is over the ceiling never fits: retrying cannot help, the sender splits it
        if (joining > ceiling) {
          if (f.mode === "signature")
            await app.db.control.query("UPDATE connector_events SET status = 'failed', last_error = 'invalid_argument' WHERE connector_id = $1 AND event_id = $2", [id, eventId]);
          return c.json({ code: "invalid_argument", message: INVALID, details: { problems: [{ pointer: "/items", keyword: "maxItems" }] } }, 400);
        }
        if (Number(row?.n ?? 0) + joining > ceiling)
          return tooMany(c, 3600, { message: "The daily quota of the connector is used up.", reason: "connector_quota:items" });
      }
      // 8. staging
      const out = await stageAll(app, id, parsed.items, maxBytes);
      await fault("after_staged");
      // 9. queued, then 202
      await fault("before_queued");
      if (f.mode === "signature")
        await app.db.control.query("UPDATE connector_events SET status = 'queued', items = $3, last_error = NULL WHERE connector_id = $1 AND event_id = $2", [id, eventId, parsed.items.length]);
      if (out.staged + out.entities + out.deleted > 0)
        await audit(app, null, { ...auditConnectorRun(f.ref, { run_id: randomUUID(), kind: "webhook", status: "ok", seen: parsed.items.length, staged: out.staged,
                                                               entities: out.entities, deleted: out.deleted }), ip: f.ip });
      return c.json({ event_id: eventId, items: out.results }, 202);
    };
    return f.mode === "signature" ? serial(`${id}:${eventId}`, process) : process();
  }));

  r.get("/api/v1/hooks/:connector_id/items/:external_id", guarded(async (c) => {
    // the item key, checked against the contract before anything else (no database)
    const type = c.req.query("type") ?? "";
    let externalId: string;
    try { externalId = c.req.param("external_id") ?? ""; } catch { return notFound(c); }
    if (!STATE_TYPES.has(type) || validateItem({ type: "delete", external_id: externalId, of: type }).length > 0) return notFound(c);
    const f = await front(app, c, clientIp, now, false);
    const row = (await app.db.control.query(
      "SELECT status, reason, record_id, version FROM connector_items WHERE connector_id = $1 AND item_type = $2 AND external_id = $3",
      [f.connector.id, type, externalId])).rows[0] as { status: string; reason: string | null; record_id: string | null; version: number } | undefined;
    if (!row) return notFound(c);
    return c.json({ external_id: externalId, type, status: row.status, ...(row.reason ? { reason: row.reason } : {}), ...(row.record_id ? { record_id: row.record_id } : {}),
                    version: Number(row.version ?? 0) }, 200, { "Cache-Control": "no-store" });
  }));

  // nothing else under the prefix reaches the key middleware (other methods, the bare prefix, deeper paths)
  r.all("/api/v1/hooks", (c) => notFound(c));
  r.all("/api/v1/hooks/*", (c) => notFound(c));
}
