// A record of the memory export: Markdown with a YAML front matter (<id>.md) and full JSON metadata (<id>.json), format
// prisma-memory-export/1 (contracts/export/record.schema.json). Only data the requester may read reaches this module;
// what it writes out of `attrs` is an allow-list — fingerprints and marks of the open check, storage keys, signed links
// and processing internals never leave.

/** One record as the export source hands it over (values already resolved: logins, slugs, entity keys). */
export interface ExportRecord {
  id: string;
  type: string;
  event_kind: string | null;
  title: string | null;
  summary_line?: string | null;
  space: string;
  class: "open" | "closed";
  origin: string | null;
  method: string | null;
  source_kind: string | null;
  source_ref: string | null;
  occurred_at: Date | string;
  ingested_at: Date | string | null;
  owner: string | null;
  version: number;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  is_current: boolean;
  /**
   * Hidden from everyone when it was exported (mid class move, or held back after a failed check): only the
   * whole-instance export writes such records; the field is left out otherwise.
   */
  hidden?: boolean;
  parent_id: string | null;
  derived: string[];
  domains: string[];
  entities: Array<{ ref: string; display_name: string | null; role: string | null }>;
  people: string[];
  audience: string;
  confirmed: boolean;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  attrs: Record<string, unknown> | null;
  corrections: Array<{ id: string; kind: string; status: string; result_id: string | null; created_at: Date | string | null }>;
}

/** The original file of a record as written to the archive. */
export interface ExportOriginalMeta {
  /** Archive path of the file; null when the file is missing. */
  entry: string | null;
  name: string | null;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
  pages: number | null;
  duration_sec: number | null;
  /** The stored file could not be read (storage lost it): the record is exported without it. */
  missing?: true;
  /**
   * The file exists but is not in the archive: `unchecked` — an open record whose conversion and check are not done;
   * `excluded` — the whole-instance export was asked to leave every original out (--no-originals).
   */
  withheld?: "unchecked" | "excluded";
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const hex4 = (cp: number): string => `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * A YAML double-quoted scalar that every YAML 1.1 and 1.2 reader reads back as the same string: quotes and backslashes
 * escaped, line breaks and every character outside the printable set of YAML (C0, DEL, C1, U+2028, U+2029, U+FEFF,
 * U+FFFE, U+FFFF) written as escapes; a lone surrogate becomes U+FFFD. A title such as "---" or "!!python/object" stays a plain string.
 */
export function yamlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff || cp === 0xfffe || cp === 0xffff) out += hex4(cp);
    else if (cp >= 0xd800 && cp <= 0xdfff) out += "\uFFFD";
    else out += ch;
  }
  return `${out}"`;
}

const yamlValue = (v: string | number | boolean | null): string =>
  v === null ? "null" : typeof v === "string" ? yamlString(v) : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "null") : v ? "true" : "false";

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The allow-list of `attrs` the archive carries: filename, meeting_id, participants, transcript_format,
 * consent{version, accepted_at, by}, actors, conversion{status, profile}. Everything else stays in the database.
 */
export function pickAttrs(attrs: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const a = plainObject(attrs) ? attrs : {};
  const out: Record<string, unknown> = {};
  for (const k of ["filename", "meeting_id", "participants", "transcript_format", "actors"] as const) if (a[k] !== undefined) out[k] = a[k];
  if (plainObject(a.consent)) {
    const c: Record<string, unknown> = {};
    for (const k of ["version", "accepted_at", "by"] as const) if (a.consent[k] !== undefined) c[k] = a.consent[k];
    out.consent = c;
  }
  if (plainObject(a.conversion)) {
    const c: Record<string, unknown> = {};
    for (const k of ["status", "profile"] as const) if (a.conversion[k] !== undefined) c[k] = a.conversion[k];
    out.conversion = c;
  }
  return out;
}

/** <id>.md: front matter (id, path, title, type, event_kind, class, origin, occurred_at, version), then the text. */
export function renderMarkdown(r: ExportRecord, path: string, text: string | null): string {
  const fm: Array<[string, string | number | boolean | null]> = [
    ["id", r.id], ["path", path], ["title", r.title ?? null], ["type", r.type], ["event_kind", r.event_kind],
    ["class", r.class], ["origin", r.origin], ["occurred_at", iso(r.occurred_at)], ["version", r.version],
  ];
  const body = text ?? r.summary_line ?? "";
  return `---\n${fm.map(([k, v]) => `${k}: ${yamlValue(v)}`).join("\n")}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

/** <id>.json: the full metadata of record.schema.json. */
export function renderRecordJson(r: ExportRecord, path: string, original: ExportOriginalMeta | null): Record<string, unknown> {
  return {
    id: r.id, path, type: r.type, event_kind: r.event_kind, title: r.title ?? null, space: r.space, class: r.class,
    origin: r.origin, method: r.method, source_kind: r.source_kind, source_ref: r.source_ref,
    occurred_at: iso(r.occurred_at), ingested_at: iso(r.ingested_at), owner: r.owner,
    version: r.version, supersedes_id: r.supersedes_id, superseded_by_id: r.superseded_by_id, is_current: r.is_current,
    ...(r.hidden === true ? { hidden: true } : {}),
    parent_id: r.parent_id, derived: [...r.derived], domains: [...r.domains],
    entities: r.entities.map((e) => ({ ref: e.ref, display_name: e.display_name, role: e.role })),
    people: [...r.people], audience: r.audience, confirmed: r.confirmed,
    valid_from: iso(r.valid_from), valid_to: iso(r.valid_to),
    original: original ? {
      file: original.entry, name: original.name, mime: original.mime, bytes: original.bytes, sha256: original.sha256, pages: original.pages,
      duration_sec: original.duration_sec, ...(original.missing ? { missing: true } : {}), ...(original.withheld ? { withheld: original.withheld } : {}),
    } : null,
    corrections: r.corrections.map((c) => ({ id: c.id, kind: c.kind, status: c.status, result_id: c.result_id, created_at: iso(c.created_at) })),
    attrs: pickAttrs(r.attrs),
  };
}
