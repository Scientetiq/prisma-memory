import "server-only";
import { cache } from "react";
import type { ExternalState } from "./external-access";
import { meGw } from "./me-api";
import { cachedFetch, NAV_STALE_MS, NAV_TTL_MS, navMemo, SessionMemo, settleNav } from "./nav-cache";
import type { MyNavSummary } from "./types";

export const navSummary = cache(async (key: string): Promise<{ data: MyNavSummary | null; stale: boolean }> =>
  cachedFetch(navMemo, key, () => meGw<MyNavSummary>(key, "/api/v1/me/nav"), Date.now, settleNav));

export const externalMemo = new SessionMemo<ExternalState>(NAV_TTL_MS, NAV_STALE_MS);
export const invalidateExternal = (key: string): void => externalMemo.invalidate(key);

export const externalSummary = cache(async (key: string): Promise<{ data: ExternalState | null; stale: boolean }> =>
  cachedFetch(externalMemo, key, () => meGw<ExternalState>(key, "/api/v1/me/external")));
