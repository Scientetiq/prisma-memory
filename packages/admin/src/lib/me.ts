import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { mimeTitle } from "./labels";
import { getMe } from "./me-call";
import { meGw, type MeResult } from "./me-api";
import { builtinSignIn, keycloakSignIn, type OAuthConnectConfig } from "./oauth-connect";
import { canAdd } from "./plain";
import { unavailableDigest } from "./retry";
import type { PublicOrigin } from "./snippets";
import { loginUrl, requireUserSession, type UserSession } from "./user-session";
import type { Me, MeSpace } from "./types";

export { getMe };

export const oauthAgentConfig = cache(async (key: string): Promise<MeResult<OAuthConnectConfig>> => meGw<OAuthConnectConfig>(key, "/api/v1/me/connections/config"));
/**
 * Agents sign in with the company account — through the identity provider (`oauth.enabled`, only while the mode is external) or the
 * built-in sign-in of this memory when it is on and ready. Built-in but not ready, or off — neither.
 */
export const oauthAgentsOn = (r: MeResult<OAuthConnectConfig> | null | undefined): boolean => Boolean(r?.ok && (keycloakSignIn(r.data) !== null || builtinSignIn(r.data) !== null));

export interface Workspace { session: UserSession; me: Me }

export async function requireWorkspace(): Promise<Workspace> {
  const session = await requireUserSession();
  const me = await getMe(session.key);
  if (me.ok) return { session, me: me.data };
  if (me.code === "unauthorized") redirect(session.preview ? "/admin/preview?expired=1" : await loginUrl({ expired: true }));
  throw new WorkspaceUnavailable(me.code, me.message, me.retryAfter);
}

export class WorkspaceUnavailable extends Error {
  readonly digest: string;
  constructor(readonly code: string, message: string, readonly retryAfter?: number) {
    super(message); this.name = "WorkspaceUnavailable"; this.digest = unavailableDigest(code, retryAfter);
  }
}

export async function publicOrigin(me: Me): Promise<PublicOrigin> {
  const h = await headers();
  return { host: h.get("host"), proto: h.get("x-forwarded-proto"), publicBaseUrl: me.public_base_url ?? null, cloudBaseUrl: me.cloud_agent_base_url ?? null };
}

export interface UploadLimits { accepted: string[]; maxBytes: number; converter: boolean; exact: boolean }
const FALLBACK_MIME = ["text/markdown", "text/plain"];
export function uploadLimits(me: Me): UploadLimits {
  const u = me.upload;
  const mimes = u?.accepted_mime?.length ? u.accepted_mime : FALLBACK_MIME;
  return {
    accepted: [...new Set(mimes.map(mimeTitle))],
    maxBytes: u?.max_bytes && u.max_bytes > 0 ? u.max_bytes : 20 * 1024 * 1024,
    converter: u?.converter_configured === true,
    exact: Boolean(u?.accepted_mime?.length),
  };
}

export const writableSpaces = (me: Me) => me.spaces.filter(canAdd);
export const personalSpace = (me: Me) => me.spaces.find((s) => s.kind === "personal") ?? null;
export const ownedSpaces = (me: Me) => me.spaces.filter((s) => s.role === "owner" && s.kind !== "personal" && s.kind !== "project");
export const isDepartment = (s: Pick<MeSpace, "org_unit">): boolean => Boolean(s.org_unit);
export const projectSpaces = (me: Me) => me.spaces.filter((s) => s.kind === "project");
export const hiddenClosedTotal = (me: Me) => me.spaces.reduce((a, s) => a + (s.hidden_closed ?? 0), 0);
