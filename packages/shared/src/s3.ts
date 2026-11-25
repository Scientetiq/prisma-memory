import type { Readable } from "node:stream";
import { Client } from "minio";
import { allowReachable, checkedAgent, type AnswerJudge } from "./checked-connect.ts";
import type { DataClass } from "./db.ts";
import { tooLarge } from "./errors.ts";
import { log } from "./log.ts";
import type { ModelLookup } from "./models/address.ts";
import type { Settings } from "./settings.ts";

export interface S3Target { client: Client; bucket: string; endpoint: string }

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  void p.catch(() => undefined);
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no response within ${ms} ms`)), ms); });
  try { return await Promise.race([p, guard]); } finally { clearTimeout(timer); }
}

const clients = new Map<DataClass, { fingerprint: string; target: S3Target; agent: ReturnType<typeof checkedAgent> }>();

export const s3Endpoint = (settings: Settings, cls: DataClass): string | null =>
  (cls === "closed" ? settings.str("storage.s3_endpoint_closed") || settings.str("storage.s3_endpoint") : settings.str("storage.s3_endpoint"));

export function makeS3Client(settings: Settings, cls: DataClass, net?: { lookup?: ModelLookup; judge?: AnswerJudge }): S3Target | null {
  const endpoint = s3Endpoint(settings, cls), bucket = settings.str(`storage.bucket_${cls}`);
  const accessKey = settings.str(`storage.access_key_${cls}`), secretKey = settings.str(`storage.secret_key_${cls}`);
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  const region = settings.get("storage.s3_region", "us-east-1");
  const fingerprint = [endpoint, bucket, accessKey, secretKey, region].join("\u0000");
  const cached = clients.get(cls);
  if (cached && cached.fingerprint === fingerprint) return cached.target;
  const u = new URL(endpoint), useSSL = u.protocol === "https:";
  const agent = checkedAgent({ host: u.hostname, tls: useSSL, keepAlive: true, lookup: net?.lookup, judge: net?.judge ?? allowReachable });
  const target: S3Target = {
    bucket, endpoint, client: new Client({ endPoint: u.hostname, port: u.port ? Number(u.port) : useSSL ? 443 : 80, useSSL, accessKey, secretKey, region, transportAgent: agent }),
  };
  clients.set(cls, { fingerprint, target, agent });
  cached?.agent.destroy();
  return target;
}

export const S3_TIMEOUT_MS = { transfer: 60_000, remove: 15_000, check: 5_000 } as const;

export function s3Put(t: S3Target, key: string, body: Buffer, mime: string, ms: number = S3_TIMEOUT_MS.transfer): Promise<unknown> {
  return withTimeout(t.client.putObject(t.bucket, key, body, body.length, { "Content-Type": mime }), ms, `s3 put ${t.bucket}`);
}

export async function s3GetBuffer(t: S3Target, key: string, ms: number = S3_TIMEOUT_MS.transfer, maxBytes?: number): Promise<Buffer> {
  let stream: Readable | undefined;
  let failure: { error: unknown } | undefined;
  const job = (async () => {
    stream = await t.client.getObject(t.bucket, key);
    if (failure) {
      stream.destroy();
      throw failure.error;
    }
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of stream) {
      n += (c as Buffer).length;
      if (maxBytes !== undefined && n > maxBytes) { stream.destroy(); throw tooLarge(`storage object exceeds ${maxBytes} bytes`); }
      parts.push(c as Buffer);
    }
    return Buffer.concat(parts);
  })();
  try {
    return await withTimeout(job, ms, `s3 get ${t.bucket}`);
  } catch (e) {
    failure = { error: e };
    stream?.destroy();
    throw e;
  }
}

export async function s3GetStream(t: S3Target, key: string, ms: number = S3_TIMEOUT_MS.transfer): Promise<Readable> {
  const p = t.client.getObject(t.bucket, key);
  try { return await withTimeout(p, ms, `s3 get ${t.bucket}`); }
  catch (e) { void p.then((s) => s.destroy(), () => undefined); throw e; }
}

export async function s3Size(t: S3Target, key: string, ms: number = S3_TIMEOUT_MS.check): Promise<number> {
  const st = await withTimeout(t.client.statObject(t.bucket, key), ms, `s3 stat ${t.bucket}`);
  return Number(st.size);
}

export const S3_VERSIONS_RECHECK_MS = 10 * 60_000;
export const MAX_KEY_VERSIONS = 1000;
const NO_VERSIONS_CODES = new Set(["NotImplemented", "MethodNotAllowed"]);

type VersionsMode = "list" | "none" | "denied";
const versionsModes = new WeakMap<object, Map<string, { mode: VersionsMode; until: number }>>();
const rememberedMode = (t: S3Target) => versionsModes.get(t.client)?.get(t.bucket);
function rememberMode(t: S3Target, mode: VersionsMode, ttl: number): void {
  let m = versionsModes.get(t.client);
  if (!m) versionsModes.set(t.client, (m = new Map()));
  const was = m.get(t.bucket);
  if (was?.mode === "list" && mode !== "list") return;
  m.set(t.bucket, { mode, until: Date.now() + ttl });
}

function versionsRefusal(e: unknown): "none" | "denied" | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "AccessDenied") return "denied";
  return typeof code === "string" && NO_VERSIONS_CODES.has(code) ? "none" : null;
}

interface KeyVersion { versionId: string; latest: boolean; deleteMarker: boolean }
interface KeyListing { versions: KeyVersion[]; versioned: boolean | null }
const yes = (v: unknown) => v === true || v === "true";

async function listKeyVersions(t: S3Target, key: string, ms: number): Promise<KeyListing> {
  let stream: (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
  const job = new Promise<KeyListing>((resolve, reject) => {
    const out: KeyListing = { versions: [], versioned: null };
    let seen = 0;
    stream = t.client.listObjects(t.bucket, key, true, { IncludeVersion: true }) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
    stream.on("data", (o: { name?: string; versionId?: unknown; isLatest?: unknown; isDeleteMarker?: unknown }) => {
      if (++seen > MAX_KEY_VERSIONS) { stream?.destroy?.(); reject(new Error(`s3 versions ${t.bucket}: more than ${MAX_KEY_VERSIONS} versions for the key`)); return; }
      const hasId = typeof o.versionId === "string" && o.versionId !== "";
      out.versioned = out.versioned === true || hasId;
      if (o.name !== key || !hasId) return;
      out.versions.push({ versionId: o.versionId as string, latest: yes(o.isLatest), deleteMarker: yes(o.isDeleteMarker) });
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(out));
  });
  try { return await withTimeout(job, ms, `s3 versions ${t.bucket}`); } catch (e) { stream?.destroy?.(); throw e; }
}

async function keyVersionsOrNull(t: S3Target, key: string, ms: number): Promise<KeyVersion[] | null> {
  const knownList = rememberedMode(t)?.mode === "list";
  let listing: KeyListing;
  try {
    listing = await listKeyVersions(t, key, ms);
  } catch (e) {
    const refusal = knownList ? null : versionsRefusal(e), error = String((e as Error)?.message ?? e).slice(0, 120);
    if (refusal === "denied") {
      rememberMode(t, "denied", S3_VERSIONS_RECHECK_MS);
      log.warn("s3_versions_denied", { bucket: t.bucket, error, hint: "permission to list versions is missing: earlier object versions may remain" });
      return null;
    }
    if (refusal === "none") { rememberMode(t, "none", S3_VERSIONS_RECHECK_MS); log.info("s3_versions_unsupported", { bucket: t.bucket, error }); return null; }
    throw new Error(`s3 remove ${t.bucket}: could not check versions. Object was not deleted — ${error}`);
  }
  if (listing.versioned === false) {
    if (knownList) throw new Error(`s3 remove ${t.bucket}: could not check versions. Object was not deleted because the list has no versions`);
    rememberMode(t, "none", S3_VERSIONS_RECHECK_MS);
    return null;
  }
  if (listing.versioned) rememberMode(t, "list", Number.POSITIVE_INFINITY);
  return listing.versions;
}

async function removeVersions(t: S3Target, key: string, versions: KeyVersion[], ms: number): Promise<void> {
  for (const v of [...versions.filter((x) => !x.latest), ...versions.filter((x) => x.latest)]) {
    await withTimeout(t.client.removeObject(t.bucket, key, { versionId: v.versionId }), ms, `s3 remove version ${t.bucket}`);
  }
}

export async function s3Remove(t: S3Target, key: string, ms: number = S3_TIMEOUT_MS.remove): Promise<void> {
  const plainRemove = () => withTimeout(t.client.removeObject(t.bucket, key), ms, `s3 remove ${t.bucket}`);
  const known = rememberedMode(t);
  if (typeof (t.client as { listObjects?: unknown }).listObjects !== "function" || (known && known.mode !== "list" && known.until > Date.now())) {
    await plainRemove();
    return;
  }
  const versions = await keyVersionsOrNull(t, key, ms);
  if (versions === null) { await plainRemove(); return; }
  if (versions.length) { await removeVersions(t, key, versions, ms); return; }
  if (rememberedMode(t)?.mode === "list") return;
  await plainRemove();
  const again = await keyVersionsOrNull(t, key, ms).catch(() => null);
  if (again?.length) await removeVersions(t, key, again.filter((v) => v.deleteMarker), ms);
}

export function s3BucketExists(t: S3Target, ms: number = S3_TIMEOUT_MS.check): Promise<boolean> {
  return withTimeout(t.client.bucketExists(t.bucket), ms, `s3 check ${t.bucket}`);
}

export function s3Has(t: S3Target, key: string, ms: number = S3_TIMEOUT_MS.check): Promise<boolean> {
  return withTimeout(t.client.statObject(t.bucket, key), ms, `s3 stat ${t.bucket}`).then(() => true, () => false);
}

export interface S3ListItem { key: string; size: number; lastModified: Date | null }

export async function s3List(t: S3Target, prefix: string, max: number, ms: number = 30_000): Promise<S3ListItem[]> {
  let stream: (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
  const job = new Promise<S3ListItem[]>((resolve, reject) => {
    const out: S3ListItem[] = [];
    stream = t.client.listObjectsV2(t.bucket, prefix, true) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
    stream.on("data", (o: { name?: string; size?: number; lastModified?: Date; prefix?: string }) => {
      if (!o.name) return;
      if (out.length >= max) { stream?.destroy?.(); reject(new Error(`s3 list ${t.bucket}: more than ${max} objects`)); return; }
      out.push({ key: o.name, size: Number(o.size ?? 0), lastModified: o.lastModified ? new Date(o.lastModified) : null });
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(out));
  });
  try { return await withTimeout(job, ms, `s3 list ${t.bucket}`); } catch (e) { stream?.destroy?.(); throw e; }
}
