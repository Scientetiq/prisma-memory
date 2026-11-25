export interface ServiceEnv {
  instanceId: string | null;
  pgHost: string;
  pgPort: number;
  anchorsDir: string | null;
}

type ServiceEnvVars = { MEMORY_INSTANCE_ID?: string; PG_HOST?: string; PG_PORT?: string; MEMORY_ANCHORS_DIR?: string };

export function readServiceEnv(vars?: ServiceEnvVars): ServiceEnv {
  const env: ServiceEnvVars = vars ?? {
    MEMORY_INSTANCE_ID: process.env.MEMORY_INSTANCE_ID, PG_HOST: process.env.PG_HOST, PG_PORT: process.env.PG_PORT,
    MEMORY_ANCHORS_DIR: process.env.MEMORY_ANCHORS_DIR,
  };
  const val = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  const port = Number(val(env.PG_PORT) ?? 5432);
  return {
    instanceId: val(env.MEMORY_INSTANCE_ID),
    pgHost: val(env.PG_HOST) ?? "db",
    pgPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 5432,
    anchorsDir: val(env.MEMORY_ANCHORS_DIR),
  };
}
