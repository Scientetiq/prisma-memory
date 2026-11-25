import { estimateTokens } from "./ids.ts";

export const GUIDE_SECTIONS = ["tasks", "docs", "sources", "glossary", "people", "rhythm"] as const;
export type GuideSection = typeof GUIDE_SECTIONS[number];

export const GUIDE_SECTION_TITLES: Readonly<Record<GuideSection, string>> = {
  tasks: "Where tasks live", docs: "Where documents live", sources: "Sources to trust", glossary: "Glossary", people: "Who does what", rhythm: "Routine",
};

export const isGuideSection = (v: unknown): v is GuideSection => typeof v === "string" && (GUIDE_SECTIONS as readonly string[]).includes(v);

export const GUIDE_TITLE = "How we work";

export const GUIDE_SUBTYPE = "space_guide";
export const SPACE_GUIDE_PREFIX = "space_guide:";
export const spaceGuideRef = (spaceId: string): string => `${SPACE_GUIDE_PREFIX}${spaceId}`;

export const isSpaceGuideRow = (r: { type?: string | null; source_kind?: string | null; source_ref?: string | null } | null | undefined): boolean =>
  !!r && r.type === "note" && r.source_kind === "agent" && typeof r.source_ref === "string" && r.source_ref.startsWith(SPACE_GUIDE_PREFIX);

export const GUIDE_ENABLED_SETTING = "access.space_guide_enabled";
export const GUIDE_SETTING = "access.space_guide";

export interface GuideLimits { max_tokens: number }
export const GUIDE_LIMITS_DEFAULT: Readonly<GuideLimits> = Object.freeze({ max_tokens: 1500 });
const MAX_TOKENS_RANGE = [300, 4000] as const;
const intIn = (v: unknown, [min, max]: readonly [number, number]): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function spaceGuideSettingProblems(path: string, value: unknown): string[] {
  if (path !== GUIDE_SETTING || value === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["object {max_tokens}"];
  const o = value as Record<string, unknown>, out: string[] = [];
  const extra = Object.keys(o).filter((k) => k !== "max_tokens");
  if (extra.length) out.push(`unexpected fields: ${extra.join(", ")}`);
  if ("max_tokens" in o && !intIn(o.max_tokens, MAX_TOKENS_RANGE))
    out.push(`max_tokens (tokens for the entire guide) must be an integer from ${MAX_TOKENS_RANGE[0]} to ${MAX_TOKENS_RANGE[1]}`);
  return out;
}

export function guideLimits(raw: unknown): GuideLimits {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { max_tokens: intIn(o.max_tokens, MAX_TOKENS_RANGE) ? o.max_tokens : GUIDE_LIMITS_DEFAULT.max_tokens };
}

export type GuideSections = Partial<Record<GuideSection, string>>;
export interface GuideAttrs { sections: GuideSections; changed?: GuideSection[] }

export function guideSectionText(v: string): string {
  return v.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
}

export function parseGuideAttrs(raw: unknown): GuideAttrs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawSections = o.sections && typeof o.sections === "object" && !Array.isArray(o.sections) ? o.sections as Record<string, unknown> : {};
  const sections: GuideSections = {};
  for (const s of GUIDE_SECTIONS) {
    const v = rawSections[s];
    if (typeof v === "string" && v.trim()) sections[s] = v;
  }
  return { sections, ...(Array.isArray(o.changed) ? { changed: GUIDE_SECTIONS.filter((s) => (o.changed as unknown[]).includes(s)) } : {}) };
}

export function guideText(sections: GuideSections): string {
  return GUIDE_SECTIONS.filter((s) => sections[s]?.trim()).map((s) => `## ${GUIDE_SECTION_TITLES[s]}\n${sections[s]!.trim()}`).join("\n\n");
}

export function guideSpans(sections: GuideSections): Array<{ section: GuideSection; start: number; end: number }> {
  const out: Array<{ section: GuideSection; start: number; end: number }> = [];
  let pos = 0;
  for (const s of GUIDE_SECTIONS) {
    const text = sections[s]?.trim();
    if (!text) continue;
    if (out.length) pos += 2;
    const len = `## ${GUIDE_SECTION_TITLES[s]}\n${text}`.length;
    out.push({ section: s, start: pos, end: pos + len });
    pos += len;
  }
  return out;
}

export const guideSectionAt = (spans: ReadonlyArray<{ section: GuideSection; start: number; end: number }>, at: number | undefined): GuideSection | null =>
  typeof at === "number" ? spans.find((x) => at >= x.start && at < x.end)?.section ?? null : null;

const TITLE_TO_SECTION = new Map<string, GuideSection>(GUIDE_SECTIONS.map((s) => [GUIDE_SECTION_TITLES[s].toLowerCase(), s]));

export function parseGuideText(text: string): { sections: GuideSections; unplaced: string | null } {
  const sections: Partial<Record<GuideSection, string[]>> = {};
  const unplaced: string[] = [];
  let cur: GuideSection | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const s = TITLE_TO_SECTION.get(h[1]!.toLowerCase()) ?? null;
      if (s) { cur = s; (sections[s] ??= []).push(""); continue; }
      cur = null;
    }
    if (cur) sections[cur]!.push(line); else unplaced.push(line);
  }
  const out: GuideSections = {};
  for (const s of GUIDE_SECTIONS) {
    const v = sections[s] ? guideSectionText(sections[s]!.join("\n")) : "";
    if (v) out[s] = v;
  }
  const rest = guideSectionText(unplaced.join("\n"));
  return { sections: out, unplaced: rest || null };
}

export const guideTokens = (sections: GuideSections): number => estimateTokens(guideText(sections));
