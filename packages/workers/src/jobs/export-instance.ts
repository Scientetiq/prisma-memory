// Whole-instance memory export by the server operator: the worker job export_instance
// writes every record of both class databases — previous versions too, not the trash — with their originals into one
// archive of the open format prisma-memory-export/1 (contracts/export/), on the same engine as the space export of the
// workplace. It is not reachable over HTTP: only a person with shell access to the workers container starts it, which is
// the trust of a database dump.
//
// It writes the records hidden from everyone at that moment too (mid class move, or held back after a failed check —
// convert.ts leaves such a document hidden until an administrator retries): the system scope has no visibility rule to
// respect, so each record is written once — a visible copy first, else the copy of the class its location names — and
// marked `hidden: true` in its JSON.
//
// The order of the steps is the security property:
//   1. arguments, strictly (--out <dir> required; --space <slug>; --no-originals);
//   2. the directory: an existing directory inside MEMORY_EXPORT_DIR after resolving symbolic links; the archive name and
//      its ".partial" name must not exist in any form;
//   3. the spaces to export, from the control database only;
//   — a refusal so far writes nothing: no record database was read, no file was created, no event was written —
//   4. the start event in the audit log, strictly (the log refuses — the job stops without reading a record);
//   5. a high alert for the security auditor, right after the start event (an export killed half-way stays visible);
//   6. the ".partial" file, created with O_CREAT|O_EXCL|O_NOFOLLOW and mode 0600 (nothing is overwritten, a symbolic link
//      is never followed), checked again after it is open (a file found elsewhere — the directory was swapped — is removed);
//   — a refusal from here on comes after the start event and the alert, still before any record is read —
//   7. the stream, with its byte count and SHA-256;
//   8. a complete archive gets its final name by a hard link (a rename would overwrite a file created meanwhile); an
//      incomplete one is removed — only the file this run created;
//   9. the closing event with the numbers (never record ids, titles, logins or file names of originals).
// The archive is plain data at rest: the result says so (export.at_rest_notice) and the README of the archive repeats it.
import { createHash } from "node:crypto";
import { constants as FS, lstatSync, promises as fsp, realpathSync, statSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  EXPORT_FORMAT, EXPORT_ROW_SQL, ExportAbort, exportArchive, exportMessage, exportRecordOf, instanceArchiveFileName, loadExportRelations, log, newId, raiseAlert,
  s3GetStream, s3Size, type DataClass, type ExportItem, type ExportOriginalSource, type ExportResult, type ExportRow, type ExportSkipped,
} from "@memory/shared";
import { auditWorker, auditWorkerStrict, recordsDb } from "../ctx.ts";
import type { PurgeCtx } from "./maintenance.ts";

/** Where archives may be written when MEMORY_EXPORT_DIR is not set (a deployment mount of the workers container). */
export const EXPORT_DIR_DEFAULT = "/var/lib/memory/exports";
/** Records per batch: one id query in primary-key order, then their rows. */
export const INSTANCE_EXPORT_BATCH = 500;
/** Texts read from the database at a time inside a batch (a text may be large). */
const TEXT_CHUNK = 20;
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
/** Page size of the closing sweep over the ids of a class database (ids only). */
const SWEEP_PAGE = 5000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Why the job did not start; each code has the English text export.job.<code>. */
export type InstanceExportRefusal =
  | "bad_args" | "out_required" | "export_dir_invalid" | "out_not_directory" | "out_outside_export_dir" | "out_exists" | "out_refused"
  | "space_not_found" | "audit_unavailable" | "alert_unavailable";

export type InstanceExportResult =
  | { refused: InstanceExportRefusal; message: string }
  | {
      complete: boolean; reason: string | null; run: string; file: string | null; sha256: string | null; bytes: number;
      spaces: number; records: number; originals: number; original_bytes: number; skipped: ExportSkipped; notice: string;
      /** Incomplete only: id of the record being written when the archive stopped (null — it stopped between records). */
      stopped_at: string | null;
    };

class Refusal extends Error {
  constructor(readonly code: InstanceExportRefusal) { super(code); }
}
const refused = (code: InstanceExportRefusal): InstanceExportResult => ({ refused: code, message: exportMessage(`export.job.${code}`) });

export interface InstanceExportArgs { out: string; space: string | null; originals: boolean }

/** The arguments of export_instance; an unknown or repeated flag, or a value that looks like a flag, is a refusal. */
export function parseInstanceExportArgs(args: string[]): InstanceExportArgs | { refused: "bad_args" | "out_required" } {
  let out: string | null = null, space: string | null = null, noOriginals = false;
  const value = (i: number): string | null => { const v = args[i + 1]; return v === undefined || v === "" || v.startsWith("--") ? null : v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") {
      const v = value(i);
      if (out !== null || v === null) return { refused: "bad_args" };
      out = v; i++;
    } else if (a === "--space") {
      const v = value(i);
      if (space !== null || v === null || !SLUG.test(v)) return { refused: "bad_args" };
      space = v; i++;
    } else if (a === "--no-originals") {
      if (noOriginals) return { refused: "bad_args" };
      noOriginals = true;
    } else return { refused: "bad_args" };
  }
  if (out === null) return { refused: "out_required" };
  return { out, space, originals: !noOriginals };
}

/**
 * The directory an archive goes to: `out` resolved (symbolic links too) must be an existing directory equal to or below
 * the resolved `exportDir`, which itself must be an absolute path to an existing directory other than the file-system
 * root. Throws a refusal; returns the resolved directory.
 */
export function resolveExportOut(exportDir: string, out: string): string {
  if (!exportDir || !isAbsolute(exportDir)) throw new Refusal("export_dir_invalid");
  let base: string;
  try { base = realpathSync(exportDir); } catch { throw new Refusal("export_dir_invalid"); }
  if (base === parsePath(base).root || !statSync(base).isDirectory()) throw new Refusal("export_dir_invalid");
  let dir: string;
  try { dir = realpathSync(resolve(out)); } catch { throw new Refusal("out_not_directory"); }
  if (!statSync(dir).isDirectory()) throw new Refusal("out_not_directory");
  if (dir !== base && !dir.startsWith(base + sep)) throw new Refusal("out_outside_export_dir");
  return dir;
}

/** Whether a name exists in any form (file, directory, symbolic link — also one that points nowhere). */
const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
const sameFile = (a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">): boolean => a.dev === b.dev && a.ino === b.ino;
/** Remove `p` only if it is still the file this run created. */
async function removeOwn(p: string, own: Pick<Stats, "dev" | "ino">): Promise<void> {
  try { if (sameFile(await fsp.lstat(p), own)) await fsp.unlink(p); } catch { /* gone already, or not ours: left alone */ }
}

interface SpaceRow {
  id: string; slug: string; name: string; kind: string; default_class: string; description: string | null;
  created_at: Date | null; archived_at: Date | null; owner: string | null;
}

const SPACES_SQL = `SELECT s.id, s.slug, s.name, s.kind, s.default_class, s.description, s.created_at, s.archived_at, p.login AS owner
                      FROM spaces s LEFT JOIN people p ON p.id = s.owner_id WHERE s.instance_id = $1`;

interface SourceOpts {
  /** Only this space (its id); null — the whole instance. */
  spaceId: string | null;
  originals: boolean;
  skipped: ExportSkipped;
  run: string;
  /** Set by the source: id of the record handed to the engine and not finished yet (where an incomplete archive stopped). */
  current?: string | null;
}

const missingOk = (e: { code?: unknown }): null => { if (e?.code === "NoSuchKey" || e?.code === "NotFound") return null; throw e; };

/**
 * The original of a row, read from storage when the engine reaches it; with --no-originals it is never opened. The size
 * comes from storage (a stat before the stream): the file is written exactly as stored, also when the record says another
 * size or none (a server log line names the record) and also above today's upload limit — the system scope reads every
 * file as a stream, never whole into memory. An open record's file not found in the open bucket is looked for in the
 * closed one (the open-check fallback moves it there under the same key).
 */
function originalOf(ctx: PurgeCtx, r: ExportRow, o: SourceOpts): ExportOriginalSource | null {
  if (!r.original_key) return null;
  const meta = { name: typeof r.attrs?.filename === "string" ? r.attrs.filename : null, mime: r.original_mime, pages: r.pages, duration_sec: r.duration_sec };
  if (!o.originals) {
    o.skipped.originals_excluded = (o.skipped.originals_excluded ?? 0) + 1;
    return { ...meta, withheld: "excluded", open: async () => null };
  }
  const key = r.original_key;
  // an open record shown to agents "as text only" keeps its file in the closed bucket
  const bucket: DataClass = r.class === "open" && r.attrs?.original_closed === true ? "closed" : r.class;
  const known = r.original_bytes === null || r.original_bytes === undefined ? null : Number(r.original_bytes);
  const buckets: DataClass[] = bucket === "open" ? ["open", "closed"] : ["closed"];
  return {
    ...meta,
    open: async () => {
      for (const b of buckets) {
        const t = ctx.s3(b);
        if (!t) continue;
        const size = await s3Size(t, key).catch(missingOk);
        if (size === null || !Number.isSafeInteger(size) || size < 0) continue;
        const s: Readable | null = await s3GetStream(t, key).catch(missingOk);
        if (!s) continue;
        if (known !== size) log.warn("instance_export_original_size_differs", { run: o.run, record_id: r.id, stored: size, recorded: known });
        return { bytes: size, body: s };
      }
      return null;
    },
  };
}

/**
 * The source of the whole-instance export: every space first, then the records in id order over each whole class
 * database (one primary-key walk, not one per space) — the open database, the closed one, then the open one again for
 * records that moved there meanwhile; each record once (`moved` — the later copy in the closed pass, as the space export
 * counts it). Then a closing sweep over the ids of both databases writes every live row no pass wrote: hidden from
 * everyone (mid class move, held back) — or hidden only while its pass went by, or hidden after the pass took its snapshot
 * of hidden rows. A visible copy is written first; a record hidden in one database is written from it, one hidden in both
 * from the class of its location (record_locations; none — the open copy), marked `hidden`; a record not found where it
 * was seen (its move finished meanwhile) is looked for in the other database before it is counted. Not in the archive and
 * counted: rows deleted before they were read (`gone`), rows whose space is not one of this instance (`no_space`).
 * Previous versions are in, the trash is not. No per-batch audit events: this is the system scope — the start event and
 * the alert are the record of it.
 */
export function instanceExportSource(ctx: PurgeCtx, spaces: SpaceRow[], o: SourceOpts): AsyncGenerator<ExportItem> {
  const add = (k: string, n: number) => { if (n > 0) o.skipped[k] = (o.skipped[k] ?? 0) + n; };
  const bySpace = new Map(spaces.map((s) => [s.id, s]));
  const people = new Map<string, string | null>();
  const written = new Set<string>(), gone = new Set<string>(), noSpace = new Set<string>();
  const hiddenIn = new Map<string, Set<DataClass>>();
  const passes: Array<{ cls: DataClass }> = [{ cls: "open" }, { cls: "closed" }, { cls: "open" }];
  const scopeSql = o.spaceId ? " AND r.space_id = $2::uuid" : "";
  const scopeArgs = o.spaceId ? [o.spaceId] : [];
  const logins = async (ids: Iterable<string>): Promise<void> => {
    const want = [...new Set(ids)].filter((id) => !people.has(id));
    if (!want.length) return;
    for (const p of (await ctx.db.control.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [want])).rows) people.set(p.id, p.login);
    for (const id of want) if (!people.has(id)) people.set(id, null);
  };
  /** The records `ids` of class database `cls` (not yet written): visible rows only, or any live row (the hidden pass). */
  async function* emit(cls: DataClass, ids: string[], visibleOnly: boolean): AsyncGenerator<ExportItem> {
    const db = recordsDb(ctx, cls);
    const vis = visibleOnly ? " AND r.hidden_at IS NULL" : "";
    const all = (await db.query(`SELECT ${EXPORT_ROW_SQL}, r.hidden_at IS NOT NULL AS hidden_now FROM records r LEFT JOIN record_content c ON c.record_id = r.id
                                   WHERE r.id = ANY($1::uuid[]) AND r.deleted_at IS NULL${vis}${scopeSql} ORDER BY r.id`, [ids, ...scopeArgs])).rows as Array<ExportRow & { hidden_now: boolean }>;
    const present = new Set(all.map((r) => r.id));
    for (const id of ids) if (!present.has(id)) gone.add(id);
    const rows = all.filter((r) => { if (bySpace.has(r.space_id)) return true; noSpace.add(r.id); return false; });
    if (!rows.length) return;
    const got = rows.map((r) => r.id);
    const rel = await loadExportRelations(db, ctx.db.control, got);
    await logins([...rows.map((r) => r.owner_id), ...[...rel.listed.values()].flat()]);
    // derived records of the system scope: hidden ones too — they are in the archive as well
    const derived = new Map<string, string[]>();
    for (const x of (await db.query(`SELECT r.parent_id, r.id FROM records r WHERE r.parent_id = ANY($1::uuid[]) AND r.deleted_at IS NULL${scopeSql}
                                      ORDER BY r.id`, [got, ...scopeArgs])).rows)
      (derived.get(x.parent_id) ?? derived.set(x.parent_id, []).get(x.parent_id)!).push(x.id);
    for (let i = 0; i < rows.length; i += TEXT_CHUNK) {
      const chunk = rows.slice(i, i + TEXT_CHUNK);
      const texts = new Map<string, string>();
      for (const t of (await db.query("SELECT record_id, text FROM record_content WHERE record_id = ANY($1::uuid[])", [chunk.map((r) => r.id)])).rows) texts.set(t.record_id, t.text);
      for (const r of chunk) {
        if (written.has(r.id)) continue;
        const record = exportRecordOf(r, bySpace.get(r.space_id)!.slug, rel, derived.get(r.id) ?? [], people);
        if (r.hidden_now === true) record.hidden = true;
        const original = originalOf(ctx, r, o);
        written.add(r.id);
        o.current = r.id;
        yield { kind: "record", record, text: texts.get(r.id) ?? null, original };
        o.current = null;
      }
    }
  }
  return (async function* () {
    try {
      for (const s of spaces) {
        yield { kind: "space", space: { slug: s.slug, name: s.name, kind: s.kind, default_class: s.default_class, description: s.description,
                                        created_at: s.created_at, owner: s.owner, archived_at: s.archived_at }, scope: { space: s.slug } };
      }
      for (const { cls } of passes) {
        const db = recordsDb(ctx, cls);
        for (const x of (await db.query(`SELECT r.id FROM records r WHERE r.deleted_at IS NULL AND r.hidden_at IS NOT NULL${o.spaceId ? " AND r.space_id = $1::uuid" : ""}`, scopeArgs)).rows)
          (hiddenIn.get(x.id) ?? hiddenIn.set(x.id, new Set()).get(x.id)!).add(cls);
        let after = ZERO_ID;
        for (;;) {
          const listed = (await db.query(`SELECT r.id FROM records r WHERE r.deleted_at IS NULL AND r.hidden_at IS NULL AND r.id > $1::uuid${scopeSql}
                                           ORDER BY r.id LIMIT ${INSTANCE_EXPORT_BATCH}`, [after, ...scopeArgs])).rows.map((x) => x.id as string);
          if (!listed.length) break;
          after = listed[listed.length - 1]!;
          const ids = listed.filter((id) => !written.has(id));
          if (cls === "closed") add("moved", listed.length - ids.length);
          if (ids.length) yield* emit(cls, ids, true);
        }
      }
      // the closing sweep: every live row of both databases that no pass wrote — class → whether that copy is visible
      const live = new Map<string, Map<DataClass, boolean>>();
      for (const cls of ["open", "closed"] as const) {
        const db = recordsDb(ctx, cls);
        let after = ZERO_ID;
        for (;;) {
          const page = (await db.query(`SELECT r.id, r.hidden_at IS NULL AS visible FROM records r WHERE r.deleted_at IS NULL AND r.id > $1::uuid${scopeSql}
                                         ORDER BY r.id LIMIT ${SWEEP_PAGE}`, [after, ...scopeArgs])).rows as Array<{ id: string; visible: boolean }>;
          for (const x of page) if (!written.has(x.id) && !noSpace.has(x.id)) (live.get(x.id) ?? live.set(x.id, new Map()).get(x.id)!).set(cls, x.visible === true);
          if (page.length < SWEEP_PAGE) break;
          after = page[page.length - 1]!.id;
        }
      }
      // where each record left out is written from: a visible copy; the only copy; both hidden — its location's class.
      // Rows hidden at a pass's start and gone since are tried where they were seen (and counted as gone there).
      const seen = new Map<string, Set<DataClass>>();
      for (const [id, c] of live) seen.set(id, new Set(c.keys()));
      for (const [id, c] of hiddenIn) if (!written.has(id) && !live.has(id)) seen.set(id, c);
      const twice = [...seen].filter(([id, c]) => c.size > 1 && ![...(live.get(id)?.values() ?? [])].some((v) => v)).map(([id]) => id);
      const home = new Map<string, DataClass>();
      for (let i = 0; i < twice.length; i += INSTANCE_EXPORT_BATCH)
        for (const x of (await ctx.db.control.query("SELECT record_id, class FROM record_locations WHERE record_id = ANY($1::uuid[])", [twice.slice(i, i + INSTANCE_EXPORT_BATCH)])).rows)
          home.set(x.record_id, x.class);
      const from = new Map<string, DataClass>();
      for (const [id, c] of seen) {
        const visible = [...(live.get(id) ?? new Map<DataClass, boolean>())].filter(([, v]) => v).map(([k]) => k);
        from.set(id, visible.length === 1 ? visible[0]! : c.size === 1 ? [...c][0]! : (home.get(id) ?? "open"));
      }
      const writeFrom = async function* (pick: (id: string) => DataClass | null): AsyncGenerator<ExportItem> {
        for (const cls of ["open", "closed"] as const) {
          const ids = [...from.keys()].filter((id) => !written.has(id) && pick(id) === cls).sort();
          for (let i = 0; i < ids.length; i += INSTANCE_EXPORT_BATCH) yield* emit(cls, ids.slice(i, i + INSTANCE_EXPORT_BATCH), false);
        }
      };
      yield* writeFrom((id) => from.get(id) ?? null);
      // not found where it was seen: its move finished meanwhile — the copy in the other database (any live row)
      yield* writeFrom((id) => (gone.has(id) ? (from.get(id) === "open" ? "closed" : "open") : null));
      // what is not in the archive after all: a record deleted here may have been written under its other class
      add("gone", [...gone].filter((id) => !written.has(id)).length);
      add("no_space", [...noSpace].filter((id) => !written.has(id)).length);
    } catch (e) {
      if (!(e instanceof ExportAbort)) log.error("instance_export_failed", { run: o.run, error: ((e as Error)?.message ?? String(e)).slice(0, 300) });
      throw e;
    }
  })();
}

/** Write all of `chunk` (a regular file may take it in parts). */
async function writeAll(fh: fsp.FileHandle, chunk: Buffer): Promise<void> {
  let off = 0;
  while (off < chunk.length) off += (await fh.write(chunk, off, chunk.length - off)).bytesWritten;
}

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Give a complete `.partial` its final name without ever replacing a file: a hard link (fails when the name exists),
 * then the `.partial` name goes. Where the file system has no hard links: create the final name exclusively first,
 * then rename onto that empty file of our own. Returns null, or the refusal code.
 */
async function publish(partial: string, final: string, own: Pick<Stats, "dev" | "ino">): Promise<"out_exists" | "out_refused" | null> {
  try {
    await fsp.link(partial, final);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "EEXIST") return "out_exists";
    if (!LINK_UNSUPPORTED.has(code)) return "out_refused";
    let placeholder: fsp.FileHandle;
    try { placeholder = await fsp.open(final, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600); }
    catch (e2) { return (e2 as { code?: string }).code === "EEXIST" ? "out_exists" : "out_refused"; }
    let mark: Stats | null = null;
    try {
      mark = await placeholder.stat();
      await placeholder.close();
      if (!sameFile(await fsp.lstat(partial), own)) { await removeOwn(final, mark); return "out_refused"; }
      await fsp.rename(partial, final);
      return null;
    } catch {
      // an incomplete step never leaves our empty placeholder under the final name
      await placeholder.close().catch(() => undefined);
      if (mark) await removeOwn(final, mark);
      return "out_refused";
    }
  }
  // the name we linked must be our file (the .partial name was not swapped between the close and the link)
  if (!sameFile(await fsp.lstat(final), own)) { await fsp.unlink(final).catch(() => undefined); return "out_refused"; }
  await removeOwn(partial, own);
  return null;
}

/**
 * The job export_instance: `run-job.ts export_instance --out <dir> [--space <slug>] [--no-originals]`. `deps` — for
 * tests: the allowed directory instead of MEMORY_EXPORT_DIR, a stop signal (run-job.ts wires SIGTERM and SIGINT), the
 * clock of the archive name.
 */
export async function exportInstance(ctx: PurgeCtx, args: string[], deps: { exportDir?: string; signal?: AbortSignal; now?: () => Date } = {}): Promise<InstanceExportResult> {
  const now = deps.now ?? (() => new Date());
  const exportDir = deps.exportDir ?? (process.env.MEMORY_EXPORT_DIR || EXPORT_DIR_DEFAULT);
  // 1–3: nothing is read from the record databases and nothing is written before these pass
  const parsed = parseInstanceExportArgs(args);
  if ("refused" in parsed) return refused(parsed.refused);
  let dir: string;
  try { dir = resolveExportOut(exportDir, parsed.out); }
  catch (e) { if (e instanceof Refusal) return refused(e.code); throw e; }
  const final = join(dir, instanceArchiveFileName(ctx.instanceId, now()));
  const partial = `${final}.partial`;
  if (exists(final) || exists(partial)) return refused("out_exists");
  const spaces = (await ctx.db.control.query(`${SPACES_SQL}${parsed.space ? " AND s.slug = $2" : ""} ORDER BY s.slug`,
                                              parsed.space ? [ctx.instanceId, parsed.space] : [ctx.instanceId])).rows as SpaceRow[];
  if (parsed.space && !spaces.length) return refused("space_not_found");
  const spaceId = parsed.space ? spaces[0]!.id : null;

  // 4. the start event, strictly: without it no record is read
  const run = newId();
  const facts = { run, out_dir: dir, space: parsed.space, originals: parsed.originals };
  try { await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "instance_export_started", ...facts, format: EXPORT_FORMAT } }); }
  catch { return refused("audit_unavailable"); }
  const done = (o: { file: string | null; records?: number; originals?: number; original_bytes?: number; bytes?: number; sha256?: string | null; skipped?: ExportSkipped;
                     complete: boolean; reason: string | null }) =>
    auditWorker(ctx, { event_type: "admin", details: { op: "instance_export_done", run, out_dir: dir, file: o.file, records: o.records ?? 0, originals: o.originals ?? 0,
      original_bytes: o.original_bytes ?? 0, bytes: o.bytes ?? 0, sha256: o.sha256 ?? null, skipped: o.skipped ?? {}, complete: o.complete, ...(o.reason ? { reason: o.reason } : {}) } });

  // 5. the alert, before the first record is read: an export killed half-way is still seen by the security auditor
  const alert = await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
    instanceId: ctx.instanceId, level: "high", code: "instance_export",
    summary: "Memory export started by a server job (the whole instance or one space): records of both classes are being written to a file on the server",
    details: facts, dedupeKey: `instance_export:${run}`,
  });
  if (alert.inserted !== true) { await done({ file: null, complete: false, reason: "alert_unavailable" }); return refused("alert_unavailable"); }

  // 6. the file: created here, exclusively, never through a symbolic link; checked again once open
  let fh: fsp.FileHandle;
  try { fh = await fsp.open(partial, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600); }
  catch (e) {
    const code = (e as { code?: string }).code;
    const why = code === "EEXIST" || code === "ELOOP" ? "out_exists" : "out_refused";
    await done({ file: null, complete: false, reason: why });
    return refused(why);
  }
  let own: Stats | null = null;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await fh.close().catch(() => undefined); } };
  try {
    await fh.chmod(0o600);
    own = await fh.stat();
    const real = realpathSync(partial);
    if (real !== join(dir, basename(partial)) || !sameFile(lstatSync(partial), own)) throw new Error("the .partial file is not where it was created");
  } catch {
    await close();
    // the empty file we created (it may lie elsewhere when the directory was swapped for a link): removed, only if ours
    if (own) await removeOwn(partial, own);
    await done({ file: null, complete: false, reason: "out_refused" });
    return refused("out_refused");
  }
  const mine: Stats = own;

  // 7. the stream
  const skipped: ExportSkipped = {};
  const state: SourceOpts = { spaceId, originals: parsed.originals, skipped, run, current: null };
  let res: ExportResult | null = null;
  let reported: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { reported = resolve; });
  const hash = createHash("sha256");
  let bytes = 0, writeFailed: string | null = null;
  const archive = exportArchive(instanceExportSource(ctx, spaces, state), {
    instance: ctx.instanceId, by: null, createdAt: now(),
    scope: { kind: "instance", spaces: spaces.map((s) => s.slug), classes: ["open", "closed"], originals: parsed.originals },
    signal: deps.signal, skipped: () => skipped, onDone: (r) => { res = r; reported(); },
  });
  try {
    for await (const chunk of archive as AsyncIterable<Buffer>) { hash.update(chunk); bytes += chunk.length; await writeAll(fh, chunk); }
  } catch (e) {
    writeFailed = (e as { code?: string }).code ?? "error";
    log.error("instance_export_write_failed", { run, code: writeFailed });
    archive.destroy();
    // the engine reports its counts once its generator has closed (a stuck source does not hold the job for long)
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([finished, new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); })]);
    clearTimeout(timer);
  }
  const r = res as ExportResult | null;
  // a complete archive: the engine added the source's counts (moved, gone, moving, no_space, originals_excluded) to its own
  // (original_missing) for the manifest; a stopped one: the counts so far, from both
  const allSkipped: ExportSkipped = { ...(r?.skipped ?? {}) };
  if (r?.complete !== true) for (const [k, v] of Object.entries(skipped)) allSkipped[k] = (allSkipped[k] ?? 0) + v;
  let complete = !writeFailed && r?.complete === true;
  let reason: string | null = writeFailed ? "write_failed" : complete ? null : (r?.reason ?? "internal");

  // 8. the final name for a complete archive; an incomplete one is removed (only our own file)
  if (complete) {
    try { await fh.sync(); await close(); }
    catch { complete = false; reason = "write_failed"; }
  }
  await close();
  if (complete) {
    const failed = await publish(partial, final, mine).catch(() => "out_refused" as const);
    if (failed) { complete = false; reason = failed; }
  }
  if (!complete) await removeOwn(partial, mine);
  // where it stopped: the record in the result line and a server log line (never in the audit log)
  const stoppedAt = complete ? null : state.current ?? null;
  if (!complete) log.error("instance_export_incomplete", { run, reason, record_id: stoppedAt, last_written: r?.last ?? null });

  // 9. the closing event: numbers only
  const sha256 = complete ? hash.digest("hex") : null;
  const counts = { records: r?.records ?? 0, originals: r?.originals ?? 0, original_bytes: r?.original_bytes ?? 0 };
  await done({ file: complete ? basename(final) : null, ...counts, bytes, sha256, skipped: allSkipped, complete, reason });
  return { complete, reason, run, file: complete ? basename(final) : null, sha256, bytes, spaces: r?.spaces ?? 0, ...counts, skipped: allSkipped,
           notice: exportMessage("export.at_rest_notice"), stopped_at: stoppedAt };
}
