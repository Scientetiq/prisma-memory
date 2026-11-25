// Login normalisation for outside sign-in (see the login-check contract): one function for the edge (edge-auth
// normalises the form before the request) and memory-authcheck (checks it came normalised). If they differed, a person
// typing one login in two letter cases would get two attempt budgets. Leaf: no input or output.

/** Control and invisible characters (general categories Cc and Cf): the same set as the Keycloak sign-in (oidc.ts). */
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
/** The final form: local part ≤ 64, domain ≤ 189, in all ≤ 254 characters, no spaces and no second «@». */
export const LOGIN_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,189}$/u;
/** Length limit of the normalised login (the login field of the request). */
export const LOGIN_MAX = 254;

/**
 * Lower case between two NFCs: a small letter with a combining mark may not match a precomposed one (T + U+0308 →
 * t + U+0308, while Unicode has a precomposed U+1E97 for that). Without the second NFC normalisation would not be
 * idempotent, and authcheck would refuse a request with a login the edge itself normalised.
 */
const fold = (x: string): string => x.normalize("NFC").toLowerCase().normalize("NFC");

/**
 * Trim spaces → NFC → lower case → NFC → refuse control and invisible characters → no «@» and a domain is set:
 * append «@domain» → check the form. A refusal is null (the edge shows the person the sign-in failure after the floor
 * delay and sends no request). domain is the value of edge.login_domain («»: a short login is not extended); a leading
 * «@» of the domain is allowed and removed.
 */
export function normalizeLogin(raw: string, domain = ""): string | null {
  if (typeof raw !== "string" || raw.length > 1024) return null;
  let s = fold(raw.trim());
  if (!s || HIDDEN.test(s)) return null;
  if (!s.includes("@")) {
    const d = typeof domain === "string" ? fold(domain.trim()).replace(/^@/, "") : "";
    if (!d || HIDDEN.test(d)) return null;
    s = `${s}@${d}`;
  }
  return LOGIN_PATTERN.test(s) && s.length <= LOGIN_MAX ? s : null;
}

/** The login is already normalised: normalising it again changes nothing. memory-authcheck checks the field so. */
export function isNormalizedLogin(s: unknown): s is string {
  return typeof s === "string" && normalizeLogin(s) === s;
}
