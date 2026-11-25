/**
 * Prisma Memory · prompts as code — a port of the reference Python implementation.
 *
 * A prompt is a file `contracts/pipeline/prompts/<stage>-v<N>.md`: a YAML header (stage, version, schema, model,
 * budgets), sections `## system` and `## user` (a template with `{{name}}` placeholders). Here: load, fill-in
 * and source protection: the transcript or document content is wrapped in `<source id sha256>` and defanged
 * (chat-template tokens, the closing tag), so the text cannot «leave» the data role. Here too —
 * the model answer before schema validation: `collapseRepeats` (output schemas lack `uniqueItems`; uniqueness
 * is the code's).
 *
 * Prompt and schema files are not copied: they are read from the repository's `contracts/pipeline` (root by
 * module place or arg).
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { matchFrontMatter } from "./chunker.ts";
import { pipelineText } from "./verify.ts";
const {
  PY_WORD_CLASS, PY_WS_CLASS, cmpCodePoints, escapeRegExp, isWellFormed, pyEquals, pyReprList, pyRstrip, pySplitOnce,
  pySplitlines, pyStrip, pyStripChars, readTextUtf8,
} = pipelineText.pytext;

// ---------------------------------------------------------------- contracts

/** Repository root by module location: `packages/workers/src/pipeline` → four levels up. */
export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** `<root>/contracts/pipeline`; an argument overrides the root (another directory layout in the image). */
export function pipelineContractsDir(repoRoot: string = defaultRepoRoot()): string {
  return join(repoRoot, "contracts", "pipeline");
}

export function promptsDir(repoRoot?: string): string {
  return join(pipelineContractsDir(repoRoot), "prompts");
}

export function schemasDir(repoRoot?: string): string {
  return join(pipelineContractsDir(repoRoot), "schemas");
}

// ---------------------------------------------------------------- template

const PLACEHOLDER = new RegExp(`\\{\\{([${PY_WORD_CLASS}]+)\\}\\}`, "gu");

/**
 * A case-insensitive literal — as `re.I` in Python for str: besides the lower/upper pair, `i` matches
 * İ (U+0130) and ı (U+0131), `s` — ſ (U+017F). The JS `i` flag gives another set, so classes are written out.
 */
function ci(literal: string): string {
  return Array.from(literal, (ch) => {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo === "i") return "[iI\\u0130\\u0131]";
    if (lo === "s") return "[sS\\u017f]";
    return lo !== up ? `[${lo}${up}]` : escapeRegExp(ch);
  }).join("");
}

const CHAT_TOKENS = ["im_start", "im_end", "endoftext", "system", "user", "assistant", "eot_id", "start_header_id", "end_header_id"];

const DEFANG: ReadonlyArray<readonly [RegExp, (...groups: string[]) => string]> = [
  [new RegExp(`<\\|(${CHAT_TOKENS.map(ci).join("|")})\\|>`, "gu"), (_m, name) => `‹|${name}|›`],
  // Python `\b` — a boundary by Unicode `\w`: no letter, digit or `_` may follow `source`
  [new RegExp(`</?${ci("source")}(?![${PY_WORD_CLASS}])`, "gu"), () => "‹source"],
  [new RegExp([ci("[INST]"), ci("[/INST]"), ci("<<SYS>>"), ci("<</SYS>>")].join("|"), "gu"), () => "‹inst›"],
];

/** Defangs chat template tokens and the `</source>` tag inside the source content. */
export function defang(text: string): string {
  let out = text;
  for (const [rx, repl] of DEFANG) out = out.replace(rx, repl);
  return out;
}

/** Content → [defanged text, sha256 of the source UTF-8 bytes] for template substitution. */
export function sourceBlock(_sourceId: string, content: string): [text: string, sha256: string] {
  if (!isWellFormed(content)) throw new TypeError("source content cannot be encoded in UTF-8: unpaired surrogate");
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return [defang(content), digest];
}

// ---------------------------------------------------------------- prompt

export class Prompt {
  readonly stage: string;
  readonly version: string;
  /** absolute path of the output schema */
  readonly outputSchema: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly system: string;
  readonly userTemplate: string;
  readonly path: string;

  constructor(init: {
    stage: string; version: string; outputSchema: string; meta: Readonly<Record<string, string>>;
    system: string; userTemplate: string; path: string;
  }) {
    this.stage = init.stage;
    this.version = init.version;
    this.outputSchema = init.outputSchema;
    this.meta = init.meta;
    this.system = init.system;
    this.userTemplate = init.userTemplate;
    this.path = init.path;
    Object.freeze(this);
  }

  /** Placeholder names `{{name}}` of the user template. */
  get placeholders(): Set<string> {
    return new Set(Array.from(this.userTemplate.matchAll(PLACEHOLDER), (m) => m[1] as string));
  }
}

// `^## (system|user)\s*$` with re.M: Python `^` and `$` see only `\n` (JS with `m` also \r, U+2028, U+2029)
const SECTION = new RegExp(`(?<![^\\n])## (system|user)[${PY_WS_CLASS}]*(?![^\\n])`, "gu");

/** Loads a prompt from `<version>.md`: header, sections, consistency checks — as `load_prompt` of the reference. */
export function loadPrompt(path: string): Prompt {
  const text = readTextUtf8(path);
  const fm = matchFrontMatter(text);
  if (!fm) throw new Error(`${path}: missing YAML front matter`);
  const entries: Array<[string, string]> = [];
  for (const raw of pySplitlines(fm.block)) {
    const line = pyRstrip(pySplitOnce(raw, "  #")[0]); // comments after two spaces
    if (line.includes(":") && !line.startsWith(" ")) {
      const [k, v] = pySplitOnce(line, ":") as [string, string];
      entries.push([pyStrip(k), pyStripChars(pyStrip(v), "'\"")]);
    }
  }
  const meta: Record<string, string> = Object.fromEntries(entries);
  const body = text.slice(fm.end);

  const parts = new Map<string, string>();
  const heads = Array.from(body.matchAll(SECTION));
  heads.forEach((m, k) => {
    const from = (m.index as number) + m[0].length;
    const next = heads[k + 1];
    parts.set(m[1] as string, pyStrip(body.slice(from, next ? next.index : body.length)));
  });
  if (!parts.has("system") || !parts.has("user")) throw new Error(`${path}: sections '## system' and '## user' are required`);
  for (const key of ["stage", "version", "output_schema"]) {
    if (!Object.hasOwn(meta, key)) throw new Error(`${path}: front matter is missing ${key}`);
  }
  const version = meta["version"] as string;
  if (version !== basename(path, extname(path))) {
    throw new Error(`${path}: version in the front matter (${version}) must match the file name`);
  }
  const schema = resolve(dirname(path), meta["output_schema"] as string);
  if (!existsSync(schema)) throw new Error(`${path}: schema ${schema} was not found`);
  return new Prompt({
    stage: meta["stage"] as string, version, outputSchema: realpathSync(schema), meta: Object.freeze(meta),
    system: parts.get("system") as string, userTemplate: parts.get("user") as string, path,
  });
}

/** A prompt by version (`events-v4`) from the repository's prompts directory. */
export function loadPromptVersion(version: string, repoRoot?: string): Prompt {
  return loadPrompt(join(promptsDir(repoRoot), `${version}.md`));
}

/** The model output JSON schema of a prompt (guided decoding, answer check). */
export function loadOutputSchema(prompt: Prompt): Record<string, unknown> {
  return JSON.parse(readTextUtf8(prompt.outputSchema)) as Record<string, unknown>;
}

/** Placeholder fill-in: extra or missing ones are errors (template and code change as one). */
export function renderUser(prompt: Prompt, values: Readonly<Record<string, string>>): string {
  const wanted = prompt.placeholders;
  const given = Object.keys(values);
  const missing = [...wanted].filter((k) => !Object.hasOwn(values, k)).sort(cmpCodePoints);
  const extra = given.filter((k) => !wanted.has(k)).sort(cmpCodePoints);
  if (missing.length || extra.length) {
    throw new Error(`${basename(prompt.path)}: missing ${pyReprList(missing)}, unexpected ${pyReprList(extra)}`);
  }
  return prompt.userTemplate.replace(PLACEHOLDER, (_m, name: string) => String(values[name]));
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Messages for chat completions via the model gateway */
export function buildMessages(prompt: Prompt, values: Readonly<Record<string, string>>): ChatMessage[] {
  return [{ role: "system", content: prompt.system }, { role: "user", content: renderUser(prompt, values) }];
}

// ---------------------------------------------------------------- model answer, pre-check

/**
 * Repeats in model answer arrays collapse at any depth (the first occurrence stays, the order is kept;
 * equality by value, as `==` in the reference). Output schemas do not use `uniqueItems` — the platform grammar engine
 * does not implement it; this code keeps the items unique.
 */
export function collapseRepeats(data: unknown): unknown {
  if (Array.isArray(data)) {
    const out: unknown[] = [];
    for (const raw of data) {
      const item = collapseRepeats(raw);
      if (!out.some((x) => pyEquals(x, item))) out.push(item);
    }
    return out;
  }
  if (data && typeof data === "object") {
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, collapseRepeats(v)]));
  }
  return data;
}
