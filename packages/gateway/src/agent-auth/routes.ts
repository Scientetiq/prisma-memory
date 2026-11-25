// One registration of the protocol routes of the built-in authorization server for agents:
// buildRest calls registerAgentAuth right after registerOAuthMetadata, before the key check — none of
// these requests carries a key, and the transport body limit of /oauth/* is the routes' own (16 KiB, routes-token.ts).
//   - the authorize side (routes-authorize.ts): GET, HEAD, OPTIONS /.well-known/oauth-authorization-server, GET
//     /oauth/authorize, GET /oauth/authorize/continue;
//   - the token side (routes-token.ts): POST, OPTIONS /oauth/token and /oauth/revoke;
//   - automatic registration (dcr.ts): POST, OPTIONS /oauth/register — only while agent_auth.dcr_enabled is on —
//     and the resolver of dcr_… clients for the authorize side. It is optional for readiness: builtin without DCR is
//     complete, and the metadata announce registration_endpoint only while the resolver is installed and DCR is on.
// Client metadata documents: https:// client ids resolve through the CIMD fetch (cimd-fetch.ts) — registered here
// with the routes, so the metadata announce client_id_metadata_document_supported only on a gateway that serves them; the
// policy step's listener clears the fetcher on every save of agent_auth.*.
// The consent API of the workplace (consent-api.ts) is not part of this registration: its handlers need the caller, so
// buildRest registers it after authenticate.
//
// Each side marks its part of the AS routes (readiness.ts): builtin is ready only when the authorize, token and consent
// parts are all served — a gateway that lost one registration stays "not ready" (routes_missing) instead of sending apps
// into a dead end. Outside agent_auth.mode = builtin, and in an unready builtin, every route answers the router's 404;
// external reads the mode from the settings cache and touches no database here.
import type { Hono } from "hono";
import type { App, Caller } from "../context.ts";
import { agentAuthCimd, cimdResolver } from "./cimd-fetch.ts";
import { registerAgentAuthRegister } from "./dcr.ts";
import { onAgentAuthPolicyChange } from "./policy-step.ts";
import { noteRefusal, registerAgentAuthAuthorize, setClientResolver, type SockOf } from "./routes-authorize.ts";
import { registerAgentAuthToken, type RefreshFlights } from "./routes-token.ts";

type Env = { Variables: { caller: Caller } };

/**
 * Register the protocol routes of the built-in server on the REST router. sockOf — the address of the TCP peer
 * (rest.ts remoteOf), from which requestChannel derives the client address with access.trusted_proxies. flights — the
 * in-process map of refresh requests in flight (one flight per token, client and resource); tests pass their own.
 */
export function registerAgentAuth(r: Hono<Env>, app: App, sockOf: SockOf, o: { flights?: RefreshFlights } = {}): void {
  registerAgentAuthAuthorize(r, app, sockOf);
  registerAgentAuthToken(r, app, sockOf, o.flights);
  registerAgentAuthCimd();
  registerAgentAuthRegister(r, app, sockOf);
}

let cimdListening = false;
/**
 * Serve client metadata documents: the resolver of https:// client ids with the process fetcher, and once
 * per process the policy step's listener that resets it (the cache is cleared on every save of agent_auth.*).
 */
export function registerAgentAuthCimd(): void {
  setClientResolver("cimd", cimdResolver(noteRefusal));
  if (!cimdListening) { cimdListening = true; onAgentAuthPolicyChange(() => agentAuthCimd().reset()); }
}
