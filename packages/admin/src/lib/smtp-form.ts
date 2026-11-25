import { derivedList } from "../i18n/runtime";
import { SMTP_GROUPS, SMTP_ENABLED, MAIL_KIND_TITLES, MAIL_STATUS_TITLES, SMTP_ERROR_TITLES, TEXT } from "../messages/smtp-form";
import { parseLdapField, type LdapField, type LdapFieldKind } from "./ldap-form";

export { SMTP_GROUPS } from "../messages/smtp-form";

export { SMTP_ENABLED } from "../messages/smtp-form";

export const SMTP_FIELDS: LdapField[] = derivedList(() => [SMTP_ENABLED, ...SMTP_GROUPS.flatMap((g) => g.fields)]) as LdapField[];

export const smtpInput = (key: string): string => `smtp:${key}`;

export const SMTP_STANDARD_PORTS: Readonly<Record<string, number>> = { starttls: 587, tls: 465, none: 25 };

export function smtpPortAdvice(security: string, port: number): string | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  if (port === 465 && security !== "tls") return TEXT.portNormallyExpectsTLSFromTheFirst(security === "none" ? TEXT.noEncryption : "STARTTLS");
  if (security === "tls" && (port === 587 || port === 25)) return TEXT.portNormallyUsesButTLSFromThe(port, port === 587 ? "STARTTLS" : TEXT.unencryptedDelivery);
  return null;
}

export function smtpPortOnModeChange(port: string, nextSecurity: string): string | null {
  const next = SMTP_STANDARD_PORTS[nextSecurity];
  if (!next) return null;
  const n = Number(port.trim());
  const standard = !port.trim() || n === 0 || Object.values(SMTP_STANDARD_PORTS).includes(n);
  return standard && n !== next ? String(next) : null;
}
export const SMTP_CLEAR_SECRET = "clear:password";

const MAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export interface SmtpFormValues {
  enabled: boolean; host: string; port: number; security: string; insecure_ack: boolean; ca_cert: string; username: string; password_set: boolean;
  from_address: string; from_name: string; admin_email: string; timeout_sec: number; max_attempts: number; retry_base_sec: number; keep_days: number;
}

export function smtpFormProblems(v: SmtpFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  const bad = (key: string, message: string) => { if (!out[key]) out[key] = message; };
  const host = v.host.trim().toLowerCase(), from = v.from_address.trim().toLowerCase(), adminMail = v.admin_email.trim().toLowerCase();
  const username = v.username.trim(), fromName = v.from_name.trim();
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (host && !HOST_RE.test(host) && !IPV4_RE.test(host)) bad("host", TEXT.serverMustBeAHostNameMail);
  if (!int(v.port, 1, 65535)) bad("port", TEXT.portMustBeForSTARTTLSForTLS);
  if (!["starttls", "tls", "none"].includes(v.security)) bad("security", TEXT.encryptionMustBeSTARTTLSTLSOrNo);
  if (v.security === "none" && !v.insecure_ack) bad("insecure_ack", TEXT.withoutEncryptionMailLoginAndPasswordTravel);
  if (v.ca_cert && !/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(v.ca_cert)) bad("ca_cert", TEXT.theRootCertificateCouldNotBeParsed);
  if (username.length > 254 || /[\r\n]/.test(username)) bad("username", TEXT.loginMustBeOneLineAtMost);
  if (from && !MAIL_RE.test(from)) bad("from_address", TEXT.senderAddressMustBeAnEmailAddress);
  if (fromName.length > 100 || /[\r\n<>"]/.test(fromName)) bad("from_name", TEXT.senderNameMustBeOneLineAt);
  if (adminMail && !MAIL_RE.test(adminMail)) bad("admin_email", TEXT.administratorEmailMustBeAnEmailAddress);
  if (!(v.timeout_sec >= 1 && v.timeout_sec <= 120)) bad("timeout_sec", TEXT.timeoutMustBeSeconds);
  if (!int(v.max_attempts, 1, 20)) bad("max_attempts", TEXT.attemptsMustBe);
  if (!int(v.retry_base_sec, 1, 3600)) bad("retry_base_sec", TEXT.retryDelayMustBeSeconds);
  if (!int(v.keep_days, 1, 365)) bad("keep_days", TEXT.mailLogRetentionMustBeDays);
  if (v.enabled) {
    if (!host) bad("host", TEXT.aServerIsRequiredMailExampleCom);
    if (!from) bad("from_address", TEXT.aSenderAddressIsRequired);
    if (username && !v.password_set) bad("password", TEXT.aLoginIsSetWithoutAPassword);
  }
  return out;
}

export function smtpFormValues(get: (key: string) => string | null, secretSet: boolean): SmtpFormValues {
  const val = (key: string, kind: LdapFieldKind): unknown => { const r = parseLdapField(kind, get(key)); return r.ok ? r.value : Number.NaN; };
  const text = (key: string, kind: LdapFieldKind = "text") => String(val(key, kind) ?? "");
  const num = (key: string) => Number(val(key, "number"));
  return {
    enabled: get("enabled") === "on", host: text("host"), port: num("port"), security: (get("security") ?? "").trim(), insecure_ack: get("insecure_ack") === "on",
    ca_cert: text("ca_cert", "multiline"), username: text("username"), password_set: secretSet || (get("password") ?? "").trim() !== "",
    from_address: text("from_address"), from_name: text("from_name"), admin_email: text("admin_email"),
    timeout_sec: num("timeout_sec"), max_attempts: num("max_attempts"), retry_base_sec: num("retry_base_sec"), keep_days: num("keep_days"),
  };
}

export { MAIL_KIND_TITLES } from "../messages/smtp-form";

export { MAIL_STATUS_TITLES } from "../messages/smtp-form";

export { SMTP_ERROR_TITLES } from "../messages/smtp-form";
