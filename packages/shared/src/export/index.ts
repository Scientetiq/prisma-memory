// Memory export engine (format prisma-memory-export/1, contracts/export/): an async source of spaces and records in, a
// gzip-compressed tar stream out. Nothing is written to disk and only one record (its text, its metadata and a chunk of
// its original) is in memory at a time. The source decides what may be exported and audits it; the engine only lays the
// archive out. A failure after the first byte cannot change the HTTP status any more, so the engine ends the archive
// with EXPORT-INCOMPLETE.txt and without manifest.json — the README says that such an archive is incomplete.
import { createHash } from "node:crypto";
import { Readable, pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { citationPath, originalEntry, recordEntryBase, spaceEntry } from "./layout.ts";
import { buildManifest, indexLine, type ExportScope, type ExportSkipped } from "./manifest.ts";
import { exportMessage } from "./messages.ts";
import { renderMarkdown, renderRecordJson, type ExportOriginalMeta, type ExportRecord } from "./render.ts";
import { tarFile, tarHeader, tarPadding, TAR_END } from "./tar.ts";

export * from "./layout.ts";
export * from "./manifest.ts";
export * from "./messages.ts";
export * from "./render.ts";
export * from "./rows.ts";
export * from "./settings.ts";
export * from "./tar.ts";

export interface ExportSpace {
  slug: string; name: string; kind: string; default_class: string; description: string | null;
  created_at: Date | string | null; owner: string | null; archived_at: Date | string | null;
}

/** Bytes of an original: a stream from storage, or chunks already in memory. */
export type ExportOriginalBody = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * The original of a record: opened only when the engine reaches it; null from open() — the file is missing.
 * `withheld` — the file exists but is not handed out (`unchecked`: an open record whose check is not done; `excluded`:
 * the instance export leaves originals out): open() is never called and the record JSON says so (`original.withheld`).
 */
export interface ExportOriginalSource {
  name: string | null; mime: string | null; pages: number | null; duration_sec: number | null;
  withheld?: "unchecked" | "excluded";
  open(): Promise<{ bytes: number; body: ExportOriginalBody } | null>;
}

export type ExportItem =
  | { kind: "space"; space: ExportSpace; scope?: Record<string, unknown> }
  | { kind: "record"; record: ExportRecord; text: string | null; original: ExportOriginalSource | null };

/** A stop with a reason code for EXPORT-INCOMPLETE.txt (audit_unavailable, time_limit, original_size_mismatch, …). */
export class ExportAbort extends Error {
  constructor(readonly reason: string, message?: string) { super(message ?? reason); }
}

export interface ExportResult {
  complete: boolean;
  /** Why the archive is incomplete; null when complete. */
  reason: string | null;
  spaces: number; records: number; originals: number; original_bytes: number;
  skipped: ExportSkipped;
  /** Id of the last record written. */
  last: string | null;
}

export interface ExportOptions {
  instance: string;
  /** Login of the person who exported; null for the server job. */
  by: string | null;
  scope: ExportScope;
  createdAt?: Date;
  /** Epoch milliseconds after which the export stops (time_limit) between two records. */
  deadline?: number;
  /**
   * Stops the export where it waits: an original being opened or read (a stalled storage stream is destroyed) ends the
   * archive with EXPORT-INCOMPLETE.txt; the reason is the signal's ExportAbort, else `aborted`. A reader that stopped
   * reading is not reached by it — the caller closes the stream itself (gateway route: the time cap).
   */
  signal?: AbortSignal;
  /** Skips counted by the source (no_access, gone, …), read when the manifest is written. */
  skipped?: () => ExportSkipped;
  /** Called exactly once with the outcome: complete, aborted, or the reader went away (client_closed). */
  onDone?: (r: ExportResult) => void;
  now?: () => number;
}

/** The stop reason a signal carries. */
const abortOf = (signal: AbortSignal): ExportAbort => (signal.reason instanceof ExportAbort ? signal.reason : new ExportAbort("aborted"));

/** A promise that rejects as soon as the signal fires; a value that comes later is handed to `late` (to be destroyed). */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, late: (v: T) => void): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) { p.then(late, () => undefined); return Promise.reject(abortOf(signal)); }
  return new Promise<T>((resolve, reject) => {
    let gone = false;
    const onAbort = () => { gone = true; reject(abortOf(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); if (gone) late(v); else resolve(v); },
           (e) => { signal.removeEventListener("abort", onAbort); if (!gone) reject(e); });
  });
}

type Destroyable = { destroy: (e?: Error) => unknown };
const destroyable = (b: unknown): b is Destroyable => !!b && typeof (b as Destroyable).destroy === "function";

const json = (v: unknown): Buffer => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, "utf8");
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const time = (v: Date | string | null | undefined, fallback: Date): Date => {
  const d = v ? new Date(v) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
};

/**
 * The original's bytes into the tar: exactly `bytes` of them. A body that ends early is padded with zeros and a longer
 * one is cut, then the export stops (original_size_mismatch): the archive stays readable, and it is marked incomplete.
 */
async function* originalBytes(body: ExportOriginalBody, bytes: number, hash: ReturnType<typeof createHash>, signal?: AbortSignal): AsyncGenerator<Buffer> {
  let written = 0, mismatch = false, failed: unknown = null;
  // the signal destroys a stream that stalled (the for-await below then throws the stop reason)
  const onAbort = () => { if (destroyable(body)) body.destroy(abortOf(signal!)); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  // no yield in a `finally` here: when the reader goes away the generator is closed with return(), and a yield there
  // would suspend it for good (the outer finally — slots, onDone — would never run)
  try {
    for await (const chunk of body) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(b.length, bytes - written);
      if (take < b.length) mismatch = true;
      if (take > 0) { const part = take === b.length ? b : b.subarray(0, take); hash.update(part); written += take; yield part; }
      if (mismatch) break;
    }
  } catch (e) {
    failed = e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (written < bytes) {
    // keep the tar structure: the declared size is filled up whatever stopped the body
    let left = bytes - written;
    while (left > 0) { const n = Math.min(left, 65_536); left -= n; yield Buffer.alloc(n); }
    mismatch = true;
  }
  yield tarPadding(bytes);
  if (failed) throw failed instanceof ExportAbort ? failed : new ExportAbort("original_unreadable");
  if (mismatch) throw new ExportAbort("original_size_mismatch");
}

/** The uncompressed tar of an export, chunk by chunk. */
export async function* exportTar(items: AsyncIterable<ExportItem>, o: ExportOptions): AsyncGenerator<Buffer> {
  const now = o.now ?? Date.now;
  const createdAt = o.createdAt ?? new Date(now());
  const res: ExportResult = { complete: false, reason: "client_closed", spaces: 0, records: 0, originals: 0, original_bytes: 0, skipped: {}, last: null };
  const it = items[Symbol.asyncIterator]();
  let sourceDone = false, reported = false;
  const report = (): void => { if (!reported) { reported = true; o.onDone?.(res); } };
  const index: string[] = [];
  try {
    yield* tarFile("README.md", Buffer.from(exportMessage("export.readme"), "utf8"), createdAt);
    try {
      for (;;) {
        if (o.signal?.aborted) throw abortOf(o.signal);
        if (o.deadline !== undefined && now() > o.deadline) throw new ExportAbort("time_limit");
        const next = await it.next();
        if (next.done) { sourceDone = true; break; }
        const item = next.value;
        if (item.kind === "space") {
          const s = item.space;
          yield* tarFile(spaceEntry(s.slug), json({
            slug: s.slug, name: s.name, kind: s.kind, default_class: s.default_class, description: s.description,
            created_at: s.created_at ? time(s.created_at, createdAt).toISOString() : null, owner: s.owner,
            archived_at: s.archived_at ? time(s.archived_at, createdAt).toISOString() : null,
            export_scope: { ...(item.scope ?? {}), classes: o.scope.classes, originals: o.scope.originals },
          }), createdAt);
          res.spaces += 1;
          continue;
        }
        const r = item.record;
        const path = citationPath(r.space, r.type, r.occurred_at, r.id);
        const base = recordEntryBase(r.space, r.type, r.occurred_at, r.id);
        const mtime = time(r.ingested_at ?? r.occurred_at, createdAt);
        const md = Buffer.from(renderMarkdown(r, path, item.text), "utf8");
        yield* tarFile(`${base}.md`, md, mtime);
        let meta: ExportOriginalMeta | null = null;
        if (item.original) {
          const src = item.original;
          const common = { name: src.name, mime: src.mime, pages: src.pages, duration_sec: src.duration_sec };
          const opened = src.withheld ? null
            : await unlessAborted(src.open(), o.signal, (late) => { if (late && destroyable(late.body)) late.body.destroy(); });
          if (src.withheld) {
            meta = { ...common, entry: null, bytes: null, sha256: null, withheld: src.withheld };
          } else if (!opened) {
            meta = { ...common, entry: null, bytes: null, sha256: null, missing: true };
            res.skipped.original_missing = (res.skipped.original_missing ?? 0) + 1;
          } else {
            const entry = originalEntry(r.space, r.id, src.name);
            const hash = createHash("sha256");
            yield tarHeader({ name: entry, size: opened.bytes, mtime });
            yield* originalBytes(opened.body, opened.bytes, hash, o.signal);
            meta = { ...common, entry, bytes: opened.bytes, sha256: hash.digest("hex") };
            res.originals += 1; res.original_bytes += opened.bytes;
          }
        }
        yield* tarFile(`${base}.json`, json(renderRecordJson(r, path, meta)), mtime);
        index.push(indexLine({ id: r.id, path, md_sha256: sha256(md), original_sha256: meta?.sha256 ?? null, bytes: meta?.bytes ?? null }));
        res.records += 1; res.last = r.id;
      }
    } catch (e) {
      res.reason = e instanceof ExportAbort ? e.reason : (e as { code?: unknown })?.code === "ERR_STREAM_PREMATURE_CLOSE" ? "client_closed" : "internal";
      if (!sourceDone) { sourceDone = true; await Promise.resolve(it.return?.()).catch(() => undefined); }
      yield* tarFile("EXPORT-INCOMPLETE.txt", Buffer.from(exportMessage("export.incomplete", { reason: res.reason, last: res.last ?? "none", records: res.records }), "utf8"), new Date(now()));
      yield TAR_END;
      return;
    }
    for (const [k, v] of Object.entries(o.skipped?.() ?? {})) res.skipped[k] = (res.skipped[k] ?? 0) + v;
    yield* tarFile("index.jsonl", Buffer.from(index.join(""), "utf8"), createdAt);
    const finishedAt = new Date(now());
    yield* tarFile("manifest.json", json(buildManifest({ instance: o.instance, createdAt, finishedAt, by: o.by, scope: o.scope,
      counts: { spaces: res.spaces, records: res.records, originals: res.originals, original_bytes: res.original_bytes }, skipped: res.skipped })), finishedAt);
    yield TAR_END;
    res.complete = true; res.reason = null;
  } finally {
    if (!sourceDone) await Promise.resolve(it.return?.()).catch(() => undefined);
    report();
  }
}

/**
 * The export as a gzip stream. Destroying the returned stream (the reader went away) stops the tar generator and the
 * source (their `finally` blocks run: slots are freed, nothing is left open).
 */
export function exportArchive(items: AsyncIterable<ExportItem>, o: ExportOptions): Readable {
  const tar = Readable.from(exportTar(items, o), { objectMode: false, highWaterMark: 65_536 });
  const gz = createGzip();
  pipeline(tar, gz, () => undefined);
  return gz;
}
