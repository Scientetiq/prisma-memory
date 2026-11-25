import { spaceGuide as M } from "../messages/space-guide";
import { GUIDE_PLAIN } from "./plain";
import type { MeResult } from "./me-api";
import type { GuideSection, GuideSections, SpaceGuide, SpaceGuideProposal, SpaceGuideSaved } from "./types";

export const GUIDE_SECTION_ORDER: readonly GuideSection[] = ["tasks", "docs", "sources", "glossary", "people", "rhythm"];
export const isGuideSection = (s: string): s is GuideSection => (GUIDE_SECTION_ORDER as readonly string[]).includes(s);
export const GUIDE_SECTION_MAX = 20_000;
export const GUIDE_HISTORY_PAGE = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isProposalId = (s: string): boolean => UUID.test(s);

export const guideHref = (slug: string): string => `/projects/${encodeURIComponent(slug)}/guide`;
export const guideApplyHref = (slug: string, proposalId: string): string => `${guideHref(slug)}?proposal=${encodeURIComponent(proposalId)}#form`;
export const guideProposalsHref = (slug: string): string => `${guideHref(slug)}#proposals`;
export const GUIDE_BACK = /^\/projects\/[a-z0-9][a-z0-9-]{1,62}\/guide$/;

export const sectionTitles = (list: readonly GuideSection[]): string =>
  list.map((s) => M.quote(GUIDE_PLAIN.sections[s].title)).join(", ");

const norm = (v: string | undefined | null): string => (v ?? "").replace(/\r\n?/g, "\n").trim();

export function changedSections(current: GuideSections, next: GuideSections): GuideSection[] {
  return GUIDE_SECTION_ORDER.filter((s) => norm(current[s]) !== norm(next[s]));
}

export function formValues(guide: Pick<SpaceGuide, "sections">, proposal: Pick<SpaceGuideProposal, "sections"> | null): Record<GuideSection, string> {
  const src = proposal ? proposal.sections : guide.sections;
  return Object.fromEntries(GUIDE_SECTION_ORDER.map((s) => [s, src[s] ?? ""])) as Record<GuideSection, string>;
}

export function pickProposal(guide: Pick<SpaceGuide, "proposals" | "proposal" | "can_edit">, id: string): SpaceGuideProposal | null {
  if (!id || !isProposalId(id) || !guide.can_edit) return null;
  const same = (x: SpaceGuideProposal | null | undefined): x is SpaceGuideProposal => !!x && x.id.toLowerCase() === id.toLowerCase();
  const p = guide.proposal !== undefined ? (same(guide.proposal) ? guide.proposal : null) : (guide.proposals ?? []).find(same) ?? null;
  return p && p.can.apply ? p : null;
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
export const isGuideCursor = (s: string): boolean => CURSOR.test(s);

export function guideQuery(proposal: string, cursor: string): { proposal?: string; proposals_cursor?: string } {
  return { ...(isProposalId(proposal) ? { proposal: proposal.toLowerCase() } : {}), ...(isGuideCursor(cursor) ? { proposals_cursor: cursor } : {}) };
}

export function formSections(form: FormData): Record<GuideSection, string | null> {
  return Object.fromEntries(GUIDE_SECTION_ORDER.map((s) => {
    const v = form.get(s);
    const t = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
    return [s, t || null];
  })) as Record<GuideSection, string | null>;
}

export function tooLongSection(sections: Record<GuideSection, string | null>): GuideSection | null {
  return GUIDE_SECTION_ORDER.find((s) => (sections[s]?.length ?? 0) > GUIDE_SECTION_MAX) ?? null;
}

export type GuideLoad =
  | { kind: "ok"; guide: SpaceGuide }
  | { kind: "disabled" }
  | { kind: "not_found" }
  | { kind: "error"; result: Extract<MeResult<SpaceGuide>, { ok: false }> };
const reasonOf = (details: unknown): string | null =>
  details && typeof details === "object" && typeof (details as { reason?: unknown }).reason === "string" ? (details as { reason: string }).reason : null;
export function guideLoad(res: MeResult<SpaceGuide>): GuideLoad {
  if (res.ok) return { kind: "ok", guide: res.data };
  if (res.code === "forbidden" && reasonOf(res.details) === "space_guide_disabled") return { kind: "disabled" };
  if (res.code === "not_found") return { kind: "not_found" };
  return { kind: "error", result: res };
}

export function savedText(saved: SpaceGuideSaved, fromProposal: boolean): { message: string; lines: string[] } {
  const v = saved.guide.version ?? 1;
  if (saved.already_known) return { message: fromProposal ? GUIDE_PLAIN.appliedSame : GUIDE_PLAIN.same, lines: [] };
  const closed = saved.guide.class === "closed";
  return {
    message: fromProposal ? GUIDE_PLAIN.applied(v) : GUIDE_PLAIN.saved(v),
    lines: [closed ? GUIDE_PLAIN.savedClosedLine : GUIDE_PLAIN.savedLine, ...(saved.changed.length ? [GUIDE_PLAIN.changed(sectionTitles(saved.changed))] : [])],
  };
}

export function saveFailText(res: Extract<MeResult<unknown>, { ok: false }>): { message: string; lines: string[] } {
  const d = (res.details && typeof res.details === "object" ? res.details : {}) as { max?: unknown; tokens?: unknown };
  if (res.code === "too_large" && typeof d.max === "number")
    return { message: GUIDE_PLAIN.limit(d.max), lines: typeof d.tokens === "number" ? [M.tokenCount(d.tokens)] : [] };
  if (res.code === "open_check") return { message: res.message, lines: res.hint ? [res.hint] : [] };
  if (reasonOf(res.details) === "space_guide_disabled") return { message: GUIDE_PLAIN.disabled, lines: [] };
  if (reasonOf(res.details) === "not_proposed" || reasonOf(res.details) === "space_guide_proposal")
    return { message: `${GUIDE_PLAIN.notSaved}: ${res.message}`, lines: [GUIDE_PLAIN.proposalGone] };
  return { message: `${GUIDE_PLAIN.notSaved}: ${res.message}`, lines: [] };
}

export function proposalMeta(p: Pick<SpaceGuideProposal, "by" | "mine" | "origin">): string[] {
  const who = p.mine ? GUIDE_PLAIN.mine : p.by ? GUIDE_PLAIN.by(p.by.display_name || p.by.login) : null;
  return [...(who ? [who] : []), p.origin === "agent" ? GUIDE_PLAIN.fromAgent : GUIDE_PLAIN.fromHuman];
}
