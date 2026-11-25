// A person's consent to reading "on behalf": access.obo_read_consent — legacy (no consent needed,
// as before), consent (a live consent of the pair "person, service" is needed), off (reading "on behalf" is off for all; unknown
// value is off too). Without consent a request is not refused but narrowed: the service loses its read operations (auth.ts),
// writing and intake on behalf stay.
//
// Only the person gives consent, in the workplace (a workplace session, the internal channel): "Service access", the routes
// /api/v1/me/obo-consents. The term is access.obo_read_consent_days; another "Allow" extends it (the old consent
// is closed, a new one is given). The administrator gives no consent — only revokes it (/api/v1/admin/obo-consents, the class
// "narrowing"). Turning a service or its on-behalf reading off closes consents at once, in the same transaction (PATCH /services,
// closeServiceConsents); the admin_plane_gc job closes expired ones, departed people's and — as a safeguard — disabled services'.
//
// The journal gets only service data: op, service id, term, who revoked; author is the person, so the event is in their "My
// actions" also when the administrator revoked.
import { Hono } from "hono";
import { invalid, log, newId, notFound, raiseAlert, tx } from "@memory/shared";
import type { App, Caller, PersonRow, ServiceRow } from "./context.ts";
import { audit } from "./audit.ts";
import { HttpReject } from "./auth.ts";
import { onceIn } from "./channel.ts";
import { intParam, isUuidParam, offsetCursor } from "./paging.ts";
import { isHumanSession } from "./workplace.ts";
import type { AdminEnv } from "./admin-plane/middleware.ts";

type Env = { Variables: { caller: Caller } };

/** The access.obo_read_consent mode; an unknown value counts as off (closed when unknown). */
export function oboReadMode(app: Pick<App, "settings">): "legacy" | "consent" | "off" {
  const v = app.settings.get<string>("access.obo_read_consent", "legacy");
  return v === "legacy" || v === "consent" ? v : "off";
}

/** The consent term in days: access.obo_read_consent_days, bounds 1–365 (as the setting has). */
export function oboConsentDays(app: Pick<App, "settings">): number {
  const v = Number(app.settings.get<number>("access.obo_read_consent_days", 90));
  return Number.isFinite(v) ? Math.min(365, Math.max(1, Math.trunc(v))) : 90;
}

/** The event "read without consent" — at most once an hour per pair (person, service). */
export const NO_CONSENT_EVENT_EVERY_MS = 3_600_000;

/**
 * May the service read on behalf of the person (after the services.obo_read check in auth.ts). With consent mode and no live
 * consent — false; an admin event (op obo_read_no_consent, on behalf of the person: it is in their "My actions") at most once an
 * hour per pair and a medium alert, one a day per service — noteNoConsentOnce. Event and alert are written in the background.
 *
 * The event comes only on a real refusal to read, where the operation is known (rest.ts requireOp → auth.ts
 * oboReadRefused). o.note = false — do not mark at sign-in (REST); by default it marks, as before (MCP, until mcp.ts
 * marks a tool refusal itself). who — the sign-in caller (auth.ts: base): the key, address, client signature and channel go into
 * the event, so the journal shows which service key made the call.
 */
export async function oboReadAllowed(app: App, service: ServiceRow, person: PersonRow, who?: Partial<Caller>, o: { note?: boolean } = {}): Promise<boolean> {
  const mode = oboReadMode(app);
  if (mode !== "consent") return mode === "legacy";
  const r = await app.db.control.query(
    `SELECT 1 FROM obo_read_consents
      WHERE instance_id = $1 AND person_id = $2 AND service_id = $3 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [app.instanceId, person.id, service.id]);
  if ((r.rowCount ?? 0) > 0) return true;
  if (o.note !== false) noteNoConsentOnce(app, service, person, who);
  return false;
}

/** The "no consent" event and alert — at most once an hour per pair (person, service), in the background. */
export function noteNoConsentOnce(app: App, service: ServiceRow, person: PersonRow, who?: Partial<Caller>): void {
  if (onceIn(app, `obo_read_no_consent:${service.id}:${person.id}`, NO_CONSENT_EVENT_EVERY_MS))
    void noteNoConsent(app, service, person, who).catch((e: unknown) => log.error("obo_no_consent_note_failed", { error: ((e as Error)?.message ?? String(e)).slice(0, 200) }));
}

async function noteNoConsent(app: App, service: ServiceRow, person: PersonRow, base?: Partial<Caller>): Promise<void> {
  // journal caller: the service on behalf of the person (on_behalf_of = person); key, address and client from sign-in, if given
  const who = { keyId: null, keyKind: "service", tier: service.tier ?? null, clientLabel: null, clientKind: null, expiresAt: null, ip: null, netBound: false, preview: false,
                ...(base ?? {}), principalType: "service", person, service, onBehalfOf: true, allowedOps: null } as unknown as Caller;
  if (app.db.audit) await audit(app, who, { event_type: "admin", details: { op: "obo_read_no_consent", service: service.id, person: person.id } });
  const day = new Date().toISOString().slice(0, 10);
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
    instanceId: app.instanceId, level: "medium", code: "obo_read_no_consent",
    summary: `Service “${String(service.name ?? service.id).slice(0, 80)}” acted on behalf of someone who did not consent. Read access on their behalf was restricted`,
    details: { service: service.id, person: person.id }, dedupeKey: `obo_read_no_consent:${service.id}:${day}`,
  });
}

// ---------------------------------------------------------------- consent view (OpenAPI OboConsent)
interface ConsentRow {
  id: string | null; service_id: string; service_name: string; login?: string | null;
  granted_at: Date | null; expires_at: Date | null; revoked_at: Date | null; revoked_by: string | null;
}
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const view = (r: ConsentRow, withPerson: boolean) => ({
  id: r.id ?? null,
  service: { id: r.service_id, name: r.service_name },
  ...(withPerson ? { person: r.login ?? null } : {}),
  granted_at: iso(r.granted_at), expires_at: iso(r.expires_at), revoked_at: iso(r.revoked_at), revoked_by: r.revoked_by ?? null,
});

/** Refuse all but the person's own workplace session (the text is as for workplace sessions, ForbiddenSessionOnly). */
function requireWorkplaceSession(caller: Caller): void {
  if (!isHumanSession(caller) || (caller.channel !== undefined && caller.channel !== "internal"))
    throw new HttpReject(403, "forbidden", "Only you can grant or revoke consent to read on your behalf, in the workspace");
}

/** A service that may be given consent: active, acts on behalf of people and reads on their behalf. */
const READING_SERVICE = "s.instance_id = $1 AND s.active AND s.obo_allowed AND s.obo_read";

/** Workplace: own consents (/api/v1/me/obo-consents). */
export function oboConsentRoutes(app: App): Hono<Env> {
  const r = new Hono<Env>();
  const limit = (caller: Caller, bucket: string) => app.limiter?.check(caller, bucket);

  // services reading on behalf of people, and my consent to each (live first, else the last closed; id null — never given)
  r.get("/api/v1/me/obo-consents", async (c) => {
    const caller = c.get("caller");
    requireWorkplaceSession(caller);
    limit(caller, "me_keys_view");
    const { rows } = await app.db.control.query(
      `SELECT s.id AS service_id, s.name AS service_name, x.id, x.granted_at, x.expires_at, x.revoked_at, x.revoked_by
         FROM services s
         LEFT JOIN LATERAL (
           SELECT id, granted_at, expires_at, revoked_at, revoked_by FROM obo_read_consents
            WHERE instance_id = $1 AND person_id = $2 AND service_id = s.id
            ORDER BY (revoked_at IS NULL) DESC, granted_at DESC LIMIT 1) x ON true
        WHERE ${READING_SERVICE}
        ORDER BY s.name LIMIT 200`, [app.instanceId, caller.person!.id]);
    return c.json({ mode: oboReadMode(app), items: (rows as ConsentRow[]).map((x) => view(x, false)) });
  });

  // give consent (or extend the live one: the old one is closed, a new one is given for the full term)
  r.post("/api/v1/me/obo-consents", async (c) => {
    const caller = c.get("caller");
    requireWorkplaceSession(caller);
    limit(caller, "me_keys");
    const body = await c.req.json().catch(() => null) as { service_id?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Expected JSON with {service_id}");
    const extra = Object.keys(body).filter((k) => k !== "service_id");
    if (extra.length) throw invalid(`Unexpected fields: ${extra.slice(0, 5).join(", ")}`);
    if (!isUuidParam(body.service_id as string)) throw invalid("service_id — service identifier (uuid)");
    const serviceId = body.service_id as string, person = caller.person!;
    const days = oboConsentDays(app);
    const out = await tx(app.db.control, async (q) => {
      const s = (await q.query(`SELECT s.id, s.name FROM services s WHERE s.id = $2 AND ${READING_SERVICE}`, [app.instanceId, serviceId])).rows[0] as { id: string; name: string } | undefined;
      if (!s) return null;
      // one grant per pair at a time: a second "Allow" in the next tab waits for the first instead of failing on the unique index
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`obo_consent:${app.instanceId}:${person.id}:${s.id}`]);
      const prev = await q.query(
        `UPDATE obo_read_consents SET revoked_at = now(), revoked_by = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'person' END
          WHERE instance_id = $1 AND person_id = $2 AND service_id = $3 AND revoked_at IS NULL RETURNING (expires_at > now()) AS live`,
        [app.instanceId, person.id, s.id]);
      const id = newId();
      const row = (await q.query(
        `INSERT INTO obo_read_consents (id, instance_id, person_id, service_id, granted_at, expires_at, granted_session)
         VALUES ($1, $2, $3, $4, now(), now() + make_interval(days => $5::int), $6)
         RETURNING id, granted_at, expires_at, revoked_at, revoked_by`, [id, app.instanceId, person.id, s.id, days, caller.keyId])).rows[0];
      return { s, row, renewed: prev.rows.some((x: { live: boolean }) => x.live) };
    });
    if (!out) throw notFound();
    const expires = iso(out.row.expires_at);
    await audit(app, caller, { event_type: "admin", details: { op: "obo_consent_grant", service: out.s.id, expires_at: expires, author: person.id, ...(out.renewed ? { renewed: true } : {}) } });
    return c.json(view({ ...out.row, service_id: out.s.id, service_name: out.s.name }, false), 201);
  });

  // revoke my own live consent
  r.delete("/api/v1/me/obo-consents/:id", async (c) => {
    const caller = c.get("caller");
    requireWorkplaceSession(caller);
    limit(caller, "me_keys");
    const id = c.req.param("id");
    if (!isUuidParam(id)) throw notFound();
    const { rows } = await app.db.control.query(
      `UPDATE obo_read_consents SET revoked_at = now(), revoked_by = 'person'
        WHERE id = $1 AND instance_id = $2 AND person_id = $3 AND revoked_at IS NULL RETURNING service_id`, [id, app.instanceId, caller.person!.id]);
    if (!rows.length) throw notFound();
    await audit(app, caller, { event_type: "admin", details: { op: "obo_consent_revoke", service: rows[0].service_id, revoked_by: "person", author: caller.person!.id } });
    return c.body(null, 204);
  });
  return r;
}

/**
 * The service is disabled or no longer reads on behalf (PATCH /services): its live consents are closed in the same
 * transaction as the disabling (revoked_by service_off). Else disable it, re-enable it a minute before the workers' pass with
 * obo_read — and the old consents hold again. The workers' pass (obo_consent_sweep) stays a safeguard. Returns the people
 * whose consents were closed — the caller writes the journal events after the transaction (serviceConsentsClosedAudit).
 */
export async function closeServiceConsents(q: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> }, instanceId: string, serviceId: string): Promise<string[]> {
  const { rows } = await q.query(
    `UPDATE obo_read_consents SET revoked_at = now(), revoked_by = 'service_off'
      WHERE instance_id = $1 AND service_id = $2 AND revoked_at IS NULL RETURNING person_id::text AS person`, [instanceId, serviceId]);
  return (rows as Array<{ person: string }>).map((r) => r.person);
}

/** Events of consents closed by a disabled service — as with the workers' pass: author is the person (their "My actions"). */
export async function serviceConsentsClosedAudit(app: App, caller: Caller, serviceId: string, persons: readonly string[]): Promise<void> {
  for (const person of persons)
    await audit(app, caller, { event_type: "admin", details: { op: "obo_consent_revoke", service: serviceId, revoked_by: "service_off", author: person } });
}

/**
 * The administrator's list: all live ones, closed ones for the last ADMIN_ENDED_DAYS days; by pages (limit, by default and
 * at most ADMIN_LIST_MAX; cursor is the offset from next_cursor). Before, the list was silently cut at 1000 rows, and live
 * consents past them could be neither seen nor revoked.
 */
export const ADMIN_LIST_MAX = 1000;
export const ADMIN_ENDED_DAYS = 90;

/** The admin listener: everyone's consents (/api/v1/admin/obo-consents). The administrator only revokes. */
export function oboConsentAdminRoutes(app: App): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get("/api/v1/admin/obo-consents", async (c) => {
    const limit = intParam(c.req.query("limit"), ADMIN_LIST_MAX, 1, ADMIN_LIST_MAX), offset = offsetCursor(c.req.query("cursor"));
    const { rows } = await app.db.control.query(
      `SELECT x.id, x.service_id, coalesce(s.name, x.service_id::text) AS service_name, p.login, x.granted_at, x.expires_at, x.revoked_at, x.revoked_by
         FROM obo_read_consents x
         LEFT JOIN services s ON s.id = x.service_id
         LEFT JOIN people p ON p.id = x.person_id
        WHERE x.instance_id = $1 AND (x.revoked_at IS NULL OR x.revoked_at > now() - make_interval(days => $2::int))
        ORDER BY (x.revoked_at IS NULL AND x.expires_at > now()) DESC, x.granted_at DESC, x.id
        LIMIT $3 OFFSET $4`, [app.instanceId, ADMIN_ENDED_DAYS, limit + 1, offset]);
    return c.json({ items: (rows as ConsentRow[]).slice(0, limit).map((x) => view(x, true)), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });

  r.delete("/api/v1/admin/obo-consents/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuidParam(id)) throw notFound();
    const { rows } = await app.db.control.query(
      `UPDATE obo_read_consents SET revoked_at = now(), revoked_by = 'admin'
        WHERE id = $1 AND instance_id = $2 AND revoked_at IS NULL RETURNING service_id, person_id`, [id, app.instanceId]);
    if (!rows.length) throw notFound();
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "obo_consent_revoke", service: rows[0].service_id, revoked_by: "admin", author: rows[0].person_id } });
    return c.body(null, 204);
  });
  return r;
}
