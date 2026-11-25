// Admin API of connectors (contract `connectors` 1.0.0, routes marked
// x-admin-listener). Routes under /api/v1/admin/connectors*: the kinds of this build, the list, create, read, change,
// delete, write-only secrets, rotation of the webhook secret with a 24-hour overlap, test and run requests (rows of
// connector_runs the worker scheduler takes), pause, resume and the reconfirmation of the meeting consent; runs and item
// states, never content. Classes and roles are rows of contracts/admin/admin-routes.json (GET → read, pause and delete →
// narrow, the rest → ordinary): the admin plane checks them before a handler runs.
//
// States: a new connector is a `draft` until a passed test and a resume; pausing a draft leaves it a draft. Resume checks
// the facts and not only the status (a passed test for a draft, the current consent text for a meeting connector). PATCH
// and resume read, check and write the row under its lock, so two changes at the same moment are never lost.
//
// Who the records are written as: a connector that writes meetings (its kind produces them), writes into
// a personal space (no target space) or is a personal source (scope person) runs as the administrator who creates it — the
// administrator's own person card; `created_by` is the login of that card (delivery compares it, caller.ts). An
// administrator without an active person card cannot create such a connector. A connector that writes documents and notes
// into a team or project space may run as any active person who can write there; the choice is in the audit event
// (`run_as`). An entity-only connector has no run-as person. The meeting consent is acknowledged by the run-as person
// themselves (create with `consent_version`, or reconfirm).
//
// Secrets are write-only: answers carry fingerprints; the webhook secret is shown once, when it is created or rotated.
// Audit events carry ids, field names, the run-as person and fingerprints — never a value (auditConnectorAdmin).
// Deleting a connector removes its rows (secrets, events, items and runs cascade); staged bodies in the closed bucket are
// removed by the workers' cleanup (the gateway storage has no delete).
//
// Imports from the gateway follow the rule of this folder (an import test checks it): no module that reads records.
import { randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  applyConfigDefaults, auditConnectorAdmin, builtinConnectors, ConnectorSecretError, entitySystemRefusal, loadConnectorSecrets, rotateConnectorSecret,
  secretFingerprint, setConnectorSecret, validateConfig, WEBHOOK_SIGNING_SECRET, type Connector, type Queryable, type ConnectorAdminOp, type ConnectorManifest, type ConnectorRegistry, type Pack,
} from "@memory/connectors";
import { settingsKeyring, type SettingsKeyring } from "@memory/shared/crypto";
import { MemoryError, tx } from "@memory/shared";
import { personCols } from "../auth.ts";
import type { App, Caller, PersonRow } from "../context.ts";
import { consentText } from "../meetings.ts";
import { operatorOf } from "../operator.ts";
import { connectorCaller } from "./caller.ts";
import { requeueHeld } from "./deliver.ts";
import { deliveryTarget } from "./gates.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

/** Name of the framework secret that signs webhooks (Standard Webhooks); manifests may not declare it. */
export const WEBHOOK_SECRET_NAME = WEBHOOK_SIGNING_SECRET;
/** How long the previous webhook secret still verifies after a rotation. */
export const WEBHOOK_ROTATE_OVERLAP_SEC = 86_400;
/** Page size of the lists: default and maximum (contract parameter Limit). */
export const ADMIN_PAGE_DEFAULT = 50;
export const ADMIN_PAGE_MAX = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z][a-z0-9_]{1,31}$/;
const SECRET_PATH_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const REASON = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)?$/;
/** Characters a one-line field of the contract refuses. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** A visible character: a name made only of spaces and format characters (U+200B, U+2060, U+FEFF…) is no name. */
const VISIBLE = /[^\s\p{Cf}]/u;
/** What jsonb refuses in a string: U+0000 and a lone surrogate half. */
const JSONB_BAD = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const ITEM_STATUSES = ["staged", "delivering", "delivered", "unchanged", "held", "skipped", "failed", "deleted_at_source"];
const POLICY_ENUMS: Readonly<Record<string, readonly string[]>> = { participants: ["owner_only", "attended_emails"], on_change: ["version", "new_record"], on_delete: ["keep", "trash"] };
const POLICY_INTS = ["schedule_sec", "daily_items", "daily_mb"];
const CONNECTOR_COLS = `id, instance_id, kind, pack, name, scope, owner_id, target_space_id, data_class, status, config, policy, consent_version, consent_at, consent_by,
  next_run_at, last_run_at, last_ok_at, last_error, failures, created_by, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS page_key`;

interface Row {
  id: string; instance_id: string; kind: string; pack: string | null; name: string; scope: "instance" | "person"; owner_id: string | null;
  target_space_id: string | null; data_class: "closed" | "space"; status: string; config: Record<string, unknown>; policy: Record<string, unknown>;
  consent_version: string | null; consent_at: Date | null; consent_by: string | null; next_run_at: Date | null; last_run_at: Date | null;
  last_ok_at: Date | null; last_error: string | null; failures: number; created_by: string; created_at: Date; updated_at: Date; page_key: string;
}

export interface ConnectorsAdminOptions {
  /** The registry for the packs listed in integrations.connectors_packs (tests pass their own kinds). */
  registry?: (packs: readonly string[]) => ConnectorRegistry;
  /** The settings keyring (default: the keyring of the process, from its key files and the application secret). */
  keyring?: SettingsKeyring;
}

// ---------------------------------------------------------------- errors (the Error shape of the contract)

const bad = (reason: string, message: string, problems?: Array<{ pointer: string; keyword: string }>): MemoryError =>
  new MemoryError("invalid_argument", message, { reason, ...(problems?.length ? { details: { problems: problems.slice(0, 5) } } : {}) });
const conflict = (reason: string, message: string): MemoryError => new MemoryError("conflict", message, { reason });
const notFound = (): MemoryError => new MemoryError("not_found", "Not found.");
const forbidden = (reason: string, message: string): MemoryError => new MemoryError("forbidden", message, { reason });

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => undefined);
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw bad("connector_request", "The request body must be a JSON object.");
  return b as Record<string, unknown>;
}

/** Fields of a body outside the allowed set → 400 with their pointers. */
function onlyFields(b: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  const cut = (k: string): string => (k.length > 40 ? `${k.slice(0, 40)}…` : k).replace(new RegExp(CONTROL.source, "g"), "?");
  if (extra.length) throw bad("connector_request", `Unknown field: ${extra.slice(0, 5).map(cut).join(", ")}.`,
                              extra.map((k) => ({ pointer: `/${cut(k)}`.slice(0, 512), keyword: "additionalProperties" })));
}

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
function uuidField(b: Record<string, unknown>, k: string): string | undefined {
  if (b[k] === undefined) return undefined;
  if (!isUuid(b[k])) throw bad("connector_request", `${k} must be a lowercase UUID.`, [{ pointer: `/${k}`, keyword: "pattern" }]);
  return b[k] as string;
}
function nameField(v: unknown, at: string): string {
  if (typeof v !== "string" || v.length < 1 || v.length > 200 || CONTROL.test(v) || !VISIBLE.test(v))
    throw bad("connector_request", "The name is one line of 1–200 characters.", [{ pointer: at, keyword: "pattern" }]);
  return v;
}
function enumField<T extends string>(b: Record<string, unknown>, k: string, values: readonly T[]): T | undefined {
  if (b[k] === undefined) return undefined;
  if (!values.includes(b[k] as T)) throw bad("connector_request", `${k} must be one of: ${values.join(", ")}.`, [{ pointer: `/${k}`, keyword: "enum" }]);
  return b[k] as T;
}

/** The policy object of the contract (Policy); the schedule is not shorter than the kind allows. */
function policyField(v: unknown, manifest: ConnectorManifest): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad("connector_policy", "The policy must be an object.", [{ pointer: "/policy", keyword: "type" }]);
  const p = v as Record<string, unknown>;
  const problems: Array<{ pointer: string; keyword: string }> = [];
  for (const [k, x] of Object.entries(p)) {
    if (Object.hasOwn(POLICY_ENUMS, k)) { if (!POLICY_ENUMS[k]!.includes(x as string)) problems.push({ pointer: `/policy/${k}`, keyword: "enum" }); }
    else if (POLICY_INTS.includes(k)) {
      const min = k === "schedule_sec" ? Math.max(60, manifest.limits.minIntervalSec) : 1;
      if (typeof x !== "number" || !Number.isSafeInteger(x)) problems.push({ pointer: `/policy/${k}`, keyword: "type" });
      else if (x < min) problems.push({ pointer: `/policy/${k}`, keyword: "minimum" });
    } else problems.push({ pointer: `/policy/${k}`, keyword: "additionalProperties" });
  }
  if (problems.length) throw bad("connector_policy", "The policy does not match the contract.", problems);
  return { ...p };
}

/** Pointer to the first string (value or key) that jsonb cannot store, or null; a bad key points to its object. */
function jsonbProblem(v: unknown, at: string, depth = 0): string | null {
  if (typeof v === "string") return JSONB_BAD.test(v) ? at : null;
  if (v === null || typeof v !== "object" || depth > 32) return null;
  for (const [k, x] of Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)) {
    if (JSONB_BAD.test(k)) return at;
    const found = jsonbProblem(x, `${at}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The config with the kind's defaults (and the preset's) filled in, checked against the kind's schema. */
function configField(v: unknown, connector: Connector, presetConfig: Record<string, unknown> | null): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad("connector_config", "The config must be an object.", [{ pointer: "/config", keyword: "type" }]);
  const unstorable = jsonbProblem(v, "/config");
  if (unstorable) throw bad("connector_config", "A text of the config holds U+0000 or a broken surrogate pair.", [{ pointer: unstorable.slice(0, 512), keyword: "pattern" }]);
  const config = applyConfigDefaults(connector.manifest, { ...(presetConfig ?? {}), ...(v as Record<string, unknown>) });
  const problems = [...validateConfig(connector.manifest, config), ...(connector.validate?.(config) ?? [])];
  if (problems.length)
    throw bad("connector_config", "The connector configuration does not match the schema of its kind.",
              problems.map((p) => ({ pointer: `/config${p.path ?? ""}`.slice(0, 512), keyword: (p.code.split(":")[1] ?? p.code).slice(0, 64) })));
  return config;
}

// ---------------------------------------------------------------- views (never a secret value)

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const reasonOf = (v: string | null): string | null => (v === null ? null : REASON.test(v) && v.length <= 64 ? v : "internal");
const oneLine = (v: unknown, fallback: string): string => {
  const s = typeof v === "string" ? v.replace(new RegExp(CONTROL.source, "g"), " ").trim().slice(0, 200) : "";
  return s || fallback;
};

const writesMeetings = (m: ConnectorManifest): boolean => m.produces.includes("meeting");
const entityOnly = (m: ConnectorManifest): boolean => m.produces.length > 0 && m.produces.every((p) => p === "entity");
const takesWebhooks = (m: ConnectorManifest): boolean => Boolean(m.capabilities.webhook);
/** Writes documents or notes, the only items with a target space and a data class (meetings go to the owner, closed). */
const writesDocs = (m: ConnectorManifest): boolean => m.produces.some((p) => p === "document" || p === "note");
/** Runs as its creator: meetings, a personal-space target or a personal source. */
const ownConnector = (m: ConnectorManifest, scope: string, target: string | null): boolean =>
  !entityOnly(m) && (writesMeetings(m) || target === null || scope === "person");
/** Names of the secrets a connector of this kind has: the manifest's, and the webhook secret of a kind that takes webhooks. */
const secretNames = (m: ConnectorManifest): string[] => [...m.secrets.map((s) => s.name), ...(takesWebhooks(m) ? [WEBHOOK_SECRET_NAME] : [])];

/**
 * A kind without documents and notes has no place to choose: its meetings go to the run-as person's personal space and
 * are closed, its entities to the registry. A target space or the class `space` would only show a place that is never used.
 */
function noPlacement(target: string | null, dataClass: "closed" | "space"): void {
  if (target !== null)
    throw bad("connector_request", "This kind writes no documents or notes: it takes no target space.", [{ pointer: "/target_space_id", keyword: "not" }]);
  if (dataClass !== "closed")
    throw bad("connector_request", "This kind writes no documents or notes: its records are always closed.", [{ pointer: "/data_class", keyword: "const" }]);
}

/** Packs in the shape entitySystemRefusal reads: the presets of the listed packs only. */
const enabledPacks = (reg: ConnectorRegistry): Pack[] => [{ id: "enabled", presets: [...reg.presets] }];

function pageCursor(key: string, id: string): string { return Buffer.from(JSON.stringify([key, id]), "utf8").toString("base64url"); }
function readCursor(raw: string | undefined): { key: string; id: string } | null {
  if (raw === undefined) return null;
  if (!CURSOR.test(raw)) throw bad("connector_request", "The cursor is not valid.", [{ pointer: "/cursor", keyword: "pattern" }]);
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(v[0]) && isUuid(v[1])
        && realTime(v[0])) return { key: v[0], id: v[1] };
  } catch { /* falls through */ }
  throw bad("connector_request", "The cursor is not valid.", [{ pointer: "/cursor", keyword: "pattern" }]);
}
/** A page key names a moment that exists (the database refuses month 13 or second 61 with an error). */
function realTime(key: string): boolean {
  const t = Date.parse(`${key.slice(0, 23)}Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 23) === key.slice(0, 23);
}
function readLimit(raw: string | undefined): number {
  if (raw === undefined) return ADMIN_PAGE_DEFAULT;
  if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > ADMIN_PAGE_MAX)
    throw bad("connector_request", `limit is a whole number from 1 to ${ADMIN_PAGE_MAX}.`, [{ pointer: "/limit", keyword: "maximum" }]);
  return Number(raw);
}

export function registerConnectorsAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit, o: ConnectorsAdminOptions = {}): void {
  const ctl = app.db.control;
  let keyringCache: SettingsKeyring | null = o.keyring ?? null;
  const keyring = (): SettingsKeyring => (keyringCache ??= settingsKeyring({ appSecret: app.appSecret }));
  const registry = (): ConnectorRegistry => {
    const packs = app.settings.get<unknown>("integrations.connectors_packs", []);
    return (o.registry ?? builtinConnectors)(Array.isArray(packs) ? packs.filter((p): p is string => typeof p === "string") : []);
  };
  const kindOf = (reg: ConnectorRegistry, kind: string): Connector => {
    const k = reg.kinds.get(kind);
    if (!k) throw conflict("connector_kind", "This build has no connector kind of this name any more.");
    return k;
  };

  /** The connector row; inside a transaction with `lock`, the row stays locked until it ends (a read-check-write is one step). */
  async function load(id: string, q: Queryable = ctl, lock = false): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    const row = (await q.query(`SELECT ${CONNECTOR_COLS} FROM connectors WHERE id = $1 AND instance_id = $2${lock ? " FOR UPDATE" : ""}`, [id, app.instanceId])).rows[0] as Row | undefined;
    if (!row) throw notFound();
    return row;
  }
  async function person(id: string | null): Promise<PersonRow | null> {
    if (!id) return null;
    return ((await ctl.query(`SELECT ${personCols()} FROM people WHERE id = $1 AND instance_id = $2`, [id, app.instanceId])).rows[0] as PersonRow | undefined) ?? null;
  }
  /** The administrator's own person card (active, not a demo person), or null. */
  async function operator(c: Context): Promise<PersonRow | null> {
    const op = await operatorOf(app, c);
    return op.person ? person(op.person.id) : null;
  }
  /** Login of whoever acts: the person card, else the admin session's login. */
  const actorLogin = (c: Context, me: PersonRow | null): string | null =>
    me?.login ?? ((c.get("caller") as Caller | undefined)?.admin?.login ?? null);

  /**
   * The run-as person can write where the connector delivers documents and notes, with its data class (the same gates as
   * the delivery: space_denied, space_unsupported, class_gate); inactive or demo → owner_inactive.
   */
  async function checkRunAs(conn: { id: string; kind: string; name: string; target_space_id: string | null; data_class: "closed" | "space" },
                            owner: PersonRow | null, m: ConnectorManifest, asConflict = false): Promise<void> {
    const fail = (reason: string, message: string) => (asConflict ? conflict(reason, message) : bad(reason, message, [{ pointer: "/owner_id", keyword: "run_as" }]));
    if (!owner || !owner.active || owner.demo) throw fail("owner_inactive", "The run-as person must be an active person of this installation (not a demo person).");
    if (!writesDocs(m)) return;
    const gate = await deliveryTarget(app, connectorCaller(app, conn, owner), conn, "document");
    if (!gate.ok) {
      const text: Record<string, string> = {
        space_denied: "The run-as person cannot write into the target space (archived, gone, another person's personal space, or no write role).",
        space_unsupported: "Connectors do not write into the organisation-wide space in this release.",
        class_gate: "The connector delivers closed records only, and the target space would make its records open.",
      };
      throw fail(gate.reason, text[gate.reason] ?? "The target is not allowed.");
    }
    // a personal space named as the target would pass the delivery as a team target: the rule "personal targets only for
    // the creator" holds only when the personal space is chosen by leaving target_space_id out
    if (conn.target_space_id !== null && gate.space.kind === "personal")
      throw fail("personal_target", "To write into the personal space, leave target_space_id out: the connector then runs as the administrator who creates it.");
  }

  /** Whether the entity system code of a config is checked (a kind that writes entities and names a code, or must). */
  const systemChecked = (m: ConnectorManifest, config: Record<string, unknown>): boolean =>
    m.produces.includes("entity") && (config.system !== undefined || entityOnly(m));
  /** The entity system code of a config: allowed for this preset (no database). */
  function checkSystemCode(reg: ConnectorRegistry, m: ConnectorManifest, config: Record<string, unknown>, pack: string | null): void {
    if (!systemChecked(m, config)) return;
    const refused = entitySystemRefusal(config.system, pack, enabledPacks(reg));
    if (refused) throw bad(refused, "The entity system code of the config is missing, invalid or reserved.", [{ pointer: "/config/system", keyword: "system" }]);
  }
  /**
   * Not used by another team connector. Runs inside the transaction that writes the connector: the instance's codes are
   * checked and written under one advisory lock, so two administrators cannot take the same code at the same moment.
   */
  async function checkSystemFree(q: Queryable, m: ConnectorManifest, config: Record<string, unknown>, selfId: string | null): Promise<void> {
    if (!systemChecked(m, config)) return;
    await q.query("SELECT pg_advisory_xact_lock(hashtext('connector_system:' || $1))", [app.instanceId]);
    const taken = await q.query(
      "SELECT 1 FROM connectors WHERE instance_id = $1 AND scope = 'instance' AND status <> 'revoked' AND config ->> 'system' = $2 AND ($3::uuid IS NULL OR id <> $3)",
      [app.instanceId, config.system, selfId]);
    if (taken.rowCount) throw conflict("entity_system:taken", "Another connector already writes entities with this system code.");
  }

  async function view(row: Row, reg: ConnectorRegistry): Promise<Record<string, unknown>> {
    const kind = reg.kinds.get(row.kind);
    const owner = await person(row.owner_id);
    const names = kind ? secretNames(kind.manifest) : [];
    const stored = (await ctl.query("SELECT name, updated_at FROM connector_secrets WHERE connector_id = $1", [row.id])).rows as Array<{ name: string; updated_at: Date }>;
    const all = [...new Set([...names, ...stored.map((s) => s.name)])].filter((n) => n.length <= 32).sort();
    const loaded = stored.length ? await loadConnectorSecrets(ctl, keyring(), row.id) : null;
    const secrets = all.map((name) => {
      const s = stored.find((x) => x.name === name);
      let fingerprint: string | null = null;
      if (s && loaded) {
        try { const v = loaded.get(name); fingerprint = v === null ? null : secretFingerprint(keyring(), v); }
        catch (e) { if (!(e instanceof ConnectorSecretError)) throw e; }   // unreadable: set, without a fingerprint
      }
      return { name, set: Boolean(s), fingerprint, updated_at: iso(s?.updated_at ?? null) };
    });
    return {
      id: row.id, kind: row.kind, pack: row.pack, name: oneLine(row.name, "Connector"), scope: row.scope,
      owner: owner ? { id: owner.id, login: oneLine(owner.login, owner.id), name: oneLine(owner.display_name, oneLine(owner.login, owner.id)) } : null,
      target_space_id: row.target_space_id, data_class: row.data_class, status: row.status, config: row.config ?? {}, policy: row.policy ?? {},
      consent: row.consent_version && row.consent_at ? { version: oneLine(row.consent_version, "v0"), at: iso(row.consent_at) } : null,
      next_run_at: iso(row.next_run_at), last_run_at: iso(row.last_run_at), last_ok_at: iso(row.last_ok_at), last_error: reasonOf(row.last_error),
      failures: row.failures, secrets, webhook_path: kind && takesWebhooks(kind.manifest) ? `/api/v1/hooks/${row.id}` : null,
      created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    };
  }

  const audited = (c: Context, op: ConnectorAdminOp, row: Pick<Row, "id" | "kind" | "scope">,
                   x: { fields?: string[]; run_as?: string; status?: string; secret_name?: string; fingerprint?: string } = {}) => {
    const ev = auditConnectorAdmin(op, { id: row.id, kind: row.kind, scope: row.scope }, x);
    const { op: name, ...details } = ev.details;
    return adminAudit(c, String(name), details);
  };
  const newSecret = (): string => `whsec_${randomBytes(32).toString("base64")}`;

  // ---------------------------------------------------------------- kinds (before /connectors/:id)
  r.get("/connectors/kinds", (c) => {
    const reg = registry();
    return c.json({
      kinds: [...reg.kinds.values()].map((k) => k.manifest),
      presets: reg.presets.map((p) => ({ id: p.id, kind: p.kind, title: oneLine(p.title, p.id) })),
    });
  });

  // ---------------------------------------------------------------- list, newest first
  r.get("/connectors", async (c) => {
    const limit = readLimit(c.req.query("limit"));
    const cur = readCursor(c.req.query("cursor"));
    const { rows } = await ctl.query(
      `SELECT ${CONNECTOR_COLS} FROM connectors WHERE instance_id = $1
         AND ($2::timestamp IS NULL OR (created_at AT TIME ZONE 'UTC', id) < ($2::timestamp, $3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`, [app.instanceId, cur?.key ?? null, cur?.id ?? null, limit + 1]);
    const reg = registry();
    const page = (rows as Row[]).slice(0, limit);
    const out: Record<string, unknown> = { connectors: await Promise.all(page.map((row) => view(row, reg))) };
    if (rows.length > limit) out.next_cursor = pageCursor(page[page.length - 1]!.page_key, page[page.length - 1]!.id);
    return c.json(out);
  });

  // ---------------------------------------------------------------- create (status draft)
  r.post("/connectors", async (c) => {
    const b = await body(c);
    onlyFields(b, ["kind", "pack", "name", "scope", "config", "owner_id", "target_space_id", "data_class", "policy", "consent_version"]);
    for (const k of ["kind", "name", "scope", "config"]) if (b[k] === undefined) throw bad("connector_request", `${k} is required.`, [{ pointer: `/${k}`, keyword: "required" }]);
    if (typeof b.kind !== "string" || !KIND.test(b.kind)) throw bad("connector_kind", "kind is the name of a connector kind.", [{ pointer: "/kind", keyword: "pattern" }]);
    const reg = registry();
    const kind = reg.kinds.get(b.kind);
    if (!kind) throw bad("connector_kind", "This build has no connector kind of this name.", [{ pointer: "/kind", keyword: "enum" }]);
    const m = kind.manifest;
    let pack: string | null = null, presetConfig: Record<string, unknown> | null = null;
    if (b.pack !== undefined) {
      const preset = typeof b.pack === "string" ? reg.preset(b.pack) : null;
      if (!preset || preset.kind !== m.kind) throw bad("connector_preset", "No switched-on preset of this name for this kind.", [{ pointer: "/pack", keyword: "enum" }]);
      pack = preset.id; presetConfig = preset.config;
    }
    const name = nameField(b.name, "/name");
    const scope = enumField(b, "scope", ["instance", "person"] as const)!;
    if (!m.scopes.includes(scope)) throw bad("connector_scope", `A ${m.kind} connector has scope ${m.scopes.join(" or ")}.`, [{ pointer: "/scope", keyword: "enum" }]);
    const target = uuidField(b, "target_space_id") ?? null;
    const dataClass = enumField(b, "data_class", ["closed", "space"] as const) ?? "closed";
    if (!writesDocs(m) && !entityOnly(m)) noPlacement(target, dataClass);
    if (entityOnly(m) && dataClass !== "closed") noPlacement(null, dataClass);
    const policy = b.policy === undefined ? {} : policyField(b.policy, m);
    const config = configField(b.config, kind, presetConfig);
    const ownerArg = uuidField(b, "owner_id") ?? null;
    const me = await operator(c);
    const own = ownConnector(m, scope, target);
    let owner: PersonRow | null = null;
    if (entityOnly(m)) {
      if (scope !== "instance") throw bad("entity_scope", "An entity-only connector is a team connector (scope instance).", [{ pointer: "/scope", keyword: "enum" }]);
      if (ownerArg || target) throw bad("connector_owner", "An entity-only connector has no run-as person and no target space.", [{ pointer: ownerArg ? "/owner_id" : "/target_space_id", keyword: "not" }]);
    } else if (own) {
      // meetings, a personal space, a personal source: only the administrator's own person card
      if (!me) throw bad("operator_unlinked", "Meetings and personal-space targets run as the administrator who creates the connector: link your administrator account to your person card first.");
      if (ownerArg && ownerArg !== me.id)
        throw bad("run_as_denied", "A connector that writes meetings or into a personal space runs as the administrator who creates it; another person connects their own sources.", [{ pointer: "/owner_id", keyword: "run_as" }]);
      owner = me;
    } else {
      owner = ownerArg ? await person(ownerArg) : me;
      if (!owner && !ownerArg) throw bad("operator_unlinked", "Name the run-as person (owner_id), or link your administrator account to your person card.", [{ pointer: "/owner_id", keyword: "required" }]);
    }
    let consent: { version: string; by: string } | null = null;
    if (b.consent_version !== undefined) {
      if (!writesMeetings(m) || !owner) throw bad("connector_consent", "Only a connector that writes meetings takes a consent acknowledgement.", [{ pointer: "/consent_version", keyword: "not" }]);
      const v = nameField(b.consent_version, "/consent_version");
      if (v !== consentText(app).version) throw bad("consent_outdated", "This is not the current version of the consent text.", [{ pointer: "/consent_version", keyword: "const" }]);
      consent = { version: v, by: owner.id };
    }
    const id = randomUUID();
    if (!entityOnly(m)) await checkRunAs({ id, kind: m.kind, name, target_space_id: target, data_class: dataClass }, owner, m);
    checkSystemCode(reg, m, config, pack);
    const createdBy = (own ? me?.login : actorLogin(c, me)) ?? "system";
    const secret = takesWebhooks(m) ? newSecret() : null;
    let fingerprint: string | undefined;
    await tx(ctl, async (q) => {
      await checkSystemFree(q, m, config, null);
      await q.query(
        `INSERT INTO connectors (id, instance_id, kind, pack, name, scope, owner_id, target_space_id, data_class, status, config, policy, consent_version, consent_at, consent_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10::jsonb,$11::jsonb,$12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13, $14)`,
        [id, app.instanceId, m.kind, pack, name, scope, owner?.id ?? null, target, dataClass, JSON.stringify(config), JSON.stringify(policy),
         consent?.version ?? null, consent?.by ?? null, createdBy]);
      if (secret) fingerprint = (await setConnectorSecret(q, keyring(), id, WEBHOOK_SECRET_NAME, secret)).fingerprint;
    });
    const row = await load(id);
    await audited(c, "connector_created", row, {
      fields: ["name", "scope", "data_class", ...(target ? ["target_space_id"] : []), ...(pack ? ["pack"] : []), ...Object.keys(config).sort().map((k) => `config.${k}`),
               ...Object.keys(policy).sort().map((k) => `policy.${k}`), ...(consent ? ["consent_version"] : [])],
      ...(owner ? { run_as: owner.id } : {}), status: "draft",
      ...(fingerprint ? { secret_name: WEBHOOK_SECRET_NAME, fingerprint } : {}),
    });
    return c.json({ connector: await view(row, reg), ...(secret ? { webhook_secret: secret } : {}) }, 201);
  });

  // ---------------------------------------------------------------- one connector
  r.get("/connectors/:id", async (c) => c.json(await view(await load(c.req.param("id")), registry())));

  r.patch("/connectors/:id", async (c) => {
    await load(c.req.param("id"));
    const b = await body(c);
    onlyFields(b, ["name", "config", "policy", "target_space_id", "data_class", "owner_id"]);
    if (Object.keys(b).length === 0) throw bad("connector_request", "Name at least one field to change.");
    // read, check and write under the row lock: two changes at the same moment are applied one after the other, none is lost
    const out = await tx(ctl, (q) => patchLocked(q, c.req.param("id"), b));
    if (out.changed) await audited(c, "connector_changed", out.row, { fields: out.fields, ...(out.row.owner_id ? { run_as: out.row.owner_id } : {}), ...(out.paused ? { status: "paused" } : {}) });
    return c.json(await view(out.row, registry()));
  });

  async function patchLocked(q: Queryable, id: string, b: Record<string, unknown>): Promise<{ row: Row; changed: boolean; fields: string[]; paused: boolean }> {
    const row = await load(id, q, true);
    if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector does not change; delete it.");
    const reg = registry();
    const kind = kindOf(reg, row.kind);
    const m = kind.manifest;
    const next = { ...row };
    const fields: string[] = [];
    if (b.name !== undefined) { next.name = nameField(b.name, "/name"); if (next.name !== row.name) fields.push("name"); }
    if (b.policy !== undefined) {
      next.policy = policyField(b.policy, m);
      fields.push(...[...new Set([...Object.keys(row.policy ?? {}), ...Object.keys(next.policy)])]
        .filter((k) => JSON.stringify(row.policy?.[k]) !== JSON.stringify(next.policy[k])).sort().map((k) => `policy.${k}`));
    }
    if (b.config !== undefined) {
      const presetConfig = row.pack ? reg.preset(row.pack)?.config ?? null : null;
      next.config = configField(b.config, kind, presetConfig);
      fields.push(...[...new Set([...Object.keys(row.config ?? {}), ...Object.keys(next.config)])]
        .filter((k) => JSON.stringify(row.config?.[k]) !== JSON.stringify(next.config[k])).sort().map((k) => `config.${k}`));
    }
    const target = uuidField(b, "target_space_id");
    if (target !== undefined && target !== row.target_space_id) {
      if (entityOnly(m)) throw bad("connector_owner", "An entity-only connector has no target space.", [{ pointer: "/target_space_id", keyword: "not" }]);
      if (!writesDocs(m)) noPlacement(target, "closed");
      next.target_space_id = target; fields.push("target_space_id");
    }
    const dataClass = enumField(b, "data_class", ["closed", "space"] as const);
    if (dataClass !== undefined && !writesDocs(m)) noPlacement(null, dataClass);
    if (dataClass !== undefined && dataClass !== row.data_class) { next.data_class = dataClass; fields.push("data_class"); }
    const ownerArg = uuidField(b, "owner_id");
    if (ownerArg !== undefined && ownerArg !== row.owner_id) {
      // kind, scope and the run-as person of a meeting or personal-space connector never change (delete and create again)
      if (entityOnly(m)) throw bad("connector_owner", "An entity-only connector has no run-as person.", [{ pointer: "/owner_id", keyword: "not" }]);
      if (ownConnector(m, row.scope, row.target_space_id) || ownConnector(m, next.scope, next.target_space_id))
        throw bad("run_as_fixed", "The run-as person of a connector that writes meetings or into a personal space does not change: delete the connector and create it again.",
                  [{ pointer: "/owner_id", keyword: "run_as" }]);
      next.owner_id = ownerArg; fields.push("owner_id");
    }
    if (fields.length === 0) return { row, changed: false, fields, paused: false };
    const moved = fields.some((f) => f === "target_space_id" || f === "data_class" || f === "owner_id");
    // the new combination of person, target and class passes the delivery's gates
    if (!entityOnly(m) && moved) await checkRunAs(next, await person(next.owner_id), m);
    const systemChanged = fields.some((f) => f === "config.system");
    if (systemChanged) checkSystemCode(reg, m, next.config, row.pack);
    // a new place, class or person: staged items are not delivered there by surprise — paused until an explicit resume
    const pause = moved && ["active", "error", "needs_reconfirm"].includes(row.status);
    if (systemChanged) await checkSystemFree(q, m, next.config, row.id);
    await q.query(
      `UPDATE connectors SET name = $2, config = $3::jsonb, policy = $4::jsonb, target_space_id = $5, data_class = $6, owner_id = $7,
              status = CASE WHEN $8 THEN 'paused' ELSE status END, updated_at = now() WHERE id = $1`,
      [row.id, next.name, JSON.stringify(next.config), JSON.stringify(next.policy), next.target_space_id, next.data_class, next.owner_id, pause]);
    return { row: await load(row.id, q), changed: true, fields, paused: pause };
  }

  r.delete("/connectors/:id", async (c) => {
    const row = await load(c.req.param("id"));
    await ctl.query("DELETE FROM connectors WHERE id = $1 AND instance_id = $2", [row.id, app.instanceId]);
    await audited(c, "connector_deleted", row, { ...(row.owner_id ? { run_as: row.owner_id } : {}) });
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- secrets (write-only)
  r.put("/connectors/:id/secrets/:name", async (c) => {
    const row = await load(c.req.param("id"));
    const name = c.req.param("name");
    if (!SECRET_PATH_NAME.test(name)) throw bad("connector_secret_name", "No secret of this name.", [{ pointer: "/name", keyword: "pattern" }]);
    const b = await body(c);
    onlyFields(b, ["value"]);
    const kind = kindOf(registry(), row.kind);
    if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector does not change; delete it.");
    // the signing secret of webhooks is never set by hand, even if a manifest declared the name (the registry refuses that)
    if (name === WEBHOOK_SECRET_NAME || !kind.manifest.secrets.some((s) => s.name === name))
      throw bad("connector_secret_name", name === WEBHOOK_SECRET_NAME
        ? "The webhook secret is created by the memory: rotate it instead." : "The kind of this connector declares no secret of this name.", [{ pointer: "/name", keyword: "enum" }]);
    if (typeof b.value !== "string" || b.value.length < 1 || b.value.length > 8192) throw bad("connector_secret", "The value is a string of 1–8192 characters.", [{ pointer: "/value", keyword: "maxLength" }]);
    let fingerprint: string;
    try { fingerprint = (await setConnectorSecret(ctl, keyring(), row.id, name, b.value)).fingerprint; }
    catch (e) {
      if (e instanceof ConnectorSecretError) throw bad("connector_secret", "The value cannot be stored as a secret.", [{ pointer: "/value", keyword: "pattern" }]);
      throw e;
    }
    const at = (await ctl.query("SELECT updated_at FROM connector_secrets WHERE connector_id = $1 AND name = $2", [row.id, name])).rows[0]?.updated_at as Date;
    await ctl.query("UPDATE connectors SET updated_at = now() WHERE id = $1", [row.id]);
    await audited(c, "connector_secret_set", row, { secret_name: name, fingerprint });
    return c.json({ name, fingerprint, updated_at: iso(at) });
  });

  r.post("/connectors/:id/webhook-secret/rotate", async (c) => {
    const row = await load(c.req.param("id"));
    const kind = kindOf(registry(), row.kind);
    if (!takesWebhooks(kind.manifest)) throw conflict("connector_no_webhook", "The kind of this connector takes no webhooks.");
    if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector takes no webhooks.");
    const secret = newSecret();
    const { fingerprint } = await rotateConnectorSecret(ctl, keyring(), row.id, WEBHOOK_SECRET_NAME, secret, WEBHOOK_ROTATE_OVERLAP_SEC);
    const s = (await ctl.query("SELECT COALESCE(prev_until, updated_at) AS until FROM connector_secrets WHERE connector_id = $1 AND name = $2",
                               [row.id, WEBHOOK_SECRET_NAME])).rows[0] as { until: Date };
    await ctl.query("UPDATE connectors SET updated_at = now() WHERE id = $1", [row.id]);
    await audited(c, "connector_secret_rotated", row, { secret_name: WEBHOOK_SECRET_NAME, fingerprint });
    return c.json({ webhook_secret: secret, previous_valid_until: iso(s.until) });
  });

  // ---------------------------------------------------------------- test and run: rows the worker scheduler takes
  const queueRun = async (c: Context, row: Row, kind: "test" | "sync"): Promise<Response> => {
    const me = await operator(c);
    const runId = randomUUID();
    const { rowCount } = await ctl.query(
      `INSERT INTO connector_runs (id, connector_id, kind, status, requested_by)
       SELECT $1, $2, $3, 'queued', $4 WHERE NOT EXISTS (SELECT 1 FROM connector_runs WHERE connector_id = $2 AND status IN ('queued','running'))`,
      [runId, row.id, kind, actorLogin(c, me)?.slice(0, 200) ?? null]);
    if (!rowCount) throw conflict("connector_busy", "A run of this connector is already queued or going.");
    await audited(c, "connector_status", row, { status: kind === "test" ? "test_queued" : "run_queued" });
    return c.json({ run_id: runId }, 202);
  };
  r.post("/connectors/:id/test", async (c) => {
    const row = await load(c.req.param("id"));
    kindOf(registry(), row.kind);
    if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector is not tested.");
    return queueRun(c, row, "test");
  });
  r.post("/connectors/:id/run", async (c) => {
    const row = await load(c.req.param("id"));
    const kind = kindOf(registry(), row.kind);
    if (!kind.manifest.capabilities.pull) throw conflict("connector_no_pull", "The kind of this connector does not pull; its source sends items itself.");
    if (row.status !== "active") throw conflict("connector_not_active", "Only an active connector runs; resume it first.");
    return queueRun(c, row, "sync");
  });

  // ---------------------------------------------------------------- pause, resume, reconfirm
  r.post("/connectors/:id/pause", async (c) => {
    const row = await load(c.req.param("id"));
    if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector does not run.");
    // a draft does not run yet and stays a draft: pausing it must not wash away "never tested" (it becomes active only by
    // resume after a passed test)
    const { rowCount } = await ctl.query("UPDATE connectors SET status = 'paused', updated_at = now() WHERE id = $1 AND status NOT IN ('paused', 'draft', 'revoked')", [row.id]);
    if (rowCount) await audited(c, "connector_status", row, { status: "paused" });
    return c.json(await view(await load(row.id), registry()));
  });

  r.post("/connectors/:id/resume", async (c) => {
    await load(c.req.param("id"));
    const reg = registry();
    // checks and the write under the row lock: a change of target or person at the same moment waits for the resume or is
    // checked by it, never written past it
    const out = await tx(ctl, async (q) => {
      const row = await load(c.req.param("id"), q, true);
      const m = kindOf(reg, row.kind).manifest;
      if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector does not run again; create a new one.");
      if (row.status === "needs_reconfirm") throw conflict("consent_outdated", "The meeting consent text changed: the run-as person acknowledges it again (reconfirm).");
      if (row.status === "active") return { row, resumed: false };
      // the facts, not only the status: whatever the connector went through (pause, a change), a meeting connector runs
      // only with an acknowledgement of the current consent text, and a connector that never ran only after a passed test
      if (row.status === "draft") {
        const last = (await q.query("SELECT status FROM connector_runs WHERE connector_id = $1 AND kind = 'test' ORDER BY created_at DESC, id DESC LIMIT 1", [row.id])).rows[0];
        if (last?.status !== "ok") throw conflict("connector_untested", "A new connector is activated after a passed test.");
      }
      if (writesMeetings(m) && row.consent_version !== consentText(app).version)
        throw conflict("consent_outdated", "The run-as person has not acknowledged the current meeting consent text: reconfirm first.");
      if (!entityOnly(m)) await checkRunAs(row, await person(row.owner_id), m, true);
      await q.query(
        `UPDATE connectors SET status = 'active', failures = 0, last_error = NULL, updated_at = now(),
                next_run_at = CASE WHEN $2 THEN now() ELSE next_run_at END WHERE id = $1`, [row.id, Boolean(m.capabilities.pull)]);
      return { row, resumed: true };
    });
    if (!out.resumed) return c.json(await view(out.row, reg));
    await requeueHeld(app, out.row.id);
    await audited(c, "connector_status", out.row, { status: "active", ...(out.row.owner_id ? { run_as: out.row.owner_id } : {}) });
    return c.json(await view(await load(out.row.id), reg));
  });

  r.post("/connectors/:id/reconfirm", async (c) => {
    const row = await load(c.req.param("id"));
    const reg = registry();
    const m = kindOf(reg, row.kind).manifest;
    if (!writesMeetings(m)) throw conflict("connector_no_meetings", "The kind of this connector writes no meetings.");
    if (row.status === "revoked") throw conflict("connector_revoked", "A revoked connector does not run again; create a new one.");
    const me = await operator(c);
    if (!me || me.id !== row.owner_id)
      throw forbidden("run_as_denied", "Only the run-as person of this connector acknowledges its meeting consent.");
    const version = consentText(app).version;
    await ctl.query(
      `UPDATE connectors SET consent_version = $2, consent_at = now(), consent_by = $3, updated_at = now(),
              status = CASE WHEN status = 'needs_reconfirm' THEN 'active' ELSE status END WHERE id = $1`, [row.id, version, me.id]);
    await requeueHeld(app, row.id, ["consent_outdated"]);
    const after = await load(row.id);
    await audited(c, "connector_status", after, { fields: ["consent_version"], run_as: me.id, status: after.status });
    return c.json(await view(after, reg));
  });

  // ---------------------------------------------------------------- runs and items (never content)
  r.get("/connectors/:id/runs", async (c) => {
    const row = await load(c.req.param("id"));
    const limit = readLimit(c.req.query("limit"));
    const cur = readCursor(c.req.query("cursor"));
    const { rows } = await ctl.query(
      `SELECT id, kind, status, requested_by, created_at, started_at, finished_at, seen, staged, error,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS page_key
         FROM connector_runs WHERE connector_id = $1
          AND ($2::timestamp IS NULL OR (created_at AT TIME ZONE 'UTC', id) < ($2::timestamp, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`, [row.id, cur?.key ?? null, cur?.id ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const out: Record<string, unknown> = {
      runs: page.map((x) => ({
        id: x.id, kind: x.kind, status: x.status, requested_by: x.requested_by === null ? null : oneLine(x.requested_by, "unknown"),
        created_at: iso(x.created_at), started_at: iso(x.started_at), finished_at: iso(x.finished_at), seen: x.seen, staged: x.staged, error: reasonOf(x.error),
      })),
    };
    if (rows.length > limit) out.next_cursor = pageCursor(page[page.length - 1]!.page_key, page[page.length - 1]!.id);
    return c.json(out);
  });

  r.get("/connectors/:id/items", async (c) => {
    const row = await load(c.req.param("id"));
    const status = c.req.query("status");
    if (status !== undefined && !ITEM_STATUSES.includes(status)) throw bad("connector_request", `status is one of: ${ITEM_STATUSES.join(", ")}.`, [{ pointer: "/status", keyword: "enum" }]);
    const limit = readLimit(c.req.query("limit"));
    const cur = readCursor(c.req.query("cursor"));
    const { rows } = await ctl.query(
      `SELECT id, item_type, external_id, status, reason, record_id, version,
              to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS page_key
         FROM connector_items WHERE connector_id = $1 AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamp IS NULL OR (received_at AT TIME ZONE 'UTC', id) < ($3::timestamp, $4::uuid))
        ORDER BY received_at DESC, id DESC LIMIT $5`, [row.id, status ?? null, cur?.key ?? null, cur?.id ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const out: Record<string, unknown> = {
      items: page.map((x) => ({
        external_id: x.external_id, type: x.item_type, status: x.status,
        ...(reasonOf(x.reason) ? { reason: reasonOf(x.reason) } : {}), ...(x.record_id ? { record_id: x.record_id } : {}), version: x.version,
      })),
    };
    if (rows.length > limit) out.next_cursor = pageCursor(page[page.length - 1]!.page_key, page[page.length - 1]!.id);
    return c.json(out);
  });
}
