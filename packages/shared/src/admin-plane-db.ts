import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { credentialsDir } from "./credentials.ts";
import type { Env } from "./db.ts";
import { log } from "./log.ts";
import { pgTls } from "./pg-tls.ts";

export const ADMIN_PLANE_ROLE = "memory_admin_plane";
export const ADMIN_PLANE_CREDENTIAL = `pg-${ADMIN_PLANE_ROLE}`;
export const userCredentialsDir = (): string => join(homedir(), "memory", "credentials", "memory-gateway");

export function adminPlanePassword(dirs: readonly string[] = [credentialsDir(), userCredentialsDir()].filter((d): d is string => !!d)): string | null {
  for (const dir of dirs) {
    let text: string;
    try { text = readFileSync(join(dir, ADMIN_PLANE_CREDENTIAL), "utf8"); } catch { continue; }
    const value = text.trim();
    if (value) return value;
  }
  return null;
}

export function openAdminPlanePool(env: Pick<Env, "pgHost" | "pgPort" | "applicationName">, password: string | null = adminPlanePassword()): pg.Pool | null {
  if (!password) return null;
  const pool = new pg.Pool({ host: env.pgHost, port: env.pgPort, database: "memory_control", user: ADMIN_PLANE_ROLE, password, max: 4,
                             idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
                             ssl: (env as Partial<Env>).pgTls ?? pgTls(),
                             ...(env.applicationName ? { application_name: `${env.applicationName}-admin`.slice(0, 63) } : {}) });
  pool.on("error", (e) => log.warn("pg_pool_error", { database: "memory_control", role: ADMIN_PLANE_ROLE, error: e.message.slice(0, 200) }));
  pool.on("connect", (client) => {
    let reported = false;
    client.on("error", (e) => {
      if (reported || client.listenerCount("error") !== 1) return;
      reported = true;
      log.warn("pg_client_error", { database: "memory_control", application: pool.options.application_name, sqlstate: (e as { code?: string }).code ?? null });
    });
  });
  return pool;
}
