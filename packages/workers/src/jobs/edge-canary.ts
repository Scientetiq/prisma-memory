// Edge canaries: bait records that must never get outside under any conditions. Set by a panel button
// (the gateway writes a request into maintenance_state.edge_canary_request) and when export is first switched
// on (edge.export_enabled, with no canaries standing). Six kinds:
//   - three closed: personal closed of the service person, team closed of the service space edge-canary, a meeting;
//   - one hidden open (hidden_at set);
//   - two in transit: a closed one with a contract-number-like marker and a show request the check will refuse;
//     a HELD document (the fallback check failed).
// Each holds a random marker CANARY-<32 hex>; marker and id are in edge_canaries (memory_control) before the record:
// the export gate sees a canary from the first minute. Markers go to neither the process log nor audit; to the bridge
// they ship with the anchors (/etc/memory-bridge/canaries.json), not from memory. Old ones retire (retired_at); their
// records stay: a bait id must not appear at the edge after a swap either.
//
// The service person is a demo persona without sign-in: no org-table cards, no leavers job, no people
// lists take it. So bait records are also held by gate condition 9 (demo owner): a canary catches any gate bypass
// (an export past generation issue, foreign batch rows, a serialization fault), not one condition's slip.
import { randomBytes } from "node:crypto";
import { log, newId, tx, watchLock } from "@memory/shared";
import { auditWorker, recordsDb, type DbCtx } from "../ctx.ts";

export const CANARY_KINDS = ["closed_personal", "closed_team", "closed_meeting", "hidden_open", "transitional_nda", "transitional_held"] as const;
export type CanaryKind = (typeof CANARY_KINDS)[number];
/** Gateway panel request {requested_at}. */
export const CANARY_REQUEST_KEY = "edge_canary_request";
/** Worker outcome {created_at, request_done_at, active}: only times and a count, no markers. */
export const CANARY_STATE_KEY = "edge_canary";
export const CANARY_LOGIN = "edge-canary@memory.invalid";
export const CANARY_TEAM_SLUG = "edge-canary";
export const CANARY_PERSONAL_SLUG = "edge-canary-me";
export const CANARY_EVERY_MS = 60_000;
const LOCK = "edge_canary";

interface Plan { kind: CanaryKind; cls: "open" | "closed"; space: "personal" | "team"; type: "note" | "transcript" | "document"; hidden?: boolean; attrs?: Record<string, unknown>; move?: boolean }
const PLANS: readonly Plan[] = [
  { kind: "closed_personal", cls: "closed", space: "personal", type: "note" },
  { kind: "closed_team", cls: "closed", space: "team", type: "note" },
  { kind: "closed_meeting", cls: "closed", space: "team", type: "transcript" },
  { kind: "hidden_open", cls: "open", space: "team", type: "note", hidden: true },
  { kind: "transitional_nda", cls: "closed", space: "team", type: "note", move: true },
  { kind: "transitional_held", cls: "open", space: "team", type: "document", attrs: { conversion: { status: "done", error_kind: "open_check_fallback_failed" } } },
];

export const newMarker = (): string => `CANARY-${randomBytes(16).toString("hex")}`;

/** Bait record text: a marker and (for in-transit with NDA) a contract-number-like line the open check will not pass. */
export function canaryText(kind: CanaryKind, marker: string): string {
  const lines = [`# Service record: edge canary (${kind})`, "", "This record must not appear outside the inner perimeter. If you see it in the external copy, turn off export.", "", `Marker: ${marker}`];
  if (kind === "transitional_nda") lines.push("", "Under contract No. 47-18/2026-K dated 2026-03-12 the payment term is 30 days.");
  return lines.join("\n");
}

/** The service person and its two spaces: made once, then taken as they are. */
export async function canaryOwner(ctx: DbCtx): Promise<{ person: string; personal: string; team: string }> {
  const c = ctx.db.control;
  let person = (await c.query("SELECT id FROM people WHERE login = $1", [CANARY_LOGIN])).rows[0]?.id as string | undefined;
  if (!person) {
    person = newId();
    await c.query(`INSERT INTO people (id, login, display_name, instance_id, active, attrs) VALUES ($1, $2, $3, $4, true, $5)
                   ON CONFLICT (login) DO NOTHING`, [person, CANARY_LOGIN, "Service account: Edge canaries", ctx.instanceId, { demo: "true", service: "edge_canary" }]);
    person = (await c.query("SELECT id FROM people WHERE login = $1", [CANARY_LOGIN])).rows[0].id as string;
  }
  const space = async (slug: string, kind: "personal" | "team", name: string): Promise<string> => {
    const have = (await c.query("SELECT id FROM spaces WHERE slug = $1", [slug])).rows[0]?.id as string | undefined;
    if (have) return have;
    await c.query(`INSERT INTO spaces (id, slug, kind, name, owner_id, instance_id, default_class) VALUES ($1, $2, $3, $4, $5, $6, 'closed')
                   ON CONFLICT (slug) DO NOTHING`, [newId(), slug, kind, name, person, ctx.instanceId]);
    return (await c.query("SELECT id FROM spaces WHERE slug = $1", [slug])).rows[0].id as string;
  };
  const personal = (await c.query("SELECT id FROM spaces WHERE kind = 'personal' AND owner_id = $1", [person])).rows[0]?.id as string | undefined
    ?? await space(CANARY_PERSONAL_SLUG, "personal", "Edge canaries — personal space");
  const team = await space(CANARY_TEAM_SLUG, "team", "Edge canaries");
  await c.query("INSERT INTO space_members (space_id, person_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [team, person]);
  return { person, personal, team };
}

/** Retire the old ones and set six new. Returns the numbers retired and set; never gives markers out. */
export async function createCanaries(ctx: DbCtx): Promise<{ created: number; retired: number; ids: string[] }> {
  const owner = await canaryOwner(ctx);
  const retired = (await ctx.db.control.query("UPDATE edge_canaries SET retired_at = now() WHERE retired_at IS NULL")).rowCount ?? 0;
  const ids: string[] = [];
  for (const p of PLANS) {
    const id = newId(), marker = newMarker();
    const spaceId = p.space === "personal" ? owner.personal : owner.team;
    // first the canary mark (the gate sees it before the record), then locator, then record row
    await ctx.db.control.query("INSERT INTO edge_canaries (record_id, kind, marker) VALUES ($1, $2, $3)", [id, p.kind, marker]);
    await ctx.db.control.query("INSERT INTO record_locations (record_id, class, space_id, type, owner_id) VALUES ($1, $2, $3, $4, $5)",
      [id, p.cls, spaceId, p.type, owner.person]);
    await tx(recordsDb(ctx, p.cls), async (c) => {
      await c.query(
        `INSERT INTO records (id, type, class, space_id, audience, owner_id, source_kind, method, origin, occurred_at, title, processor, attrs, hidden_at)
         VALUES ($1, $2, $3, $4, 'space', $5, 'pipeline', 'source_document', 'agent', now(), $6, '{"job":"edge_canary"}', $7, $8)`,
        [id, p.type, p.cls, spaceId, owner.person, `Edge canary: ${p.kind}`, p.attrs ?? {}, p.hidden ? new Date() : null]);
      await c.query("INSERT INTO record_content (record_id, text) VALUES ($1, $2)", [id, canaryText(p.kind, marker)]);
    });
    // a show request: a move to open by the usual worker path; the open check will refuse it by the contract line
    if (p.move) await ctx.db.control.query("INSERT INTO class_moves (record_id, from_class, to_class, requested_by) VALUES ($1, 'closed', 'open', $2)", [id, owner.person]);
    ids.push(id);
  }
  await auditWorker(ctx, { event_type: "admin", record_ids: ids, details: { job: "edge_canary", created: ids.length, retired } });
  log.info("edge_canary_created", { created: ids.length, retired });
  return { created: ids.length, retired, ids };
}

const state = async (ctx: DbCtx, key: string): Promise<Record<string, unknown>> =>
  ((await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, key])).rows[0]?.value ?? {}) as Record<string, unknown>;

/** Are canaries needed now: an unhandled panel request, or export on with no canaries standing. */
export async function canaryDue(ctx: DbCtx): Promise<"request" | "first_enable" | null> {
  const req = await state(ctx, CANARY_REQUEST_KEY), done = await state(ctx, CANARY_STATE_KEY);
  const asked = typeof req.requested_at === "string" ? Date.parse(req.requested_at) : NaN;
  const handled = typeof done.request_done_at === "string" ? Date.parse(done.request_done_at) : -Infinity;
  if (Number.isFinite(asked) && asked > handled) return "request";
  if (ctx.settings.get<boolean>("edge.export_enabled", false) !== true) return null;
  const active = Number((await ctx.db.control.query("SELECT count(*)::int AS n FROM edge_canaries WHERE retired_at IS NULL")).rows[0]?.n ?? 0);
  return active ? null : "first_enable";
}

/** One pass, under the instance lock (no second worker or run-job sets canaries twice). */
export async function edgeCanaryTick(ctx: DbCtx): Promise<"request" | "first_enable" | null> {
  const due = await canaryDue(ctx);
  if (!due) return null;
  const c = await ctx.db.control.connect();
  let watch: ReturnType<typeof watchLock> | undefined;
  try {
    const got = (await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`${LOCK}:${ctx.instanceId}`])).rows[0]?.ok === true;
    if (!got) return null;
    watch = watchLock(c);
    try {
      if ((await canaryDue(ctx)) !== due) return null;
      const req = await state(ctx, CANARY_REQUEST_KEY);
      await watch.alive();
      const out = await createCanaries(ctx);
      const value = { created_at: new Date().toISOString(), request_done_at: typeof req.requested_at === "string" ? req.requested_at : null, active: out.created, why: due };
      await watch.alive();
      await ctx.db.control.query(
        `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, CANARY_STATE_KEY, JSON.stringify(value)]);
      return due;
    } finally {
      if (!watch.lost())
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`${LOCK}:${ctx.instanceId}`]).catch(() => undefined);
    }
  } finally {
    const lost = watch?.lost();
    try {
      if (lost) log.warn("lock_connection_lost", { job: "edge_canary" });
    } finally {
      watch?.done();
      if (lost) c.release(true);
      else c.release();
    }
  }
}

/** Worker registration: a pass a minute and at start; passes never overlap; a failure only goes to the log. */
export function registerEdgeCanary(ctx: DbCtx, everyMs = CANARY_EVERY_MS): () => void {
  let run: Promise<unknown> = Promise.resolve();
  const tick = (): void => {
    run = run.catch(() => undefined).then(() => edgeCanaryTick(ctx))
      // error code only: a DB refusal text may carry a key value — the canary marker
      .catch((e) => log.warn("edge_canary_failed", { code: String((e as { code?: unknown }).code ?? "error").slice(0, 16) }));
  };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  tick();
  return () => clearInterval(t);
}
