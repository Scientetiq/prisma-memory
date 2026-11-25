import {
  AndFilter, EqualityFilter, ExtensibleFilter, InsufficientAccessError, InvalidCredentialsError, NoSuchObjectError, OrFilter, PresenceFilter,
  ResultCodeError, type Client, type Filter,
} from "ldapts";
import {
  adBindSubcode,
  clientText,
  closeClient,
  directoryEntryByGuid,
  domainRootDn,
  groupNameBases,
  LdapFailure,
  normalizeDn,
  openClient,
  serviceSession,
  withDeadline,
  type LdapConfig,
  type LdapTarget,
} from "./ldap.ts";

const EPOCH_1601_MS = 11_644_473_600_000n;
export const AD_FILETIME_NEVER = "9223372036854775807";

export function filetimeToMs(v: unknown): number | null {
  const s = textOf(v);
  if (s === null || !/^-?\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  if (n <= 0n || s === AD_FILETIME_NEVER) return null;
  return Number(n / 10_000n - EPOCH_1601_MS);
}

export function msToFiletime(ms: number): string {
  return ms > 0 ? ((BigInt(Math.trunc(ms)) + EPOCH_1601_MS) * 10_000n).toString() : "0";
}

export function adIntervalToMs(v: unknown): number | null {
  const s = textOf(v);
  if (s === null || !/^-?\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  if (n === -9223372036854775808n) return null;
  return Number((n < 0n ? -n : n) / 10_000n);
}

export interface AdLockoutPolicy { threshold: number; windowMs: number }

export const UF_ACCOUNTDISABLE = 0x2;
export const UF_LOCKOUT = 0x10;
export const RULE_IN_CHAIN = "1.2.840.113556.1.4.1941";
export const PSO_CONTAINER_RDN = "CN=Password Settings Container,CN=System";

export type GroupsProblem = "groups_unreadable" | "group_unresolved" | "group_ambiguous";

export interface AccountState {
  dn: string;
  guid: string;
  /** userAccountControl & ACCOUNTDISABLE */
  disabled: boolean;
  expired: boolean;
  locked: boolean | null;
  adminCount: boolean;
  groups: string[];
  groupsProblem: GroupsProblem | null;
  pwdLastSetMs: number | null;
  mustChangePassword: boolean;
  counters: { badPwdCount: number; badPasswordTimeMs: number | null } | null;
  pso: { dn: string | null; policy: AdLockoutPolicy | null } | null;
  domain: AdLockoutPolicy | null;
}

export interface GroupLists {
  allow: readonly string[];
  deny: readonly string[];
}

export interface ReadAccountOptions {
  groups: GroupLists;
  lockout?: boolean;
  now?: () => number;
}

const ATTRS = {
  uac: "userAccountControl", expires: "accountExpires", pwdLastSet: "pwdLastSet", adminCount: "adminCount", pso: "msDS-ResultantPSO",
  badPwd: "badPwdCount", badTime: "badPasswordTime", lockoutTime: "lockoutTime", computed: "msDS-User-Account-Control-Computed",
} as const;
const PSO_ATTRS = ["msDS-LockoutThreshold", "msDS-LockoutObservationWindow"] as const;
const GROUP_NAME_MAX = 10;
const PSO_MAX = 50, PSO_CHECKS_MAX = 50;

function attr(e: Record<string, unknown>, name: string): unknown {
  if (name in e) return e[name];
  const k = Object.keys(e).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : e[k];
}
/**
 * @internal — exported for tests.
 */
export function attrValues(e: Record<string, unknown>, name: string): string[] {
  const n = name.toLowerCase();
  return Object.keys(e).filter((k) => k.toLowerCase() === n || k.toLowerCase().startsWith(`${n};range=`)).flatMap((k) => listOf(e[k]));
}
function textOf(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (Buffer.isBuffer(x)) return x.toString("utf8");
  return typeof x === "string" ? x : null;
}
function intOf(v: unknown): number | null {
  const s = textOf(v);
  return s !== null && /^-?\d{1,12}$/.test(s.trim()) ? Number(s.trim()) : null;
}
function listOf(v: unknown): string[] {
  return ([] as unknown[]).concat(v ?? []).map((x) => (Buffer.isBuffer(x) ? x.toString("utf8") : String(x))).filter(Boolean);
}

function readFailure(e: unknown): LdapFailure {
  if (e instanceof LdapFailure) return e;
  if (e instanceof ResultCodeError) return new LdapFailure("ldap_search_failed", clientText(e));
  return new LdapFailure("ldap_unreachable", clientText(e));
}

export type AccountLdapConfig = LdapConfig & { plain_allowed?: boolean };

function requireTls(cfg: AccountLdapConfig): void {
  if (cfg.tls_mode === "none" && cfg.plain_allowed !== true) {
    throw new LdapFailure("ldap_tls_failed", "memory-authcheck connects to the directory without encryption only when the mode allows it (basic, insecure_ack, with “LDAPS only” off)");
  }
}

async function readBase(cfg: LdapConfig, client: Client, dn: string, attributes: string[]): Promise<Record<string, unknown> | null> {
  try {
    const r = await client.search(dn, { scope: "base", filter: "(objectClass=*)", attributes, sizeLimit: 1, timeLimit: cfg.timeout_sec, derefAliases: "never" });
    return (r.searchEntries[0] as Record<string, unknown> | undefined) ?? null;
  } catch (e) {
    if (e instanceof NoSuchObjectError) return null;
    throw readFailure(e);
  }
}

async function matches(cfg: LdapConfig, client: Client, dn: string, filter: Filter): Promise<boolean> {
  try {
    const r = await client.search(dn, { scope: "base", filter, attributes: ["1.1"], sizeLimit: 1, timeLimit: cfg.timeout_sec, derefAliases: "never" });
    return r.searchEntries.length > 0;
  } catch (e) {
    if (e instanceof NoSuchObjectError) return false;
    throw readFailure(e);
  }
}

function policyOf(e: Record<string, unknown> | null, thresholdAttr: string, windowAttr: string): AdLockoutPolicy | null {
  if (!e) return null;
  const threshold = intOf(attr(e, thresholdAttr)), windowMs = adIntervalToMs(attr(e, windowAttr));
  if (threshold === null || threshold < 0 || windowMs === null) return null;
  return { threshold, windowMs };
}

export function strictestPolicy(ps: readonly AdLockoutPolicy[]): AdLockoutPolicy | null {
  if (!ps.length) return null;
  const positive = ps.map((p) => p.threshold).filter((t) => t > 0);
  return { threshold: positive.length ? Math.min(...positive) : 0, windowMs: Math.max(...ps.map((p) => p.windowMs)) };
}

const deadlineOf = (cfg: LdapConfig): number => (cfg.connect_timeout_sec * 2 + cfg.timeout_sec * 12) * 1000;

const isGroup = (): Filter => new EqualityFilter({ attribute: "objectClass", value: "group" });

async function groupDnsByName(cfg: LdapConfig, client: Client, name: string): Promise<string[]> {
  const out: string[] = [];
  const n = name.trim();
  for (const base of groupNameBases(cfg)) {
    const filter = new AndFilter({ filters: [isGroup(), new OrFilter({ filters: [
      new EqualityFilter({ attribute: "cn", value: n }), new EqualityFilter({ attribute: "sAMAccountName", value: n })] })] });
    let r;
    try {
      r = await client.search(base, { scope: "sub", filter, attributes: ["1.1"], sizeLimit: GROUP_NAME_MAX, timeLimit: cfg.timeout_sec, derefAliases: "never" });
    } catch (e) {
      if (e instanceof NoSuchObjectError) continue;
      throw readFailure(e);
    }
    for (const e of r.searchEntries) if (!out.some((x) => normalizeDn(x) === normalizeDn(e.dn))) out.push(e.dn);
  }
  return out;
}

interface ResolvedGroup { dns: string[]; problem: GroupsProblem | null }

async function resolveGroup(cfg: LdapConfig, client: Client, entry: string, role: "allow" | "deny"): Promise<ResolvedGroup> {
  const e = entry.trim();
  const dns = e.includes("=") ? ((await matches(cfg, client, e, isGroup())) ? [e] : []) : await groupDnsByName(cfg, client, e);
  if (!dns.length) return { dns, problem: "group_unresolved" };
  if (role === "deny") return { dns, problem: null };
  if (dns.length > 1) return { dns, problem: "group_ambiguous" };
  const visible = await matches(cfg, client, dns[0]!, new AndFilter({ filters: [isGroup(), new PresenceFilter({ attribute: "member" })] }));
  return { dns, problem: visible ? null : "groups_unreadable" };
}

async function memberOfAny(cfg: LdapConfig, client: Client, user: { dn: string; memberOf: ReadonlySet<string> }, groupDns: readonly string[]): Promise<boolean> {
  if (groupDns.some((g) => user.memberOf.has(normalizeDn(g)))) return true;
  const groupsAttr = cfg.attributes.groups;
  for (const g of groupDns) {
    if (await matches(cfg, client, user.dn, new ExtensibleFilter({ matchType: groupsAttr, rule: RULE_IN_CHAIN, value: g }))) return true;
    if (await matches(cfg, client, g, new ExtensibleFilter({ matchType: "member", rule: RULE_IN_CHAIN, value: user.dn }))) return true;
  }
  return false;
}

/**
 * @internal — exported for tests.
 */
export async function psoFromContainer(cfg: LdapConfig, client: Client, user: { dn: string; memberOf: ReadonlySet<string> }): Promise<AccountState["pso"]> {
  const container = `${PSO_CONTAINER_RDN},${domainRootDn(cfg.base_dn)}`;
  let r;
  try {
    r = await client.search(container, {
      scope: "one", filter: new EqualityFilter({ attribute: "objectClass", value: "msDS-PasswordSettings" }), attributes: [...PSO_ATTRS, "msDS-PSOAppliesTo"],
      sizeLimit: PSO_MAX + 1, timeLimit: cfg.timeout_sec, derefAliases: "never",
    });
  } catch (e) {
    if (e instanceof NoSuchObjectError || e instanceof InsufficientAccessError) return { dn: null, policy: null };
    throw readFailure(e);
  }
  const psos = (r.searchEntries as Array<Record<string, unknown> & { dn: string }>).map((e) => ({
    dn: e.dn, policy: policyOf(e, PSO_ATTRS[0], PSO_ATTRS[1]), appliesTo: listOf(attr(e, "msDS-PSOAppliesTo")),
  }));
  if (!psos.length) return null;
  const all = (ps: typeof psos): AccountState["pso"] => (ps.some((p) => !p.policy) ? { dn: ps[0]!.dn, policy: null }
    : { dn: ps[0]!.dn, policy: strictestPolicy(ps.map((p) => p.policy!)) });
  if (psos.length > PSO_MAX) return all(psos);
  const me = normalizeDn(user.dn);
  const applies: typeof psos = [];
  let checks = 0;
  for (const p of psos) {
    if (p.appliesTo.some((d) => normalizeDn(d) === me)) { applies.push(p); continue; }
    for (const g of p.appliesTo) {
      if (++checks > PSO_CHECKS_MAX) return all(psos);
      if (await memberOfAny(cfg, client, user, [g])) { applies.push(p); break; }
    }
  }
  return applies.length ? all(applies) : null;
}

export async function readAccountState(cfg: AccountLdapConfig, target: LdapTarget, guid: string, o: ReadAccountOptions): Promise<AccountState | null> {
  requireTls(cfg);
  const now = o.now ?? Date.now;
  const groupsAttr = cfg.attributes.groups;
  const entry = await directoryEntryByGuid(cfg, guid, {
    target,
    attributes: [ATTRS.uac, ATTRS.expires, ATTRS.pwdLastSet, ATTRS.adminCount, groupsAttr, ATTRS.pso, ATTRS.badPwd, ATTRS.badTime, ATTRS.lockoutTime],
  });
  if (!entry) return null;
  const a = entry.attrs;
  const uac = intOf(attr(a, ATTRS.uac)) ?? 0;
  const expiresMs = filetimeToMs(attr(a, ATTRS.expires));
  const badPwd = intOf(attr(a, ATTRS.badPwd));
  const psoDn = textOf(attr(a, ATTRS.pso));
  const user = { dn: entry.dn, memberOf: new Set(attrValues(a, groupsAttr).map(normalizeDn)) };
  const pwdRaw = textOf(attr(a, ATTRS.pwdLastSet));

  return withDeadline(deadlineOf(cfg), async () => {
    const svc = await serviceSession(cfg, [target]);
    try {
      const computed = await readBase(cfg, svc.client, entry.dn, [ATTRS.computed]);
      const computedUac = computed ? intOf(attr(computed, ATTRS.computed)) : null;
      const groups: string[] = [];
      let groupsProblem: GroupsProblem | null = null;
      for (const [role, list] of [["allow", o.groups.allow], ["deny", o.groups.deny]] as const) {
        for (const g of list) {
          const r = await resolveGroup(cfg, svc.client, g, role);
          if (r.problem) { groupsProblem ??= r.problem; continue; }
          if (!groups.includes(g) && (await memberOfAny(cfg, svc.client, user, r.dns))) groups.push(g);
        }
      }
      let pso: AccountState["pso"] = null;
      let domain: AdLockoutPolicy | null = null;
      if (o.lockout !== false) {
        if (psoDn) pso = { dn: psoDn, policy: policyOf(await readBase(cfg, svc.client, psoDn, [...PSO_ATTRS]), PSO_ATTRS[0], PSO_ATTRS[1]) };
        else pso = await psoFromContainer(cfg, svc.client, user);
        try {
          domain = policyOf(await readBase(cfg, svc.client, domainRootDn(cfg.base_dn), ["lockoutThreshold", "lockOutObservationWindow"]), "lockoutThreshold", "lockOutObservationWindow");
        } catch (e) {
          if (!(e instanceof LdapFailure && e.code === "ldap_search_failed")) throw e;
        }
      }
      return {
        dn: entry.dn, guid: guid.trim().toLowerCase(),
        disabled: (uac & UF_ACCOUNTDISABLE) !== 0,
        expired: expiresMs !== null && expiresMs <= now(),
        locked: computedUac === null ? null : (computedUac & UF_LOCKOUT) !== 0,
        adminCount: (intOf(attr(a, ATTRS.adminCount)) ?? 0) > 0,
        groups, groupsProblem,
        pwdLastSetMs: pwdRaw === null ? null : filetimeToMs(pwdRaw),
        mustChangePassword: pwdRaw !== null && pwdRaw.trim() === "0",
        counters: badPwd === null ? null : { badPwdCount: badPwd, badPasswordTimeMs: filetimeToMs(attr(a, ATTRS.badTime)) },
        pso, domain,
      };
    } finally {
      await closeClient(svc.client);
    }
  });
}

export type PdcRole = "yes" | "no" | "unknown";

export async function pdcRole(cfg: AccountLdapConfig, target: LdapTarget): Promise<PdcRole> {
  requireTls(cfg);
  return withDeadline((cfg.connect_timeout_sec + cfg.timeout_sec * 3) * 1000, async () => {
    const svc = await serviceSession(cfg, [target]);
    try {
      const root = await readBase(cfg, svc.client, "", ["dsServiceName"]);
      const head = await readBase(cfg, svc.client, domainRootDn(cfg.base_dn), ["fSMORoleOwner"]);
      const self = root ? textOf(attr(root, "dsServiceName")) : null, owner = head ? textOf(attr(head, "fSMORoleOwner")) : null;
      if (!self || !owner) return "unknown";
      return normalizeDn(self) === normalizeDn(owner) ? "yes" : "no";
    } finally {
      await closeClient(svc.client);
    }
  });
}

export type BindOutcome =
  | { outcome: "ok" }
  | { outcome: "bad"; subcode: string | null }
  | { outcome: "unknown"; reason: "drop" | "timeout" | "referral" | "refused" };

export async function bindAs(cfg: AccountLdapConfig, target: LdapTarget, dn: string, password: string): Promise<BindOutcome> {
  if (typeof password !== "string" || password.length === 0) throw new TypeError("bindAs: an empty password is not sent");
  if (!dn) throw new TypeError("bindAs: a DN is required");
  requireTls(cfg);
  const deadline = (cfg.connect_timeout_sec + cfg.timeout_sec + 1) * 1000;
  let client: Client | null = null;
  try {
    return await withDeadline(deadline, async () => {
      client = await openClient(cfg, target);
      try {
        await client.bind(dn, password);
        return { outcome: "ok" } as const;
      } catch (e) {
        if (e instanceof InvalidCredentialsError) return { outcome: "bad", subcode: adBindSubcode(e) } as const;
        if (e instanceof ResultCodeError) return { outcome: "unknown", reason: e.code === 10 ? "referral" : "refused" } as const;
        return { outcome: "unknown", reason: /timeout/i.test(clientText(e)) ? "timeout" : "drop" } as const;
      }
    });
  } catch (e) {
    if (e instanceof LdapFailure && e.code === "ldap_timeout") return { outcome: "unknown", reason: "timeout" };
    return { outcome: "unknown", reason: "drop" };
  } finally {
    const c = client as Client | null;
    if (c) await closeClient(c);
  }
}
