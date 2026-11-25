// Language of what agents see over MCP: tool titles and descriptions, instructions, resources and prompts.
// English is the canonical contract (contracts/mcp-tools.json); Russian is the overlay contracts/locales/ru/mcp-tools.json.
// No I/O here: settings.ts validates the value with this list and contracts.ts loads the texts.
import { LOCALES, localeOf, type Locale } from "@memory/i18n";
/** Languages of the MCP texts — the values of the setting locale.mcp_language. */
export const MCP_LANGUAGES = LOCALES;
export type McpLanguage = Locale;
export const MCP_LANGUAGE_SETTING = "locale.mcp_language";
/** The language for a setting value: a known language as is, anything else (no row, empty, unknown) — English. */
export const mcpLanguage: (value: unknown) => McpLanguage = localeOf;
