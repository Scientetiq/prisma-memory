import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync, type ZipOptions } from "fflate";
import { parse as parseYaml } from "yaml";
import { CONTRACTS_DIR } from "./contracts.ts";
import { SKILL_BUNDLE, skillBundleDir } from "./skill-bundle.ts";

// Name, folder, signing namespace and resource prefix come from the skill package description (skill-bundle.ts,
// contracts/skills/bundle.json) — nowhere else.
export const SKILL_NAME = SKILL_BUNDLE.name;
export const SKILL_DIR = skillBundleDir(SKILL_BUNDLE);
export const SKILL_SIGNATURES_DIR = resolve(CONTRACTS_DIR, "skills", "signatures");
export const SKILL_SIGNATURE_NAMESPACE = SKILL_BUNDLE.signature_namespace;
export const SKILL_URI_PREFIX = SKILL_BUNDLE.uri_prefix;
export const SKILL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.md$/;

export interface SkillFile { path: string; bytes: Uint8Array; size: number; sha256: string }
export interface SkillManifest {
  name: string; version: string; uri: string;
  files: Array<{ path: string; uri: string; size: number; digest: string }>;
  files_digest: string;
  archive: { name: string; size: number; digest: string };
  provenance?: SkillProvenance;
}
export interface SkillProvenance { source_commit: string }

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export function collectSkillFiles(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const path = rel ? `${rel}/${name}` : name, full = join(abs, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) walk(full, path); continue; }
      if (!st.isFile() || !SKILL_PATH_RE.test(path)) continue;
      const bytes = new Uint8Array(readFileSync(full));
      out.push({ path, bytes, size: bytes.length, sha256: sha256(bytes) });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

let cachedFiles: { list: SkillFile[]; byPath: Map<string, SkillFile> } | undefined;
function files(): { list: SkillFile[]; byPath: Map<string, SkillFile> } {
  if (!cachedFiles) {
    const list = collectSkillFiles(SKILL_DIR);
    cachedFiles = { list, byPath: new Map(list.map((f) => [f.path, f])) };
  }
  return cachedFiles;
}

export function skillFiles(): readonly SkillFile[] { return files().list; }

export function skillFile(rel: string): SkillFile | undefined { return files().byPath.get(rel); }

export function skillFileByUri(uri: string): SkillFile | undefined {
  return uri.startsWith(SKILL_URI_PREFIX) ? skillFile(uri.slice(SKILL_URI_PREFIX.length)) : undefined;
}

export function skillMarkdown(): string {
  const core = skillFile("SKILL.md");
  if (!core) throw new Error(`memory skill: missing ${SKILL_DIR}/SKILL.md`);
  return Buffer.from(core.bytes).toString("utf8");
}

export function parseSkillVersion(markdown: string): string {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (head === undefined) throw new Error("memory skill: no front matter between the --- lines");
  const meta = /^metadata:\n((?: {2}[^\n]*\n?)*)/m.exec(head)?.[1];
  if (meta === undefined) throw new Error("memory skill: front matter is missing metadata (version is metadata.version)");
  const v = /^ {2}version: "(\d+\.\d+\.\d+)"$/m.exec(meta)?.[1];
  if (!v) throw new Error('memory skill: expected a metadata.version line of the form “  version: "X.Y.Z"”');
  return v;
}

let cachedVersion: string | undefined;
export function skillVersion(): string {
  cachedVersion ??= parseSkillVersion(skillMarkdown());
  return cachedVersion;
}

export function filesDigest(list: ReadonlyArray<{ path: string; sha256: string }>): string {
  return sha256([...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}  ${f.sha256}\n`).join(""));
}

export function buildSkillZip(list: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const opts: ZipOptions = { level: 9, mtime: new Date(2025, 0, 1, 12, 0, 0) };
  const entries: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const f of [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) entries[`${SKILL_NAME}/${f.path}`] = [f.bytes, opts];
  return zipSync(entries, opts);
}

let cachedZip: Uint8Array | undefined;
export function skillZip(): Uint8Array {
  cachedZip ??= buildSkillZip(skillFiles());
  return cachedZip;
}

export function parseSkillFrontmatter(markdown: string): Record<string, unknown> {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (head === undefined) throw new Error("memory skill: no front matter between the --- lines");
  const data: unknown = parseYaml(head);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("memory skill: front matter is not a YAML mapping");
  const front = data as Record<string, unknown>;
  if (typeof front.name !== "string" || typeof front.description !== "string") throw new Error("memory skill: front matter is missing name and description");
  return front;
}

export interface SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string; size: number }>;
}

export function buildSkillEntry(list: readonly SkillFile[], frontmatter: Record<string, unknown>): SkillEntry {
  if (frontmatter.name !== SKILL_NAME) throw new Error(`memory skill: the front matter name must be ${SKILL_NAME}`);
  if (!list.some((f) => f.path === "SKILL.md")) throw new Error("memory skill: SKILL.md is missing");
  const size = list.reduce((n, f) => n + f.size, 0);
  if (list.length > 512 || size > 16 * 1024 * 1024) throw new Error("memory skill: more than 512 files or 16 MiB (SEP-2640 limit)");
  return {
    uri: `${SKILL_URI_PREFIX}SKILL.md`, frontmatter,
    resources: list.map((f) => ({ uri: `${SKILL_URI_PREFIX}${f.path}`, digest: `sha256:${f.sha256}`, size: f.size })),
  };
}

let cachedEntry: SkillEntry | undefined;
export function skillEntry(): SkillEntry {
  cachedEntry ??= buildSkillEntry(skillFiles(), parseSkillFrontmatter(skillMarkdown()));
  return cachedEntry;
}

export function buildSkillManifest(list: readonly SkillFile[], version: string, zip: Uint8Array = buildSkillZip(list), provenance: SkillProvenance | null = null): SkillManifest {
  return {
    name: SKILL_NAME, version, uri: `${SKILL_URI_PREFIX}SKILL.md`,
    files: list.map((f) => ({ path: f.path, uri: `${SKILL_URI_PREFIX}${f.path}`, size: f.size, digest: `sha256:${f.sha256}` })),
    files_digest: filesDigest(list),
    archive: { name: `${SKILL_NAME}.zip`, size: zip.length, digest: `sha256:${sha256(zip)}` },
    ...(provenance ? { provenance } : {}),
  };
}

export const skillManifestBytes = (m: SkillManifest): Uint8Array => new TextEncoder().encode(JSON.stringify(m));

export const skillSignatureFiles = (version: string): { provenance: string; signature: string } =>
  ({ provenance: `${SKILL_NAME}-${version}.provenance.json`, signature: `${SKILL_NAME}-${version}.manifest.json.sig` });

export function readSkillProvenance(version: string, dir: string = SKILL_SIGNATURES_DIR): SkillProvenance | null {
  let text: string;
  try {
    text = readFileSync(join(dir, skillSignatureFiles(version).provenance), "utf8");
  } catch {
    return null;
  }
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).join() !== "source_commit" || !/^[0-9a-f]{40}$/.test(String((v as SkillProvenance).source_commit)))
    throw new Error(`memory skill: ${skillSignatureFiles(version).provenance} must be {"source_commit": "<40 hex>"}`);
  return { source_commit: (v as SkillProvenance).source_commit };
}

export function readSkillSignature(version: string, dir: string = SKILL_SIGNATURES_DIR): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(join(dir, skillSignatureFiles(version).signature)));
  } catch {
    return null;
  }
}

let cachedManifest: SkillManifest | undefined;
export function skillManifest(): SkillManifest {
  cachedManifest ??= buildSkillManifest(skillFiles() as SkillFile[], skillVersion(), skillZip(), readSkillProvenance(skillVersion()));
  return cachedManifest;
}

let cachedSignature: Uint8Array | null | undefined;
export function skillSignature(): Uint8Array | null {
  if (cachedSignature === undefined) cachedSignature = readSkillSignature(skillVersion());
  return cachedSignature;
}
