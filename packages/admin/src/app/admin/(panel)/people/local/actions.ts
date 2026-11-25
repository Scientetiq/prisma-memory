"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { call, GatewayError } from "@/lib/gateway";
import { handoverValue, workplaceOrigin } from "@/lib/local-handover";
import { requireSession } from "@/lib/session";
import type { SettingsResponse } from "@/lib/types";
import { webRole } from "@/lib/web-role";
import { publicHttpsOrigin, requestOrigin } from "@/lib/workplace-login";
import { LOCAL_ACCOUNTS_PANEL as M } from "@/messages/panel-local-accounts";

const ROUTE = "/api/v1/admin/local-accounts";
const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GatewayBody {
  code?: unknown;
  message?: unknown;
  link?: { value?: unknown };
  agent_connections?: unknown;
  already?: unknown;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function post(path: string, body?: { login: string; display_name: string }): Promise<{ status: number; data: GatewayBody }> {
  const { token } = await requireSession();
  // The mutation needs the HTTP status even when the gateway returns a successful body.
  try {
    const { status, data } = await call(path, { method: "POST", token, ...(body === undefined ? {} : { body }) });
    return { status, data: (data ?? {}) as GatewayBody };
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    return { status: error.status, data: { code: error.code, message: error.message } };
  }
}

function failed(status: number, { code, message }: GatewayBody) {
  const line = typeof code === "string" && code
    ? `${code}: ${typeof message === "string" ? message.slice(0, 300) : ""}`
    : `HTTP ${status}`;
  return failState(M.failed, { lines: [line] });
}

function conflictMessage(code: unknown): string | undefined {
  switch (code) {
    case "security_mode_advanced": return M.advanced;
    case "directory_person": return M.directoryPerson;
    case "account_disabled": return M.accountDisabled;
    case "person_inactive": return M.personInactive;
  }
}

async function workplaceSetting(): Promise<unknown> {
  try {
    const settings = await tryGw<SettingsResponse>("/api/v1/admin/settings");
    return settings.ok ? settings.data.items.find((item) => item.category === "access" && item.key === "workplace_url")?.value : null;
  } catch {
    // The account change has succeeded and the link must still reach the administrator.
    return null;
  }
}

async function successWithLink(message: string, link: string, agentsNotRevoked = false): Promise<ActionState> {
  const role = webRole();
  const origin = role === "panel"
    ? workplaceOrigin(role, await workplaceSetting(), null)
    : workplaceOrigin(role, null, publicHttpsOrigin() ?? requestOrigin({ headers: await headers() }));
  const value = handoverValue(origin, link);
  const warnings = [M.linkWarning];
  if (origin === null) warnings.push(M.noOrigin);
  if (agentsNotRevoked) warnings.push(M.agentsNotRevoked);
  refresh();
  return okState(message, { secret: { label: M.linkLabel, value, warning: warnings.join(" ") } });
}

export async function addLocalAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor();
  if (denied) return denied;
  const login = textField(formData, "login");
  const display_name = textField(formData, "display_name");
  if (!login || !display_name) return failState(M.enterBoth);

  const { status, data } = await post(ROUTE, { login, display_name });
  const link = data.link?.value;
  if (status === 201 && typeof link === "string") return successWithLink(M.added, link);
  if (status === 409) {
    if (data.code === "account_exists") return failState(M.accountExists);
    if (data.code === "login_case_conflict") return failState(M.caseConflict);
    const message = conflictMessage(data.code);
    if (message) return failState(message);
  }
  if (status === 400) return failState(M.badInput);
  if (status === 404) return failState(M.off);
  return failed(status, data);
}

export async function resetLocalPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor();
  if (denied) return denied;
  const id = textField(formData, "person_id");
  if (!PERSON_ID.test(id)) return failState(M.noAccount);

  const { status, data } = await post(`${ROUTE}/${id}/reset`);
  const link = data.link?.value;
  if (status === 201 && typeof link === "string") return successWithLink(M.resetDone, link, data.agent_connections !== "revoked");
  if (status === 409) {
    const message = conflictMessage(data.code);
    if (message) return failState(message);
  }
  if (status === 404) return failState(M.noAccount);
  return failed(status, data);
}

export async function disableLocalAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor();
  if (denied) return denied;
  const id = textField(formData, "person_id");
  if (!PERSON_ID.test(id)) return failState(M.noAccount);
  if (formData.get("confirm") !== "yes") return failState(M.confirmFirst);

  const { status, data } = await post(`${ROUTE}/${id}/disable`);
  if (status === 200) {
    const message = data.already === true ? M.alreadyDisabled : M.disabled;
    refresh();
    return okState(data.agent_connections === "revoked" ? message : message + " " + M.agentsNotRevoked);
  }
  if (status === 404) return failState(M.noAccount);
  return failed(status, data);
}
