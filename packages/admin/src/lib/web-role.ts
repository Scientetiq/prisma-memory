import { WEB_ROLE_TEXT } from "../messages/web-role";

export type WebRole = "all" | "workplace" | "panel";

export function webRole(raw: string | undefined = process.env.MEMORY_WEB_ROLE): WebRole {
  const v = (raw ?? "").trim();
  if (!v || v === "all") return "all";
  if (v === "workplace" || v === "panel") return v;
  throw new Error(WEB_ROLE_TEXT.invalid(v));
}

export const isPanelPath = (pathname: string): boolean => /^\/admin(?:\/|$)/.test(pathname.replace(/\/{2,}/g, "/"));

export const isAssetPath = (pathname: string): boolean =>
  pathname.startsWith("/_next/") || /^\/(?:favicon\.ico|icon\.(?:svg|png)|apple-icon\.png|robots\.txt|manifest\.webmanifest)$/.test(pathname);

export function roleAllows(role: WebRole, pathname: string): boolean {
  if (role === "all" || isAssetPath(pathname)) return true;
  return role === "panel" ? isPanelPath(pathname) : !isPanelPath(pathname);
}
