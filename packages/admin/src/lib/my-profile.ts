import type { MeResult } from "./me-api";
import { PROFILE_PLAIN } from "./plain";
import { dayWords } from "./record-view";
import type { MyNavSummary, MyProfile, MyProfileHistoryItem, MyProfileSection, PublicProfile, WorkProfilePublicSection, WorkProfileSection } from "./types";
import { isPublicSection, PROFILE_CHARS_PER_TOKEN, PROFILE_SECTION_TITLES, PROFILE_SECTIONS, PUBLIC_SECTIONS } from "./work-profile";

export const MY_PROFILE_API = "/api/v1/me/profile";
export const MY_PROFILE_HREF = "/me/profile";
export const HISTORY_CURSOR = "hcur";
export const HISTORY_PAGE = 10;
export const sectionField = (s: WorkProfileSection): string => `s_${s}`;

export const profileOn = (nav: Pick<MyNavSummary, "profile_enabled"> | null | undefined): boolean => nav?.profile_enabled === true;

export const historyCursor = (raw: string | null | undefined): string => (raw && /^\d{1,6}$/.test(raw) && raw !== "0" ? raw : "");

export function historyPath(cursor: string): string {
  return `${MY_PROFILE_API}/history?limit=${HISTORY_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
}

export function publicProfilePath(login: string | null | undefined): string | null {
  const l = (login ?? "").trim();
  return l && l.length <= 320 ? `/api/v1/people/${encodeURIComponent(l)}/profile` : null;
}

export type ProfileState = { kind: "off" } | { kind: "ok"; data: MyProfile } | { kind: "failed"; message: string };

export function profileState(r: MeResult<MyProfile> | null | undefined): ProfileState {
  if (!r) return { kind: "off" };
  if (r.ok) return r.data && typeof r.data.sections === "object" && r.data.sections !== null ? { kind: "ok", data: r.data } : { kind: "off" };
  if (r.code === "forbidden" || r.code === "not_found") return { kind: "off" };
  return { kind: "failed", message: r.message };
}

export function publicProfileOf(r: MeResult<PublicProfile> | null | undefined): PublicProfile | null {
  if (!r || !r.ok || !r.data || typeof r.data.sections !== "object" || r.data.sections === null) return null;
  return PUBLIC_SECTIONS.some((s) => r.data.sections[s]?.text?.trim()) ? r.data : null;
}

export function shownSections(sections: Partial<Record<WorkProfilePublicSection, { text: string; updated_at: string }>>): Array<{ s: WorkProfilePublicSection; title: string; text: string }> {
  return PUBLIC_SECTIONS.flatMap((s) => {
    const t = sections[s]?.text?.trim();
    return t ? [{ s, title: PROFILE_SECTION_TITLES[s], text: t }] : [];
  });
}

export const sourceWords = (src: MyProfileSection["source"] | null | undefined): string | null =>
  src === "person" ? PROFILE_PLAIN.sourcePerson : src === "agent_on_behalf" ? PROFILE_PLAIN.sourceAgent : null;

export function sectionMeta(v: MyProfileSection | undefined, now: Date = new Date()): { text: string; stale: boolean } | null {
  if (!v) return null;
  const day = dayWords(v.updated_at, now);
  return v.stale ? { text: PROFILE_PLAIN.stale(day), stale: true } : { text: PROFILE_PLAIN.updated(day, sourceWords(v.source)), stale: false };
}

export const sectionChars = (limits: MyProfile["limits"] | null | undefined): number => Math.max(1, (limits?.section_max_tokens ?? 200) * PROFILE_CHARS_PER_TOKEN);

export function previewKind(p: Pick<MyProfile, "public" | "public_preview" | "hidden" | "sections">): "shown" | "empty" | "pending" | "unfilled" {
  if (shownSections(p.public_preview?.sections ?? {}).length) return "shown";
  if (p.hidden || !p.public.length) return "empty";
  return p.public.some((s) => p.sections?.[s]?.text?.trim()) ? "pending" : "unfilled";
}

export function extendedNote(s: WorkProfileSection, p: Pick<MyProfile, "sections" | "public" | "hidden">): string | null {
  if (!p.sections[s]?.extended_write) return null;
  return !p.hidden && isPublicSection(s) && !p.public.includes(s) ? PROFILE_PLAIN.extended : PROFILE_PLAIN.extendedPlain;
}

export const publicButEmpty = (s: WorkProfileSection, p: Pick<MyProfile, "sections" | "public" | "hidden">): boolean =>
  !p.hidden && isPublicSection(s) && p.public.includes(s) && !p.sections[s]?.text?.trim();

export function focusStaleDay(nav: Pick<MyNavSummary, "profile_enabled" | "profile_focus_stale"> | null | undefined, now: Date = new Date()): string | null {
  return profileOn(nav) && nav?.profile_focus_stale ? dayWords(nav.profile_focus_stale, now) : null;
}

export function historyLine(it: MyProfileHistoryItem): string {
  const titles = PROFILE_SECTIONS.filter((s) => it.sections_changed.includes(s)).map((s) => PROFILE_SECTION_TITLES[s]);
  return [PROFILE_PLAIN.historyChanged(titles), it.public_changed ? PROFILE_PLAIN.historyPublic : null, sourceWords(it.source)].filter(Boolean).join(" · ");
}

const lines = (v: FormDataEntryValue | null | undefined): string => String(v ?? "").replace(/\r\n?/g, "\n").trim();

export const BASE_FIELD = "base";
export const BASE_PUBLIC_FIELD = "pub0";
export const PENDING_FIELD = "pend";
export const OVERWRITE_FIELD = "overwrite";

export type SectionTexts = Partial<Record<WorkProfileSection, string>>;
export type SectionChanges = Partial<Record<WorkProfileSection, string | null>>;

export function baseField(p: Pick<MyProfile, "sections">): string {
  return JSON.stringify(Object.fromEntries(PROFILE_SECTIONS.flatMap((s) => {
    const t = lines(p.sections[s]?.text);
    return t ? [[s, t]] : [];
  })));
}

export function baseFromForm(fd: FormData): SectionTexts | null {
  const raw = fd.get(BASE_FIELD);
  if (typeof raw !== "string" || !raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: SectionTexts = {};
  for (const s of PROFILE_SECTIONS) {
    const t = (v as Record<string, unknown>)[s];
    if (typeof t === "string" && lines(t)) out[s] = lines(t);
  }
  return out;
}

export function sectionsFromForm(fd: FormData, base: SectionTexts | null = null): SectionChanges {
  const out: SectionChanges = {};
  for (const s of PROFILE_SECTIONS) {
    if (!fd.has(sectionField(s))) continue;
    const v = lines(fd.get(sectionField(s)));
    if (base && v === (base[s] ?? "")) continue;
    out[s] = v || null;
  }
  return out;
}

export function clashes(changes: SectionChanges, base: SectionTexts, current: Pick<MyProfile, "sections">): WorkProfileSection[] {
  return PROFILE_SECTIONS.filter((s) => {
    if (!(s in changes)) return false;
    const now = lines(current.sections[s]?.text);
    return now !== (base[s] ?? "") && now !== (changes[s] ?? "");
  });
}

export function clashLine(list: readonly WorkProfileSection[], current: Pick<MyProfile, "sections">): string {
  return PROFILE_PLAIN.clashLine(list.map((s) => `«${PROFILE_SECTION_TITLES[s]}» (${PROFILE_PLAIN.clashWho(current.sections[s]?.source ?? null)})`));
}

export function publicFromForm(fd: FormData): WorkProfilePublicSection[] | undefined {
  if (fd.get("pub") !== "1") return undefined;
  const picked = new Set(fd.getAll("public").map((v) => String(v)));
  return PUBLIC_SECTIONS.filter((s) => picked.has(s) && isPublicSection(s));
}

export function basePublicFromForm(fd: FormData): WorkProfilePublicSection[] | null {
  const raw = fd.get(BASE_PUBLIC_FIELD);
  if (typeof raw !== "string") return null;
  const picked = new Set(raw.split(",").map((v) => v.trim()));
  return PUBLIC_SECTIONS.filter((s) => picked.has(s));
}

export function publicNeeded(checked: readonly WorkProfilePublicSection[], base: readonly WorkProfilePublicSection[] | null, pending: boolean): boolean {
  if (!base || pending) return true;
  return checked.length !== base.length || checked.some((s) => !base.includes(s));
}

export function mergePublic(current: readonly WorkProfilePublicSection[], base: readonly WorkProfilePublicSection[] | null,
                            checked: readonly WorkProfilePublicSection[]): WorkProfilePublicSection[] {
  if (!base) return [...checked];
  return PUBLIC_SECTIONS.filter((s) => (checked.includes(s) && !base.includes(s)) || (current.includes(s) && !(base.includes(s) && !checked.includes(s))));
}

export function refusalLine(message: string): string {
  const rest = message.replace(/^Profile not saved[\s:.,—-]*/u, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : message;
}
