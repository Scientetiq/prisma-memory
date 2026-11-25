import { pluralEn } from "../../i18n/core";
// Messages in the language of the current request. One export per dictionary.
export const EN = {
  title: "Connect {app} to your memory",
  who: "You are signed in as {name} ({login}).",
  not_you: "Not you? Sign out",
  app_known: "{app} wants to access your memory.",
  app_unknown: "An app at {host} wants to access your memory.",
  calls_itself: "It calls itself “{name}”.",
  unknown_mark: "App not on the list of known apps",
  dcr_mark: "Registered automatically.",
  started_by_you: "Allow only if you just started connecting {app} yourself.",
  started_ago: "This request was started {age} ago.",
  stale_warning: "This request is more than 3 minutes old. If you did not start it just now, choose Deny.",
  redirect: "After you allow, the sign-in code goes to {host}.",
  loopback_warning: "The code goes to an app on this computer.",
  custom_warning: "The code goes to an app installed on this computer ({host}).",
  scope: "The app can read and change open data on your behalf. It cannot see closed data.",
  duration: "Access lasts up to {days} days and is not extended.",
  revoke_hint: "You can disconnect it at any time in Keys and agents.",
  allow: "Allow",
  deny: "Deny",
  continue: "Continue",
  fresh_login: "This app asked you to sign in again.",
  fresh_login_button: "Sign in again",
  gone: "This sign-in link has expired or was opened in another browser. Start connecting again in your app.",
  decided: "This request has already been answered. Start connecting again in your app.",
  preview: "Preview sessions cannot approve apps.",
  failed: "Something went wrong. Start connecting again in your app.",
  // additions to the table: the browser tab title and the brand line of the screen
  document_title: "Connect an app · Prisma Memory",
  brand: "Prisma Memory",
  // the decision buttons while the request is on its way (they are blocked after the first press)
  sending: "Sending…",
  // a press within the first moment after the page became visible and focused (double-click-jacking guard,
  // lib/consent-arming.ts): it did not count; the next press after the wait does
  wait: "Take a moment to read this request, then press again.",
  // a private-use scheme without a host (RFC 8252 §7.1, e.g. com.example.app:/oauth/cb): custom_warning without an empty "()"
  custom_warning_no_host: "The code goes to an app installed on this computer.",
} as const;

export const CONSENT_AGE_TEXT = { seconds: (n: number): string => `${n} ${pluralEn(n, "second", "seconds")}`, minutes: (n: number): string => `${n} ${pluralEn(n, "minute", "minutes")}`, hours: (n: number): string => `${n} ${pluralEn(n, "hour", "hours")}` };
