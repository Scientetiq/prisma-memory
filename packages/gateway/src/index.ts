import { AnchorsError, Databases, deployProfile, DeployProfileError, type DeployProfile, GATEWAY_DB_ROLES, initAnchors, listenSecurityMode, loadServiceSecrets, log, PgTlsConfigError, mcpContract, MCP_LANGUAGES, ModelGateAudit, openAdminPlanePool, Platform, publicAddress, readEnv, registerInstanceLocale, Settings, UsageRecorder } from "@memory/shared";
import { unhandledRejectionLine } from "./process-lines.ts";
import type { App } from "./context.ts";
import { Limiter, startDiskReport } from "./limits.ts";
import { Storage } from "./storage.ts";
import { JobQueue } from "./queue.ts";
import { buildHttp } from "./http.ts";
import { externalChannelWarnings, healthState } from "./health.ts";
import { audit } from "./audit.ts";
import { startGroupSync } from "./space-groups.ts";
import { startAccessExpiry } from "./access.ts";
import { startConnectorDelivery } from "./connectors/index.ts";
import { demoteSelfAddedDeptOwners } from "./dept-owner-cleanup.ts";
import { agentAuthStartupStep } from "./agent-auth/policy-step.ts";
import { markWallTimeFix } from "./report-wall-time.ts";
import { notePublicUrl } from "./public-url-state.ts";
import { flushDirectoryFailures, restoreDirectoryFailures } from "./ldap-login.ts";
import { adminPlanePools } from "./admin-plane/db.ts";
import { retryEdgePreparedUntilKnown } from "./admin-plane/edge-prepared.ts";
import { startLayoutWatch } from "./admin-plane/layout-watch.ts";
import { ssoLoginWatch } from "./admin-plane/sso-login-watch.ts";
import { ListenerConfigError, processTopology, startListeners, type Listeners, type ListenerTopology } from "./admin-plane/listeners.ts";
import { startHttps, wrapTls } from "./listen.ts";
import { buildMcp } from "./mcp.ts";
import { buildAdminPlane } from "./admin-plane/app.ts";
import { cliApp } from "./admin-plane/cli.ts";
import { announceFirstRunCode } from "./admin.ts";
import { firstRunCodeStartProblem } from "./first-run-code.ts";
import { internalNetworksBeyondLoopback, publicAddressRefusals, startRefusals } from "./deploy-guard.ts";
import { cgroupMemoryLimit, scryptStartProblem } from "./local-accounts.ts";

// deploy profile — before everything else: an unknown MEMORY_DEPLOY_PROFILE stops the start, a typo must not
// pick another set of rules silently. Unset — the strictest profile (internet)
let profile: DeployProfile;
try { profile = deployProfile(); }
catch (e) {
  if (e instanceof DeployProfileError) { log.error("deploy_profile_invalid", { error: e.message }); process.exit(1); }
  throw e;
}

// install code of the first-run: an unreadable code file, or a code shorter than 16 characters in `internet`,
// stops the start — a guessable code is the same open door as no code
const firstRunCodeProblem = firstRunCodeStartProblem(profile);
if (firstRunCodeProblem) { log.error("first_run_code_unusable", { error: firstRunCodeProblem }); process.exit(1); }

let topology: ListenerTopology;
try { topology = processTopology(); }
catch (e) {
  if (e instanceof ListenerConfigError) { log.error("listener_config_invalid", { error: e.message }); process.exit(1); }
  throw e;
}
// the layout the deploy profile demands: in `internet` the admin API has its own listener that other machines
// cannot reach — otherwise the start stops here, with every problem on its own line
const layoutRefusals = startRefusals(profile, topology);
if (layoutRefusals.length) { for (const error of layoutRefusals) log.error("listener_config_invalid", { error }); process.exit(1); }
// the public address and the trusted proxies from the environment: a malformed value stops the start in every
// profile; in `internet` the address must be an https name and come with MEMORY_TRUSTED_PROXIES. The texts never repeat the address
const address = publicAddress();
const addressRefusals = publicAddressRefusals(profile, address);
if (addressRefusals.length) { for (const error of addressRefusals) log.error("public_address_invalid", { error }); process.exit(1); }
const scryptProblem = scryptStartProblem(process.env.MEMORY_SCRYPT_PARALLEL, cgroupMemoryLimit());
if (scryptProblem) { log.error("local_scrypt_parallel_invalid", { error: scryptProblem }); process.exit(1); }

// a refused PostgreSQL TLS configuration stops the start with one line; any other error is thrown on
let env: ReturnType<typeof readEnv>;
try { env = readEnv(); }
catch (e) {
  if (e instanceof PgTlsConfigError) { log.error("pg_tls_invalid", { error: e.message }); process.exit(1); }
  throw e;
}
const secrets = loadServiceSecrets(env, GATEWAY_DB_ROLES);
if (secrets.legacy.length) log.info("secrets_legacy", { names: secrets.legacy });
const db = new Databases(env);
const settings = new Settings(db.control, env.instanceId, env.appSecret, secrets.settingsKeyring);
// the instance language (locale.language) is the language of everything rendered outside a request: mail, alerts, jobs
registerInstanceLocale(settings);

async function waitForDb(): Promise<void> {
  for (let i = 0; ; i++) {
    try { await settings.load(true); return; }
    catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
await waitForDb();
log.setLevel(settings.get("observability.log_level", "info"));
// in `internet` a stored list of internal networks beyond loopback (an upgraded database, or an administrator's
// choice) makes those networks internal — said once at the start, not refused
if (profile === "internet") {
  const count = internalNetworksBeyondLoopback(settings.get<unknown>("access.internal_networks", null));
  if (count > 0) log.warn("internal_networks_wider_than_loopback", { count });
}
// the MCP texts of every language: a stale or broken overlay (contracts/locales/<lang>/mcp-tools.json) stops the
// start, instead of failing every /mcp request of an installation with that locale.mcp_language
try { for (const language of MCP_LANGUAGES) mcpContract(language); }
catch (e) { log.error("mcp_contract_invalid", { error: (e as Error).message.slice(0, 300) }); process.exit(1); }

try { await initAnchors({ process: "gateway", db: db.control, audit: db.audit, instanceId: env.instanceId, appSecret: env.appSecret, settings }); }
catch (e) {
  if (e instanceof AnchorsError) { log.error(e.code, { error: e.message.slice(0, 300) }); process.exit(1); }
  throw e;
}

const queue = new JobQueue(env);
await queue.start();
const app: App = { instanceId: env.instanceId, appSecret: env.appSecret, db, settings, platform: new Platform(settings), limiter: new Limiter(settings), storage: new Storage(settings), queue,
                   despiteKeys: secrets.despiteKeys, linkKeys: secrets.linkKeys, secretsLegacy: secrets.legacy, settingsKeyring: secrets.settingsKeyring,
                   // the admin plane only with the separate listener; on the legacy layout the role's pool serves the
                   // alerts router alone (alertsDb) and adminDb stays null
                   ...adminPlanePools(topology.adminSeparate, () => openAdminPlanePool(env)) };
if (topology.adminSeparate && !app.adminDb) log.warn("admin_plane_not_configured", { hint: "the memory_admin_plane role has no password in the gateway’s key directory" });
await markWallTimeFix(app);
// MEMORY_PUBLIC_URL against the previous start — public_url_changed once when it moved
await notePublicUrl(app, address.url);
await retryEdgePreparedUntilKnown(app);
const gateAudit = new ModelGateAudit({
  settings,
  write: (e) => {
    const sum = "count" in e ? { count: e.count, hour: e.hour } : {};
    log.warn("t1_gate", { alias: e.alias, purpose: e.purpose, class: e.dataClass, allowed: e.allowed, role: e.role, endpoint: e.endpoint, reason: e.reason, ...sum });
    // strict: a failed write is logged by audit() and rejects, so that the aggregator puts a summary back
    return audit(app, null, { event_type: "t1_fallback", class: e.dataClass, details: { alias: e.alias, purpose: e.purpose, allowed: e.allowed, role: e.role, endpoint: e.endpoint, reason: e.reason, ...sum } }, { strict: true });
  },
});
app.platform.onModelGate = (e) => { gateAudit.record(e); };
gateAudit.start();

// usage of every model call of this process: sums in memory, written to model_usage_daily every 10 s and at
// shutdown; the gateway also deletes the days older than models.usage_retention_days once a day
const usage = new UsageRecorder({ db: db.control, instanceId: env.instanceId, settings, retention: true });
app.platform.usage = usage;
usage.start();

await restoreDirectoryFailures(app);

const mcp = buildMcp(app);
const http = buildHttp(app, mcp, { listener: "main", adminSeparate: topology.adminSeparate });

const port = Number(process.env.PORT ?? 8080);
let listeners: Listeners;
try {
  listeners = await startListeners({
    main: http,
    ...(topology.adminSeparate ? { admin: buildAdminPlane(app) } : {}),
    ...(topology.workplaceSeparate ? { workplace: buildHttp(app, mcp, { listener: "workplace", adminSeparate: topology.adminSeparate }) } : {}),
    ...(topology.cli.length ? { cli: cliApp(app) } : {}),
  }, { port, hostname: "0.0.0.0", topology, wrap: wrapTls });
} catch (e) {
  if (e instanceof ListenerConfigError) { log.error("listener_config_invalid", { error: e.message }); process.exit(1); }
  throw e;
}
const https = await startHttps(http, settings);
const h = await healthState(app, true);
log.info("gateway_started", { port, instance: env.instanceId, profile, health: h.status, failed_checks: Object.entries(h.checks).filter(([, v]) => !v.ok).map(([k]) => k),
                              admin_listener: topology.adminSeparate, workplace_listener: topology.workplaceSeparate, cli_listener: topology.cli.length > 0,
                              public_url: address.url, trusted_proxies_env: address.proxies.length });
// without a supplied install code (internet, internal-http) the generated one is printed once, while no administrator exists
await announceFirstRunCode(app);
const channelGaps = externalChannelWarnings(app);
if (channelGaps.length) log.warn("external_hosts_empty", { missing: channelGaps });
const observeSsoLogin = topology.adminSeparate ? ssoLoginWatch(app) : null;
await observeSsoLogin?.("startup");
setInterval(() => void settings.load(true)
  .then(() => observeSsoLogin?.("periodic"))
  .catch(() => observeSsoLogin?.("reload_failed")), 60_000).unref();
listenSecurityMode(db.control, settings);
startLayoutWatch(app, { adminSeparate: topology.adminSeparate });
startDiskReport(app);
startGroupSync(app);
startAccessExpiry(app);
// delivery of staged connector items into memory: a poll every 5 s; idle while integrations.connectors_enabled is off
startConnectorDelivery(app);
void demoteSelfAddedDeptOwners(app).catch((e) => log.warn("dept_self_owner_cleanup_failed", { error: ((e as Error)?.message ?? String(e)).slice(0, 300) }));
// built-in agent sign-in: the policy step once, in the background, after the listeners — catches a mode or a
// policy changed past the API (an SQL edit, a restored copy); an error goes to the log (agent_auth_startup_step_failed)
void agentAuthStartupStep(app);
process.on("unhandledRejection", unhandledRejectionLine);   // a class, never the text (process-lines.ts)
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => {
  void Promise.all([gateAudit.stop(), listeners.close(), new Promise<void>((r) => (https ? https.close(() => r()) : r()))]).then(() => flushDirectoryFailures()).then(() => Promise.all([gateAudit.stop(), usage.stop()])).then(() => queue.stop()).then(() => Promise.all([app.adminDb?.end(), app.alertsDb?.end()])).then(() => db.close()).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
