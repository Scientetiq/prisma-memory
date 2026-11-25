// Types of the connector SDK. The item shapes follow the versioned contract `connectors` 1.0.0
// (contracts/connectors/schemas/*.schema.json); the contract is the source of truth and validateItem() checks every item
// against it. A connector never receives database handles, the settings object, other connectors' secrets or a way to
// read memory: everything it may use is in ConnectorCtx.

import type { ConnectorLogEvent, ConnectorLogFields } from "../diag.ts";

/** Version of the SDK interface a manifest is written for. */
export const SDK_VERSION = 1 as const;

export const ITEM_TYPES = ["document", "meeting", "note", "entity"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Kinds of external entities. `person` and `project` are not delivered by connectors (people come from the directory,
 * projects are spaces). */
export const ENTITY_KINDS = ["company", "deal", "contact", "task", "document", "other"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SIGNATURE_SCHEMES = ["standard_webhooks", "hmac_sha256_hex_body"] as const;
export type SignatureSchemeId = (typeof SIGNATURE_SCHEMES)[number];

export type ConnectorScope = "instance" | "person";

/** A JSON Schema (draft 2020-12) object; manifest.ts checks that a config schema uses only the supported subset. */
export type JsonSchema = { [key: string]: unknown };

export interface ConnectorManifest {
  /** ^[a-z][a-z0-9_]{1,31}$ */
  kind: string;
  sdk: typeof SDK_VERSION;
  /** Semantic version of the connector code. */
  version: string;
  /** English; the panel may localise by the key `connectors.<kind>.*`. */
  title: string;
  description: string;
  /** `mock_only`: not verified against a live account — the panel and the docs say so. */
  verified: "live" | "mock_only";
  scopes: ConnectorScope[];
  produces: ItemType[];
  capabilities: {
    pull?: true;
    webhook?: SignatureSchemeId;
    entity_lookup?: EntityKind[];
    /** Outbound actions are not executed in this release; a manifest that declares them is refused. */
    actions?: never;
  };
  /** Schema of the connector configuration: an object of string | number | integer | boolean | enum | array of strings. */
  config: JsonSchema;
  /** Secrets the connector reads through ctx.secret(name); their values never appear in the config. */
  secrets: Array<{ name: string; title: string; required: boolean }>;
  /** Fixed vendor hosts, or the name of the config field whose URL host is the only allowed host. */
  egress: { hosts: string[] } | { hostFromConfig: string };
  limits: { minIntervalSec: number; maxItemsPerRun: number; maxBytesPerItem: number };
}

/** A problem found by a check. `code` is stable (the panel explains it by code); `message` is English, for logs and
 * developers; `path` is a JSON pointer into the checked value when there is one. */
export interface Problem {
  code: string;
  message: string;
  path?: string;
}

/** Reference to an entity of an external system, or to a person by e-mail. */
export type EntityRef = { system: string; kind: EntityKind; id: string } | { email: string };

interface ItemBase {
  /** 1–200 characters, unique inside the connector per type. */
  external_id: string;
  /** Opaque version in the source (a revision, an etag). Not part of the content hash. */
  external_version?: string;
}

interface RecordItemBase extends ItemBase {
  /** One line, ≤ 300 characters. */
  title?: string;
  /** Provenance link, http or https. */
  url?: string;
  /** ≤ 20 references. */
  entities?: EntityRef[];
}

export interface DocumentItem extends RecordItemBase {
  type: "document";
  occurred_at?: string;
  /** File name without a directory. */
  filename: string;
  mime?: string;
  /** Path of the file in the source, for people. */
  path?: string;
  /** Exactly one body: `text`, `content_base64` (the wire form) or `content` (bytes, SDK-internal, pull connectors). */
  text?: string;
  content_base64?: string;
  content?: Uint8Array;
}

export interface MeetingParticipant {
  name?: string;
  email?: string;
  /** Only where the platform reports presence. */
  attended?: boolean;
  /** Calendar invitees are `invitee` and never `attended`. */
  role?: "host" | "attendee" | "invitee";
}

export interface TranscriptSegment {
  start_sec: number;
  end_sec: number;
  text: string;
  speaker?: string | null;
}

export interface MeetingItem extends RecordItemBase {
  type: "meeting";
  started_at: string;
  duration_sec?: number;
  /** BCP 47 (`en`, `en-GB`); the connector sends its configured language when the source has none. */
  language?: string;
  participants?: MeetingParticipant[];
  transcript:
    | { text: string; format?: "auto" | "marked" | "timeline" | "srt" | "vtt" | "json" | "plain" }
    | { segments: TranscriptSegment[] };
}

export interface NoteItem extends RecordItemBase {
  type: "note";
  occurred_at?: string;
  text: string;
  kind?: "note" | "decision" | "action" | "question_risk" | "fact";
}

export interface EntityItem extends ItemBase {
  type: "entity";
  occurred_at?: string;
  url?: string;
  kind: EntityKind;
  /** Id of the entity in its system. The system code is the connector's configured system, never a field of the item. */
  id: string;
  name: string;
  aliases?: string[];
  /** ≤ 20 scalar attributes. */
  attrs?: Record<string, string | number | boolean>;
}

export interface DeleteItem {
  type: "delete";
  external_id: string;
  of: ItemType;
  occurred_at?: string;
}

export type RecordItem = DocumentItem | MeetingItem | NoteItem;
export type Item = RecordItem | EntityItem | DeleteItem;

/**
 * What pull() yields: an item, a new cursor (saved by the runner after the items before it), a deletion, or the mark
 * that the listing is complete. `{complete: true}` says that this pull named every item the source has now (a folder
 * scan, a full export): when the run ends without being cut (no cap, quota, stop or error), the runner marks the items
 * of earlier runs that this one did not name as deleted at the source. An incremental pull (changes since a cursor)
 * never yields it — it reports deletions with `{deleted}`.
 */
export type PullEvent =
  | { item: Item }
  | { cursor: string }
  | { deleted: { of: ItemType; external_id: string } }
  | { complete: true };

export interface TestResult {
  ok: boolean;
  /** `ok`, or a stable problem code (`auth_failed`, `unreachable`, …). */
  code: string;
  message?: string;
  latencyMs?: number;
}

/** What parseWebhook() returns: items carried by the request, or ids to fetch from the vendor API (the vendor body is
 * never trusted as content). */
export type WebhookParsed = { items: Item[] } | { refetch: string[] };

export interface EntityHit {
  kind: EntityKind;
  id: string;
  name: string;
  url?: string;
}

/** An outbound request of a connector. The egress client applies the SSRF policy, the host allow-list of the
 * manifest and the size and time limits; a connector has no other way to the network. */
export interface EgressRequest {
  method: "GET" | "POST" | "PUT" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Response body cap; the client's own cap applies when this is larger. */
  maxBytes?: number;
  timeoutMs?: number;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text(): string;
  json(): unknown;
}

export interface EgressClient {
  request(req: EgressRequest): Promise<EgressResponse>;
}

/** A file under the connector's allowed root (folder sources). */
export interface FolderEntry {
  /** Path relative to the root, `/`-separated. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Read-only access to the allowed root of a folder connector. Given only to kinds that need local files. */
export interface FolderAccess {
  list(): AsyncIterable<FolderEntry>;
  /** The file bytes, or null when the file is gone, is not a regular file or is larger than maxBytes. */
  read(path: string, maxBytes: number): Promise<Uint8Array | null>;
}

export type LogFields = Record<string, string | number | boolean>;

export interface ConnectorCtx<C = unknown> {
  config: C;
  /** A secret of this connector by its manifest name; null when it is not set. */
  secret(name: string): string | null;
  http: EgressClient;
  files?: FolderAccess;
  /** Small connector state (cursors, tokens of the vendor's paging): ≤ 16 KiB of JSON. Files never go here. */
  state: { get(): Promise<unknown>; set(v: unknown): Promise<void> };
  /**
   * A diagnostic event of the closed set CONNECTOR_LOG_EVENTS (diag.ts) with its own fields: counters, an HTTP status, a
   * Retry-After, a listed outcome — never free text. The runtime projects the call by the schema and writes only that
   * projection; a name, a key or a value outside the set refuses the whole call (one constant `connector_log_refused`).
   */
  log<E extends ConnectorLogEvent>(event: E, fields?: ConnectorLogFields<E>): void;
  /**
   * The former call shape, kept as a compatible adapter: checked at run time against the same closed set, refused before
   * anything is copied when it is not in it.
   */
  log(event: string, fields?: LogFields): void;
  signal: AbortSignal;
  now(): Date;
}

export interface Connector<C = unknown> {
  manifest: ConnectorManifest;
  /** Checks beyond the config schema; pure. */
  validate?(config: C): Problem[];
  /** Reachability and authentication; writes no data. */
  test(ctx: ConnectorCtx<C>): Promise<TestResult>;
  pull?(ctx: ConnectorCtx<C>, cursor: string | null): AsyncIterable<PullEvent>;
  fetch?(ctx: ConnectorCtx<C>, externalId: string): Promise<Item | null>;
  parseWebhook?(ctx: ConnectorCtx<C>, body: Uint8Array, headers: Record<string, string>): Promise<WebhookParsed>;
  lookup?(ctx: ConnectorCtx<C>, kind: EntityKind, name: string, limit: number): Promise<EntityHit[]>;
}

/** A preset of an optional pack: defaults for one built-in kind (for example a regional CRM behind `mcp_source`). */
export interface Preset {
  /** ^[a-z][a-z0-9_]{1,31}$ — unique in the build. */
  id: string;
  /** The pack that brings the preset; it is offered only when the pack is listed in integrations.connectors_packs. */
  pack: string;
  /** The built-in kind the preset configures. */
  kind: string;
  title: string;
  description: string;
  /** Config defaults; must validate against the kind's config schema. */
  config: Record<string, unknown>;
}

export interface Pack {
  /** ^[a-z][a-z0-9_]{1,31}$ — the value an administrator lists in integrations.connectors_packs. */
  id: string;
  presets: Preset[];
}
