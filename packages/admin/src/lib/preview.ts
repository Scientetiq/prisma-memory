import { PREVIEW_TEXT } from "../messages/preview";

export const PREVIEW_OPS = ["me", "search", "read", "list", "original"] as const;

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { PREVIEW_TEXT } from "../messages/preview";

export const previewBarText = (persona: string, role: string): string =>
  PREVIEW_TEXT.bar(persona, role);
