import type pg from "pg";
import { LDAP_IDENTITY_KEYS, log, OIDC_IDENTITY_KEYS, tx, type LdapConfig, type OidcConfig, type Settings } from "@memory/shared";
import type { App } from "./context.ts";

export const loginPolicyLock = (app: Pick<App, "instanceId">): string => `login-policy:${app.instanceId}`;

export const LOGIN_POLICY_CHANGED = "Sign-in settings just changed. Sign in again";

export async function withSettingsTx<T>(app: App, locks: readonly string[], fn: (q: pg.PoolClient, settings: Settings) => Promise<T>): Promise<T> {
  try {
    return await tx(app.db.control, async (q) => {
      for (const name of locks) await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [name]);
      const settings = app.settings.withDatabase(q);
      await settings.load(true);
      return fn(q, settings);
    });
  } finally {
    await app.settings.load(true).catch((e: unknown) => log.warn("settings_reload_after_tx_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }));
  }
}

const print = (cfg: object, keys: ReadonlySet<string>): string =>
  JSON.stringify([...keys].sort().map((k) => [k, (cfg as Record<string, unknown>)[k] ?? null]));
export const ldapPolicyPrint = (cfg: LdapConfig): string => print(cfg, LDAP_IDENTITY_KEYS);
export const oidcPolicyPrint = (cfg: OidcConfig): string => print(cfg, OIDC_IDENTITY_KEYS);

export async function underLoginPolicy<T>(app: App, printNow: (s: Settings) => string, printed: string,
                                          fn: (q: pg.PoolClient) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const out = await tx(app.db.control, async (q) => {
    await q.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [loginPolicyLock(app)]);
    const s = app.settings.withDatabase(q);
    await s.load(true);
    if (printNow(s) !== printed) return { ok: false as const };
    return { ok: true as const, value: await fn(q) };
  });
  if (!out.ok) await app.settings.load(true).catch(() => undefined);
  return out;
}
