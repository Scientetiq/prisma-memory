// Agent consent messages in the request language. The explicit EN export retains the original English contract.
// Placeholders: {app}, {host}, {days}, {name}, {login}, {age}. Pure module: server, browser and tests.

export { EN } from "../messages/agent-consent/en";
import { EN } from "../messages/agent-consent/en";
import { EN as CONSENT_TEXT, CONSENT_AGE_TEXT } from "../messages/agent-consent";

export type ConsentTextKey = keyof typeof EN;
export type ConsentVars = Partial<Record<"app" | "host" | "days" | "name" | "login" | "age", string | number>>;

/**
 * The text of a key with its placeholders filled. A placeholder without a value stays as it is: a missing value is visible
 * in a test instead of silently turning into an empty string. Values are plain text — React escapes them when rendering.
 */
export function consentText(key: ConsentTextKey, vars: ConsentVars = {}): string {
  return CONSENT_TEXT[key].replace(/\{(app|host|days|name|login|age)\}/g, (m, name: keyof ConsentVars) => {
    const v = vars[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/** The request age, with a localized unit, for the started_ago line. */
export function consentAge(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return CONSENT_AGE_TEXT.seconds(s);
  if (s < 3600) return CONSENT_AGE_TEXT.minutes(Math.floor(s / 60));
  return CONSENT_AGE_TEXT.hours(Math.floor(s / 3600));
}
