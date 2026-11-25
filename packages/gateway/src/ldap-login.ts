import { identityProviders } from "./identity.ts";
import { localAccountsUsable } from "./local-login.ts";
import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import {
  AD_SUBCODE_TEXT, canonicalObjectGuid, checkConnection, clientText, escapeFilterValue, LDAP_FAILURE_TEXT, LDAP_FAILURE_WINDOW_MINUTES, ldapConfig, LdapFailure,
  ldapFailureWindowMs, lockCustody, loginKey, log, newId, normalizeDn,
  isHumanSession, isTestDomainLogin, oidcConfig, parseLoginName, personId, SUPPORT_CONTACT_SETTING, supportContactOf, tx, type DirectoryEntryRef, type DirectoryPerson,
  type HumanSessionCaller, type LdapConfig, type LdapStep, type LoginName, type LoginOutcome,
} from "@memory/shared";
import type pg from "pg";
import type { App, Caller, PersonRow } from "./context.ts";
import { audit } from "./audit.ts";
import { personCols, scopeFor, workplaceClientAddress } from "./auth.ts";
import { ensurePersonalSpace, renamePersonLogin, type DetachedManager } from "./access.ts";
import { healthState } from "./health.ts";
import { grantPendingMeetings } from "./participants.ts";
import { grantSpaceInvites } from "./space-people.ts";
import { refreshGroupsOnLogin } from "./space-groups.ts";
import { createSession, SESSION_CLIENT_LABEL } from "./user-sessions.ts";
import { fromWorkplace } from "./workplace.ts";
import { operatorOf } from "./operator.ts";
import { ADDRESS_IN_FLIGHT_MAX, FailureWindow, IN_FLIGHT_RETRY_SEC, type WindowLimit, type WindowRefusal } from "./failure-window.ts";
import { ACCOUNT_KEY_PREFIX, AccountFailuresSaver, loadAccountFailures } from "./account-failures.ts";
import { ldapPolicyPrint, LOGIN_POLICY_CHANGED, underLoginPolicy } from "./login-policy.ts";
import { candidatesOf, chooseCard, type CardMatch, type CardRow, type ConflictReason, type LinkResult, type MatchedBy, type Refusal } from "./card-choice.ts";
export { candidatesOf, chooseCard, type CardMatch, type ConflictReason, type LinkResult, type MatchedBy } from "./card-choice.ts";

const GENERIC = "Incorrect login or password";
const NAME_RULES = "Sign-in name — as in the company: jsmith, jsmith@example.com or EXAMPLE\\jsmith (Latin letters, no spaces)";

export { FailureWindow };
export const directoryFailures = new FailureWindow(LDAP_FAILURE_WINDOW_MINUTES.default * 60_000, LDAP_FAILURE_WINDOW_MINUTES.max * 60_000);

export const directoryLimits = (cfg: Pick<LdapConfig, "max_failures_per_login" | "max_failures_per_ip">, loginKeyName: string, ipKey: string): WindowLimit[] =>
  [[loginKeyName, cfg.max_failures_per_login, cfg.max_failures_per_login, "run"], [ipKey, cfg.max_failures_per_ip, ADDRESS_IN_FLIGHT_MAX, "window"]];

export const directoryAccountKey = (entry: DirectoryEntryRef): string =>
  `${ACCOUNT_KEY_PREFIX}${createHash("sha256").update(entry.guid ? `guid:${entry.guid}` : `dn:${normalizeDn(entry.dn)}`).digest("hex").slice(0, 32)}`;
export const accountLimits = (cfg: Pick<LdapConfig, "max_failures_per_login">, accountKey: string): WindowLimit[] =>
  [[accountKey, cfg.max_failures_per_login, cfg.max_failures_per_login, "run"]];

let accountSaver: AccountFailuresSaver | null = null;
export async function restoreDirectoryFailures(app: Pick<App, "db" | "instanceId">): Promise<void> {
  try {
    const n = await loadAccountFailures(app.db.control, app.instanceId, directoryFailures);
    log.info("ldap_account_failures_restored", { accounts: n });
  } catch (e) { log.warn("ldap_account_failures_restore_failed", { error: clientText(e) }); }
  accountSaver = new AccountFailuresSaver(app.db.control, app.instanceId, directoryFailures);
}
export const flushDirectoryFailures = (): Promise<void> => accountSaver?.flush() ?? Promise.resolve();

export type DirectoryAttempt =
  | { kind: "limited"; refusal: WindowRefusal }
  | { kind: "answered"; outcome: Exclude<LoginOutcome, { kind: "held" }> }
  | { kind: "failed"; failure: LdapFailure };

export async function attemptDirectoryLogin(cfg: LdapConfig, name: LoginName, password: string, keys: { login: string; address: string },
                                            trace?: LdapStep[]): Promise<DirectoryAttempt> {
  const windowMs = ldapFailureWindowMs(cfg);
  const slot = directoryFailures.reserve(directoryLimits(cfg, keys.login, keys.address), Date.now(), windowMs);
  if ("wait" in slot) return { kind: "limited", refusal: slot };
  const gate: { key: string | null; slot: { release: () => void } | null; refusal: WindowRefusal | null } = { key: null, slot: null, refusal: null };
  const failed = () => {
    directoryFailures.record([keys.address, keys.login, ...(gate.key ? [gate.key] : [])]);
    if (gate.key) accountSaver?.touch();
  };
  let outcome: LoginOutcome | undefined, hold: Promise<void> | null = null;
  try {
    outcome = await identityProviders.get("ldap").login(cfg, name, password, { ...(trace ? { trace } : {}), beforeBind: (entry) => {
      const key = directoryAccountKey(entry), s = directoryFailures.reserve(accountLimits(cfg, key), Date.now(), windowMs);
      if ("wait" in s) { gate.refusal = s; return false; }
      gate.key = key; gate.slot = s;
      return true;
    } });
  } catch (e) {
    const failure = e instanceof LdapFailure ? e : new LdapFailure("ldap_unreachable", clientText(e));
    if (failure.unansweredBind) { failed(); hold = failure.unansweredBind.settled; }
    return { kind: "failed", failure };
  } finally {
    if (outcome && !outcome.ok && outcome.kind === "invalid_credentials") failed();
    const release = () => { slot.release(); gate.slot?.release(); };
    if (hold) void hold.then(release, release); else release();
  }
  if (!outcome.ok && outcome.kind === "held") return { kind: "limited", refusal: gate.refusal ?? { wait: IN_FLIGHT_RETRY_SEC, inFlight: false } };
  if (outcome.ok || outcome.kind === "not_in_group") {
    directoryFailures.clear([keys.login, ...(gate.key ? [gate.key] : [])]);
    if (gate.key) accountSaver?.touch();
  }
  return { kind: "answered", outcome };
}

export const sockAddr = (remote: string | null): string | null => remote?.replace(/^::ffff:/, "") ?? null;

export function inFlightRefusal(slot: WindowRefusal, loginKeyName: string):
  { message: string | null; body: Record<string, string>; audit: Record<string, unknown> } {
  if (!slot.inFlight) return { message: null, body: {}, audit: {} };
  return slot.key === loginKeyName || slot.key.startsWith(ACCOUNT_KEY_PREFIX)
    ? { message: "A sign-in for this account is already being checked. Try again in a few seconds", body: { reason: "in_flight" }, audit: { in_flight: true } }
    : { message: "Too many sign-in attempts from this address. Try again in a few seconds", body: { reason: "in_flight_address" }, audit: { in_flight: true, in_flight_by: "address" } };
}

type Q = Pick<pg.PoolClient, "query">;
const CARD = `p.id, p.login, p.employee_id, p.active, COALESCE(p.attrs->>'demo','') = 'true' AS demo,
  EXISTS (SELECT 1 FROM person_identities o WHERE o.person_id = p.id AND o.system = 'ad' AND o.active
          AND COALESCE(o.source, '') <> 'rename' AND lower(btrim(o.external_id, '{} ')) <> $1) AS bound_elsewhere`;

export const canonicalGuid = (v: unknown): string | null => canonicalObjectGuid(v);

export async function importedIdentityOwner(q: Q, system: string, external: string, personId: string): Promise<string | null> {
  const r = await q.query(`SELECT person_id FROM person_identities WHERE system = $1 AND person_id <> $3
                             AND (external_id = $2 OR ($1 = 'ad' AND COALESCE(source, '') <> 'rename' AND lower(btrim(external_id, '{} ')) = $2)) LIMIT 1`,
                          [system, external, personId]);
  return (r.rows[0]?.person_id as string | undefined) ?? null;
}

export async function upsertImportedIdentity(q: Q, o: { system: string; external: string; personId: string; verified: boolean; verifiedBy: string | null; label: string }): Promise<boolean> {
  const r = await q.query(`INSERT INTO person_identities (system, external_id, person_id, verified, verified_at, verified_by, verified_label, source)
                 VALUES ($1,$2,$3,$4,CASE WHEN $4 THEN now() END,CASE WHEN $4 THEN $5::uuid END,CASE WHEN $4 THEN $6 END,'org_table')
                 ON CONFLICT (system, external_id) DO UPDATE SET verified = person_identities.verified OR EXCLUDED.verified,
                   verified_at = CASE WHEN person_identities.verified THEN person_identities.verified_at ELSE EXCLUDED.verified_at END,
                   verified_by = CASE WHEN person_identities.verified THEN person_identities.verified_by ELSE EXCLUDED.verified_by END,
                   verified_label = CASE WHEN person_identities.verified THEN person_identities.verified_label ELSE EXCLUDED.verified_label END,
                   active = true
                 RETURNING COALESCE((SELECT p.active FROM person_identities p WHERE p.system = $1 AND p.external_id = $2), false) AS was_active`,
                [o.system, o.external, o.personId, o.verified, o.verifiedBy, o.label]);
  return r.rows[0]?.was_active !== true;
}

export async function matchCard(q: Q, instanceId: string, dp: DirectoryPerson): Promise<CardMatch> {
  const g = (await q.query(`SELECT ${CARD}, i.active AS link_active, i.verified AS link_verified FROM person_identities i JOIN people p ON p.id = i.person_id
                            WHERE i.system = 'ad' AND i.external_id = $1 AND COALESCE(i.source, '') <> 'rename' AND p.instance_id = $2`, [dp.guid, instanceId])).rows[0];
  const e = dp.employeeId ? (await q.query(`SELECT ${CARD} FROM people p WHERE p.employee_id = $2 AND p.instance_id = $3`, [dp.guid, dp.employeeId, instanceId])).rows[0] : null;
  const m = dp.mail ? (await q.query(`SELECT ${CARD} FROM people p WHERE p.login = $2 AND p.instance_id = $3`, [dp.guid, dp.mail, instanceId])).rows[0] : null;
  return { guidLink: g ?? null, byEmployee: e ?? null, byMail: m ?? null };
}


export const LINK_REFUSAL_TEXT: Record<ConflictReason | "guid_unconfirmed", string> = {
  two_cards: "This company account matches two profiles in memory. Sign-in was denied. Contact the memory administrator",
  other_guid: "The profile in memory with your e-mail address or employee number is already linked to another company account. Sign-in was denied. Contact the memory administrator",
  race: "The profile in memory changed during sign-in. Sign in again. If it fails again, contact the memory administrator",
  guid_unconfirmed: "The link between your company account and the profile in memory is unconfirmed. Sign-in was denied. Contact the memory administrator",
};


export async function setGivenName(q: Q, personId: string, givenName: string | null | undefined): Promise<void> {
  if (!givenName) return;
  await q.query("UPDATE people SET attrs = jsonb_set(attrs, '{given_name}', to_jsonb($2::text)) WHERE id = $1 AND attrs->>'given_name' IS DISTINCT FROM $2", [personId, givenName]);
}

class LinkRefused extends Error { constructor(readonly result: Refusal) { super(result.kind); } }
const raced = (e: unknown): boolean => ["23505", "40P01"].includes(String((e as { code?: unknown } | null)?.code ?? ""));

export async function linkPerson(app: App, dp: DirectoryPerson, o: { trustMail?: boolean; via?: "ldap" | "oidc" } = {}): Promise<LinkResult> {
  if (!dp.mail || !/^[^@\s]+@[^@\s]+$/.test(dp.mail)) return { kind: "no_mail" };
  const guid = canonicalGuid(dp.guid);
  if (!guid) return { kind: "bad_guid" };
  const d: DirectoryPerson = { ...dp, guid };
  const mail = dp.mail, trust = o.trustMail !== false, via = o.via ?? "ldap";
  let res: LinkResult;
  try {
    res = await tx(app.db.control, async (q): Promise<LinkResult> => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ldap:${guid}`]);
      let m = await matchCard(q, app.instanceId, d);
      let choice = chooseCard(m, trust);
      if (choice.kind !== "card") return choice;
      const renames = trust && !!choice.card && choice.card.login !== mail;
      if (renames) await lockCustody(q, app.instanceId);
      const picked = choice.card?.id ?? null;
      if (picked) {
        await q.query("SELECT 1 FROM people WHERE id = $1 FOR UPDATE", [picked]);
        m = await matchCard(q, app.instanceId, d);
        choice = chooseCard(m, trust);
        if (choice.kind !== "card") return choice;
        if (choice.card?.id !== picked) return { kind: "conflict", reason: "race", candidates: [picked] };
      }
      let id: string, created = false, renamedFrom: string | null = null;
      let detached: DetachedManager[] = [];
      if (!choice.card) {
        const derived = personId(mail);
        id = (await q.query("SELECT 1 FROM people WHERE id = $1", [derived])).rowCount ? newId() : derived;
        await q.query(
          `INSERT INTO people (id, login, employee_id, display_name, department, instance_id, active, attrs) VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
          [id, mail, d.employeeId, d.name ?? mail, d.department, app.instanceId, JSON.stringify({ source: via === "oidc" ? "keycloak" : "ad", ...(d.givenName ? { given_name: d.givenName } : {}) })]);
        await ensurePersonalSpace(q, app.instanceId, id, mail, d.name ?? mail);
        created = true;
      } else {
        const card = choice.card;
        id = card.id;
        if (trust && card.login !== mail) {
          if (!renames) throw new LinkRefused({ kind: "conflict", reason: "race", candidates: [card.id] });
          detached = await renamePersonLogin(q, app.instanceId, card.id, card.login, mail); renamedFrom = card.login;
        }
        if (trust && !card.employee_id && d.employeeId && !m.byEmployee) await q.query("UPDATE people SET employee_id = $2 WHERE id = $1 AND employee_id IS NULL", [card.id, d.employeeId]);
      }
      const linked = await q.query(
        `INSERT INTO person_identities (system, external_id, person_id, verified, verified_at, verified_label, source, active)
         VALUES ('ad', $1, $2, true, now(), $3, $4, true)
         ON CONFLICT (system, external_id) DO UPDATE SET active = true, verified = true, verified_at = COALESCE(person_identities.verified_at, now()),
           verified_label = COALESCE(person_identities.verified_label, $3)
         WHERE person_identities.person_id = EXCLUDED.person_id AND COALESCE(person_identities.source, '') <> 'rename' AND $5::boolean
         RETURNING person_id`, [guid, id, via, `${via}_login`, m.guidLink?.id === id]);
      if (linked.rowCount !== 1) throw new LinkRefused({ kind: "conflict", reason: "race", candidates: [id] });
      if (!created) await setGivenName(q, id, d.givenName);
      const login = created || renamedFrom ? mail : choice.card!.login;
      return { kind: "ok", personId: id, login, created, renamedFrom, matchedBy: choice.matchedBy,
               ...(detached.length ? { detached: detached.map((d) => ({ person: d.person, space: d.space })) } : {}) };
    });
  } catch (e) {
    if (e instanceof LinkRefused) res = e.result;
    else if (raced(e)) res = { kind: "conflict", reason: "race", candidates: [] };
    else throw e;
    log.warn("directory_link_race", { via, code: e instanceof LinkRefused ? "link_taken" : String((e as { code?: unknown }).code), constraint: (e as { constraint?: unknown }).constraint ?? null });
  }
  if (res.kind === "ok" && res.matchedBy === "guid_restored") log.warn("directory_link_restored", { via, person: res.personId });
  if (res.kind === "ok" && res.detached?.length) {
    log.warn("custody_manager_detached", { via, renamed: res.personId, people: res.detached.length });
    for (const d of res.detached)
      await audit(app, null, { event_type: "admin", space_id: d.space,
                               details: { op: "custody_manager_detached", person: d.person, manager_login: res.login, renamed: res.personId, source: via } });
  }
  if (res.kind === "ok") {
    const grant = grantPendingMeetings(app, [{ id: res.personId, login: res.login }], `${via}_login`, null);
    if (res.created || res.renamedFrom) {
      await grant;
      await grantSpaceInvites(app, [{ id: res.personId, login: res.login }], `${via}_login`);
    } else void grant.catch((e: unknown) => log.warn("meeting_pending_grant_failed", { via: `${via}_login`, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
  return res;
}

export function sessionCallerOf(person: PersonRow, sessionId: string, ip: string | null, expiresAt: string): Caller {
  return { keyId: sessionId, keyKind: "session", tier: "T0", principalType: "person", person, service: null, onBehalfOf: false, allowedOps: null,
           clientLabel: SESSION_CLIENT_LABEL, clientKind: null, expiresAt: new Date(expiresAt), ip, netBound: false, preview: false, scope: scopeFor("session", "T0"), baseUrl: "" };
}

export function registerLdapLogin(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null): void {
  r.get("/api/v1/auth/methods", async (c) => {
    const cfg = identityProviders.get("ldap").config(app.settings);
    return c.json({ ldap: { enabled: cfg.enabled, domains: cfg.domains }, oidc: { enabled: identityProviders.get("oidc").config(app.settings).enabled },
                    local: { enabled: await localAccountsUsable(app) },
                    support_contact: supportContactOf(app.settings.get<unknown>(SUPPORT_CONTACT_SETTING, "")) });
  });

  r.post("/api/v1/auth/ldap", async (c) => {
    const sock = sockAddr(remoteOf(c));
    if (!(await fromWorkplace(app, sock))) return c.json({ code: "forbidden", message: "Sign-in with a company account is accepted only from the workspace server" }, 403);
    if ((await healthState(app)).status === "fail_closed") return c.json({ code: "forbidden", message: "The installation is not serving requests (fail-closed): see /api/v1/health" }, 503);
    const ip = await workplaceClientAddress(app, (n) => c.req.header(n), sock);
    const b = await c.req.json().catch(() => null);
    const cfg = identityProviders.get("ldap").config(app.settings), policy = ldapPolicyPrint(cfg);
    if (!cfg.enabled) return c.json({ code: "ldap_disabled", message: LDAP_FAILURE_TEXT.ldap_disabled }, 503);
    const name = parseLoginName(String(b?.login ?? ""));
    const password = typeof b?.password === "string" ? b.password : "";
    if (!name) return c.json({ code: "invalid_argument", message: NAME_RULES }, 400);
    if (password.length > 1024) return c.json({ code: "invalid_argument", message: "The password is longer than 1024 characters" }, 400);

    const account = loginKey(name), ipKey = `ip:${ip ?? "?"}`, loginKeyName = `login:${account}`;
    const attempt = await attemptDirectoryLogin(cfg, name, password, { login: loginKeyName, address: ipKey });
    if (attempt.kind === "limited") {
      const slot = attempt.refusal, busy = inFlightRefusal(slot, loginKeyName);
      await audit(app, null, { event_type: "rate_limited", details: { reason: "ldap_login", login: account, ...busy.audit }, ip });
      c.header("Retry-After", String(slot.wait));
      return c.json({ code: "rate_limited", message: busy.message ?? `Too many failed sign-in attempts. Try again in ${Math.ceil(slot.wait / 60)} min.`,
                      retry_after: slot.wait, ...busy.body }, 429);
    }
    const reject = async (status: 401 | 403 | 409 | 503, code: string, message: string, result: string, extra: Record<string, unknown> = {}) => {
      await audit(app, null, { event_type: "auth_failure", details: { reason: "ldap_login", result, login: account, ...extra }, ip });
      return c.json({ code, message }, status);
    };
    if (attempt.kind === "failed") {
      const f = attempt.failure, counted = f.unansweredBind ? { counted: true } : {};
      log.warn("ldap_login_failed", { code: f.code, account, detail: f.detail, ...counted });
      return reject(503, f.code, f.message, f.code, counted);
    }
    const outcome = attempt.outcome;
    if (!outcome.ok && outcome.kind === "invalid_credentials") {
      log.info("ldap_login_rejected", { account, reason: outcome.reason, ad_code: outcome.adCode, matches: outcome.matches });
      return reject(401, "unauthorized", GENERIC, "invalid_credentials");
    }
    if (!outcome.ok) {
      log.info("ldap_login_not_in_group", { account, groups: outcome.person.groups.length });
      return reject(403, "ldap_not_in_group", "The company account is outside the memory access group. Contact the memory administrator", "not_in_group");
    }
    let stage = "link", sessionId: string | null = null;
    try {
      const linked = await linkPerson(app, outcome.person);
      if (linked.kind === "bad_guid") {
        log.warn("ldap_login_failed", { code: "ldap_attribute_missing", account, detail: "objectGUID is not 16 bytes long or is all zeros" });
        return await reject(503, "ldap_attribute_missing", LDAP_FAILURE_TEXT.ldap_attribute_missing, "ldap_attribute_missing");
      }
      if (linked.kind === "no_mail") return await reject(403, "ldap_no_mail", "The company account has no e-mail address, which memory uses as the login. Contact the directory administrator", "no_mail");
      if (linked.kind === "conflict") {
        log.warn("ldap_login_conflict", { account, reason: linked.reason, candidates: linked.candidates });
        return await reject(409, "person_conflict", LINK_REFUSAL_TEXT[linked.reason], "conflict", { conflict: linked.reason, candidates: linked.candidates });
      }
      if (linked.kind === "guid_unconfirmed") {
        log.warn("ldap_login_guid_unconfirmed", { account, person: linked.personId, link: linked.state });
        return await reject(409, "guid_link_unconfirmed", LINK_REFUSAL_TEXT.guid_unconfirmed, "guid_link_unconfirmed", { person: linked.personId, link: linked.state });
      }
      if (linked.kind === "inactive") return await reject(403, "person_inactive", "The profile in memory is inactive. Contact the memory administrator", "person_inactive", { person: linked.personId });
      if (linked.kind !== "ok") return await reject(503, "internal", "The profile could not be matched. Try signing in again later", linked.kind);
      stage = "session";
      const person: PersonRow = (await app.db.control.query(`SELECT ${personCols()} FROM people WHERE id = $1`, [linked.personId])).rows[0];
      sessionId = newId();
      const pre = sessionCallerOf(person, sessionId, ip, new Date().toISOString());
      if (linked.created) await audit(app, pre, { event_type: "admin", details: { op: "person_created", person: person.id, source: "ldap" } });
      if (linked.renamedFrom) await audit(app, pre, { event_type: "admin", details: { op: "person_login_changed", person: person.id, from: linked.renamedFrom, to: person.login, source: "ldap" } });
      await refreshGroupsOnLogin(app, linked.personId, outcome.person.groups, pre)
        .catch((e) => log.warn("group_login_refresh_failed", { account, person: linked.personId, error: clientText(e) }));
      try {
        await audit(app, pre, { event_type: "admin", details: { op: "login", source: "ldap", session_id: sessionId, matched_by: linked.matchedBy, server: outcome.server }, ip }, { strict: true });
      } catch {
        sessionId = null;
        return c.json({ code: "internal", message: "The audit log is unavailable, so sign-in was not completed. Try again later" }, 503);
      }
      const issued = await underLoginPolicy(app, (s) => ldapPolicyPrint(ldapConfig(s)), policy,
        (q) => createSession(app, person.id, "ldap", { id: sessionId!, ip, userAgent: c.req.header("x-memory-client-ua") ?? null, q, authTime: "now" }));
      if (!issued.ok) {
        log.info("ldap_login_policy_changed", { account, person: person.id });
        return await reject(503, "login_policy_changed", LOGIN_POLICY_CHANGED, "config_changed", { session_id: sessionId });
      }
      const s = issued.value;
      log.info("ldap_login", { account, person: person.id, session: s.id, created: linked.created, matched_by: linked.matchedBy });
      return c.json({ token: s.token, session: { id: s.id, expires_at: s.expires_at, source: s.source }, person: { id: person.id, login: person.login, created: linked.created } }, 201);
    } catch (e) {
      const extra = { stage, ...(sessionId ? { session_id: sessionId } : {}) };
      log.error("ldap_login_internal", { account, ...extra, error: clientText(e), stack: String((e as Error)?.stack ?? "").slice(0, 4000) });
      return reject(503, "internal", "Sign-in was not completed because of an internal memory error. Try again later", "internal", extra);
    }
  });
}

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

const PREVIEW_TEXT: Record<string, string> = {
  ldap_attribute_missing: `${LDAP_FAILURE_TEXT.ldap_attribute_missing} (objectGUID is not 16 bytes long)`,
  guid_conflict: "Sign-in will be denied: the profile with this e-mail address or employee number is already linked to another directory account (a different objectGUID linked by sign-in or the org table). A match does not change the link",
  guid_link_unconfirmed: "Sign-in will be denied: the link between this objectGUID and the profile is unconfirmed (provisional from the org table or disabled), and the directory employee number and e-mail address point elsewhere",
};

async function rightsPreview(app: App, personIdOrNull: string | null): Promise<Record<string, unknown>> {
  const base = { base: "employee: their personal space, Company knowledge, their teams and their department’s space (from the org table)" };
  if (!personIdOrNull) return { ...base, roles: [], note: "the profile is created at first sign-in; the memory administrator assigns roles" };
  const { rows } = await app.db.control.query(
    `SELECT role_code, scope_kind, scope_ref, valid_to FROM role_grants WHERE person_id = $1 AND instance_id = $2 AND revoked_at IS NULL
       AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY role_code`, [personIdOrNull, app.instanceId]);
  const spaces = (await app.db.control.query("SELECT count(*)::int AS n FROM space_members_effective WHERE person_id = $1", [personIdOrNull]).catch(() => ({ rows: [{ n: null }] }))).rows[0]?.n ?? null;
  return { ...base, roles: rows, member_of_spaces: spaces };
}

export const TEST_LOGIN_OWN_ONLY = "test_login_own_only";
export const TEST_LOGIN_OWN_ONLY_TEXT = "You can only test sign-in with your own account or a test login (a .test or corp.test domain). The admin panel does not check someone else’s password";

export async function testLoginAddress(app: App, c: Context, name: LoginName): Promise<string | null> {
  if (name.form === "upn" && isTestDomainLogin(name.upn)) return name.upn.toLowerCase();
  const { person } = await operatorOf(app, c);
  if (!person) return null;
  const own = person.login.toLowerCase();
  const ok = name.form === "upn" ? name.upn.toLowerCase() === own : name.account.toLowerCase() === own.split("@")[0];
  return ok ? own : null;
}

export const testLoginAllowed = async (app: App, c: Context, name: LoginName): Promise<boolean> => (await testLoginAddress(app, c, name)) !== null;

export const testLoginFilter = (userFilter: string, address: string): string => {
  const a = escapeFilterValue(address);
  return `(&${userFilter}(|(userPrincipalName=${a})(mail=${a})))`;
};

export function registerLdapAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit, remoteOf: (c: Context) => string | null): void {
  r.post("/ldap/check", async (c) => {
    const cfg = ldapConfig(app.settings);
    const admin = (c.get("caller") as { admin?: HumanSessionCaller | null } | undefined)?.admin ?? null;
    const res = await checkConnection(cfg, { human: isHumanSession(admin) });
    const failedSteps = res.steps.filter((s) => s.status === "fail");
    await adminAudit(c, "ldap_check", { ok: res.ok, failed: failedSteps.map((s) => s.code ?? s.step), failed_steps: failedSteps.map((s) => s.step) });
    return c.json({ ...res, mode: cfg.tls_mode, enabled: cfg.enabled });
  });

  r.post("/ldap/test-login", async (c) => {
    const b = await c.req.json().catch(() => null);
    const cfg: LdapConfig = { ...ldapConfig(app.settings), enabled: true };
    const name = parseLoginName(String(b?.login ?? ""));
    const password = typeof b?.password === "string" ? b.password : "";
    if (!name) return c.json({ code: "invalid_argument", message: NAME_RULES }, 400);
    const address = await testLoginAddress(app, c, name);
    if (!address) return c.json({ code: "forbidden", reason: TEST_LOGIN_OWN_ONLY, message: TEST_LOGIN_OWN_ONLY_TEXT }, 403);
    cfg.user_filter = testLoginFilter(cfg.user_filter, address);
    const account = loginKey(name), loginKeyName = `login:${account}`, ipKey = `admin:${sockAddr(remoteOf(c)) ?? "?"}`;
    const steps: LdapStep[] = [];
    const attempt = await attemptDirectoryLogin(cfg, name, password, { login: loginKeyName, address: ipKey }, steps);
    if (attempt.kind === "limited") {
      const slot = attempt.refusal, busy = inFlightRefusal(slot, loginKeyName);
      c.header("Retry-After", String(slot.wait));
      return c.json({ code: "rate_limited", message: busy.message
        ?? `Too many failed attempts for this account. Try again in ${Math.ceil(slot.wait / 60)} min. (The ldap.max_failures_per_login limit protects the account from lockout in AD)`, retry_after: slot.wait,
        ...busy.body }, 429);
    }
    let result: Record<string, unknown>;
    try {
      if (attempt.kind === "failed") {
        if (attempt.failure.unansweredBind)
          steps.push({ step: "user_bind", status: "fail", code: attempt.failure.code,
                       message: "the directory did not respond to the password check. The attempt counts toward the account’s failed sign-in limit because the directory may have counted it too" });
        throw attempt.failure;
      }
      const out = attempt.outcome;
      if (!out.ok && out.kind === "invalid_credentials") {
        result = { ok: false, outcome: out.reason, ad_code: out.adCode, ad_text: out.adCode ? AD_SUBCODE_TEXT[out.adCode] ?? null : null,
                   message: out.reason === "empty_password" ? "An empty password will not be checked because the directory would accept it as anonymous sign-in" :
                            out.reason === "domain_not_allowed" ? `The domain “${name.domain}” is outside ldap.domains` :
                            out.reason === "ambiguous" ? "The filter found more than one match. Sign-in would be denied before the password check" :
                            out.reason === "not_found" ? "The filter found no records" : "The directory rejected the password (the person would see “Wrong login or password”)" };
      } else {
        const dp = out.person, guid = canonicalGuid(dp.guid);
        const m: CardMatch = guid ? await matchCard(app.db.control, app.instanceId, { ...dp, guid }) : { guidLink: null, byEmployee: null, byMail: null };
        const ids = candidatesOf(m);
        const choice = chooseCard(m, true);
        const g = m.guidLink, card = choice.kind === "card" ? choice.card : g ?? m.byEmployee ?? m.byMail;
        const would = !out.ok ? "not_in_group" : !guid ? "ldap_attribute_missing" : !dp.mail ? "no_mail"
          : choice.kind === "card" ? (choice.card ? "login" : "create_card")
          : choice.kind === "conflict" ? (choice.reason === "other_guid" ? "guid_conflict" : "conflict")
          : choice.kind === "guid_unconfirmed" ? "guid_link_unconfirmed" : choice.kind === "inactive" ? "person_inactive" : choice.kind;
        result = {
          ok: out.ok && (would === "login" || would === "create_card"), outcome: would, ...(PREVIEW_TEXT[would] ? { message: PREVIEW_TEXT[would] } : {}),
          attributes: { dn: dp.dn, account: dp.account, mail: dp.mail, name: dp.name, given_name: dp.givenName ?? null, department: dp.department, employee_id: dp.employeeId, guid: dp.guid, groups: dp.groups, matched_groups: dp.matchedGroups },
          login: dp.mail,
          card: { matched_by: choice.kind === "card" ? (choice.card ? choice.matchedBy : null) : g ? (g.link_active && g.link_verified ? "guid" : "guid_unconfirmed") : m.byEmployee ? "employee_id" : m.byMail ? "mail" : null,
                  candidates: ids, login: card?.login ?? null,
                  renamed_to: choice.kind === "card" && choice.card && dp.mail && choice.card.login !== dp.mail ? dp.mail : null,
                  guid_link_inactive: choice.kind === "card" && choice.matchedBy === "guid_restored" },
          rights: await rightsPreview(app, ids.length === 1 ? ids[0]! : null),
        };
      }
    } catch (e) {
      const f = e instanceof LdapFailure ? e : new LdapFailure("ldap_unreachable", clientText(e));
      steps.push({ step: "failure", status: "fail", code: f.code, message: f.message, detail: f.detail });
      result = { ok: false, outcome: f.code, message: f.message };
    }
    await adminAudit(c, "ldap_test_login", { login: account, outcome: result.outcome });
    return c.json({ ...result, steps, session_created: false });
  });
}
