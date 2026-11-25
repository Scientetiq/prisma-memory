// "More about the space" — the space description from a template. The column
// `spaces.readme` (01-control.sql) is a document with sections next to the short "What to write here" line (`description`):
// members' agents read it first in `memory_list /spaces/<slug>`. The `onboarding.readme_templates_enabled` switch
// (off by default) turns it all off: the create and edit REST field (a refusal), the card field, the template and the highlight
// of an empty description in the workplace, the new readme build in `memory_list` (off — byte for byte as before).
// A pure module: field parsing, the template, the readme build for the agent; rights and writing — spaces.ts.
import { GUIDE_ENABLED_SETTING, invalid, type MemoryError } from "@memory/shared";

/** The "More about the space" limit, in characters (next to "What to write here" — 2000). */
export const README_MAX = 6000;
/** The description templates switch (the "Getting started" category). */
export const README_SETTING = "onboarding.readme_templates_enabled";
/**
 * The "How we work" map switch (key — `@memory/shared` space-guide.ts): the template with the "How we
 * work" section — only with the map on.
 */
export const GUIDE_SETTING = GUIDE_ENABLED_SETTING;

type SettingsLike = { get: <T>(key: string, fallback: T) => T };
/** Whether "Space description from a template" is on: only an explicit true (a typo in the panel does not turn it on). */
export const readmeEnabled = (s: SettingsLike): boolean => s.get<unknown>(README_SETTING, false) === true;
const guideEnabled = (s: SettingsLike): boolean => s.get<unknown>(GUIDE_SETTING, false) === true;

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["About this team or project", "Briefly describe what we do, who it’s for and when it’s due."],
  ["What to record here", "Decisions, agreements, meeting outcomes and reference material that colleagues and their agents can use."],
  ["What to keep out of this space", "All members and their agents can see this space, so keep passwords, keys, personal data and contract amounts out of it."],
  ["Where to find tasks and documents", "For example: tasks — in the task tracker, project “…”; contracts — in the document system, not here."],
];
const GUIDE_SECTION = ["How we work", "See this space’s “How we work” page for details."] as const;

/** The template with sections; the "How we work" section — only with the map on. */
export function readmeTemplate(guide: boolean): string {
  return [...SECTIONS, ...(guide ? [GUIDE_SECTION] : [])].map(([h, body]) => `## ${h}\n${body}`).join("\n\n");
}

/** The template for this instance (with the map section, if it is on). */
export const instanceReadmeTemplate = (s: SettingsLike): string => readmeTemplate(guideEnabled(s));

/** Text for comparing with the template: line breaks — \n, no spaces at line ends, no empty lines at the edges. */
const normalized = (v: string): string => v.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
const TEMPLATES = new Set([readmeTemplate(false), readmeTemplate(true)].map(normalized));
/** An untouched blank (of either variant — the map could be turned on while the form was open). */
export const isUntouchedTemplate = (v: string): boolean => TEMPLATES.has(normalized(v));

/**
 * The request body's `readme` field value: a string up to README_MAX chars or null. An empty string, only spaces and an untouched
 * blank — null: otherwise agents would read an empty template instead of a description. Line breaks are brought to
 * \n, line ends are trimmed, and the limit is counted on that text: a form field (maxLength) counts a line
 * break as one character, but the browser sends the pair \r\n — otherwise text the field let through would get a refusal, and
 * agents would read \r in memory_list.
 */
export function readmeOf(v: unknown): string | null {
  if (v === null) return null;
  const tooLong = () => invalid(`readme: “More about the space” — a string of up to ${README_MAX} characters`);
  if (typeof v !== "string") throw tooLong();
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (t.length > README_MAX) throw tooLong();
  return !t || isUntouchedTemplate(t) ? null : t;
}

/** Refusal: the field was sent while the switch is off. */
export const readmeDisabled = (): MemoryError =>
  invalid("The “More about the space” field is turned off by the administrator", { reason: "readme_disabled", setting: README_SETTING });

/**
 * The space description in the `memory_list /spaces/<slug>` readme (before counters). On: "What to write here" and "More about
 * the space" — both, each in its own part; neither — the name (the old `readme ?? description`
 * would hide the short line when a document is set). Off — the old rule byte for byte. The rule is a shared function with
 * the edge (@memory/mcp-core spaceAbout): the edge gets the switch in edge_meta.settings.
 */
export { spaceAbout } from "@memory/mcp-core";
