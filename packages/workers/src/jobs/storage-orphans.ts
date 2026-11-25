import { s3List, type DataClass, type S3Target } from "@memory/shared";

export const ORPHAN_MIN_AGE_MS = 24 * 3_600_000;
export const STORAGE_MAX = 100_000;
export const CLASSES: readonly DataClass[] = ["open", "closed"];

type Q = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
export interface OrphanDbs { control: Q; records: (cls: DataClass) => Q }

export const KEY_RE = (inst: string) => new RegExp(`^${inst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\d{4}/\\d{2}/([0-9a-f]{32})/[^/]+$`);
const ID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-./;
export function recordIdOfKey(key: string): string | null {
  return ID_PREFIX.exec(key.slice(key.lastIndexOf("/") + 1))?.[1] ?? null;
}

export interface FreeObject { key: string; hash: string }
export interface FreeObjects { byClass: Record<DataClass, FreeObject[]>; listed: number; unavailable?: string; unavailable_classes: DataClass[] }

export async function unreferencedObjects(inst: string, dbs: OrphanDbs, s3: (cls: DataClass) => S3Target | null, o: { now: Date; refs: "class" | "both"; minAgeMs?: number }): Promise<FreeObjects> {
  const out: FreeObjects = { byClass: { open: [], closed: [] }, listed: 0, unavailable_classes: [] };
  const re = KEY_RE(inst), minAge = o.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  for (const cls of CLASSES) {
    const t = s3(cls);
    if (!t) { out.unavailable_classes.push(cls); continue; }
    let list: Awaited<ReturnType<typeof s3List>>;
    try { list = await s3List(t, `${inst}/`, STORAGE_MAX); }
    catch (e) { out.unavailable = String((e as Error).message).slice(0, 120); out.unavailable_classes.push(cls); continue; }
    out.listed += list.length;
    const cand = list.filter((x) => re.test(x.key) && x.lastModified && o.now.getTime() - x.lastModified.getTime() > minAge);
    if (!cand.length) continue;
    const keys = cand.map((x) => x.key);
    const used = new Set<string>();
    for (const db of o.refs === "both" || cls === "closed" ? CLASSES : [cls])
      for (const r of (await dbs.records(db).query("SELECT original_key FROM record_content WHERE original_key = ANY($1::text[])", [keys])).rows) used.add(r.original_key);
    out.byClass[cls] = cand.filter((x) => !used.has(x.key)).map((x) => ({ key: x.key, hash: re.exec(x.key)![1]! }));
  }
  return out;
}

export async function liveHashes(dbs: OrphanDbs, hexes: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!hexes.length) return out;
  for (const db of CLASSES)
    for (const r of (await dbs.records(db).query("SELECT DISTINCT substr(encode(source_hash, 'hex'), 1, 32) AS h FROM records WHERE source_hash IS NOT NULL AND substr(encode(source_hash, 'hex'), 1, 32) = ANY($1::text[])", [hexes])).rows) out.add(r.h);
  return out;
}

export async function movingHashes(dbs: OrphanDbs): Promise<Set<string>> {
  return new Set<string>((await dbs.control.query(
    `SELECT DISTINCT substr(encode(l.source_hash, 'hex'), 1, 32) AS h FROM record_locations l JOIN class_moves m ON m.record_id = l.record_id
     WHERE m.status IN ('pending', 'copying', 'verifying') AND l.source_hash IS NOT NULL`)).rows.map((r) => r.h));
}

export async function purgedTombsByHash(dbs: OrphanDbs, cls: DataClass, hexes: string[]): Promise<Array<{ id: string; h: string }>> {
  if (!hexes.length) return [];
  return (await dbs.records(cls).query(
    "SELECT id, substr(encode(source_hash, 'hex'), 1, 32) AS h FROM record_tombstones WHERE reason = 'purged' AND source_hash IS NOT NULL AND substr(encode(source_hash, 'hex'), 1, 32) = ANY($1::text[])", [hexes])).rows;
}
