import pg from "pg";
import { log, passwordFor, pgTls, type Env } from "@memory/shared";

export function auditMaintPool(env: Pick<Env, "pgHost" | "pgPort" | "appSecret" | "pgAppPassword">, applicationName?: string): pg.Pool {
  const pool = new pg.Pool({ host: env.pgHost, port: env.pgPort, database: "memory_audit", user: "memory_audit_maint",
                             password: passwordFor(env, "memory_audit_maint"), max: 1, connectionTimeoutMillis: 60_000,
                             ssl: (env as Partial<Env>).pgTls ?? pgTls(),
                             ...(applicationName ? { application_name: applicationName.slice(0, 63) } : {}) });
  pool.on("error", (e) => log.warn("pg_pool_error", { database: "memory_audit", error: e.message.slice(0, 200) }));
  pool.on("connect", (client) => {
    let reported = false;
    client.on("error", (e) => {
      if (reported || client.listenerCount("error") !== 1) return;
      reported = true;
      log.warn("pg_client_error", { database: "memory_audit", application: pool.options.application_name, sqlstate: (e as { code?: string }).code ?? null });
    });
  });
  return pool;
}
