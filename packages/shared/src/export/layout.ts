// Paths inside an export archive (format prisma-memory-export/1, contracts/export/README.md). Every entry name is built
// here from a space slug, a record type, a UTC year and month, a record id and — for originals only — the stored file
// name passed through safeEntryName: no "/", no "..", no control characters, never absolute.
import { safeFileName } from "../record-text.ts";
import { recordPath } from "../ids.ts";

export const EXPORT_FORMAT = "prisma-memory-export/1";

const SLUG_SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_SAFE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_SAFE = /^[a-z_]{1,32}$/;
/** Longest file name of an original inside the archive, in UTF-8 bytes (file systems allow 255 per component). */
export const ENTRY_NAME_MAX_BYTES = 200;

/** Truncate to at most `max` UTF-8 bytes without cutting a code point. */
function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "", n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (n + b > max) break;
    out += ch; n += b;
  }
  return out;
}

/**
 * One path component from an untrusted file name: safeFileName (letters, marks, digits, "._-"; everything else "_"),
 * leading dots removed (so "." and ".." cannot appear), at most ENTRY_NAME_MAX_BYTES bytes with the extension kept,
 * "original" when nothing is left.
 */
export function safeEntryName(name: string | null | undefined): string {
  let s = safeFileName(String(name ?? "")).replace(/^\.+/, "");
  if (Buffer.byteLength(s, "utf8") > ENTRY_NAME_MAX_BYTES) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    s = truncateBytes(s.slice(0, ext ? dot : s.length), ENTRY_NAME_MAX_BYTES - Buffer.byteLength(ext, "utf8")) + ext;
  }
  return s.replace(/^\.+/, "") || "original";
}

const slugPart = (slug: string): string => (SLUG_SAFE.test(slug) ? slug : safeEntryName(slug));
const idPart = (id: string): string => (UUID_SAFE.test(id) ? id.toLowerCase() : safeEntryName(id));
const typePart = (type: string): string => (TYPE_SAFE.test(type) ? type : safeEntryName(type));

/** The path agents cite for a record: /spaces/<slug>/<type>/<yyyy>/<mm>/<id> (recordPath, UTC). */
export const citationPath = (slug: string, type: string, occurredAt: Date | string, id: string): string =>
  recordPath(slugPart(slug), typePart(type), occurredAt, idPart(id));

/** Archive path of a record without the extension: spaces/<slug>/<type>/<yyyy>/<mm>/<id> (".md" and ".json" are added). */
export const recordEntryBase = (slug: string, type: string, occurredAt: Date | string, id: string): string =>
  citationPath(slug, type, occurredAt, id).slice(1);

/** Archive path of a record's original: spaces/<slug>/originals/<id>/<safe file name>. */
export const originalEntry = (slug: string, id: string, fileName: string | null | undefined): string =>
  `spaces/${slugPart(slug)}/originals/${idPart(id)}/${safeEntryName(fileName)}`;

/** Archive path of the space description. */
export const spaceEntry = (slug: string): string => `spaces/${slugPart(slug)}/space.json`;

/** Download file name: prisma-memory-<slug>-<YYYY-MM-DD>.tar.gz (slug and the UTC date only). */
export const archiveFileName = (slug: string, at: Date): string => `prisma-memory-${slugPart(slug)}-${at.toISOString().slice(0, 10)}.tar.gz`;

/**
 * File name of a whole-instance export on the server: prisma-memory-export-<instance>-<YYYYMMDD>T<HHMMSS>Z.tar.gz — the
 * instance id made one safe path component, the UTC time to the second (two runs a second apart get two files).
 */
export const instanceArchiveFileName = (instance: string, at: Date): string =>
  `prisma-memory-export-${safeEntryName(instance)}-${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z.tar.gz`;
