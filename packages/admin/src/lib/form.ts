import { FORM_TEXT } from "../messages/form";

export const text = (fd: FormData, name: string): string => String(fd.get(name) ?? "").trim();
export const textLines = (fd: FormData, name: string): string => String(fd.get(name) ?? "").replace(/\r\n?/g, "\n").trim();

export const logins = (fd: FormData, name: string): string[] =>
  [...new Set(text(fd, name).split(/[\s,;]+/).map((m) => m.trim().toLowerCase()).filter(Boolean))];

export const isId = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const isLogin = (s: string): boolean => /^[^\s@]+@[^\s@]+$/.test(s);

export const isSpaceRef = (s: string): boolean => /^(me|org|[a-z0-9][a-z0-9-]{1,62})$/.test(s);

export const isSlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{1,62}$/.test(s);

export const isReservedSlug = (s: string): boolean => s === "me" || s === "org" || /^(u|dep|demo|zz)-/.test(s);

export const PROJECT_NAME_MAX = 120, PROJECT_DESCRIPTION_MAX = 2000, PROJECT_MEMBERS_MAX = 100;
export const PROJECT_README_MAX = 6000;

export const openAckMissing = (cls: string, ack: boolean): boolean => cls !== "closed" && !ack;
/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { FORM_TEXT } from "../messages/form";

export const NEW_PROJECT_FIELDS = ["name", "description", "slug"] as const;
export function nextFieldName(current: string, order: readonly string[] = NEW_PROJECT_FIELDS): string | null {
  const i = order.indexOf(current);
  return i >= 0 && i < order.length - 1 && order[i + 1] !== "slug" ? order[i + 1]! : null;
}

export const HANDOVER_BATCH_MAX = 20;
