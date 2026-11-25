import { CUSTODY_PLAIN, formatDay } from "./plain";
import { RECORD_TYPE_TITLES } from "./labels";
import type { RenderOptions } from "./markdown";
import type { CustodyBasis, CustodyPeople, CustodyRecordItem } from "./types";

type Named = { login: string; display_name: string | null };
export const custodyName = (p: Named): string => p.display_name?.trim() || p.login;

export const custodyBasisLine = (basis: CustodyBasis | string): string =>
  CUSTODY_PLAIN.basis[Object.hasOwn(CUSTODY_PLAIN.basis, basis) ? basis : "admin"]!;

export function custodyPersonCard(p: CustodyPeople["items"][number]): { title: string; basis: string; count: string } {
  const live = p.records.open + p.records.closed;
  return { title: CUSTODY_PLAIN.personLine(custodyName(p.person), formatDay(p.since)), basis: custodyBasisLine(p.basis), count: CUSTODY_PLAIN.countLine(live, p.records.closed) };
}

export const custodyKind = (type: string): string => {
  const t = Object.hasOwn(RECORD_TYPE_TITLES, type) ? RECORD_TYPE_TITLES[type]! : type;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function custodyRow(r: CustodyRecordItem): { title: string; kind: string; day: string; closed: boolean; deleted: string | null } {
  return { title: r.title?.trim() || CUSTODY_PLAIN.untitled, kind: custodyKind(r.type), day: formatDay(r.occurred_at), closed: r.class === "closed",
           deleted: r.deleted_at ? CUSTODY_PLAIN.deletedMark(formatDay(r.deleted_at)) : null };
}

export function custodyRefusal(r: { code: string; message: string; details?: unknown }): { text: string; off: boolean; gone: boolean } {
  const reason = (r.details as { reason?: unknown } | null | undefined)?.reason;
  if (reason === "custody_off") return { text: CUSTODY_PLAIN.off, off: true, gone: false };
  if (reason === "custody_not_copyable") return { text: CUSTODY_PLAIN.notCopyable, off: false, gone: false };
  if (reason === "custody_too_big") return { text: CUSTODY_PLAIN.tooBig, off: false, gone: false };
  if (reason === "custody_empty") return { text: CUSTODY_PLAIN.emptyText, off: false, gone: false };
  if (reason === "custody_active") return { text: r.message, off: false, gone: true };
  if (r.code === "not_found") return { text: CUSTODY_PLAIN.gone, off: false, gone: true };
  return { text: r.message, off: false, gone: false };
}

export const custodyHref = (slug: string, id?: string): string => `/custody/${encodeURIComponent(slug)}${id ? `/${encodeURIComponent(id)}` : ""}`;
export const isCustodySlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{1,62}$/.test(s);

export function custodyRenderOptions(slug: string, type: string, transcriptId: string | null | undefined): RenderOptions {
  if (type !== "summary" && type !== "event") return {};
  return { timeLink: transcriptId ? (sec: number) => `${custodyHref(slug, transcriptId)}#t-${sec}` : null };
}

