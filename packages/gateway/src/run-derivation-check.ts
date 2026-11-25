// A check of the retelling gate on live records of an installation: for the instance's people, their
// spaces T and random live records s, "each reader of T (except the writer) sees s" is counted two ways —
// fast, as in the gate (spaceReaders + spacesOfMany + spaceSeesRow), and by brute force (readableSpaces of each reader with
// the archive + the visibleRow core with its own people list). The org target (a synthetic reader) is not checked by brute force:
// the rule there is stricter by design. Prints one JSON line: counters and mismatches (ids only). Run in the gateway container:
//   docker compose … exec -T gateway node_modules/.bin/tsx packages/gateway/src/run-derivation-check.ts [people=25] [records=200]
import { AnchorsError, Databases, GATEWAY_DB_ROLES, initAnchors, loadServiceSecrets, log, readEnv, SCOPE_T0, Settings, spaceSeesRow, visibleRow, type DataClass, type RowFacts, type VisibilitySpec } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { readableSpaces, spaceReaders, spacesOfMany, type SpaceAccess } from "./access.ts";

const limitPeople = Math.max(1, Number(process.argv[2] ?? 25));
const limitRecords = Math.max(1, Number(process.argv[3] ?? 200));
const env = readEnv();
// the same secret files as the gateway: an incomplete directory stops the job before any database connection
const secrets = loadServiceSecrets(env, GATEWAY_DB_ROLES);
const db = new Databases(env);
const settings = new Settings(db.control, env.instanceId, env.appSecret, secrets.settingsKeyring);
await settings.load(true);
// trust anchors: pinned settings work in a one-off run too — the same as the gateway's;
// the signers file exists but the check failed — the run refuses, as the gateway does
try { await initAnchors({ process: "gateway", db: db.control, audit: db.audit, instanceId: env.instanceId, appSecret: env.appSecret, settings }); }
catch (e) {
  if (e instanceof AnchorsError) { log.error(e.code, { error: e.message.slice(0, 300) }); process.exit(1); }
  throw e;
}
const app = { db, settings, instanceId: env.instanceId } as unknown as App;

type Rec = Omit<RowFacts, "listed"> & { people: string[] };
const out = { people: 0, targets: 0, records: 0, comparisons: 0, sees_true: 0, org_skipped: 0, mismatches: [] as Array<Record<string, unknown>> };

/** Brute force: each reader has its own map with archive and a core with its own people list (recordVisible, no class gate). */
const mapCache = new Map<string, string[]>();
async function bruteSees(readers: readonly string[], r: Rec): Promise<boolean> {
  for (const q of readers) {
    let S = mapCache.get(q);
    if (!S) { S = [...(await readableSpaces(app, { person: { id: q } } as unknown as Caller, { archived: true })).keys()]; mapCache.set(q, S); }
    const spec: VisibilitySpec = { principals: [{ id: q, spaces: S }], asker: q, gate: { open: "all", closed: "all" }, owner: "always" };
    if (!visibleRow(spec, { ...r, listed: r.people.includes(q) ? [q] : [] })) return false;
  }
  return true;
}

try {
  const sample: Rec[] = [];
  for (const cls of ["open", "closed"] as const) {
    const pool = db.records(cls, SCOPE_T0);
    const rows = (await pool.query("SELECT id, owner_id, audience, space_id, class FROM records_live ORDER BY random() LIMIT $1", [limitRecords])).rows as Rec[];
    const ids = rows.map((r) => r.id);
    const byId = new Map(rows.map((r) => [r.id, Object.assign(r, { placed: [] as string[], people: [] as string[] })]));
    for (const p of (await pool.query("SELECT record_id, space_id FROM record_placements WHERE record_id = ANY($1::uuid[])", [ids])).rows) (byId.get(p.record_id)?.placed as string[] | undefined)?.push(p.space_id as string);
    for (const p of (await pool.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [ids])).rows) byId.get(p.record_id)?.people.push(p.person_id);
    sample.push(...rows);
  }
  out.records = sample.length;
  const people = (await db.control.query(
    `SELECT p.id FROM people p WHERE p.instance_id = $1 AND p.active
      ORDER BY (SELECT count(*) FROM space_members m WHERE m.person_id = p.id) DESC, p.login LIMIT $2`, [env.instanceId, limitPeople])).rows as Array<{ id: string }>;
  const candidates = [...new Set(sample.flatMap((r) => [r.space_id, ...r.placed]))];
  for (const person of people) {
    out.people++;
    const targets = [...(await readableSpaces(app, { person: { id: person.id } } as unknown as Caller)).values()] as SpaceAccess[];
    for (const t of targets) {
      out.targets++;
      const readers = await spaceReaders(app, t);
      if (readers.kind === "all_org") { out.org_skipped++; continue; }
      const list = readers.kind === "self" ? (readers.owner && readers.owner !== person.id ? [readers.owner] : []) : readers.ids.filter((p) => p !== person.id);
      const map = await spacesOfMany(app, list, candidates);
      for (const r of sample) {
        // the core gets the source's whole people list — the same as the gate (loadSources)
        const fast = spaceSeesRow(list, { ...r, listed: r.people }, (p) => [...(map.get(p) ?? [])]);
        const brute = await bruteSees(list, r);
        out.comparisons++;
        if (fast) out.sees_true++;
        if (fast !== brute) out.mismatches.push({ person: person.id, space: t.id, record_id: r.id, cls: r.class as DataClass, fast, brute });
      }
    }
  }
  console.log(JSON.stringify({ ...out, mismatches: out.mismatches.slice(0, 50), mismatch_count: out.mismatches.length }));
} finally { await db.close(); }
