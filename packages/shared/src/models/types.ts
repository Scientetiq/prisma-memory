// Model connections: the shared types of the three model roles. One connection per role — chat, embeddings,
// rerank — each with its own adapter kind, base address, key, model and capability overrides. The interface between the
// model layer and the embeddings layer: the embedding adapters receive a `ModelConnection`, never settings.
import type { Settings } from "../settings.ts";
import type { AddressLocality } from "./address.ts";
import type { ChatCapabilities } from "./presets.ts";

/** The three model roles. */
export type ModelRole = "chat" | "embeddings" | "rerank";

/** Where a connection points: the canonical origin and path of its base URL (`address.ts`). */
export interface Endpoint {
  /** `scheme://host[:port]` — a key is bound to it and every request must stay on it. */
  origin: string;
  /** Path below the origin without a trailing slash; "" for the root. */
  pathPrefix: string;
  /** Host as in the URL: a name, an IPv4 address or an IPv6 address in brackets. */
  host: string;
  /**
   * Locality of an IP literal (loopback, private or public). A host name is `public` here: its addresses need DNS, which
   * the transport, the test route and the policy pre-selection resolve with `hostLocality`. A hint, never a permission.
   */
  locality: AddressLocality;
}

/** A resolved connection of one role. Holds the key in memory only: never log or return it. */
export interface ModelConnection {
  role: ModelRole;
  /** Adapter kind: `openai-compatible`, `anthropic`, `gemini` (chat); `cohere`, `voyage`, `jina`, `tei`, `openrouter` (rerank); the embedding adapter kinds (embeddings). */
  provider: string;
  /** Named bundle of capability defaults (`params.preset`); the legacy chat adapter is `litellm`. */
  preset: string | null;
  /** Canonical base URL: lower-case host, no default port, no trailing slash, no userinfo. */
  baseUrl: string;
  /** null — a keyless server. */
  apiKey: string | null;
  model: string;
  /** Capability overrides as stored (read whole); validated by the capabilities layer. */
  params: Readonly<Record<string, unknown>>;
  endpoint: Endpoint;
  /**
   * The legacy adapter of the role at the legacy gateway address (`models.gateway_base_url`): an install that has not
   * chosen a provider for the role. The legacy wire profile applies (today's bytes, the legacy repair text).
   */
  legacy: boolean;
}

/**
 * State of a role. `off`: `disabled` — the provider is `none`; `not_configured` — something is missing or refused.
 * `missing` — keys that need a value; `invalid` — keys whose stored value is refused (an address that does not parse or is
 * of a refused kind, an unknown provider, a value of the wrong type). Key names only, never values.
 */
export type ConnectionState =
  | { state: "ready"; connection: ModelConnection }
  | { state: "off"; reason: "disabled" | "not_configured"; missing: string[]; invalid: string[] };

/** The stored fields of one connection, as read from the settings (null — not set). */
export interface RawConnectionFields { provider: string | null; baseUrl: string | null; apiKey: string | null; model: string | null; params: unknown }
/** The legacy fields of a role: one gateway address and key for all roles, and the role's legacy model name. */
export interface LegacyFields { baseUrl: string | null; apiKey: string | null; model: string | null }

/** Names of the settings keys of one connection. */
export interface ConnectionKeyNames { provider: string; baseUrl: string; apiKey: string; model: string; params: string }

/** What connection resolution reads: `Settings.get` and `Settings.str`. */
export type ConnectionSettings = Pick<Settings, "get" | "str">;

// ---------------------------------------------------------------- transport and adapters

/**
 * The user-visible texts of the model layer, supplied by the facade (`platform.ts`): the messages of a failed call reach
 * `record_stages.last_error` and the panel, so their wording is the facade's, not the transport's or an adapter's.
 */
export interface ModelTexts {
  /** The call was aborted by its caller (the model slot). */
  aborted(): string;
  /** No answer within `ms`. */
  timeout(ms: number): string;
  /** The request did not reach the model server; `detail` is the error text of the network layer. */
  unreachable(detail: string): string;
  /** The model server answered 429. */
  busy(role: ModelRole): string;
  /** An HTTP error status, or an answer without the expected fields; `body` is the parsed JSON body or null. */
  failed(role: ModelRole, status: number, body: unknown): string;
}

/** What one exchange with a model cost, as the adapter read it from the answer. Counted by the usage layer. */
export interface ModelUsageReport {
  ok: boolean;
  stage?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  searchUnits?: number;
  /** The numbers were estimated, not reported by the provider. */
  estimated?: boolean;
  providerCost?: number;
}

/**
 * A JSON exchange through the model transport: the status and the parsed body (null when the body is not JSON). A failed
 * answer (400 and above) may carry `retryAfterMs` (the provider's Retry-After, at most 10 minutes) and `providerDetail`
 * (its short code and message, redacted, at most 200 characters) —.
 */
export interface ModelReply { status: number; json: any; retryAfterMs?: number; providerDetail?: string }

/** What an adapter gets: its connection, the facade's texts, a POST bound to the connection, and the usage sink. */
export interface ModelIo {
  readonly connection: ModelConnection;
  readonly texts: ModelTexts;
  /** POST `body` as JSON to `connection.baseUrl + path`; `path` is a literal of the adapter. */
  post(path: string, body: unknown, o: { timeoutMs: number; signal?: AbortSignal; stage?: string }): Promise<ModelReply>;
  /** Metadata uses the same destination and budget checks; it is not billed as inference. */
  get(path: string, o: { timeoutMs: number; signal?: AbortSignal; stage?: string }): Promise<ModelReply>;
  /** Report the usage of one exchange (a no-op until the usage layer). */
  report(u: ModelUsageReport): void;
}

/** One message of a chat request on the wire. */
export interface WireMessage { role: "system" | "user" | "assistant"; content: string }

/** A structured-output chat request, as the facade hands it to a chat adapter. */
export interface ChatWireRequest {
  /** Resolved once by the facade; maxTokens already includes output headroom. */
  capabilities?: ChatCapabilities;
  model: string;
  messages: readonly WireMessage[];
  maxTokens: number;
  schemaName: string;
  /** The schema as sent to the model (the facade has already adapted it). */
  wireSchema: unknown;
  /** Sampling fields of the profile; spread FIRST, so they can never override the fields the adapter sets. */
  sampling: Readonly<Record<string, unknown>>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The answer of a chat adapter: the text to parse, why the model stopped, the model that served, the token counts. */
export interface ChatWireReply {
  text: string;
  finish: "stop" | "length" | "refusal";
  servedModel?: string;
  usage: { promptTokens?: number; completionTokens?: number };
}

/** A chat adapter: only the wire — no slot, no policy, no validation. */
export interface ChatAdapter {
  /** Local validation before beforeCall; never performs I/O. */
  preflight?(connection: ModelConnection, req: ChatWireRequest): void;
  chat(io: ModelIo, req: ChatWireRequest): Promise<ChatWireReply>;
}

/** A rerank adapter: scores per original document index. */
export interface RerankAdapter {
  rerank(io: ModelIo, req: { model: string; query: string; documents: string[]; timeoutMs: number }): Promise<Array<{ index: number; score: number }>>;
}
