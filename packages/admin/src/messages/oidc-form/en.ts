import type { LdapField } from "../../lib/ldap-form";

export const OIDC_GROUPS: Array<{ title: string; hint?: string; fields: LdapField[] }> = [
    { title: "Provider", fields: [
            { key: "issuer", category: "oidc", kind: "text", label: "Issuer (issuer)", placeholder: "https://auth.example.com/realms/example",
                hint: "Issuer URL over HTTPS (in Keycloak: the realm URL). Metadata is read from …/.well-known/openid-configuration. The issuer in metadata and tokens must match this URL." },
            { key: "ca_cert", category: "oidc", kind: "multiline", label: "Identity provider root certificate (PEM)", placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
                hint: "Required if auth.example.com uses an internal CA. Empty uses the memory server’s system trust store. Change only together with the client secret." },
            { key: "timeout_sec", category: "oidc", kind: "number", label: "Timeout, s", hint: "1–60: metadata, keys and code exchange." },
            { key: "private_networks", category: "oidc", kind: "hosts", label: "Provider private networks", placeholder: "fd00::5/128",
                hint: "IP addresses or CIDRs separated by spaces or new lines, for example the proxy in front of the identity provider. Private addresses outside this list are blocked; empty blocks all private addresses. Loopback, link-local and cloud metadata addresses are always blocked." },
        ] },
    { title: "Workspace client", hint: "Confidential client at the identity provider: Standard flow, PKCE S256 and Client authentication enabled (step 1 above).", fields: [
            { key: "client_id", category: "oidc", kind: "text", label: "Client ID", hint: "As recorded at the identity provider (in Keycloak: Clients → workspace client → Client ID)." },
            { key: "client_secret", category: "oidc", kind: "secret", label: "Client secret" },
            { key: "redirect_uri", category: "oidc", kind: "text", label: "Return URL",
                hint: "Workspace URL + /auth/oidc/callback. Enter the same URL as an allowed redirect URI of the client at the identity provider (in Keycloak: Valid redirect URIs)." },
            { key: "scopes", category: "oidc", kind: "text", label: "Scopes", placeholder: "openid profile email", hint: "Space-separated; openid is required." },
        ] },
    { title: "Who can sign in", fields: [
            { key: "login_groups", category: "oidc", kind: "lines", label: "Access groups", placeholder: "MemoryAI-Users",
                hint: "One per line: an AD group name as returned by the identity provider, for example MemoryAI-Users (also matches /MemoryAI-Users), or a full group path. Case-sensitive: memoryai-users is a different group. A bare name also matches nested groups with that name; a full path (/MemoryAI-Users) is safer when the provider sends full group paths (in Keycloak: a group mapper with full.path). Only group members can sign in." },
            { key: "claims", category: "oidc", kind: "json", label: "Claim names",
                hint: "guid is LDAP_ID (AD objectGUID), identifying the person across directory sign-in methods. mail becomes the login if the identity provider verifies the email (mail_verified). given_name is used in the workspace greeting; if absent, it is derived from the full name." },
        ] },
];

export const OIDC_ENABLED: LdapField = { key: "enabled", category: "oidc", kind: "bool", label: "Workspace sign-in through the identity provider is enabled",
    hint: "Enable once issuer, client, secret, return URL and access group are set; otherwise the gateway refuses to save." };

export const OIDC_STEP_TITLES: Record<string, string> = {
    config: "settings",
    discovery: "metadata",
    issuer: "issuer",
    endpoints: "URLs and PKCE",
    jwks: "signing keys",
    redirect_uri: "return URL",
    client: "client",
    groups: "access groups",
};

export const TEXT = {
  isNotAPrivateNetworkItMust: (value1: string | number | null | undefined): string => `“${value1}” is not a private network: it must be within the RFC 1918 IPv4 ranges, 100.64.0.0/10 or fc00::/7`,
  isNotAnIPAddressOrCIDR: (value1: string | number | null | undefined): string => `“${value1}” is not an IP address or CIDR (for example, fd00::5/128)`,
  anAccessGroupMemoryUsersIsRequired: "an access group (memory-users) is required; without it nobody can sign in",
  aReturnURLIsRequiredHttpWorkspace: (value1: string | number | null | undefined): string => `a return URL is required (http://workspace-host${value1}), matching the client at the identity provider`,
  aClientSecretIsRequiredForThe: "a client secret is required for the confidential client at the identity provider",
  aClientIDIsRequiredTheCompany: "a client ID is required (the company’s client at the identity provider, for example memory)",
  anIssuerURLIsRequiredHttpsAuth: "an issuer URL is required (https://auth.example.com/realms/example)",
  atMostPrivateNetworks: "at most 20 private networks",
  timeoutMustBeSeconds: "timeout must be 1–60 seconds",
  claimMustBeAClaimNameLatin: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `claim ${value1}: “${value2}” must be a claim name (Latin letters, digits, _ . : -)`,
  eachGroupMustBeANameOr: "each group must be a name or path (/memory-users) on one line, at most 255 characters",
  atMostAccessGroups: "at most 20 access groups",
  theRootCertificateCouldNotBeParsed: "the root certificate could not be parsed: no -----BEGIN CERTIFICATE----- block",
  theRootCertificateMustBeAtMost: "the root certificate must be at most 64000 characters, with at most 10 certificates in the chain",
  isNotAScopeNameSpaceSeparated: (value1: string | number | null | undefined): string => `“${value1}” is not a scope name (space-separated: openid profile email)`,
  atMostScopes: "at most 20 scopes",
  openidIsRequiredInTheListOtherwise: "openid is required in the list; otherwise the identity provider issues no ID token",
  theReturnURLPathMustBeHandled: (value1: string | number | null | undefined): string => `the return URL path must be ${value1} (handled by the workspace)`,
  theReturnURLMustBeHttpS: (value1: string | number | null | undefined): string => `the return URL must be http(s)://workspace-host${value1}, without ? or #`,
  theReturnURLMustBeAtMost: "the return URL must be at most 500 characters",
  clientIDMustUseLatinLettersDigits: "client ID must use Latin letters, digits and symbols without spaces, at most 255 characters",
  theIssuerURLMustBeHttpsServer: "the issuer URL must be an https:// URL without ? or # (client secrets and tokens require HTTPS)",
};
