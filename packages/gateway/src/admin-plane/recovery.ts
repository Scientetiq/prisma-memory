import { AGENT_AUTH_PROBLEM_TEXT, agentAuthMode, agentAuthProblems, alwaysKeysOf, currentAnchors, effectiveMode, ldapConfig, ldapProblems, MemoryError, newId, oidcConfig,
         oidcProblems, raiseAlert, settingsPolicy, SettingsTypeError, smtpConfig, smtpProblems, tx, type Category, type Settings } from "@memory/shared";
import type { Context } from "hono";
import type pg from "pg";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { endIdentitySessions, requiredClears, secretAnchorProblems, settingsWriteSettled } from "../admin.ts";
import { reconcileAccess } from "../access.ts";
import { loginPolicyLock, withSettingsTx } from "../login-policy.ts";
import { oauthPolicyLock } from "../oauth.ts";
import { applyAgentAuthPolicy, futureSettings } from "../agent-auth/policy-step.ts";
import { agentAuthFacts } from "../agent-auth/readiness.ts";
import { contourCheck, equalsPin, externalContourLock, notePreMail, securityModeInTx, settingAuditDetails, settingsSaved, transportPreMail, type SettingChange } from "./settings-guard.ts";

export interface RecoveryRefusal { status: 400 | 403 | 404 | 409; code: string; message: string; details?: Record<string, unknown> }

export const RECOVERY_ACTOR = "command line on the VM";

export const RECOVERY_ROLES = ["memory_admin", "security_auditor"] as const;

const RECOVERY_COMPANIONS = ["oidc.client_secret", "ldap.bind_password"];

export function recoveryKeys(): string[] {
  const all = Object.keys(settingsPolicy().keys);
  return [...new Set([...alwaysKeysOf(all), ...all.filter((k) => k === "access.refuse_outside_clients" || RECOVERY_COMPANIONS.includes(k))])].sort();
}

const CHANNEL_KEYS = ["smtp.enabled", "admin.alert_recipients"];

function channelNarrowing(settings: Pick<Settings, "get" | "meta">, items: ReadonlyArray<{ category: string; key: string; value?: unknown }>): string[] {
  const after = (path: string): unknown => {
    const it = items.find((i) => `${i.category}.${i.key}` === path);
    return it === undefined ? undefined : it.value ?? settings.meta(path).defaultValue ?? null;
  };
  const out: string[] = [];
  const enabled = after("smtp.enabled");
  if (enabled !== undefined && settings.get<unknown>("smtp.enabled", false) === true && enabled !== true) out.push("smtp.enabled");
  const list = after("admin.alert_recipients");
  if (list !== undefined) {
    const norm = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()) : []);
    const next = new Set(norm(list));
    if (norm(settings.get<unknown>("admin.alert_recipients", [])).some((x) => !next.has(x))) out.push("admin.alert_recipients");
  }
  return out;
}

const noCaller = { get: () => undefined } as unknown as Context;

/**
 * The rules recoverSettings() applies to its batch before the batch cross-checks, on the future state that the batch alone
 * leaves: the section rules of ldap, oidc and smtp on the whole section (as PUT /settings), the secret that follows its
 * anchor (`reentered` — same-value secrets counted as entered, never written) and, when `agentFuture` names the
 * built-in mode, the readiness of the built-in agent sign-in. provision.ts runs the same rules on its group
 * "always" before anything is written, so its dry run refuses what its step 1 would. The problems; empty — none.
 */
export async function recoveryRuleProblems(app: App, q: Pick<pg.PoolClient, "query">, settings: Pick<Settings, "get" | "meta">,
                                           changes: readonly SettingChange[], reentered: ReadonlyArray<{ category: string; key: string; value: unknown }>,
                                           agentFuture: Pick<Settings, "get"> | null): Promise<Array<{ key: string; message: string }>> {
  const next = new Map(changes.map((ch) => [`${ch.category}.${ch.key}`, ch.value] as const));
  const future = { get: <T,>(path: `${string}.${string}`, def: T): T => (next.has(path) ? ((next.get(path) ?? settings.meta(path).defaultValue ?? def) as T) : settings.get<T>(path, def)) } as Pick<Settings, "get">;
  const problems = [
    ...(changes.some((c) => c.category === "ldap") ? ldapProblems(ldapConfig(future)).map((p) => ({ key: `ldap.${p.key}`, message: p.message })) : []),
    ...(changes.some((c) => c.category === "oidc") ? oidcProblems(oidcConfig(future)).map((p) => ({ key: `oidc.${p.key}`, message: p.message })) : []),
    ...(changes.some((c) => c.category === "smtp") ? smtpProblems(smtpConfig(future)).map((p) => ({ key: `smtp.${p.key}`, message: p.message })) : []),
  ];
  problems.push(...secretAnchorProblems(settings, [...changes, ...reentered]));
  if (agentFuture && agentAuthMode(agentFuture) === "builtin")
    problems.push(...agentAuthProblems(agentFuture, await agentAuthFacts(app, q)).map((p) => ({ key: "agent_auth.mode", message: `${p}: ${AGENT_AUTH_PROBLEM_TEXT[p]}` })));
  return problems;
}

export async function recoverSettings(app: App, items: ReadonlyArray<{ category: string; key: string; value?: unknown; confirm_clear?: unknown }>, ssh: string | null,
                                      opts: { skip?: (settings: Settings) => string[];
                                              reenteredSecrets?: (settings: Settings) => ReadonlyArray<{ category: string; key: string; value: unknown }> } = {}):
    Promise<{ ok: true; keys: string[]; skipped?: string[]; ldap_sessions_ended: number; oidc_sessions_ended: number } | { ok: false; refusal: RecoveryRefusal }> {
  const bad = (status: RecoveryRefusal["status"], code: string, message: string, details?: Record<string, unknown>) => ({ ok: false as const, refusal: { status, code, message, ...(details ? { details } : {}) } });
  if (!items.length || items.length > 50) return bad(400, "invalid_argument", "items must contain 1 to 50 settings {category, key, value}");
  for (const it of items) if (!it || typeof it.category !== "string" || typeof it.key !== "string" || !Object.hasOwn(it, "value"))
    return bad(400, "invalid_argument", "Each setting takes {category, key, value}. Use null to restore the default");
  const paths = items.map((it) => `${it.category}.${it.key}`);
  const dup = paths.filter((p, n) => paths.indexOf(p) !== n);
  if (dup.length) return bad(400, "invalid_argument", `Duplicate setting ${[...new Set(dup)].join(", ")}. Nothing was saved`);
  await app.settings.load(true);
  if (effectiveMode(app.settings) !== "basic")
    return bad(409, "recovery_advanced", "In advanced mode, anchors pin protected settings. Change them with a new document signed by 2 of 3 signers (memory-admin-cli anchors draft --set). Change roles with a second signature");
  const allowed = new Set(recoveryKeys());
  const outside = paths.filter((p) => !allowed.has(p));
  if (outside.length) return bad(403, "recovery_key_not_allowed", `Server recovery can change only protected settings (the “always” group). Change ${outside.slice(0, 8).join(", ")} through the admin panel`,
                                 { keys: outside, allowed: [...allowed] });
  const narrowed = channelNarrowing(app.settings, items);
  if (narrowed.length && paths.some((p) => !CHANNEL_KEYS.includes(p)))
    return bad(400, "invalid_argument", `Turn off alert e-mail and remove alert addresses in a recovery batch by themselves (${narrowed.join(", ")}). Change the other settings first, then the alert channel. Nothing was saved`,
               { keys: narrowed });
  const policy = settingsPolicy();
  const immutable = paths.filter((p) => policy.keys[p]?.class === "immutable");
  if (immutable.length) return bad(403, "setting_not_whitelisted", "An immutable setting cannot be changed", { keys: immutable });
  const anchors = currentAnchors();
  const pinned = items.filter((it) => policy.keys[`${it.category}.${it.key}`]?.class === "anchored" && !equalsPin(app, `${it.category}.${it.key}`, it.value ?? null))
    .map((it) => `${it.category}.${it.key}`);
  if (anchors.inForce && pinned.length) return bad(403, "setting_anchored", "This setting is pinned by the trust anchors: it changes only with a new signed anchor file", { keys: pinned });
  let changes: SettingChange[] = items.map((it) => ({ category: it.category, key: it.key, value: it.value ?? null }));
  let skipped: string[] = [];
  // lock order as in PUT /settings: the agent sign-in policy (agent_auth.* keys), the login rules, the contour
  const agentKeys = items.some((i) => i.category === "agent_auth");
  const locks = [...(agentKeys ? [oauthPolicyLock(app)] : []), ...(items.some((i) => i.category === "ldap" || i.category === "oidc") ? [loginPolicyLock(app)] : []),
                 externalContourLock(app)];
  let refusal: RecoveryRefusal | null = null;
  let before: unknown[] = [];
  let secrets: boolean[] = [];
  let ended = { ldap: 0, oidc: 0 };
  let cleared: string[] = [];
  let agentRevoked = 0;
  try {
    await withSettingsTx(app, locks, async (q, settings: Settings) => {
      const mode = await securityModeInTx(app, q);
      if (mode !== "basic") { refusal = { status: 409, code: "recovery_advanced", message: "The mode changed to advanced. Nothing was saved" }; return; }
      await settings.load(true);
      if (opts.skip) {
        const skip = new Set(opts.skip(settings));
        skipped = changes.map((ch) => `${ch.category}.${ch.key}`).filter((p) => skip.has(p));
        if (skipped.length) { changes = changes.filter((ch) => !skip.has(`${ch.category}.${ch.key}`)); items = items.filter((it) => !skip.has(`${it.category}.${it.key}`)); }
        if (!changes.length) return;
      }
      for (const it of changes) {
        try { settings.validate(it.category as Category, it.key, it.value); }
        catch (e) { if (e instanceof SettingsTypeError) { refusal = { status: 400, code: "invalid_argument", message: `${e.message}: nothing was saved` }; return; } throw e; }
      }
      cleared = requiredClears(settings, [...items]);
      const unconfirmed = cleared.filter((p) => items.find((i) => `${i.category}.${i.key}` === p)?.confirm_clear !== true);
      if (unconfirmed.length) { refusal = { status: 400, code: "invalid_argument", message: `${unconfirmed.join(", ")} is required. Clearing it makes memory unavailable to everyone. Add --confirm-clear to clear it. Nothing was saved`,
                                            details: { problems: unconfirmed.map((key) => ({ key, message: "required setting: pass confirm_clear: true to clear it" })) } }; return; }
      // the batch's own rules on the state it leaves (recoveryRuleProblems, shared with provision.ts); built-in agent sign-in:
      // recovery (memory-admin-cli recover) cannot enable an unready builtin either
      const agentFuture = agentKeys ? futureSettings(settings, changes) : null;
      const problems = await recoveryRuleProblems(app, q, settings, changes, opts.reenteredSecrets?.(settings) ?? [], agentFuture);
      if (problems.length) { refusal = { status: 400, code: "invalid_argument", message: `Settings were not saved: ${problems.map((p) => `${p.key} — ${p.message}`).join("; ")}`.slice(0, 600), details: { problems } }; return; }
      await settings.assertBatch(changes, { db: q, instanceId: app.instanceId });
      const contour = await contourCheck(noCaller, app, changes, { settings, q, mode, recovery: true });
      if (contour && contour.ok === false) { refusal = { status: contour.status === 400 ? 400 : contour.status, code: contour.code, message: contour.message, details: contour.details ?? { keys: contour.keys } }; return; }
      notePreMail(changes, await transportPreMail(app, settings, changes, RECOVERY_ACTOR));
      before = changes.map((ch) => settings.get<unknown>(`${ch.category}.${ch.key}`, null));
      secrets = changes.map((ch) => settings.meta(`${ch.category}.${ch.key}`).secret);
      // the common step of built-in sign-in — after every check and before the write, as in PUT /settings
      if (agentFuture) { const step = await applyAgentAuthPolicy(app, q, agentFuture, { before: settings, reason: "recovery" }); agentRevoked = step.keycloak + step.builtin; }
      await settings.setMany(changes.map((ch) => ({ ...ch, category: ch.category as Category })), { updatedBy: null });
      ended = await endIdentitySessions({ ...app, db: { ...app.db, control: q } } as unknown as App, changes);
    });
  } catch (e) {
    if (e instanceof MemoryError) return bad(e.status === 400 ? 400 : 409, e.code, e.message.slice(0, 300), (e.extra as { details?: Record<string, unknown> }).details);
    if (e instanceof SettingsTypeError) return bad(400, "invalid_argument", e.message.slice(0, 300));
    throw e;
  }
  if (refusal) return { ok: false, refusal };
  if (!changes.length) return { ok: true, keys: [], skipped, ldap_sessions_ended: 0, oidc_sessions_ended: 0 };
  settingsWriteSettled(changes);
  const keys = changes.map((ch) => `${ch.category}.${ch.key}`);
  for (const [n, ch] of changes.entries()) {
    const path = `${ch.category}.${ch.key}`;
    const { op, ...details } = settingAuditDetails(app, path, before[n] ?? null, ch.value ?? null, { secret: secrets[n] });
    await audit(app, null, { event_type: "admin", ip: ssh, details: { op, ...details, via: "cli", recovery: true } });
  }
  await audit(app, null, { event_type: "admin", ip: ssh, details: { op: "recovery_settings", via: "cli", keys, ...(cleared.length ? { cleared_required: cleared } : {}),
                                                                     ...(agentRevoked ? { agent_connections_revoked: agentRevoked } : {}),
                                                                     ...(ended.ldap ? { ldap_sessions_ended: ended.ldap } : {}), ...(ended.oidc ? { oidc_sessions_ended: ended.oidc } : {}) } });
  await settingsSaved(app, changes, RECOVERY_ACTOR);
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "external_weakened",
    summary: `Protected settings changed through server recovery (command line on the VM): ${keys.slice(0, 8).join(", ")}`.slice(0, 300),
    details: { keys, via: "cli", ...(ssh ? { ssh_from: ssh } : {}) } });
  return { ok: true, keys, ...(skipped.length ? { skipped } : {}), ldap_sessions_ended: ended.ldap, oidc_sessions_ended: ended.oidc };
}

export async function recoverGrant(app: App, b: { login?: unknown; role_code?: unknown; basis_ref?: unknown }, ssh: string | null):
    Promise<{ ok: true; id: string } | { ok: false; refusal: RecoveryRefusal }> {
  const bad = (status: RecoveryRefusal["status"], code: string, message: string) => ({ ok: false as const, refusal: { status, code, message } });
  await app.settings.load(true);
  if (effectiveMode(app.settings) !== "basic") return bad(409, "recovery_advanced", "In advanced mode, grant roles in the admin panel with a second signature");
  const role = String(b.role_code ?? "");
  if (!(RECOVERY_ROLES as readonly string[]).includes(role)) return bad(400, "invalid_argument", "role_code must be memory_admin or security_auditor");
  if (typeof b.basis_ref !== "string" || b.basis_ref.trim().length < 3) return bad(400, "invalid_argument", "basis_ref must be a request or decision number of at least 3 characters");
  const ctl = app.db.control;
  const person = (await ctl.query("SELECT id, login FROM people WHERE login = $1 AND instance_id = $2 AND active", [String(b.login ?? "").toLowerCase(), app.instanceId])).rows[0] as
    { id: string; login: string } | undefined;
  if (!person) return bad(400, "invalid_argument", "Person not found or inactive");
  if (role === "security_auditor") {
    const op = (await ctl.query("SELECT login FROM admin_users WHERE person_id = $1 AND instance_id = $2 AND disabled_at IS NULL", [person.id, app.instanceId])).rows[0];
    if (op) return bad(400, "invalid_argument", "The security auditor and the person assigned to the local administrator account (admin@local) must be different people");
  }
  const id = newId();
  const done = await tx(ctl, async (q) => {
    if (await securityModeInTx(app, q) !== "basic") return false;
    await q.query(
      `INSERT INTO role_grants (id, person_id, role_code, actions, scope_kind, scope_ref, basis_source, basis_ref, approved_by, approved_at, valid_to, instance_id)
       VALUES ($1, $2, $3, ARRAY['view'], 'company', NULL, 'manual', $4, NULL, NULL, NULL, $5)`, [id, person.id, role, b.basis_ref, app.instanceId]);
    await reconcileAccess(q, app.instanceId, false);
    return true;
  });
  if (!done) return bad(409, "recovery_advanced", "The mode changed to advanced. The role was not granted. In advanced mode, use a second signature in the admin panel");
  await audit(app, null, { event_type: "admin", ip: ssh, details: { op: "grant_create", grant_id: id, role, person: person.id, scope_kind: "company", wide: true, via: "cli", recovery: true } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "admin_role_changed",
    summary: `Granted role ${role} to ${person.login} (${RECOVERY_ACTOR})`, details: { role, person: person.id, action: "granted", via: "cli" } });
  return { ok: true, id };
}

export async function recoverRevoke(app: App, grantId: string, ssh: string | null): Promise<{ ok: true } | { ok: false; refusal: RecoveryRefusal }> {
  await app.settings.load(true);
  if (effectiveMode(app.settings) !== "basic") return { ok: false, refusal: { status: 409, code: "recovery_advanced", message: "In advanced mode, revoke roles in the admin panel with a second signature" } };
  const ctl = app.db.control;
  const cur = (await ctl.query("SELECT g.role_code, g.person_id, p.login FROM role_grants g JOIN people p ON p.id = g.person_id WHERE g.id = $1 AND g.instance_id = $2 AND g.revoked_at IS NULL",
    [grantId, app.instanceId]).catch(() => ({ rows: [] }))).rows[0] as { role_code: string; person_id: string; login: string } | undefined;
  if (!cur) return { ok: false, refusal: { status: 404, code: "not_found", message: "No active grant was found" } };
  if (!(RECOVERY_ROLES as readonly string[]).includes(cur.role_code))
    return { ok: false, refusal: { status: 403, code: "recovery_key_not_allowed", message: "Recovery can revoke only the memory_admin and security_auditor roles" } };
  const done = await tx(ctl, async (q) => {
    if (await securityModeInTx(app, q) !== "basic") return false;
    await q.query("UPDATE role_grants SET revoked_at = now() WHERE id = $1 AND instance_id = $2 AND revoked_at IS NULL", [grantId, app.instanceId]);
    await reconcileAccess(q, app.instanceId, false);
    return true;
  });
  if (!done) return { ok: false, refusal: { status: 409, code: "recovery_advanced", message: "The mode changed to advanced. The role was not revoked. In advanced mode, use a second signature in the admin panel" } };
  await audit(app, null, { event_type: "admin", ip: ssh, details: { op: "grant_revoke", grant_id: grantId, via: "cli", recovery: true } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "admin_role_changed",
    summary: `Revoked role ${cur.role_code} from ${cur.login} (${RECOVERY_ACTOR})`, details: { role: cur.role_code, person: cur.person_id, action: "revoked", via: "cli" } });
  return { ok: true };
}

export const recoveryHelp = (): { keys: string[]; roles: readonly string[] } => ({ keys: recoveryKeys(), roles: RECOVERY_ROLES });
