// Health check `schema` (the thin soft gate): is the schema applied to this installation the one this release
// ships? The schema step of the public install path (deploy/compose/db/memory-schema) writes maintenance_state key
// `schema_applied` = { manifest_sha256, commit, at } after a successful run; the gateway computes the same fingerprint from
// its own copy of contracts/schema and compares.
//   * equal — ok;
//   * different, or a record without a fingerprint, or this release's files not readable — degraded (ok false, level warn)
//     with the hint to run `setup upgrade`: new code on an older schema (or the other way round) is not refused here — a
//     hard gate and compatibility ranges wait for a later release;
//   * no record — no check at all: a schema applied without the manifest never writes it.
// The fingerprint: sha256 over the lines "<sha256 of the file>  <name>\n" — first manifest.tsv, then every file a row of it
// names, once each, sorted by name — the output form of `sha256sum`, so the shell computes the same value.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_DIR } from "@memory/shared";
import type { App } from "./context.ts";

export const SCHEMA_APPLIED_KEY = "schema_applied";
export const SCHEMA_UPGRADE_HINT = "the schema is from another release: run `setup upgrade`";

export interface SchemaCheck { ok: boolean; level: "ok" | "warn"; detail: string }

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

/** The fingerprint of a schema folder, or null when its manifest or a file it names is missing. */
export function schemaFingerprint(dir: string): string | null {
  const manifest = join(dir, "manifest.tsv");
  if (!existsSync(manifest)) return null;
  const bytes = readFileSync(manifest);
  const files = new Set<string>();
  let header = false;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (!header) { header = true; continue; }
    const file = line.split("\t")[1];
    if (file) files.add(file);
  }
  let lines = `${sha(bytes)}  manifest.tsv\n`;
  for (const file of [...files].sort()) {
    const path = join(dir, file);
    if (!existsSync(path)) return null;
    lines += `${sha(readFileSync(path))}  ${file}\n`;
  }
  return sha(lines);
}

let own: string | null | undefined;
/** This release's fingerprint (its contracts/schema), computed once per process. */
export const ownSchemaFingerprint = (): string | null => (own === undefined ? (own = schemaFingerprint(join(CONTRACTS_DIR, "schema"))) : own);

/** A short, printable form of a recorded string (commit, time): nothing but [A-Za-z0-9.:+_-], at most 40 characters. */
const shown = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9.:+_-]{1,40}$/.test(v) ? v : null);

/** The check, or null on a path that records no applied schema. */
export async function schemaCheck(app: Pick<App, "db" | "instanceId">, mine: string | null = ownSchemaFingerprint()): Promise<SchemaCheck | null> {
  const r = await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, SCHEMA_APPLIED_KEY]);
  const row = r.rows[0] as { value?: Record<string, unknown> } | undefined;
  if (!row) return null;
  const v = row.value ?? {};
  const applied = typeof v.manifest_sha256 === "string" && HEX64.test(v.manifest_sha256) ? v.manifest_sha256 : null;
  if (!mine) return { ok: false, level: "warn", detail: `the schema files of this release are not readable, the applied schema cannot be compared: ${SCHEMA_UPGRADE_HINT}` };
  if (!applied) return { ok: false, level: "warn", detail: `the record of the applied schema has no fingerprint: ${SCHEMA_UPGRADE_HINT}` };
  if (applied !== mine) return { ok: false, level: "warn", detail: `${SCHEMA_UPGRADE_HINT} (applied ${applied.slice(0, 12)}, this release ${mine.slice(0, 12)})` };
  const commit = shown(v.commit); const at = shown(v.at);
  return { ok: true, level: "ok", detail: `schema ${mine.slice(0, 12)} of this release${commit ? `, commit ${commit}` : ""}${at ? `, applied ${at}` : ""}` };
}
