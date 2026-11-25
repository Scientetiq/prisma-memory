"use server";
import { TEXT } from "../../../messages/panel-first-run";
import { headers } from "next/headers";
import { failState, okState, type ActionResult } from "@/lib/action-state";
import { firstRunFailText } from "@/lib/first-run";
import { call, GatewayError } from "@/lib/gateway";
import { MIN_ADMIN_PASSWORD } from "@/lib/labels";
import { clientHeaders } from "@/lib/workplace-login";

export async function firstRunAction(formData: FormData): Promise<ActionResult> {
  const login = String(formData.get("login") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  if (!login) return failState(TEXT.enterTheAdministratorSLogin);
  if (password.length < MIN_ADMIN_PASSWORD) return failState(TEXT.thePasswordMustBeAtLeastCharacters(MIN_ADMIN_PASSWORD));
  if (password !== confirm) return failState(TEXT.thePasswordsDoNotMatch);

  let res: { status: number; data: unknown };
  try {
    res = await call("/api/v1/first-run", { method: "POST", body: code ? { login, password, code } : { login, password }, headers: clientHeaders(await headers()) });
  } catch (e) {
    return failState(e instanceof GatewayError ? e.message : TEXT.theGatewayIsNotResponding);
  }
  const fail = firstRunFailText(res.status, res.data);
  if (fail) return failState(fail);

  const key = (res.data as { system_key?: unknown } | null)?.system_key;
  if (typeof key !== "string" || !key) return failState(TEXT.theAdministratorWasCreatedButTheGateway);
  return okState(TEXT.administratorCreated(login.toLowerCase()), {
    secret: {
      label: TEXT.instanceSystemKey,
      value: key,
      warning: TEXT.thisKeyIsShownOnceAndIs,
    },
  });
}
