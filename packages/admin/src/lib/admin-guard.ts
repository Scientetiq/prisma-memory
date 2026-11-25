import { ADMIN_GUARD_TEXT } from "../messages/admin-guard";
export { ADMIN_GUARD_TEXT } from "../messages/admin-guard";
import "server-only";
import { redirect } from "next/navigation";
import { failState, type ActionResult } from "./action-state";
import { readSession } from "./session";
import { readAdminView } from "./view-as";



async function auditorSession(): Promise<boolean> {
  return (await readSession().catch(() => null))?.role === "security_auditor";
}

export async function denyAuditor(): Promise<ActionResult | null> {
  if (await auditorSession()) return failState(ADMIN_GUARD_TEXT.AUDITOR_ROLE_DENIED);
  return (await readAdminView()) === "auditor" ? failState(ADMIN_GUARD_TEXT.AUDITOR_DENIED) : null;
}

export async function redirectAuditor(): Promise<void> {
  if ((await readAdminView()) === "auditor" || (await auditorSession())) redirect("/admin/audit");
}

export async function guardAuditorPage(allowAuditor = false): Promise<void> {
  if (!allowAuditor && ((await readAdminView()) === "auditor" || (await auditorSession()))) redirect("/admin/audit");
}
