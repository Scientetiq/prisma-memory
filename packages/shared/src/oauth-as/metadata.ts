// OAuth authorization-server module of the gateway: server metadata. Differs from the edge's module:
// asMetadata(issuer, { cimd, registration }) — the flag client_id_metadata_document_supported follows the settings and
// registration_endpoint is present only with DCR on; a parity test pins the rest
//
// Authorization server metadata (RFC 8414), served only at /.well-known/oauth-authorization-server. Not declared:
// offline_access (refresh is always issued), OIDC scopes (this is not an OIDC provider), any client authentication other
// than "none". /.well-known/openid-configuration stays 404.

export const SCOPES_SUPPORTED = ["mcp:memory"] as const;

export interface AsMetadataOptions {
  /** client_id_metadata_document_supported: agent_auth.cimd_hosts not empty or agent_auth.cimd_any_https on */
  cimd: boolean;
  /** registration_endpoint: agent_auth.dcr_enabled */
  registration: boolean;
}

/** Metadata document of an issuer (an origin without a trailing slash). */
export function asMetadata(issuer: string, o: AsMetadataOptions): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES_SUPPORTED],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: o.cimd === true,
    ...(o.registration === true ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
  };
}
