import { CHAIN_TREE } from "./version-chain.ts";
import { OPEN_CHECK_MAX_FINDINGS, type OpenCheckFinding, type OpenCheckText } from "./open-check.ts";
import { PROJECT_TAG_ROLE } from "./project-entity.ts";
import { DEFAULT_LEGACY_CHARSET, LEGACY_SCAN_CHARSETS, legacyCharsetOrNull, recordText, type LegacyCharset } from "./record-text.ts";

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

/**
 * The text of a file: UTF-8 (strict; a byte-order mark is dropped), UTF-16 by its mark, otherwise the configured legacy
 * code page (`legacy`, textCharset).
 */
export function decodeText(bytes: Uint8Array, legacy: LegacyCharset = DEFAULT_LEGACY_CHARSET): string {
  return decodeVariants(bytes, legacy)[0]!;
}

/**
 * Every plausible reading of a file, the stored one (decodeText) first. UTF-8 cut inside a character or with a stray
 * byte is stored as UTF-8 when under 1 % of the sequences are broken, and the legacy reading is checked as well;
 * otherwise the legacy reading is stored and the lossy UTF-8 one is checked when it has non-Latin letters. On the legacy
 * branch the open check also reads `extra` code pages (a record's stored page, LEGACY_SCAN_CHARSETS); they never change
 * the stored text.
 */
export function decodeVariants(bytes: Uint8Array, legacy: LegacyCharset = DEFAULT_LEGACY_CHARSET, extra: readonly string[] = LEGACY_SCAN_CHARSETS): string[] {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return [new TextDecoder("utf-16le").decode(bytes.subarray(2))];
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return [new TextDecoder("utf-16be").decode(bytes.subarray(2))];
  try { return [new TextDecoder("utf-8", { fatal: true }).decode(bytes)]; }
  catch {
    const loose = new TextDecoder("utf-8").decode(bytes), cp = new TextDecoder(legacy).decode(bytes);
    const broken = (loose.match(/\uFFFD/g) ?? []).length;
    // the lossy UTF-8 reading is worth checking only when it has letters beyond Latin (otherwise it is ASCII and "\uFFFD")
    const out = broken <= Math.max(1, loose.length / 100) ? [loose, cp] : /[^\p{ASCII}\uFFFD]/u.test(loose) ? [cp, loose] : [cp];
    for (const page of new Set(extra.map(legacyCharsetOrNull))) {
      if (page === null || page === legacy) continue;
      const t = new TextDecoder(page).decode(bytes);
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }
}

const JSON_MIME = /^application\/(json|x-ndjson)\b/i;
const JSON_ESCAPE = /\\u[0-9a-fA-F]{4}/;
const JSON_DEPTH = 64, JSON_NODES = 2_000_000;
export interface JsonWalkLimits { depth: number; nodes: number }

function jsonLines(root: unknown, out: string[], limits: JsonWalkLimits): boolean {
  const stack: Array<{ v: unknown; key: string | null; depth: number }> = [{ v: root, key: null, depth: 0 }];
  let cut = false, nodes = 0;
  for (; stack.length && nodes < limits.nodes; nodes++) {
    const { v, key, depth } = stack.pop()!;
    if (v !== null && typeof v === "object") {
      if (key !== null) out.push(key);
      if (depth >= limits.depth) { cut ||= (Array.isArray(v) ? v.length : Object.keys(v).length) > 0; continue; }
      const entries: Array<[string | null, unknown]> = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) stack.push({ v: entries[i]![1], key: entries[i]![0], depth: depth + 1 });
    } else if (v !== null && v !== undefined) out.push(key !== null ? `${key}: ${String(v)}` : String(v));
    else if (key !== null) out.push(key);
  }
  return cut || stack.length > 0;
}

const unescapeJson = (s: string): string => s.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_m, hex: string | undefined, c: string | undefined) =>
  hex ? String.fromCharCode(parseInt(hex, 16)) : ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[c!] ?? c!);

function parseJsonText(s: string, ndjson: boolean): unknown[] | null {
  try { return [JSON.parse(s)]; } catch { }
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (!ndjson && !(lines.length > 1 && lines.every((l) => /^\s*[[{]/.test(l)))) return null;
  try { return lines.map((l) => JSON.parse(l)); } catch { return null; }
}

export function jsonTextVariants(s: string | null | undefined, mime?: string | null,
                                 limits: JsonWalkLimits = { depth: JSON_DEPTH, nodes: JSON_NODES }): string[] {
  if (typeof s !== "string" || !JSON_ESCAPE.test(s)) return [];
  const byMime = JSON_MIME.test(String(mime ?? ""));
  if (!byMime && !/^\s*[[{]/.test(s)) return [];
  const parsed = parseJsonText(s, /x-ndjson/i.test(String(mime ?? "")));
  const out: string[] = [];
  let cut = !parsed;
  if (parsed) { const lines: string[] = []; for (const v of parsed) cut = jsonLines(v, lines, limits) || cut; out.push(lines.join("\n")); }
  if (cut) out.push(unescapeJson(s));
  return [...new Set(out)].filter((v) => v.trim() && v !== s);
}

const TEXT_ORIGINAL = /^(text\/|application\/(json|x-subrip|x-ndjson)\b)/i;
const TEXT_ORIGINAL_SQL = "^(text/|application/(json|x-subrip|x-ndjson))";
export const TEXT_ORIGINAL_MAX = 25 * 1_048_576;
export const TREE_CHECK_MAX_CHARS = 48 * 1024 * 1024;
export const treeTooLarge = (size: { chars?: unknown; original_bytes?: unknown } | undefined): boolean => {
  const n = Number(size?.chars ?? 0) + Number(size?.original_bytes ?? 0);
  return Number.isFinite(n) && n > TREE_CHECK_MAX_CHARS;
};

export type OpenCheckUnchecked = "timeout" | "busy" | "conversion_pending" | "conversion_failed" | "empty_text" | "partial_text" | "original_unavailable" | "original_too_large" | "tree_too_large" | "check_failed";

export const OPEN_CHECK_UNCHECKED: Record<OpenCheckUnchecked, string> = {
  timeout: "content check timed out",
  conversion_pending: "document conversion is still in progress. Its text cannot be checked yet",
  conversion_failed: "document conversion failed. There is no text to check",
  empty_text: "no text was recognized in the document, so it cannot be checked",
  partial_text: "some pages are scans or images and could not be checked",
  original_unavailable: "the original file cannot be read from storage right now, so it cannot be checked",
  original_too_large: `the text original exceeds ${TEXT_ORIGINAL_MAX / 1_048_576} MB and cannot be checked in full`,
  tree_too_large: "the record and its edit history are too large to check in full",
  check_failed: "content check did not complete",
  busy: "check server is busy. Try again in a minute",
};

export interface TreeTextSources {
  records: Queryable;
  control: Queryable;
  original?: (key: string) => Promise<Buffer | null>;
  legacyCharset?: LegacyCharset;                                 // configured legacy code page (legacyCharsetOf); default windows-1252
  scanCharsets?: readonly string[];                              // extra scan pages (legacyScanCharsetsOf); default LEGACY_SCAN_CHARSETS
}

/** The tree and the version chain (agent notes or documents, chainLinkSql): an older version moves and opens with the head. */
const TREE = CHAIN_TREE;

export async function openTreeTooLarge(src: Pick<TreeTextSources, "records">, id: string, opts: { live: boolean }): Promise<boolean> {
  const size = (await src.records.query(
    `${TREE} SELECT count(*)::bigint AS n, COALESCE(sum(length(c.text)), 0)::bigint AS chars,
            COALESCE(sum(CASE WHEN c.original_key IS NOT NULL AND c.original_mime ~* '${TEXT_ORIGINAL_SQL}' AND c.original_bytes <= ${TEXT_ORIGINAL_MAX}
                              THEN c.original_bytes ELSE 0 END), 0)::bigint AS original_bytes
       FROM records r LEFT JOIN record_content c ON c.record_id = r.id
      WHERE r.id IN (SELECT id FROM tree)${opts.live ? " AND r.deleted_at IS NULL" : ""}`, [id])).rows[0];
  return treeTooLarge(size);
}

/**
 * The texts of a tree for the open check. `uncheckedVersion` — an older version of a document chain has no checked text
 * — whatever the head's own reason in `unchecked`: showing "text only" relaxes the head alone, so it cannot help.
 */
export interface OpenTreeTexts { texts: OpenCheckText[]; unchecked: OpenCheckUnchecked | null; uncheckedVersion?: true }

export async function openTreeTexts(src: TreeTextSources, id: string, opts: { live: boolean; targetSpaceId?: string; textOnly?: boolean }): Promise<OpenTreeTexts> {
  if (await openTreeTooLarge(src, id, opts)) return { texts: [], unchecked: "tree_too_large" };
  const rows = (await src.records.query(
    `${TREE} SELECT r.id, r.space_id, r.type, r.title, r.summary_line, r.source_ref, r.attrs->>'filename' AS filename, r.attrs->>'original_charset' AS original_charset, r.attrs->'conversion'->>'status' AS conversion,
            r.id IN (SELECT id FROM chain) AS in_chain,
            r.attrs->'conversion'->>'extraction_state' AS extraction, r.attrs->'participants_unresolved' AS unresolved, c.text, c.original_key, c.original_mime, c.original_bytes
       FROM records r LEFT JOIN record_content c ON c.record_id = r.id
      WHERE r.id IN (SELECT id FROM tree)${opts.live ? " AND r.deleted_at IS NULL" : ""}`, [id])).rows;
  const texts: OpenCheckText[] = [], seen = new Set<string>();
  const add = (field: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim() || seen.has(`${field}\0${value}`)) return;
    seen.add(`${field}\0${value}`); texts.push({ field, value });
  };
  const addJson = (field: string, value: unknown, mime?: string | null) => {
    for (const v of jsonTextVariants(value as string, mime)) if (!texts.some((t) => t.value === v)) add(field, v);
  };
  // Why a document row cannot be checked: the head's reason first, then an older version's, then an original's (below)
  const docUnchecked = (r: { conversion?: string | null; extraction?: string | null; text?: string | null }, textOnly: boolean): OpenCheckUnchecked | null =>
    r.conversion === "pending" ? "conversion_pending" : r.conversion === "failed" ? "conversion_failed"
      : r.extraction === "unavailable" || !String(r.text ?? "").replace(/<!--\s*page:\s*\d+\s*-->/gu, "").trim() ? "empty_text"
      : r.extraction === "partial" && !textOnly ? "partial_text" : null;
  let headUnchecked: OpenCheckUnchecked | null = null, versionUnchecked: OpenCheckUnchecked | null = null, unchecked: OpenCheckUnchecked | null = null;
  for (const r of rows) {
    if (r.id === id) {
      add("title", r.title); add("text", r.text); add("summary", r.summary_line); add("source", r.source_ref); add("filename", r.filename);
      addJson("text", r.text);
      if (Array.isArray(r.unresolved)) add("participants", r.unresolved.map(String).join("\n"));
      if (r.type === "document") headUnchecked = docUnchecked(r, opts.textOnly === true);
    } else {
      add("derived", [r.title, r.summary_line, r.source_ref, r.text].filter((x) => typeof x === "string" && x.trim()).join("\n")); addJson("derived", r.text);
      // Another version of the chain: it moves to the open class with the head, file included, so its file
      // name is checked and a document version without a checked text refuses the whole chain. "Text only" keeps only the
      // head's file in the closed bucket, so a partly scanned older version is refused even then.
      if (r.in_chain === true) {
        add("filename", r.filename);
        if (r.type === "document") versionUnchecked ??= docUnchecked(r, false);
      }
    }
    if (src.original && r.original_key && TEXT_ORIGINAL.test(String(r.original_mime ?? ""))) {
      if (Number(r.original_bytes ?? 0) > TEXT_ORIGINAL_MAX) { unchecked ??= "original_too_large"; continue; }
      const body = await src.original(r.original_key).catch(() => undefined);
      if (body === undefined) { unchecked ??= "original_unavailable"; continue; }
      const legacy = src.legacyCharset ?? DEFAULT_LEGACY_CHARSET;
      for (const t of body ? decodeVariants(body, legacy, [String(r.original_charset ?? ""), ...(src.scanCharsets ?? LEGACY_SCAN_CHARSETS)]) : []) {
        if (recordText(t) !== r.text) add(r.id === id ? "original" : "derived", t);
        addJson(r.id === id ? "original" : "derived", t, r.original_mime);
      }
    }
  }
  // an older version has no checked text: "text only" cannot relax it, the hint must not offer
  // it — even when the head has a reason of its own, which `unchecked` reports first
  const fromVersion = versionUnchecked !== null;
  unchecked = headUnchecked ?? versionUnchecked ?? unchecked;
  const ids = rows.map((r) => r.id);
  const links = ids.length ? (await src.records.query("SELECT DISTINCT record_id, entity_id, role FROM record_entities WHERE record_id = ANY($1::uuid[])", [ids])).rows : [];
  if (links.length) {
    const entities = (await src.control.query("SELECT id, display_name, attrs FROM entities WHERE id = ANY($1::uuid[])", [[...new Set(links.map((e) => e.entity_id))]])).rows;
    const homes = new Map(rows.map((r) => [r.id, r.space_id]));
    const names = entities.filter((entity) => links.some((link) => link.entity_id === entity.id
      && entityNameNeedsOpenCheck(link.role, entity.attrs?.space_id, opts.targetSpaceId ?? homes.get(link.record_id))))
      .map((entity) => entity.display_name);
    add("entities", names.filter(Boolean).join("\n"));
  }
  return { texts, unchecked, ...(fromVersion ? { uncheckedVersion: true as const } : {}) };
}

export function entityNameNeedsOpenCheck(role: string | undefined, entitySpaceId: string | null | undefined, homeSpaceId: string | null | undefined): boolean {
  return role !== PROJECT_TAG_ROLE || !entitySpaceId || entitySpaceId !== homeSpaceId;
}

export const JOINED_FIELD = "\u0000joined";
const JOINED = ["title", "summary", "text"];
const JOINED_HEAD = 4096;

export function joinedTexts(texts: OpenCheckText[]): { texts: OpenCheckText[]; map: (found: OpenCheckFinding[]) => OpenCheckFinding[] } {
  const parts = JOINED.map((f) => texts.find((t) => t.field === f && typeof t.value === "string" && t.value.trim()))
    .filter((t): t is OpenCheckText & { value: string } => !!t).map((t) => ({ field: t.field, value: t.value.slice(0, JOINED_HEAD) }));
  if (parts.length < 2) return { texts, map: (found) => found };
  const spans: Array<{ field: string; start: number }> = [];
  let pos = 0;
  for (const p of parts) { spans.push({ field: p.field, start: pos }); pos += p.value.length + 1; }
  const map = (found: OpenCheckFinding[]) => {
    const key = (f: OpenCheckFinding) => `${f.rule}\u0000${f.field}\u0000${f.at}`;
    const dedupe = found.length < OPEN_CHECK_MAX_FINDINGS;
    const out = found.filter((f) => f.field !== JOINED_FIELD), seen = new Set(out.map(key));
    for (const f of found) {
      if (f.field !== JOINED_FIELD) continue;
      const span = [...spans].reverse().find((s) => f.at >= s.start) ?? spans[0]!;
      const m = { ...f, field: span.field, at: f.at - span.start };
      if (!dedupe || !seen.has(key(m))) { seen.add(key(m)); out.push(m); }
    }
    return out;
  };
  return { texts: [...texts, { field: JOINED_FIELD, value: parts.map((p) => p.value).join("\n") }], map };
}
