"use server";
import { refresh } from "next/cache";
import { okState, failState, type ActionState } from "@/lib/action-state";
import { connectorGw as gw } from "@/lib/connector-api";
import { explainConnectorError } from "@/lib/connector-errors";
import { parseConnectorConfig } from "@/lib/connector-form";
import { CONNECTORS_API, connectorPath, isConnectorId, UUID, type ConnectorKind, type ConnectorView, type KindsResponse } from "@/lib/connectors";
import { GatewayError } from "@/lib/gateway";
import { requireSession } from "@/lib/session";
import { readAdminView } from "@/lib/view-as";
import { connectors as M } from "@/messages/connectors";

const value = (f: FormData, k: string): string => typeof f.get(k) === "string" ? String(f.get(k)) : "";
async function denied(narrow = false): Promise<ActionState> {
  const session = await requireSession();
  if (session.role === "security_auditor" || await readAdminView() === "auditor") return failState(M.readOnly);
  if (session.breakglass && !narrow) return failState(explainConnectorError("breakglass_only").text);
  return null;
}
function failure(e: unknown): ActionState {
  if (!(e instanceof GatewayError)) throw e;
  const details = e.details as { reason?: unknown; problems?: Array<{ pointer?: unknown }> } | undefined;
  const code = typeof details?.reason === "string" ? details.reason : e.code;
  const x = explainConnectorError(code);
  // Only schema-derived field names can be returned; never echo request values or an upstream error body.
  const fields = (details?.problems ?? []).slice(0, 5).flatMap((p) => typeof p.pointer === "string" && /^\/(?:config|policy)\/[a-zA-Z0-9_/-]{1,128}$/.test(p.pointer) ? [p.pointer] : []);
  return failState(x.text, { lines: [x.action, ...(fields.length ? [`${M.fieldError} ${fields.join(", ")}`] : [])] });
}
const secret = (v: string | undefined) => v ? { label: M.once, value: v, warning: M.onceWarning } : undefined;
async function kindOf(name: string): Promise<ConnectorKind | undefined> {
  const { kinds } = await gw<KindsResponse>(`${CONNECTORS_API}/kinds`);
  return kinds.find((k) => k.kind === name);
}
function configuration(f: FormData, kind: ConnectorKind): { body: Record<string, unknown> } | { error: ActionState } {
  const name = value(f, "name").trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return { error: failState(M.invalid) };
  const parsed = parseConnectorConfig(kind.config, f);
  if (!parsed.ok) {
    const fieldErrors = Object.fromEntries(parsed.fields.map((k) => [`config.${k}`, M.invalid]));
    return { error: failState(M.fieldError, { lines: parsed.fields, fieldErrors }) };
  }
  const dataClass = value(f, "data_class") || "closed";
  if (!["closed", "space"].includes(dataClass)) return { error: failState(M.invalid) };
  const body: Record<string, unknown> = { name, config: parsed.config, data_class: dataClass };
  for (const key of ["owner_id", "target_space_id"]) {
    const v = value(f, key).trim();
    if (v && !UUID.test(v)) return { error: failState(M.invalid) };
    if (v) body[key] = v;
  }
  const policy: Record<string, unknown> = {};
  for (const key of ["schedule_sec", "daily_items", "daily_mb"]) {
    const v = value(f, `policy.${key}`);
    if (v) {
      const n = Number(v), min = key === "schedule_sec" ? Math.max(60, kind.limits?.minIntervalSec ?? 60) : 1;
      if (!Number.isSafeInteger(n) || n < min) return { error: failState(M.invalid) };
      policy[key] = n;
    }
  }
  for (const [key, allowed] of Object.entries({ participants: ["owner_only", "attended_emails"], on_change: ["version", "new_record"], on_delete: ["keep", "trash"] })) {
    const v = value(f, `policy.${key}`);
    if (v && !allowed.includes(v)) return { error: failState(M.invalid) };
    if (v) policy[key] = v;
  }
  body.policy = policy;
  return { body };
}

export async function createConnectorAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const no = await denied(); if (no) return no;
  try {
    const kind = await kindOf(value(f, "kind"));
    if (!kind || !kind.scopes.includes(value(f, "scope") as "instance" | "person")) return failState(M.invalid);
    const parsed = configuration(f, kind); if ("error" in parsed) return parsed.error;
    for (const s of kind.secrets) {
      const v = value(f, `secret.${s.name}`);
      if (s.required && !v || v.length > 8192) return failState(M.invalid);
    }
    const r = await gw<{ connector: ConnectorView; webhook_secret?: string }>(CONNECTORS_API, {
      method: "POST", body: { ...parsed.body, kind: kind.kind, scope: value(f, "scope"), ...(value(f, "pack") ? { pack: value(f, "pack") } : {}) },
    });
    const result = { secret: secret(r.webhook_secret), link: { href: `/admin/connectors/${r.connector.id}`, label: M.open } };
    try {
      for (const s of kind.secrets) {
        const v = value(f, `secret.${s.name}`);
        if (v) await gw(connectorPath(r.connector.id, `secrets/${s.name}`), { method: "PUT", body: { value: v } });
      }
    } catch (e) {
      if (!(e instanceof GatewayError)) throw e;
      refresh(); return failState(M.partial, result);
    }
    refresh(); return okState(M.created, result);
  } catch (e) { return failure(e); }
}

export async function saveConnectorAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const no = await denied(); if (no) return no;
  const id = value(f, "id"); if (!isConnectorId(id)) return failState(M.invalid);
  try {
    const current = await gw<ConnectorView>(connectorPath(id));
    const kind = await kindOf(current.kind); if (!kind) return failState(M.invalid);
    const parsed = configuration(f, kind); if ("error" in parsed) return parsed.error;
    // The API cannot clear an existing target; recreating explicitly preserves its consent and ownership rules.
    if (current.target_space_id && !value(f, "target_space_id")) return failState(M.invalid);
    await gw(connectorPath(id), { method: "PATCH", body: parsed.body });
    refresh(); return okState(M.saved);
  } catch (e) { return failure(e); }
}

export async function saveConnectorSecretAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const no = await denied(); if (no) return no;
  const id = value(f, "id"), name = value(f, "name"), v = value(f, "value");
  if (!isConnectorId(id) || !/^[a-z][a-z0-9_]{0,31}$/.test(name) || name === "webhook" || !v || v.length > 8192) return failState(M.invalid);
  try {
    await gw(connectorPath(id, `secrets/${name}`), { method: "PUT", body: { value: v } });
    refresh(); return okState(M.done);
  } catch (e) { return failure(e); }
}

export async function connectorAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const op = value(f, "op"), id = value(f, "id");
  const no = await denied(op === "pause" || op === "delete"); if (no) return no;
  if (!isConnectorId(id) || !["test", "run", "pause", "resume", "reconfirm", "rotate", "delete"].includes(op)) return failState(M.invalid);
  if (["delete", "rotate", "reconfirm"].includes(op) && value(f, "acknowledge") !== "on") return failState(M.invalid);
  try {
    const suffix = op === "delete" ? "" : op === "rotate" ? "webhook-secret/rotate" : op;
    const r = await gw<{ webhook_secret?: string }>(connectorPath(id, suffix), op === "delete" ? { method: "DELETE" } : { method: "POST", body: {} });
    refresh();
    return okState(op === "test" || op === "run" ? M.queued : M.done, {
      ...(op === "rotate" ? { secret: secret(r.webhook_secret), lines: [M.rotation] } : {}),
      ...(op === "delete" ? { link: { href: "/admin/connectors", label: M.back } } : {}),
    });
  } catch (e) { return failure(e); }
}
