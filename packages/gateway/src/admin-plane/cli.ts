// The administrator's command line on the host: a separate unix socket MEMORY_CLI_LISTEN,
// access to it comes from an OS group — no key or session, the trust boundary is the rights on the socket file. The program is
// tools/admin/memory-admin-cli.mjs. There is no reading of records and no create-administrator here: only anchors
// (verify, reload, draft — with the mode floor and the leave document), revoking all administrator sessions, the emergency
// access window, edge on|off and the modes: issuing and rotating the system key only in basic (a high
// alert system_key_issued; the key goes in the answer to the host's wrapper, which writes it into the state file and
// prints only the fingerprint), the mode and cancelling a request to return to basic.
// The ban on granting rights in the command line gives way to recovery on the
// server — only the roles memory_admin, security_auditor and the protected settings (the core group always,
// access.refuse_outside_clients), only in basic, with the same checks, encryption, log and alerts as the panel
// (recovery.ts): /cli/recover/settings, /cli/recover/grant, /cli/recover/revoke. It creates no sessions; opening the perimeter,
// lifting the switch and resetting a factor are not possible with it. The CLI reports the SSH source (header X-Memory-Ssh-From):
// a trace, not a boundary.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { ANCHOR_SIGNERS_FILE, AnchorsError, anchorsDir, checkAnchors, dirAnchorFiles, effectiveMode, generateApiKey, log, mapAnchorFiles, newId, raiseAlert, reloadAnchors,
         modeOf, securityModeFloor, signerFingerprints, stricterMode, tx, withTimeout, type EdgeFloorResult } from "@memory/shared";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { healthState } from "../health.ts";
import { AnchorsDraftError, anchorsDraft, draftResponse, type AnchorsDraftOptions } from "./anchors-routes.ts";
import { cancelOpenApprovals } from "./approvals.ts";
import { breakglassState, closeBreakglass, openBreakglass, sshFromOf } from "./breakglass.ts";
import { adminDb, AdminPlaneNotConfigured } from "./db.ts";
import { processTopology, type ListenerTopology } from "./listeners.ts";
import { notImplemented } from "./responses.ts";
import { provisionSettings } from "./provision.ts";
import { recoverGrant, recoverRevoke, recoverSettings, recoveryHelp } from "./recovery.ts";
import { revokeAdminSessions } from "./session.ts";

/**
 * Storage isolation for /cli/health: only the status of the storage isolation check, so that
 * `setup` can stop on a violation before anybody uses the install — no detail, no bucket or key names. The CLI socket has
 * host-level trust; the status reveals nothing a host user could not learn. Values: ok — each class's key is refused on
 * the other bucket; fail — a proven violation; warn — no clear answer (the probe failed, timed out or threw);
 * unavailable — the check did not run (a class's storage is not configured). Never missing, never a 500: `setup`
 * passes only on ok.
 */
export type CliStorageIsolation = "ok" | "warn" | "fail" | "unavailable";
export async function cliStorageIsolation(app: Pick<App, "storage">): Promise<CliStorageIsolation> {
  try {
    const s = await withTimeout(app.storage.check(), 12_000, "storage check");
    const state = s?.isolation?.state;
    return state === "ok" ? "ok" : state === "violation" ? "fail" : state === undefined ? "unavailable" : "warn";
  } catch { return "warn"; }
}

/** Listeners of the process for /cli/health: the main one always exists; the others have their own address (separate) or none. */
export function cliListeners(t: Pick<ListenerTopology, "adminSeparate" | "workplaceSeparate" | "cli"> & Partial<Pick<ListenerTopology, "admin" | "workplace">>):
    Record<"main" | "admin" | "workplace" | "cli", "on" | "separate" | "separate_tcp" | "off"> {
  // the listener has a tcp: address (a unix socket plus a TCP port) — separate but with TCP, not just separate
  const sep = (on: boolean, addrs?: ReadonlyArray<{ type: string }>) => (!on ? "off" : addrs?.some((a) => a.type === "tcp") ? "separate_tcp" : "separate");
  return { main: "on", admin: sep(t.adminSeparate, t.admin), workplace: sep(t.workplaceSeparate, t.workplace), cli: t.cli.length ? "separate" : "off" };
}

/**
 * The outcome of the gateway's edge document in the reload answer: status — applied (edge row set
 * now), same (the same document already written), none (no document or root, no boundary function), failed (refusal — code);
 * serial — the edge document number (applied, same). null — the process applies no edge document. The MFA boundary of it
 * is not in the answer: it shows in the anchors_applied row of kind edge, and the release write sign is that row, not the answer.
 */
export function cliEdgeFloor(r: EdgeFloorResult | null): { status: EdgeFloorResult["status"]; serial: number | null; code: string | null } | null {
  if (!r) return null;
  if (r.status === "applied" || r.status === "same") return { status: r.status, serial: r.serial, code: null };
  if (r.status === "failed") return { status: "failed", serial: null, code: r.code };
  return { status: "none", serial: null, code: null };
}

/** Body limit: anchor files are kilobytes, the document at most 1 MB. */
export const CLI_BODY_MAX = 4 * 1_048_576;
const ANCHOR_FILE_NAME = /^(anchor-signers\.pub|trust-anchors(-inner)?\.json(\.sig\.\d{1,3})?)$/;

const sshFrom = (c: Context, body?: { ssh_connection?: unknown }): string | null => sshFromOf(c.req.header("x-memory-ssh-from") ?? body?.ssh_connection);
const cliAudit = (app: App, c: Context, op: string, details: Record<string, unknown>, ip?: string | null) =>
  audit(app, null, { event_type: "admin", ip: ip ?? sshFrom(c), details: { op, via: "cli", ...details } });

export function cliApp(app: App, topology: () => Pick<ListenerTopology, "adminSeparate" | "workplaceSeparate" | "cli"> & Partial<Pick<ListenerTopology, "admin" | "workplace">> = processTopology): Hono {
  const r = new Hono();
  r.onError((e, c) => e instanceof AdminPlaneNotConfigured
    ? c.json({ code: "internal", message: e.message }, 503)
    : (log.error("cli_error", { path: c.req.path, error: ((e as Error)?.message ?? String(e)).slice(0, 300) }), c.json({ code: "internal", message: "Internal gateway error" }, 500)));
  r.use("/cli/*", bodyLimit({ maxSize: CLI_BODY_MAX, onError: (c) => c.json({ code: "too_large", message: "The request body exceeds the size limit" }, 413) }));
  r.get("/cli/health", async (c) => {
    const [h, isolation] = await Promise.all([healthState(app), cliStorageIsolation(app)]);
    return c.json({ status: h.status, version: h.version, instance: h.instance, listeners: cliListeners(topology()), storage_isolation: isolation });
  });

  // anchors: check the files before putting them (applies and writes nothing). The trust root is the installed
  // anchor-signers.pub of the gateway; from the body only with root: "files" (memory-admin-cli anchors verify --root)
  r.post("/cli/anchors/verify", async (c) => {
    const b = await c.req.json<{ files?: unknown; root?: unknown }>().catch(() => ({} as { files?: unknown; root?: unknown }));
    const files = b.files && typeof b.files === "object" && !Array.isArray(b.files) ? b.files as Record<string, unknown> : null;
    if (!files || !Object.keys(files).length || Object.entries(files).some(([n, v]) => !ANCHOR_FILE_NAME.test(n) || typeof v !== "string"))
      return c.json({ code: "invalid_argument", message: "files: map file names to text for trust-anchors-inner.json, trust-anchors.json, their .sig.<n> files and optionally anchor-signers.pub" }, 400);
    if (b.root !== undefined && b.root !== "installed" && b.root !== "files")
      return c.json({ code: "invalid_argument", message: "root: installed (the installed signer file) or files (from the request body)" }, 400);
    const root = b.root === "files" ? "files" : "installed";
    if (root === "files" && typeof files[ANCHOR_SIGNERS_FILE] !== "string")
      return c.json({ code: "invalid_argument", message: `root: files requires ${ANCHOR_SIGNERS_FILE} in the request body` }, 400);
    const mapped = mapAnchorFiles(files as Record<string, string>, dirAnchorFiles(anchorsDir()), { root });
    try {
      const res = await checkAnchors(mapped, { db: app.db.control, instanceId: app.instanceId, settings: app.settings });
      if (!res.inForce)
        return c.json({ code: "anchors_rejected", details: { reason: res.reason === "disabled" ? "anchors_disabled" : "no_signers" },
          message: res.reason === "disabled" ? "The anchors-disabled marker removed the anchors, and the signer file is missing. There is no file to verify against"
                                             : "The installed signer file anchor-signers.pub is missing. There is no file to verify against (use --root for a root from the package)" }, 409);
      const docs = [res.inner, ...(res.edge ? [res.edge] : [])].map((d) => ({ kind: d.kind, serial: d.serial, sha256: d.sha256, signers: d.signers, rejected_signatures: d.rejected.length }));
      const rootSigners = await signerFingerprints(mapped.read(ANCHOR_SIGNERS_FILE)?.toString("utf8") ?? "");
      return c.json({ ok: true, root, root_signers: rootSigners, documents: docs, problems: res.problems });
    } catch (e) {
      // details.reason — the reason of the refusal (its code, or roles_not_split under anchors_state); the text of
      // roles_not_split says what to do, so it is not cut to the usual length
      if (e instanceof AnchorsError) return c.json({ code: "anchors_rejected", message: e.message.slice(0, e.reason === e.code ? 300 : 900), details: { reason: e.reason } }, 409);
      throw e;
    }
  });
  // reload the anchors: the answer is about the internal ones (200 or 409) and the outcome of the gateway's edge document: it
  // is applied even when the internal ones are refused, so it is in both answers (in 409 — in details)
  r.post("/cli/anchors/reload", async (c) => {
    const res = await reloadAnchors("cli", { db: app.db.control, audit: app.db.audit, instanceId: app.instanceId, settings: app.settings });
    const edge = cliEdgeFloor(res.edge);
    if (!res.applied)
      return c.json({ code: "anchors_rejected", message: `${res.error.message.slice(0, res.error.reason === res.error.code ? 280 : 900)}. The existing anchors remain in effect`,
                      details: { reason: res.error.reason, edge } }, 409);
    return c.json({ applied: true, kind: res.kind, serial: res.serial, in_force: res.inForce, edge });
  });
  // a draft of the internal anchors — for signing on the signer's machine (the same as GET /api/v1/admin/anchors/draft). POST —
  // with parameters: signers_pub (the signers file for the first document), accept (take the database value for keys where
  // the database differs from the anchors), set (new values of pinned keys — a secret change with anchors in force; not stored)
  const draft = async (c: Context, o: AnchorsDraftOptions) => {
    try {
      const d = await anchorsDraft(app, o);
      return await draftResponse(c, d, ({ op, ...details }) => cliAudit(app, c, String(op), details));
    } catch (e) {
      if (e instanceof AnchorsDraftError) return c.json(e.body(), e.status);
      throw e;
    }
  };
  r.get("/cli/anchors/draft", (c) => draft(c, {}));
  r.post("/cli/anchors/draft", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => null);
    const strList = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 200 && x.every((k) => typeof k === "string" && k.length <= 128);
    if (!b || typeof b !== "object" || Array.isArray(b)
        || (b.signers_pub !== undefined && (typeof b.signers_pub !== "string" || b.signers_pub.length > 65_536))
        || (b.accept !== undefined && !strList(b.accept))
        || (b.set !== undefined && (!b.set || typeof b.set !== "object" || Array.isArray(b.set) || Object.keys(b.set).length > 50))
        || (b.security_mode_min !== undefined && b.security_mode_min !== "basic" && b.security_mode_min !== "advanced")
        || (b.retire !== undefined && typeof b.retire !== "boolean"))
      return c.json({ code: "invalid_argument", message: "body: {signers_pub?: signer file text, accept?: [keys], set?: {key: value}, security_mode_min?: basic|advanced, retire?: true}" }, 400);
    return draft(c, { signersText: b.signers_pub as string | undefined, accept: b.accept as string[] | undefined, set: b.set as Record<string, unknown> | undefined,
                      ...(b.security_mode_min ? { securityModeMin: b.security_mode_min as "basic" | "advanced" } : {}), ...(b.retire === true ? { retire: true } : {}) });
  });

  // incident: revoke all administrator sessions (and old panel tokens) and cancel open second-signature requests —
  // a signed but unexecuted request would otherwise outlive the revoke
  r.post("/cli/sessions/revoke-all", async (c) => {
    const n = await revokeAdminSessions(app, { all: true }, "incident");
    const cancelled = await cancelOpenApprovals(app);
    await cliAudit(app, c, "admin_session_revoke", { reason: "incident", count: n, approvals_cancelled: cancelled });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "admin_disabled",
      summary: `Revoked all administrator sessions from the VM command line: ${n}. Canceled second-signature requests: ${cancelled}`,
      details: { count: n, approvals_cancelled: cancelled, via: "cli", ssh_from: sshFrom(c) } });
    return c.json({ revoked: n, approvals_cancelled: cancelled });
  });

  // emergency access
  r.post("/cli/breakglass/open", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const from = sshFrom(c, b);
    const res = await openBreakglass(app, { half_a: b.half_a, half_b: b.half_b, reason_code: b.reason_code, ssh_connection: from });
    if (!res.ok) {
      if (res.retry_after) c.header("retry-after", String(res.retry_after));
      return c.json({ code: res.code, message: res.message, ...(res.retry_after ? { retry_after: res.retry_after } : {}) }, res.status);
    }
    return c.json({ window: res.window, expires_at: res.expires_at });
  });
  r.post("/cli/breakglass/close", async (c) => {
    const res = await closeBreakglass(app, "cli", sshFrom(c));
    return c.json({ closed: res.closed, revoked: res.revoked });
  });
  r.get("/cli/breakglass", async (c) => {
    const s = await breakglassState(app);
    return c.json(s.open ? { open: true, window: s.window, reason_code: s.reason_code, expires_at: s.expires_at } : { open: false });
  });

  // modes: the system key only in basic. issue — when none is in force (otherwise 409: rotate), rotate —
  // the old ones are revoked in the same transaction. The mode is from the database (security_mode()), stricter than the anchors
  // floor, not the process cache, checked in the issue transaction under the mode change lock: advanced turned on meanwhile waits
  // for the issue and revokes this key, and an issue after turning it on sees advanced and refuses
  const advancedRefused = (c: Context) => c.json({ code: "system_key_advanced", message: "In advanced mode, a system key cannot be issued. Request a return to basic first" }, 409);
  const systemKey = async (c: Context, rotate: boolean) => {
    const key = generateApiKey("system");
    const id = newId();
    const out = await tx(app.db.control, async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext('security_mode'), hashtext($1))", [app.instanceId]);
      const m = (await q.query("SELECT security_mode($1) AS m", [app.instanceId])).rows[0]?.m;
      if (stricterMode(modeOf(m ?? null), securityModeFloor()) !== "basic") return "advanced" as const;
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`system-key:${app.instanceId}`]);
      const live = Number((await q.query("SELECT count(*)::int AS n FROM api_keys WHERE instance_id = $1 AND principal_type = 'system' AND revoked_at IS NULL", [app.instanceId])).rows[0]?.n ?? 0);
      if (live && !rotate) return null;
      const revoked = rotate ? (await q.query("UPDATE api_keys SET revoked_at = now() WHERE instance_id = $1 AND principal_type = 'system' AND revoked_at IS NULL RETURNING id", [app.instanceId])).rowCount ?? 0 : 0;
      await q.query("INSERT INTO api_keys (id, key_prefix, key_hash, principal_type, principal_id, kind, tier, instance_id, client_label) VALUES ($1, $2, $3, 'system', NULL, 'system', 'T0', $4, 'cli-system-key')",
        [id, key.prefix, key.hash, app.instanceId]);
      return { revoked };
    });
    if (out === "advanced") return advancedRefused(c);
    if (!out) return c.json({ code: "conflict", message: "An active system key already exists. Use memory-admin-cli system-key rotate to replace it" }, 409);
    const fingerprint = `sha256:${createHash("sha256").update(key.plain).digest("hex").slice(0, 16)}`;
    await cliAudit(app, c, "system_key_issue", { key_id: id, fingerprint, rotated: rotate, revoked: out.revoked });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "system_key_issued",
      summary: `${rotate ? "Rotated" : "Issued"} the system key from the VM command line (fingerprint ${fingerprint}). Previous keys revoked: ${out.revoked}`,
      details: { key_id: id, fingerprint, rotated: rotate, revoked: out.revoked } });
    // the key only into the answer to the host wrapper (the socket — OS group rights); in the log and alert — the fingerprint
    return c.json({ key_id: id, system_key: key.plain, fingerprint, revoked: out.revoked });
  };
  r.post("/cli/system-key/issue", (c) => systemKey(c, false));
  r.post("/cli/system-key/rotate", (c) => systemKey(c, true));
  r.get("/cli/security-mode", async (c) => {
    const mode = String((await app.db.control.query("SELECT security_mode($1) AS m", [app.instanceId])).rows[0]?.m ?? "basic");
    const p = (await adminDb(app).query(
      `SELECT id, requested_at, not_before, approved_at IS NOT NULL AS approved FROM security_mode_pending
        WHERE instance_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL ORDER BY requested_at DESC LIMIT 1`, [app.instanceId])).rows[0] as
      { id: string; requested_at: Date; not_before: Date; approved: boolean } | undefined;
    return c.json({ mode, process_mode: effectiveMode(app.settings),
                    pending: p ? { id: p.id, requested_at: new Date(p.requested_at).toISOString(), not_before: new Date(p.not_before).toISOString(), approved: p.approved } : null });
  });
  r.post("/cli/security-mode/cancel-downgrade", async (c) => {
    const n = Number((await adminDb(app).query("SELECT security_mode_cancel_downgrade($1, NULL, NULL, 'cli') AS n", [app.instanceId])).rows[0]?.n ?? 0);
    await cliAudit(app, c, "security_mode_downgrade_cancel", { via: "cli", count: n });
    if (n) await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "medium", code: "security_mode_downgrade_cancelled",
      summary: "The request to return to basic was canceled from the VM command line", details: { via: "cli", ssh_from: sshFrom(c) } });
    return c.json({ cancelled: n });
  });

  // recovery on the server: protected settings and administrator roles without a personal session
  r.get("/cli/recover/keys", (c) => c.json(recoveryHelp()));
  r.post("/cli/recover/settings", async (c) => {
    const b = await c.req.json<{ items?: unknown }>().catch(() => null);
    if (!b || !Array.isArray(b.items)) return c.json({ code: "invalid_argument", message: "body: {items: [{category, key, value}]}" }, 400);
    const res = await recoverSettings(app, b.items as Array<{ category: string; key: string; value?: unknown; confirm_clear?: unknown }>, sshFrom(c));
    if (!res.ok) return c.json({ code: res.refusal.code, message: res.refusal.message, ...(res.refusal.details ? { details: res.refusal.details } : {}) }, res.refusal.status);
    return c.json({ updated: res.keys.length, keys: res.keys, ...(res.ldap_sessions_ended ? { ldap_sessions_ended: res.ldap_sessions_ended } : {}),
                    ...(res.oidc_sessions_ended ? { oidc_sessions_ended: res.oidc_sessions_ended } : {}) });
  });
  r.post("/cli/recover/grant", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const res = await recoverGrant(app, b, sshFrom(c));
    if (!res.ok) return c.json({ code: res.refusal.code, message: res.refusal.message }, res.refusal.status);
    return c.json({ id: res.id }, 201);
  });
  r.post("/cli/recover/revoke", async (c) => {
    const b = await c.req.json<{ grant_id?: unknown }>().catch(() => ({} as { grant_id?: unknown }));
    if (typeof b.grant_id !== "string" || !/^[0-9a-f-]{36}$/i.test(b.grant_id)) return c.json({ code: "invalid_argument", message: "grant_id must be a grant identifier" }, 400);
    const res = await recoverRevoke(app, b.grant_id, sshFrom(c));
    if (!res.ok) return c.json({ code: res.refusal.code, message: res.refusal.message }, res.refusal.status);
    return c.json({ revoked: true });
  });

  // provisioning of keys an administrator never changed: setup and optional profiles — provision.ts
  r.post("/cli/provision", async (c) => {
    const res = await provisionSettings(app, await c.req.json<unknown>().catch(() => null), sshFrom(c));
    if (!res.ok) return c.json({ code: res.refusal.code, message: res.refusal.message, ...(res.refusal.details ? { details: res.refusal.details } : {}) }, res.refusal.status);
    return c.json(res.report);
  });

  // edge on and off
  r.post("/cli/edge", notImplemented);
  r.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404));
  return r;
}
