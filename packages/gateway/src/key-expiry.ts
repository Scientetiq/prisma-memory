// Expiry of people's keys (all keys and agent connections last at most 90 days, without
// auto-renewal, a warning 14 days ahead). Personal and extended keys are never issued without expiry; service and system keys
// have none (an administrator revokes them). Keys already issued without expiry got +90 days by migration 05-access-model.sql.
import { invalid, oauthConfig } from "@memory/shared";
import type { App } from "./context.ts";
import { workplaceWhere } from "./workplace.ts";

export const PERSON_KEY_MAX_DAYS = 90;
export const KEY_EXPIRY_WARN_DAYS = 14;
const DAY_MS = 86_400_000;

/** The last allowed moment: the end of the day (UTC) in 90 days — a form date ("until that date inclusive") passes whole. */
export function personKeyLimit(now = Date.now()): Date {
  const d = new Date(now + PERSON_KEY_MAX_DAYS * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Expiry of a personal or extended key in a request: required, future, at most 90 days ahead; otherwise invalid_argument. */
export function personKeyExpiry(raw: unknown, now = Date.now()): string {
  if (raw === undefined || raw === null || raw === "")
    throw invalid(`expires_at: a key for a person needs an expiry date at most ${PERSON_KEY_MAX_DAYS} days ahead; there is no renewal, a new key is issued when it expires`);
  const at = typeof raw === "string" ? new Date(raw).getTime() : Number.NaN;
  if (Number.isNaN(at)) throw invalid("expires_at: not a date");
  if (at <= now) throw invalid("expires_at: this date has already passed");
  const limit = personKeyLimit(now);
  if (at > limit.getTime())
    throw invalid(`expires_at: a key for a person lasts at most ${PERSON_KEY_MAX_DAYS} days (until ${limit.toISOString().slice(0, 10)} inclusive)`,
      { max_days: PERSON_KEY_MAX_DAYS, latest: limit.toISOString() });
  return new Date(at).toISOString();
}

/**
 * Warning of a key's expiry (memory_me, the workplace banner): 14 days ahead or less; otherwise null. connect — where
 * to connect an agent without a key, through the company account: when agent sign-in is on, it is named first, a new key —
 * as the fallback (so that it has priority in the description).
 */
export function keyExpiryWarning(expiresAt: Date | string | null, where: string, now = Date.now(), connect: string | null = null): string | null {
  if (!expiresAt) return null;
  const left = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(left) || left > KEY_EXPIRY_WARN_DAYS * DAY_MS) return null;
  const days = Math.max(0, Math.ceil(left / DAY_MS));
  const date = new Date(expiresAt).toISOString().slice(0, 10);
  const head = `The key expires on ${date}${days ? ` (in ${days} d)` : " (today)"}; it cannot be extended`;
  return connect
    ? `${head} — it is simpler to connect the agent again through the company account, without a key: ${connect}; if the program cannot sign in through a browser, the person issues a new key themselves: ${where}`
    : `${head} — the person issues a new key themselves: ${where}`;
}

/** A person's key warning in memory_me: the keys page and, while agent sign-in by account is on (oauth.enabled), first the agent connect page. */
export function personKeyWarning(app: App, expiresAt: Date | string | null, now = Date.now()): string | null {
  return keyExpiryWarning(expiresAt, workplaceWhere(app, "/keys", "Keys and agents"), now,
    oauthConfig(app.settings).enabled ? workplaceWhere(app, "/connect", "Connect an agent") : null);
}
