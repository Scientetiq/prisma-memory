// External entity lookup of the entities stage. A mention of a
// company, a deal or another kind that the registry does not know is looked up in the active instance-scope connectors
// whose kind can look it up (`capabilities.entity_lookup`), in creation order; their hits are concatenated, and the stage
// links only when the total is exactly one.
//
// Default deny: no active connector — status "none", no client is built, no socket opens. The
// only way to the network is ConnectorCtx.http, built in exactly one function, lookupCtx() below, with the unchanged
// egress client: the origin of the connector's configured URL, the private networks of the installation read on every
// request, no redirects, 1 MiB, 20 s and the stage's abort signal.
//
// Outcomes: a failure a retry may fix (network, timeout, HTTP 404/5xx, a tool error, the control database while the
// secrets are read) throws EntityResolverError — the stage fails and is retried, earlier links stay. A configuration failure (a refused address, an unreadable or missing
// secret, an invalid config or system code, HTTP 401/403) sets the connector to `error` once (one audit event on that
// transition), the cache of targets is dropped at once, and the lookup answers "unavailable": the stage marks the rest of
// the record's mentions lookup_unavailable without calls and finishes. Logged per call: connector id, entity kind, code,
// hits, ms, and on a refusal the host — never the URL path or query, the mention, headers, bodies or vendor texts.
import {
  allowedOrigins, applyConfigDefaults, auditConnectorPaused, bindDiag, ConnectorError, ConnectorSecretError, createEgressClient, createRedactor, EgressError,
  entitySystemRefusal, EntityResolverError, isConfigErrorCode, loadConnectorSecrets, lookupQuery,
  validateConfig, BUILTIN_PACKS, ENTITY_KINDS, type Connector, type ConnectorAuditEvent, type ConnectorCtx, type ConnectorRegistry, type EgressClient,
  type EgressOptions, type EntityHit, type EntityKind, type Queryable,
} from "@memory/connectors";
import { builtinConnectors } from "@memory/connectors";
import { log } from "@memory/shared";
import { auditWorker, type DbCtx } from "../ctx.ts";
import type { SettingsKeyring } from "@memory/shared/crypto";

/** How long the list of active lookup connectors is trusted. */
export const LOOKUP_TARGETS_MS = 60_000;
/** Hits one lookup asks each connector for. */
export const LOOKUP_LIMIT = 5;
/** Time of one lookup call. */
export const LOOKUP_TIMEOUT_MS = 20_000;
/** Body cap of one lookup answer. */
export const LOOKUP_MAX_BYTES = 1_048_576;
export interface SettingsLike { get<T>(path: string, fallback: T): T }

export interface LookupDeps {
  instanceId: string;
  /** The control database as memory_worker. */
  db: Queryable;
  settings: SettingsLike;
  keyring: SettingsKeyring;
  /** The registry of this build for the enabled packs. */
  registry: () => ConnectorRegistry;
  audit: (e: ConnectorAuditEvent<"processing">) => Promise<void>;
  /** Tests only: the egress client (default: the real client with the options of lookupCtx). */
  egress?: (o: EgressOptions) => EgressClient;
  /** Tests only: the clock of the targets cache. */
  now?: () => number;
}

export interface LookupHit { connectorId: string | null; system: string; id: string; title: string }
export type LookupResult = { status: "none" } | { status: "hits"; hits: LookupHit[] } | { status: "unavailable"; code: string };

export interface ExternalLookup {
  resolve(kind: string, name: string, o?: { signal?: AbortSignal }): Promise<LookupResult>;
}

interface TargetRow { id: string; name: string; kind: string; pack: string | null; scope: string; config: unknown }

/** A connector ready to look up: its kind, config with defaults and secrets. */
interface Target {
  id: string;
  name: string;
  kind: string;
  scope: string;
  connector: Connector<Record<string, unknown>>;
  config: Record<string, unknown>;
  secret: (name: string) => string | null;
  values: string[];
}

const TARGETS_SQL = `SELECT id, name, kind, pack, scope, config FROM connectors
                      WHERE instance_id = $1 AND status = 'active' AND scope = 'instance' AND kind = ANY($2::text[])
                      ORDER BY created_at, id`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isKind = (k: string): k is EntityKind => (ENTITY_KINDS as readonly string[]).includes(k);

/** True when a connector of this config looks up the kind: a config with a `lookup` object lists the kinds it serves. */
function servesKind(config: Record<string, unknown>, kind: string): boolean {
  const l = config.lookup;
  return !isObject(l) || isObject(l[kind]);
}

/** The code of a failure (never its message). */
function codeOf(e: unknown): string {
  if (e instanceof EgressError || e instanceof ConnectorError || e instanceof ConnectorSecretError) return e.code;
  return "internal";
}

/**
 * The ConnectorCtx of one lookup — the only place that builds the lookup's egress client. State is read-only and empty;
 * log lines of the connector pass the SDK's rules and are redacted with its secrets.
 */
function lookupCtx(d: LookupDeps, t: Target, signal: AbortSignal | undefined): ConnectorCtx<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const opts: EgressOptions = {
    origins: allowedOrigins(t.connector.manifest, t.config),
    privateNetworks: () => d.settings.get<string[]>("integrations.connectors_private_networks", []),   // read on every request
    maxRedirects: 0,
    maxResponseBytes: LOOKUP_MAX_BYTES,
    signal: all,
  };
  const redact = createRedactor(t.values);
  // The connector's diagnostics through the wall of diag.ts, as the runner writes them — ids and kind bound here
  // from our own row and the registry, the closed schema of the event, redact.ts as the second layer
  const diag = bindDiag({ connectorId: t.id, kind: t.kind, registry: d.registry(), redact });
  return {
    config: t.config,
    secret: t.secret,
    http: (d.egress ?? createEgressClient)(opts),
    state: { get: async () => ({}), set: async () => { throw new ConnectorError("state_readonly"); } },
    log: (event: unknown, fields?: unknown) => { diag.connector(event, fields); },
    signal: all,
    now: () => new Date(),
  };
}

export function createExternalLookup(d: LookupDeps): ExternalLookup {
  const now = d.now ?? Date.now;
  let cached: { at: number; rows: TargetRow[] } | null = null;

  const targets = async (reg: ConnectorRegistry): Promise<TargetRow[]> => {
    const t = now();
    if (cached && t - cached.at < LOOKUP_TARGETS_MS && t >= cached.at) return cached.rows;
    const kinds = [...reg.kinds.values()].filter((c) => (c.manifest.capabilities.entity_lookup ?? []).length > 0).map((c) => c.manifest.kind);
    const rows = kinds.length ? ((await d.db.query(TARGETS_SQL, [d.instanceId, kinds])).rows as TargetRow[]) : [];
    cached = { at: t, rows };
    return rows;
  };

  /** Sets the connector to error once; one audit event on that transition. */
  const pause = async (t: { id: string; kind: string; scope: string }, code: string): Promise<void> => {
    cached = null;
    const r = await d.db.query("UPDATE connectors SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'active'", [t.id, code]);
    if (r.rowCount) await d.audit(auditConnectorPaused({ id: t.id, kind: t.kind, scope: t.scope }, code)).catch(() => undefined);
  };

  /** Kind, config and secrets of a connector row; a ConnectorError with a configuration code when one is not usable. */
  const prepare = async (reg: ConnectorRegistry, row: TargetRow): Promise<Target> => {
    const connector = reg.kinds.get(row.kind) as Connector<Record<string, unknown>> | undefined;
    if (!connector) throw new ConnectorError("kind_unknown");
    const m = connector.manifest;
    if (validateConfig(m, row.config).length > 0) throw new ConnectorError("config_invalid");
    const config = applyConfigDefaults(m, row.config as Record<string, unknown>);
    if ((connector.validate?.(config) ?? []).length > 0) throw new ConnectorError("config_invalid");
    const refused = entitySystemRefusal(config.system, row.pack, BUILTIN_PACKS);
    if (refused) throw new ConnectorError(refused);
    const secrets = await loadConnectorSecrets(d.db, d.keyring, row.id);
    const own = new Set(m.secrets.map((s) => s.name));
    if (secrets.unreadable().some((n) => own.has(n))) throw new ConnectorError("secret_unreadable");
    const names = new Set(secrets.names());
    if (m.secrets.some((s) => s.required && !names.has(s.name))) throw new ConnectorError("secret_missing");
    const values = [...own].filter((n) => names.has(n)).map((n) => secrets.get(n)).filter((v): v is string => typeof v === "string");
    return { id: row.id, name: row.name, kind: row.kind, scope: row.scope, connector, config, values, secret: (n) => (own.has(n) && names.has(n) ? secrets.get(n) : null) };
  };

  const logCall = (t: { id: string }, kind: string, code: string, hits: number, t0: number, host?: string | null): void => {
    log.info("entity_lookup", { connector_id: t.id, entity_kind: kind, code, hits, ms: Date.now() - t0, ...(host ? { host } : {}) });
  };

  return {
    async resolve(kind, name, o = {}) {
      if (!isKind(kind)) return { status: "none" };
      const query = lookupQuery(name);
      if (query === "") return { status: "none" };
      const enabledPacks = new Set(d.settings.get<string[]>("integrations.connectors_packs", []));
      const reg = d.registry();
      const rows = (await targets(reg)).filter((r) => {
        const c = reg.kinds.get(r.kind);
        return Boolean(c?.manifest.capabilities.entity_lookup?.includes(kind)) && servesKind(isObject(r.config) ? r.config : {}, kind);
      });
      if (rows.length === 0) return { status: "none" };
      const hits: LookupHit[] = [];
      let asked = 0;
      for (const item of rows) {
        const t0 = Date.now();
        if (item.pack !== null && !enabledPacks.has(item.pack)) {
          logCall(item, kind, "pack_disabled", 0, t0);
          continue;
        }
        let t: Target;
        try {
          t = await prepare(reg, item);
        } catch (e) {
          const code = codeOf(e);
          logCall(item, kind, code, 0, t0);
          // only a configuration failure stops the connector; anything else (the control database while the secrets are
          // read) is a failure a retry may fix
          if (!isConfigErrorCode(code)) throw new EntityResolverError(item.name, code);
          await pause(item, code);
          return { status: "unavailable", code };
        }
        asked++;
        let found: EntityHit[];
        try {
          found = await t.connector.lookup!(lookupCtx(d, t, o.signal), kind, query, LOOKUP_LIMIT);
        } catch (e) {
          const code = codeOf(e);
          logCall(t, kind, code, 0, t0, e instanceof EgressError ? e.host : null);
          if (isConfigErrorCode(code)) {
            await pause(t, code);
            return { status: "unavailable", code };
          }
          throw new EntityResolverError(t.name, code);
        }
        const valid = (Array.isArray(found) ? found : []).slice(0, LOOKUP_LIMIT).filter((h) => h && h.kind === kind && typeof h.id === "string" && typeof h.name === "string");
        logCall(t, kind, "ok", valid.length, t0);
        const system = typeof t.config.system === "string" ? t.config.system : "";
        for (const h of valid) hits.push({ connectorId: t.id, system, id: h.id, title: h.name });
      }
      // every target skipped (packs switched off): nothing was asked — as if there were no connector
      if (asked === 0) return { status: "none" };
      return { status: "hits", hits };
    },
  };
}

/** The registry of this build for the packs listed in integrations.connectors_packs (rebuilt when the list changes). */
function packRegistry(settings: SettingsLike): () => ConnectorRegistry {
  let key = "", reg: ConnectorRegistry | null = null;
  return () => {
    const packs = settings.get<string[]>("integrations.connectors_packs", []);
    const list = Array.isArray(packs) ? packs.filter((p): p is string => typeof p === "string") : [];
    const k = JSON.stringify(list);
    if (!reg || k !== key) { reg = builtinConnectors(list); key = k; }
    return reg;
  };
}

/** The external lookup of the worker process (one call in index.ts): the control database, the settings, the keyring. */
export function workerExternalLookup(ctx: DbCtx, keyring: SettingsKeyring): ExternalLookup {
  return createExternalLookup({
    instanceId: ctx.instanceId, db: ctx.db.control, settings: ctx.settings, keyring, registry: packRegistry(ctx.settings),
    audit: (e) => auditWorker(ctx, { event_type: e.event_type, details: e.details }),
  });
}
