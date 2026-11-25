import type { WebRole } from "./web-role";

export function workplaceHome(role: WebRole, workplaceUrl: unknown): string {
  if (role !== "panel" || typeof workplaceUrl !== "string" || !workplaceUrl.trim()) return "/";
  try {
    const u = new URL(workplaceUrl.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.origin}/` : "/";
  } catch {
    return "/";
  }
}
