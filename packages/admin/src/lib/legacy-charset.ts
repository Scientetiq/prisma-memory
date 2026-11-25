// Fallback code page of the people and org-unit uploads: a file that is not valid UTF-8 is read in the page the
// installation chose (setting locale.legacy_charset). Hand copy of LEGACY_CHARSETS of packages/shared/src/record-text.ts
// (the panel bundle does not depend on @memory/shared); a unit test keeps the two lists equal.

export const LEGACY_CHARSETS = ["windows-1250", "windows-1251", "windows-1252", "windows-1253", "windows-1254", "windows-1255",
  "windows-1256", "windows-1257", "windows-1258"] as const;
export type LegacyCharset = (typeof LEGACY_CHARSETS)[number];
export const DEFAULT_LEGACY_CHARSET: LegacyCharset = "windows-1252";

/** The configured page from the settings list of the gateway; absent, unset or invalid — windows-1252. */
export function legacyCharsetFromSettings(items: ReadonlyArray<{ category: string; key: string; value: unknown }> | null | undefined): LegacyCharset {
  const v = items?.find((i) => i.category === "locale" && i.key === "legacy_charset")?.value;
  return typeof v === "string" && (LEGACY_CHARSETS as readonly string[]).includes(v) ? (v as LegacyCharset) : DEFAULT_LEGACY_CHARSET;
}

/** Text of an uploaded file: strict UTF-8 first, otherwise the legacy page. */
export function decodeUploadText(buf: ArrayBuffer | Uint8Array, legacy: LegacyCharset = DEFAULT_LEGACY_CHARSET): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder(legacy).decode(buf);
  }
}
