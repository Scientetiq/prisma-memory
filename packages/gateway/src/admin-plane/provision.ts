// Provisioning of settings an administrator never changed (deploy): `memory-admin provision apply <file|->`
// on the command-line socket only (cli.ts: MEMORY_CLI_LISTEN; the right to call it is the permission on the socket file — the
// same trust `recover set` has). It is how `setup` stores the storage address, buckets and key pairs before any
// administrator exists (secret settings are encrypted by the application, so SQL cannot do it), and how an optional profile
// (`deploy/compose/provision/*.json`, a company's own values that left the defaults) is applied.
//
// Rules:
//  * file `{"format": "prisma-provision/1", "items": [{category, key, value}, …]}`, 1–200 items, no repeated key, no null
//    value (provisioning writes values; a reset to the default is the panel's or `recover set`'s job);
//  * an item is written only when the key was never changed by an administrator: its stored value is NULL or equals the
//    row's default_value (a key with a non-NULL seed default is stored in every database, so "only unset" could not apply a
//    profile at all). Otherwise it is `kept` with the reason; an install upgraded from an older seed keeps its stored value
//    (it differs from the new default), so nothing of an existing install is overwritten;
//  * refused (the whole file, nothing written): unknown keys, immutable keys, keys pinned by trust anchors in force,
//    `security.*` and the keys whose panel save runs steps this route does not (PANEL_ONLY: lock-out readiness, the MCP OAuth
//    policy, the second-factor floor);
//  * the whole file is checked before anything is written (dry run and real run alike): the panel's checks over every item to
//    be written (Settings.validate, the section rules of ldap, oidc and smtp on the future state of the section — the group
//    "always" included —, the secret that follows its anchor counting the file's own secret, open_check values, the
//    semantic-search model rule, the built-in agent sign-in readiness), the rules recoverSettings() applies to the group
//    "always" on the state that group leaves alone (recoveryRuleProblems: step 1 writes it before the other keys), and the
//    batch cross-checks of the group "always" alone and of the whole file. A file of a complete sign-in section (servers or
//    issuer, account, secret, groups, enabled) applies in one call; a file whose group "always" passes only with its other
//    keys — the built-in agent sign-in with the addresses it needs — is refused whole: the addresses go first, in a file of
//    their own;
//  * keys of the group "always" (recoveryKeys(): network trust, sign-in, alert transport) are not written here: they are handed
//    to recoverSettings() with all its guards, locks, session endings, audit and alerts, which checks the never-changed
//    condition again under its locks (a key an administrator set meanwhile is kept). They go first, so its refusal leaves
//    nothing written;
//  * the other keys then take the panel's checks again (and the external-contour check, also before step 1) in one
//    transaction under the contour lock, with the security mode read from the database; secrets are encrypted by
//    Settings.setMany; one audit event `admin` with `op: provision`, `via: cli` and key names only, written only when a key
//    was written — values are never logged or answered. Only a change made by somebody else between the two steps can still
//    refuse step 2 after step 1 wrote; the answer then lists what was written (`details.written`);
//  * basic mode only; `dry_run: true` answers with the same lists (`written`, `kept`, `refused`) and writes nothing (the
//    external-contour check is not run then: its refusal raises an alert).
import { AGENT_AUTH_PROBLEM_TEXT, agentAuthMode, agentAuthProblems, canonicalJson, CLOUD_AGENT_BASE_SETTING, cloudOAuthMismatch, currentAnchors, effectiveMode, ldapConfig,
         ldapProblems, log, MemoryError, oauthConfig, oidcConfig, oidcProblems, openCheckSettingProblems, settingsPolicy, SettingsTypeError, smtpConfig, smtpProblems,
         type Category, type Settings } from "@memory/shared";
import type { Context } from "hono";
import type pg from "pg";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { embeddingsModelProblem, endIdentitySessions, requiredClears, secretAnchorProblems, settingsWriteSettled } from "../admin.ts";
import { agentAuthStepNeeded, applyAgentAuthPolicy, futureSettings } from "../agent-auth/policy-step.ts";
import { agentAuthFacts } from "../agent-auth/readiness.ts";
import { llmSettingsSaved } from "../llm-gate-admin.ts";
import { loginPolicyLock, withSettingsTx } from "../login-policy.ts";
import { oauthPolicyLock } from "../oauth.ts";
import { recoverSettings, recoveryKeys, recoveryRuleProblems } from "./recovery.ts";
import { contourCheck, equalsPin, externalContourLock, securityModeInTx, settingsSaved, type SettingChange } from "./settings-guard.ts";

/** Format name of a provisioning file. */
export const PROVISION_FORMAT = "prisma-provision/1";
/** At most this many items in one file. */
export const PROVISION_MAX_ITEMS = 200;
/** Who acted — for the alerts that settingsSaved raises. */
export const PROVISION_ACTOR = "server command line (provision)";

/**
 * Keys whose panel save runs steps this route does not run, so they are changed in the panel only: the readiness checks that
 * protect administrators from locking themselves out (they need the caller), the relying-party name of the admin security
 * keys, the second-factor floor of the anchors, and the MCP OAuth policy (`oauth.*`, it revokes connections).
 */
const PANEL_ONLY = new Set(["admin.webauthn_required", "admin.second_signature", "admin.local_login", "admin.local_totp_required", "admin.webauthn_rp_id", "edge.mfa_mode"]);
const panelOnly = (path: string): boolean => PANEL_ONLY.has(path) || path.startsWith("oauth.");

// A complete model profile (including setup's demo profile) changes the connection, names and admission list together.
// If any member is configured, keeping the whole group preserves the installation's working model gate.
const MODEL_PROFILE_KEYS = ["models.gateway_base_url", "models.gateway_api_key", "models.llm_model", "models.t0_aliases",
                            "retrieval.embeddings_model", "retrieval.rerank_model"];

export type KeptReason = "changed" | "same_value";
export type RefusedReason = "unknown" | "immutable" | "anchored" | "security_mode" | "panel_only";
export interface ProvisionReport {
  format: typeof PROVISION_FORMAT;
  dry_run: boolean;
  /** Keys written (dry run: keys that would be written), in file order. */
  written: string[];
  /** The part of `written` that went through recoverSettings() (the group "always"). */
  through_recovery: string[];
  kept: Array<{ key: string; reason: KeptReason }>;
  refused: Array<{ key: string; reason: RefusedReason }>;
}
export interface ProvisionRefusal { status: 400 | 403 | 404 | 409; code: string; message: string; details?: Record<string, unknown> }
export type ProvisionResult = { ok: true; report: ProvisionReport } | { ok: false; refusal: ProvisionRefusal };

const REFUSED_TEXT: Record<RefusedReason, string> = {
  unknown: "no such setting",
  immutable: "set once at installation, never through the API",
  anchored: "pinned by the trust anchors in force: changed only by a new signed anchors file",
  security_mode: "the security mode is changed only in the panel",
  panel_only: "changed only in the panel: its save runs checks this command does not",
};

interface Item { category: string; key: string; value: unknown }
const pathOf = (it: { category: string; key: string }): string => `${it.category}.${it.key}`;
const KEY_PART = /^[a-z0-9_]{1,64}$/;
/** contourCheck without a caller: no session, so the core keys that need a person in a session are refused. */
const noCaller = { get: () => undefined } as unknown as Context;

/** Parse the body: the item list or a 400 refusal. Item values are never echoed. */
function parseBody(body: unknown): { items: Item[]; dryRun: boolean } | ProvisionRefusal {
  const bad = (message: string): ProvisionRefusal => ({ status: 400, code: "invalid_argument", message });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(`The body is {"format": "${PROVISION_FORMAT}", "items": [{category, key, value}], "dry_run"?: true}`);
  const b = body as Record<string, unknown>;
  if (b.format !== PROVISION_FORMAT) return bad(`format must be "${PROVISION_FORMAT}"`);
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") return bad("dry_run is true or false");
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > PROVISION_MAX_ITEMS)
    return bad(`items is a list of 1 to ${PROVISION_MAX_ITEMS} settings {category, key, value}: nothing was written`);
  const items: Item[] = [];
  for (const [n, raw] of b.items.entries()) {
    const it = raw as Record<string, unknown> | null;
    if (!it || typeof it !== "object" || Array.isArray(it) || typeof it.category !== "string" || typeof it.key !== "string" || !Object.hasOwn(it, "value")
        || Object.keys(it).some((k) => k !== "category" && k !== "key" && k !== "value"))
      return bad(`Item ${n + 1} is not {category, key, value}: nothing was written`);
    if (!KEY_PART.test(it.category) || !KEY_PART.test(it.key)) return bad(`Item ${n + 1}: category and key are lower-case names (a-z, 0-9, _): nothing was written`);
    if (it.value === null) return bad(`${it.category}.${it.key}: value null — provisioning writes values; a reset to the default is done in the panel: nothing was written`);
    items.push({ category: it.category, key: it.key, value: it.value });
  }
  const paths = items.map(pathOf);
  const dup = [...new Set(paths.filter((p, n) => paths.indexOf(p) !== n))];
  if (dup.length) return bad(`Repeated setting ${dup.join(", ")}: nothing was written`);
  return { items, dryRun: b.dry_run === true };
}

/** Why an item is refused, or null. */
function refusedReason(settings: Settings, path: string, value: unknown, app: App, always: ReadonlySet<string>): RefusedReason | null {
  const policy = settingsPolicy().keys[path];
  if (!policy || !settings.meta(path).exists) return "unknown";
  if (path === "security.mode" || path.startsWith("security.")) return "security_mode";
  if (policy.class === "immutable") return "immutable";
  if (currentAnchors().inForce && policy.class === "anchored" && !equalsPin(app, path, value)) return "anchored";
  if (!always.has(path) && panelOnly(path)) return "panel_only";
  return null;
}

/**
 * Kept or to be written: the same value already in force — `same_value`; a stored value other than NULL and the row's default
 * (an administrator, or an older seed, set it; also a secret that cannot be decrypted) — `changed`; otherwise null (write).
 */
function keptReason(settings: Settings, path: string, value: unknown): KeptReason | null {
  const meta = settings.meta(path);
  if (settings.undecryptable().includes(path)) return "changed";
  const stored = settings.rawValue(path);
  const inForce = stored ?? meta.defaultValue ?? null;
  if (canonicalJson(inForce) === canonicalJson(value)) return "same_value";
  if (stored !== null && canonicalJson(stored) !== canonicalJson(meta.defaultValue ?? null)) return "changed";
  return null;
}

/** The complete model-profile group is kept if any member differs from both the file and its seed default. */
function keptModelProfile(settings: Settings, items: readonly Item[]): ReadonlySet<string> {
  const group = items.filter((it) => MODEL_PROFILE_KEYS.includes(pathOf(it)));
  return group.length === MODEL_PROFILE_KEYS.length && group.some((it) => keptReason(settings, pathOf(it), it.value) === "changed")
    ? new Set(MODEL_PROFILE_KEYS) : new Set();
}

/**
 * The panel's checks of a batch that need no write transaction: value rules, section rules on the future state of the whole
 * section (run when any item of the file touches the section — the group "always" included, so the dry run refuses what
 * recoverSettings() would), open_check values, the secret that follows its anchor, the semantic-search model, the built-in
 * agent sign-in readiness and the cloud agents' address. A refusal or null.
 * write — the items written by this step; all — every item of the file that is or will be written; reentered — the items the
 * secret-follows-anchor rule counts as "in the batch": `all` plus the file's items already in force with the same value (a
 * secret in the file equal to the stored one is entered again; a secret an administrator changed is not — it is `kept`).
 */
async function panelChecks(app: App, settings: Settings, q: Pick<pg.PoolClient, "query">, write: readonly Item[], all: readonly Item[], reentered: readonly Item[]): Promise<ProvisionRefusal | null> {
  const bad = (message: string, problems?: Array<{ key: string; message: string }>): ProvisionRefusal =>
    ({ status: 400, code: "invalid_argument", message: message.slice(0, 900), ...(problems ? { details: { problems } } : {}) });
  for (const it of write) {
    try { settings.validate(it.category as Category, it.key, it.value); }
    catch (e) { if (e instanceof SettingsTypeError) return bad(`${e.message}: nothing was written`); throw e; }
  }
  const next = new Map(all.map((it) => [pathOf(it), it.value] as const));
  const future = { get: <T,>(path: string, def: T): T => (next.has(path) ? next.get(path) as T : settings.get<T>(path, def)) };
  const problems = [
    ...(all.some((c) => c.category === "ldap") ? ldapProblems(ldapConfig(future)).map((p) => ({ key: `ldap.${p.key}`, message: p.message })) : []),
    ...(all.some((c) => c.category === "oidc") ? oidcProblems(oidcConfig(future)).map((p) => ({ key: `oidc.${p.key}`, message: p.message })) : []),
    ...(all.some((c) => c.category === "smtp") ? smtpProblems(smtpConfig(future)).map((p) => ({ key: `smtp.${p.key}`, message: p.message })) : []),
    ...write.filter((i) => i.category === "open_check").flatMap((i) => openCheckSettingProblems(i.key, i.value).map((message) => ({ key: pathOf(i), message }))),
    ...secretAnchorProblems(settings, reentered),
  ];
  const emb = write.find((i) => pathOf(i) === "retrieval.embeddings_model");
  if (emb) { const p = await embeddingsModelProblem(app, settings.str("retrieval.embeddings_model"), emb.value, q); if (p) problems.push({ key: "retrieval.embeddings_model", message: p }); }
  const agentFuture = agentAuthStepNeeded(write.map(pathOf)) ? futureSettings(settings, all) : null;
  if (agentFuture && agentAuthMode(agentFuture) === "builtin")
    problems.push(...agentAuthProblems(agentFuture, await agentAuthFacts(app, q)).map((p) => ({ key: "agent_auth.mode", message: `${p}: ${AGENT_AUTH_PROBLEM_TEXT[p]}` })));
  const cloud = write.find((i) => pathOf(i) === CLOUD_AGENT_BASE_SETTING);
  if (cloud && agentAuthMode(agentFuture ?? settings) === "external") {
    const mismatch = cloudOAuthMismatch(cloud.value, oauthConfig(settings));
    if (mismatch) problems.push({ key: CLOUD_AGENT_BASE_SETTING, message: mismatch });
  }
  if (problems.length) return bad(`Settings not written: ${problems.map((p) => `${p.key} — ${p.message}`).join("; ")}`, problems);
  const cleared = requiredClears(settings, [...write]);
  if (cleared.length) return bad(`${cleared.join(", ")}: an empty value of a required setting stops the memory for everybody — set it in the panel: nothing was written`);
  return null;
}

/** Refusal of a MemoryError or SettingsTypeError thrown by the batch checks — the same answer as the panel's. */
function thrownRefusal(e: unknown): ProvisionRefusal | null {
  if (e instanceof MemoryError) return { status: e.status === 400 ? 400 : 409, code: e.code, message: e.message.slice(0, 300), ...((e.extra as { details?: Record<string, unknown> })?.details ? { details: (e.extra as { details: Record<string, unknown> }).details } : {}) };
  if (e instanceof SettingsTypeError) return { status: 400, code: "invalid_argument", message: e.message.slice(0, 300) };
  return null;
}

/**
 * Apply a provisioning file (POST /cli/provision). ssh — the SSH address the command line reports, for the audit log only.
 * The answer carries key names and reasons, never values.
 */
export async function provisionSettings(app: App, body: unknown, ssh: string | null): Promise<ProvisionResult> {
  const parsed = parseBody(body);
  if ("status" in parsed) return { ok: false, refusal: parsed };
  const { items, dryRun } = parsed;
  await app.settings.load(true);
  if (effectiveMode(app.settings) !== "basic")
    return { ok: false, refusal: { status: 409, code: "provision_advanced", message: "Advanced mode: the server command line provisions nothing — protected keys change by a new 2-of-3 anchors document, the rest in the panel" } };
  const policy = settingsPolicy(), anchors = currentAnchors();
  if (anchors.inForce && anchors.settingsPolicySha256 !== policy.sha256)
    return { ok: false, refusal: { status: 403, code: "policy_mismatch", message: "The settings policy file does not match the trust anchors: settings are closed for changes until the anchors are signed again" } };
  const always = new Set(recoveryKeys());
  const report: ProvisionReport = { format: PROVISION_FORMAT, dry_run: dryRun, written: [], through_recovery: [], kept: [], refused: [] };
  for (const it of items) {
    const reason = refusedReason(app.settings, pathOf(it), it.value, app, always);
    if (reason) report.refused.push({ key: pathOf(it), reason });
  }
  if (report.refused.length)
    return { ok: false, refusal: { status: 403, code: "provision_refused", message: `Not provisioned: ${report.refused.slice(0, 8).map((r) => `${r.key} — ${REFUSED_TEXT[r.reason]}`).join("; ")}. Nothing was written`.slice(0, 900),
                                   details: { refused: report.refused } } };
  // every value is checked, also of the items that will be kept: a broken file is refused whole, as a panel batch is
  for (const it of items) {
    try { app.settings.validate(it.category as Category, it.key, it.value); }
    catch (e) { if (e instanceof SettingsTypeError) return { ok: false, refusal: { status: 400, code: "invalid_argument", message: `${e.message}: nothing was written`.slice(0, 300) } }; throw e; }
  }
  const toWrite: Item[] = [];
  const keptModels = keptModelProfile(app.settings, items);
  for (const it of items) {
    const kept = keptModels.has(pathOf(it)) ? "changed" : keptReason(app.settings, pathOf(it), it.value);
    if (kept) report.kept.push({ key: pathOf(it), reason: kept });
    else toWrite.push(it);
  }
  const viaRecovery = toWrite.filter((it) => always.has(pathOf(it)));
  const plain = toWrite.filter((it) => !always.has(pathOf(it)));

  // the items the secret-follows-anchor rule counts as entered: everything but the keys an administrator changed
  const changedByAdmin = new Set(report.kept.filter((k) => k.reason === "changed").map((k) => k.key));
  const reentered = items.filter((it) => !changedByAdmin.has(pathOf(it)));
  const refuse = (r: ProvisionRefusal): ProvisionResult => ({ ok: false, refusal: { ...r, details: { ...(r.details ?? {}), written: [] } } });

  // The whole file is checked before anything is written, in the dry run and in the real run alike: the panel's checks over
  // every item that would be written (the section rules of the group "always" included), the rules recoverSettings()
  // applies to the group "always" on the stored settings plus that group alone (it is written before the other keys),
  // and the batch cross-checks of the group "always" alone (what recoverSettings() runs first) and of the whole file (the
  // state after both steps). So a refusal never leaves the group "always" written, and the dry run refuses what the real
  // run would.
  if (toWrite.length) {
    const pre = await panelChecks(app, app.settings, app.db.control, toWrite, toWrite, reentered).catch((e: unknown) => { const r = thrownRefusal(e); if (r) return r; throw e; });
    if (pre) return refuse(pre);
    if (viaRecovery.length) {
      const first: SettingChange[] = viaRecovery.map((it) => ({ category: it.category, key: it.key, value: it.value }));
      const firstEntered = items.filter((it) => app.settings.meta(pathOf(it)).secret && keptReason(app.settings, pathOf(it), it.value) === "same_value");
      const firstAgent = viaRecovery.some((it) => it.category === "agent_auth") ? futureSettings(app.settings, first) : null;
      let problems: Array<{ key: string; message: string }>;
      try { problems = await recoveryRuleProblems(app, app.db.control, app.settings, first, firstEntered, firstAgent); }
      catch (e) { const r = thrownRefusal(e); if (r) return refuse(r); throw e; }
      if (problems.length)
        return refuse({ status: 400, code: "invalid_argument", details: { problems },
                        message: `Nothing was written: the group "always" of this file is written first, alone, and is refused on its own. If the keys it needs are in this file, provision them first in a file of their own, then this file. ${problems.map((p) => `${p.key} — ${p.message}`).join("; ")}`.slice(0, 900) });
    }
    try {
      if (viaRecovery.length) await app.settings.assertBatch(viaRecovery, { db: app.db.control, instanceId: app.instanceId });
      await app.settings.assertBatch(toWrite, { db: app.db.control, instanceId: app.instanceId });
    } catch (e) { const r = thrownRefusal(e); if (r) return refuse(r); throw e; }
  }
  if (dryRun) {
    report.written = toWrite.map(pathOf);
    report.through_recovery = viaRecovery.map(pathOf);
    return { ok: true, report };
  }
  // the external-contour check of the other keys, before the group "always" is written (it is repeated under the lock in
  // step 2). Not in the dry run: a refusal here raises the alert external_gate_refused, and the dry run writes nothing.
  if (plain.length) {
    const contour = await contourCheck(noCaller, app, plain.map((it) => ({ category: it.category, key: it.key, value: it.value })), { mode: effectiveMode(app.settings) });
    if (contour && contour.ok === false) return refuse({ status: contour.status, code: contour.code, message: contour.message, details: contour.details ?? { keys: contour.keys } });
  }

  // 1. the group "always": recoverSettings() with its guards, locks, audit and alerts — first, so its refusal writes nothing.
  //    The never-changed condition is checked again under its locks: a key an administrator set meanwhile is kept, not written.
  if (viaRecovery.length) {
    const res = await recoverSettings(app, viaRecovery, ssh, {
      skip: (s) => viaRecovery.filter((it) => keptReason(s, pathOf(it), it.value) !== null).map(pathOf),
      reenteredSecrets: (s) => items.filter((it) => s.meta(pathOf(it)).secret && keptReason(s, pathOf(it), it.value) === "same_value"),
    });
    if (!res.ok) return refuse(res.refusal);
    report.through_recovery = res.keys;
    for (const key of res.skipped ?? []) {
      const it = viaRecovery.find((i) => pathOf(i) === key)!;
      report.kept.push({ key, reason: keptReason(app.settings, key, it.value) ?? "changed" });
    }
  }
  const recovered = viaRecovery.filter((it) => report.through_recovery.includes(pathOf(it)));

  // 2. the other keys: one transaction under the contour lock, the never-changed condition read again inside it
  let refusal: ProvisionRefusal | null = null;
  let changes: SettingChange[] = [];
  if (plain.length) {
    const agentKeys = agentAuthStepNeeded(plain.map(pathOf));
    const locks = [...(agentKeys ? [oauthPolicyLock(app)] : []), ...(plain.some((i) => i.category === "ldap" || i.category === "oidc") ? [loginPolicyLock(app)] : []), externalContourLock(app)];
    try {
      await withSettingsTx(app, locks, async (q, settings: Settings) => {
        const mode = await securityModeInTx(app, q);
        if (mode !== "basic") { refusal = { status: 409, code: "provision_advanced", message: "The security mode changed to advanced: nothing more was written" }; return; }
        await settings.load(true);
        const now: Item[] = [];
        const keptModelsNow = keptModelProfile(settings, items);
        for (const it of plain) {
          const kept = keptModelsNow.has(pathOf(it)) ? "changed" : keptReason(settings, pathOf(it), it.value);
          if (kept) report.kept.push({ key: pathOf(it), reason: kept }); else now.push(it);
        }
        if (!now.length) return;
        // the secret-follows-anchor rule counts the file's secret that step 1 wrote or that was already in force (same value)
        const entered = items.filter((it) => now.includes(it) || keptReason(settings, pathOf(it), it.value) === "same_value");
        refusal = await panelChecks(app, settings, q, now, [...now, ...recovered], entered);
        if (refusal) return;
        await settings.assertBatch(now, { db: q, instanceId: app.instanceId });
        changes = now.map((it) => ({ category: it.category, key: it.key, value: it.value }));
        const contour = await contourCheck(noCaller, app, changes, { settings, q, mode });
        if (contour && contour.ok === false) { refusal = { status: contour.status, code: contour.code, message: contour.message, details: contour.details ?? { keys: contour.keys } }; changes = []; return; }
        const agentFuture = agentKeys ? futureSettings(settings, changes) : null;
        if (agentFuture) await applyAgentAuthPolicy(app, q, agentFuture, { before: settings, reason: "settings" });
        await settings.setMany(changes.map((ch) => ({ ...ch, category: ch.category as Category })), { updatedBy: null });
        await endIdentitySessions({ ...app, db: { ...app.db, control: q } } as unknown as App, changes);
      });
    } catch (e) {
      const r = thrownRefusal(e);
      if (!r) throw e;
      refusal = r;
      changes = [];
    }
  }
  const written = [...report.through_recovery, ...changes.map(pathOf)];
  report.written = toWrite.map(pathOf).filter((p) => written.includes(p));
  if (changes.length) {
    settingsWriteSettled(changes);
    await llmSettingsSaved(app, changes).catch((e: unknown) => log.warn("llm_settings_reaction_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }));
  }
  if (report.written.length)
    await audit(app, null, { event_type: "admin", ip: ssh, details: { op: "provision", via: "cli", keys: report.written,
                                                                       ...(report.through_recovery.length ? { through_recovery: report.through_recovery } : {}),
                                                                       ...(report.kept.length ? { kept: report.kept.map((k) => k.key) } : {}) } });
  if (changes.length) await settingsSaved(app, changes, PROVISION_ACTOR);
  const failed = refusal as ProvisionRefusal | null;
  if (failed) return { ok: false, refusal: { ...failed, details: { ...(failed.details ?? {}), written: report.written } } };
  return { ok: true, report };
}
