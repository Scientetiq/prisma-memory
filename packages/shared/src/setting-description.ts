// Descriptions of settings in the language of the reader: one catalog of English and Russian texts keyed by
// "category.key" (src/messages/settings-<category>.ts), with the description stored in the database as the fallback for
// a key the catalog does not know (keys of a profile, custom keys, keys another package added before its text arrived).
import { localeOf, type Locale, type Message } from "@memory/i18n";
import { M as access } from "./messages/settings-access.ts";
import { M as admin } from "./messages/settings-admin.ts";
import { M as agent_auth } from "./messages/settings-agent_auth.ts";
import { M as edge } from "./messages/settings-edge.ts";
import { M as integrations } from "./messages/settings-integrations.ts";
import { M as ldap } from "./messages/settings-ldap.ts";
import { M as limits } from "./messages/settings-limits.ts";
import { M as locale } from "./messages/settings-locale.ts";
import { M as meetings } from "./messages/settings-meetings.ts";
import { M as models } from "./messages/settings-models.ts";
import { M as oauth } from "./messages/settings-oauth.ts";
import { M as observability } from "./messages/settings-observability.ts";
import { M as oidc } from "./messages/settings-oidc.ts";
import { M as onboarding } from "./messages/settings-onboarding.ts";
import { M as open_check } from "./messages/settings-open_check.ts";
import { M as processing } from "./messages/settings-processing.ts";
import { M as retrieval } from "./messages/settings-retrieval.ts";
import { M as search } from "./messages/settings-search.ts";
import { M as security } from "./messages/settings-security.ts";
import { M as smtp } from "./messages/settings-smtp.ts";
import { M as storage } from "./messages/settings-storage.ts";

type Table = Readonly<Record<string, Message<unknown>>>;

// category → messages of its keys; a Map and Object.hasOwn keep names of object internals ("constructor") unknown
const TABLES: ReadonlyMap<string, Table> = new Map<string, Table>(Object.entries({ access, admin, agent_auth, edge, integrations, ldap, limits, locale, meetings, models, oauth, observability, oidc, onboarding, open_check, processing, retrieval, search, security, smtp, storage }));

/** Every described key as "category.key", sorted. */
export const SETTING_DESCRIPTION_PATHS: readonly string[] = Object.freeze(
  [...TABLES].flatMap(([category, table]) => Object.keys(table).map((key) => `${category}.${key}`)).sort(),
);

/** The catalog entry of a settings key ("category.key"), or null when the catalog does not describe it. */
export function settingDescriptionMessage(path: string): Message<unknown> | null {
  const dot = path.indexOf(".");
  if (dot <= 0) return null;
  const table = TABLES.get(path.slice(0, dot)), key = path.slice(dot + 1);
  return table !== undefined && Object.hasOwn(table, key) ? table[key]! : null;
}

/**
 * The description of a settings key in a language: the catalog text (an unknown language is English), else the
 * description stored in the database, else null. The text is returned as written — braces in it are examples of
 * values, not parameters, so nothing is substituted.
 */
export function settingDescription(locale: Locale, path: string, dbDescription: string | null | undefined): string | null {
  const m = settingDescriptionMessage(path);
  if (m !== null) {
    const own = m[localeOf(locale)];
    if (typeof own === "string") return own;
    if (typeof m.en === "string") return m.en;
  }
  return typeof dbDescription === "string" && dbDescription !== "" ? dbDescription : null;
}
