const WORKPROFILE_PREFIX = "workprofile:";
const WORKPROFILE_PUBLIC_PREFIX = "workprofile-public:";

export const isWorkProfileRecord = (r: { type?: string | null; source_kind?: string | null; source_ref?: string | null } | null | undefined): boolean =>
  !!r && r.type === "profile" && r.source_kind === "agent" && typeof r.source_ref === "string"
  && (r.source_ref.startsWith(WORKPROFILE_PREFIX) || r.source_ref.startsWith(WORKPROFILE_PUBLIC_PREFIX));

export const isPublicCopyRecord = (r: { type?: string | null; source_kind?: string | null; source_ref?: string | null } | null | undefined): boolean =>
  isWorkProfileRecord(r) && (r!.source_ref as string).startsWith(WORKPROFILE_PUBLIC_PREFIX);

export const PROFILE_SECTIONS = ["role", "focus", "expertise", "work_with_me", "agent"] as const;
export type ProfileSection = typeof PROFILE_SECTIONS[number];
export const PUBLIC_SECTIONS = ["role", "focus", "expertise", "work_with_me"] as const;
export type PublicSection = typeof PUBLIC_SECTIONS[number];

export { PROFILE_SECTION_TITLES } from "../messages/work-profile";

export const isProfileSection = (v: unknown): v is ProfileSection => typeof v === "string" && (PROFILE_SECTIONS as readonly string[]).includes(v);
export const isPublicSection = (v: unknown): v is PublicSection => typeof v === "string" && (PUBLIC_SECTIONS as readonly string[]).includes(v);

export const PROFILE_TITLE = "Work profile";
const PUBLIC_TITLE_HEAD = `${PROFILE_TITLE}: `;

export function publicCopyName(title: string | null | undefined): string | null {
  if (!title || !title.startsWith(PUBLIC_TITLE_HEAD)) return null;
  return title.slice(PUBLIC_TITLE_HEAD.length).trim() || null;
}

export const PROFILE_CHARS_PER_TOKEN = 4;
