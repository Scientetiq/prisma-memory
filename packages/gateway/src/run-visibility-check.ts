// A check of the visibility builder on live records of an installation: for the instance's people, SQL `V(r)` over the record
// bases against JS `visibleRow` over the same rows and facts — the author rules legacy and always, the session gate (T0),
// the extended and personal key, without a filter and with the "in a space" filter. Prints one JSON line: counters and
// mismatches (only ids of records, people and modes — no titles, no text). Run in the gateway container:
//   docker compose … exec -T gateway node_modules/.bin/tsx packages/gateway/src/run-visibility-check.ts [people=25]
import {
  AnchorsError, binder, Databases, GATEWAY_DB_ROLES, initAnchors, loadServiceSecrets, log, readEnv, SCOPE_T0, Settings, visibleRow, visibleSql,
  type AuthorRule, type DataClass, type RowFacts, type VisibilitySpec,
} from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { readableSpaces } from "./access.ts";
import { classGate } from "./visibility.ts";

const limitPeople = Math.max(1, Number(process.argv[2] ?? 25));
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
const out = { people: 0, records: 0, comparisons: 0, sql_queries: 0, visible_total: 0, cell4_always: 0, mismatches: [] as Array<Record<string, unknown>> };
try {
  // the facts of all live records of both bases in one pass — the system (T0), as the worker job; only ids go out
  const recs = new Map<DataClass, Rec[]>();
  for (const cls of ["open", "closed"] as const) {
    const pool = db.records(cls, SCOPE_T0);
    const rows = (await pool.query("SELECT id, owner_id, audience, space_id, class FROM records_live")).rows as Rec[];
    const byId = new Map(rows.map((r) => [r.id, Object.assign(r, { placed: [] as string[], people: [] as string[] })]));
    for (const p of (await pool.query("SELECT record_id, space_id FROM record_placements")).rows) (byId.get(p.record_id)?.placed as string[] | undefined)?.push(p.space_id as string);
    for (const p of (await pool.query("SELECT record_id, person_id FROM record_people")).rows) byId.get(p.record_id)?.people.push(p.person_id);
    for (const r of rows) if (r.class !== cls) out.mismatches.push({ record_id: r.id, why: "the row’s class differs from the database class", db: cls });
    recs.set(cls, rows);
    out.records += rows.length;
  }
  // people: first those who have records or are on people lists — the author rule and RP are checked on them for real
  const people = (await db.control.query(
    `SELECT p.id, p.login, COALESCE(p.attrs->>'demo','') = 'true' AS demo FROM people p
      WHERE p.instance_id = $1 AND p.active ORDER BY (SELECT count(*) FROM record_locations l WHERE l.owner_id = p.id AND NOT l.deleted) DESC, p.login LIMIT $2`,
    [env.instanceId, limitPeople])).rows as Array<{ id: string; login: string; demo: boolean }>;
  for (const person of people) {
    out.people++;
    const spaces = await readableSpaces(app, { person: { id: person.id } } as unknown as Caller);
    const S = [...spaces.keys()];
    const team = [...spaces.values()].find((s) => s.kind !== "personal");
    for (const [keyKind, tier] of [["session", "T0"], ["extended", "T2"], ["personal", "T2"]] as const) {
      const classes: DataClass[] = keyKind === "personal" ? ["open"] : ["open", "closed"];
      const gate = classGate({ classes }, keyKind);
      for (const owner of ["legacy", "always"] as AuthorRule[]) for (const scope of [null, team ? [team.id] : []]) {
        const spec: VisibilitySpec = { principals: [{ id: person.id, spaces: S }], asker: person.id, gate, owner, scope };
        for (const cls of ["open", "closed"] as const) {
          const args: unknown[] = [];
          const v = visibleSql(spec, cls, binder(args));
          const rows = recs.get(cls)!;
          const js = new Set(rows.filter((r) => visibleRow(spec, { ...r, listed: r.people.includes(person.id) ? [person.id] : [] })).map((r) => r.id));
          if (v === null) {                                          // gate none: the class is not queried — JS is empty too
            if (js.size) out.mismatches.push({ person: person.id, key: keyKind, tier, owner, cls, why: "the gate is none, but JS found visible records", n: js.size });
            continue;
          }
          const sql = new Set((await db.records(cls, SCOPE_T0).query(`SELECT r.id FROM records_live r WHERE ${v}`, args)).rows.map((x) => x.id as string));
          out.sql_queries++;
          out.comparisons += rows.length;
          out.visible_total += sql.size;
          for (const id of sql) if (!js.has(id)) out.mismatches.push({ person: person.id, key: keyKind, owner, cls, scoped: scope !== null, record_id: id, sql: true, js: false });
          for (const id of js) if (!sql.has(id)) out.mismatches.push({ person: person.id, key: keyKind, owner, cls, scoped: scope !== null, record_id: id, sql: false, js: true });
          if (owner === "always" && scope === null && keyKind === "session")
            out.cell4_always += rows.filter((r) => r.owner_id === person.id && r.audience === "space" && !S.includes(r.space_id) && !r.placed.some((s) => S.includes(s)) && !r.people.includes(person.id)).length;   // vis-ok: cell 4 count for the check report
        }
      }
    }
  }
  console.log(JSON.stringify({ ...out, mismatches: out.mismatches.slice(0, 50), mismatch_count: out.mismatches.length }));
} finally { await db.close(); }
