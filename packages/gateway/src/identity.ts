// Bind the established operations at the gateway boundary, preserving transport substitution and test seams.
import { createIdentityProviders, createLdapDirectorySource, createNoneNotifier, createSmtpNotifier, directoryLogin, directorySearch,
  directoryGroupMembers, directoryGroupsFind, directoryGroupSearch, enqueueMail, ldapConfig, oidcConfig, ssoPerson, exchangeCode, verifyIdToken, fetchUserinfo,
  notifierFor, sendMail, type IdentitySettings, type MailNotifier } from "@memory/shared";

export const identityProviders = createIdentityProviders({ ldapConfig, oidcConfig, ssoPerson, directoryLogin, exchangeCode, verifyIdToken, fetchUserinfo });
export const ldapDirectorySource = createLdapDirectorySource({ directorySearch, directoryGroupMembers, directoryGroupsFind, directoryGroupSearch });
export const smtpNotifier = createSmtpNotifier(enqueueMail, sendMail);
const mailAdapters = { smtp: smtpNotifier, none: createNoneNotifier(enqueueMail, sendMail) };

export function mailNotifierFor(settings: IdentitySettings): MailNotifier {
  return notifierFor(settings, mailAdapters);
}
