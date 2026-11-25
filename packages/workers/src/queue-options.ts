import { pgTls, type Env } from "@memory/shared";

export function workerQueueOptions(env: Env, password: string | undefined) {
  return {
    host: env.pgHost, port: env.pgPort, database: "memory_control", user: "memory_worker",
    password, schema: "pgboss", max: 6, ssl: env.pgTls ?? pgTls(),
  };
}
