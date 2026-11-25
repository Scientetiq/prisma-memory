import { adminStrictMode, agentAuthMode, deployProfile, publicAddress, auditLost, discoveryProblems, fetchDiscovery, groupStaleHours, ldapConfig, ldapProblems, nextModelKeys, oidcConfig, OidcFailure, oidcProblems, openCheckHealth, openCheckRunnerState, resolveTargets, withTimeout,
         type BudgetState, type OpenCheckRunnerState } from "@memory/shared";
import { alertChannelCheck } from "./ops-alerts-admin.ts";
import type { App } from "./context.ts";
import { mailHealth } from "./mail-admin.ts";
import { llmHealthCheck, stubMode } from "./llm-gate-admin.ts";
import { converterHealthCheck } from "./converter-admin.ts";
import { embeddingIndexCheck } from "./health-embedding.ts";
import { edgeExportCheck } from "./edge-export-admin.ts";
import { externalLoginCheck } from "./edge-admin.ts";
import { poolExhausted } from "./control-lock.ts";
import { oauthHealth } from "./oauth.ts";
import { agentAuthFacts, agentAuthRoutesServed } from "./agent-auth/readiness.ts";
import { cimdHealthNote } from "./agent-auth/cimd-fetch.ts";
import { externalHosts, normalizeHost, proxyHostsSeen, trustedProxies, untrustedProxiesSeen } from "./channel.ts";
import { processTopology } from "./admin-plane/listeners.ts";
import { diskGuardHealth } from "./limits.ts";
import { tlsLinksCheck } from "./health-tls.ts";
import { secretsSourceCheck } from "./health-secrets.ts";
import { localFactorHealth } from "./admin-plane/local-totp.ts";
import { firstProblem, legacyProbeNeeded, modelsCheck, modelsHealth, MODELS_AI_OFF_TEXT, type LegacyGatewayProbe, type ModelsHealth } from "./health-models.ts";
import type { StorageCheck } from "./storage.ts";
import { ftsIndexCheck } from "./health-fts.ts";
import { schemaCheck } from "./health-schema.ts";
import { originalStorageCheck } from "./original-storage.ts";
import { originalStateUnavailable } from "./original-storage.messages.ts";

export interface HealthState {
  status: "ok" | "degraded" | "fail_closed"; version: string; instance: string; checks: Record<string, { ok: boolean; detail?: string; level?: "ok" | "warn" | "fail" }>;
  open_check?: OpenCheckRunnerState;
}

export const version = (): string => (process.env.MEMORY_COMMIT ?? "").trim().slice(0, 40) || "unknown";

export interface HealthCache { at: number; state: HealthState; hard: boolean; soft: boolean }
let cached: HealthCache | null = null;
let inFlight: Promise<HealthState> | null = null;

export async function healthState(app: App, force = false): Promise<HealthState> {
  if (!force && cached && Date.now() - cached.at < 15_000) return withOpenCheck(cached);
  if (inFlight) return inFlight;
  inFlight = compute(app, force).finally(() => { inFlight = null; });
  return inFlight;
}

async function compute(app: App, force: boolean): Promise<HealthState> {
  await app.settings.load(force);
  const checks: HealthState["checks"] = {};
  const missing = app.settings.missingRequired();
  checks.settings = missing.length ? { ok: false, detail: `required settings are missing: ${missing.join(", ")}` } : { ok: true };
  let hard = missing.length > 0, soft = false;
  let activeEmbedder: string | null = null;
  try {
    const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
    for (const cls of ["open", "closed"] as const) {
      const v = (await app.db.records(cls, sys).query("SELECT current_setting('memory.class', true) AS c, has_table_privilege(current_user, 'records', 'DELETE') AS can_delete")).rows[0];
      const ok = v.c === cls && v.can_delete === false;
      checks[`db_${cls}`] = ok ? { ok } : { ok, detail: v.c !== cls ? `memory.class = ${v.c ?? "not set"}` : "the gateway role can permanently delete records" };
      hard ||= !ok;
    }
    // u — UPDATE, s — SELECT (append-only); t — INSERT on at or received_at
    const a = (await app.db.audit.query("SELECT has_table_privilege(current_user, 'audit_events', 'UPDATE') AS u, has_table_privilege(current_user, 'audit_events', 'SELECT') AS s, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'audit_events'::regclass AND a.attname IN ('at', 'received_at') AND NOT a.attisdropped AND has_column_privilege(current_user, a.attrelid, a.attnum, 'INSERT')) AS t")).rows[0];
    // the gateway role inserts the event columns only, the database sets at and received_at. A role that can still
    // set them (the schema not re-applied after an upgrade) is reported, not refused: an application started before the
    // re-apply must still serve (degraded, not fail_closed)
    checks.audit_append_only = a.u || a.s ? { ok: false, detail: "the gateway role can read or modify the audit log" }
      : a.t ? { ok: false, detail: "the gateway role can set the time of audit events: apply the schema (08-audit-extras.sql)" } : { ok: true };
    hard ||= a.u || a.s;
    soft ||= Boolean(a.t);
    const e = await app.db.control.query("SELECT id FROM embedders WHERE active");
    // no active embedder is a supported state: search works by keyword until an embedding model is configured
    checks.embedder = e.rowCount === 1 ? { ok: true, detail: e.rows[0].id } : !e.rowCount ? { ok: true, detail: await keywordOnlyDetail(app) }
      : { ok: false, detail: `active embedders: ${e.rowCount} (one at most)` };
    hard ||= (e.rowCount ?? 0) > 1;
    if (e.rowCount === 1) activeEmbedder = e.rows[0].id as string;
  } catch (err) {
    if (poolExhausted(err)) throw err;
    checks.database = { ok: false, detail: (err as Error).message.slice(0, 120) }; hard = true;
  }
  checks.embedder_model = await embedderModelCheck(app, activeEmbedder).catch((err) => {
    if (poolExhausted(err)) throw err;
    return { ok: false, detail: `could not read the semantic search model: ${(err as Error).message.slice(0, 200)}` };
  });
  soft ||= !checks.embedder_model.ok;
  // full-text language and index of the records databases: passages without tsv — degraded; an unapplied wish — warn
  try { checks.fts_index = await ftsIndexCheck(app); if (!checks.fts_index.ok) soft = true; }
  catch (err) {
    if (poolExhausted(err)) throw err;
    checks.fts_index = { ok: true, level: "warn", detail: `full-text state not readable: ${(err as Error).message.slice(0, 200)}` };
  }
  // re-embedding: the worker's progress and the registry — degraded only for a stop that needs an administrator
  try { checks.embedding_index = await embeddingIndexCheck(app); soft ||= !checks.embedding_index.ok; }
  catch (err) {
    if (poolExhausted(err)) throw err;
    checks.embedding_index = { ok: true, level: "warn", detail: `the re-embedding state is not readable: ${(err as Error).message.slice(0, 200)}` };
  }
  const [p, s] = await Promise.all([
    legacyProbeNeeded(app.settings)
      ? withTimeout(app.platform.check(), 12_000, "gateway check").catch((err): LegacyGatewayProbe => ({ ok: false, missing: [], error: (err as Error).message }))
      : Promise.resolve(null),
    missing.length ? Promise.resolve(null)
      : withTimeout(app.storage.check(), 12_000, "storage check").catch((err): StorageCheck => ({ ok: false, error: (err as Error).message,
          isolation: { state: "unknown", detail: "storage isolation was not checked: the storage check failed or did not finish" } })),
  ]);
  // models: each role's state and the endpoints that may receive closed data; `platform` is its second name.
  // models.health_strict false — a model problem is degraded and no AI at all is ok; true (an earlier version) — a
  // misconfigured role is fail_closed, as a missing required model key was
  const hints = modelAddressHints(app.platform);
  const models = modelsHealth(app.settings, { probe: p, stub: stubMode(), hints, budget: modelBudgetState(app.platform) });
  checks.models = modelsCheck(models);
  // Operational failures are a warning: reads and RRF search remain available. Doubles of the model client may omit it.
  const rerankHealth = app.platform?.rerankHealth?.();
  if (rerankHealth?.level === "warn") checks.models = { ...checks.models, level: "warn", detail: `${checks.models.detail}; ${rerankHealth.detail}` };
  checks.platform = platformAliasCheck(models, p, hints);
  if (models.severity === "hard") hard = true;
  else if (models.severity === "soft") soft = true;
  if (s) {
    checks.storage = s.ok ? { ok: true } : { ok: false, detail: s.error };
    soft ||= !s.ok;
    // the other class's key reaches a bucket — proven violation, hard (fail_closed: memory requests and originals
    // are refused); no clear answer — degraded with the reason. A storage double without a verdict adds no check.
    const iso = (s as StorageCheck).isolation;
    if (iso) {
      checks.storage_isolation = { ok: iso.state === "ok", level: iso.state === "ok" ? "ok" : iso.state === "violation" ? "fail" : "warn", detail: iso.detail };
      if (iso.state === "violation") hard = true; else if (iso.state === "unknown") soft = true;
    }
  }
  // A bucket may answer while writes fail; retain that failure until a put in the same class succeeds.
  checks.original_storage = await originalStorageCheck(app).catch((error) => {
    if (poolExhausted(error)) throw error;
    return { ok: false, detail: originalStateUnavailable() };
  });
  soft ||= !checks.original_storage.ok;
  const origins = app.settings.get<string[]>("access.origin_allowlist", []);
  if (origins.includes("*")) { checks.origin_allowlist = { ok: false, detail: "access.origin_allowlist contains “*”: any browser Origin is accepted and DNS rebinding protection is off. Narrow or clear the list (an empty list rejects browser Origin headers and accepts requests without Origin)" }; soft = true; }
  else checks.origin_allowlist = { ok: true, detail: origins.length ? `allowed Origin values: ${origins.length}` : "browser Origin headers are rejected; requests without Origin are accepted" };
  // the T1 gate is always shown: a closed gate is the default, not a fault. Since
  // access.t1_providers means only the service keys of tier T1; which model may receive records is the data policy on the
  // pair (models.allow_closed, models.allow_open), reported by the models check, not here
  const t1 = app.settings.get<string[]>("access.t1_providers", []);
  checks.t1_gate = { ok: true, detail: t1.length ? `T1 providers: ${t1.length}` : "closed" };
  const rec = await app.db.control.query("SELECT value, updated_at FROM maintenance_state WHERE instance_id = $1 AND key = 'class_reconcile'", [app.instanceId]).catch(() => ({ rows: [] as any[] }));
  const rv = rec.rows[0]?.value as { removed?: number; orphans?: number; at?: string } | undefined;
  if (!rv) checks.class_consistency = { ok: true, detail: "the data class reconciler has not run yet" };
  else if (Number(rv.orphans) > 0) { checks.class_consistency = { ok: false, detail: `rows found only in the wrong class database: ${rv.orphans}. Retry failed moves in the admin panel under “Processing”; run ${rv.at}` }; soft = true; }
  else checks.class_consistency = { ok: true, detail: `run ${rv.at}: leftover rows removed: ${Number(rv.removed ?? 0)}` };
  const ldap = ldapConfig(app.settings);
  if (!ldap.enabled) checks.ldap = { ok: true, detail: "directory sign-in is not set up (ldap.enabled = false): nobody can sign in to the workspace. The administrator can view it under “Preview”" };
  else {
    const problems = ldapProblems(ldap);
    if (problems.length) { checks.ldap = { ok: false, detail: `directory settings errors: ${problems.map((x) => `${x.key}: ${x.message}`).join("; ").slice(0, 300)}` }; soft = true; }
    else {
      const r = await withTimeout(resolveTargets(ldap), (ldap.connect_timeout_sec + 3) * 1000, "directory check").catch((err) => ({ reachable: [], unreachable: [], dnsFailed: [{ host: "*", error: (err as Error).message }] }));
      if (!r.reachable.length) { checks.ldap = { ok: false, detail: `directory controllers are unavailable: ${[...r.unreachable.map((u) => `${u.address}:${u.port} ${u.error}`), ...r.dnsFailed.map((d) => `${d.host}: the name does not resolve (${d.error})`)].join("; ").slice(0, 300)}` }; soft = true; }
      else if (ldap.tls_mode === "none") { checks.ldap = { ok: false, detail: "directory sign-in is unencrypted: passwords travel over the network in plain text (ldap.insecure_ack). Enable LDAPS or StartTLS" }; soft = true; }
      else checks.ldap = { ok: true, detail: `controllers responding: ${r.reachable.length}${r.unreachable.length || r.dnsFailed.length ? `; unavailable: ${[...r.unreachable.map((u) => u.address), ...r.dnsFailed.map((d) => d.host)].join(", ")}` : ""}` };
    }
  }
  checks.group_sync = await groupSyncCheck(app, ldap.enabled, ldap.group_sync_minutes, groupStaleHours(ldap)).catch((err) => ({ ok: false, detail: `could not read the group reconciliation results: ${(err as Error).message.slice(0, 200)}` }));
  soft ||= !checks.group_sync.ok;
  const oidc = oidcConfig(app.settings);
  if (!oidc.enabled) checks.oidc = { ok: true, detail: "sign-in through the identity provider is not set up (oidc.enabled = false)" };
  else {
    const problems = oidcProblems(oidc);
    if (problems.length) { checks.oidc = { ok: false, detail: `single sign-on settings errors: ${problems.map((x) => `${x.key}: ${x.message}`).join("; ").slice(0, 300)}` }; soft = true; }
    else {
      try {
        const d = await withTimeout(fetchDiscovery(oidc), (oidc.timeout_sec + 3) * 1000, "identity provider check");
        const bad = discoveryProblems(oidc, d);
        if (bad.length) { checks.oidc = { ok: false, detail: `identity provider metadata cannot be used for sign-in: ${bad.join("; ").slice(0, 300)}` }; soft = true; }
        else checks.oidc = { ok: true, detail: `identity provider is responding: ${oidc.issuer}` };
      } catch (e) {
        checks.oidc = { ok: false, detail: `identity provider unavailable: ${e instanceof OidcFailure ? `${e.message} (${e.detail})` : (e as Error).message}`.slice(0, 300) };
        soft = true;
      }
    }
  }
  const agentFacts = agentAuthMode(app.settings) === "builtin" ? await agentAuthFacts(app).catch(() => ({ routes: agentAuthRoutesServed() })) : undefined;
  checks.oauth = oauthHealth(app.settings, agentFacts);
  // builtin: what the app document downloads of this process know — information without refusal, the
  // status of the check does not change
  if (agentFacts) { const note = cimdHealthNote(app.settings); if (note) checks.oauth = { ...checks.oauth, detail: `${checks.oauth.detail}; ${note}` }; }
  soft ||= !checks.oauth.ok;
  try { const x = await externalLoginCheck(app); if (x) { checks.external_login = x; soft ||= !x.ok; } }
  catch (e) { checks.external_login = { ok: false, level: "fail", detail: `could not read sign-in status for outside connections: ${(e as Error).message.slice(0, 200)}` }; soft = true; }
  checks.external_channel = externalChannelCheck(app);
  // an untrusted reverse proxy lost the client addresses: every client behind it shares the limits before the key
  // — degraded, with the proxy's socket; external_channel keeps its promise not to change the status
  { const pt = proxyTrustCheck(app); if (pt) { checks.proxy_trust = pt; soft = true; } }
  { const ac = alertChannelCheck(app.settings); if (ac) checks.alert_channel = ac; }
  // a local administrator without a second factor — ok with level warn (the status does not change); else no key
  { const lf = await localFactorHealth(app); if (lf) checks.local_admin_factor = lf; }
  { const t = tlsLinksCheck(app.settings); checks.tls_links = { ok: t.ok, level: t.level, detail: t.detail }; }
  checks.secrets_source = { ok: true, detail: secretsSourceCheck(app).detail };
  // deploy profile: information for the administrator — which set of start rules this process runs under
  // (MEMORY_DEPLOY_PROFILE); never changes the status. A check row, because the Health contract has no field for it
  checks.deploy_profile = { ok: true, detail: deployProfile() };
  try { checks.smtp = await mailHealth(app); if (!checks.smtp.ok) soft = true; }
  catch (e) { checks.smtp = { ok: false, detail: `could not read the e-mail queue: ${(e as Error).message.slice(0, 200)}` }; soft = true; }
  try { checks.llm = await llmHealthCheck(app); if (!checks.llm.ok) soft = true; }
  catch (e) { checks.llm = { ok: false, detail: `could not read model status: ${(e as Error).message.slice(0, 200)}` }; soft = true; }
  try { checks.converter = await converterHealthCheck(app); if (!checks.converter.ok) soft = true; }
  catch (e) { checks.converter = { ok: false, level: "fail", detail: `could not read converter status: ${(e as Error).message.slice(0, 200)}` }; soft = true; }
  try { const ee = await edgeExportCheck(app); if (ee) { checks.edge_export = ee; if (!ee.ok) soft = true; } }
  catch { checks.edge_export = { ok: true, level: "warn", detail: "could not read edge export status" }; }
  try { checks.disk_guard = await diskGuardHealth(app); if (!checks.disk_guard.ok) soft = true; }
  catch (e) { checks.disk_guard = { ok: false, level: "fail", detail: `could not check disk space: ${(e as Error).message.slice(0, 200)}` }; soft = true; }
  // audit outbox: events the journal refused wait for the worker; an old queue, rejected rows or a recent loss — degraded
  try { checks.audit_outbox = await auditOutboxCheck(app); if (!checks.audit_outbox.ok) soft = true; }
  catch (e) {
    if (poolExhausted(e)) throw e;
    checks.audit_outbox = { ok: false, level: "fail", detail: `the audit outbox is not readable: ${(e as Error).message.slice(0, 200)}` }; soft = true;
  }
  // schema fingerprint (soft gate): the schema step recorded another release's schema — degraded with the hint to
  // run `setup upgrade`; no record (the frozen paths write none) — no check; the record not readable — a warning only
  try { const sc = await schemaCheck(app); if (sc) { checks.schema = sc; if (!sc.ok) soft = true; } }
  catch (e) {
    if (poolExhausted(e)) throw e;
    checks.schema = { ok: true, level: "warn", detail: `the record of the applied schema is not readable: ${(e as Error).message.slice(0, 200)}` };
  }
  const hooks: string[] = [];
  const fault = app.settings.get<Record<string, unknown>>("processing.class_move_fault", {});
  if (fault && Object.keys(fault).length) hooks.push(`processing.class_move_fault: ${JSON.stringify(fault).slice(0, 120)}`);
  const llmFault = app.settings.get<Record<string, unknown>>("processing.llm_fault", {});
  if (llmFault && Object.keys(llmFault).length) hooks.push(`processing.llm_fault: ${JSON.stringify(llmFault).slice(0, 120)}`);
  if (stubMode()) hooks.push("MEMORY_LLM_STUB: the model is disabled and returns canned responses");
  const openCheckFault = app.settings.get<Record<string, unknown>>("processing.open_check_fault", {});
  if (openCheckFault && Object.keys(openCheckFault).length) hooks.push(`processing.open_check_fault: ${JSON.stringify(openCheckFault).slice(0, 120)}`);
  const conversionFault = app.settings.get<Record<string, unknown>>("processing.conversion_fault", {});
  if (conversionFault && Object.keys(conversionFault).length) hooks.push(`processing.conversion_fault: ${JSON.stringify(conversionFault).slice(0, 120)}`);
  const diskFault = app.settings.get<Record<string, unknown>>("processing.disk_guard_fault", {});
  if (diskFault && Object.keys(diskFault).length) hooks.push(`processing.disk_guard_fault: ${JSON.stringify(diskFault).slice(0, 120)}`);
  if (app.settings.get<boolean>("access.test_sessions", false) === true) hooks.push("access.test_sessions: passwordless workspace sessions for test accounts");
  if (app.settings.get<unknown>("processing.links_test_hook", false) === true) hooks.push("processing.links_test_hook: links use the test intake path");
  if (app.settings.get<unknown>("integrations.converter_office_test_hook", false) === true) hooks.push("integrations.converter_office_test_hook: office documents enabled for test accounts ahead of general rollout");
  if (hooks.length) { checks.test_hooks = { ok: false, detail: `test hook enabled: ${hooks.join("; ")}` }; soft = true; }
  const entry: HealthCache = { at: Date.now(), state: { status: hard ? "fail_closed" : soft ? "degraded" : "ok", version: version(), instance: app.instanceId, checks }, hard, soft };
  cached = entry;
  return withOpenCheck(entry);
}
export const resetHealthCache = (): void => { cached = null; };

const EXTERNAL_HOSTS_MISSING = "The proxy is configured (access.trusted_proxies), but the external hostname for agents is missing (access.external_hosts). If the name is in access.agent_hosts, requests to it are treated as agent traffic rather than external traffic. Specify the hostname";
const AGENT_HOSTS_MISSING = "The proxy is configured (access.trusted_proxies), but agent hostnames are missing (access.agent_hosts). All requests through the proxy are treated as external, so extended keys, T0 service keys and “on behalf of” service keys are rejected. Specify the hostnames";
const listOf = (app: Pick<App, "settings">, path: string): unknown[] => { const v = app.settings.get<unknown>(path, []); return Array.isArray(v) ? v : []; };
const hostNames = (app: Pick<App, "settings">, path: string): Set<string> =>
  new Set(listOf(app, path).map((v) => normalizeHost(typeof v === "string" ? v : "")).filter((v): v is string => v !== null));

export function externalChannelWarnings(app: Pick<App, "settings">): string[] {
  if (!trustedProxies(app).length) return [];
  // internet: everything through the proxy is external by design — an empty access.agent_hosts is not a gap there
  const agentHostsGap = !listOf(app, "access.agent_hosts").length && deployProfile() !== "internet";
  return [...(externalHosts(app).length ? [] : ["access.external_hosts"]), ...(agentHostsGap ? ["access.agent_hosts"] : [])];
}

/** external_channel in `internet` without MEMORY_PUBLIC_URL: the installation is reachable from loopback only. */
export const LOCAL_ONLY_NOTE = "Local only: MEMORY_PUBLIC_URL is not set; every request on the main listener is external unless it comes from loopback.";

export function externalChannelCheck(app: App): { ok: true; level?: "warn"; detail: string } {
  const seen = proxyHostsSeen(app);
  const hosts = seen.length ? `Host names received through the proxy in the last hour: ${seen.map((x) => `${x.host} (${x.count})`).join(", ")}` : "no requests came through the proxy in the last hour";
  const known = new Set([...externalHosts(app).map(normalizeHost).filter((v): v is string => v !== null), ...hostNames(app, "access.agent_hosts")]);
  const unknown = trustedProxies(app).length ? seen.filter((x) => !known.has(x.host)) : [];
  const why = [
    ...externalChannelWarnings(app).map((k) => (k === "access.external_hosts" ? EXTERNAL_HOSTS_MISSING : AGENT_HOSTS_MISSING)),
    ...(unknown.length ? [`Requests came through the proxy for hostnames outside access.external_hosts and access.agent_hosts (${unknown.map((x) => x.host).join(", ")}). These requests are treated as external. `
      + "For an agent hostname, add the name to access.agent_hosts; if the proxy substitutes the gateway address for the name, ask IT to preserve Host"] : []),
  ];
  const local = deployProfile() === "internet" && publicAddress().url === null ? `. ${LOCAL_ONLY_NOTE}` : "";
  if (why.length) return { ok: true, level: "warn", detail: `${why.join("; ")}. ${hosts}${local}` };
  return { ok: true, detail: `external hostnames: ${externalHosts(app).length}, agent hostnames: ${listOf(app, "access.agent_hosts").length}; ${hosts}${local}` };
}

/**
 * Health check proxy_trust: during the last hour requests for the public address arrived from a non-public
 * socket that is not a trusted proxy, with or without forwarding headers (channel.ts lostClient) — the client addresses are lost and every
 * client behind that proxy shares the limits before the key. Degraded until the proxy is trusted (the next settings
 * reload) or an hour has passed without such requests. Names only the sockets (validated addresses) and their counts, not
 * the hosts; null when nothing was seen.
 */
export function proxyTrustCheck(app: App): { ok: false; level: "fail"; detail: string } | null {
  const seen = untrustedProxiesSeen(app);
  if (!seen.length) return null;
  return { ok: false, level: "fail", detail: "Proxy is not trusted: client addresses are lost and every client shares the limits before the key. "
    + `Requests for the public address arrive from ${seen.map((x) => `${x.sock} (${x.count})`).join(", ")} — `
    + `${seen.length === 1 ? "an address that is" : "addresses that are"} not in access.trusted_proxies / MEMORY_TRUSTED_PROXIES. `
    + "Add the proxy's address there and make the proxy send X-Forwarded-For with the client address." };
}

/**
 * Why search is keyword-only: the notes of the worker's last embedder reconciliation
 * (maintenance_state `embedders_reconcile`) — a refused probe, a profile this version cannot serve — or that no model is
 * configured. Read by the gateway role; a missing or unreadable record is the plain note.
 */
async function keywordOnlyDetail(app: Pick<App, "db" | "instanceId">): Promise<string> {
  const plain = "keyword-only: no embedding model configured";
  let notes: unknown = [];
  try {
    const r = await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'embedders_reconcile'", [app.instanceId]);
    notes = r?.rows?.[0]?.value?.notes ?? [];
  } catch (err) {
    if (poolExhausted(err)) throw err;
  }
  if (!Array.isArray(notes)) return plain;
  const why = notes.filter((n): n is string => typeof n === "string" && n !== plain);
  return why.length ? `keyword-only: ${why.join(" | ").slice(0, 400)}` : plain;
}

export async function embedderModelCheck(app: Pick<App, "db" | "instanceId" | "settings">, embedderId: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!embedderId) return { ok: true, detail: "no active embedding service (see the “Embedding service” check)" };
  const row = (await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, `embedder_alias:${embedderId}`])).rows[0] as
    { value?: { model?: unknown } } | undefined;
  const was = typeof row?.value?.model === "string" ? row.value.model : null;
  const now = app.settings.str("retrieval.embeddings_model");
  if (!was) return { ok: true, detail: "the model is recorded when the first document is prepared for semantic search" };
  if (!now || now === was) return { ok: true, detail: `model “${was}” prepares records for semantic search` };
  // a row with a profile is served by its own connection and profile, never by retrieval.embeddings_model: after
  // a switch of models that legacy key still names the old model, and that is no fault
  const own = (await app.db.control.query("SELECT profile IS NOT NULL AS has_profile, profile -> 'space' ->> 'model' AS model, connection_slot FROM embedders WHERE active AND id = $1", [embedderId])).rows[0] as
    { has_profile?: unknown; model?: unknown; connection_slot?: "a" | "b" | null } | undefined;
  if (own?.has_profile === true) return { ok: true, detail: `model “${typeof own.model === "string" ? own.model : was}” prepares records for semantic search (dedicated embedding service connection ${embedderId})` };
  return { ok: false, detail: `semantic search is degraded: old records were prepared with “${was}”, but the configured model is “${now}”. Restore the previous model `
    + `(“Settings” → Retrieval, embeddings_model); set up a new model on another embedding service connection (${nextModelKeys(own?.connection_slot)}). It gets its own vectors, and search switches to it once they are ready` };
}

/** Oldest pending outbox row older than this — the worker does not move the queue. */
export const AUDIT_OUTBOX_STALE_SEC = 600;
/** A lost audit event (neither the journal nor the outbox took it) keeps the check red this long. */
export const AUDIT_LOST_WINDOW_MS = 3_600_000;

/**
 * Audit outbox: pending rows and the age of the oldest, rejected rows, events lost by this process. One query; counts
 * and ages only — never the payload.
 */
export async function auditOutboxCheck(app: Pick<App, "db" | "instanceId">, lost = auditLost(), now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const r = (await app.db.control.query(
    `SELECT count(*) FILTER (WHERE rejected_at IS NULL)::int AS pending, count(*) FILTER (WHERE rejected_at IS NOT NULL)::int AS rejected,
            coalesce(floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE rejected_at IS NULL))), 0)::int AS age
       FROM audit_outbox WHERE instance_id = $1`, [app.instanceId])).rows[0] as { pending: number; rejected: number; age: number } | undefined
    ?? { pending: 0, rejected: 0, age: 0 };   // an aggregate always gives one row; a stub database without it is an empty queue
  const problems: string[] = [];
  if (r.pending && r.age > AUDIT_OUTBOX_STALE_SEC)
    problems.push(`${r.pending} audit event(s) wait in the outbox, the oldest for ${Math.round(r.age / 60)} min — the audit log or the worker job audit_outbox_drain does not move them`);
  if (r.rejected) problems.push(`${r.rejected} audit event(s) refused by the log stay in audit_outbox marked rejected`);
  if (lost.lastAt !== null && now - lost.lastAt < AUDIT_LOST_WINDOW_MS)
    problems.push(`${lost.total} audit event(s) lost by this process since start (neither the log nor the outbox took them), the last ${Math.max(0, Math.round((now - lost.lastAt) / 60_000))} min ago`);
  if (problems.length) return { ok: false, detail: problems.join("; ") };
  return { ok: true, detail: r.pending ? `${r.pending} audit event(s) wait in the outbox, the oldest for ${r.age} s` : "the audit outbox is empty" };
}

export async function groupSyncCheck(app: Pick<App, "db" | "instanceId">, enabled: boolean, minutes: number, staleHours = 0): Promise<{ ok: boolean; detail: string }> {
  const b = (await app.db.control.query(
    `SELECT count(*)::int AS n, min(g.created_at) AS first FROM space_groups g JOIN spaces s ON s.id = g.space_id AND s.instance_id = $1 AND s.archived_at IS NULL`,
    [app.instanceId])).rows[0] as { n: number; first: Date | null };
  const expiry = `membership from them is removed ${staleHours} h after the last successful verification (ldap.group_stale_hours)`;
  if (!enabled && b.n && staleHours > 0)
    return { ok: false, detail: `the directory is off (ldap.enabled = false) while directory groups are bound to spaces: ${b.n} — ${expiry}. Switch the directory on ("Sign-in and LDAP") or unbind the groups (space cards)` };
  if (!enabled) return b.n
    ? { ok: false, detail: `the directory is disabled (ldap.enabled = false), but ${b.n} directory groups are linked to spaces. Membership from these groups is frozen, so people who leave a group keep their access. Enable the directory (“Sign-in and LDAP”) or unlink the groups (in the space profiles)` }
    : { ok: true, detail: "the directory is not connected. Membership through directory groups is unavailable" };
  if (!b.n) return { ok: true, detail: "no directory groups are linked to spaces" };
  const st = (await app.db.control.query("SELECT value, updated_at FROM maintenance_state WHERE instance_id = $1 AND key = 'group_sync'", [app.instanceId])).rows[0] as
    { value: { ok?: boolean; error_code?: string | null }; updated_at: Date } | undefined;
  const stale = (at: Date) => minutes > 0 && Date.now() - new Date(at).getTime() > 3 * minutes * 60_000;
  if (!st) return stale(b.first!) ? { ok: false, detail: `bound groups: ${b.n}. No full reconciliation has run for more than three intervals (ldap.group_sync_minutes = ${minutes})` }
                                  : { ok: true, detail: `bound groups: ${b.n}; no full reconciliation has run yet` };
  const at = new Date(st.updated_at).toISOString();
  if (st.value?.ok === false && staleHours > 0)
    return { ok: false, detail: `the last group sync (${at}) failed: ${st.value.error_code ?? "directory failure"} — while the directory does not answer, ${expiry} (see "Sign-in and LDAP")` };
  if (st.value?.ok === false) return { ok: false, detail: `the last group reconciliation (${at}) failed: ${st.value.error_code ?? "directory error"}. Group-based membership is frozen while the directory is unavailable (see “Sign-in and LDAP”)` };
  if (stale(st.updated_at)) return { ok: false, detail: `the last group reconciliation was ${at}, more than three intervals ago (ldap.group_sync_minutes = ${minutes}). Group-based membership is not being updated` };
  return { ok: true, detail: `bound groups: ${b.n}; last reconciliation ${at}` };
}

export function withOpenCheck(c: HealthCache, oc: OpenCheckRunnerState = openCheckRunnerState()): HealthState {
  const check = openCheckHealth(oc);
  return { ...c.state, status: c.hard ? "fail_closed" : c.soft || !check.ok ? "degraded" : "ok", checks: { ...c.state.checks, open_check: check }, open_check: oc };
}

export function adminPlaneHealth(app: Pick<App, "settings">): { listener: "separate" | "legacy"; strict: boolean } {
  let separate = false;
  try { separate = processTopology().adminSeparate; } catch { separate = false; }
  return { listener: separate ? "separate" : "legacy", strict: adminStrictMode((p) => app.settings.get<unknown>(p, undefined)) };
}

/**
 * Advice for accepted model addresses (an address on 0.0.0.0 —, lead); [] for a platform
 * object without that view (stubs of tests).
 */
/** The money budget of the platform for the `models` check; null for a stand-in platform without one. */
export function modelBudgetState(platform: unknown): BudgetState | null {
  const f = (platform as { budgetState?: () => BudgetState | null } | null)?.budgetState;
  return typeof f === "function" ? f.call(platform) : null;
}

export function modelAddressHints(platform: unknown): string[] {
  const f = (platform as { addressHints?: () => string[] } | null)?.addressHints;
  return typeof f === "function" ? f.call(platform) : [];
}

/**
 * The `platform` check — the second name of `models`: the same `ok`. A failed probe of the legacy gateway keeps
 * its texts (scripts and people read them); a passing probe is `{ ok: true }` as before, or a warning with advice; without a
 * probe one line: no AI, or the first problem of the models check.
 */
export function platformAliasCheck(m: ModelsHealth, probe: LegacyGatewayProbe | null, hints: string[]): { ok: boolean; level?: "warn"; detail?: string } {
  if (!m.ok) {
    if (probe && !probe.ok) { const old = platformCheck(probe, []); if (old.detail) return old; }
    return { ok: false, detail: `see the models check: ${firstProblem(m) ?? m.detail}` };
  }
  if (hints.length) return { ok: true, level: "warn", detail: hints.join("; ") };
  if (probe) return { ok: true };
  return { ok: true, detail: m.ai_off ? MODELS_AI_OFF_TEXT : "the same as the models check" };
}

/** The `platform` check from the gateway check: a passing check with advice is a warning (the status does not change). */
export function platformCheck(p: { ok: boolean; missing: string[]; error?: string }, hints: string[]): { ok: boolean; level?: "warn"; detail?: string } {
  if (!p.ok) return { ok: false, detail: p.missing.length ? `models missing from the gateway: ${p.missing.join(", ")}` : p.error };
  return hints.length ? { ok: true, level: "warn", detail: hints.join("; ") } : { ok: true };
}
