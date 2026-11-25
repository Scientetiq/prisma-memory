import { instanceLocale } from "@memory/i18n/context";
import { circleOf } from "./custody.ts";
import { renderMail, type MailText } from "./mail-render.ts";
import { MAIL_RE } from "./smtp.ts";

export interface IdentityLinkChange { system: string; externalId: string; change: "added" | "removed" }

/**
 * Mail about changed account links (template identity.change, messages/mail-identity.ts), in the instance language.
 * `link` — the workspace address or null (then words). An empty list of changes is the caller's error: there is no mail
 * without a change.
 */
export function identityChangeMail(a: { changes: readonly IdentityLinkChange[]; link: string | null }): MailText {
  if (!a.changes.length) throw new Error("identityChangeMail: no identity links changed");
  return renderMail("identity.change", instanceLocale(), a);
}

export const identityMailable = (p: { active: boolean; demo: boolean; login: string | null }): boolean =>
  !!p.login && p.active && !p.demo && circleOf(p.login) === "staff" && MAIL_RE.test(p.login);

export const identityChangeMailKey = (personId: string, uploadId: string): string => `identity_change:${personId}:${uploadId}`;
