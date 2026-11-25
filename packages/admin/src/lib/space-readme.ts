import type { MeResult } from "./me-api";
import type { MySpace, SpaceReadmeConfig } from "./types";

export const readmeOn = (s: Pick<MySpace, "readme">): boolean => s.readme !== undefined;
export const readmeMissing = (s: Pick<MySpace, "readme">): boolean => s.readme === null;
export const readmeConfigOn = (r: MeResult<SpaceReadmeConfig> | null | undefined): r is Extract<MeResult<SpaceReadmeConfig>, { ok: true }> =>
  Boolean(r && r.ok && r.data && r.data.enabled === true);
export const readmeTemplateOf = (r: MeResult<SpaceReadmeConfig> | null | undefined): string | null =>
  readmeConfigOn(r) && typeof r.data.template === "string" ? r.data.template : null;
export const readmeValue = (readme: string | null | undefined, template: string | null): string => readme ?? template ?? "";
export const readmeHref = (slug: string): string => `/projects/${encodeURIComponent(slug)}?tab=settings#readme`;
