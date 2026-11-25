import type { WebRole } from "./web-role";

export function workplaceOrigin(role: WebRole, workplaceUrl: unknown, here: string | null): string | null {
  if (role !== "panel") return here;
  if (typeof workplaceUrl !== "string") return null;
  try {
    const url = new URL(workplaceUrl.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function handoverValue(origin: string | null, link: string): string {
  return (origin ?? "") + "/set-password#" + link;
}
