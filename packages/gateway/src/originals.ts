// The gateway itself gives an original out by a link signed for 10 minutes: the closed bucket stays reachable only
// to the gateway and the workers. The route /api/v1/originals/<signature> is additive to OpenAPI.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { charsetOf, custodyCurrentSql, custodyPolicy, isNetBound, log, notFound, rateLimited, safeFileName, showcaseSql, signLink, testLoginSql, verifyLink, type DataClass } from "@memory/shared";
import type { App, Caller, PersonRow, ServiceRow } from "./context.ts";
import { isHumanSession } from "./workplace.ts";
import { auditRead } from "./audit.ts";
import { callerForKey, clientAddress, OBO_READ_OPS, personCols, scopeFor, t1Allowed } from "./auth.ts";
import { loadReadable } from "./access.ts";
import { credentialAllowed, isExternal, requestChannel, type Channel, type CredentialKind } from "./channel.ts";
import { Slots } from "./concurrency.ts";
import { oboReadAllowed } from "./obo-consent.ts";

/**
 * An open-class document's original is given only after conversion: before it the document text is not
 * checked, and after a check refusal the file is deleted — between upload and check no link is given and none is served.
 * The closed class and documents without conversion (text checked at intake) — as before.
 */
const CHECKED = "(r.class <> 'open' OR r.attrs->'conversion' IS NULL OR r.attrs->'conversion'->>'status' = 'done')";
/**
 * The file — never to agents, yes to people.
 * An open-class document where the converter recognized text not on all pages (`partial`), or a scan with no text at all
 * (`unavailable`), and the file of a record shown to agents "as text only" (`attrs.original_closed`: the file lies in the closed
 * bucket) are given to no one but a person in the workplace (a session, `isHumanSession`): not to a personal key, not
 * to the extended one (its scope holds the closed class — a class rule would let it through), not to T0 and T1 services — among
 * keys an agent cannot be told from a service. So in any state of the open check: the old question was about
 * agents ("stop giving the file itself to agents for those already uploaded"); refusing people was an implementation choice.
 * Without a recognition mark (parsed before the mark existed) — given as before. COALESCE — so a missing mark gives no NULL in
 * the condition (the row would then vanish).
 * The same for a closed PDF with scans uploaded by a person in the workplace into an open team or project
 * (`attrs.keep_closed_on_findings`): before, such a file was refused and deleted; now it lies closed
 * until "Make available to agents" — agents do not get the file before the showing either, nor a participant's extended key.
 * And while the conversion of the closed copy is not finished: the fallback path moves such a PDF into closed
 * before the conversion in closed writes `extraction_state` (till then the copy has `conversion.status = pending`, no recognition
 * mark), and on a converter failure — for good; the scan flag is still unknown then — the file is not given to agents
 * until the conversion is `done` with the whole text recognized. To people — as before.
 * Other closed scans (personal, closed spaces) — as before.
 * And a document with content that did not become text (`attrs.conversion.agent_file = false`):
 * pages recognized by a model, pictures, comments,
 * attachments and PDF form fields, active content, a cut table, an office file. Agents get the text (it is checked),
 * the file — only people. So in the open class and in closed with `keep_closed_on_findings`; in ordinary closed an agent with
 * an extended key is let to the file on purpose, as before. No mark (a conversion from before it) — as before. The comparison
 * is by string, not a cast to boolean: an unknown value does not drop the request but gives the file, as without a mark.
 * The TS twin of CHECKED and AGENT_FILE is agentFileWithheld (records.ts): by it `conversion.agent_file` in answers says what
 * the serving does. When changing the condition here, change it too.
 */
const AGENT_FILE = " AND (r.class <> 'open' OR (COALESCE(r.attrs->'conversion'->>'extraction_state', '') NOT IN ('partial', 'unavailable')"
  + " AND NOT COALESCE((r.attrs->>'original_closed')::boolean, false)))"
  + " AND NOT (r.class = 'closed' AND COALESCE((r.attrs->>'keep_closed_on_findings')::boolean, false)"
  + " AND (COALESCE(r.attrs->'conversion'->>'status', '') <> 'done'"
  + " OR COALESCE(r.attrs->'conversion'->>'extraction_state', '') IN ('partial', 'unavailable')))"
  + " AND NOT ((r.class = 'open' OR (r.class = 'closed' AND COALESCE((r.attrs->>'keep_closed_on_findings')::boolean, false)))"
  + " AND COALESCE(r.attrs->'conversion'->>'agent_file', '') = 'false')";
const checked = (human: boolean): string => (human ? CHECKED : `(${CHECKED}${AGENT_FILE})`);
/** Only a person in the workplace gets the file: the decision is by the caller's kind, not by the classes in scope. */
export const fileForHuman = (caller: Pick<Caller, "keyKind" | "principalType" | "person" | "onBehalfOf" | "preview">): boolean => isHumanSession(caller);
/**
 * The file's bucket and the journal event class: the file of a record shown to agents "as text only" (`original_closed`) lies in
 * the closed bucket while the record is open — the stream comes from there, and the link and the download journal as closed. One
 * rule for the link (REST /records/{id}/original) and for downloading by it.
 */
export const originalBucket = (cls: DataClass, originalClosed: boolean | null | undefined): DataClass => (cls === "open" && originalClosed === true ? "closed" : cls);

/**
 * The external agent address says nothing about closed content: a link is given and the file is served only for a record
 * of the open class with the file in the open bucket. A closed-class record or a "text only" file (closed bucket) — no
 * link, and by a link given inside — 404.
 */
export const externalWithheld = (cls: DataClass, originalClosed: boolean | null | undefined): boolean => originalBucket(cls, originalClosed) !== "open";

/**
 * `kid` — the key the link was given to: the download event is no longer anonymous. `h` — the link
 * was given to a person in the workplace: only by it is a file served that agents do not get. The signature guards the field from
 * forgery; a link without it (given earlier or to an agent) — as for an agent. The bucket of a "text only" record file (closed
 * while the record is open) is read from the row at download, not from the link: showing and hiding between link and download
 * change it, and the link lives 10 minutes. `dl` — a keeper's link to a record that a departed employee deleted to the trash
 * ("Handed to me"): only by it and only together with `h`
 * is the file of a deleted record served; an ordinary link still does not serve deleted content.
 */
interface LinkPayload { rid: string; cls: DataClass; exp: number; kid?: string; h?: boolean; dl?: boolean; pid?: string; ob?: string; [k: string]: unknown }

/**
 * Link signing keys. The signature uses the current link-signing-key-<n> if the gateway has it (App.linkKeys), else
 * the old setting access.link_signing_key. The check uses the current, the previous and the old setting while it is not retired.
 * A link signed by a key from a file is rechecked at download: the rights of the key or person — at the time of the
 * download, not of the link. `pid` — the person of a workplace link (h), `ob` — the person on whose behalf the service acted.
 * A link by the old setting — as before the file keys (signature and term only), but after the switch (a file key exists) — only
 * one given before it (legacyLinkAccepted): its term is no later than the switch time plus the link term. The setting key is
 * held by all who read settings with the settings key (workers, a base copy holder) — the gateway takes no new link from them.
 * Retiring the old setting — a mark in the gateway's key folder; the value
 * of the setting stays: it is required, an empty one would send the whole instance to fail_closed.
 */
const FRESH = Symbol("link-signed-by-file-key");
type CheckedLink = LinkPayload & { [FRESH]?: true };

function linkSigner(app: App): { key: string | Buffer; fresh: boolean } | null {
  const file = app.linkKeys?.sign;
  if (file) return { key: file.key, fresh: true };
  const legacy = app.settings.str("access.link_signing_key");
  return legacy ? { key: legacy, fresh: false } : null;
}

/** The link is signed by a key from a file — rights are rechecked at download. */
export const linkNeedsRecheck = (p: LinkPayload): boolean => (p as CheckedLink)[FRESH] === true;

/** The process start time (seconds): the switch time if the gateway has no link-switch-at file. */
const STARTED_AT = Math.floor(Date.now() / 1000);
/** Slack for clock drift when comparing a link term, s. */
export const LINK_EXP_SKEW_SEC = 60;

/**
 * The link term is plausible: a link given by the gateway lives no longer than access.original_link_ttl_sec. A term past "now +
 * the link term" is a forgery by a key holder (verifyLink knows no upper bound). It works after the switch to a key
 * from a file: before it the behavior is the old one (off — no changes).
 */
function expPlausible(app: App, p: LinkPayload, now: number): boolean {
  return p.exp <= now + app.settings.get("access.original_link_ttl_sec", 600) + LINK_EXP_SKEW_SEC;
}

/**
 * A link by the old setting after the switch: not accepted at all after the setting is retired
 * (link-legacy-retired), else — only if the term is no later than the switch time (link-switch-at, no file — the process
 * start) plus the link term: after the switch the gateway does not sign with the setting, anything later is a forgery.
 */
export function legacyLinkAccepted(app: Pick<App, "linkKeys" | "settings">, p: LinkPayload, now = Math.floor(Date.now() / 1000)): boolean {
  const lk = app.linkKeys;
  if (!lk?.sign) return true;
  if (lk.legacyRetired) return false;
  const ttl = app.settings.get("access.original_link_ttl_sec", 600);
  return p.exp <= (lk.switchAt ?? STARTED_AT) + ttl + LINK_EXP_SKEW_SEC && p.exp <= now + ttl + LINK_EXP_SKEW_SEC;
}

export async function originalInfo(app: App, caller: Caller, recordId: string, cls: DataClass) {
  const { rows } = await app.db.records(cls, caller.scope).query(
    `SELECT c.original_key, c.original_mime, c.original_bytes, COALESCE((r.attrs->>'original_closed')::boolean, false) AS original_closed
       FROM record_content c JOIN records r ON r.id = c.record_id
      WHERE c.record_id = $1 AND c.original_key IS NOT NULL AND ${checked(fileForHuman(caller))}`, [recordId]);
  return rows[0] as { original_key: string; original_mime: string; original_bytes: string; original_closed: boolean } | undefined;
}

/**
 * A signed link to the original — only to those allowed the `original` operation: a "search only"
 * key (`search`, `read`) got links in search and read and downloaded whole documents. The system key reads no content
 * at all. `allowedOps` null — all operations (a session, a personal key without narrowing).
 */
export const mayGetOriginal = (caller: Pick<Caller, "principalType" | "allowedOps">): boolean =>
  caller.principalType !== "system" && (!caller.allowedOps || caller.allowedOps.has("original"));

export async function signedOriginalUrl(app: App, caller: Caller, recordId: string, cls: DataClass, o: { deleted?: boolean } = {}): Promise<string | null> {
  if (!mayGetOriginal(caller)) return null;
  const external = isExternal(caller);
  if (external && cls !== "open") return null;
  const signer = linkSigner(app);
  const info = signer ? await originalInfo(app, caller, recordId, cls) : undefined;
  if (!signer || !info) return null;
  if (external && externalWithheld(cls, info.original_closed)) return null;
  const ttl = app.settings.get("access.original_link_ttl_sec", 600);
  const human = fileForHuman(caller);
  // pid — the workplace person (their kid is a session, not in api_keys); ob — the person "on behalf" of a service key
  const who = human && caller.person ? { pid: caller.person.id }
    : caller.principalType === "service" && caller.onBehalfOf && caller.person ? { ob: caller.person.id } : {};
  return `${caller.baseUrl}/api/v1/originals/${signLink(signer.key, { rid: recordId, cls, exp: Math.floor(Date.now() / 1000) + ttl, kid: caller.keyId, ...who,
                                                                       ...(human ? { h: true } : {}), ...(human && o.deleted ? { dl: true } : {}) } satisfies LinkPayload)}`;
}

/** Only types the browser does not run; the rest — as an attachment with nosniff (a stored XSS through the original's content-type). */
const INLINE_MIME = new Set(["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "audio/mpeg", "audio/ogg", "audio/wav"]);
/**
 * Text originals — with charset: without it a browser reads UTF-8 without a BOM mark at an http(s) address
 * (Mac programs save so) in the default encoding, and a Cyrillic "Report" turns into mojibake, and Python requests reads it
 * as latin-1. The upload records the encoding (attrs.original_charset, textCharset); old records lack it — utf-8: almost all
 * of them are UTF-8, and a BOM mark wins over the header.
 */
const TEXT_INLINE_MIME = new Set(["text/plain", "text/markdown"]);

/**
 * Original serving limits: the file goes in parts from the storage, not whole from memory; at once —
 * at most `total` downloads per gateway and `perKey` by links of one key; one download — at most `sendTimeoutMs`
 * (a slow client does not hold a place forever). The limits are generous: a person and an agent download one file each.
 */
export const ORIGINAL_LIMITS = Object.freeze({ total: 32, perKey: 4, sendTimeoutMs: 15 * 60_000, busyRetrySec: 5 });
export const originalSlots = new Slots(ORIGINAL_LIMITS.total, ORIGINAL_LIMITS.perKey);

/**
 * The signature is valid and the term not out — the link's content; else null. Keys from files (current and previous) first:
 * such a link is marked for a rights recheck at download (linkNeedsRecheck); then the old setting while it exists.
 */
export function originalLink(app: App, signed: string): LinkPayload | null {
  const now = Math.floor(Date.now() / 1000);
  for (const key of app.linkKeys?.verify ?? []) {
    const p = verifyLink<LinkPayload>(key, signed);
    if (p) return expPlausible(app, p, now) ? Object.assign(p, { [FRESH]: true as const }) : null;
  }
  if (app.linkKeys?.sign && app.linkKeys.legacyRetired) return null;
  const signingKey = app.settings.str("access.link_signing_key");
  const p = signingKey ? verifyLink<LinkPayload>(signingKey, signed) : null;
  return p && legacyLinkAccepted(app, p, now) ? p : null;
}

/** Where the download came from: the client address (the key's network binding) and the channel (the key's channel rules). */
export interface DownloadFrom { ip: string | null; channel: Channel }

/**
 * Rechecking rights by a link signed with a key from a file — at download time:
 *   pid (a workplace link) — the person is active and not a demo; the record is visible to them (as for reading), and a deleted
 *        (dl) one or one in a departed person's personal space — only to a keeper with live access of this dismissal;
 *   kid of a person or OAuth key — the key works (callerForKey: not revoked, term, pause, network, the person active), the key
 *        is allowed the original operation, the record is visible;
 *   kid of a service key — key and service work, the T1 gate, the original operation; with ob — the service may act and read
 *        "on behalf", the person is active, their read consent (obo-consent.ts) holds; then visibility.
 * Neither pid nor kid — a refusal. A file that agents do not get is checked by originalInfo by the caller's kind.
 * A link by the old setting is rechecked only "on behalf" (ob): the service may still read on behalf, and
 * the person's consent holds; other such links — as before the file keys. The channel rule does not apply (it did not exist then,
 * off — no changes).
 */
export async function originalLinkHolds(app: App, p: LinkPayload, from: DownloadFrom): Promise<boolean> {
  try {
    // a link by the old setting: only the "on behalf" consent — for links given to a service on behalf of a person (ob)
    if (!linkNeedsRecheck(p)) {
      if (!p.ob) return true;
      const c = p.kid ? await keyAtDownload(app, p.kid, p.ob, from, { channels: false }) : null;
      return !!c && mayGetOriginal(c);
    }
    const caller = p.pid ? await personAtDownload(app, p.pid, from) : p.kid ? await keyAtDownload(app, p.kid, p.ob ?? null, from, { channels: true }) : null;
    if (!caller || !mayGetOriginal(caller)) return false;
    if (p.pid && (p.dl === true || !(await visibleTo(app, caller, p.rid)))) return await custodianHolds(app, caller, p);
    if (!p.pid && !(await visibleTo(app, caller, p.rid))) return false;
    return !!(await originalInfo(app, caller, p.rid, p.cls));
  } catch (e) {
    // a check failure — a refusal (404), not serving the file; the reason goes to the journal without content
    log.warn("original_recheck_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) });
    return false;
  }
}

async function visibleTo(app: App, caller: Caller, rid: string): Promise<boolean> {
  try { await loadReadable(app, caller, rid); return true; } catch { return false; }
}

async function activePerson(app: App, id: string): Promise<PersonRow | null> {
  const { rows } = await app.db.control.query(`SELECT ${personCols()} FROM people WHERE id = $1 AND instance_id = $2`, [id, app.instanceId]);
  const person = rows[0] as PersonRow | undefined;
  return person?.active && !person.demo ? person : null;
}

/**
 * The credential kind of a service key — the same rule as keyCredential in auth.ts (it is not exported there; a request to
 * insert it is reported): T0 for the key or service, "on behalf", else T1.
 */
const serviceCredential = (key: { tier: string }, service: Pick<ServiceRow, "tier" | "obo_allowed">): CredentialKind =>
  key.tier === "T0" || service.tier === "T0" ? "service_t0" : service.obo_allowed ? "service_obo" : "service_t1";

/**
 * The workplace person at download time — as the caller of a session (T0, all operations). The session channel rule
 * (workplace_session — inside only) does not apply to the link: the link is opened by the person's browser without a session, by
 * access.public_base_url — on a host this is the agents' name behind a trusted proxy, channel agent (else after
 * moving the secrets no employee could download a file). The link issue checked the session. From outside — refused: workplace
 * pages are not shown outside, and an h link also opens files that agents do not get.
 */
async function personAtDownload(app: App, pid: string, from: DownloadFrom): Promise<Caller | null> {
  if (isExternal(from)) return null;
  const person = await activePerson(app, pid);
  if (!person) return null;
  return { keyId: pid, keyKind: "session", tier: "T0", principalType: "person", person, service: null, onBehalfOf: false, allowedOps: null,
           clientLabel: null, clientKind: null, expiresAt: null, ip: from.ip, netBound: false, preview: false, scope: scopeFor("session", "T0"),
           baseUrl: "", channel: from.channel };
}

/**
 * The link's key at download time; a service key with ob — with all "on behalf" checks and the read consent.
 * A service key — the channel rule, as at sign-in (T0 and "on behalf" are not accepted from outside), but only for a link
 * signed by a file key (channels): a link by the old setting — as before, one consent. The network binding of a service key by
 * the download address is not checked: an "on behalf" key is not issued without a binding, and its link is shown by a bot
 * or a portal to an employee — the person's browser downloads from their workplace, not the service address. Binding is a rule
 * of the key sign-in, not of a link signed for 10 minutes. A person's key — callerForKey in full.
 */
async function keyAtDownload(app: App, kid: string, ob: string | null, from: DownloadFrom, o: { channels: boolean }): Promise<Caller | null> {
  const { rows } = await app.db.control.query(
    `SELECT id, auth_method, principal_type, principal_id, kind, tier, ops_override, client_label, expires_at, paused_until, net_cidrs::text[] AS net_cidrs
       FROM api_keys WHERE id = $1 AND instance_id = $2 AND revoked_at IS NULL`, [kid, app.instanceId]);
  const key = rows[0];
  if (!key) return null;
  if (key.principal_type !== "service") return callerForKey(app, kid, from.ip, "", from.channel);
  if (key.kind === "system") return null;
  if (key.expires_at && new Date(key.expires_at) <= new Date()) return null;
  if (key.paused_until && new Date(key.paused_until) > new Date()) return null;
  const service = (await app.db.control.query(
    "SELECT id, name, kind, obo_allowed, obo_read, allowed_ops, tier, write_space_id FROM services WHERE id = $1 AND active", [key.principal_id])).rows[0] as ServiceRow | undefined;
  if (!service) return null;
  if (o.channels && !credentialAllowed(from.channel, serviceCredential(key, service))) return null;
  if (service.tier === "T1" && !t1Allowed(app, service.name)) return null;
  const ops = new Set<string>(key.ops_override ? service.allowed_ops.filter((o: string) => key.ops_override.includes(o)) : service.allowed_ops);
  let person: PersonRow | null = null;
  if (ob) {
    if (!service.obo_allowed) return null;
    person = await activePerson(app, ob);
    if (!person) return null;
    // reading on behalf — the service's right and the person's consent at download time; the "no consent" mark is not set here
    if (!service.obo_read || !(await oboReadAllowed(app, service, person, undefined, { note: false }))) for (const o of OBO_READ_OPS) ops.delete(o);
  }
  return { keyId: key.id, keyKind: key.kind, tier: key.tier, principalType: "service", person, service, onBehalfOf: person !== null, allowedOps: ops,
           clientLabel: key.client_label ?? null, clientKind: null, expiresAt: key.expires_at ?? null, ip: from.ip, netBound: isNetBound(key.net_cidrs), preview: false,
           scope: scopeFor(key.kind, key.tier), baseUrl: "", channel: from.channel };
}

/**
 * The keeper of a departed person's personal space: a record in the personal space of an inactive owner, the keeper's
 * row of this dismissal (custodyCurrentSql), the waiting period passed, keeper reading not off; closed content — only in
 * mode all. The fine points of the keeper's list (meetings with participants) were checked when the link was given.
 */
async function custodianHolds(app: App, caller: Caller, p: LinkPayload): Promise<boolean> {
  const policy = custodyPolicy(app.settings);
  if (policy.read === "off" || (p.cls === "closed" && policy.read !== "all") || !caller.person) return false;
  const { rowCount } = await app.db.control.query(
    `SELECT 1 FROM record_locations l
       JOIN personal_custody c ON c.space_id = l.space_id
       JOIN spaces s ON s.id = c.space_id AND s.kind = 'personal' AND s.instance_id = c.instance_id
       JOIN people o ON o.id = s.owner_id
      WHERE l.record_id = $1 AND c.instance_id = $2 AND c.custodian_id = $3 AND NOT o.active AND NOT ${showcaseSql("o")}
        AND (NOT ${testLoginSql("o")} OR $5::boolean)
        AND s.archived_at IS NOT NULL AND s.archived_at <= now() - make_interval(days => $4::int) AND ${custodyCurrentSql("c", "s")}`,
    [p.rid, app.instanceId, caller.person.id, policy.afterDays, policy.testToo]);
  return (rowCount ?? 0) > 0;
}

/**
 * The signed link route (no key). The limit window is by the verified signature: before, the bucket
 * was counted by the signature's first 64 signs — in fact by the record number, and anyone on the network knowing the number,
 * with made-up signatures of the same start, kept the owner from downloading. Wrong, expired signatures: own bucket by address.
 */
export function registerOriginals(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null,
                                  refuse?: (c: Context) => Promise<Response | null>): void {
  r.get("/api/v1/originals/:signed", async (c) => {
    const signed = c.req.param("signed");
    const p = originalLink(app, signed);
    if (!p) {
      app.limiter.checkAnonymous("original_bad", (await clientAddress(app, c.req.raw, remoteOf(c))) ?? "unknown", 60);
      throw notFound();
    }
    app.limiter.checkAnonymous("original", createHash("sha256").update(signed).digest("base64url").slice(0, 32));
    // a refusal of the whole instance (fail-closed) — after the limit window, before the storage and the journal
    const refused = refuse ? await refuse(c) : null;
    if (refused) return refused;
    // the channel — the one the gateway's first handler set (channelGate); outside it — by Host
    const rc = await requestChannel(app, c.req.raw, remoteOf(c));
    const external = isExternal(rc);
    // a link by a key from a file — rights at download time, an "on behalf" link — the consent; a refusal — the same 404
    // as for a wrong signature
    if ((linkNeedsRecheck(p) || p.ob) && !(await originalLinkHolds(app, p, { ip: rc.ip, channel: rc.channel }))) throw notFound();
    // Hono leads HEAD through this same GET route and throws the response body away unread: the storage stream would not close,
    // the place would stay held to the serving term (15 min), and the journal would log a download that never was. Link checks,
    // previews and download managers send HEAD first — they get only headers, without the storage, a place and a journal event.
    if (c.req.method === "HEAD") return headOriginal(app, p, { external });
    return serveOriginal(app, p, remoteOf(c), { external });
  });
}

interface OriginalRow { original_key: string | null; original_mime: string | null; original_bytes: string | null; space_id: string | null; filename: string | null; original_closed?: boolean;
                       charset?: string | null }

/**
 * The original's row by a link: a hidden one (a move runs, closing included) and a deleted one are not given even by a live
 * link; a file that agents do not get — only by a link given to a person (`h`). A deleted one — only by a keeper's
 * link (`dl` together with `h`): the row is in the trash until it is purged — the file is intact.
 */
async function originalRow(app: App, p: LinkPayload): Promise<OriginalRow | undefined> {
  const db = app.db.records(p.cls, { classes: [p.cls], tier: "system" });
  const { rows } = await db.query(
    `SELECT c.original_key, c.original_mime, c.original_bytes, r.space_id, r.attrs->>'filename' AS filename, r.attrs->>'original_charset' AS charset,
            COALESCE((r.attrs->>'original_closed')::boolean, false) AS original_closed FROM record_content c JOIN records r ON r.id = c.record_id
      WHERE c.record_id = $1 AND (r.deleted_at IS NULL OR $2::boolean) AND r.hidden_at IS NULL AND ${checked(p.h === true)}`, [p.rid, p.dl === true && p.h === true]);
  return rows[0] as OriginalRow | undefined;
}

/**
 * Response headers — the same for GET and HEAD. The name in NFC, no "_" inside words of a Finder name; the text encoding — only
 * from the allow list (charsetOf), else utf-8.
 */
export function originalHeaders(row: Pick<OriginalRow, "original_mime" | "filename" | "charset">): Record<string, string> {
  const mime = String(row.original_mime ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
  const filename = safeFileName(String(row.filename ?? "original"));
  const type = !INLINE_MIME.has(mime) ? "application/octet-stream" : TEXT_INLINE_MIME.has(mime) ? `${mime}; charset=${charsetOf(row.charset) ?? "utf-8"}` : mime;
  return {
    "content-type": type, "x-content-type-options": "nosniff",
    "content-disposition": `${INLINE_MIME.has(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`, "cache-control": "private, no-store",
  };
}

/** HEAD by a link: the same link and row checks and headers, but no body — the storage, a place and the journal are untouched. */
export async function headOriginal(app: App, p: LinkPayload, o: { external?: boolean } = {}): Promise<Response> {
  if (o.external && p.cls !== "open") throw notFound();
  const row = await originalRow(app, p);
  if (!row?.original_key || (o.external && externalWithheld(p.cls, row.original_closed))) throw notFound();
  return new Response(null, { headers: originalHeaders(row) });
}

/**
 * Serving by the signature: rights were checked when the link was given; a hidden row (a move runs, closing included)
 * is not given even by a still live link; the term is in the signature; each serving is an audit event, mandatory for closed.
 * Errors — in the common JSON format (`errorResponse` through the route's onError), not text: "errors — one format".
 * The file is streamed from the storage: the place is freed when the stream is closed — given, broken by the client
 * or by the serving term. No places on the gateway — 503 with Retry-After; by links of one key — 429 (rate_limited).
 * `o.external` — a request by the external agent address: a record or bucket not of the open class — 404
 * (the link may have been given inside), before a place, the storage and the journal.
 */
export async function serveOriginal(app: App, p: LinkPayload, ip: string | null = null, o: { external?: boolean } = {}): Promise<Response> {
  if (o.external && p.cls !== "open") throw notFound();
  const slot = originalSlots.take(p.kid ?? null);
  if (slot === "key") throw rateLimited(ORIGINAL_LIMITS.busyRetrySec);
  if (slot === "total") {
    log.warn("original_download_busy", { busy: originalSlots.busy });
    return new Response(JSON.stringify({ code: "rate_limited", message: "Too many files are being downloaded. Try again in a few seconds", retry_after: ORIGINAL_LIMITS.busyRetrySec }),
                        { status: 503, headers: { "content-type": "application/json", "retry-after": String(ORIGINAL_LIMITS.busyRetrySec) } });
  }
  let stream: Readable | null = null;
  try {
    const row = await originalRow(app, p);
    if (o.external && row && externalWithheld(p.cls, row.original_closed)) throw notFound();
    // a "text only" record's file — in the closed bucket while the record is open: stream from there, journal as closed
    const bucket = originalBucket(p.cls, row?.original_closed);
    stream = row?.original_key ? await app.storage.getStream(bucket, row.original_key).catch((e: { code?: unknown }) => {
      if (e?.code === "NoSuchKey" || e?.code === "NotFound") return null;
      throw e;
    }) : null;
    if (!stream || !row) throw notFound();
    const bytes = Number(row.original_bytes);
    // closed content is not given without a journal write (as read, search, list): the journal refused the event — error, no file
    await auditRead(app, null, { event_type: "read", class: bucket, record_ids: [p.rid], space_id: row.space_id,
                                 details: { op: "original_download", bytes: Number.isFinite(bytes) ? bytes : null, key_id: p.kid ?? null, ...(p.dl === true ? { deleted: true } : {}) }, ip });
    const s = stream;
    const timer = setTimeout(() => s.destroy(new Error("original send timeout")), ORIGINAL_LIMITS.sendTimeoutMs);
    timer.unref?.();
    s.once("close", () => { clearTimeout(timer); slot.release(); });
    s.on("error", (e) => log.warn("original_download_aborted", { error: String((e as Error)?.message ?? e).slice(0, 120) }));
    return new Response(Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>, { headers: originalHeaders(row) });
  } catch (e) {
    stream?.destroy();
    slot.release();
    throw e;
  }
}
