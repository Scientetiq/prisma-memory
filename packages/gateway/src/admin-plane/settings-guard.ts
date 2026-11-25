import { raiseSsoLoginStateAlert, type SsoChange } from "./sso-login-watch.ts";
import type { Context } from "hono";
import { alertRecipients, approvalsRequired, authcheckReadinessKey, canonicalJson, coreChanges, currentAnchors, deliverableRecipients, effectiveMode, log, sendMail, smtpConfig, SmtpFailure, SMTP_TRANSPORT_RE, EXTERNAL_GATE_WOULD_BREAK, EXTERNAL_GATE_WOULD_BREAK_TEXT, externalGate, gateWouldBreak,
         HUMAN_SESSION_REQUIRED_TEXT, isHumanSession, isWeakening, LDAP_CHANNEL_KEYS, ldapChannelOf, LOGIN_FLAGS, modeOf, openingFlags, pinMatches, policyOf, raiseAlert,
         mfaModeFloorProblems, deployProfile, internalNetworksDefault, securityModeFloor, settingFingerprint, settingsPolicy, stricterMode, type ExternalFlag, type PolicyClass, type PolicyKey, type SecurityMode,
         type Settings } from "@memory/shared";
import { tierOfSetting, type SettingTier } from "@memory/shared/settings-tier";
import type { AdminCaller, App } from "../context.ts";
import { adminAppOf, approvalIdOf, externalWeakened, requireApproval, secondSignatureOn, wouldRequireApproval } from "./approvals.ts";
import { adminPlaneConfigured } from "./db.ts";
import { revokeFactorlessLocalSessions } from "./session.ts";
import { edgePrepared, externalContourLock } from "./edge-prepared.ts";
import { humanSessionsHere } from "./human-only.ts";
import { gateFacts, unconfirmedProfile } from "./external-gate.ts";
import { READINESS_FAILED, readinessChecks, type ReadinessCheck } from "./readiness.ts";
import { webauthnRpChangeProblem } from "./webauthn-routes.ts";

export interface SettingChange { category: string; key: string; value: unknown }
export type GuardResult =
  | { ok: true; wouldRequireApproval?: boolean; approvalId?: string | null }
  | { ok: false; status: 400 | 403 | 409; code: string; message: string; keys: string[]; details?: Record<string, unknown> }
  | { ok: "approval"; response: Response };

export const GUARD_TEXT = {
  setting_not_whitelisted: "This setting cannot be changed in the panel: it is not in the settings policy file",
  setting_immutable: "This setting is set once during installation and cannot be changed through the API or admin panel",
  setting_anchored: "This setting is pinned by the trust anchors: it changes only with a new signed anchor file",
  policy_mismatch: "The settings policy file does not match the trust anchors: settings cannot be changed until the anchors are signed again",
} as const;

export function weakenRuleOf(p: PolicyKey, inForce: boolean): string | null {
  if (p.class === "anchored" && !inForce) return p.weaken && p.weaken !== "any" ? p.weaken : "any";
  return p.weaken;
}

const effectiveIn = (s: Pick<Settings, "meta">, path: string, v: unknown): unknown =>
  (v === null || v === undefined ? (path === "access.internal_networks" ? [...internalNetworksDefault(deployProfile())] : s.meta(path).defaultValue) : v);
const effective = (app: App, path: string, v: unknown): unknown => effectiveIn(app.settings, path, v);

const beforeIn = (s: Settings, path: string): unknown => effectiveIn(s, path, s.meta(path).secret ? s.rawValue(path) : s.get<unknown>(path, null));
const beforeOf = (app: App, path: string): unknown => beforeIn(app.settings, path);

export { externalContourLock };

export async function securityModeInTx(app: Pick<App, "instanceId">, q: Pick<App["db"]["control"], "query">): Promise<SecurityMode> {
  await q.query("SELECT pg_advisory_xact_lock_shared(hashtext('security_mode'), hashtext($1))", [app.instanceId]);
  const has = (await q.query("SELECT to_regprocedure('security_mode(text)') IS NOT NULL AS ok")).rows[0]?.ok === true;
  const m = has ? (await q.query("SELECT security_mode($1) AS m", [app.instanceId])).rows[0]?.m : null;
  return stricterMode(modeOf(m ?? null), securityModeFloor());
}

export const SECURITY_MODE_CHANGED = {
  code: "conflict", reason: "security_mode_changed",
  message: "Security mode changed to advanced while saving settings. Nothing was saved. Try again. Weakening a setting now requires a second signature",
} as const;

export function equalsPin(app: Pick<App, "appSecret">, path: string, value: unknown): boolean {
  const pin = currentAnchors().settingsPins?.[path];
  if (!pin) return false;
  return "hmac" in pin ? pinMatches(app.appSecret, path, value ?? null, pin.hmac) : canonicalJson(value ?? null) === canonicalJson(pin.value);
}

export function weakenedBy(app: App, changes: readonly SettingChange[]): { keys: string[]; always: boolean } {
  const inForce = currentAnchors().inForce;
  const keys: string[] = [];
  let always = false;
  for (const ch of changes) {
    const path = `${ch.category}.${ch.key}`;
    const p = policyOf(path);
    if (!p || (inForce && p.class === "anchored")) continue;
    const before = beforeOf(app, path);
    if (isWeakening(weakenRuleOf(p, inForce), before, effective(app, path, ch.value))) {
      keys.push(path);
      if (p.always) always = true;
    }
  }
  return { keys, always };
}

export interface ReadinessNeed {
  key: string;
  ok: string[];
  notFail: string[];
  anyOk?: string[];
  okWhileNotFail?: Record<string, string[]>;
}
export function readinessNeeded(app: App, changes: readonly SettingChange[]): ReadinessNeed[] {
  const out: ReadinessNeed[] = [];
  for (const ch of changes) {
    const path = `${ch.category}.${ch.key}`, v = effective(app, path, ch.value), now = app.settings.get<unknown>(path, null);
    if (path === "admin.webauthn_required" && v === true && now !== true) out.push({ key: path, ok: ["sso", "directory", "admin_keys", "breakglass"], notFail: [] });
    if (path === "admin.second_signature" && v === "on" && now !== "on") out.push({ key: path, ok: ["conditional"], notFail: ["listeners", "signers"] });
    if (path === "admin.local_login" && v !== "open" && now === "open") out.push({
      key: path, ok: [], notFail: ["listeners"], anyOk: ["sso", "breakglass"], okWhileNotFail: { sso: ["admins"] },
    });
    // a required second factor only when every enabled local administrator has one (or local sign-in is off)
    if (path === "admin.local_totp_required" && v === true && now !== true) out.push({ key: path, ok: ["local_admin_factor"], notFail: [] });
  }
  return out;
}

export function unmetReadiness(checks: readonly ReadinessCheck[], needs: readonly ReadinessNeed[]): ReadinessCheck[] {
  const byId = new Map(checks.map((x) => [x.id, x]));
  const failed = new Map<string, ReadinessCheck>();
  const miss = (id: string): ReadinessCheck => byId.get(id) ?? { id, status: "fail", title: `Check ${id} did not pass` };
  for (const n of needs) {
    for (const id of n.ok) { const x = miss(id); if (x.status !== "ok") failed.set(id, { ...x, status: "fail" }); }
    for (const id of n.notFail) { const x = miss(id); if (x.status === "fail") failed.set(id, x); }
    if (n.anyOk) {
      const blockers = new Map(Object.entries(n.okWhileNotFail ?? {}));
      const failuresByAlternative = n.anyOk.map((id): ReadinessCheck[] => {
        const x = miss(id);
        if (x.status !== "ok") return [{ ...x, status: "fail" }];
        return (blockers.get(id) ?? []).map(miss).filter((check) => check.status === "fail");
      });
      if (failuresByAlternative.every((rows) => rows.length > 0)) {
        for (const x of failuresByAlternative.flat()) failed.set(x.id, x);
      }
    }
  }
  return [...failed.values()];
}

const brief = (v: unknown): string => { const j = canonicalJson(v ?? null); return j.length > 40 ? `${j.slice(0, 39)}…` : j; };

export function weakenSummary(app: App, changes: readonly SettingChange[], keys: readonly string[]): string {
  const parts: string[] = [];
  for (const path of keys) {
    const ch = changes.find((x) => `${x.category}.${x.key}` === path);
    if (!ch) continue;
    const before = beforeOf(app, path), after = effective(app, path, ch.value);
    const mode = auditMode(path);
    if (mode === "keys_only") parts.push(`${path}: changed`);
    else if (mode === "fingerprint" || app.settings.meta(path).secret)
      parts.push(`${path}: fingerprint ${settingFingerprint(app.appSecret, before).slice(0, 8)} → ${settingFingerprint(app.appSecret, after).slice(0, 8)}`);
    else parts.push(`${path}: ${brief(before)} → ${brief(after)}`);
  }
  const out = `Weaken settings: ${parts.join("; ")}`;
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}

export async function check(c: Context, changes: readonly SettingChange[], app0?: App): Promise<GuardResult> {
  const app = app0 ?? adminAppOf(c);
  if (!app) throw new Error("settingsGuard.check: the request is not bound to an application. Pass app on the main listener");
  const policy = settingsPolicy();
  const anchors = currentAnchors();
  const paths = changes.map((ch) => `${ch.category}.${ch.key}`);
  const unknown = paths.filter((p) => !policy.keys[p]);
  if (unknown.length) return { ok: false, status: 403, code: "setting_not_whitelisted", message: GUARD_TEXT.setting_not_whitelisted, keys: unknown, details: { keys: unknown } };
  const immutable = paths.filter((p) => policy.keys[p]!.class === "immutable");
  if (immutable.length) return { ok: false, status: 403, code: "setting_not_whitelisted", message: GUARD_TEXT.setting_immutable, keys: immutable, details: { keys: immutable } };
  if (anchors.inForce && anchors.settingsPolicySha256 !== policy.sha256)
    return { ok: false, status: 403, code: "policy_mismatch", message: GUARD_TEXT.policy_mismatch, keys: paths, details: { keys: paths } };
  const anchored = changes.filter((ch) => policy.keys[`${ch.category}.${ch.key}`]!.class === "anchored" && !equalsPin(app, `${ch.category}.${ch.key}`, ch.value))
    .map((ch) => `${ch.category}.${ch.key}`);
  if (anchors.inForce && anchored.length)
    return { ok: false, status: 403, code: "setting_anchored", message: GUARD_TEXT.setting_anchored, keys: anchored, details: { keys: anchored } };

  const rp = changes.find((ch) => ch.category === "admin" && ch.key === "webauthn_rp_id");
  if (rp && adminPlaneConfigured(app)) {
    const problem = await webauthnRpChangeProblem(app, effective(app, "admin.webauthn_rp_id", rp.value));
    if (problem) return { ok: false, status: 409, code: "conflict", message: problem, keys: ["admin.webauthn_rp_id"], details: { keys: ["admin.webauthn_rp_id"] } };
  }

  const needs = readinessNeeded(app, changes);
  if (needs.length) {
    const overlay = new Map(changes.map((ch) => [`${ch.category}.${ch.key}`, effective(app, `${ch.category}.${ch.key}`, ch.value)] as const));
    const checks = await readinessChecks(app, (c.get("caller") as never) ?? null, { overlay });
    const failed = unmetReadiness(checks, needs);
    if (failed.length) {
      const body = READINESS_FAILED(failed);
      return { ok: false, status: 409, code: body.code, message: body.message, keys: needs.map((n) => n.key), details: body.details };
    }
  }

  const contour = await contourCheck(c, app, changes);
  if (contour) return contour;

  const floor = await mfaFloorRefusal(app, changes);
  if (floor) return floor;

  const approvalId = approvalIdOf(c);
  if (approvalId) return { ok: true, approvalId };
  const weak = weakenedBy(app, changes);
  if (!weak.keys.length) return { ok: true };
  const subject = changes.some((ch) => ch.category === "edge" && ch.key === "mfa_mode") ? "edge.mfa_mode" : undefined;
  const res = await requireApproval(c, "settings_weaken", () => weakenSummary(app, changes, weak.keys), { app, always: weak.always, ...(subject ? { subject } : {}) });
  if (res) return { ok: "approval", response: res };
  return { ok: true, wouldRequireApproval: wouldRequireApproval(c) };
}

async function mfaFloorRefusal(app: App, changes: readonly SettingChange[]): Promise<GuardResult | null> {
  const mfa = changes.find((ch) => ch.category === "edge" && ch.key === "mfa_mode");
  if (!mfa) return null;
  const want = effective(app, "edge.mfa_mode", mfa.value);
  const problems = await mfaModeFloorProblems({ db: app.db.control, instanceId: app.instanceId, changed: new Set(["edge.mfa_mode"]),
    future: (path) => (path === "edge.mfa_mode" ? want : effective(app, path, app.settings.get<unknown>(path, null))),
    current: (path) => effective(app, path, app.settings.get<unknown>(path, null)) });
  if (!problems.length) return null;
  return { ok: false, status: 400, code: "invalid_argument", message: `Settings were not saved: ${problems.map((p) => `${p.key} — ${p.message}`).join("; ")}`,
           keys: ["edge.mfa_mode"], details: { problems: problems.map(({ key, code, message }) => ({ key, code, message })) } };
}

/** A GET /settings item with its informational profile tier and policy metadata (OpenAPI SettingItem). */
export interface Annotated { tier: SettingTier; class?: PolicyClass; pinned?: boolean; db_differs?: boolean; weaken_needs_approval?: boolean }

export function annotate<T extends { category: string; key: string }>(list: T[], app?: Pick<App, "settings">): Array<T & Annotated> {
  const policy = settingsPolicy();
  const inForce = currentAnchors().inForce;
  const on = app ? secondSignatureOn(app) : false;
  return list.map((row) => {
    const tier = tierOfSetting(row.category, row.key);
    const p = policy.keys[`${row.category}.${row.key}`];
    if (!p) return { ...row, tier };
    const rule = weakenRuleOf(p, inForce);
    return { ...row, tier, class: p.class, weaken_needs_approval: rule !== null && p.class !== "immutable" && on };
  });
}

export function auditMode(key: string): "legacy" | "fingerprint" | "value" | "keys_only" {
  return policyOf(key)?.audit ?? "legacy";
}

export function settingAuditDetails(app: Pick<App, "appSecret">, key: string, before: unknown, after: unknown,
                                    o: { secret?: boolean; wouldRequireApproval?: boolean } = {}): Record<string, unknown> {
  const mode = auditMode(key);
  const base: Record<string, unknown> = { op: "setting_change", key, ...(o.wouldRequireApproval ? { would_require_approval: true } : {}) };
  if (mode === "keys_only") return base;
  if (mode === "fingerprint" || o.secret) return { ...base, fingerprint: settingFingerprint(app.appSecret, after) };
  if (mode === "value") return { ...base, old: before ?? null, new: after ?? null };
  return base;
}

interface LdapPlainAfter { keys: string[]; flags: string[] }
interface AfterSave { weakened: string[]; auth: string | null; recipientsBefore: string[]; openCheckWeakened: string[]; mode: SecurityMode | null; ldapPlain: LdapPlainAfter | null }
const afterSave = new WeakMap<readonly SettingChange[], AfterSave>();

export const SM_TEXT = {
  external_gate_closed: "The external perimeter gates are not green, so the perimeter cannot open yet",
  external_profile_unconfirmed: "The external perimeter core keys are weaker than the baseline. Confirm them explicitly in the “Readiness” confirmations before opening the perimeter",
} as const;

const isChannelKey = (path: string): boolean => path.startsWith("smtp.") || path === "admin.alert_recipients";

const HIGH_ANCHORED = (path: string): boolean =>
  /^(ldap|oidc|smtp|admin)\./.test(path) || path === "access.trusted_proxies" || path === "access.system_key_networks" || path === "access.internal_networks";

async function gateRefused(app: App, a: AdminCaller | undefined, problems: ReadonlyArray<{ key: string; flag: string; condition: string }>): Promise<void> {
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "external_gate_refused",
    summary: `Settings batch rejected. With the perimeter open, it would weaken a gate condition (${[...new Set(problems.map((p) => p.key))].slice(0, 6).join(", ")})${a?.login ? `, ${a.login}` : ""}`.slice(0, 300),
    details: { keys: [...new Set(problems.map((p) => p.key))], ...(a?.login ? { admin_login: a.login } : {}), ...(a?.authMethod ? { auth: a.authMethod } : {}) } });
}

export async function contourCheck(c: Context, app: App, changes: readonly SettingChange[],
                                   o: { settings?: Settings; q?: Pick<App["db"]["control"], "query">; mode?: SecurityMode; recovery?: boolean } = {}): Promise<GuardResult | null> {
  const a = (c.get("caller") as { admin?: AdminCaller } | undefined)?.admin;
  const s = o.settings ?? app.settings;
  const current = (p: string): unknown => s.effective(p);
  const list = changes.map((ch) => { const path = `${ch.category}.${ch.key}`; return { path, before: beforeIn(s, path), after: effectiveIn(s, path, ch.value) }; });
  const next = new Map(list.map((x) => [x.path, x.after] as const));
  const future = (p: string): unknown => (next.has(p) ? next.get(p) : current(p));
  const changed = new Set(list.map((x) => x.path));
  const mode: SecurityMode = o.mode ?? effectiveMode(app.settings);

  const broken = gateWouldBreak(future, current, changed, mode);
  if (broken.length) {
    await gateRefused(app, a, broken);
    const keys = [...new Set(broken.map((b) => b.key))];
    return { ok: false, status: 409, code: EXTERNAL_GATE_WOULD_BREAK, message: EXTERNAL_GATE_WOULD_BREAK_TEXT, keys,
             details: { keys, problems: broken.map((b) => ({ key: b.key, flag: b.flag, condition: b.condition })) } };
  }

  const basic = mode === "basic";
  const prepared = await edgePrepared(o.q ?? app.db.control, app.instanceId, { inTx: !!o.q });
  const core = coreChanges(list, current, { edgePrepared: prepared, humanSessions: humanSessionsHere() });
  const needHuman = o.recovery ? core.filter((x) => x.group === "1") : core;
  if (basic && needHuman.length && !isHumanSession(a))
    return { ok: false, status: 403, code: "human_session_required", message: HUMAN_SESSION_REQUIRED_TEXT, keys: needHuman.map((x) => x.key),
             details: { keys: needHuman.map((x) => x.key), groups: [...new Set(needHuman.map((x) => x.group))] } };

  const opening = new Set<ExternalFlag>(openingFlags(list));
  if (core.some((x) => x.group === "1" && !x.key.endsWith("_enabled"))) for (const f of LOGIN_FLAGS) if (current(f) === true) opening.add(f);
  if (opening.size) {
    const pending = list.filter((x) => authcheckReadinessKey(x.path) && canonicalJson(x.before ?? null) !== canonicalJson(x.after ?? null)).map((x) => x.path);
    const facts = { ...(await gateFacts(app, { get: future })), ...(pending.length ? { authcheckSettingsPending: pending } : {}) };
    const failed = [...opening].flatMap((flag) => externalGate(future, facts, flag, mode));
    if (failed.length)
      return { ok: false, status: 409, code: "external_gate_closed", message: `${SM_TEXT.external_gate_closed}: ${failed[0]!.title}`.slice(0, 500), keys: [...opening],
               details: { reason: failed[0]!.reason, failed: failed.map((f) => ({ flag: f.flag, reason: f.reason, title: f.title, ...(f.keys ? { keys: [...f.keys] } : {}) })) } };
    const unconfirmed = await unconfirmedProfile(app, [...opening], future, s, o.q ?? app.db.control);
    if (unconfirmed.length)
      return { ok: false, status: 409, code: "external_profile_unconfirmed", message: SM_TEXT.external_profile_unconfirmed, keys: unconfirmed.map((u) => u.key),
               details: { keys: unconfirmed.map((u) => u.key), problems: unconfirmed } };
  }

  const recipients = current("admin.alert_recipients");
  const ocWeak = list.filter((x) => x.path.startsWith("open_check.") && isWeakening(policyOf(x.path)?.weaken ?? null, x.before, x.after)).map((x) => x.path);
  const inForce = currentAnchors().inForce;
  const always = list.filter((x) => {
    const p = policyOf(x.path);
    return !!p && p.always === true && !(inForce && p.class === "anchored") && isWeakening(weakenRuleOf(p, inForce), x.before, x.after);
  }).map((x) => x.path);
  const prev = afterSave.get(changes);
  const union = (a: readonly string[] | undefined, b: readonly string[]): string[] => [...new Set([...(a ?? []), ...b])];
  afterSave.set(changes, { weakened: union(prev?.weakened, [...core.map((x) => x.key), ...always]), auth: a?.authMethod ?? prev?.auth ?? null,
                           openCheckWeakened: union(prev?.openCheckWeakened, ocWeak),
                           recipientsBefore: union(prev?.recipientsBefore, Array.isArray(recipients) ? recipients.map(String).filter(Boolean) : []),
                           mode: o.mode ?? prev?.mode ?? null,
                           ldapPlain: ldapPlainAfter(list, future, mode) });
  return null;
}

export function ldapPlainAfter(list: ReadonlyArray<{ path: string; before: unknown; after: unknown }>, future: (p: string) => unknown, mode: SecurityMode): LdapPlainAfter | null {
  const flags = LOGIN_FLAGS.filter((f) => future(f) === true);
  if (!flags.length || ldapChannelOf(future, mode).channel !== "plain") return null;
  const keys = list.filter((x) => (LOGIN_FLAGS as readonly string[]).includes(x.path) ? x.before !== true && x.after === true
    : (LDAP_CHANNEL_KEYS as readonly string[]).includes(x.path) && canonicalJson(x.before ?? null) !== canonicalJson(x.after ?? null))
    .map((x) => x.path);
  return keys.length ? { keys, flags: [...flags] } : null;
}

export async function settingsSaved(app: App, changes: readonly SettingChange[], who: string | null, ssoChange?: SsoChange): Promise<void> {
  if (ssoChange?.before === true && ssoChange.after !== true && ssoChange.state) await raiseSsoLoginStateAlert(app, ssoChange.state);
  const memo = afterSave.get(changes);
  afterSave.delete(changes);
  const ctx = { control: app.db.control, audit: app.db.audit };
  // a required second factor ends the local sessions issued without one (also when the value is saved again)
  if (changes.some((ch) => ch.category === "admin" && ch.key === "local_totp_required" && effective(app, "admin.local_totp_required", ch.value) === true))
    await revokeFactorlessLocalSessions(app);
  const basic = memo?.mode ? memo.mode === "basic" : !approvalsRequired(app);
  const paths = changes.map((ch) => `${ch.category}.${ch.key}`);
  const pre = takePreMail(changes);
  if (basic && memo?.weakened.length) await externalWeakened(app, { keys: memo.weakened, admin_login: who, auth: memo.auth, ...(pre ? { old_transport_mail: pre } : {}) });
  if (memo?.ldapPlain)
    await raiseAlert(ctx, { instanceId: app.instanceId, level: "high", code: "external_login_ldap_plain",
      summary: `External sign-in is open (${memo.ldapPlain.flags.join(", ")}), and sign-in passwords go to the domain controller unencrypted${who ? `, ${who}` : ""}: ${memo.ldapPlain.keys.join(", ")}`.slice(0, 300),
      details: { keys: memo.ldapPlain.keys, flags: memo.ldapPlain.flags, channel: "plain", ...(who ? { admin_login: who } : {}), ...(memo.auth ? { auth: memo.auth } : {}) } });
  const channel = paths.filter(isChannelKey);
  const recipients = channel.length ? { recipients_before: memo?.recipientsBefore ?? [] } : {};
  const anchored = currentAnchors().inForce ? [] : paths.filter((p) => policyOf(p)?.class === "anchored");
  if (anchored.length) {
    const high = !basic || anchored.some(HIGH_ANCHORED) || (memo?.openCheckWeakened.length ?? 0) > 0;
    await raiseAlert(ctx, { instanceId: app.instanceId, level: high ? "high" : "medium", code: "settings_anchored_changed",
      summary: `Anchored settings changed while anchors were inactive${who ? `, administrator ${who}` : ""}: ${anchored.slice(0, 8).join(", ")}`.slice(0, 300),
      details: { keys: anchored, ...recipients, ...(who ? { admin_login: who } : {}) } });
  }
  const rest = channel.filter((p) => !anchored.includes(p));
  if (rest.length)
    await raiseAlert(ctx, { instanceId: app.instanceId, level: "high", code: "alert_channel_changed",
      summary: `The alert e-mail channel changed${who ? ` (${who})` : ""}: ${rest.slice(0, 8).join(", ")}. The notification goes to the previous and new recipients`.slice(0, 300),
      details: { keys: rest, ...recipients, ...(who ? { admin_login: who } : {}) } });
}

export const PRE_MAIL_DEADLINE_MS = 8_000;
const PRE_MAIL_ATTEMPT_SEC = 4;

async function preMailOnce(cfg: ReturnType<typeof smtpConfig>, m: { to: string; subject: string; text: string }, left: number): Promise<"sent" | "rejected" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"down">((resolve) => { timer = setTimeout(() => resolve("down"), Math.max(left, 1)); timer.unref?.(); });
  const send = sendMail(cfg, m).then(() => "sent" as const,
    (e: unknown) => { log.warn("transport_pre_mail_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
                      return e instanceof SmtpFailure && e.permanent ? "rejected" as const : "down" as const; });
  try { return await Promise.race([send, late]); } finally { clearTimeout(timer); }
}

export async function transportPreMail(app: App, settings: Settings, changes: readonly SettingChange[], who: string | null,
                                       o: { deadlineMs?: number } = {}): Promise<"sent" | "failed" | "skipped"> {
  const keys = changes.map((ch) => `${ch.category}.${ch.key}`).filter((p) => SMTP_TRANSPORT_RE.test(p))
    .filter((p) => { const ch = changes.find((x) => `${x.category}.${x.key}` === p)!; return canonicalJson(beforeIn(settings, p) ?? null) !== canonicalJson(effectiveIn(settings, p, ch.value) ?? null); });
  if (!keys.length || settings.get<unknown>("smtp.enabled", false) !== true) return "skipped";
  const to = deliverableRecipients(alertRecipients(settings));
  if (!to.length) return "skipped";
  const base = smtpConfig(settings);
  const cfg = { ...base, timeout_sec: Math.min(base.timeout_sec, PRE_MAIL_ATTEMPT_SEC) };
  const deadline = Date.now() + (o.deadlineMs ?? PRE_MAIL_DEADLINE_MS);
  const text = [`The mail transport that sends alert e-mail is being changed: ${keys.join(", ")}${who ? ` (${who})` : ""}.`,
                "This message was sent through the previous transport, before the change. If you are not making this change and it is not planned, check the “Mail (SMTP)” section and the audit log.",
                "The next alert mails will go through the new transport."].join("\n\n");
  let sent = 0;
  for (const addr of to.slice(0, 20)) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const r = await preMailOnce(cfg, { to: addr, subject: "{product}: the mail transport for alerts is being changed", text }, left);
    if (r === "sent") sent++;
    if (r === "down") break;
  }
  return sent > 0 ? "sent" : "failed";
}

const preMail = new WeakMap<readonly SettingChange[], "sent" | "failed">();
export function notePreMail(changes: readonly SettingChange[], r: "sent" | "failed" | "skipped"): void { if (r !== "skipped") preMail.set(changes, r); }
export function takePreMail(changes: readonly SettingChange[]): "sent" | "failed" | undefined { const r = preMail.get(changes); preMail.delete(changes); return r; }

export type { PolicyClass };
