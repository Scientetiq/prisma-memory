// The program of a key: the checks of the issue and edit fields of a key are pure rules,
// shared by the admin API (admin.ts) and self-service (rest.ts). The value is parsed by parseClientKind of @memory/shared.
import { CLIENT_KINDS, invalid, parseClientKind, type ClientKind } from "@memory/shared";

/**
 * `client_kind` when an administrator issues a key (POST /admin/keys). Personal and extended — optional: without it
 * null, a cloud key (like those issued before; `conftest.issue_key` does not pass it). For service and system keys any
 * value but null is a 400 before INSERT: otherwise the database constraint api_keys_client_kind_person would give a 500. A
 * preview key (view as a role) never gets a program: the value is not read.
 */
export function issueClientKind(kind: string, preview: boolean, raw: unknown): ClientKind | null {
  if (preview) return null;
  if (kind !== "personal" && kind !== "extended") {
    if (raw !== undefined && raw !== null) throw invalid("client_kind: only personal and extended keys carry a program");
    return null;
  }
  return parseClientKind(raw);
}

/**
 * The body is a JSON object (not null, an array or a string): otherwise 400 naming the schema. `c.req.json().catch(() => ({}))`
 * replaces only an unparsable body: valid JSON `null` went further, and reading a field gave a 500.
 */
export function jsonObjectBody(raw: unknown, schema: string): Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(`The request body must be an object ${schema}`);
  return raw as Record<string, any>;
}

/**
 * A body with fields strictly from the list (contract `additionalProperties: false`): an extra field is a 400 naming it, not a
 * silent skip. Before, `{net_cidrs: null, client_kind: "script"}` in PATCH /admin/keys gave 200, and the field
 * was lost.
 */
export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(`Unexpected fields: ${extra.join(", ")}. Allowed fields: ${allowed.join(", ")}`, { unknown: extra });
}

/**
 * Body of PATCH /me/keys/{id}: the program can only be narrowed to `script` (a key a script uses is marked without
 * reissue). Widening — no: a script key made cloud would give the script open personal records; another program, null, garbage
 * and extra fields are a 400 that says to issue a new key.
 */
export function scriptNarrowing(body: unknown): "script" {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).length !== 1 || b.client_kind !== "script")
    throw invalid("client_kind: you can only mark the key as a script (script) here. Issue a new key for a different program", { allowed: ["script"], kinds: [...CLIENT_KINDS] });
  return "script";
}

// ---------------------------------------------------------------- writing into open

/** Reason for turning the flag on: 3–500 characters, only into the log (admin/key_issue, key_update), not kept in the key. */
function openWriteBasis(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v.length < 3 || v.length > 500)
    throw invalid("open_write_basis: the reason for letting the key write open records (a request number or a decision), 3 to 500 characters", { field: "open_write_basis" });
  return v;
}

/**
 * `open_write` when an administrator issues a key (POST /admin/keys): no field or false — false; true — only for an
 * extended key (not a preview) and only with the reason `open_write_basis`. Not a boolean, true on
 * another kind, a reason without true — 400 before INSERT (otherwise the constraint api_keys_open_write_extended would give 500).
 */
export function issueOpenWrite(kind: string, preview: boolean, b: Record<string, unknown>): { openWrite: boolean; basis: string | null } {
  if (b.open_write !== undefined && typeof b.open_write !== "boolean") throw invalid("open_write must be true or false", { field: "open_write" });
  if (b.open_write !== true) {
    if (b.open_write_basis !== undefined) throw invalid("open_write_basis is accepted only with open_write: true", { field: "open_write_basis" });
    return { openWrite: false, basis: null };
  }
  if (kind !== "extended" || preview) throw invalid("open_write: only an extended key (extended) may be allowed to write open records", { field: "open_write" });
  return { openWrite: true, basis: openWriteBasis(b.open_write_basis) };
}

/**
 * The flag in PATCH /admin/keys/{id}: no field — null (no change); false — clear, without a reason; true — with a reason.
 * The key kind (extended only) is checked by the route on the key row under a lock.
 */
export function keyPatchOpenWrite(b: Record<string, unknown>): { openWrite: boolean; basis: string | null } | null {
  if (b.open_write === undefined) {
    if (b.open_write_basis !== undefined) throw invalid("open_write_basis is accepted only with open_write: true", { field: "open_write_basis" });
    return null;
  }
  if (typeof b.open_write !== "boolean") throw invalid("open_write must be true or false", { field: "open_write" });
  if (!b.open_write) {
    if (b.open_write_basis !== undefined) throw invalid("open_write_basis: provide it only with open_write: true; revoking permission does not require a reason", { field: "open_write_basis" });
    return { openWrite: false, basis: null };
  }
  return { openWrite: true, basis: openWriteBasis(b.open_write_basis) };
}

/**
 * Body of PATCH /me/keys/{id} — narrowing only: `{client_kind: "script"}` or `{open_write: false}` —
 * clears the permission to write into open from one's own extended key. Only an administrator can turn it on: `{open_write:
 * true}` — 400. Both fields at once, garbage and extra fields — 400.
 */
export function myKeyNarrowing(body: unknown): { client_kind: "script" } | { open_write: false } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (b && "open_write" in b) {
    if (Object.keys(b).length !== 1) throw invalid("Restrict one permission per request: open_write: false or client_kind: script", { allowed: ["open_write", "client_kind"] });
    if (b.open_write === true) throw invalid("open_write: only the memory administrator can grant the key permission to write to open spaces. Here you can only revoke it (false)", { field: "open_write" });
    if (b.open_write !== false) throw invalid("open_write: use false here to revoke permission to write to open spaces", { field: "open_write" });
    return { open_write: false };
  }
  return { client_kind: scriptNarrowing(body) };
}
