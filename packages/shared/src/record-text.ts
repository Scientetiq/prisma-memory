import { activePacks, OPEN_CHECK_PACKS } from "./open-check-packs.ts";

export function recordText(s: string): string {
  const lf = s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
  return lf.normalize("NFC");
}

/**
 * Single-byte code pages an administrator may choose for legacy text (`locale.legacy_charset`): text that is not valid
 * UTF-8 and has no UTF-16 byte-order mark is decoded with the chosen page. Canonical lowercase WHATWG labels.
 */
export const LEGACY_CHARSETS = ["windows-1250", "windows-1251", "windows-1252", "windows-1253", "windows-1254", "windows-1255",
  "windows-1256", "windows-1257", "windows-1258"] as const;
export type LegacyCharset = (typeof LEGACY_CHARSETS)[number];
/** Fallback code page when the setting is absent, unset or invalid. */
export const DEFAULT_LEGACY_CHARSET: LegacyCharset = "windows-1252";
/** The setting that selects the fallback code page. */
export const LEGACY_CHARSET_SETTING = "locale.legacy_charset";
/** Error text of an invalid value written through the settings API. */
export const LEGACY_CHARSET_INVALID = `${LEGACY_CHARSET_SETTING} must be a supported Windows code page`;
/**
 * Extra readings of legacy text for the open check while the Russian rule pack is on (legacyScanCharsetsOf): Cyrillic
 * text in another code page stays covered by the Cyrillic rules. Never used for the stored text or the served charset.
 */
export const LEGACY_SCAN_CHARSETS: readonly LegacyCharset[] = ["windows-1251"];

/** Extra scan readings under these settings: LEGACY_SCAN_CHARSETS while the pack ru is in force (`open_check.packs`), else none. */
export function legacyScanCharsetsOf(settings: { get<T>(path: string, fallback: T): T } | null | undefined): readonly LegacyCharset[] {
  const packs = settings ? settings.get<unknown>("open_check.packs", [...OPEN_CHECK_PACKS]) : [...OPEN_CHECK_PACKS];
  return activePacks(packs).has("ru") ? LEGACY_SCAN_CHARSETS : [];
}

/** A supported legacy code page or null. */
export function legacyCharsetOrNull(v: unknown): LegacyCharset | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toLowerCase();
  return (LEGACY_CHARSETS as readonly string[]).includes(c) ? (c as LegacyCharset) : null;
}

/** The configured legacy code page; an absent, unset or invalid value gives DEFAULT_LEGACY_CHARSET. */
export function legacyCharsetOf(settings: { get<T>(path: string, fallback: T): T } | null | undefined): LegacyCharset {
  if (!settings) return DEFAULT_LEGACY_CHARSET;
  return legacyCharsetOrNull(settings.get<unknown>("locale.legacy_charset", DEFAULT_LEGACY_CHARSET)) ?? DEFAULT_LEGACY_CHARSET;
}

/** Charsets of a text original that the gateway names in the response header (allow list). */
export const TEXT_CHARSETS = ["utf-8", "utf-16le", "utf-16be", ...LEGACY_CHARSETS] as const;
export type TextCharset = (typeof TEXT_CHARSETS)[number];

/** A charset from the allow list or null: a stored value reaches the response header only through this. */
export function charsetOf(v: unknown): TextCharset | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toLowerCase();
  return (TEXT_CHARSETS as readonly string[]).includes(c) ? (c as TextCharset) : null;
}

/**
 * The charset the stored text is read in, the same branches as decodeVariants (open-check-texts.ts): UTF-16 by its
 * byte-order mark; strict UTF-8; UTF-8 with at most 1 % broken sequences is still UTF-8 (stored with "\uFFFD");
 * otherwise the configured legacy code page. A unit test checks the match with decodeVariants on every sample.
 */
export function textCharset(bytes: Uint8Array, legacy: LegacyCharset = DEFAULT_LEGACY_CHARSET): TextCharset {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    const loose = new TextDecoder("utf-8").decode(bytes);
    const broken = (loose.match(/\uFFFD/g) ?? []).length;
    return broken <= Math.max(1, loose.length / 100) ? "utf-8" : legacy;
  }
}

export function safeFileName(name: string): string {
  return name.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "_");
}

class NfcTestRegExp extends RegExp {
  override test(s: string): boolean { return super.test(String(s).normalize("NFC")); }
}

export function titleRuleRe(pattern: string, flags = "iu"): RegExp {
  return new NfcTestRegExp(pattern.normalize("NFC"), flags);
}
