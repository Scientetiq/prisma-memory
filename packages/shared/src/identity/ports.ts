import type { AgentAuthMode, ClientSource } from "../agent-auth.ts";
import type { OAuthClaims } from "../oauth.ts";
import type { Settings } from "../settings.ts";

export type IdentitySettings = Pick<Settings, "get">;
export type ProviderKind = "ldap" | "oidc" | "local";
export interface ProviderDescriptor { readonly id: string; readonly kind: ProviderKind }

/** Identity data only. Linking, access, group admission and session issuance remain gateway decisions. */
export interface LoginIdentity<Raw = unknown> {
  providerId: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  givenName: string | null;
  groups: string[];
  department?: string | null;
  employeeId?: string | null;
  /** The provider's original identity data. Never log it. */
  raw: Raw;
}

/** Flow operations stay separate so callers keep their existing limits, pending-login state and error stages. */
export interface LoginProvider<Config, Flow, Input, Raw> extends ProviderDescriptor {
  readonly profile: string;
  config(settings: IdentitySettings): Config;
  readonly login: Flow;
  identity(config: Config, input: Input): LoginIdentity<Raw>;
}

/** A source can expose only the operations it already supports; null means unavailable, never an empty directory. */
export interface DirectorySource<People, Departments, Groups> {
  readonly id: string;
  readonly people: People;
  readonly departments: Departments;
  readonly groups: Groups;
}

/** Reserved client context for built-in authorization, metadata documents and dynamic registration. */
export interface AgentClient { id: string; kind: OAuthClaims["clientKind"]; source: ClientSource }
export interface AgentAuth<Context, Principal> {
  readonly mode: AgentAuthMode;
  /** Optional AS seam: resolving registry/CIMD/DCR metadata never grants access by itself. */
  resolveClient?(context: Context, clientId: string): Promise<AgentClient | null>;
  verifyBearer(context: Context, token: string, ip: string | null, baseUrl: string): Promise<Principal>;
  protectedResource(context: Context, path: string): Promise<Record<string, unknown> | null>;
  challenge(context: Context, options?: { tokenPresented?: boolean }): Promise<string | null>;
}

/** Delivery may enqueue a message. A receipt never claims that an SMTP server has already delivered it. */
export interface Notifier<Send, SendTest = unknown> {
  readonly id: string;
  readonly send: Send;
  /** Whether normal delivery is enabled. An explicit test can still probe a disabled transport. */
  readonly canDeliver: boolean;
  readonly sendTest: SendTest;
}
