// "Readiness": the checks before the strict mode in plain text, status ok / warn / fail.
//   1 listeners — the admin listener and the workplace on their own addresses (tcp: — warn);  2 sso — admin sign-in via the identity provider works;
//   3 directory — a directory probe by the current administrator's GUID;     4 admins, admin_keys — the administrators table;
//   5 signers — signers with keys, ≥ 2 different people;                     6 system_keys — the active system keys;
//   7 breakglass — the halves file is readable, bastion addresses are set;   8 alerts — recipients and alert mail;
//   9 audit_ship — shipping the log out;                                    10 anchors — anchors, the policy hash, unpinned ones;
//  11 obo_read — on-behalf-of reads: services, keys, events over 30 days;   12 flags — the flags and their strict values;
//  networks — the panel networks are set (anchors in force — the anchors' networks, as at sign-in): empty is "any network",
//  the strict mode does not turn on so; llm_gate_keys — narrow model-arbiter keys: the strict mode does not revoke them;
//  and also: run_mode — the start mode of the services, external_flags — an external flag while the second signature is off,
//  would_require — "unsigned" actions over 30 days, conditional — the second signature is wired to conditional actions.
// The "Turn on strict mode" button (POST /strict-mode): one settings change sets six strict values and revokes
// all system keys. Precondition — checks 1–9 and conditional without fail, and sso, directory, admin_keys, breakglass and
// conditional at "ok" (the strict values turn on WebAuthn and the second signature and close the local admin account: the same
// lock-out guard as at PUT /settings); one administrator (memory_admin), a fresh key touch. Each changed value is
// its own setting_change event. There is no button back: weakening goes one flag at a time with the second signature.
// sso is "ok" only when sign-in is on (admin.sso_login_enabled) and the last "Check the
// provider" succeeded (oidc_check event); conditional with no wired conditions — fail; anchors removed by a marker and a broken
// pin of the open check — fail. The checks are also computed on the future state (overlay — the batch values over the base).
// Sign-in and keys are decided by the same functions that decide the sign-in itself (adminLoginProblems, usableCredentials),
// the directory by directoryAccountByGuid, alerts by alertMailOff (smtp.admin_email is no recipient: mail goes only to
// admin.alert_recipients), the last mail through the admin-plane pool, the log by auditShipStatus (the tail and freshness).
// A ship state or a tail that could not be read — fail (the strict mode does not turn on blind); a measured
// tail and the reception age — warn, as before.
// Modes: "Readiness" shows the mode in force and the gates of the external perimeter
// (gateReport); in basic the items only advanced needs are marked advanced_only (greyed in the panel: "needed for advanced");
// in advanced — a standing security_admins check (fewer than two administrators with keys). ?target=advanced — two
// lists: "Before the button" (before, 1–18; the enabling route refuses while any one is not "ok") and "Completion" (completion,
// 1–5; after the button), and a dry run (dry_run): flags before and after, system keys to revoke, actions over 30 days,
// the whole profile weakened against the reference, who used a system key, whose sessions get revoked. Changes nothing.
// The button is POST /api/v1/admin/security-mode (security-mode.ts); POST /strict-mode is its synonym for one release.
// "The alert mail went out" means delivered (mail_outbox, status sent), not queued; binding the keys to a
// device — only by a device_binding acknowledgement (the AAGUID from admin.webauthn_aaguids is a hint: the attestation signature
// of the key is not checked); "one visible mode" — authcheck reports the same mode; the decision on tool sessions is
// an event of a person in a personal session through the identity provider (details.admin_auth, admin_person); profile item 4a — also any-rule keys
// (except secrets); "The second signature is on" — only when it acts (advanced), not by the value in the base; the directory
// probe is needed in basic too (it matches the administrator with the directory, guards against an AD lock-out), not greyed.
// Profile keys in the gates and in the dry run carry the value, the reference, and who last changed the key and when
// (gateReport, profileChanges): a person confirms what they see, and an edit made with a system key shows at once.
// LDAPS to the directory is a requirement of advanced only. The ldaps item ("Before the button" and
// the checks): ldap.tls_mode = ldaps, edge.ldap_require_ldaps = true, and a fresh memory-authcheck heartbeat does not dispute it
// (ldap_channel not ldaps or tls_none closed — fail; no ldap_channel field — warn "did not confirm the channel"; no heartbeat —
// the settings suffice; unreadable — fail); in basic it is grey, "needed for advanced". The gates carry yellow notices,
// warnings (gateReport). Items 12, 13 and 16 (settings and the heartbeat alone) are repeated by the enabling under
// an exclusive lock on the settings of its own transaction (settingsBeforeAgain).
// transport — the workplace address and the agents' address are HTTPS (plain HTTP only on loopback); it only informs.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { ADMIN_STRICT_FLAGS, ADVANCED_SET_VALUES, advancedCompletion, securityModeFloor, advancedTargets, alertMailOff, canonicalJson, canonicalObjectGuid, currentAnchors, deviceBoundKey, directoryAccountByGuid, effectiveMode, HEARTBEAT_FRESH_SEC, isNetBound,
         groupStaleHours, isWeakening, LDAP_CHANNEL_WORDS, ldapConfig, log, PIN_FAIL_CLOSED, settingsPolicy, valueDigest, auditArchivedBefore, TOOL_SESSIONS_DECISION_MARK,
         TOOL_SESSIONS_DECISION_SQL, type Settings } from "@memory/shared";
import type pg from "pg";
import type { App, Caller } from "../context.ts";
import { auditArchiveReadiness } from "../audit-archive.ts";
import { groupExpiryState } from "../space-groups.ts";
import { auditShipMode, auditShipStatus } from "./alerts-routes.ts";
import { conditionalApprovalsWired } from "./approvals.ts";
import { halvesPath, parseHalvesFile } from "./breakglass.ts";
import { adminDb, adminPlaneConfigured } from "./db.ts";
import { localAdminFactorCheck, localFactorCoverage } from "./local-totp.ts";
import { ALERT_MAIL_FRESH_DAYS, alertTransportFp, gateReport, lastAlertMailDelivered, lastTransportChange, profileChanges, TRANSPORT_UNREAD, type ProfileChange } from "./external-gate.ts";
import { processTopology, type ListenerTopology } from "./listeners.ts";
import { LLM_GATE_OP, llmGateKeyModeOn } from "./middleware.ts";
import { adminLoginProblems } from "./sso.ts";
import { usableCredentials } from "./webauthn-routes.ts";

export type CheckStatus = "ok" | "warn" | "fail";
export interface ReadinessCheck { id: string; status: CheckStatus; title: string; detail?: string; advanced_only?: boolean }

/** Checks 1–9 and conditional: while any of them fails, the strict mode does not turn on. */
export const STRICT_PRECONDITIONS = ["listeners", "sso", "directory", "admins", "admin_keys", "signers", "system_keys", "breakglass", "alerts", "audit_ship", "conditional", "networks"] as const;
/** Only "ok" here (strict values turn on WebAuthn, the second signature, close the local admin account; the panel — admin networks only). */
export const STRICT_MUST_BE_OK = ["sso", "directory", "admin_keys", "breakglass", "conditional", "networks"] as const;
/** Strict values of the six flags; enabling advanced writes them and the session limits 60/15 (ADVANCED_SET_VALUES). */
export const STRICT_VALUES: ReadonlyArray<{ category: "admin"; key: string; value: unknown }> =
  ADVANCED_SET_VALUES.filter((v) => !v.key.startsWith("session_"));
/** "Readiness" items needed only for advanced: in basic the panel greys them: "needed for advanced". */
export const ADVANCED_ONLY_CHECKS: ReadonlySet<string> = new Set(["admin_keys", "signers", "system_keys", "llm_gate_keys", "breakglass", "audit_ship", "flags",
  "external_flags", "would_require", "conditional", "networks", "ldaps", "bridge_vm", "edge_proxy_dedicated"]);

// ---------------------------------------------------------------- test seams

/** Directory probe by GUID: the real one is directoryAccountByGuid (the same as at admin sign-in); tests put in their own. */
type DirectoryProbe = (app: App, guid: string) => Promise<"ok" | "not_found" | string>;
const realProbe: DirectoryProbe = async (app, guid) => {
  try {
    const cfg = ldapConfig(app.settings);
    const e = await directoryAccountByGuid(cfg, guid);
    return e ? "ok" : "not_found";
  } catch (e) {
    return ((e as { code?: string }).code ?? "ldap_error").slice(0, 60);
  }
};
let probe: DirectoryProbe = realProbe;
export function setDirectoryProbeForTests(p: DirectoryProbe | null): void { probe = p ?? realProbe; }
type TopologyView = Pick<ListenerTopology, "adminSeparate" | "workplaceSeparate"> & Partial<Pick<ListenerTopology, "admin" | "workplace">>;
let topology: () => TopologyView = processTopology;
export function setReadinessTopologyForTests(t: (() => TopologyView) | null): void { topology = t ?? processTopology; }
let halvesText: () => string = () => readFileSync(halvesPath(), "utf8");
export function setReadinessHalvesForTests(f: (() => string) | null): void { halvesText = f ?? (() => readFileSync(halvesPath(), "utf8")); }

// ---------------------------------------------------------------- checks

/** Tail and freshness of the log shipping: older than 10 minutes — a warning. */
const SHIP_STALE_SEC = 600;

const ok = (id: string, title: string, detail?: string): ReadinessCheck => ({ id, status: "ok", title, ...(detail ? { detail } : {}) });
const warn = (id: string, title: string, detail?: string): ReadinessCheck => ({ id, status: "warn", title, ...(detail ? { detail } : {}) });
const fail = (id: string, title: string, detail?: string): ReadinessCheck => ({ id, status: "fail", title, ...(detail ? { detail } : {}) });

// Counts over the audit log. The gateway role memory_gateway may only INSERT into audit_events (the log is
// append-only; /health reports a SELECT grant as audit_append_only: false), so readiness reads the log through
// app.db.auditRead(), the memory_audit_reader pool, like every other audit read in this file. A count that could not be
// read is "unreadable", never 0: the check says "no data" and warns, and the gateway log gets readiness_audit_unreadable.
export const AUDIT_UNREADABLE_EVENT = "readiness_audit_unreadable";
type AuditCount<T> = { ok: true; row: T } | { ok: false; code: string | null };
async function auditCount<T>(app: App, check: string, sql: string, params: unknown[]): Promise<AuditCount<T>> {
  try {
    const row = (await app.db.auditRead().query(sql, params)).rows[0] as T | undefined;
    if (row) return { ok: true, row };
    log.warn(AUDIT_UNREADABLE_EVENT, { check, code: "no_row" });
    return { ok: false, code: "no_row" };
  } catch (e) {
    const raw = (e as { code?: unknown } | null)?.code;
    const code = typeof raw === "string" && raw ? raw.slice(0, 16) : null;
    log.warn(AUDIT_UNREADABLE_EVENT, { check, code, error: ((e as Error | null)?.message ?? "").slice(0, 200) });
    return { ok: false, code };
  }
}
/** Admin actions in the last 30 days marked would_require_approval: the would_require check and the dry run. */
const wouldRequireCount = (app: App, check: string): Promise<AuditCount<{ n: number }>> => auditCount<{ n: number }>(app, check,
  `SELECT count(*)::int AS n FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND at > now() - interval '30 days'
      AND details->>'would_require_approval' = 'true'`, [app.instanceId]);
/** Why a count is missing, for the check detail: the reading role and the database error code, if any. */
const auditUnreadableDetail = (code: string | null): string =>
  `The audit log could not be read as memory_audit_reader${code ? ` (error ${code})` : ""}; see ${AUDIT_UNREADABLE_EVENT} in the gateway log`;
/** Settings read for the checks: the batch values (overlay) over the ones in force. */
interface View { get<T>(path: string, fallback: T): T; isSet(path: string): boolean }
function viewOf(s: Settings, overlay?: ReadonlyMap<string, unknown>): View {
  const has = (k: string) => !!overlay && overlay.has(k);
  return {
    get: <T>(k: string, fallback: T): T => (has(k) ? ((overlay!.get(k) ?? fallback) as T) : s.get<T>(k, fallback)),
    isSet: (k: string) => (has(k) ? (v => v !== null && v !== undefined && v !== "")(overlay!.get(k)) : s.listMasked().some((r) => `${r.category}.${r.key}` === k && r.isSet)),
  };
}
const list = (s: Pick<View, "get">, k: string): string[] => { const v = s.get<unknown>(k, []); return Array.isArray(v) ? v.map(String).filter(Boolean) : []; };

/** The directory GUID in canonical form (like guidOfPerson at sign-in): without curly braces, lowercase. */
const canonicalGuid = (raw: string): string | null => canonicalObjectGuid(raw.trim().replace(/^\{|\}$/g, ""));

/**
 * The memory-authcheck heartbeat for the ldaps item: fresh (not older than HEARTBEAT_FRESH_SEC) — its detail; none fresh or no
 * table (42P01) — null; the query failed (rights, timeout, connection) — "unreadable" ("unreadable" is
 * not "no heartbeat", or else the item would pass on the settings alone, blind).
 */
export type AuthcheckBeat = Record<string, unknown> | null | "unreadable";
export async function authcheckBeat(q: Pick<pg.Pool, "query">, instanceId: string): Promise<AuthcheckBeat> {
  try {
    const r = await q.query(
      "SELECT detail FROM service_heartbeats WHERE instance_id = $1 AND service = 'memory-authcheck' AND at >= now() - make_interval(secs => $2::int)",
      [instanceId, HEARTBEAT_FRESH_SEC]);
    const row = r.rows[0] as { detail: Record<string, unknown> | null } | undefined;
    return row ? row.detail ?? {} : null;
  } catch (e) {
    const code = String((e as { code?: string })?.code ?? "");
    if (code === "42P01") return null;
    log.warn("readiness_authcheck_beat_failed", { code: code.slice(0, 10) });
    return "unreadable";
  }
}

/** The channel from the heartbeat in words; one not from the list — briefly, as is. */
const channelWords = (v: unknown): string => (typeof v === "string" && v in LDAP_CHANNEL_WORDS ? LDAP_CHANNEL_WORDS[v as keyof typeof LDAP_CHANNEL_WORDS] : JSON.stringify(v ?? null).slice(0, 40));

/**
 * The ldaps item: the channel to the directory for sign-in from outside is LDAPS. Settings: ldap.tls_mode = ldaps and
 * edge.ldap_require_ldaps = true, else fail. A fresh memory-authcheck heartbeat (beat) does not dispute them: closed by tls_none
 * or detail.ldap_channel set and not ldaps — fail; no ldap_channel field (older authcheck) — warn "did not confirm the channel"
 * ("Before the button" requires ok — a warn holds the button too); no heartbeat — ok by the settings; unreadable — fail (not
 * checked means not ready, as with log shipping). In basic the item is grey, "needed for advanced".
 */
export function ldapsCheck(get: (path: string) => unknown, beat: AuthcheckBeat): ReadinessCheck {
  const tls = get("ldap.tls_mode"), req = get("edge.ldap_require_ldaps");
  if (tls !== "ldaps" || req !== true)
    return fail("ldaps", "The directory channel for sign-in from outside is not restricted to LDAPS. Advanced mode requires LDAPS",
      `Current settings: ldap.tls_mode = ${channelWords(tls === "none" ? "plain" : tls)}, edge.ldap_require_ldaps = ${req === true ? "yes" : "no"}. Use ldaps and yes. `
      + "Needed from IT: LDAPS on the domain controllers, port 636 from the memory host, and the CA chain");
  if (beat === "unreadable")
    return fail("ldaps", "The sign-in check service heartbeat could not be read. The directory channel was not confirmed", "Retry the check. The gateway log contains the query error (readiness_authcheck_beat_failed)");
  if (!beat) return ok("ldaps", "The directory channel for sign-in from outside is restricted to LDAPS", "Configured as required, but there is no recent heartbeat from the sign-in check service");
  const ch = beat.ldap_channel;
  if (beat.closed_reason === "tls_none")
    return fail("ldaps", "The sign-in check service is blocked because the directory channel is disallowed (tls_none)", ch === undefined || ch === null ? undefined : `Reported channel: ${channelWords(ch)}`);
  if (ch === undefined || ch === null)
    return warn("ldaps", "The sign-in check service did not confirm the channel", "The memory-authcheck heartbeat has no ldap_channel field");
  if (ch !== "ldaps") return fail("ldaps", "The sign-in check service connects to the directory without LDAPS", `Reported channel: ${channelWords(ch)}`);
  return ok("ldaps", "The directory channel for sign-in from outside is restricted to LDAPS", "The sign-in check service confirms LDAPS");
}

interface AdminRow { person_id: string; login: string; roles: string[]; guid: string | null; keys: number; usable_keys: number }

async function adminTable(app: App): Promise<AdminRow[]> {
  const db = adminDb(app);
  const r = await db.query(
    `SELECT p.id AS person_id, p.login, array_agg(DISTINCT g.role_code) AS roles,
            (SELECT i.external_id FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active AND i.verified LIMIT 1) AS guid,
            (SELECT count(*)::int FROM admin_webauthn_credentials w WHERE w.person_id = p.id AND w.instance_id = $1 AND w.disabled_at IS NULL) AS keys
       FROM role_grants g JOIN people p ON p.id = g.person_id AND p.instance_id = g.instance_id
      WHERE g.instance_id = $1 AND g.role_code IN ('memory_admin', 'security_auditor') AND g.revoked_at IS NULL
        AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()) AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'
      GROUP BY p.id, p.login ORDER BY p.login`, [app.instanceId]);
  const rows: AdminRow[] = [];
  // keys the person really signs in and signs with — the same function as at sign-in, usableCredentials (with
  // anchors in force — only those listed for their GUID with the same public-key fingerprint)
  for (const x of r.rows as Array<Omit<AdminRow, "usable_keys">>) {
    const guid = x.guid ? canonicalGuid(String(x.guid)) : null;
    const usable = (await usableCredentials(app, x.person_id, guid)).length;
    rows.push({ ...x, keys: Number(x.keys), usable_keys: usable });
  }
  return rows;
}

/**
 * All "Readiness" checks. caller — for the directory probe by the current administrator's GUID. overlay — the batch values
 * over the settings in force (the lock-out guard computes readiness on the state after the write). assumeAdvanced —
 * compute in the advanced mode (the button's dry run): the second signature acts only there.
 */
export async function readinessChecks(app: App, caller: Caller | null, o: { overlay?: ReadonlyMap<string, unknown>; assumeAdvanced?: boolean } = {}): Promise<ReadinessCheck[]> {
  const s = viewOf(app.settings, o.overlay);
  const out: ReadinessCheck[] = [];
  const anchors = currentAnchors();
  const minKeys = Math.max(1, Number(s.get<number>("admin.webauthn_min_keys", 2)) || 2);

  // 1. listeners
  const t = topology();
  const tcp = [(t.admin ?? []).some((a) => a.type === "tcp") ? "MEMORY_ADMIN_LISTEN" : null, (t.workplace ?? []).some((a) => a.type === "tcp") ? "MEMORY_WORKPLACE_LISTEN" : null]
    .filter(Boolean).join(", ");
  out.push(!t.adminSeparate ? fail("listeners", "The admin API is on the main listener", "Set MEMORY_ADMIN_LISTEN in the gateway unit to enable administrator sessions and second signatures")
    : !t.workplaceSeparate ? warn("listeners", "The admin listener is separate and the workspace runs on the main listener", "MEMORY_WORKPLACE_LISTEN is unset")
      : tcp ? warn("listeners", "The admin listener and workspace are separate but have a TCP address", `${tcp}: use a Unix socket on the VM. TCP is for a test installation`)
        : ok("listeners", "The admin listener and workspace are separate"));

  // 2. sign-in through the identity provider
  // the same as the sign-in itself decides (adminLoginProblems: issuer, client, return URL, group, panel name, key sources),
  // except the switch itself (it is checked as on, to see every gap): "set up but off" is a separate line
  const asEnabled = { get: <T>(k: string, fallback: T): T => (k === "admin.sso_login_enabled" ? (true as T) : s.get<T>(k, fallback)) };
  const ssoMissing = adminLoginProblems(asEnabled);
  if (ssoMissing.length) out.push(fail("sso", "Administrator sign-in through the identity provider is not configured", ssoMissing.slice(0, 8).join("; ")));
  else if (s.get<unknown>("admin.sso_login_enabled", false) !== true) out.push(warn("sso", "Administrator sign-in through the identity provider is configured but off", "admin.sso_login_enabled"));
  else {
    // "Check the provider" (oidc_check in the log): until the last check passes, sign-in is not counted as working. The log is
    // read only by the memory_audit_reader role (the gateway writes, never reads it); unreadable — "not checked" (warn), and
    // the lock-out guard (settings-guard) will not close the local admin account
    let last: { ok: string | null } | undefined;
    try {
      last = (await app.db.auditRead().query(
        `SELECT details->>'ok' AS ok FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND details->>'op' = 'oidc_check' ORDER BY at DESC LIMIT 1`,
        [app.instanceId])).rows[0] as { ok: string | null } | undefined;
    } catch { last = undefined; }
    out.push(!last ? warn("sso", "Administrator sign-in through the identity provider is on, but the provider has not been checked", "Select “Check provider” under “Single sign-on”")
      : last.ok !== "true" ? warn("sso", "The last “Check provider” attempt failed", "Correct the settings and check the provider again")
        : ok("sso", "Administrator sign-in through the identity provider is on and the provider has passed its check"));
  }

  // 3. directory by GUID
  const plane = adminPlaneConfigured(app);
  const personId = caller?.admin?.personId ?? null;
  if (!plane) out.push(fail("directory", "The directory GUID match has not been checked", "The admin plane is not configured (no memory_admin_plane pool)"));
  else if (!personId) out.push(warn("directory", "The directory GUID match has not been checked", "Open “Readiness” in an administrator session to check using your GUID"));
  else {
    const guid = (await adminDb(app).query("SELECT external_id FROM person_identities WHERE person_id = $1 AND system = 'ad' AND active AND verified LIMIT 1", [personId])).rows[0]?.external_id as string | undefined;
    if (!guid) out.push(fail("directory", "Directory GUID matching failed", "Your profile has no verified directory link"));
    else {
      const res = await probe(app, String(guid));
      out.push(res === "ok" ? ok("directory", "Directory GUID matching works") : fail("directory", "Directory GUID matching failed",
        res === "not_found" ? "Your GUID was not found in the directory" : `Directory: ${res}`));
    }
  }

  // 4. administrators table, keys
  let admins: AdminRow[] = [];
  if (plane) {
    try { admins = await adminTable(app); } catch (e) { log.warn("readiness_admins_failed", { error: (e as Error).message.slice(0, 200) }); }
  }
  if (!plane) {
    out.push(fail("admins", "The administrator table has not been checked", "The admin plane is not configured"));
    out.push(fail("admin_keys", "Administrator WebAuthn keys have not been checked", "The admin plane is not configured"));
  } else if (!admins.length) {
    out.push(fail("admins", "Nobody holds the memory administrator or security auditor role"));
    out.push(fail("admin_keys", "No administrators to check for WebAuthn keys"));
  } else {
    const anchorIds = new Set((anchors.admin?.ldap_ids ?? []).map((x) => x.toLowerCase()));
    const problems: string[] = [];
    for (const a of admins) {
      if (!a.guid) problems.push(`${a.login}: directory link is unverified`);
      if (a.roles.length > 1) problems.push(`${a.login}: holds both roles`);
      if (anchors.inForce && a.guid && !anchorIds.has(String(a.guid).toLowerCase())) problems.push(`${a.login}: missing from the anchors`);
    }
    out.push(problems.length ? fail("admins", "Administrator table: issues found", problems.slice(0, 10).join("; "))
      : ok("admins", `Administrators and auditors: ${admins.length}, with verified directory links`));
    const keyProblems = admins.filter((a) => a.usable_keys < minKeys)
      .map((a) => `${a.login}: ${a.keys} keys${a.usable_keys !== a.keys ? `, ${a.usable_keys} usable for sign-in` : ""}`);
    out.push(keyProblems.length ? fail("admin_keys", `Each administrator needs at least ${minKeys} WebAuthn keys`, keyProblems.slice(0, 10).join("; "))
      : ok("admin_keys", `Each administrator has at least ${minKeys} WebAuthn keys`));
  }

  // 5. signers
  const signers = admins.filter((a) => a.usable_keys > 0).length;
  const noKeys = admins.filter((a) => a.usable_keys === 0).map((a) => a.login);
  out.push(signers >= 2 ? (noKeys.length ? warn("signers", `Signers with keys: ${signers}`, `Without a key, signing does not require a touch: ${noKeys.slice(0, 10).join(", ")}`)
    : ok("signers", `Signers with keys: ${signers}`))
    : fail("signers", "A second signature requires two different signers with keys", `Current count: ${signers}`));

  // 6. system keys
  const sys = (await app.db.control.query(
    `SELECT count(*)::int AS n, max(last_used_at) AS last_at,
            (SELECT host(last_used_ip) FROM api_keys k2 WHERE k2.instance_id = $1 AND k2.principal_type = 'system' AND k2.revoked_at IS NULL
              ORDER BY k2.last_used_at DESC NULLS LAST LIMIT 1) AS last_ip
       FROM api_keys WHERE instance_id = $1 AND principal_type = 'system' AND revoked_at IS NULL`, [app.instanceId])).rows[0] as { n: number; last_at: Date | null; last_ip: string | null };
  out.push(sys.n === 0 ? ok("system_keys", "No active system keys")
    : warn("system_keys", `Active system keys: ${sys.n}. Strict mode will revoke them`,
      sys.last_at ? `Last used: ${new Date(sys.last_at).toISOString().slice(0, 16).replace("T", " ")} UTC${sys.last_ip ? `, address ${sys.last_ip}` : ""}` : "Never used"));

  // narrow keys of the model arbiter: the strict mode does not revoke them (the arbiter needs admission after it too), so
  // they are shown here — how many, of which services, bound to a network or not, when and from where used. They act only in
  // advanced; none at all — a warning: after the strict mode the arbiter is left without the model gate
  type GateKey = { name: string; net_cidrs: string[] | null; last_used_at: Date | null; last_ip: string | null };
  const gk = await app.db.control.query(
    `SELECT s.name, k.net_cidrs::text[] AS net_cidrs, k.last_used_at, host(k.last_used_ip) AS last_ip
       FROM api_keys k JOIN services s ON s.id = k.principal_id AND s.instance_id = k.instance_id
      WHERE k.instance_id = $1 AND k.principal_type = 'service' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND s.active AND s.obo_allowed IS NOT TRUE AND s.allowed_ops = ARRAY[$2]::text[]
      ORDER BY k.last_used_at DESC NULLS LAST LIMIT 50`, [app.instanceId, LLM_GATE_OP])
    .then((r) => r.rows as GateKey[])
    .catch((e: unknown) => { log.warn("readiness_llm_gate_keys_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) }); return null; });
  if (!gk) out.push(warn("llm_gate_keys", "The scoped model arbiter keys could not be read"));
  else if (!gk.length) out.push(warn("llm_gate_keys", "No scoped model arbiter key is available. Strict mode will revoke the system keys, leaving the model arbiter without access to the gate",
    "Use a service key with llm_gate as its only operation, with a network restriction or through the admin listener socket only"));
  else {
    const bound = gk.filter((k) => isNetBound(k.net_cidrs)).length, last = gk[0]!;
    const detail = `Services: ${[...new Set(gk.map((k) => k.name))].slice(0, 5).join(", ")}. Network-restricted keys: ${bound} of ${gk.length} (the others can be used only through the socket); `
      + (last.last_used_at ? `last request ${new Date(last.last_used_at).toISOString().slice(0, 16).replace("T", " ")} UTC${last.last_ip ? `, address ${last.last_ip}` : ""}` : "never used");
    out.push(ok("llm_gate_keys", llmGateKeyModeOn(app) ? `Scoped model arbiter keys: ${gk.length}. Strict mode leaves them active`
      : `Scoped model arbiter keys: ${gk.length}. They also work in basic mode. Switch the arbiter to these keys before selecting advanced`, detail));
  }

  // 7. emergency access
  let halves = "ok";
  try { parseHalvesFile(halvesText()); } catch (e) { halves = (e as NodeJS.ErrnoException).code === "ENOENT" ? "key halves file is missing" : "key halves file is unreadable"; }
  const bastion = list(s, "admin.bastion_cidrs");
  out.push(halves === "ok" && bastion.length ? ok("breakglass", "Emergency access is ready. The key halves file is present and the bastion addresses are configured")
    : fail("breakglass", "Emergency access is not ready", [halves === "ok" ? null : halves, bastion.length ? null : "admin.bastion_cidrs is empty"].filter(Boolean).join("; ")));

  // 8. alerts
  // mail goes only to admin.alert_recipients (smtp.admin_email is no fallback address); the last one — delivered
  // (mail_outbox, status sent), not queued. The gates of sign-in and of writes from outside
  // count only a high mail via the current mail transport (the transport_fp fingerprint); mail from before the update (no
  // a fingerprint) and through the former server — a warning with an explanation, not "goes out"
  const mailOff = alertMailOff(s);
  const lastMail = mailOff ? null : await lastAlertMailDelivered(app, { highOnly: false });
  const viaNow = lastMail ? await lastAlertMailDelivered(app, { transportFp: alertTransportFp(app, (p) => s.get<unknown>(p, null)) }) : null;
  const at = (d: Date) => `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  out.push(mailOff ? fail("alerts", "Alert e-mail is not being sent", mailOff)
    : lastMail && viaNow ? ok("alerts", "Alert e-mail is being sent", `Last sent: ${at(lastMail)}`)
      : lastMail ? warn("alerts", "Alert e-mail has been sent, but the current mail transport has yet to send a high alert",
                        `Last sent: ${at(lastMail)}. ${ALERT_MAIL_TRANSPORT_TEXT}`)
        : warn("alerts", "Recipients and mail are configured, but no alert e-mail has been sent"));

  // 9. log shipping
  const shipMode = String(s.get<unknown>("observability.audit_ship_mode", "off"));
  if (shipMode === "off") out.push(fail("audit_ship", "External audit log forwarding is off", "observability.audit_ship_mode = off"));
  else if (shipMode !== auditShipMode(app)) out.push(warn("audit_ship", `External audit log forwarding (${shipMode}): this change switches the mode. Forwarding has not been checked`));
  else {
    // the same state the panel shows (auditShipStatus): tail — the age of the oldest unshipped event,
    // freshness — when the receiver last accepted
    let st: Record<string, unknown> | null = null;
    try { st = await auditShipStatus(app); } catch (e) { log.warn("readiness_audit_ship_failed", { error: (e as Error).message.slice(0, 200) }); }
    const lag = typeof st?.lag_sec === "number" ? st.lag_sec : null;
    const okAt = typeof st?.last_ok_at === "string" ? Date.parse(st.last_ok_at) : NaN;
    const freshMin = Number.isFinite(okAt) ? (Date.now() - okAt) / 60_000 : Infinity;
    // unreadable means unchecked: fail (otherwise the strict mode would turn on with unchecked shipping)
    out.push(!st ? fail("audit_ship", `Could not read external audit log forwarding status (${shipMode})`, "Check the gateway pool’s access to audit_ship_state and the database connection")
      : st.last_error_code ? fail("audit_ship", "Audit log forwarding failed", `Code: ${String(st.last_error_code)}`)
        : lag === null ? fail("audit_ship", `External audit log forwarding (${shipMode}): could not read the backlog`, "The memory_audit_reader role cannot read the audit log")
          : lag > SHIP_STALE_SEC ? warn("audit_ship", `External audit log forwarding (${shipMode}): the oldest unsent event has been waiting ${Math.round(lag / 60)} min`)
            : freshMin >= SHIP_STALE_SEC / 60 ? warn("audit_ship", `External audit log forwarding (${shipMode}): the receiver has accepted nothing for more than 10 minutes`)
              : st.mismatch === true ? warn("audit_ship", `External audit log forwarding is working (${shipMode}), but reconciliation for ${String(st.reconciled_day)} found a mismatch`)
                : ok("audit_ship", `External audit log forwarding is working (${shipMode})`, `Backlog: ${lag} s`));
  }

  // audit archive: off, no storage, a month waiting more than seven days — warn; not a precondition of advanced
  out.push(await auditArchiveReadiness(app, { mode: s.get<unknown>("observability.audit_archive_mode", "off"),
    retention: s.get<unknown>("observability.audit_retention_months", 12), keep: s.get<unknown>("observability.audit_archive_keep_months", 24) }));

  // panel networks: an empty list is "any network"; the strict mode does not turn on so. The source is the same as at sign-in
  // (adminNetworks): with anchors in force — the anchors' networks, else the setting
  const pinned = anchors.inForce;
  const nets = pinned ? (anchors.admin?.networks ?? []).map(String).filter(Boolean) : list(s, "admin.networks");
  out.push(nets.length ? ok("networks", `The admin panel is accessible only from the configured networks${pinned ? " (pinned by anchors)" : ""}: ${nets.length}`, nets.slice(0, 5).join(", "))
    : pinned ? fail("networks", "The anchors lack admin panel networks. Once the anchors take effect, nobody can sign in", "Sign the anchors again with admin.networks")
      : fail("networks", "No admin panel networks are configured. The admin panel is accessible from any network", "admin.networks: administrator networks (CIDR)"));

  // the addresses people and agents use are HTTPS (literal keys: the settings registry records each read)
  out.push(transportCheck({
    "access.workplace_url": s.get<unknown>("access.workplace_url", ""),
    "access.public_base_url": s.get<unknown>("access.public_base_url", ""),
    "access.cloud_agent_base_url": s.get<unknown>("access.cloud_agent_base_url", ""),
  }));

  // every enabled local administrator has a second factor (on the state after the batch: overlay values)
  out.push(localAdminFactorCheck(await localFactorCoverage(app.db.control, app.instanceId).catch(() => null), {
    "admin.local_login": s.get<unknown>("admin.local_login", "open"),
    "admin.system_key_admin": s.get<unknown>("admin.system_key_admin", true),
    "admin.local_totp_required": s.get<unknown>("admin.local_totp_required", false),
  }));

  // 10. anchors
  if (anchors.reason === "disabled") out.push(fail("anchors", "The anchors-disabled marker removed the anchors. Settings now come from the database even though anchors were previously applied",
    "Restore the anchors files or sign them again. Use the marker only during recovery"));
  else if (!anchors.inForce) out.push(warn("anchors", "Anchors are inactive. Settings come from the database (legacy)", anchors.reason === "no_signers" ? "Signer file anchor-signers.pub is missing" : undefined));
  else {
    const policyOk = anchors.settingsPolicySha256 === settingsPolicy().sha256;
    const unpinned = (anchors.problems ?? []).filter((p) => /^(unpinned|pin_mismatch|pin_kind):/.test(p)).map((p) => p.split(":")[1]);
    const closed = Object.keys(PIN_FAIL_CLOSED).filter((k) => app.settings.pinState(k)?.ok === false);
    out.push(!policyOk ? fail("anchors", `Anchors are in effect (serial ${anchors.serial}), but the settings policy file does not match. Settings changes are blocked`)
      : closed.length ? fail("anchors", `Anchors are in effect (serial ${anchors.serial}), but the pinned open check does not match. Open writes are blocked`, closed.join(", "))
      : unpinned.length ? warn("anchors", `Anchors are in effect (serial ${anchors.serial}). Unpinned or nonmatching keys are treated as unset`, unpinned.slice(0, 15).join(", "))
        : ok("anchors", `Anchors are in effect, serial ${anchors.serial}, and the policy matches`));
  }

  // 11. on-behalf-of reads
  const svc = (await app.db.control.query(
    `SELECT count(*)::int AS n,
            (SELECT count(*)::int FROM api_keys k WHERE k.instance_id = $1 AND k.principal_type = 'service' AND k.revoked_at IS NULL
                AND k.principal_id IN (SELECT id FROM services WHERE instance_id = $1 AND obo_read)) AS keys
       FROM services WHERE instance_id = $1 AND obo_read`, [app.instanceId])).rows[0] as { n: number; keys: number };
  const reads = await auditCount<{ n: number; people: number }>(app, "obo_read",
    `SELECT count(*)::int AS n, count(DISTINCT on_behalf_of)::int AS people FROM audit_events
      WHERE instance_id = $1 AND at > now() - interval '30 days' AND on_behalf_of IS NOT NULL AND service_id IS NOT NULL AND event_type IN ('read', 'search', 'list')`,
    [app.instanceId]);
  const oboMode = String(s.get<unknown>("access.obo_read_consent", "legacy"));
  const legacyReaders = oboMode === "legacy" && svc.n > 0;
  if (reads.ok) {
    const oboDetail = `Services: ${svc.n}, service keys: ${svc.keys}. Reads in the last 30 days: ${reads.row.n}, people: ${reads.row.people}. Mode: ${oboMode}`;
    out.push(legacyReaders ? warn("obo_read", "Services read on behalf of people without their consent (legacy mode)", oboDetail)
      : ok("obo_read", "Inventory of reads “on behalf of” people", oboDetail));
  } else {
    // An unread log is not "0 reads" — warn with "no data" (the legacy warning keeps its title)
    const oboDetail = `Services: ${svc.n}, service keys: ${svc.keys}. Mode: ${oboMode}. Reads on behalf of people in the last 30 days: no data. ${auditUnreadableDetail(reads.code)}`;
    out.push(warn("obo_read", legacyReaders ? "Services read on behalf of people without their consent (legacy mode)"
      : "Reads on behalf of people: no data for the last 30 days — the audit log could not be read", oboDetail));
  }

  // 12. flags
  const loose = ADMIN_STRICT_FLAGS.filter((f) => !f.strict(s.get<unknown>(f.path, null))).map((f) => f.path);
  if (s.get<unknown>("access.obo_read_consent", "legacy") === "legacy") loose.push("access.obo_read_consent");
  if (shipMode === "off") loose.push("observability.audit_ship_mode");
  out.push(loose.length ? warn("flags", "Some flags do not use strict settings", loose.join(", ")) : ok("flags", "Flags use strict settings"));

  // start mode of the services: only fresh heartbeats (as at the gates, HEARTBEAT_FRESH_SEC); silent ones go to the details
  // (an old row decided for a service that is gone). The "edge" and "memory-relay" rows written by
  // the reconciler (detail.via = reconciler) do not count: they report no start mode, they serve the roots reconciliation
  const hbAll = (await app.db.control.query(
    `SELECT service, run_mode, at >= now() - make_interval(secs => $2::int) AS fresh FROM service_heartbeats
      WHERE instance_id = $1 AND COALESCE(detail->>'via', '') <> 'reconciler' ORDER BY service`, [app.instanceId, HEARTBEAT_FRESH_SEC])
    .catch(() => ({ rows: [] as Array<{ service: string; run_mode: string; fresh: boolean }> }))).rows as Array<{ service: string; run_mode: string; fresh: boolean }>;
  const hb = hbAll.filter((h) => h.fresh === true);
  const quiet = hbAll.filter((h) => h.fresh !== true).map((h) => h.service);
  const quietNote = quiet.length ? `; no recent heartbeat: ${quiet.join(", ")}` : "";
  const user = hb.filter((h) => h.run_mode === "user").map((h) => h.service);
  out.push(!hb.length ? ok("run_mode", "Service run mode: no external perimeter services", quiet.length ? quietNote.slice(2) : undefined)
    : user.length ? warn("run_mode", "Services run in user mode. External flags cannot be enabled (run_mode_user)", user.join(", ") + quietNote)
      : ok("run_mode", "The service run mode is system or container", hb.map((h) => `${h.service}: ${h.run_mode}`).join(", ") + quietNote));

  // the second signature is off while the external flag is on
  const external = Object.entries(settingsPolicy().keys).filter(([k, p]) => k.startsWith("edge.") && p.default_off === true)
    .filter(([k, p]) => { const v = s.get<unknown>(k, null); return v !== null && JSON.stringify(v) !== JSON.stringify(p.off_value ?? false) && v !== "off" && v !== false && !(Array.isArray(v) && !v.length) && v !== ""; })
    .map(([k]) => k);
  // the second signature acts only in advanced: in basic the value in the base is a placeholder, not a protection
  const on = (o.assumeAdvanced === true || effectiveMode(app.settings) === "advanced") && s.get<string>("admin.second_signature", "off") === "on";
  out.push(!on && external.length ? warn("external_flags", "External access is on while second signatures are off", external.join(", "))
    : ok("external_flags", on ? "Second signatures are on" : "External access is off"));

  // actions "without a signature" over 30 days
  // with the second signature in force the count does not matter (the title says so); otherwise an unread log is "no data"
  if (on) out.push(ok("would_require", "Second signatures are on"));
  else {
    const wr = await wouldRequireCount(app, "would_require");
    out.push(!wr.ok ? warn("would_require", "Actions that would need a second signature in the last 30 days: no data — the audit log could not be read", auditUnreadableDetail(wr.code))
      : wr.row.n > 0 ? warn("would_require", `Actions that would have waited for a second signature in the last 30 days: ${wr.row.n}`)
        : ok("would_require", "No actions required a second signature in the last 30 days"));
  }

  // conditional actions under the second signature
  out.push(conditionalApprovalsWired() ? ok("conditional", "Second signatures are wired up for all conditional actions")
    : fail("conditional", "Second signatures are still unavailable for conditional actions. With second signatures on, those actions and saving settings return “not enabled” (501)",
      "Wait for the release that supports second signatures for conditional actions before enabling second signatures and strict mode"));

  // does membership from directory groups expire without verification
  { const get = (k: string) => s.get<unknown>(k, app.settings.effective(k));
    const st = await groupExpiryState(app, groupStaleHours(ldapConfig({ get: <T>(k: string, d: T): T => (get(k) ?? d) as T })))
      .catch(() => null);
    out.push(directoryGroupsCheck(get, st)); }

  // the channel to the directory for sign-in from outside: LDAPS is an advanced requirement; in basic the item is grey
  out.push(ldapsCheck((k) => s.get<unknown>(k, app.settings.effective(k)), await authcheckBeat(app.db.control, app.instanceId)));
  // the bridge VM and a separate edge proxy are advanced requirements; in basic the items are grey
  const att = await attestations(app);
  out.push(bridgeVmCheck(s.get<unknown>("edge.bridge_url", app.settings.effective("edge.bridge_url")), bridgeAttestedHosts(att.get("bridge_vm")?.keys()), await lastHostFacts(app)),
           edgeProxyCheck((att.get("edge_proxy_dedicated")?.size ?? 0) > 0));

  // modes: in advanced — a standing "fewer than two administrators with keys" check (the dead end of going back); in basic
  // the items only for advanced are greyed
  const advanced = effectiveMode(app.settings) === "advanced";
  if (advanced && plane) {
    const withKeys = admins.filter((a) => a.roles.includes("memory_admin") && a.usable_keys > 0).length;
    out.push(withKeys >= 2 ? ok("security_admins", `Memory administrators with keys: ${withKeys}`)
      : fail("security_admins", `Returning to basic requires two memory administrators with keys. There are only ${withKeys}`,
        "Register keys for a second administrator; without one, the only option is the “retirement document”"));
  }
  return advanced ? out : out.map((x) => (ADVANCED_ONLY_CHECKS.has(x.id) ? { ...x, advanced_only: true } : x));
}

// ---------------------------------------------------------------- "Readiness" for advanced

/** The emergency access drill — no earlier than 90 days ago. */
export const BREAKGLASS_DRILL_DAYS = 90;
const DAY_MS = 86_400_000;
const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
const nullRows = { rows: [] as Array<Record<string, unknown>> };

/** People's acknowledgements: kind → subjects (the last acknowledgement of each subject). */
async function attestations(app: App): Promise<Map<string, Map<string, string | null>>> {
  const r = await app.db.control.query(
    `SELECT DISTINCT ON (kind, subject) kind, subject, encode(value_sha256, 'hex') AS sha FROM security_attestations
      WHERE instance_id = $1 ORDER BY kind, subject, attested_at DESC`, [app.instanceId]).catch(() => nullRows);
  const out = new Map<string, Map<string, string | null>>();
  for (const x of r.rows as Array<{ kind: string; subject: string; sha: string | null }>) {
    if (!out.has(x.kind)) out.set(x.kind, new Map());
    out.get(x.kind)!.set(x.subject, x.sha);
  }
  return out;
}

/**
 * Acknowledgements of the weakened profile that item 4a of "Before the button" counts: the last one per key among
 * those that (1) are made no earlier than the last edit of the setting row — a value that came back after an edit is confirmed
 * again — and (2) are made by a person who had an active WebAuthn key at that moment: the acknowledgement route then requires
 * a fresh touch (fresh "if_keys"), while a basic acknowledgement without keys had no touch. The admin-plane pool: the gateway
 * has no right to read keys; unreadable — empty (the item is red).
 */
async function touchedProfileAttestations(app: App, keys: readonly string[]): Promise<Map<string, string | null>> {
  if (!keys.length) return new Map();
  const r = await adminDbOr(app).query(
    `SELECT DISTINCT ON (a.subject) a.subject, encode(a.value_sha256, 'hex') AS sha FROM security_attestations a
       LEFT JOIN settings s ON s.instance_id = a.instance_id AND s.category || '.' || s.key = a.subject
      WHERE a.instance_id = $1 AND a.kind = 'profile_weakening' AND a.subject = ANY($2::text[])
        AND (s.updated_at IS NULL OR a.attested_at >= s.updated_at)
        AND EXISTS (SELECT 1 FROM admin_webauthn_credentials w WHERE w.person_id = a.attested_by AND w.instance_id = a.instance_id
                      AND w.created_at <= a.attested_at AND (w.disabled_at IS NULL OR w.disabled_at > a.attested_at))
      ORDER BY a.subject, a.attested_at DESC`, [app.instanceId, [...keys]])
    .catch((e: unknown) => { log.warn("readiness_profile_attestations_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); return nullRows; });
  return new Map((r.rows as Array<{ subject: string; sha: string | null }>).map((x) => [x.subject, x.sha]));
}

/**
 * Weaker than the reference (seed defaults) by the weaken rule: every key with always and open_check.* (item 4a). Rule any —
 * any difference from the default (a person confirms what an agent changed too); secrets are not compared — their fingerprint
 * is not written into acknowledgements. digest — the fingerprint of the value: the panel sends it with the acknowledgement.
 */
export function profileWeakerThanSeed(app: App): Array<{ key: string; value: unknown; seed: unknown; digest: string }> {
  const out: Array<{ key: string; value: unknown; seed: unknown; digest: string }> = [];
  for (const [key, p] of Object.entries(settingsPolicy().keys)) {
    if (!(p.always === true || key.startsWith("open_check.")) || !p.weaken) continue;
    const meta = app.settings.meta(key);
    if (!meta.exists || meta.secret) continue;
    const value = app.settings.effective(key), seed = meta.defaultValue;
    if (isWeakening(p.weaken, seed, value)) out.push({ key, value, seed, digest: valueDigest(value) });
  }
  return out;
}

/** The key's AAGUID in canonical form (8-4-4-4-12, lowercase); all zeros — null. */
const aaguidText = (b: Buffer | null): string | null => {
  if (!b || b.length !== 16 || b.every((x) => x === 0)) return null;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Loopback host of a URL: localhost, *.localhost, 127.0.0.0/8, ::1 — plain HTTP there never leaves this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * "Readiness" item `transport`: every set address among access.workplace_url, access.public_base_url and
 * access.cloud_agent_base_url is https, or plain HTTP on loopback — ok; another scheme or host — warn naming the setting.
 * Nothing set — warn: HTTPS cannot be confirmed. Session cookies of the web service follow its own MEMORY_PUBLIC_URL, which
 * the gateway cannot see — the detail says so. Never fail: this item is no precondition of the strict mode.
 */
export function transportCheck(values: Readonly<Record<string, unknown>>): ReadinessCheck {
  const keys = ["access.workplace_url", "access.public_base_url", "access.cloud_agent_base_url"];
  const plain: string[] = [], local: string[] = [], unset: string[] = [];
  for (const key of keys) {
    const raw = typeof values[key] === "string" ? (values[key] as string).trim() : "";
    if (!raw) { unset.push(key); continue; }
    let u: URL | null = null;
    try { u = new URL(raw); } catch { u = null; }
    if (u?.protocol === "https:") continue;
    if (u?.protocol === "http:" && isLoopbackHost(u.hostname)) { local.push(key); continue; }
    plain.push(`${key} = ${raw.slice(0, 200)}`);
  }
  const cookies = "Session cookies are Secure when the web service has MEMORY_PUBLIC_URL=https://… or the proxy sends X-Forwarded-Proto: https";
  if (unset.length === keys.length) return warn("transport", "No public address is set: HTTPS of the workplace and the agents' address cannot be confirmed",
    `Set ${keys.join(", ")} (the agents' address: one of the last two) to https:// addresses. ${cookies}`);
  if (plain.length) return warn("transport", "An address of the workplace or of the agents is not HTTPS", `${plain.join("; ")}. Sign-in, session cookies and agent keys travel in clear text over it. ${cookies}`);
  // ok: the title claims HTTPS only when it is true of all three addresses; otherwise it says what was checked
  const notes = [unset.length ? `Not set: ${unset.join(", ")}.` : "", local.length ? `Plain HTTP on this computer only: ${local.join(", ")}.` : ""].filter(Boolean);
  return ok("transport", notes.length ? "No workplace or agents' address uses plain HTTP outside this computer" : "The workplace and the agents' addresses are HTTPS",
    [...notes, cookies].join(" "));
}

/**
 * "Readiness" item directory_groups. warn — group bindings exist and their membership never expires: the directory
 * is on with the periodic sync off (ldap.group_sync_minutes = 0), or ldap.group_stale_hours = 0; warn too while some
 * groups are not verified within the expiry (their members are removed until the directory answers), and while a group
 * over ldap.group_max_members was left without members (a sync does not refill it). ok — no bindings,
 * or membership expires as configured. st = null — the bindings could not be read (warn, no data).
 */
export function directoryGroupsCheck(get: (path: string) => unknown, st: { bindings: number; stale: number; frozenEmpty?: number } | null): ReadinessCheck {
  const id = "directory_groups";
  const cfg = ldapConfig({ get: <T>(k: string, d: T): T => (get(k) ?? d) as T });
  const hours = groupStaleHours(cfg);
  if (!st) return warn(id, "Directory groups: no data — the group bindings could not be read");
  if (!st.bindings) return ok(id, "No directory groups are bound to spaces");
  if (!hours && cfg.enabled && !(cfg.group_sync_minutes > 0) && (cfg.group_stale_hours ?? 1) > 0)
    return warn(id, "Group membership never expires: periodic sync is off",
      `ldap.group_sync_minutes = 0: ${st.bindings} group binding(s) are verified only by the button and at sign-in, and ldap.group_stale_hours does not apply — a person removed from a group keeps the membership until someone syncs. Set a sync period to let membership expire without verification`);
  if (!hours)
    return warn(id, "Group membership never expires: ldap.group_stale_hours = 0",
      `${st.bindings} group binding(s): a person removed from a group keeps the membership while the directory cannot verify it (directory unreachable or switched off, group deleted)`);
  if (st.stale)
    return warn(id, `Directory groups not verified for more than ${hours} h: ${st.stale}`,
      "Their members lost the membership they have through these groups until the directory answers — see the group sync state in \"Sign-in and LDAP\" (\"Sync groups now\" verifies at once) and the space pages");
  if (st.frozenEmpty)
    return warn(id, `Directory groups over the size limit without members: ${st.frozenEmpty}`,
      "These groups give nobody a membership: the expiry removed their members, or none were known; a sync does not refill a group over ldap.group_max_members — raise the limit and sync the groups, or unbind the group (space card)");
  return ok(id, `Directory group membership expires ${hours} h after the last successful verification`, `group bindings: ${st.bindings}`);
}

/** "Before the button" item 12: one form of the administrator's name (account or upn). */
export function usernameFormCheck(get: (path: string) => unknown): ReadinessCheck {
  const form = String(get("admin.oidc_username_form") ?? "any");
  return form === "account" || form === "upn" ? ok("username_form", `Administrator name format: ${form}`)
    : fail("username_form", "admin.oidc_username_form must use one form (account or upn)", `Current value: ${form}`);
}
/** "Before the button" item 13: the quotas of connections from outside are in force. */
export function quotaCheck(get: (path: string) => unknown): ReadinessCheck {
  const quota = String(get("edge.quota_mode") ?? "observe");
  return quota === "enforce" ? ok("quota", "External connection quotas use enforce") : fail("quota", "edge.quota_mode — enforce", `Current value: ${quota}`);
}

/**
 * Audit archive: the decision on admin.tool_sessions is proven by its setting_change event made through an SSO
 * session; once older months are dropped, a decision made before them has no event in the base. Its fact is kept in
 * maintenance_state (TOOL_SESSIONS_DECISION_MARK: written here when the event is seen, and by the archive job before it drops
 * the month that holds the event). The settings row is no proof: its updated_by is also set by admin@local linked to a person,
 * whose event says admin_auth "local". Accepted when the mark is older than the newest dropped month; its time,
 * otherwise null (also when the archive state or the mark cannot be read: the check then fails as before).
 */
async function toolSessionsArchived(app: App): Promise<Date | null> {
  try {
    const before = await auditArchivedBefore(app.db.auditRead());
    if (!before) return null;
    const v = (await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2",
      [app.instanceId, TOOL_SESSIONS_DECISION_MARK])).rows[0]?.value as { at?: unknown } | undefined;
    const at = typeof v?.at === "string" ? new Date(v.at) : null;
    return at && Number.isFinite(at.getTime()) && at < before ? at : null;
  } catch { return null; }
}

/** The mark of a decision seen in the journal (first one wins); a failed write only logs — the event is still in the base. */
async function keepToolSessionsDecision(app: App, at: Date, person: string | null): Promise<void> {
  await app.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT DO NOTHING`,
    [app.instanceId, TOOL_SESSIONS_DECISION_MARK, JSON.stringify({ at: new Date(at).toISOString(), person })])
    .catch((e: unknown) => log.warn("readiness_mark_failed", { mark: TOOL_SESSIONS_DECISION_MARK, error: ((e as Error)?.message ?? "").slice(0, 160) }));
}

/** The last host_mode_facts event (from the host's mode-check job): when and what the host reported. None — null. */
export interface HostFacts { at: Date; details: Record<string, unknown> }
/** Host facts older than a day — the hint is unchecked. */
export const HOST_FACTS_FRESH_MS = 86_400_000;

/** The last host_mode_facts event from the log; unreadable — null (the hint unchecked; the address and acknowledgement decide). */
export async function lastHostFacts(app: App): Promise<HostFacts | null> {
  const row = (await app.db.auditRead().query(
    `SELECT at, details FROM audit_events WHERE instance_id = $1 AND event_type = 'ops' AND details->>'code' = 'host_mode_facts'
      ORDER BY at DESC, id DESC LIMIT 1`, [app.instanceId]).catch(() => nullRows)).rows[0] as { at: Date; details: Record<string, unknown> | null } | undefined;
  return row ? { at: new Date(row.at), details: row.details ?? {} } : null;
}

/**
 * Host of the bridge address; one that does not parse — null. IPv6 square brackets removed, lowercase, a trailing dot
 * of a name removed ("memory-relay." and "localhost." are the same), IPv4 in IPv6 (::ffff:127.0.0.1, parsed ::ffff:7f00:1)
 * — back to IPv4. Other IPv4 notations (a decimal number, 0x7f.1) the URL parser normalizes by itself.
 */
export function bridgeHost(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let h: string;
  try { h = new URL(url.trim()).hostname; } catch { return null; }
  h = h.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  const m = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);   // URL parsing compresses 0:0:0:0:0:ffff:…
  if (m) {
    if (m[1]) h = m[1];
    else {
      const hi = parseInt(m[2]!, 16), lo = parseInt(m[3]!, 16);
      h = [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
    }
  }
  return h || null;
}

/**
 * Host from a bridge_vm acknowledgement subject (IT names the bridge VM host: an https://… address or a bare name, port allowed):
 * the same parsing as for the bridge address; does not parse — null.
 */
export function bridgeSubjectHost(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.includes("://")) return bridgeHost(t);
  return bridgeHost(`https://${!t.startsWith("[") && t.split(":").length > 2 ? `[${t}]` : t}`);
}

/**
 * The host is the bridge on this same machine (6.4 item 17): memory-relay and the names of its compose
 * container (memory-core-memory-relay-1), bridge, localhost, *.localhost, the loopback 127.0.0.0/8 and ::1,
 * the any address 0.0.0.0 and ::.
 * No fixed compose subnet counts as this machine: the product ships none, and the compose networks of an
 * installation are not known here.
 * The host comes after bridgeHost (lower case, no trailing dot, IPv4 instead of IPv4 inside IPv6).
 */
export function bridgeHostLocal(host: string): boolean {
  if (host === "bridge" || host === "localhost" || host.endsWith(".localhost")) return true;
  if (/(^|[-_.])memory-relay([-_.]\d+)?$/.test(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "0.0.0.0") return true;
  return host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1";
}

/** The hosts of the bridge machine that IT attested (bridge_vm subjects after bridgeSubjectHost; hosts of this machine do not count). */
export function bridgeAttestedHosts(subjects: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const x of subjects ?? []) {
    const h = bridgeSubjectHost(x);
    if (h && !bridgeHostLocal(h)) out.add(h);
  }
  return out;
}

/**
 * Item 17 bridge_vm: the bridge is its own VM in its own segment, the move is finished. An IT acknowledgement (bridge_vm)
 * given for the bridge VM host decides: the host of edge.bridge_url must be among the confirmed ones (then any other name,
 * including a local one in an unforeseen notation, fails, fresh facts or not). Facts refute it: the edge.bridge_url address
 * points to the bridge of this VM (memory-relay, bridge, localhost, loopback, compose networks) — always;
 * fresh host facts (under a day old) — the bridge address is one of this VM's (host_addrs), memory-relay set up and running
 * here (relay_local), the egress rule or the bridge key folder on this VM (relay_egress_rule, relay_credentials).
 * Facts stale or absent — only the address and acknowledgement are checked; the note says "host facts are not fresh". machine-id
 * is not compared: a copy of the VM repeats it.
 */
export function bridgeVmCheck(bridgeUrl: unknown, attested: ReadonlySet<string>, facts: HostFacts | null, now = Date.now()): ReadinessCheck {
  const host = bridgeHost(bridgeUrl);
  if (!host) return fail("bridge_vm", "The bridge address edge.bridge_url is unset or could not be parsed", "Set the bridge VM address (https://…:8445) after following the move procedure in bridge-move.md");
  if (bridgeHostLocal(host))
    return fail("bridge_vm", "The bridge runs on this VM. edge.bridge_url points to memory-relay, bridge or a loopback address",
      `Bridge host: ${host}. In advanced the bridge is its own VM in its own segment: move it following bridge-move.md, then use the new address`);
  if (!attested.size) return fail("bridge_vm", "IT has not confirmed that the bridge VM is in a separate network segment", "Confirm bridge_vm for the bridge VM host after moving it (bridge-move.md)");
  if (!attested.has(host))
    return fail("bridge_vm", "The bridge address does not match the host IT confirmed",
      `Host in edge.bridge_url: ${host}. Confirmed: ${[...attested].slice(0, 3).join(", ")}. Confirm bridge_vm for the bridge VM host, which must match the host in the address (bridge-move.md)`);
  const fresh = !!facts && now - facts.at.getTime() <= HOST_FACTS_FRESH_MS;
  if (!fresh) return ok("bridge_vm", "IT confirmed the bridge VM is in a separate network segment", `Bridge host: ${host}. Host facts are stale, so the result is unverified`);
  const d = facts!.details;
  const addrs = (typeof d.host_addrs === "string" ? d.host_addrs.split(/[\s,]+/) : []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const against = [addrs.includes(host) ? `bridge address ${host} is an address of this VM (host_addrs)` : null,
                   d.relay_local === true ? "memory-relay is configured and running on this VM (relay_local)" : null,
                   d.relay_egress_rule === true ? "the bridge egress rule is on this VM (relay_egress_rule)" : null,
                   d.relay_credentials === true ? "the bridge key directory is on this VM (relay_credentials)" : null].filter(Boolean) as string[];
  if (against.length) return fail("bridge_vm", "The host facts contradict the confirmation. The bridge is still on this VM", against.join("; "));
  return ok("bridge_vm", "IT confirmed the bridge VM is in a separate network segment. The host facts are consistent with the confirmation", `Bridge host: ${host}. Host facts as of ${facts!.at.toISOString()}`);
}

/**
 * Item 18 edge_proxy_dedicated: a separate proxy for the edge only, the switch day of the main name
 * is over — an IT acknowledgement.
 */
export function edgeProxyCheck(attested: boolean): ReadinessCheck {
  return attested ? ok("edge_proxy_dedicated", "IT confirmed the dedicated edge proxy. The main hostname cutover day is complete")
    : fail("edge_proxy_dedicated", "The dedicated edge proxy has not been confirmed. Complete the main hostname cutover day first",
      "Get edge_proxy_dedicated confirmation from IT after switching the main hostname to the dedicated edge proxy");
}

/**
 * "Before the button" items decided by settings and the authcheck heartbeat alone (12 username_form, 13 quota, 16 ldaps) —
 * once more on the settings of the enabling transaction, under the exclusive lock of the mode change: a basic batch
 * saved between "Readiness" and the lock could have moved the directory channel off LDAPS (basic allows that). The unmet ones;
 * empty — all "ok". q — the transaction's connection (the heartbeat is read in it too).
 */
export async function settingsBeforeAgain(get: (path: string) => unknown, q: Pick<pg.Pool, "query">, instanceId: string): Promise<ReadinessCheck[]> {
  return [usernameFormCheck(get), quotaCheck(get), ldapsCheck(get, await authcheckBeat(q, instanceId))].filter((x) => x.status !== "ok");
}

export interface AdvancedReport {
  before: ReadinessCheck[];
  completion: ReadinessCheck[];
  dry_run: Record<string, unknown>;
}

/**
 * "Before the button", "Completion" and the dry run. Changes nothing. before — every item must be "ok", else
 * the button refuses (a warn refuses too: not checked means not ready).
 */
export async function advancedReadiness(app: App, caller: Caller | null): Promise<AdvancedReport> {
  const s = app.settings;
  const before: ReadinessCheck[] = [];
  const att = await attestations(app);
  const plane = adminPlaneConfigured(app);
  const minKeys = Math.max(1, Number(s.get<number>("admin.webauthn_min_keys", 2)) || 2);

  // 1. the "Readiness" checks on the state after the button (strict values over the base, the advanced mode)
  // what the button will really write (advancedTargets: what is already stricter is not weakened)
  const targets = advancedTargets((p) => s.effective(p));
  const overlay = new Map<string, unknown>(targets.map((v) => [`${v.category}.${v.key}`, v.value]));
  const base = await readinessChecks(app, caller, { overlay, assumeAdvanced: true });
  const baseBad = [...failedOf(base, STRICT_PRECONDITIONS), ...base.filter((x) => (STRICT_MUST_BE_OK as readonly string[]).includes(x.id) && x.status === "warn")];
  before.push(baseBad.length ? fail("base", "“Readiness” checks 1–9 failed", baseBad.map((x) => `${x.id}: ${x.title}`).slice(0, 12).join("; "))
    : ok("base", "“Readiness” checks 1–9 passed"));
  // 2. panel networks
  const nets = base.find((x) => x.id === "networks");
  before.push(nets?.status === "ok" ? ok("networks", nets.title, nets.detail) : fail("networks", nets?.title ?? "No admin panel networks are configured", nets?.detail));

  // 3. two administrators with keys bound to a device (without BE); checked — a device_binding acknowledgement (a person
  // looked at the keys). The AAGUID from admin.webauthn_aaguids is only a hint: the attestation signature is not checked,
  // and the key reports its AAGUID itself
  type Cred = { person_id: string; login: string; backup_eligible: boolean | null; aaguid: Buffer | null };
  const creds = plane ? (await adminDb(app).query(
    `SELECT w.person_id, p.login, w.backup_eligible, w.aaguid FROM admin_webauthn_credentials w JOIN people p ON p.id = w.person_id
      WHERE w.instance_id = $1 AND w.disabled_at IS NULL AND p.active
        AND EXISTS (SELECT 1 FROM role_grants g WHERE g.person_id = p.id AND g.instance_id = $1 AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL
                      AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()))`, [app.instanceId]).catch(() => nullRows)).rows as Cred[] : [];
  const allow = new Set((s.get<unknown>("admin.webauthn_aaguids", []) as unknown[]).map((x) => String(x).toLowerCase()));
  const byPerson = new Map<string, { login: string; bound: number; verified: number; listed: number }>();
  for (const c of creds) {
    const e = byPerson.get(c.person_id) ?? { login: c.login, bound: 0, verified: 0, listed: 0 };
    if (deviceBoundKey(c.backup_eligible)) {
      e.bound++;
      const g = aaguidText(c.aaguid);
      if (att.get("device_binding")?.has(c.person_id)) e.verified++;
      if (g && allow.has(g)) e.listed++;
    }
    byPerson.set(c.person_id, e);
  }
  const boundAdmins = [...byPerson.values()].filter((e) => e.bound >= minKeys);
  const unverifiedAdmins = boundAdmins.filter((e) => e.verified < minKeys);
  const unverified = unverifiedAdmins.map((e) => `${e.login}${e.listed >= minKeys ? " (key model is on the list. The attestation signature is not verified)" : ""}`);
  before.push(boundAdmins.length < 2 ? fail("admins_bound", `At least two administrators must each have at least ${minKeys} device-bound keys`,
      `Current count: ${boundAdmins.length}${[...byPerson.values()].some((e) => e.bound < minKeys) ? "; keys with the BE flag (syncable keys) do not count" : ""}`)
    : unverified.length ? warn("admins_bound", "Key binding to devices has not been checked", `Missing device_binding confirmation: ${unverified.slice(0, 6).join(", ")}`)
      : ok("admins_bound", `Administrators with device-bound keys: ${boundAdmins.length}`));
  // 4. signers
  const signers = base.find((x) => x.id === "signers");
  before.push(signers?.status === "ok" ? ok("signers", signers.title) : fail("signers", signers?.title ?? "Fewer than two signers", signers?.detail));
  // 4a. the profile is not weaker than the reference: a person's acknowledgement with a fresh key touch, not older than the last
  // edit of the key (touchedProfileAttestations)
  const weak = profileWeakerThanSeed(app);
  const pw = await touchedProfileAttestations(app, weak.map((w) => w.key));
  const unconfirmed = weak.filter((w) => pw.get(w.key) !== valueDigest(w.value));
  before.push(unconfirmed.length ? fail("profile", `Unconfirmed keys weaker than the baseline: ${unconfirmed.length}`, unconfirmed.map((w) => w.key).slice(0, 15).join(", "))
    : ok("profile", weak.length ? `Confirmed keys weaker than the baseline: ${weak.length}` : "The profile meets or exceeds the baseline"));
  // 5. emergency access and the drill
  const bg = base.find((x) => x.id === "breakglass");
  const drill = (await adminDbOr(app).query(
    "SELECT max(closed_at) AS at FROM breakglass_windows WHERE instance_id = $1 AND reason_code = 'drill' AND closed_at IS NOT NULL", [app.instanceId]).catch(() => nullRows)).rows[0]?.at;
  const drillOk = !!drill && Date.now() - new Date(drill as string).getTime() <= BREAKGLASS_DRILL_DAYS * DAY_MS;
  before.push(bg?.status !== "ok" ? fail("breakglass", bg?.title ?? "Emergency access is not ready", bg?.detail)
    : !drillOk ? fail("breakglass", `No emergency access drill in ${BREAKGLASS_DRILL_DAYS} days`, "Open and close the window with reason drill")
      : ok("breakglass", "Emergency access is ready. The drill is complete", `Last drill: ${iso(drill)}`));
  // 6. alerts: the last high mail delivered no earlier than 7 days ago (mail_outbox, status sent), through
  // the current mail transport — by fingerprint, as at the sign-in gates: mail from before
  // the memory update and through the former mail server do not count — and after the last write of the mail transport key.
  // A transport change that could not be read — refusal (doubt leans to "not ready").
  const mailOff = alertMailOff(s);
  const lastHigh = await lastAlertMailDelivered(app, { transportFp: alertTransportFp(app, (p) => s.get<unknown>(p, null)) });
  const transport = await lastTransportChange(app);
  const mailFresh = !!lastHigh && Date.now() - lastHigh.getTime() <= ALERT_MAIL_FRESH_DAYS * DAY_MS;
  before.push(mailOff ? fail("alerts", "Alert e-mail is not being sent", mailOff)
    : !mailFresh ? fail("alerts", `No high alert has been sent through the current mail transport in ${ALERT_MAIL_FRESH_DAYS} days`, "Messages from before the memory update or through the previous mail server do not count. Send a test alert (“Alerts” → “Send test alerts”) and check your e-mail")
      : transport === TRANSPORT_UNREAD ? fail("alerts", "The time of the last mail server change could not be read", "The alert e-mail cannot verify delivery until the last mail change is known. Try again later")
        : transport && (lastHigh?.getTime() ?? 0) <= transport.getTime()
          ? fail("alerts", "No high alert has been sent since the mail server changed", `Mail changed: ${iso(transport)}. Last high alert: ${iso(lastHigh)}. Send a test alert and wait for the e-mail`)
          : ok("alerts", "Alert e-mail is being sent", `Last high alert: ${iso(lastHigh)}`));
  // 7. the log outward: syslog_tls, a reconciliation fresher than a day
  const ship = String(s.get<unknown>("observability.audit_ship_mode", "off"));
  const st = ship === "syslog_tls" ? await auditShipStatus(app).catch(() => null) : null;
  const recDay = typeof st?.reconciled_day === "string" ? Date.parse(`${st.reconciled_day}T00:00:00Z`) : NaN;
  before.push(ship !== "syslog_tls" ? fail("audit_ship", "External audit log forwarding must use only syslog_tls", `Current value: ${ship}`)
    : !st || st.last_error_code || st.mismatch === true || !Number.isFinite(recDay) || Date.now() - recDay > 2 * DAY_MS
      ? fail("audit_ship", "Audit log reconciliation with the receiver was at least a day ago or ended with an error")
      : ok("audit_ship", "The audit log is forwarded through syslog_tls and reconciliation is recent", `Reconciled: ${String(st.reconciled_day)}`));
  // 8. heartbeats: all services in a container, one visible mode — authcheck reports the same mode as the base (no
  // field — not checked, so not ready); other services, if they report, — the same too. Only fresh
  // heartbeats count (HEARTBEAT_FRESH_SEC, as at the gates); a silent service gets a separate refusal line: not checked means not
  // ready (an old row decided for a service that no longer learns the mode). The reconciler rows "edge" and
  // "memory-relay" (detail.via = reconciler) are not service heartbeats: their start mode is not measured, they do not count
  const hbAll = (await app.db.control.query(
    `SELECT service, run_mode, detail->>'security_mode' AS mode, at >= now() - make_interval(secs => $2::int) AS fresh FROM service_heartbeats
      WHERE instance_id = $1 AND COALESCE(detail->>'via', '') <> 'reconciler' ORDER BY service`,
    [app.instanceId, HEARTBEAT_FRESH_SEC]).catch(() => nullRows)).rows as Array<{ service: string; run_mode: string; mode: string | null; fresh: boolean }>;
  const hb = hbAll.filter((h) => h.fresh === true);
  const stale = hbAll.filter((h) => h.fresh !== true).map((h) => h.service);
  const notContainer = hb.filter((h) => h.run_mode !== "container").map((h) => `${h.service}: ${h.run_mode}`);
  const modeNow = effectiveMode(app.settings);
  const authHb = hb.find((h) => h.service === "memory-authcheck");
  const otherMode = hb.filter((h) => h.mode !== null && h.mode !== modeNow).map((h) => `${h.service}: ${h.mode}`);
  const modeBad = !authHb ? "authcheck is not reporting a heartbeat" : authHb.mode === null ? "authcheck is not reporting its mode (detail.security_mode)" : otherMode.length ? `the service mode differs from the database mode (${modeNow}): ${otherMode.join(", ")}` : null;
  before.push(!hb.length ? fail("run_mode", "No services have a recent heartbeat. The run mode has not been checked", stale.length ? `No longer reporting: ${stale.join(", ")}` : undefined)
    : stale.length ? fail("run_mode", "No recent service heartbeats. Security and run modes have not been checked", stale.join(", "))
    : notContainer.length ? fail("run_mode", "Some services are not running in containers", notContainer.join(", "))
      : modeBad ? fail("run_mode", "The services report different modes", modeBad) : ok("run_mode", `All ${hb.length} services are running in containers with the same mode: ${modeNow}`));
  // 9. a narrow arbiter key exists and worked within a day: a model-gate event from its service in the log (written only after
  // admission by the intermediary), not api_keys.last_used_at — a refused call sets that too
  const gateSvc = ((await app.db.control.query(
    `SELECT DISTINCT sv.id::text AS id FROM api_keys k JOIN services sv ON sv.id = k.principal_id AND sv.instance_id = k.instance_id
      WHERE k.instance_id = $1 AND k.principal_type = 'service' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND sv.active AND sv.obo_allowed IS NOT TRUE AND sv.allowed_ops = ARRAY[$2]::text[]`,
    [app.instanceId, LLM_GATE_OP]).catch(() => nullRows)).rows as Array<{ id: string }>).map((r) => r.id);
  const gk = gateSvc.length ? (await app.db.auditRead().query(
    `SELECT max(at) AS at FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND service_id = ANY($2::uuid[]) AND client_label LIKE 'llm-gate:%'
        AND at > now() - interval '1 day'`, [app.instanceId, gateSvc]).catch(() => nullRows)).rows[0]?.at : null;
  before.push(gk ? ok("llm_gate_key", "The scoped arbiter key was used in the last day", `Last model gate action: ${iso(gk)}`)
    : fail("llm_gate_key", gateSvc.length ? "The scoped arbiter key was not used in the last day" : "No scoped arbiter key is available",
      "Switch the model arbiter to a scoped key before pressing the button. The key also works in basic mode"));
  // 10. a release through activation and a day of silence of the system key
  const sysUsed = (await app.db.control.query(
    "SELECT max(last_used_at) AS at FROM api_keys WHERE instance_id = $1 AND principal_type = 'system'", [app.instanceId]).catch(() => nullRows)).rows[0]?.at;
  const sysQuiet = !sysUsed || Date.now() - new Date(sysUsed as string).getTime() > DAY_MS;
  const upload = (process.env.MEMORY_RELEASE_UPLOAD ?? "").trim() !== "" && process.env.MEMORY_RELEASE_UPLOAD !== "0";
  before.push(!upload ? fail("release", "Release by activation is off (MEMORY_RELEASE_UPLOAD)")
    : !sysQuiet ? fail("release", "The system key was used in the last day", `Last used: ${iso(sysUsed)}`)
      : ok("release", "Release by activation is on. The system key was not used in the last day"));
  // 11. the tool-session decision was written by a person in a personal session through the identity provider (adminMarks: admin_auth, admin_person),
  // not by a system key, a tool session or the local admin account (client_label is set by the client itself)
  const toolRow = (await app.db.auditRead().query(
    `SELECT at, details->>'admin_person' AS person FROM audit_events WHERE instance_id = $1 AND ${TOOL_SESSIONS_DECISION_SQL} ORDER BY at LIMIT 1`,
    [app.instanceId]).catch(() => nullRows)).rows[0] as { at: Date; person: string | null } | undefined;
  const tool = toolRow !== undefined;
  if (toolRow) await keepToolSessionsDecision(app, toolRow.at, toolRow.person);
  const toolArchived = tool ? null : await toolSessionsArchived(app);
  before.push(tool ? ok("tool_sessions", "The decision about tool sessions has been recorded")
    : toolArchived ? ok("tool_sessions", "The decision about tool sessions has been recorded", `Recorded through an SSO session on ${iso(toolArchived)}; the month of its event has moved to the audit archive`)
      : fail("tool_sessions", "The decision about tool sessions has not been recorded", "A person must change admin.tool_sessions in the admin panel"));
  // 12. one name form; 13. quotas in force
  before.push(usernameFormCheck((k) => s.effective(k)), quotaCheck((k) => s.effective(k)));
  // 14. the DOCKER-USER filter — an IT acknowledgement; host facts are a hint
  before.push(att.get("docker_user_filter")?.size ? ok("docker_user", "IT confirmed the DOCKER-USER filter") : fail("docker_user", "The DOCKER-USER filter has not been confirmed", "Confirm docker_user_filter"));
  // 15. people's acknowledgements: IT, the code host, the fingerprints of three human signers
  const missing = [att.get("it_instructions")?.size ? null : "IT: steps 12, 13, 14, 16, 19 (it_instructions)",
                   att.get("gitlab_protected")?.size ? null : "GitLab: protected branch with approval from someone other than the author (gitlab_protected)",
                   (att.get("human_signer")?.size ?? 0) >= 3 ? null : "fingerprints of three human signers (human_signer)"].filter(Boolean) as string[];
  before.push(missing.length ? fail("attestations", "Some confirmations from people are missing", missing.join("; ")) : ok("attestations", "Confirmations from people are present"));
  // 16. the channel to the directory is LDAPS: settings and a fresh memory-authcheck heartbeat
  before.push(ldapsCheck((k) => s.effective(k), await authcheckBeat(app.db.control, app.instanceId)));
  // 17. the bridge VM in its own segment, the move finished: an IT acknowledgement, the bridge address and fresh host facts
  before.push(bridgeVmCheck(s.effective("edge.bridge_url"), bridgeAttestedHosts(att.get("bridge_vm")?.keys()), await lastHostFacts(app)));
  // 18. a separate edge proxy, the switch day of the main name is over: an IT acknowledgement
  before.push(edgeProxyCheck((att.get("edge_proxy_dedicated")?.size ?? 0) > 0));

  // "Completion" (after the button) — a rule shared with the worker's supervision (advancedCompletion)
  // the mode floor is the last row by number of the internal anchors in the base (security_mode_floor()): so SQL and
  // the worker's supervision see it; the floor from the process loader is the same document if it is newer than the base row
  const roots = (await app.db.control.query("SELECT service, detail->>'anchors_root_sha256' AS root FROM service_heartbeats WHERE instance_id = $1", [app.instanceId])
    .catch(() => nullRows)).rows as Array<{ service: string; root: string | null }>;
  const dbFloor = await app.db.control.query("SELECT security_mode_floor($1) AS f", [app.instanceId]).then((r) => r.rows[0]?.f === "advanced", () => false);
  const completion: ReadinessCheck[] = advancedCompletion({
    floorAdvanced: dbFloor || securityModeFloor() === "advanced", roots,
    humanSigners: new Set(att.get("human_signer")?.keys() ?? []),
    attested: new Set([...att.keys()].filter((k) => (att.get(k)?.size ?? 0) > 0)),
  }).map((x) => (x.ok ? ok(x.id, x.title, x.detail) : fail(x.id, x.title, x.detail)));

  // dry run
  const flags = targets.map((v) => { const k = `${v.category}.${v.key}`; return { key: k, before: s.effective(k), after: v.value }; })
    .filter((f) => canonicalJson(f.before ?? null) !== canonicalJson(f.after ?? null));
  const keys = (await app.db.control.query(
    `SELECT id, key_prefix, last_used_at, host(last_used_ip) AS last_ip FROM api_keys WHERE instance_id = $1 AND principal_type = 'system' AND revoked_at IS NULL
      ORDER BY last_used_at DESC NULLS LAST LIMIT 50`, [app.instanceId]).catch(() => nullRows)).rows.map((k) => ({ id: k.id, prefix: k.key_prefix, last_used_at: iso(k.last_used_at), last_ip: k.last_ip ?? null }));
  // null — the audit log could not be read: the panel shows "no data", not 0
  const wouldRead = await wouldRequireCount(app, "dry_run.would_require_30d");
  const would: number | null = wouldRead.ok ? Number(wouldRead.row.n) : null;
  const scripts = (await app.db.auditRead().query(
    `SELECT host(ip) AS ip, client_label, count(*)::int AS n, max(at) AS last_at FROM audit_events
      WHERE instance_id = $1 AND principal_type = 'system' AND key_id IS NOT NULL AND at > now() - interval '30 days'
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`, [app.instanceId]).catch(() => nullRows)).rows.map((r) => ({ ip: r.ip ?? null, client: r.client_label ?? null, calls: r.n, last_at: iso(r.last_at) }));
  const me = caller?.admin?.sessionId ?? null;
  const sessions = plane ? (await adminDb(app).query(
    `SELECT COALESCE(p.login, s.local_login, '?') AS login, s.auth_method, count(*)::int AS n FROM admin_sessions s LEFT JOIN people p ON p.id = s.person_id
      WHERE s.instance_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND ($2::uuid IS NULL OR s.id <> $2::uuid) GROUP BY 1, 2 ORDER BY 1`,
    [app.instanceId, me]).catch(() => nullRows)).rows.map((r) => ({ login: r.login, auth_method: r.auth_method, sessions: r.n })) : [];
  // the weakened profile — with who last changed the key and when: people confirm what they saw
  const changes = await profileChanges(app, weak.map((w) => w.key)).catch(() => new Map<string, ProfileChange>());
  const profile = weak.map((w) => ({ ...w, ...(changes.get(w.key) ?? { changed_at: null, changed_by: null, changed_by_human: null }) }));
  return { before, completion, dry_run: { flags, system_keys: keys, would_require_30d: would, profile, scripts, sessions } };
}

/** Pool for reading admin-plane tables: its own if set up, else the gateway's. */
const adminDbOr = (app: App) => (adminPlaneConfigured(app) ? adminDb(app) : app.db.control);

/** Checks with the given ids: is there a fail among them. */
/**
 * Why an alert mail does not count: the gates of sign-in and of writes from outside count only a high mail sent through
 * the current mail transport — mail from before the update (no transport fingerprint) and via the former server does not count.
 */
export const ALERT_MAIL_TRANSPORT_TEXT = "The sign-in and write gates for external access count only high alerts sent via the current mail server, port, encryption, account and sender. Messages from before the memory update or sent through the previous mail transport do not count. Send a high test alert";

export function failedOf(checks: readonly ReadinessCheck[], ids: readonly string[]): ReadinessCheck[] {
  return checks.filter((x) => ids.includes(x.id) && x.status === "fail");
}

export const READINESS_FAILED = (failed: readonly ReadinessCheck[]) => ({
  code: "readiness_failed", message: "Cannot switch on: the «Readiness» checks did not pass",
  details: { failed: failed.map((f) => ({ id: f.id, title: f.title, ...(f.detail ? { detail: f.detail } : {}) })) },
});

export function readinessRoutes(app: App): Hono {
  const r = new Hono<{ Variables: { caller: Caller } }>();
  r.get("/api/v1/admin/readiness", async (c) => {
    const caller = c.get("caller") ?? null;
    const checks = await readinessChecks(app, caller);
    const mode = effectiveMode(app.settings);
    // a profile key carries its value and reference (a secret — only set) and who last changed it
    const gate = (await gateReport(app).catch((e: unknown) => { log.warn("readiness_gate_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); return []; }))
      .map((g) => ({ flag: g.flag, open: g.open, failed: g.failed.map((f) => ({ reason: f.reason, title: f.title })), warnings: g.warnings, profile: g.profile }));
    if (c.req.query("target") !== "advanced") return c.json({ checks, mode, gate });
    const adv = await advancedReadiness(app, caller);
    return c.json({ checks, mode, gate, target: "advanced", ...adv });
  });
  return r as unknown as Hono;
}
