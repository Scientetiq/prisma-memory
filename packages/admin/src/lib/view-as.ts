import "server-only";
import { cookies } from "next/headers";
import { requestIsHttps } from "./user-session";

export const VIEW_COOKIE = "memory_admin_view";
export type AdminView = "admin" | "auditor";

export async function readAdminView(): Promise<AdminView> {
  return (await cookies()).get(VIEW_COOKIE)?.value === "auditor" ? "auditor" : "admin";
}

export async function setAdminView(view: AdminView): Promise<void> {
  (await cookies()).set(VIEW_COOKIE, view, { httpOnly: true, sameSite: "lax", secure: await requestIsHttps(), path: "/admin", maxAge: 8 * 3600 });
}
