import { invalid } from "./errors.ts";

export const CLIENT_KINDS = ["claude_code", "codex", "cursor", "cloud_other", "script"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const isClientKind = (v: unknown): v is ClientKind => typeof v === "string" && (CLIENT_KINDS as readonly string[]).includes(v);

export function parseClientKind(v: unknown, o: { required: true }): ClientKind;
export function parseClientKind(v: unknown, o?: { required?: boolean }): ClientKind | null;
export function parseClientKind(v: unknown, o: { required?: boolean } = {}): ClientKind | null {
  const allowed = CLIENT_KINDS.join(", ");
  if (v === undefined || v === null) {
    if (o.required) throw invalid(`client_kind: specify the program for the key, one of ${allowed}`, { allowed: [...CLIENT_KINDS] });
    return null;
  }
  if (!isClientKind(v)) throw invalid(`client_kind: one of ${allowed}`, { allowed: [...CLIENT_KINDS] });
  return v;
}

export const CONNECTION_CLIENT_KINDS = ["claude_code", "codex", "cursor", "cloud_other", "vscode", "local_other", "claude_desktop"] as const;
export type ConnectionClientKind = (typeof CONNECTION_CLIENT_KINDS)[number];

export const isConnectionClientKind = (v: unknown): v is ConnectionClientKind =>
  typeof v === "string" && (CONNECTION_CLIENT_KINDS as readonly string[]).includes(v);
