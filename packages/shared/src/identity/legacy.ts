import { directoryGroupMembers, directoryGroupSearch, directoryGroupsFind, directoryLogin, directorySearch, ldapConfig,
  type DirectoryPerson, type LdapConfig } from "../ldap.ts";
import { exchangeCode, fetchUserinfo, oidcConfig, ssoPerson, verifyIdToken, type OidcConfig } from "../oidc.ts";
import type { DirectorySource, LoginIdentity, LoginProvider } from "./ports.ts";
import { ProviderRegistry } from "./registry.ts";

/** Bind existing operations explicitly; gateway tests and embedders can retain their current transport seams. */
export function createIdentityProviders(flow = { ldapConfig, oidcConfig, ssoPerson, directoryLogin, exchangeCode, verifyIdToken, fetchUserinfo }) {
  const ldapProvider = {
    id: "ldap" as const, kind: "ldap" as const, profile: "active_directory",
    config: flow.ldapConfig,
    login: flow.directoryLogin,
    identity(_config: LdapConfig, person: DirectoryPerson): LoginIdentity<DirectoryPerson> {
      return { providerId: "ldap", subject: person.guid, email: person.mail,
        // A directory bind authenticates the account; it does not attest ownership of the mail attribute.
        emailVerified: false, name: person.name, givenName: person.givenName ?? null, groups: person.groups,
        department: person.department, employeeId: person.employeeId, raw: person };
    },
  } satisfies LoginProvider<ReturnType<typeof ldapConfig>, typeof directoryLogin, DirectoryPerson, DirectoryPerson>;

  const oidcProvider = {
    id: "oidc" as const, kind: "oidc" as const, profile: "keycloak_ad",
    config: flow.oidcConfig,
    login: { exchangeCode: flow.exchangeCode, verifyIdToken: flow.verifyIdToken, fetchUserinfo: flow.fetchUserinfo },
    identity(config: OidcConfig, claims: Record<string, unknown>) {
      const person = flow.ssoPerson(config, claims);
      return { providerId: "oidc", subject: person.sub, email: person.mail, emailVerified: person.mailVerified,
        name: person.name, givenName: person.givenName ?? null, groups: person.groups,
        department: person.department, employeeId: person.employeeId, raw: claims, person };
    },
  } satisfies LoginProvider<ReturnType<typeof oidcConfig>, unknown, Record<string, unknown>, Record<string, unknown>>;

  return new ProviderRegistry([ldapProvider, oidcProvider]);
}
export const identityProviders = createIdentityProviders();

export function createLdapDirectorySource(flow = { directorySearch, directoryGroupMembers, directoryGroupsFind, directoryGroupSearch }) {
  return {
    id: "ldap",
    people: { search: flow.directorySearch },
    departments: null,
    groups: { members: flow.directoryGroupMembers, find: flow.directoryGroupsFind, search: flow.directoryGroupSearch },
  } satisfies DirectorySource<unknown, null, unknown>;
}
export const ldapDirectorySource = createLdapDirectorySource();

/** The org-table importer owns the transaction for both people and departments; never split that transaction. */
export function orgTableSource<Upload>(upload: Upload): DirectorySource<{ upload: Upload }, { upload: Upload }, null> {
  return { id: "org_table", people: { upload }, departments: { upload }, groups: null };
}

export { createSmtpNotifier, smtpNotifier } from "./notifier.ts";
