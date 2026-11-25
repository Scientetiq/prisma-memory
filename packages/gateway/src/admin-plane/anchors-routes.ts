import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { ANCHOR_SIGNERS_FILE, anchoredKeys, anchorsDir, currentAnchors, pinHmac, pinKindFor, ROLES_NOT_SPLIT, rolesSplitRefusal, settingsPolicy, SettingsTypeError,
  signerFingerprints, stricterMode, type Category } from "@memory/shared";
import type { App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { adminDb, adminPlaneConfigured } from "./db.ts";
import { ROLE_FORBIDDEN, STEPUP_REQUIRED } from "./responses.ts";
import { freshUv } from "./session.ts";

export interface AnchorsStatus {
  in_force: boolean;
  documents: Array<{ kind: "edge" | "inner"; serial: number; applied_at: string; signers?: string[] }>;
  policy_sha256_ok?: boolean | null;
  unpinned?: string[];
}

export async function anchorsStatus(app: App): Promise<AnchorsStatus> {
  const a = currentAnchors();
  const r = await app.db.control.query(
    `SELECT DISTINCT ON (kind) kind, serial, applied_at, signers FROM anchors_applied WHERE instance_id = $1 ORDER BY kind, serial DESC`, [app.instanceId])
    .catch(() => ({ rows: [] as Array<{ kind: "edge" | "inner"; serial: string; applied_at: Date; signers: string[] }> }));
  return {
    in_force: a.inForce,
    documents: (r.rows as Array<{ kind: "edge" | "inner"; serial: string | number; applied_at: Date; signers: string[] }>).map((d) => ({
      kind: d.kind, serial: Number(d.serial), applied_at: new Date(d.applied_at).toISOString(), signers: d.signers ?? [] })),
    policy_sha256_ok: a.inForce ? a.settingsPolicySha256 === settingsPolicy().sha256 : null,
    unpinned: (a.problems ?? []).filter((p) => p.startsWith("unpinned:")).map((p) => p.slice("unpinned:".length)),
  };
}

export class AnchorsDraftError extends Error {
  /** reason — a narrower reason under the code, in the body as `reason` (roles_not_split under conflict,: the panel shows its own text). */
  constructor(readonly status: 400 | 409 | 503, readonly code: "invalid_argument" | "conflict" | "internal", message: string, readonly reason?: string) { super(message); }
  /** The error body: code, message and, when there is one, reason. */
  body(): { code: string; message: string; reason?: string } { return { code: this.code, message: this.message, ...(this.reason ? { reason: this.reason } : {}) }; }
}

export const DRAFT_SETTINGS_UNREAD = "Settings could not be read from the database, so the anchors draft was not created. The read failure forced strict mode. Nobody chose it, so its advanced floor must stay out of the document to be signed. Try again in a minute";

export interface AnchorsDraftOptions {
  signersText?: string | null;
  accept?: readonly string[];
  set?: Readonly<Record<string, unknown>>;
  securityModeMin?: "basic" | "advanced";
  retire?: boolean;
}

export interface AnchorsDraft {
  draft: Record<string, unknown>;
  changedInDb: string[];
  accepted: string[];
  proposed: string[];
}

export const DRAFT_CHANGED_HEADER = "x-memory-anchors-changed-in-db";
export const DRAFT_PROPOSED_HEADER = "x-memory-anchors-proposed";

const pinOf = (app: App, path: string, secret: boolean, value: unknown): { value: unknown } | { hmac: string } =>
  pinKindFor(path, secret) === "hmac" ? { hmac: pinHmac(app.appSecret, path, value) } : { value };

export async function anchorsDraft(app: App, o: AnchorsDraftOptions = {}): Promise<AnchorsDraft> {
  const s = app.settings;
  await s.load(true).catch(() => undefined);
  if (s.readFailed()) throw new AnchorsDraftError(503, "internal", DRAFT_SETTINGS_UNREAD);
  const anchored = new Set(anchoredKeys());
  const accept = [...new Set(o.accept ?? [])];
  const set = o.set ?? {};
  const bad = [...accept, ...Object.keys(set)].filter((k) => !anchored.has(k) || !s.meta(k).exists);
  if (bad.length) throw new AnchorsDraftError(400, "invalid_argument", `keys that anchors cannot pin: ${bad.slice(0, 10).join(", ")}`);
  for (const [path, value] of Object.entries(set)) {
    const dot = path.indexOf(".");
    try { s.validate(path.slice(0, dot) as Category, path.slice(dot + 1), value); }
    catch (e) { if (e instanceof SettingsTypeError) throw new AnchorsDraftError(400, "invalid_argument", e.message.slice(0, 300)); throw e; }
  }
  const netValue = Object.hasOwn(set, "admin.networks") ? set["admin.networks"] : s.get<unknown>("admin.networks", []);
  const networks = Array.isArray(netValue) ? netValue.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  if (!networks.length)
    throw new AnchorsDraftError(409, "conflict", "admin.networks is empty. Anchors pin the admin panel networks, and an empty list would block all sign-ins once the anchors take effect — "
      + "set the administrator networks in settings or pass them to the draft (--set admin.networks=[\"10.0.0.0/24\"])");
  const state = currentAnchors();
  const current = state.inForce ? state.settingsPins ?? {} : null;
  const pins: Record<string, { value: unknown } | { hmac: string }> = {};
  const changedInDb: string[] = [];
  if (current) for (const [path, pin] of Object.entries(current)) if (anchored.has(path) && !s.meta(path).exists) pins[path] = pin;
  for (const path of [...anchored].sort()) {
    const meta = s.meta(path);
    if (!meta.exists) continue;
    if (Object.hasOwn(set, path)) { pins[path] = pinOf(app, path, meta.secret, set[path]); continue; }
    if (!current) { pins[path] = pinOf(app, path, meta.secret, s.rawValue(path)); continue; }
    const st = s.pinState(path), prev = current[path];
    const prevFits = !!prev && ("hmac" in prev) === (pinKindFor(path, meta.secret) === "hmac");
    if (st?.ok && !st.dbDiffers && prevFits) { pins[path] = prev!; continue; }
    changedInDb.push(path);
    if (accept.includes(path)) pins[path] = pinOf(app, path, meta.secret, s.rawValue(path));
    else if (prevFits) pins[path] = prev!;
  }
  let signersText = o.signersText;
  if (signersText === undefined || signersText === null) { try { signersText = readFileSync(join(anchorsDir(), ANCHOR_SIGNERS_FILE), "utf8"); } catch { signersText = null; } }
  const signers = signersText ? await signerFingerprints(signersText) : [];
  if (signers.length < 2 || signers.length > 3)
    throw new AnchorsDraftError(409, "conflict", signersText
      ? `the signer file contains ${signers.length} valid keys. You need 2 or 3`
      : `signer file ${ANCHOR_SIGNERS_FILE} is missing. Provide it for the first document (memory-admin-cli anchors draft --signers <file>)`);
  const db = adminPlaneConfigured(app) ? adminDb(app) : app.db.control;
  const admins = (await db.query(
    `SELECT DISTINCT p.id AS person_id, lower(i.external_id) AS guid
       FROM role_grants g JOIN people p ON p.id = g.person_id AND p.instance_id = g.instance_id
       JOIN person_identities i ON i.person_id = p.id AND i.system = 'ad' AND i.active AND i.verified
      WHERE g.instance_id = $1 AND g.role_code IN ('memory_admin', 'security_auditor') AND g.revoked_at IS NULL
        AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()) AND p.active
      ORDER BY 2`, [app.instanceId])).rows as Array<{ person_id: string; guid: string }>;
  const webauthn: Array<{ ldap_id: string; credential_id: string; public_key_sha256: string }> = [];
  if (adminPlaneConfigured(app) && admins.length) {
    const creds = (await adminDb(app).query(
      `SELECT person_id, credential_id, public_key FROM admin_webauthn_credentials
        WHERE instance_id = $1 AND disabled_at IS NULL AND person_id = ANY($2::uuid[]) ORDER BY created_at`,
      [app.instanceId, admins.map((x) => x.person_id)])).rows as Array<{ person_id: string; credential_id: Buffer; public_key: Buffer }>;
    const guidOf = new Map(admins.map((x) => [x.person_id, x.guid]));
    for (const c of creds) webauthn.push({ ldap_id: guidOf.get(c.person_id)!, credential_id: Buffer.from(c.credential_id).toString("base64url"),
                                           public_key_sha256: createHash("sha256").update(c.public_key).digest("hex") });
  }
  const last = (await app.db.control.query("SELECT max(serial) AS s FROM anchors_applied WHERE instance_id = $1 AND kind = 'inner'", [app.instanceId])
    .catch(() => ({ rows: [{ s: null }] }))).rows[0]?.s;
  if (o.retire && o.securityModeMin === "advanced")
    throw new AnchorsDraftError(400, "invalid_argument", "a retirement document cannot set an advanced floor. Use --retire and --floor advanced separately");
  const floorRead = await app.db.control.query("SELECT security_mode_floor($1) AS f", [app.instanceId])
    .then((r) => ({ ok: true as const, f: r.rows[0]?.f as unknown }), () => ({ ok: false as const }));
  if (!floorRead.ok || s.readFailed()) throw new AnchorsDraftError(503, "internal", DRAFT_SETTINGS_UNREAD);
  const implicit = stricterMode(stricterMode(s.securityModeSetting(), floorRead.f === "advanced" ? "advanced" : null),
                                state.securityModeMin === "advanced" ? "advanced" : null);
  const floor = o.retire ? undefined : o.securityModeMin ?? (implicit === "advanced" ? "advanced" : undefined);
  // The floor advanced is closed until the role split is ported — the draft refuses it, explicit or
  // implicit, rather than put it into a document the loaders refuse or drop it silently
  const closed = floor === "advanced" ? rolesSplitRefusal() : null;
  if (closed)
    throw new AnchorsDraftError(409, "conflict", o.securityModeMin === "advanced"
      ? `security_mode_min advanced is refused — ${closed}. Draft the document without the floor (security_mode_min=basic, memory-admin-cli anchors draft --floor basic)`
      : `the draft would carry security_mode_min advanced (the mode or the floor in force is advanced), and it is refused — ${closed}. `
        + "Draft the document without the floor explicitly: security_mode_min=basic (memory-admin-cli anchors draft --floor basic)", ROLES_NOT_SPLIT);
  return {
    draft: {
      format: "memory-anchors-inner/1",
      serial: Number(last ?? 0) + 1,
      issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      admin: { networks, ldap_ids: [...new Set(admins.map((x) => x.guid))], webauthn },
      settings_pins: pins,
      settings_policy_sha256: settingsPolicy().sha256,
      ...(floor ? { security_mode_min: floor } : {}),
      ...(o.retire ? { retire: { target: "basic" } } : {}),
      signers,
    },
    changedInDb, accepted: accept.filter((k) => changedInDb.includes(k)), proposed: Object.keys(set).sort(),
  };
}

export async function draftResponse(c: Context, d: AnchorsDraft, writeAudit: (details: Record<string, unknown>) => Promise<unknown>): Promise<Response> {
  if (d.changedInDb.length) c.header(DRAFT_CHANGED_HEADER, d.changedInDb.join(","));
  if (d.proposed.length) c.header(DRAFT_PROPOSED_HEADER, d.proposed.join(","));
  await writeAudit({ op: "anchors_draft", serial: d.draft.serial, changed_in_db: d.changedInDb.length, accepted: d.accepted, proposed: d.proposed });
  return c.json(d.draft);
}

export function anchorsRoutes(app: App): Hono {
  const r = new Hono<{ Variables: { caller: Caller } }>();
  r.get("/api/v1/admin/anchors", async (c) => c.json(await anchorsStatus(app)));
  r.get("/api/v1/admin/anchors/draft", async (c) => {
    const a = c.get("caller")?.admin;
    if (!a || a.role !== "memory_admin") return c.json(ROLE_FORBIDDEN, 403);
    if (!a.sessionId || !freshUv(app, a.uvAt)) return c.json(STEPUP_REQUIRED, 403);
    const accept = (c.req.query("accept") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const floor = c.req.query("security_mode_min"), retire = c.req.query("retire") === "true";
    if (floor !== undefined && floor !== "basic" && floor !== "advanced") return c.json({ code: "invalid_argument", message: "security_mode_min must be basic or advanced" }, 400);
    try {
      const d = await anchorsDraft(app, { accept, ...(floor ? { securityModeMin: floor } : {}), ...(retire ? { retire: true } : {}) });
      return await draftResponse(c, d, (details) => audit(app, c.get("caller"), { event_type: "admin", details }));
    } catch (e) {
      if (e instanceof AnchorsDraftError) return c.json(e.body(), e.status);
      throw e;
    }
  });
  return r as unknown as Hono;
}
