// The gateway's dependency container and the caller context. The gateway is stateless: the context is built for each request.
import type pg from "pg";
import type { AdminRole, AuthMethod, CallerKind, ClaimedClient, ClassScope, ClientKind, Databases, DespiteKeys, LinkKeys, Platform, Settings } from "@memory/shared";
import type { Limiter } from "./limits.ts";
import type { Storage } from "./storage.ts";
import type { JobQueue } from "./queue.ts";
import type { SettingsKeyring } from "@memory/shared/crypto";
import type { Channel } from "./channel.ts";

export interface PersonRow { id: string; login: string; display_name: string; department: string | null; role: string | null; instance_id: string; active: boolean;
  /** A demo persona of the role showcase (`people.attrs.demo`): never mixed with real people, either way. */
  demo: boolean;
  /** The agent's personal notebook: false when the person turned it off; on by default. */
  notebook?: boolean;
  /** The name to address the person by (people.attrs.given_name): directory, identity provider or the org table; null — unknown. */
  given_name?: string | null }
export interface ServiceRow {
  id: string; name: string; kind: string; obo_allowed: boolean; obo_read: boolean; allowed_ops: string[]; tier: "T0" | "T1";
  /** A service's write space: everything it writes lands only here; null — an ordinary service. */
  write_space_id: string | null;
}

export interface Caller {
  /** API key or OAuth grant (api_keys.id), or a workplace session (user_sessions.id, keyKind = session). */
  keyId: string;
  keyKind: CallerKind;
  tier: "T0" | "T1" | "T2";
  principalType: "person" | "service" | "system";
  /** On whose behalf the request goes: the owner of a personal key or session, X-On-Behalf-Of. null — a service with no person: sees no data. */
  person: PersonRow | null;
  service: ServiceRow | null;
  onBehalfOf: boolean;
  /** Operations allowed to the key; null — all groups of a personal or extended key. */
  allowedOps: Set<string> | null;
  clientLabel: string | null;
  /**
   * The program of a person's key: `script` — a script or a local program, personal records
   * closed by default; null — not set (a key from before is cloud), and also a session, a service and the system key.
   */
  clientKind: ClientKind | null;
  /** The request transport: `details.via` of the write event — to find keys without a program used to upload through REST. */
  transport?: "mcp" | "rest";
  /**
   * The program the client named itself — not the key's program `clientKind`: clientInfo from _meta
   * of the request, from initialize of an earlier revision or the first User-Agent token. Only for the log (`details.client`) and
   * the morning report: rights, the record class, attrs and consent do not read it — only audit.ts, mcp.ts and auth.ts read it
   * (pinned by a unit test). Not set for workplace sessions, the system key, preview and download links.
   */
  claimedClient?: ClaimedClient;
  expiresAt: Date | null;
  ip: string | null;
  /** The key has a network binding (net_cidrs, not /0): only such a service key widens the readers through /ingest/access. */
  netBound: boolean;
  /** A panel preview key (view as a role): it issues and revokes no keys, its audit events are marked preview. */
  preview: boolean;
  /**
   * Which classes the caller may READ: T2 and T1 — open only (closed records never go to external providers),
   * T0 — both; an extended key — both, but the closed class only of its OWN records.
   */
  scope: ClassScope;
  /**
   * The administrator allowed this key to write into open (`api_keys.open_write`) —
   * a snapshot at the request entry, no cache. Only the gates of extended-open.ts read it. Optional: `undefined` = `false`, that
   * is, a person's agent that reads closed records does not write into open. An agent connection with extended access
   * must fill it from its own source — otherwise it cannot be allowed to write into open.
   */
  openWrite?: boolean;
  /**
   * Where an agent connection (keyKind connection) signs in: "builtin" — the built-in authorization
   * server of the memory (mem_oat_, agent-auth/tokens-auth.ts); absent — the external identity provider, as before. memory_me picks the text of
   * the expiry warning by it (connectionExpiryWarning). Information only: rights do not read it.
   */
  connectionOrigin?: "builtin";
  /** The request's base URL — for signed links to originals not bound to an address in the config. */
  baseUrl: string;
  /**
   * The request channel (channel.ts): internal — from inside, agent — on the agents' address, external — on the
   * external agents' address (nothing is said there of closed records). Set by authenticate; undefined — internal (callers
   * built outside authenticate: test sessions, jobs).
   */
  channel?: Channel;
  /**
   * An administrator on the admin listener: a mem_as_ session, and a panel session mem_adm_ and the system key while they are
   * allowed (sessionId — null). The caller is then the system principal (principalType system), so the old code of the
   * admin API and the log CHECK stay; audit() writes these into details (admin_person, admin_session, admin_role, admin_auth).
   */
  admin?: AdminCaller;
}

/** Which administrator calls the admin API (Caller.admin). */
export interface AdminCaller {
  sessionId: string | null;
  /**
   * The person's card. The local administrator account has the card linked to it (admin_users.person_id), otherwise null; a
   * panel session mem_adm_ and the system key have null.
   */
  personId: string | null;
  /** The admin_users login if the session came from the local administrator sign-in (also card-linked); else null or absent. */
  localLogin?: string | null;
  login: string;
  role: AdminRole;
  /**
   * The session's sign-in method; legacy — a panel session mem_adm_ or the system key (none in admin_sessions); llm_gate_key —
   * the narrow key of the model arbiter (only the model gates, admin-plane/middleware.ts).
   */
  authMethod: AuthMethod | "legacy_session" | "system_key" | "auditor_key" | "llm_gate_key";
  /** The last touch of the WebAuthn key. */
  uvAt: Date | null;
  /** The emergency access window the session was issued in; null — an ordinary session. */
  breakglassWindowId: string | null;
}

export interface App {
  instanceId: string;
  appSecret: string;
  db: Databases;
  settings: Settings;
  platform: Platform;
  limiter: Limiter;
  storage: Storage;
  queue: JobQueue;
  /**
   * Keys for making records available to agents: consent fingerprints and the token signature — HKDF from the app secret, once at
   * start (index.ts). Optional: without it despiteKeysOf derives the keys from appSecret (unit tests, an App built by hand).
   */
  despiteKeys?: DespiteKeys;
  /**
   * Signing keys of links to originals from the files link-signing-key-<n> (index.ts). None or an empty set — signing and
   * checking by the old setting access.link_signing_key, without rechecking rights at download (as before).
   */
  linkKeys?: LinkKeys;
  /** Which keys are still old-style (names; loadServiceSecrets) — for the secrets_source health check. */
  secretsLegacy?: string[];
  /**
   * The memory_control pool under the role memory_admin_plane: administrator sessions, requests, emergency access. None —
   * the admin plane is not set up (no role password file): the session functions answer not configured.
   */
  adminDb?: pg.Pool | null;
  /**
   * The pool of memory_admin_plane for the alerts router of the LEGACY listener only (alerts list and
   * acknowledgement, `alertsRoutes(app, { alertsOnly: true })`). Set only when the administrator listener is not
   * separate; adminDb() and adminPlaneConfigured() never see it, so every other reader behaves as before.
   */
  alertsDb?: pg.Pool | null;
  /** The settings keyring loaded at start-up (index.ts); it also reads connector secrets. Absent — derived from appSecret. */
  settingsKeyring?: SettingsKeyring;
}

export const actorName = (c: Caller): string => (c.service ? c.service.name : c.person?.login ?? c.principalType);
