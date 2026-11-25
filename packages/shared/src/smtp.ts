import { instanceLocale } from "@memory/i18n/context";
import { MAIL_KINDS as GEN_MAIL_KINDS, type MailKind as GenMailKind } from "./enums.gen.ts";
import nodemailer from "nodemailer";
import { isIP } from "node:net";
import type pg from "pg";
import type { DataClass } from "./db.ts";
import { newId } from "./ids.ts";
import { renderMail } from "./mail-render.ts";
import { parseCaCerts } from "./ldap.ts";
import type { Settings } from "./settings.ts";
import { createHmac } from "node:crypto";
import { canonicalJson, derivedKey } from "./settings-policy.ts";
import { hostLocality } from "./models/address.ts";

export type SmtpSecurity = "starttls" | "tls" | "none";
export const SMTP_SECURITY: SmtpSecurity[] = ["starttls", "tls", "none"];

export interface SmtpConfig {
  enabled: boolean; host: string; port: number; security: SmtpSecurity; insecure_ack: boolean; ca_cert: string;
  username: string; password: string; from_address: string; from_name: string; admin_email: string;
  timeout_sec: number; max_attempts: number; retry_base_sec: number; keep_days: number;
}

export function smtpConfig(s: Pick<Settings, "get">): SmtpConfig {
  const str = (k: string, d = "") => { const v = s.get<unknown>(`smtp.${k}`, d); return typeof v === "string" ? v.trim() : d; };
  const num = (k: string, d: number) => { const v = Number(s.get<unknown>(`smtp.${k}`, d)); return Number.isFinite(v) ? v : d; };
  const security = str("security", "starttls") as SmtpSecurity;
  const password = s.get<unknown>("smtp.password", "");
  return {
    enabled: s.get<unknown>("smtp.enabled", false) === true, host: str("host").toLowerCase(), port: num("port", 587),
    security: SMTP_SECURITY.includes(security) ? security : ("" as SmtpSecurity), insecure_ack: s.get<unknown>("smtp.insecure_ack", false) === true,
    ca_cert: str("ca_cert"), username: str("username"), password: typeof password === "string" ? password : "",
    from_address: str("from_address").toLowerCase(), from_name: str("from_name", "Prisma Memory"), admin_email: str("admin_email").toLowerCase(),
    timeout_sec: num("timeout_sec", 10), max_attempts: num("max_attempts", 6), retry_base_sec: num("retry_base_sec", 60),
    keep_days: num("keep_days", 30),
  };
}

export const SMTP_TRANSPORT_FIELDS = ["host", "port", "security", "insecure_ack", "ca_cert", "username", "password", "from_address"] as const;

export function smtpTransportDigest(appSecret: string, cfg: Pick<SmtpConfig, (typeof SMTP_TRANSPORT_FIELDS)[number]>): string {
  const fields = Object.fromEntries(SMTP_TRANSPORT_FIELDS.map((k) => [k, cfg[k]]));
  return createHmac("sha256", derivedKey(appSecret, "memory-smtp-transport")).update(canonicalJson(fields)).digest("hex");
}

export const MAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export function smtpProblems(cfg: SmtpConfig): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  const bad = (key: string, message: string) => out.push({ key, message });
  if (cfg.host && !HOST_RE.test(cfg.host) && !IPV4_RE.test(cfg.host)) bad("host", "server — a name (mail.example.com) or an IPv4 address, without a scheme and port");
  if (!(Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535)) bad("port", "port must be 1–65535 (587 for STARTTLS, 465 for TLS)");
  if (!cfg.security) bad("security", "encryption must be STARTTLS, TLS or no encryption");
  if (cfg.security === "none" && !cfg.insecure_ack) bad("insecure_ack", "without encryption, mail, login and password travel as plain text; acknowledge the risk or choose STARTTLS");
  if (cfg.ca_cert) { try { parseCaCerts(cfg.ca_cert); } catch (e) { bad("ca_cert", `could not parse the root certificate: ${(e as Error).message}`); } }
  if (cfg.username.length > 254 || /[\r\n]/.test(cfg.username)) bad("username", "login must be one line, at most 254 characters");
  if (cfg.from_address && !MAIL_RE.test(cfg.from_address)) bad("from_address", "sender address — an e-mail (memory@example.com)");
  if (cfg.from_name.length > 100 || /[\r\n<>"]/.test(cfg.from_name)) bad("from_name", "sender name must be one line, at most 100 characters, without quotes or angle brackets");
  if (cfg.admin_email && !MAIL_RE.test(cfg.admin_email)) bad("admin_email", "administrator email must be an email address");
  if (!(cfg.timeout_sec >= 1 && cfg.timeout_sec <= 120)) bad("timeout_sec", "timeout must be 1–120 seconds");
  if (!(Number.isInteger(cfg.max_attempts) && cfg.max_attempts >= 1 && cfg.max_attempts <= 20)) bad("max_attempts", "attempts must be 1–20");
  if (!(Number.isInteger(cfg.retry_base_sec) && cfg.retry_base_sec >= 1 && cfg.retry_base_sec <= 3600)) bad("retry_base_sec", "retry delay must be 1–3600 seconds");
  if (!(Number.isInteger(cfg.keep_days) && cfg.keep_days >= 1 && cfg.keep_days <= 365)) bad("keep_days", "mail log retention must be 1–365 days");
  if (cfg.enabled) {
    if (!cfg.host) bad("host", "a server is required (mail.example.com)");
    if (!cfg.from_address) bad("from_address", "a sender address is required");
    if (cfg.username && !cfg.password) bad("password", "a login is set without a password; set a password or clear the login to send without authentication");
  }
  return out;
}

export const retryDelaySec = (cfg: Pick<SmtpConfig, "retry_base_sec">, attempts: number): number =>
  Math.min(3600, cfg.retry_base_sec * 2 ** Math.max(0, attempts - 1));

export type SmtpFailureCode =
  | "smtp_disabled" | "smtp_not_configured" | "smtp_dns_failed" | "smtp_unreachable" | "smtp_timeout" | "smtp_tls_failed"
  | "smtp_auth_failed" | "smtp_rejected" | "smtp_temporary" | "smtp_failed";

export class SmtpFailure extends Error {
  constructor(readonly code: SmtpFailureCode, message: string, readonly detail = "", readonly permanent = false) { super(message); this.name = "SmtpFailure"; }
}

interface MailerError { code?: string; responseCode?: number; response?: string; command?: string; message?: string; reason?: string; library?: string }

/**
 * Transport hold. Encryption that could not be set up (STARTTLS refused, TLS handshake, the
 * certificate) and a refused login are faults of the mail settings or of the server, not of the letter: the queue does
 * not count them as an attempt, stops the pass at the first one and pauses the transport (jobs/mail.ts). Letters wait in
 * the queue instead of being dropped, and a wrong password costs one login per pause, not one per letter.
 */
export const SMTP_HOLD_CODES: readonly SmtpFailureCode[] = ["smtp_tls_failed", "smtp_auth_failed"];
export const smtpTransportHold = (code: string): boolean => (SMTP_HOLD_CODES as readonly string[]).includes(code);
/**
 * Pause after a refused login: at most one failed login an hour, far below an account lockout threshold (AD counts
 * failures within a window of minutes), so the queue never locks the mail account.
 */
export const SMTP_AUTH_HOLD_SEC = 3600;
/** Pause of a held transport: a refused login — SMTP_AUTH_HOLD_SEC; encryption — retry_base_sec, doubling, an hour at most. */
export function holdPauseSec(cfg: Pick<SmtpConfig, "retry_base_sec">, code: string, prevSec: number | null): number {
  if (code === "smtp_auth_failed") return SMTP_AUTH_HOLD_SEC;
  return Math.min(3600, Math.max(cfg.retry_base_sec, prevSec && prevSec > 0 ? 2 * prevSec : cfg.retry_base_sec));
}

/**
 * End a transport hold now: a test letter just went through with the current settings, so whatever broke
 * encryption or the login was fixed on the server side. Held letters become due at once; returns how many.
 */
export async function releaseMailHold(q: Pick<pg.Pool, "query">, instanceId: string): Promise<number> {
  return (await q.query(
    `UPDATE mail_outbox SET next_attempt_at = now(), updated_at = now()
      WHERE instance_id = $1 AND status = 'pending' AND last_error_code = ANY($2::text[]) AND next_attempt_at > now()`,
    [instanceId, [...SMTP_HOLD_CODES]])).rowCount ?? 0;
}

const STARTTLS_MISSING = "The server does not offer STARTTLS. Select TLS (port 465) or check the server settings";
/** Commands of the SMTP session before the envelope: a refusal here is about the server or the settings, not the letter. */
const SESSION_COMMANDS = new Set(["CONN", "EHLO", "HELO", "LHLO"]);
/** Commands of the envelope (nodemailer: "MAIL FROM", "RCPT TO", "DATA"): a reply here is about this letter. */
const ENVELOPE_COMMAND = /^(MAIL FROM|RCPT TO|DATA)\b/;
/**
 * The server's reply without the addresses it echoes («550 5.1.1 <cert@example.test>: … rejected»): words are looked up
 * in what the server said, never in a recipient's name.
 */
const replyWords = (s: string): string => s.replace(/<[^<>]*>/g, "<>").replace(/[^\s<>:;,"]+@[^\s<>:;,"]+/g, "@");
/**
 * A TLS handshake refused: the reasons OpenSSL gives only in negotiation — an alert of the server
 * about versions or ciphers, no version or cipher in common, a key or a renegotiation the client refuses. nodemailer keeps
 * the OpenSSL fields library and reason (only the code is overwritten); the text is for an error that lost them. Not a
 * sign: «SSL routines» or an «alert» as such — an error of the record layer of an established session («bad record
 * type», «bad record mac», «decryption failed») is one too, and it may come from the letter being sent.
 */
const TLS_HANDSHAKE_REFUSED = /alert (protocol version|handshake failure|insufficient security)|unsupported protocol|no shared cipher|no protocols available|no ciphers available|no suitable signature algorithm|dh key too small|unsafe legacy renegotiation disabled|version too low/i;

export function smtpFailure(e: unknown, cfg: Pick<SmtpConfig, "host" | "port" | "security">): SmtpFailure {
  if (e instanceof SmtpFailure) return e;
  const x = (e ?? {}) as MailerError;
  const msg = String(x.message ?? e ?? "").slice(0, 300);
  const code = String(x.code ?? ""), rc = Number(x.responseCode ?? 0), cmd = String(x.command ?? "").toUpperCase();
  const where = `${cfg.host}:${cfg.port}`;
  const words = replyWords(String(x.response ?? msg));
  // the server's reply on the envelope is decided first and by its code. nodemailer puts that reply
  // into the message, and the reply echoes the recipient («<cert@…>», «<timeout@…>»): the word rules below would read a
  // refused recipient as a certificate or a timeout and pause the whole transport. Only 530/538 «encryption needed» and
  // 534/535 «login» are about the settings here; any other 5xx is a refusal of this letter, 4xx — try later.
  if (rc > 0 && (code === "EENVELOPE" || code === "EMESSAGE" || ENVELOPE_COMMAND.test(cmd))) {
    if (rc === 534 || rc === 535 || (rc === 530 && /auth/i.test(words)))
      return new SmtpFailure("smtp_auth_failed", "The server rejected the username or password. Check the sender account in “Mail (SMTP)”", msg);
    if (rc === 538 || (rc === 530 && /STARTTLS|TLS|encrypt/i.test(words)))
      return new SmtpFailure("smtp_tls_failed", `Mail server ${where} requires encryption: choose STARTTLS (port 587) or TLS (port 465)`, msg);
    if (rc >= 400 && rc < 500)
      return new SmtpFailure("smtp_temporary", `The server temporarily refused the message (${rc}). It will be retried later`, msg);
    if (rc >= 500)
      return cmd.startsWith("DATA") || code === "EMESSAGE"
        ? new SmtpFailure("smtp_rejected", `Mail server ${where} refused the letter (${rc}): ${(x.response ?? msg).slice(0, 160)}`, msg, true)
        : new SmtpFailure("smtp_rejected", `The server rejected the sender or recipient address: ${(x.response ?? msg).slice(0, 160)}`, msg, true);
  }
  // the login and STARTTLS are decided by the fields of the error before any word rule. nodemailer appends
  // the server's reply to the message, and a refused login «535 … Authentication failed: timeout» or a refused STARTTLS
  // «454 … TLS negotiation timeout» / «… ECONNREFUSED» read by words as a timeout or a closed port: no transport hold,
  // one login per letter of the pass, the attempt counted. The network words apply only without a server reply.
  // the server demands encryption the settings do not use (security "none"), on AUTH too («530 5.7.0 Must issue a
  // STARTTLS command first» is not a wrong password): a settings fault, not the letter's. On AUTH over TLS
  // encryption is there already: «530 … Authentication failed (TLS connection)» is a refused login — the hour of pause
  // after it (holdPauseSec) must not shrink to retry_base_sec because the reply names TLS
  const authStep = code === "EAUTH" || cmd.startsWith("AUTH");
  if ((rc === 530 || rc === 538) && /STARTTLS|TLS|encrypt/i.test(words) && !(authStep && cfg.security !== "none"))
    return new SmtpFailure("smtp_tls_failed", `Mail server ${where} requires encryption: choose STARTTLS (port 587) or TLS (port 465)`, msg);
  if (code === "EAUTH" || rc === 535 || rc === 534 || (rc === 530 && /auth/i.test(words)))
    return new SmtpFailure("smtp_auth_failed", "The server rejected the username or password. Check the sender account in “Mail (SMTP)”", msg);
  // the network, DNS and timeouts: by the code of the error, by words only when the server sent no reply and the error is
  // not one of encryption (a reply is the server speaking, not the network failing). They stay before the TLS word
  // rules below: «getaddrinfo ENOTFOUND mail.cert.example» is a name that does not resolve, not a certificate
  const netWords = !rc && code !== "ETLS";
  if (code === "EDNS" || (netWords && /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(msg)))
    return new SmtpFailure("smtp_dns_failed", `The memory server cannot resolve mail server ${cfg.host}. Check the name or enter an IP address`, msg);
  if (netWords && /ECONNREFUSED/.test(msg))
    return new SmtpFailure("smtp_unreachable", `The port is closed. Server ${where} is refusing connections. Check the port (587 — STARTTLS, 465 — TLS) and access from the memory server`, msg);
  if (netWords && /EHOSTUNREACH|ENETUNREACH/.test(msg))
    return new SmtpFailure("smtp_unreachable", `The memory server cannot reach mail server ${where}. A network route to it is required`, msg);
  if (code === "ETIMEDOUT" || (netWords && /timeout|timed out/i.test(msg)))
    return new SmtpFailure("smtp_timeout", `Server ${where} did not respond in time. A firewall may be blocking the port or the server may be overloaded`, msg);
  if (/STARTTLS/i.test(msg) && /not|support|offer/i.test(msg))
    return new SmtpFailure("smtp_tls_failed", STARTTLS_MISSING, msg);
  // errors of the local TLS library (handshake, certificate) carry no reply of the server; a reply that names a host
  // like «mx.cert.example» is not a certificate, and neither is a reply without a code left over when the server
  // closed the connection (_onClose: ECONNECTION with «certificate …» in the response)
  const local = !rc && !x.response;
  if (local && /wrong version number|WRONG_VERSION|packet length too long|ssl3_get_record/i.test(msg))
    return new SmtpFailure("smtp_tls_failed", cfg.security === "tls"
      ? `Server ${where} does not expect TLS from the first byte. Select STARTTLS on port 587`
      : `Server ${where} did not return an SMTP response. Check the port and encryption (465 — TLS)`, msg);
  if (local && /CERT|certificate|self[- ]signed|UNABLE_TO_(GET|VERIFY)|altname|Hostname\/IP does not match/i.test(msg))
    return new SmtpFailure("smtp_tls_failed", `The certificate for server ${cfg.host} failed verification. Add the company’s root certificate or check the server name (${msg.slice(0, 120)})`, msg);
  // a TLS handshake the server refuses — TLS 1.0/1.1 only, no cipher in common — comes
  // from nodemailer as ESOCKET on CONN without a reply, with TLS from the first byte (465) and after an accepted STARTTLS
  // alike: the async error of the new TLSSocket goes to _onSocketError (smtp-connection index.js:953), not to the ETLS
  // callback. Encryption that could not be set up, as a refused STARTTLS is: a transport hold. Told by the reason of the
  // refusal (TLS_HANDSHAKE_REFUSED), not by the stage, which nodemailer does not keep: ESOCKET on CONN is every error of
  // the socket, during DATA too — an error of an established session or a dropped connection stays an ordinary failure of
  // the letter with its attempt counted (a hold there would let one letter stop all mail for ever).
  if (local && code === "ESOCKET" && cmd === "CONN" && cfg.security !== "none" && TLS_HANDSHAKE_REFUSED.test(`${x.reason ?? ""}\n${msg}`))
    return new SmtpFailure("smtp_tls_failed", `TLS handshake with mail server ${where} failed${x.reason ? ` (${String(x.reason).slice(0, 80)})` : ""}: the server may accept only TLS below 1.2 or other ciphers — update the TLS settings of the mail server${cfg.security === "tls" ? ", or choose STARTTLS (port 587) if it offers it" : ", or choose TLS (port 465) if it offers it"}`, msg);
  // the reply to STARTTLS (and a failed EHLO when STARTTLS is required) comes before encryption and is not
  // protected by anything. A server without STARTTLS and a middlebox that strips it both answer 5xx here
  // ("500 5.5.1 Unrecognized command"), so the code of that reply says nothing about the letter: never permanent.
  if (cmd === "STARTTLS" || (cmd === "EHLO" && cfg.security === "starttls" && rc >= 500))
    return new SmtpFailure("smtp_tls_failed", STARTTLS_MISSING, msg);
  if (code === "ETLS")
    return new SmtpFailure("smtp_tls_failed", `Encryption with mail server ${where} was not established: ${msg.slice(0, 160)}`, msg);
  // 5xx on the greeting or on HELO: the server refuses the session itself (and under STARTTLS that reply is not
  // protected either) — like an unreachable server, retried and never permanent; it is not a refusal of an address
  if (rc >= 500 && SESSION_COMMANDS.has(cmd))
    return new SmtpFailure("smtp_unreachable", `Mail server ${where} refused the session (${rc}) before any letter was sent: check that it accepts mail from the memory server — ${(x.response ?? msg).slice(0, 160)}`, msg);
  if (rc >= 400 && rc < 500)
    return new SmtpFailure("smtp_temporary", `The server temporarily refused the message (${rc}). It will be retried later`, msg);
  if (code === "EENVELOPE" || (rc >= 550 && rc < 560))
    return new SmtpFailure("smtp_rejected", `The server rejected the sender or recipient address: ${(x.response ?? msg).slice(0, 160)}`, msg, true);
  if (rc >= 500)
    return new SmtpFailure("smtp_rejected", `The server refused the message (${rc}): ${(x.response ?? msg).slice(0, 160)}`, msg, true);
  return new SmtpFailure("smtp_failed", `The e-mail was not sent: ${msg.slice(0, 160)}`, msg);
}

export interface MailMessage { to: string; subject: string; text: string }
export interface MailSent { messageId: string; response: string }

/**
 * One checked DNS answer for both the test route and queued delivery (including alerts). Reuse the model connector's
 * address rule through hostLocality: private/loopback are allowed, a refused address rejects the whole answer.
 * Nodemailer receives an IP literal so its DNS cache/resolver cannot select a different address after the check.
 * Keep the configured name for certificate verification and SNI in both implicit TLS and STARTTLS. No connection pool.
 * Returns the addresses of that one answer in the order they are tried: IPv4 first (nodemailer's preference), then the rest.
 */
async function checkedSmtpAddresses(cfg: SmtpConfig): Promise<string[]> {
  const ms = cfg.timeout_sec * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checked = await Promise.race([
    hostLocality(cfg.host),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SmtpFailure("smtp_timeout", `Mail server ${cfg.host}:${cfg.port} did not resolve before the SMTP timeout`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
  if (checked.status === "unresolved")
    throw new SmtpFailure("smtp_dns_failed", `Mail server name ${cfg.host} could not be resolved: check the name or specify an IP address`);
  if (checked.status === "refused")
    throw new SmtpFailure("smtp_unreachable", `Mail server ${cfg.host}:${cfg.port} has an address of class ${checked.kind} refused by the destination policy`);
  const all = checked.addresses.map((a) => a.address);
  return [...all.filter((a) => isIP(a) === 4), ...all.filter((a) => isIP(a) !== 4)];
}

/** The mailer for ONE address of the checked answer (an IP literal); the configured name stays the TLS name. */
function mailerFor(cfg: SmtpConfig, address: string) {
  const ms = cfg.timeout_sec * 1000;
  return nodemailer.createTransport({
    host: address, port: cfg.port, secure: cfg.security === "tls", requireTLS: cfg.security === "starttls", ignoreTLS: cfg.security === "none",
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: IPV4_RE.test(cfg.host) ? undefined : cfg.host, ...(cfg.ca_cert ? { ca: cfg.ca_cert } : {}) },
    connectionTimeout: ms, greetingTimeout: ms, socketTimeout: ms * 3, dnsTimeout: ms,
    disableFileAccess: true, disableUrlAccess: true,
    name: "memory",
  } as any);
}

/** At most this many addresses of one checked answer are tried for one letter. */
export const SMTP_ADDRESSES_TRIED = 3;
const TLS_IN_ERROR = /tls|ssl|certificate|handshake|cert_|self[ _-]signed/i;

/**
 * The next address of the same checked answer is tried only when TCP did not connect or, under implicit TLS,
 * the handshake did not finish before the connect timer fired. Nodemailer labels socket errors "CONN" in any phase,
 * so require the socket's own failed connect (ESOCKET with syscall "connect") or the timer's "Connection timeout".
 * A missing greeting, a server reply, a later socket error or a TLS error does not qualify.
 */
function connectFailedBeforeGreeting(e: unknown): boolean {
  const x = e as { code?: string; command?: string; responseCode?: number; syscall?: string; message?: string } | null;
  if (!x || x.command !== "CONN" || x.responseCode !== undefined) return false;
  if (TLS_IN_ERROR.test(x.message ?? "")) return false;
  return (x.code === "ESOCKET" && x.syscall === "connect") || (x.code === "ETIMEDOUT" && x.message === "Connection timeout");
}

export async function sendMail(cfg: SmtpConfig, m: MailMessage): Promise<MailSent> {
  if (!cfg.host || !cfg.from_address) throw new SmtpFailure("smtp_not_configured", "Mail setup is incomplete. A server and sender address are required under “Mail (SMTP)” in the admin panel");
  const problems = smtpProblems({ ...cfg, enabled: true });
  if (problems.length) throw new SmtpFailure("smtp_not_configured", `Mail settings are invalid: ${problems.map((p) => `${p.key}: ${p.message}`).join("; ").slice(0, 300)}`);
  if (!MAIL_RE.test(m.to)) throw new SmtpFailure("smtp_rejected", `Recipient address “${m.to.slice(0, 80)}” is not a valid e-mail address`, "", true);
  // One resolution and one check; only addresses of that answer are handed to the mailer. The next
  // one is tried only when the previous gave no connection, within the common limit of three connection timeouts.
  const addresses = (await checkedSmtpAddresses(cfg)).slice(0, SMTP_ADDRESSES_TRIED);
  const deadline = Date.now() + cfg.timeout_sec * 1000 * SMTP_ADDRESSES_TRIED;
  for (let i = 0; ; i++) {
    const t = mailerFor(cfg, addresses[i]!);
    try {
      const info = await t.sendMail({
        from: { name: cfg.from_name || "Prisma Memory", address: cfg.from_address }, to: m.to, subject: m.subject.replace(/[\r\n]+/g, " ").slice(0, 250),
        text: m.text, headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
      });
      return { messageId: String(info.messageId ?? ""), response: String(info.response ?? "").slice(0, 200) };
    } catch (e) {
      if (!(i + 1 < addresses.length && connectFailedBeforeGreeting(e) && Date.now() < deadline)) throw smtpFailure(e, cfg);
    } finally {
      t.close();
    }
  }
}

/** The test message of "Send a test message" (template mail.test): no memory content, with the workspace address to check links. */
export function testMail(to: string, workplaceUrl: string, by: string): MailMessage {
  return { to, ...renderMail("mail.test", instanceLocale(), { workplaceUrl, by }) };
}

export type MailKind = GenMailKind;
export const MAIL_KINDS: MailKind[] = [...GEN_MAIL_KINDS];
export type MailStatus = "pending" | "sending" | "sent" | "failed" | "cancelled";

export const MAIL_JOURNAL_SUBJECTS: Partial<Record<MailKind, string>> = {
  meeting_delete: "{product}: request to delete a meeting",
  meeting_new: "Prisma Memory: new meeting — you are a participant",
  custody: "Prisma Memory: Keeping a former employee’s records",
};

export function journalSubject(kind: string, subject: string): string {
  return MAIL_JOURNAL_SUBJECTS[kind as MailKind] ?? subject;
}

export async function enqueueMail(q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">, instanceId: string,
                                  m: MailMessage & { kind: MailKind; dedupeKey?: string | null; createdBy?: string | null }): Promise<{ id: string; created: boolean }> {
  if (!MAIL_RE.test(m.to)) throw new SmtpFailure("smtp_rejected", `Recipient address “${m.to.slice(0, 80)}” is not a valid e-mail address`, "", true);
  if (!MAIL_KINDS.includes(m.kind)) throw new Error(`unknown e-mail type ${m.kind}`);
  const id = newId();
  const ins = await q.query(
    `INSERT INTO mail_outbox (id, instance_id, kind, to_address, subject, body_text, dedupe_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [id, instanceId, m.kind, m.to.toLowerCase(), m.subject.replace(/[\r\n]+/g, " ").slice(0, 250), m.text, m.dedupeKey ?? null, m.createdBy ?? null]);
  if (ins.rowCount) return { id, created: true };
  const prev = await q.query("SELECT id FROM mail_outbox WHERE instance_id = $1 AND dedupe_key = $2", [instanceId, m.dedupeKey]);
  return { id: prev.rows[0].id as string, created: false };
}

export const MEETING_MAIL_NOT_PARTICIPANT = "recipient_not_participant";
export const MEETING_MAIL_NOT_PARTICIPANT_TEXT = "The e-mail was not sent because the recipient is no longer a participant, the meeting was deleted or the person is inactive";

export function meetingMailKey(key: string | null | undefined): { recordId: string; personId: string } | null {
  const m = /^meeting_new:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(key ?? "");
  return m ? { recordId: m[1]!, personId: m[2]! } : null;
}

type MailQueryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export async function meetingMailRecipientOk(src: { control: MailQueryable; records: (cls: DataClass) => MailQueryable }, instanceId: string,
                                             dedupeKey: string | null | undefined): Promise<boolean> {
  const k = meetingMailKey(dedupeKey);
  if (!k) return false;
  if (!(await src.control.query("SELECT 1 FROM people WHERE id = $1 AND instance_id = $2 AND active", [k.personId, instanceId])).rows.length) return false;
  const loc = (await src.control.query("SELECT class FROM record_locations WHERE record_id = $1 AND NOT deleted", [k.recordId])).rows[0] as { class: DataClass } | undefined;
  if (!loc) return false;
  return (await src.records(loc.class).query(
    "SELECT 1 FROM records r JOIN record_people p ON p.record_id = r.id WHERE r.id = $1 AND r.deleted_at IS NULL AND p.person_id = $2", [k.recordId, k.personId])).rows.length > 0;
}
