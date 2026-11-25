import { readFileSync } from "node:fs";

export class PgTlsConfigError extends Error {
  constructor(code: "pg_tls_ca_unreadable" | "pg_tls_no_verify_refused" | "pg_tls_mode_unknown") {
    super(code);
    this.name = "PgTlsConfigError";
  }
}

export function pgTls(): false | { rejectUnauthorized: boolean; ca?: string } {
  switch (process.env.PGSSLMODE) {
    case undefined:
    case "":
    case "disable":
    case "allow":
      return false;
    case "prefer":
    case "require":
    case "verify-ca":
    case "verify-full": {
      const rootCert = process.env.PGSSLROOTCERT;
      if (rootCert === undefined) return { rejectUnauthorized: true };
      try {
        return { rejectUnauthorized: true, ca: readFileSync(rootCert, "utf8") };
      } catch {
        throw new PgTlsConfigError("pg_tls_ca_unreadable");
      }
    }
    case "no-verify":
      if (process.env.MEMORY_PG_TLS_NO_VERIFY === "allow") return { rejectUnauthorized: false };
      throw new PgTlsConfigError("pg_tls_no_verify_refused");
    default:
      throw new PgTlsConfigError("pg_tls_mode_unknown");
  }
}
