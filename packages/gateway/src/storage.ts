import { createHash } from "node:crypto";
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import type { Readable } from "node:stream";
import { Client } from "minio";
import { allowReachable, checkedAgent, makeS3Client, S3_TIMEOUT_MS, s3BucketExists, s3Endpoint, s3GetBuffer, s3GetStream, s3Put, s3Size, tooLarge, withTimeout, type AnswerJudge, type DataClass, type ModelLookup, type Settings } from "@memory/shared";

/**
 * Isolation of the two classes: "ok" — each bucket refused the other class's key in every probe; "violation" —
 * proven: one probe was accepted, or the settings put both classes on one bucket or one key pair; "unknown" — no clear
 * answer (no answer in time, a server error, the address unreachable). Health maps them to ok / fail (fail_closed) / warn.
 */
export interface StorageIsolation { state: "ok" | "violation" | "unknown"; detail: string }
export interface StorageCheck { ok: boolean; error?: string; isolation?: StorageIsolation }

export class Storage {
  constructor(private readonly settings: Settings) {}

  async put(cls: DataClass, key: string, body: Buffer, mime: string): Promise<boolean> {
    const s = makeS3Client(this.settings, cls);
    if (!s) return false;
    await s3Put(s, key, body, mime);
    return true;
  }

  async get(cls: DataClass, key: string, maxBytes?: number): Promise<Buffer | null> {
    const s = makeS3Client(this.settings, cls);
    if (!s) return null;
    if (maxBytes !== undefined && (await s3Size(s, key)) > maxBytes) throw tooLarge(`The file is larger than ${Math.floor(maxBytes / 1_048_576)} MB`);
    return s3GetBuffer(s, key, S3_TIMEOUT_MS.transfer, maxBytes);
  }

  async getStream(cls: DataClass, key: string): Promise<Readable | null> {
    const s = makeS3Client(this.settings, cls);
    if (!s) return null;
    return s3GetStream(s, key);
  }

  async has(cls: DataClass, key: string): Promise<boolean | null> {
    const s = makeS3Client(this.settings, cls);
    if (!s) return null;
    return withTimeout(s.client.statObject(s.bucket, key), S3_TIMEOUT_MS.check, "s3 stat").then(() => true, () => false);
  }

  async check(): Promise<StorageCheck> {
    // an address that does not parse makes makeS3Client throw: the own-bucket check reports it, the method never throws
    let configured = false;
    try { configured = (["open", "closed"] as DataClass[]).every((cls) => makeS3Client(this.settings, cls)); } catch { configured = false; }
    const [own, isolation] = await Promise.all([this.ownBuckets(), configured ? storageIsolation(this.settings) : Promise.resolve(undefined)]);
    return isolation ? { ...own, isolation } : own;
  }

  private async ownBuckets(): Promise<{ ok: boolean; error?: string }> {
    try {
      for (const cls of ["open", "closed"] as DataClass[]) {
        const s = makeS3Client(this.settings, cls);
        if (!s) return { ok: false, error: `the storage of class ${cls} is not configured` };
        if (!(await s3BucketExists(s))) return { ok: false, error: `the bucket of class ${cls} is unavailable (${s.endpoint})` };
      }
      return { ok: true };
    } catch (e) { const { message, code } = e as NodeJS.ErrnoException; return { ok: false, error: (typeof message === "string" && message) || (typeof code === "string" && code) || message }; }
  }
}

// ------------------------------------------------------------------------------------------------ isolation
//
// The own-bucket check proves only that each class reaches its bucket. An S3 server with one key pair for both classes,
// or two keys that both may use both buckets, passes it — and then whoever holds the open key (the edge exporter, any
// service on the open storage network) reads or overwrites the closed originals. So each class's bucket is also tried
// with the OTHER class's key, at the address of that bucket (storage.s3_endpoint_closed for the closed one), in five
// probes: a bucket check (HeadBucket), a listing (ListObjectsV2 under the probe prefix), a read of the probe object
// (GetObject), a write (PutObject of a probe key) and a delete (DeleteObject of a probe key that never exists).
// The probe object is confirmed in every round with the bucket's OWN key (a HEAD) and written again when it is gone, so
// a key with a read grant on objects but no listing right (AWS answers it 403 for an absent key) is caught by a read of
// an object that exists — also after someone removed the object. Everything the check writes lives under
// `isolation-probe/`, outside the instance prefix the orphan sweeps list; a probe write that was accepted is removed
// again with the bucket's own key. Limit: the probes name keys under `isolation-probe/` only, so a grant that a bucket
// policy limits to other key prefixes (say, the instance prefix `core/*`) is not seen by them; the `ok` text says so.
// The answer that proves isolation is a refusal (403: AccessDenied, InvalidAccessKeyId, SignatureDoesNotMatch …) or
// "no such bucket" — the key does not even see it. An accepted probe, and NoSuchKey too (S3 says "no such key" only to a
// caller allowed to look into the bucket), prove a violation.
// The other class's key is NOT pointed at its own address: two servers may hold buckets of the same name.
// What travels to the other address is a SigV4 signature, never a secret; a signed probe names only probe keys, so a
// replay of it elsewhere reads nothing.
// Each round builds its own clients on its own HTTP agent and destroys the agent at the end: minio-js 8 has no request
// timeout, so without that a server that accepts connections and never answers would keep every probe socket open.

/** Answers that prove the key cannot use the bucket: a refusal by the server, or the bucket not visible to the key. */
export const ISOLATION_REFUSED: ReadonlySet<string> = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "AllAccessDisabled", "AccountProblem", "InvalidSecurity", "Forbidden", "NoSuchBucket"]);
/** Keys of the probes (all under one prefix of their own, outside the instance prefix). */
export const ISOLATION_PROBE_PREFIX = "isolation-probe/";
export const ISOLATION_PROBE_OBJECT = `${ISOLATION_PROBE_PREFIX}object`;           // written by the bucket's own class
export const ISOLATION_PROBE_WRITE = `${ISOLATION_PROBE_PREFIX}write-test`;      // the other class's key tries to write it
export const ISOLATION_PROBE_DELETE = `${ISOLATION_PROBE_PREFIX}delete-test`;    // the other class's key tries to delete it; never exists
const PROBE_BODY = Buffer.from("storage isolation probe: written by the gateway's health check with this bucket's own key; if it is removed, the next health check writes it again\n");
const PROBE_LABEL = "storage isolation probe";
/** Upper bound of a detail text: names, addresses and reasons only, never a server's free text. */
const DETAIL_MAX = 1000;

type Probe = "bucket check" | "listing" | "read" | "write" | "delete";
type ProbeAnswer = { probe: Probe; result: "accepted" } | { probe: Probe; result: "refused" } | { probe: Probe; result: "unclear"; reason: string };
type StorageNetwork = { lookup?: ModelLookup; judge?: AnswerJudge };
interface Round { agents: Array<HttpAgent | HttpsAgent>; net?: StorageNetwork }

const otherOf = (cls: DataClass): DataClass => (cls === "open" ? "closed" : "open");
/** The last proven violation per storage settings: an unclear round does not lift it (only a proven ok or new settings). */
const proven = new Map<string, string>();

/** An address as printed: scheme, host and port only — a user name or password in the setting is never shown. */
function shown(endpoint: string): string {
  try { return new URL(endpoint).origin; } catch { return "an address that does not parse"; }
}
const cap = (s: string): string => (s.length <= DETAIL_MAX ? s : `${s.slice(0, DETAIL_MAX - 1)}…`);

function clientFor(round: Round, endpoint: string, accessKey: string, secretKey: string, region: string): Client {
  const u = new URL(endpoint), useSSL = u.protocol === "https:";
  const agent = checkedAgent({
    host: u.hostname, tls: useSSL, keepAlive: false,
    lookup: round.net?.lookup, judge: round.net?.judge ?? allowReachable,
  });
  round.agents.push(agent);
  return new Client({ endPoint: u.hostname, port: u.port ? Number(u.port) : useSSL ? 443 : 80, useSSL, accessKey, secretKey, region, transportAgent: agent });
}

/** Why a probe got no clear answer: an S3 code of the usual form, the network error code or "no answer in time". */
function reasonOf(e: unknown, ms: number): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : "an unrecognised error code";
  const msg = String((e as Error)?.message ?? "");
  if (msg.startsWith(PROBE_LABEL)) return `no answer within ${ms / 1000} s`;
  const status = /HTTP status: (\d{3})/.exec(msg)?.[1];                // minio-js retries a 5xx and then drops the S3 code
  return status ? `HTTP ${status}` : "an error without a code";
}
function classify(probe: Probe, e: unknown, ms: number, acceptedCodes: ReadonlySet<string> = new Set()): ProbeAnswer {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && acceptedCodes.has(code)) return { probe, result: "accepted" };
  if (typeof code === "string" && ISOLATION_REFUSED.has(code)) return { probe, result: "refused" };
  return { probe, result: "unclear", reason: reasonOf(e, ms) };
}
const NO_SUCH_KEY: ReadonlySet<string> = new Set(["NoSuchKey"]);

async function probeBucket(c: Client, bucket: string, ms: number): Promise<ProbeAnswer> {
  // bucketExists: true — accepted; false — the server answered NoSuchBucket / 404 to this key (the bucket is not visible)
  try { return { probe: "bucket check", result: (await withTimeout(c.bucketExists(bucket), ms, PROBE_LABEL)) ? "accepted" : "refused" }; }
  catch (e) { return classify("bucket check", e, ms); }
}

async function probeListing(c: Client, bucket: string, ms: number): Promise<ProbeAnswer> {
  let stream: (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
  const job = new Promise<void>((resolve, reject) => {
    stream = c.listObjectsV2(bucket, ISOLATION_PROBE_PREFIX, false) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
    stream.on("data", () => resolve());
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  try { await withTimeout(job, ms, PROBE_LABEL); return { probe: "listing", result: "accepted" }; }
  catch (e) { return classify("listing", e, ms); }
  finally { stream?.destroy?.(); }
}

async function probeRead(c: Client, bucket: string, ms: number): Promise<ProbeAnswer> {
  const p = c.getObject(bucket, ISOLATION_PROBE_OBJECT);
  try { (await withTimeout(p, ms, PROBE_LABEL)).destroy(); return { probe: "read", result: "accepted" }; }
  catch (e) { void p.then((st) => st.destroy(), () => undefined); return classify("read", e, ms, NO_SUCH_KEY); }
}

async function probeWrite(c: Client, bucket: string, ms: number): Promise<ProbeAnswer> {
  try { await withTimeout(c.putObject(bucket, ISOLATION_PROBE_WRITE, PROBE_BODY, PROBE_BODY.length, { "Content-Type": "text/plain" }), ms, PROBE_LABEL); return { probe: "write", result: "accepted" }; }
  catch (e) { return classify("write", e, ms); }
}

async function probeDelete(c: Client, bucket: string, ms: number): Promise<ProbeAnswer> {
  try { await withTimeout(c.removeObject(bucket, ISOLATION_PROBE_DELETE), ms, PROBE_LABEL); return { probe: "delete", result: "accepted" }; }
  catch (e) { return classify("delete", e, ms, NO_SUCH_KEY); }
}

/**
 * The probe object in the bucket, confirmed in this round with the bucket's own key (HEAD) and written again when it is
 * not there; null — it is there, otherwise why not. Not a cache per process: an object removed out of band (by an
 * operator, a lifecycle rule, the cleanup of a storage check) would otherwise turn the read probe into a refusal.
 */
async function ensureProbeObject(owner: Client, bucket: string, ms: number): Promise<string | null> {
  const t0 = Date.now();
  try {
    await withTimeout(owner.statObject(bucket, ISOLATION_PROBE_OBJECT), ms, PROBE_LABEL);
    return null;
  } catch (e) {
    // no answer in time: a write would wait as long again; any answer (NotFound, or 403 to an owner key without a
    // listing right) — the object is written
    if (String((e as Error)?.message ?? "").startsWith(PROBE_LABEL)) return reasonOf(e, ms);
  }
  const left = Math.max(ms - (Date.now() - t0), 1_000);
  try {
    await withTimeout(owner.putObject(bucket, ISOLATION_PROBE_OBJECT, PROBE_BODY, PROBE_BODY.length, { "Content-Type": "text/plain" }), left, PROBE_LABEL);
    return null;
  } catch (e) { return reasonOf(e, left); }
}

/** Probes of the bucket of `cls` with the other class's key; they run at once, the read right after the probe object is in place. */
async function probeDirection(settings: Settings, round: Round, cls: DataClass, ms: number): Promise<{ cls: DataClass; endpoint: string; bucket: string; answers: ProbeAnswer[] }> {
  const other = otherOf(cls), endpoint = s3Endpoint(settings, cls)!, bucket = settings.str(`storage.bucket_${cls}`)!;
  const region = settings.get("storage.s3_region", "us-east-1");
  const ownKey = settings.str(`storage.access_key_${cls}`)!;
  const owner = clientFor(round, endpoint, ownKey, settings.str(`storage.secret_key_${cls}`)!, region);
  const foreign = clientFor(round, endpoint, settings.str(`storage.access_key_${other}`)!, settings.str(`storage.secret_key_${other}`)!, region);
  const t0 = Date.now();
  const read = (async (): Promise<ProbeAnswer> => {
    const why = await ensureProbeObject(owner, bucket, ms);
    if (why) return { probe: "read", result: "unclear", reason: `the probe object could not be confirmed or written with the bucket's own key (${why})` };
    return probeRead(foreign, bucket, Math.max(ms - (Date.now() - t0), 1_000));
  })();
  const answers = await Promise.all([probeBucket(foreign, bucket, ms), probeListing(foreign, bucket, ms), read, probeWrite(foreign, bucket, ms), probeDelete(foreign, bucket, ms)]);
  // a write the other key was allowed to make is removed again by the bucket's own class
  if (answers.some((a) => a.probe === "write" && a.result === "accepted")) await withTimeout(owner.removeObject(bucket, ISOLATION_PROBE_WRITE), Math.min(ms, 3_000), PROBE_LABEL).catch(() => undefined);
  return { cls, endpoint, bucket, answers };
}

const sameAddress = (a: string, b: string): boolean => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return a === b; }
};

/**
 * The isolation verdict for configured storage (both classes have address, bucket and keys). Never throws. Detail texts
 * name classes, buckets and addresses only — never a key, never a server's own text.
 */
export async function storageIsolation(settings: Settings, ms: number = S3_TIMEOUT_MS.check, net?: StorageNetwork): Promise<StorageIsolation> {
  const at = { open: s3Endpoint(settings, "open") ?? "", closed: s3Endpoint(settings, "closed") ?? "" };
  const bucket = { open: settings.str("storage.bucket_open") ?? "", closed: settings.str("storage.bucket_closed") ?? "" };
  const keys = (["open", "closed"] as DataClass[]).flatMap((c) => [settings.str(`storage.access_key_${c}`) ?? "", settings.str(`storage.secret_key_${c}`) ?? ""]);
  const fingerprint = createHash("sha256").update([at.open, at.closed, bucket.open, bucket.closed, ...keys, String(settings.get("storage.s3_region", "us-east-1"))].join("\u0000")).digest("hex");
  const fix = "each class needs its own key pair that reaches only its own bucket (storage.access_key_open, storage.access_key_closed). Memory requests are refused until this is fixed.";
  if (sameAddress(at.open, at.closed)) {
    if (bucket.open === bucket.closed) return { state: "violation", detail: cap(`storage isolation is broken: both classes store their originals in one bucket "${bucket.open}" at ${shown(at.open)}; give the closed class its own bucket and key pair. Memory requests are refused until this is fixed.`) };
    if (settings.str("storage.access_key_open") === settings.str("storage.access_key_closed")) return { state: "violation", detail: cap(`storage isolation is broken: both classes use one key pair at ${shown(at.open)}; ${fix}`) };
  }
  const round: Round = { agents: [], net };
  const verdict = await (async (): Promise<StorageIsolation> => {
    try {
      const dirs = await Promise.all((["closed", "open"] as DataClass[]).map((cls) => probeDirection(settings, round, cls, ms)));
      const broken = dirs.filter((d) => d.answers.some((a) => a.result === "accepted"));
      if (broken.length) {
        const what = broken.map((d) => `the ${otherOf(d.cls)} class's key reaches the ${d.cls} bucket "${d.bucket}" at ${shown(d.endpoint)} (${d.answers.filter((a) => a.result === "accepted").map((a) => a.probe).join(", ")})`);
        return { state: "violation", detail: cap(`storage isolation is broken: ${what.join("; ")}; ${fix}`) };
      }
      const unclear = dirs.map((d) => ({ d, list: d.answers.filter((a): a is Extract<ProbeAnswer, { result: "unclear" }> => a.result === "unclear") }))
        .filter((x) => x.list.length)
        .map(({ d, list }) => `the ${otherOf(d.cls)} class's key at the ${d.cls} bucket "${d.bucket}" (${shown(d.endpoint)}) — ${list.map((a) => `${a.probe}: ${a.reason}`).join(", ")}`);
      if (unclear.length) return { state: "unknown", detail: cap(`storage isolation could not be checked: ${unclear.join("; ")}. It is checked again with the next health check.`) };
      return { state: "ok", detail: "the open bucket refuses the closed class's key and the closed bucket refuses the open class's key (bucket check, listing, read, write, delete of probe keys under isolation-probe/; a grant a bucket policy limits to other key prefixes is not seen by these probes)" };
    } catch (e) {
      return { state: "unknown", detail: cap(`storage isolation could not be checked: ${reasonOf(e, ms)}`) };
    } finally {
      for (const a of round.agents) a.destroy();                          // probes still waiting for an answer included
    }
  })();
  // a proven violation stands until a round proves isolation or the storage settings change
  if (verdict.state === "violation") { proven.clear(); proven.set(fingerprint, verdict.detail); return verdict; }
  if (verdict.state === "ok") { proven.delete(fingerprint); return verdict; }
  const earlier = proven.get(fingerprint);
  if (earlier) return { state: "violation", detail: cap(`${earlier.slice(0, DETAIL_MAX - 180)} The last check got no clear answer; the violation proven earlier stands until a check proves isolation or the storage settings change.`) };
  return verdict;
}
