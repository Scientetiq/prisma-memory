// Sink of the external journal: file or syslog_tls. write resolves only after the sink confirms
// (file fsync; the TLS socket write reached the kernel), else it throws ShipSinkError with a code; the cursor stays.
// The error code holds no address or path: it goes to audit_ship_state.last_error_code, the panel and alert.
import type { ShipLine } from "./line.ts";

export type ShipSinkKind = "file" | "syslog_tls";

export interface ShipSink {
  readonly kind: ShipSinkKind;
  write(lines: readonly ShipLine[]): Promise<void>;
  close(): Promise<void>;
}

/** Sink failure codes. */
export type ShipErrorCode =
  | "target_invalid" | "file_dir_unavailable" | "file_write_failed"
  | "syslog_connect_failed" | "syslog_tls_failed" | "syslog_write_failed" | "syslog_timeout" | "syslog_closed";

export class ShipSinkError extends Error {
  constructor(readonly code: ShipErrorCode, detail: string) { super(`${code}: ${detail.slice(0, 200)}`); }
}
