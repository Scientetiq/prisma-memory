// Skill package description (contracts/skills/bundle.json): the one place for the skill name, its folder, the signing
// namespace of the manifest and the prefix of its MCP resources. The gateway routes, the MCP resources and skills/list
// entry, the archive, the manifest and the install phrase are built from it; the file is read once, when the module is
// loaded, from the contracts folder of the process (MEMORY_CONTRACTS_DIR, as mcp-tools.json). A missing or malformed
// description stops the process at start: serving the skill under a guessed name is worse than not starting.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACTS_DIR } from "./contracts.ts";

export interface SkillBundle {
  /** Skill name: `name` of the SKILL.md header, the top folder of the archive, the segment of the routes and addresses. */
  name: string;
  /** Folder of the skill tree, relative to the repository root and under `contracts/`. */
  dir: string;
  /** Namespace of the manifest signature (ssh-keygen -Y sign -n …). */
  signature_namespace: string;
  /** Prefix of the MCP resources of the skill: `skill://<name>/`. */
  uri_prefix: string;
  /** Locale of the tree that is served by default (BCP 47 language, optionally with a region). */
  default_locale: string;
}

/** Name of a skill (as skill-creator and SEP-2640 accept it): lowercase letters and digits, words joined by hyphens. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEYS = ["name", "dir", "signature_namespace", "uri_prefix", "default_locale"] as const;

/** Check the description (the object of bundle.json) and return its fields; anything off — an error naming the field. */
export function parseSkillBundle(data: unknown): SkillBundle {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("skill bundle: not a JSON object");
  const d = data as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => k !== "$comment" && !(KEYS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`skill bundle: unknown fields ${extra.join(", ")}`);
  for (const k of KEYS) if (typeof d[k] !== "string") throw new Error(`skill bundle: ${k} is not a string`);
  const b = Object.fromEntries(KEYS.map((k) => [k, d[k] as string])) as unknown as SkillBundle;
  if (!SKILL_NAME_RE.test(b.name) || b.name.length > 64) throw new Error("skill bundle: name — lowercase letters, digits and hyphens, up to 64");
  const segs = b.dir.split("/");
  if (segs[0] !== "contracts" || segs.length < 2 || !segs.slice(1).every((s) => SEGMENT_RE.test(s) && s !== "." && s !== ".."))
    throw new Error("skill bundle: dir — a folder under contracts/, plain segments only");
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(b.signature_namespace)) throw new Error("skill bundle: signature_namespace — letters, digits, . _ @ -");
  if (b.uri_prefix !== `skill://${b.name}/`) throw new Error("skill bundle: uri_prefix — skill://<name>/");
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(b.default_locale)) throw new Error("skill bundle: default_locale — a language code such as en or en-US");
  return b;
}

/** Path of the description in the contracts folder. */
export const skillBundleFile = (contractsDir: string = CONTRACTS_DIR): string => resolve(contractsDir, "skills", "bundle.json");

/** Read and check the description of a contracts folder. */
export function readSkillBundle(contractsDir: string = CONTRACTS_DIR): SkillBundle {
  const file = skillBundleFile(contractsDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`skill bundle: no ${file}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`skill bundle: ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return parseSkillBundle(data);
}

/** Absolute folder of the skill tree: `dir` without `contracts/`, under the contracts folder of the process. */
export const skillBundleDir = (b: SkillBundle, contractsDir: string = CONTRACTS_DIR): string =>
  resolve(contractsDir, ...b.dir.split("/").slice(1));

/** The description of this process. */
export const SKILL_BUNDLE: Readonly<SkillBundle> = Object.freeze(readSkillBundle());
