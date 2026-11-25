import { derived } from "../i18n/runtime";
import {
  CHECK_EFFECTS, text as text_MESSAGES, CHECK_LINKS as CHECK_LINKS_MESSAGES
} from "../messages/checks";

import { formatWhen } from "./format";
import { zoneKnown } from "../i18n/format";
import { instanceTz as installationTz } from "../i18n/runtime";
import type { HealthCheck, SettingsResponse } from "./types";

export type CheckState = "ok" | "off" | "fail";

export interface EnabledFlags { ldap: boolean | null; oidc: boolean | null; smtp: boolean | null; oauth?: boolean | null }

export function enabledFlags(settings: Pick<SettingsResponse, "items"> | null | undefined): EnabledFlags {
  const flag = (category: string): boolean | null => {
    const item = settings?.items?.find((i) => i.category === category && i.key === "enabled");
    return item ? item.value === true : null;
  };
  return { ldap: flag("ldap"), oidc: flag("oidc"), smtp: flag("smtp"), oauth: flag("oauth") };
}

const GROUP_SYNC_OFF = "the directory is not connected";

export function checkState(key: string, check: HealthCheck, flags: EnabledFlags): CheckState {
  if (!check.ok) return "fail";
  if ((key === "ldap" || key === "oidc" || key === "smtp" || key === "oauth") && flags[key] === false) return "off";
  if (key === "group_sync" && (check.detail ?? "").startsWith(GROUP_SYNC_OFF)) return "off";
  return "ok";
}

export function offText(detail: string | null | undefined): string {
  const d = (detail ?? "").trim();
  if (!d) return text_MESSAGES.off;
  return /disabled|turned off|switched off/i.test(d) ? d : text_MESSAGES.offDetail(d);
}

export interface PlaceLink { href: string; label: string }

export const CHECK_LINKS: Record<string, PlaceLink> = derived(() => ({
  settings: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["settings"].label },
  origin_allowlist: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["origin_allowlist"].label },
  t1_gate: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["t1_gate"].label },
  platform: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["platform"].label },
  models: { href: "/admin/settings?cat=models", label: CHECK_LINKS_MESSAGES["models"].label },
  embedding_index: { href: "/admin/settings?cat=models", label: CHECK_LINKS_MESSAGES["models"].label },   // re-embedding (next-model connection)
  embedder: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["embedder"].label },
  storage: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["storage"].label },
  test_hooks: { href: "/admin/settings", label: CHECK_LINKS_MESSAGES["test_hooks"].label },
  ldap: { href: "/admin/ldap", label: CHECK_LINKS_MESSAGES["ldap"].label },
  oidc: { href: "/admin/sso", label: CHECK_LINKS_MESSAGES["oidc"].label },
  smtp: { href: "/admin/smtp", label: CHECK_LINKS_MESSAGES["smtp"].label },
  oauth: { href: "/admin/settings?cat=oauth", label: CHECK_LINKS_MESSAGES["oauth"].label },
  group_sync: { href: "/admin/report#group-binds", label: CHECK_LINKS_MESSAGES["group_sync"].label },
  open_check: { href: "/admin/open-check", label: CHECK_LINKS_MESSAGES["open_check"].label },
  llm: { href: "/admin/unprocessed", label: CHECK_LINKS_MESSAGES["llm"].label },
  converter: { href: "/admin/unprocessed#converter", label: CHECK_LINKS_MESSAGES["converter"].label },
  edge_export: { href: "/admin/edge-export", label: CHECK_LINKS_MESSAGES["edge_export"].label },
  class_consistency: { href: "/admin/unprocessed?tab=moves#moves", label: CHECK_LINKS_MESSAGES["class_consistency"].label },
  external_channel: { href: "/admin/settings?cat=access", label: CHECK_LINKS_MESSAGES["external_channel"].label },
  alert_channel: { href: "/admin/alerts", label: CHECK_LINKS_MESSAGES["alert_channel"].label },
}));

/**
 * Zone of the installation from the panel settings, as the checks and report pages show it, in the order of the
 * server's resolver: locale.timezone, then the zone of the night window (processing.night_window, field tz, the legacy
 * place), then the zone of the installation that the gateway sends (instanceTz of the i18n layer). A stored value counts
 * exactly when the server's resolver takes it: a string that Intl knows as it is stored (an offset zone such as "+05:00"
 * included, a value with spaces around it not); anything else is skipped.
 */
export function instanceTz(settings: Pick<SettingsResponse, "items"> | null | undefined): string {
  const value = (category: string, key: string): unknown => settings?.items?.find((i) => i.category === category && i.key === key)?.value;
  const zone = (raw: unknown): string => (typeof raw === "string" && raw !== "" && raw.length <= 64 && zoneKnown(raw) ? raw : "");
  const night = value("processing", "night_window") as { tz?: unknown } | null | undefined;
  return zone(value("locale", "timezone")) || zone(night?.tz) || installationTz();
}

const ISO_IN_TEXT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export function formatDetailTimes(text: string, tz: string = installationTz()): string {
  return text.replace(ISO_IN_TEXT, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : formatWhen(iso, { tz, relative: false, year: true });
  });
}

export const versionText = (v: string | null | undefined): string => { const t = v?.trim(); return !t || t === "unknown" ? text_MESSAGES.versionUnknown : text_MESSAGES.version(t); };


export function bannerExplanation(failed: readonly string[]): string {
  const parts = [...new Set(failed.map((k) => CHECK_EFFECTS[k]).filter((x): x is string => !!x))];
  return text_MESSAGES.banner(parts);
}
