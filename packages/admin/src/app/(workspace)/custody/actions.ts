"use server";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { endedState } from "@/lib/action-ended";
import { custodyRefusal, custodyRenderOptions, isCustodySlug } from "@/lib/custody-read";
import { isId, text } from "@/lib/form";
import { renderMarkdown } from "@/lib/markdown";
import { meGw } from "@/lib/me-api";
import { CUSTODY_PLAIN } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { CustodyCopyResult, CustodyDerived, CustodyReadResult } from "@/lib/types";
import { actionSession } from "@/lib/user-session";

export type CustodyReadOutcome =
  | { ok: true; title: string; html: string; truncated: boolean; originalUrl: string | null; derived: CustodyDerived[] }
  | { ok: false; message: string; link?: { href: string; label: string } };

function ended(r: { message: string; link?: { href: string; label: string } }): Extract<CustodyReadOutcome, { ok: false }> {
  return { ok: false, message: r.link ? CUSTODY_PLAIN.sessionEnded : r.message, ...(r.link ? { link: r.link } : {}) };
}

export async function readCustodyAction(slug: string, id: string, type: string): Promise<CustodyReadOutcome> {
  const session = await actionSession();
  if ("ok" in session) return ended(session);
  if (session.preview) return { ok: false, message: PREVIEW_TEXT.previewDenied };
  if (!isCustodySlug(String(slug)) || !isId(String(id))) return { ok: false, message: CUSTODY_PLAIN.gone };
  const res = await meGw<CustodyReadResult>(session.key, `/api/v1/me/custody/${encodeURIComponent(slug)}/records/${encodeURIComponent(id)}/read`, { method: "POST", body: {} });
  if (!res.ok) {
    const e = await endedState(res);
    if (e) return ended(e);
    return { ok: false, message: custodyRefusal(res).text };
  }
  const t = String(type || "note");
  return { ok: true, title: res.data.title?.trim() || CUSTODY_PLAIN.untitled, html: renderMarkdown(res.data.text, t, custodyRenderOptions(slug, t, res.data.transcript_id)),
           truncated: res.data.truncated === true, originalUrl: res.data.original_url, derived: res.data.derived };
}

export async function copyCustodyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const slug = text(formData, "slug"), id = text(formData, "id");
  if (!isCustodySlug(slug) || !isId(id)) return failState(CUSTODY_PLAIN.gone);
  const res = await meGw<CustodyCopyResult>(session.key, `/api/v1/me/custody/${encodeURIComponent(slug)}/records/${encodeURIComponent(id)}/copy`,
    { method: "POST", body: text(formData, "closed") === "1" ? { confirm: true } : {} });
  if (!res.ok) return (await endedState(res)) ?? failState(custodyRefusal(res).text);
  refresh();
  return okState(CUSTODY_PLAIN.copied(res.data.title?.trim() || CUSTODY_PLAIN.untitled), { link: { href: `/records/${res.data.id}`, label: CUSTODY_PLAIN.open } });
}
