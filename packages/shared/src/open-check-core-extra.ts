// Additional secret rules of the pack core: keys of cloud providers and services that `service_token` does not know,
// and a context-free rule for random-looking tokens. Both are of kind `secret`: a record with such a finding is never
// opened by a word of its author.
//
// The formats follow the vendors' documentation; the MIT-licensed gitleaks rule list served as a reference only (no code or
// pattern is copied from it). Every pattern starts with a literal prefix or a bounded character class right after a token
// boundary and uses bounded repeats only — the rule of open-check.ts: linear in the length of the text.
//
// The `check` functions run on the normalized text inside the open-check thread. They live here, next to the patterns, and
// are never posted across threads: the thread receives settings and compiles the built-in rules itself. A custom rule
// (`open_check.extra_rules`) cannot carry a function — the settings check refuses any field but name, kind, pattern, reason.
//
// Leaf module: only a type import, so open-check.ts can append these rules without an import cycle at run time; what the
// rules need from open-check.ts (its reader of names) comes as the argument of coreExtraRules.
import type { OpenCheckRule } from "./open-check.ts";

const re = String.raw;

// ---------------------------------------------------------------- shared helpers
// stubs and references in documentation: xxxx, ***, <key>, ${VAR}, {{ secret }}, …EXAMPLE…, long runs of zeros
const STUB = /x{4,}|X{4,}|\*{3}|\.{3}|…|[<>]|\$\{|\{\{|EXAMPLE|example|0{10,}/;

/** A key body that is a documentation stub or too monotonous to be random (fewer than eight distinct characters). */
const stubLike = (v: string): boolean => STUB.test(v) || new Set(v).size < 8;

const hasUpper = (v: string): boolean => /[A-Z]/.test(v);
const hasLower = (v: string): boolean => /[a-z]/.test(v);
const hasDigit = (v: string): boolean => /\d/.test(v);

// ---------------------------------------------------------------- cloud_key
// Prefixed keys and tokens, case-sensitive. Each branch: vendor — format.
//   GOCSPX-…                 Google OAuth client secret (28 characters after the prefix)
//   do[opr]_v1_…             DigitalOcean personal / OAuth / refresh token (64 hex)
//   SG.x.y                   SendGrid API key (22 + 43 characters)
//   whsec_…                  Stripe (and Svix-style) webhook signing secret
//   gsk_…                    Groq API key (52)
//   xai-…                    xAI API key (80)
//   dapi…                    Databricks personal access token (32 hex, optional "-N")
//   pypi-AgEIcHlwaS5vcmc…    PyPI API token (macaroon for pypi.org)
//   dckr_pat_…               Docker Hub personal access token
//   ATATT3…                  Atlassian API token
//   shp(at|ca|pa|ss)_…       Shopify access tokens (32 hex)
//   hv[sb]….                 HashiCorp Vault service / batch token
//   dp.(pt|st|sa|ct|…).…     Doppler tokens (a service token may name its config: dp.st.prd.…)
//   lin_api_…                Linear API key (40)
//   ntn_… / secret_…         Notion integration token (current / legacy, 43 characters)
//   PMAK-…-…                 Postman API key
//   sbp_… / sb_secret_…      Supabase access token / secret key
//   sntrys_… / sntryu_…      Sentry organization / user auth token
//   AGE-SECRET-KEY-1…        age private key (bech32, 58 characters)
//   SK + 32 hex              Twilio API key — only with the word "twilio" within 200 characters
//   AKIA/ASIA + 16           AWS access key id — a finding of this rule only with a 40-character secret within 200
//                            characters (the id alone is the rule aws_key)
//   …\dQ~…                   Microsoft Entra ID (Azure AD) client secret (the finding points at its fourth character)
//   [MNO]….…. ….             Discord bot token: the first part is the bot's numeric id in base64
//   "private_key_id": "…"    Google Cloud service-account key file (40 hex)
//   AccountKey= / SharedAccessKey=   Azure storage account key (88 base64) / Service Bus and Event Hubs key (44 base64)
//   aws_secret_access_key = …        AWS secret access key after its name (40 base64)
const CLOUD_KEY = re`(?<![A-Za-z0-9_])(?:GOCSPX-[A-Za-z0-9_-]{28}|do[opr]_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`
  + re`|whsec_[A-Za-z0-9+/]{32,88}={0,2}|gsk_[A-Za-z0-9]{52}|xai-[A-Za-z0-9]{70,90}|dapi[a-f0-9]{32}(?:-\d{1,2})?`
  + re`|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}|hv[sb]\.[A-Za-z0-9_-]{24,300}|dp\.(?:pt|st|sa|ct|scim|audit)\.(?:[a-z0-9_-]{1,40}\.)?[A-Za-z0-9]{40,60}`
  + re`|lin_api_[A-Za-z0-9]{40}|ntn_[A-Za-z0-9]{40,50}|(?<ns>secret_[A-Za-z0-9]{43})|PMAK-[a-f0-9]{24}-[a-f0-9]{34}`
  + re`|sbp_[a-f0-9]{40}|sntryu_[a-f0-9]{64}`
  + re`|AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}|(?<tw>SK[0-9a-fA-F]{32})|(?<ak>(?:AKIA|ASIA)[0-9A-Z]{16})`
  + re`|(?<dc>[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}))(?![A-Za-z0-9_~-])`
  // wide bodies: the pattern takes the prefix and the shortest body only, `check` reads the rest of the body forward once
  // (wideEnd). A pattern with the whole range and a lookahead after it walked up to the maximum and back at every start —
  // "-sntrys_" repeated cost about 90 steps of the engine per character of the text
  + re`|(?<![A-Za-z0-9_])(?:(?<ws>sntrys_)[A-Za-z0-9+/=_-]{60}|(?<wa>ATATT3)[A-Za-z0-9_=-]{150}|(?<wp>pypi-AgEIcHlwaS5vcmc)[A-Za-z0-9_-]{50}`
  + re`|(?<wb>sb_secret_)[A-Za-z0-9_-]{20}|(?<wd>dckr_pat_)[A-Za-z0-9_-]{27})`
  // the Entra ID secret starts with any three characters: the match starts at its digit (a literal check per digit is far
  // cheaper than three classes per word), the lookbehind checks the three characters and the boundary before them
  + re`|(?<ad>\d(?=Q~)(?<=(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}\d)Q~[A-Za-z0-9_~.-]{31,34})(?![A-Za-z0-9_~-])`
  + re`|\\?"private_key_id\\?"[ \t]{0,3}:[ \t]{0,3}\\?"(?<gc>[0-9a-f]{40})\\?"`
  + re`|(?<![A-Za-z0-9])(?:AccountKey=(?<az>[A-Za-z0-9+/]{86}==)|SharedAccessKey=(?<sa>[A-Za-z0-9+/]{43}=))(?![A-Za-z0-9+/=])`
  + re`|(?<![A-Za-z0-9])(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|aws_secret_key|AWS_SECRET_KEY|SecretAccessKey|secretAccessKey|secret_access_key|SECRET_ACCESS_KEY)`
  + re`["']?[ \t]{0,3}(?:[:=]|=>)[ \t]{0,3}["']?(?<av>[A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])`;

// a 40-character AWS secret next to an access key id: base64 characters, both letter cases
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const awsSecretLike = (v: string): boolean => hasUpper(v) && hasLower(v) && !stubLike(v);
const TWILIO = /twilio/gi;

type Scratch = Record<string, unknown>;

/**
 * Sorted starts of every match of `rx` in the text, found once per search of the rule (`scratch`): a text with a million
 * access key ids is scanned for secrets once, not once per id.
 */
function startsOf(scratch: Scratch, key: string, text: string, rx: RegExp, keep: (v: string) => boolean): number[] {
  let list = scratch[key] as number[] | undefined;
  if (!list) {
    list = [];
    rx.lastIndex = 0;
    for (let m = rx.exec(text); m; m = rx.exec(text)) if (keep(m[0])) list.push(m.index);
    scratch[key] = list;
  }
  return list;
}

/** Some start in the sorted list lies in [from, to). */
function anyIn(list: number[], from: number, to: number): boolean {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < from) lo = mid + 1; else hi = mid; }
  return lo < list.length && list[lo] < to;
}

/** An AWS access key id with a secret access key starting within 200 characters before or after it. */
function awsPairNear(text: string, at: number, len: number, scratch: Scratch): boolean {
  const list = startsOf(scratch, "aws", text, AWS_SECRET, awsSecretLike);
  return anyIn(list, at - 240, at - 39) || anyIn(list, at + len, at + len + 200);
}

/** The first part of a Discord bot token is the bot's id (a snowflake of 17–20 digits) in base64. */
function discordIdOk(token: string): boolean {
  const head = token.slice(0, token.indexOf("."));
  try {
    const b = head.replace(/-/g, "+").replace(/_/g, "/");
    return /^[1-9]\d{16,19}$/.test(atob(b + "=".repeat((4 - (b.length % 4)) % 4)));
  } catch { return false; }
}

/** A wide body of cloud_key: its prefix length, the shortest and longest body, its characters and the characters it may end before. */
interface Wide { pre: number; min: number; max: number; body: (c: number) => boolean; cut: (c: number) => boolean }
const word = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const urlSafe = (c: number): boolean => word(c) || c === 0x2d;
const never = (): boolean => false;
const WIDE: Readonly<Record<string, Wide>> = {
  ws: { pre: 7, min: 60, max: 400, body: (c) => urlSafe(c) || c === 0x2b || c === 0x2f || c === 0x3d, cut: (c) => c === 0x2b || c === 0x2f || c === 0x3d },
  wa: { pre: 6, min: 150, max: 250, body: (c) => urlSafe(c) || c === 0x3d, cut: (c) => c === 0x3d },
  wp: { pre: 20, min: 50, max: 500, body: urlSafe, cut: never },
  wb: { pre: 10, min: 20, max: 80, body: urlSafe, cut: never },
  wd: { pre: 9, min: 27, max: 40, body: urlSafe, cut: never },
};

/**
 * End of a wide body that starts its shortest part at the match, or -1: the body runs on over its characters to at most
 * `max`, and the character after it is not "~" and not one more body character — except a character the body may end
 * before ("+", "/", "=" for Sentry). The same as the former pattern `prefix[body]{min,max}(?![A-Za-z0-9_~-])`.
 * A stretch of the text known to hold body characters only is kept in `scratch`: the next start inside it does not read it
 * again, so a run of starts ("-sntrys_-sntrys_…") costs one pass over the text.
 */
function wideEnd(text: string, start: number, w: Wide, scratch: Scratch, key: string): number {
  const first = start + w.pre + w.min, limit = start + w.pre + w.max;
  const memo = scratch[key] as { from: number; to: number } | undefined;
  const known = memo !== undefined && memo.from <= first && first < memo.to;
  let i = known ? memo.to : first;
  for (; i <= limit; i++) {
    if (i >= text.length) return i;
    const c = text.charCodeAt(i);
    if (!w.body(c)) { if (c === 0x7e) break; return i; }
    if (w.cut(c)) return i;
  }
  scratch[key] = { from: known ? memo.from : first, to: i };
  return -1;
}

function cloudKeyOk(m: RegExpExecArray, text: string, scratch: Scratch): boolean {
  const g = m.groups ?? {};
  const wide = g.ws ? "ws" : g.wa ? "wa" : g.wp ? "wp" : g.wb ? "wb" : g.wd ? "wd" : "";
  if (wide) {
    const end = wideEnd(text, m.index, WIDE[wide], scratch, wide);
    return end >= 0 && !stubLike(text.slice(m.index, end));
  }
  const value = g.av ?? g.az ?? g.sa ?? g.gc ?? m[0];
  if (stubLike(value)) return false;
  if (g.tw) return anyIn(startsOf(scratch, "twilio", text, TWILIO, () => true), m.index - 206, m.index + m[0].length + 200);
  if (g.ak) return awsPairNear(text, m.index, m[0].length, scratch);
  if (g.dc) return discordIdOk(g.dc);
  if (g.ad || g.ns) { const body = value.slice(g.ad ? 3 : 7); return hasUpper(body) && hasLower(body) && hasDigit(body); }
  if (g.av) return awsSecretLike(g.av);
  return true;
}

// ---------------------------------------------------------------- high_entropy_secret
// A context-free token of 40–300 characters from [A-Za-z0-9+/_-] (padding "=" allowed at the end) with an upper-case
// letter, a lower-case letter and a digit, whose Shannon entropy reaches the threshold for its length and whose letters
// change case often (at least once per four letters, as in a random string; a path or a name in CamelCase changes it
// rarely). Longer runs are encoded files (images, certificates), not secrets; private keys have their own rule.
// Not a secret:
//   - pure hex, UUIDs and hex joined by "-" (hashes, commit ids, request ids);
//   - a hash after its algorithm: sha256-…, sha512:…, sha-256=…, md5-…, h1:… (Go modules), the algorithm a word of its own
//     (auth1=…, cmd5=… are not); a value named integrity, etag, checksum, commit, digest, hash, fingerprint, nonce,
//     signature, challenge (PKCE) — the last word of the name right before the value (content_hash: …, ETag: W/"…", X-Hub-Signature-256:);
//     a hash word earlier in the name or on the line does not count (HASH_PEPPER=…, "signature key …");
//   - a value whose name token_assignment holds to be no secret by meaning: idempotency key, page token, cursor, cache,
//     partition, object or site key, public key, kid, thumbprint, request id (valueOfNotSecretName in open-check.ts);
//   - a token inside a URL, unless it is the value of a parameter named as a credential (token, key, secret, sig, password,
//     auth, code, session…): ?id=, fbclid=, gclid=, ved=, sdata= are ids and tracking codes; anything inside a data: URI
//     (data: right after a boundary, then a media type or ";…" up to ","); "," and ";" end a URL;
//   - a token right before "@" of a Message-ID kind of value (mailIdBefore): inside angle brackets (<…@mail.example>) with
//     no ":" between the bracket and the token, or on a Message-ID, In-Reply-To, References, Content-ID line; a token before
//     "@" anywhere else is read as any other (user:password@host and a token as the user of a remote are credentials);
//   - base64 that decodes to text (≥ 90 % printable characters);
//   - encoded files and public keys by their first characters: MII (DER: certificates, public keys), AAAA (SSH public
//     keys), iVBORw0KGgo (PNG), /9j/ (JPEG), R0lGOD (GIF), UklGR (RIFF, WebP), JVBERi (PDF), UEsDB (zip), H4sI (gzip),
//     and an IPFS content id (Qm + 44 base58);
//   - a line of a wrapped base64 block (wrappedBlockLine): lines of one length and indentation under a -----BEGIN line, an
//     LDIF "attr::" line with its value (continuation lines one space deeper) or a MIME base64 header line in the paragraph
//     right above, or at least two such lines and a shorter last line that ends with "=" padding;
//   - a part of a JWT (the rule jwt decides): the part before it starts with eyJ;
//   - a documentation stub (EXAMPLE, xxxx, <…>).
const HIGH_ENTROPY = re`(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,300}={0,2}(?![A-Za-z0-9+/_=-])`;

/** Entropy threshold in bits per character for tokens of 50 characters and longer (see `highEntropyThreshold`). */
export const HIGH_ENTROPY_BITS = 4.7;

/**
 * Threshold for a token of `len` characters: 4.7 bits per character, lowered for tokens shorter than 50 characters — a
 * random string of 40 characters over 62 or 64 symbols repeats characters, and its entropy is below 4.7 bits in a quarter
 * of cases (measured, report); log2(len) − 0.9 keeps the miss near 1 %.
 */
export function highEntropyThreshold(len: number): number {
  return Math.min(HIGH_ENTROPY_BITS, Math.log2(len) - 0.9);
}

/** Shannon entropy of a string in bits per character. */
export function shannonEntropy(v: string): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); counts.set(c, (counts.get(c) ?? 0) + 1); }
  let h = 0;
  for (const n of counts.values()) { const p = n / v.length; h -= p * Math.log2(p); }
  return h;
}

const COUNTS = new Uint16Array(128);

/**
 * One pass over a token of the rule (ASCII only, as its pattern): upper, lower, digit; only hex digits and "-"; letter case
 * changes once per four letters or more often; entropy at the threshold for the length. The cheap part of the rule.
 */
function randomShape(v: string): boolean {
  let upper = false, lower = false, digit = false, hexOnly = true, letters = 0, changes = 0, prev = 0;
  COUNTS.fill(0);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    COUNTS[c & 0x7f]++;
    const kind = c >= 0x61 && c <= 0x7a ? 1 : c >= 0x41 && c <= 0x5a ? 2 : 0;
    if (kind) {
      letters++;
      if (prev && prev !== kind) changes++;
      prev = kind;
      if (kind === 1) lower = true; else upper = true;
      if ((c | 0x20) > 0x66) hexOnly = false;
    } else if (c >= 0x30 && c <= 0x39) digit = true;
    else if (c !== 0x2d) hexOnly = false;
  }
  if (!upper || !lower || !digit || hexOnly || changes * 4 < letters) return false;
  let h = 0;
  for (let c = 0; c < 128; c++) if (COUNTS[c]) { const p = COUNTS[c] / v.length; h -= p * Math.log2(p); }
  return h >= highEntropyThreshold(v.length);
}

const HASH_PREFIX = /^(?:sha\d{1,3}|md5|h1|blake2[bs]?|xxh\d{2})[-:_]/i;
const HASH_BEFORE = /(?<![A-Za-z0-9])(?:sha-?\d{1,3}|md5|h1|blake2[bs]?|xxh\d{2})[:=]$/i;
// the name may end with its algorithm or size: X-Hub-Signature-256, checksum_sha1, digest-md5; a PKCE code_challenge is the
// hash of its verifier
const HASH_NAME = /(?:^|[_.-])(?:integrity|e-?tag|checksum|commit|digest|hash|fingerprint|nonce|signature|challenge)(?:[_.-]?(?:sha|md)?\d{1,3})?$/i;
const FILE_HEAD = /^(?:MII|AAAA|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|JVBERi|UEsDB|H4sI)/;
const IPFS_CID = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const PRINTABLE_TEXT = new TextDecoder("utf-8", { fatal: true });

/** The base64 (standard or URL-safe) decodes to text: valid UTF-8 with at least 90 % printable characters. */
export function decodesToText(v: string): boolean {
  if (/[-_]/.test(v) && /[+/]/.test(v)) return false;          // both alphabets at once — not base64
  const b = v.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (b.length % 4 === 1) return false;
  let bin: string;
  try { bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4)); } catch { return false; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let s: string;
  try { s = PRINTABLE_TEXT.decode(bytes); } catch { return false; }
  if (!s.length) return false;
  let ok = 0, n = 0;
  for (const ch of s) { n++; const c = ch.codePointAt(0)!; if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0))) ok++; }
  return ok >= 0.9 * n;
}

/** A character that ends a "word" (a URL, a data: URI): white space, quotes, brackets, "|". */
const boundaryCode = (c: number): boolean => c <= 0x20 || c === 0x22 || c === 0x27 || c === 0x60 || c === 0x3c || c === 0x3e
  || c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x7c
  || c === 0x85 || c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x3000;
const alnum = (c: number): boolean => (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a);
// after "data:" — a media type and parameters up to the ",": data:image/png;base64, data:text/plain;charset=utf-8, data:,
const DATA_HEAD = /(?:[a-z]{1,20}\/[a-z0-9.+-]{1,80})?(?:;[a-z0-9.+=-]{1,60}){0,6},/iy;

/**
 * The "word" before the token: does it contain "://" (a URL) or a data: URI? Read back from the token to the nearest
 * boundary only; a word without a boundary since the previous match continues the state kept in `scratch`. Every character
 * is read at most twice per search, however many tokens a long word holds.
 */
interface WordScan { pos: number; url: boolean; data: boolean }
function wordBefore(text: string, at: number, scratch: Scratch): WordScan {
  let w = scratch.word as WordScan | undefined;
  if (!w || at < w.pos) w = scratch.word = { pos: 0, url: false, data: false };
  let i = at;
  // a short gap since the previous match is read forward once; a long one (prose) — back to its last boundary only
  if (at - w.pos <= 256) i = w.pos;
  else {
    while (i > w.pos && !boundaryCode(text.charCodeAt(i - 1))) i--;
    if (i > w.pos) { w.url = false; w.data = false; }             // a boundary at i − 1: a new word starts at i
  }
  for (; i < at; i++) {
    const c = text.charCodeAt(i);
    if (boundaryCode(c)) { w.url = false; w.data = false; continue; }
    if (c === 0x2c || c === 0x3b) { w.url = false; continue; }    // "," and ";" end a URL, not a data: URI (;base64,)
    if (c === 0x3a) {                                                // ":"
      if (text.startsWith("//", i + 1)) w.url = true;
      else if (i >= 4 && (i === 4 || !alnum(text.charCodeAt(i - 5))) && text.slice(i - 4, i).toLowerCase() === "data") {
        DATA_HEAD.lastIndex = i + 1;
        if (DATA_HEAD.test(text)) w.data = true;
      }
    }
  }
  w.pos = at;
  return w;
}

// a URL parameter whose value is a credential: access_token=, api_key=, key=, sig=, client_secret=, code=, password=…
const CREDENTIAL_PARAM = new Set(("token tokens key keys apikey secret sig signature password passwd pwd pass auth code credential credentials "
  + "session sessionid sid jwt bearer otp").split(" "));
/** The token after "=" in a URL is the value of a parameter named as a credential. */
function credentialParam(text: string, at: number): boolean {
  let s = at - 1;
  while (s > 0 && at - 1 - s < 40 && /[A-Za-z0-9_.[\]-]/.test(text[s - 1])) s--;
  return text.slice(s, at - 1).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/)
    .some((p) => CREDENTIAL_PARAM.has(p) || /(?:token|key|secret|password)$/.test(p));
}

/** The name right before the value (then only spaces, quotes, ":", "=", W/ of a weak ETag) is a name of a hash. */
function hashNameBefore(text: string, at: number): boolean {
  let i = at;
  for (let k = 0; k < 8 && i > 0; k++) {
    const c = text[i - 1];
    if (c === '"' || c === "'" || c === " " || c === "\t" || c === ":" || c === "=" || c === "\\") i--;
    else if (c === "/" && text[i - 2] === "W") i -= 2;
    else if (c === ")") {                                            // a short note in brackets: "Checksum (SHA-256): …"
      let open = i - 1;
      while (open > 0 && i - open < 20 && text[open - 1] !== "(") open--;
      if (open === 0 || text[open - 1] !== "(") break;
      i = open - 1;
    }
    else break;
  }
  if (i === at) return false;
  let s = i;
  while (s > 0 && i - s < 40 && /[A-Za-z0-9_.-]/.test(text[s - 1])) s--;
  const name = text.slice(s, i).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return HASH_NAME.test(name);
}

const b64Code = (c: number): boolean => alnum(c) || c === 0x2b || c === 0x2f;
/**
 * Length of the base64 line that starts at `s` with the indentation `ind` (letters, digits, "+", "/", then up to two "="),
 * or -1. `end` receives the index right after its last character (at "\r", "\n" or the end of the text).
 */
function b64Line(text: string, s: number, ind: string, out: { end: number }): number {
  if (s < 0 || s >= text.length || !text.startsWith(ind, s)) return -1;
  let i = s + ind.length;
  const from = i;
  while (i < text.length && i - from < 200 && b64Code(text.charCodeAt(i))) i++;
  let pad = 0;
  while (pad < 2 && text[i] === "=") { i++; pad++; }
  out.end = i;
  if (text[i] === "\r") i++;
  if (i < text.length && text[i] !== "\n") return -1;
  return out.end - from > 0 ? out.end - from : -1;
}
/**
 * Start of the line before the line that starts at `s` (s > 0), read back 240 characters at most: a longer line is no line
 * of a block (-1), and a long line is never read to its start again for every token under it.
 */
function prevLineStart(text: string, s: number): number {
  let i = s - 1;
  while (i > 0 && s - 1 - i < 240 && text[i - 1] !== "\n") i--;
  return i === 0 || text[i - 1] === "\n" ? i : -1;
}
const BLOCK_BEGIN = /^[ \t]*-----BEGIN ([A-Z0-9 ]{1,60})-----\r?$/;
// an LDIF attribute with a base64 value that goes on in continuation lines: the value starts on its own line ("Token::"
// alone is a word with two colons, not LDIF)
const LDIF_FIRST = /^[ \t]*[A-Za-z][\w;.-]{0,60}::[ \t]?[A-Za-z0-9+/]+={0,2}\r?$/;
// the MIME header on a line of its own (a sentence that names the header is no header)
const MIME_BASE64 = /(?:^|\n)[ \t]*content-transfer-encoding:[ \t]*base64[ \t]*\r?(?:\n|$)/i;
const BLOCK_HEADER = /^[A-Za-z][A-Za-z0-9-]*:(?: [^\r\n]+)?\r?$/;
const BLOCK_END = /^\r?\n(?:[ \t]*=[A-Za-z0-9+/]{4}\r?\n)?[ \t]*-----END /;

/**
 * The paragraph directly above the blank line that starts at `s`: the lines back to the previous blank line (a line of
 * spaces and tabs only, LF or CRLF), read back 600 characters at most; a paragraph whose start is outside that window loses
 * its first, cut line.
 */
function paragraphAbove(text: string, s: number): string {
  const from = Math.max(0, s - 600);
  const lines = text.slice(from, s).split("\n");
  lines.pop();                                                        // "" after the line break that ends the paragraph
  let i = lines.length;
  while (i > 0 && lines[i - 1].trim() !== "") i--;
  if (i === 0 && from > 0 && text[from - 1] !== "\n") i = 1;
  return lines.slice(i).join("\n");
}

/**
 * A marker of a block right above its first line `top`, the block's lines indented by `ind`: -----BEGIN, an LDIF "attr::"
 * line over its continuation lines (the block indented by the attribute's own indentation and one space, RFC 2849), or a
 * blank line under armor or MIME headers — read in the paragraph directly above that blank line only (a header in an earlier part of a mail proved nothing about a key in a later one).
 */
function markerAbove(text: string, top: number, ind: string): boolean {
  if (top === 0) return false;
  const s = prevLineStart(text, top);
  if (s < 0) return false;
  const line = text.slice(s, top - 1);
  if (BLOCK_BEGIN.test(line)) return true;
  if (LDIF_FIRST.test(line)) return ind === /^[ \t]*/.exec(line)![0] + " ";
  if (line.trim() !== "") return false;
  const para = paragraphAbove(text, s);
  let needsHeader = false;
  for (const paraLine of para.split("\n").reverse()) {
    if (paraLine.includes("-----END ")) break;
    if (MIME_BASE64.test(paraLine)) return true;
    if (BLOCK_BEGIN.test(paraLine)) return !needsHeader;
    if (/^[ \t]/.test(paraLine)) {
      needsHeader = true;
    } else if (BLOCK_HEADER.test(paraLine)) {
      needsHeader = false;
    } else {
      break;
    }
  }
  return false;
}

interface Block { top: number; bottom: number; ok: boolean }
/**
 * The token at [at, end) is a line of a wrapped base64 block (PEM, PGP, MIME, LDIF): it fills its line after the
 * indentation, and the lines around it with the same indentation and of one length F (the token is one of them or the
 * shorter last line) are either under a marker (-----BEGIN, "attr::" with its value, a MIME base64 header line in the
 * paragraph right above; or -----END under them) or at least two, followed by a shorter last line of a length divisible by
 * four that ends with "=". A key on a line next to a word, two keys on two lines, keys over a word or a short line, or a
 * list of keys of one length without such a last line — not a block. The verdict for a run of lines is kept in
 * `scratch`: each line is read once per search.
 */
function wrappedBlockLine(text: string, at: number, end: number, scratch: Scratch): boolean {
  const b = scratch.block as Block | undefined;
  if (b && at >= b.top && at < b.bottom) return b.ok;
  // the indentation is read back from the token (up to 12 spaces or tabs), never the whole line: a long line of tokens
  // would cost a pass to its start at every token
  let lineStart = at;
  while (lineStart > 0 && at - lineStart < 12 && (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")) lineStart--;
  if (lineStart > 0 && text[lineStart - 1] !== "\n") return false;
  const ind = text.slice(lineStart, at);
  const L = end - at, o = { end: 0 };
  if (b64Line(text, lineStart, ind, o) !== L) return false;
  // the full length: the token's own, or the previous line's when the token is the shorter last line
  const prevS = lineStart > 0 ? prevLineStart(text, lineStart) : -1;
  const prevLen = prevS >= 0 ? b64Line(text, prevS, ind, o) : -1;
  const last = prevLen > L && L % 4 === 0;
  const F = last ? prevLen : L;
  let top = lineStart, full = last ? 0 : 1;
  for (let s = prevS; s >= 0 && b64Line(text, s, ind, o) === F; s = top > 0 ? prevLineStart(text, top) : -1) {
    top = s; full++;
    if (top === 0) break;
  }
  b64Line(text, lineStart, ind, o);
  let bottom = o.end, tail = last ? text.slice(at, end) : "";
  if (!last) {
    for (let s = bottom + (text[bottom] === "\r" ? 2 : 1); s < text.length; ) {
      const len = b64Line(text, s, ind, o);
      if (len === F) { full++; bottom = o.end; s = bottom + (text[bottom] === "\r" ? 2 : 1); continue; }
      if (len > 0 && len < F && len % 4 === 0) { tail = text.slice(o.end - len, o.end); bottom = o.end; }
      break;
    }
  }
  // without a marker only a shorter last line with "=" padding closes a block: a word under two keys ("Prod", "Password")
  // or a short line with a digit under three ("2024", "rev2", "Ab3d") would hide them.
  // An unmarked block whose last line needs no padding is read as keys (fail closed).
  const tailOk = tail !== "" && full >= 2 && tail.endsWith("=");
  const ok = markerAbove(text, top, ind) || BLOCK_END.test(text.slice(bottom, bottom + 120)) || tailOk;
  scratch.block = { top, bottom: Math.max(bottom, end), ok };
  return ok;
}

// a header line whose value is a message id (folded lines of References start with white space and keep their brackets)
const MAIL_ID_HEADER = /^[ \t]*(?:message-id|in-reply-to|references|content-id|resent-message-id)[ \t]*:/i;

/**
 * The token right before "@" is a part of a Message-ID kind of value: the "word" it ends (read back to a boundary, 200
 * characters at most) holds no ":" and opens with "<" (<CAF=x.…@mail.example>; not <admin:…@db.example>), or its line is a
 * Message-ID, In-Reply-To, References or Content-ID header — there the word is read from the header's colon on, and the
 * same test applies (: "References: admin:…@db" is a credential). Read only for a token followed by "@".
 */
function mailIdBefore(text: string, at: number): boolean {
  let i = at;
  while (i > 0 && at - i < 200 && !boundaryCode(text.charCodeAt(i - 1))) i--;
  if (i > 0 && text.charCodeAt(i - 1) === 0x3c && !text.slice(i, at).includes(":")) return true;
  let s = i;
  while (s > 0 && i - s < 400 && text.charCodeAt(s - 1) !== 0x0a) s--;
  if (s > 0 && text.charCodeAt(s - 1) !== 0x0a) return false;
  const header = MAIL_ID_HEADER.exec(text.slice(s, at));
  return header !== null && !text.slice(Math.max(i, s + header[0].length), at).includes(":");
}

/** The part before the token (after a ".") starts with eyJ: the token is a part of a JWT. */
function jwtPart(text: string, at: number): boolean {
  if (at < 1 || text[at - 1] !== ".") return false;
  let i = at - 1;
  while (i > 0 && at - i < 5000 && /[A-Za-z0-9_-]/.test(text[i - 1])) i--;
  return text.startsWith("eyJ", i);
}

/** What high_entropy_secret takes from open-check.ts: the names token_assignment holds to be no secret (no import cycle). */
export interface CoreExtraNames { valueOfNotSecretName(text: string, at: number, v: string): boolean }

function highEntropyOk(names: CoreExtraNames, m: RegExpExecArray, text: string, scratch: Scratch): boolean {
  const at = m.index, raw = m[0];
  if (text.charCodeAt(at + raw.length) === 0x40 && mailIdBefore(text, at)) return false;   // a Message-ID
  const word = wordBefore(text, at, scratch);
  if (word.data || (word.url && !(text[at - 1] === "=" && credentialParam(text, at)))) return false;
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 0x3d) end--;          // padding "="
  const v = end === raw.length ? raw : raw.slice(0, end);
  if (!randomShape(v)) return false;
  if (HASH_PREFIX.test(v) || FILE_HEAD.test(v) || IPFS_CID.test(v) || STUB.test(v)) return false;
  const before = text.slice(Math.max(0, at - 30), at);
  if (HASH_BEFORE.test(before.slice(before.lastIndexOf("\n") + 1)) || hashNameBefore(text, at)) return false;
  if (wrappedBlockLine(text, at, at + raw.length, scratch) || jwtPart(text, at)) return false;
  // the name before the value is cheaper to read than base64 is to decode
  return !names.valueOfNotSecretName(text, at, v) && !decodesToText(v);
}

// ---------------------------------------------------------------- rules
/** The two rules; open-check.ts appends them to its built-in rules and passes its reader of names. */
export function coreExtraRules(names: CoreExtraNames): readonly OpenCheckRule[] {
  return [
    { name: "cloud_key", kind: "secret", reason: "cloud provider or service key", caseSensitive: true, check: cloudKeyOk, pattern: CLOUD_KEY },
    { name: "high_entropy_secret", kind: "secret", reason: "random-looking secret (high entropy)", caseSensitive: true,
      check: (m, text, scratch) => highEntropyOk(names, m, text, scratch), pattern: HIGH_ENTROPY },
  ];
}
