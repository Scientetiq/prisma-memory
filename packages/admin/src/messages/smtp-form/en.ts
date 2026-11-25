import { productName } from "../../i18n/brand";
import type { LdapField } from "../../lib/ldap-form";

export const SMTP_GROUPS: Array<{ title: string; hint?: string; fields: LdapField[] }> = [
    { title: "Server", fields: [
            { key: "host", category: "smtp", kind: "text", label: "Mail server", placeholder: "mail.example.com", hint: "Host name or IPv4 address, without scheme or port." },
            { key: "port", category: "smtp", kind: "number", label: "Port", hint: "587 for STARTTLS, 465 for TLS from the first byte, 25 for no encryption." },
            { key: "security", category: "smtp", kind: "smtp_security", label: "Encryption", hint: "STARTTLS upgrades port 587 to TLS; TLS starts from the first byte on port 465. The server certificate is always checked." },
            { key: "insecure_ack", category: "smtp", kind: "bool", label: "I understand: without encryption, the login, password and messages travel over the network as plain text" },
            { key: "ca_cert", category: "smtp", kind: "multiline", label: "Server root certificate (PEM)", placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
                hint: "Required if the mail server certificate uses an internal CA. Empty uses the memory server’s system trust store." },
            { key: "timeout_sec", category: "smtp", kind: "number", label: "Timeout, s", hint: "1–120: connection and each server response." },
        ] },
    { title: "Sender account", hint: "An empty login sends without authentication (relay by the memory server’s address).", fields: [
            { key: "username", category: "smtp", kind: "text", label: "Login", placeholder: "memory@example.com" },
            { key: "password", category: "smtp", kind: "secret", label: "Password" },
        ] },
    { title: "Messages", fields: [
            { key: "from_address", category: "smtp", kind: "text", label: "From address", placeholder: "memory@example.com" },
            { key: "from_name", category: "smtp", kind: "text", label: "From name", get placeholder() { return `${productName()}`; } },
            { key: "workplace_url", category: "access", kind: "text", label: "Workspace URL for links", placeholder: "https://memory.example.com",
                hint: "Mail and agent responses link to the workspace. Empty mentions the section without a link." },
            { key: "admin_email", category: "smtp", kind: "text", label: "Administrator notification email", placeholder: "admin@example.com",
                hint: "Receives memory failures and reports. Empty shows notifications only in the panel." },
        ] },
    { title: "Queue", hint: "Mail is queued. Temporary failures retry with double the delay, up to one hour. After the final attempt, the message is marked as failed with a reason.", fields: [
            { key: "max_attempts", category: "smtp", kind: "number", label: "Attempts per message", hint: "1–20." },
            { key: "retry_base_sec", category: "smtp", kind: "number", label: "Initial retry delay, s", hint: "1–3600." },
            { key: "keep_days", category: "smtp", kind: "number", label: "Mail log retention, days", hint: "1–365: sent and abandoned messages are kept, then deleted." },
        ] },
];

export const SMTP_ENABLED: LdapField = { key: "enabled", category: "smtp", kind: "bool", label: "Mail sending is enabled",
    hint: "When off, messages wait in the queue. Enable once server and sender address are set. Test mail works while sending is off." };

export const MAIL_KIND_TITLES: Record<string, string> = {
    test: "test message",
    approval: "approval request",
    meeting_delete: "meeting deletion request",
    curator_digest: "weekly curator digest",
    meeting_new: "new meeting notification",
    custody: "departed employee’s record handover",
};

export const MAIL_STATUS_TITLES: Record<string, string> = {
    pending: "waiting",
    sending: "sending",
    sent: "sent",
    failed: "failed",
    cancelled: "cancelled",
};

export const SMTP_ERROR_TITLES: Record<string, string> = {
    smtp_not_configured: "mail is not configured",
    smtp_dns_failed: "server name could not be resolved",
    smtp_unreachable: "server is unreachable",
    smtp_timeout: "server did not respond",
    smtp_tls_failed: "encryption or certificate error",
    smtp_auth_failed: "server rejected authentication",
    smtp_rejected: "server refused delivery",
    smtp_temporary: "temporary refusal",
    smtp_interrupted: "delivery was interrupted",
    smtp_failed: "mail was not sent",
    participant_removed: "person was removed from the meeting",
    recipient_not_participant: "recipient is not a meeting participant",
    recipient_check_failed: "recipient could not be verified",
    custody_not_current: "custody no longer matches the message",
};

export const TEXT = {
  unencryptedDelivery: "unencrypted delivery",
  portNormallyUsesButTLSFromThe: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Port ${value1} normally uses ${value2}, but TLS from the first byte is selected. The test message may wait until timeout. TLS normally uses port 465.`,
  noEncryption: "no encryption",
  portNormallyExpectsTLSFromTheFirst: (value1: string | number | null | undefined): string => `Port 465 normally expects TLS from the first byte, but “${value1}” is selected. The test message may wait until timeout. STARTTLS normally uses 587; unencrypted delivery uses 25.`,
  aLoginIsSetWithoutAPassword: "a login is set without a password; set a password or clear the login to send without authentication",
  aSenderAddressIsRequired: "a sender address is required",
  aServerIsRequiredMailExampleCom: "a server is required (mail.example.com)",
  mailLogRetentionMustBeDays: "mail log retention must be 1–365 days",
  retryDelayMustBeSeconds: "retry delay must be 1–3600 seconds",
  attemptsMustBe: "attempts must be 1–20",
  timeoutMustBeSeconds: "timeout must be 1–120 seconds",
  administratorEmailMustBeAnEmailAddress: "administrator email must be an email address",
  senderNameMustBeOneLineAt: "sender name must be one line, at most 100 characters, without quotes or angle brackets",
  senderAddressMustBeAnEmailAddress: "sender address must be an email address (memory@example.com)",
  loginMustBeOneLineAtMost: "login must be one line, at most 254 characters",
  theRootCertificateCouldNotBeParsed: "the root certificate could not be parsed: no -----BEGIN CERTIFICATE----- block",
  withoutEncryptionMailLoginAndPasswordTravel: "without encryption, mail, login and password travel as plain text; acknowledge the risk or choose STARTTLS",
  encryptionMustBeSTARTTLSTLSOrNo: "encryption must be STARTTLS, TLS or no encryption",
  portMustBeForSTARTTLSForTLS: "port must be 1–65535 (587 for STARTTLS, 465 for TLS)",
  serverMustBeAHostNameMail: "server must be a host name (mail.example.com) or IPv4 address, without scheme or port",
};
