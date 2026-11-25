// The workplace route supplies the authenticated person to these operations.
import { randomUUID } from "node:crypto";
import {
  applyConfigDefaults, auditConnectorAdmin, ConnectorSecretError, generateWebhookSecret, loadConnectorSecrets,
  rotateConnectorSecret, secretFingerprint, setConnectorSecret, WEBHOOK_SIGNING_SECRET, webhookManifest,
} from "@memory/connectors";
import { tx } from "@memory/shared";
import type { PoolClient } from "pg";
import { audit } from "../audit.ts";
import { personCols } from "../auth.ts";
import type { App, Caller, PersonRow } from "../context.ts";
import { consentText } from "../meetings.ts";
import { WEBHOOK_ROTATE_OVERLAP_SEC, WEBHOOK_SECRET_NAME } from "./admin.ts";
import { wakeDelivery } from "./deliver.ts";
import { invalidateHookConnectors } from "./hooks.ts";
import { connectorKeyring } from "./keyring.ts";

type Consent = { consent_version: unknown };
type RefusalCode = "not_found" | "consent_outdated" | "status_conflict" | "name_invalid";
type Refusal = { ok: false; code: RefusalCode };
const refuse = (code: RefusalCode): Refusal => ({ ok: false, code });

export const MY_SOURCES_MAX = 20;

const OWNED_WEBHOOK = "c.instance_id = $1 AND c.owner_id = $2 AND c.scope = 'person' AND c.kind = 'webhook'";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const VISIBLE = /[^\s\p{Cf}]/u;
const ERROR_CODE = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)?$/;
const hookPath = (id: string) => `/api/v1/hooks/${id}`;
const ref = (id: string) => ({ id, kind: "webhook", scope: "person" });

type Source = { id: string; status: string; consent_version: string | null };
type SourceMetadata = Source & {
  name: string;
  last_error: string | null;
  has_secret: boolean;
  previous_valid_until: Date | null;
  created_at: Date;
  updated_at: Date;
  consent_at: Date | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_ok_at: Date | null;
};

type AuditEvent = ReturnType<typeof auditConnectorAdmin>;

function auditChange(app: App, caller: Caller, event: AuditEvent): Promise<void> {
  return audit(app, caller, event);
}

function callerPerson(caller: Caller): PersonRow | null {
  return caller.principalType === "person" ? caller.person : null;
}

async function lockActivePerson(q: PoolClient, instanceId: string, personId: string): Promise<boolean> {
  const { rows: [person] } = await q.query<PersonRow>(
    `SELECT ${personCols()} FROM people WHERE id = $1 AND instance_id = $2 FOR UPDATE`, [personId, instanceId]);
  return person?.active === true && !person.demo;
}

type Change<T extends object> = Refusal | {
  ok: true;
  value: T;
  event?: AuditEvent;
  refreshHook?: boolean;
  wake?: boolean;
};

/** Read ownership and write under the same connector lock. */
async function changeOwnedSource<T extends object>(
  app: App, caller: Caller, id: string,
  change: (q: PoolClient, source: Source, person: PersonRow) => Promise<Change<T>>,
): Promise<Refusal | ({ ok: true } & T)> {
  const person = callerPerson(caller);
  if (!person || typeof id !== "string" || id.length !== 36 || !UUID.test(id)) return refuse("not_found");
  const out = await tx(app.db.control, async (q) => {
    const { rows } = await q.query<Source>(
      `SELECT id, status, consent_version FROM connectors c WHERE ${OWNED_WEBHOOK} AND c.id = $3 FOR UPDATE`,
      [app.instanceId, person.id, id]);
    const source = rows[0];
    return source ? change(q, source, person) : refuse("not_found");
  });
  if (!out.ok) return out;
  if (out.refreshHook) invalidateHookConnectors();
  if (out.wake) wakeDelivery();
  if (out.event) await auditChange(app, caller, out.event);
  return { ok: true, ...out.value };
}

/** Requeue in the same transaction that clears the hold. */
async function requeueHeldItems(q: PoolClient, id: string, reason: string | null): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE connector_items SET status = 'staged', reason = NULL, attempts = 0, next_attempt_at = now(), lease_until = NULL
     WHERE connector_id = $1 AND status = 'held' AND ($2::text IS NULL OR reason = $2)`, [id, reason]);
  return Boolean(rowCount);
}

export async function listMySources(app: App, caller: Caller) {
  const person = callerPerson(caller);
  if (!person) return [];
  const version = consentText(app).version;
  return tx(app.db.control, async (q) => {
    // Read the fingerprint and the overlap from the same snapshot as the source.
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await q.query<SourceMetadata>(
      `SELECT c.id, c.name, c.status, c.consent_version, c.consent_at, c.last_error, c.created_at, c.updated_at,
              c.next_run_at, c.last_run_at, c.last_ok_at, s.name IS NOT NULL AS has_secret,
              CASE WHEN s.prev_value IS NOT NULL AND s.prev_until > now() THEN s.prev_until END AS previous_valid_until
       FROM connectors c LEFT JOIN connector_secrets s ON s.connector_id = c.id AND s.name = $3
       WHERE ${OWNED_WEBHOOK} ORDER BY c.created_at DESC, c.id DESC`,
      [app.instanceId, person.id, WEBHOOK_SIGNING_SECRET]);

    const sources = [];
    for (const row of rows) {
      let fingerprint: string | null = null;
      if (row.has_secret) {
        const keyring = connectorKeyring(app);
        try {
          const stored = await loadConnectorSecrets(q, keyring, row.id);
          const value = stored.get(WEBHOOK_SIGNING_SECRET);
          if (value !== null) fingerprint = secretFingerprint(keyring, value);
        } catch (error) {
          if (!(error instanceof ConnectorSecretError) || error.code !== "secret_unreadable") throw error;
        }
      }
      sources.push({
        id: row.id, name: row.name, status: row.status, hook_path: hookPath(row.id), fingerprint,
        consent: row.consent_version === version ? "current" as const : "outdated" as const,
        previous_valid_until: row.previous_valid_until?.toISOString() ?? null,
        last_error: row.last_error === null || (row.last_error.length <= 64 && ERROR_CODE.test(row.last_error)) ? row.last_error : "internal",
        created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
        consent_at: row.consent_at?.toISOString() ?? null, next_run_at: row.next_run_at?.toISOString() ?? null,
        last_run_at: row.last_run_at?.toISOString() ?? null, last_ok_at: row.last_ok_at?.toISOString() ?? null,
      });
    }
    return sources;
  });
}

export async function createMySource(app: App, caller: Caller, input: Consent & { name: unknown }) {
  const person = callerPerson(caller);
  if (!person) return refuse("not_found");
  if (!person.active || person.demo) return refuse("status_conflict");
  const version = consentText(app).version;
  if (input.consent_version !== version) return refuse("consent_outdated");
  const { name } = input;
  if (typeof name !== "string" || name.length < 1 || name.length > 200 || CONTROL.test(name) || !VISIBLE.test(name))
    return refuse("name_invalid");

  const id = randomUUID();
  const secret = generateWebhookSecret();
  const config = applyConfigDefaults(webhookManifest, {});
  // Store under the hook name and use the administrative name in the audit event.
  const out = await tx(app.db.control, async (q) => {
    if (!await lockActivePerson(q, app.instanceId, person.id)) return refuse("status_conflict");
    const { rows: [count] } = await q.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM connectors c WHERE ${OWNED_WEBHOOK}`, [app.instanceId, person.id]);
    if (count!.total >= MY_SOURCES_MAX) return refuse("status_conflict");
    await q.query(
      `INSERT INTO connectors (id, instance_id, kind, name, scope, owner_id, target_space_id, data_class, status,
                               config, consent_version, consent_at, consent_by, created_by)
       VALUES ($1,$2,'webhook',$3,'person',$4,NULL,'closed','active',$5::jsonb,$6,now(),$4,$7)`,
      [id, app.instanceId, name, person.id, JSON.stringify(config), version, person.login]);
    const { fingerprint } = await setConnectorSecret(q, connectorKeyring(app), id, WEBHOOK_SIGNING_SECRET, secret);
    return { ok: true as const, fingerprint };
  });
  if (!out.ok) return out;
  const { fingerprint } = out;
  invalidateHookConnectors();
  await auditChange(app, caller, auditConnectorAdmin("connector_created", ref(id), {
    fields: ["name", "scope", "data_class", ...Object.keys(config).sort().map((key) => `config.${key}`), "consent_version"],
    run_as: person.id, status: "active", secret_name: WEBHOOK_SECRET_NAME, fingerprint,
  }));
  return { ok: true as const, id, hook_path: hookPath(id), webhook_secret: secret };
}

export function rotateMySourceSecret(app: App, caller: Caller, id: string) {
  return changeOwnedSource(app, caller, id, async (q, source) => {
    if (source.status === "revoked") return refuse("status_conflict");
    const secret = generateWebhookSecret();
    const { fingerprint } = await rotateConnectorSecret(q, connectorKeyring(app), source.id, WEBHOOK_SIGNING_SECRET, secret, WEBHOOK_ROTATE_OVERLAP_SEC);
    const { rows } = await q.query<{ until: Date }>(
      "SELECT COALESCE(prev_until, updated_at) AS until FROM connector_secrets WHERE connector_id = $1 AND name = $2",
      [source.id, WEBHOOK_SIGNING_SECRET]);
    await q.query("UPDATE connectors SET updated_at = now() WHERE id = $1", [source.id]);
    return {
      ok: true, value: { webhook_secret: secret, previous_valid_until: rows[0]!.until.toISOString() },
      event: auditConnectorAdmin("connector_secret_rotated", ref(source.id), { secret_name: WEBHOOK_SECRET_NAME, fingerprint }),
    };
  });
}

async function setSourceStatus(app: App, caller: Caller, id: string, from: readonly string[], to: "active" | "paused") {
  const person = callerPerson(caller);
  if (!person) return refuse("not_found");
  const active = to === "active";
  if (active && (!person.active || person.demo)) return refuse("status_conflict");

  return changeOwnedSource(app, caller, id, async (q, source) => {
    if (source.status !== to && !from.includes(source.status)) return refuse("status_conflict");
    if (active && !await lockActivePerson(q, app.instanceId, person.id)) return refuse("status_conflict");
    if (source.status === to) return { ok: true, value: {} };
    if (active && source.consent_version !== consentText(app).version) return refuse("consent_outdated");
    await q.query(
      `UPDATE connectors SET status = $2, updated_at = now(), failures = CASE WHEN $3 THEN 0 ELSE failures END,
                             last_error = CASE WHEN $3 THEN NULL ELSE last_error END WHERE id = $1`, [source.id, to, active]);
    const requeued = active && await requeueHeldItems(q, source.id, null);
    return {
      ok: true, value: {}, refreshHook: true, wake: requeued,
      event: auditConnectorAdmin("connector_status", ref(source.id), { status: to, ...(active ? { run_as: person.id } : {}) }),
    };
  });
}

export function pauseMySource(app: App, caller: Caller, id: string) {
  return setSourceStatus(app, caller, id, ["active", "error"], "paused");
}

export function resumeMySource(app: App, caller: Caller, id: string) {
  return setSourceStatus(app, caller, id, ["paused"], "active");
}

export function deleteMySource(app: App, caller: Caller, id: string) {
  return changeOwnedSource(app, caller, id, async (q, source, person) => {
    await q.query("DELETE FROM connectors WHERE id = $1", [source.id]);
    return {
      ok: true, value: {}, refreshHook: true,
      event: auditConnectorAdmin("connector_deleted", ref(source.id), { run_as: person.id }),
    };
  });
}

export async function reconfirmMySource(app: App, caller: Caller, id: string, input: Consent) {
  const person = callerPerson(caller);
  if (!person) return refuse("not_found");
  if (!person.active || person.demo) return refuse("status_conflict");

  return changeOwnedSource(app, caller, id, async (q, source) => {
    const version = consentText(app).version;
    if (input.consent_version !== version) return refuse("consent_outdated");
    if (source.status === "revoked") return refuse("status_conflict");
    const activates = source.status === "needs_reconfirm";
    if (activates && !await lockActivePerson(q, app.instanceId, person.id)) return refuse("status_conflict");
    const status = activates ? "active" : source.status;
    await q.query(
      "UPDATE connectors SET consent_version = $2, consent_at = now(), consent_by = $3, updated_at = now(), status = $4 WHERE id = $1",
      [source.id, version, person.id, status]);
    const requeued = await requeueHeldItems(q, source.id, "consent_outdated");
    return {
      ok: true, value: {}, refreshHook: activates, wake: requeued,
      event: auditConnectorAdmin("connector_status", ref(source.id), { fields: ["consent_version"], run_as: person.id, status }),
    };
  });
}
