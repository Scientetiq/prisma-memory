// Language of the server's texts: one list of languages (@memory/i18n) and one resolution rule per surface.
//   mcp      — everything answered on /mcp: locale.mcp_language; Accept-Language is ignored (one language for the tool
//              descriptions and the answers).
//   rest     — REST and the admin listener: Accept-Language, else locale.language.
//   instance — mail, alerts, notices, jobs, stored text, workers, authcheck: locale.language.
// A missing, empty or unknown value is English. No I/O: the caller passes its settings.
import { DEFAULT_LOCALE, LOCALES, localeOf, negotiate, type Locale } from "@memory/i18n";
import { setDefaultLocaleProvider } from "@memory/i18n/context";
import { MCP_LANGUAGE_SETTING } from "./mcp-language.ts";

export { DEFAULT_LOCALE, LOCALES, localeOf, type Locale };

interface SettingsLike { get<T>(path: string, fallback: T): T }

export type LocaleSurface = "mcp" | "rest" | "instance";

/** The instance language: locale.language; no row, empty or unknown — English. */
export function instanceLocaleOf(settings: SettingsLike): Locale {
  return localeOf(settings.get<unknown>("locale.language", DEFAULT_LOCALE));
}

/** The locale of a surface (see the header); acceptLanguage counts only for rest. */
export function resolveLocale(settings: SettingsLike, surface: LocaleSurface, acceptLanguage?: string | null): Locale {
  if (surface === "mcp") return localeOf(settings.get<unknown>(MCP_LANGUAGE_SETTING, DEFAULT_LOCALE));
  if (surface === "rest") return negotiate(acceptLanguage) ?? instanceLocaleOf(settings);
  return instanceLocaleOf(settings);
}

/** Make the instance language the process default of tr/trInstance outside a request (called once at start). */
export function registerInstanceLocale(settings: SettingsLike): void {
  setDefaultLocaleProvider(() => instanceLocaleOf(settings));
}
