import { assertFastLaneText, normalizeConverterMarkdown } from "../converter.ts";
import type { ExtractionState, FastLaneOutcome, FastLaneResult } from "../converter.ts";

export type FastLaneErrorClass = "terminal" | "rerun" | "job_error";
export const FAST_LANE_TERMINAL_ERRORS: ReadonlySet<string> = new Set([
  "encrypted", "unsupported_format", "malformed_document", "malformed_pdf", "no_pages", "input_too_large", "too_many_pages", "resource_limit",
]);
export const FAST_LANE_RERUN_ERRORS: ReadonlySet<string> = new Set(["timeout", "converter_crashed", "memory_limit", "converter_output_invalid"]);

export function fastLaneErrorClass(code: string): FastLaneErrorClass {
  return FAST_LANE_TERMINAL_ERRORS.has(code) ? "terminal" : FAST_LANE_RERUN_ERRORS.has(code) ? "rerun" : "job_error";
}

function fastLaneErrorCode(error: string | null | undefined): string {
  if (error === null || error === undefined || error === "") return "conversion_failed";
  return /^[a-z][a-z0-9_]{0,63}$/.test(error) ? error : "unknown";
}

const WARNING_CODE = /^[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9_.+/-]{1,64})?$/u;
const MAX_WARNING_CODES = 50;
function fastLaneWarningCodes(raw: readonly string[]): string[] {
  return [...new Set(raw.filter((w) => WARNING_CODE.test(w)))].sort().slice(0, MAX_WARNING_CODES);
}

export const FAST_LANE_OCR_METHODS: ReadonlySet<string> = new Set(["ocr", "ocr_failed", "ocr_unavailable", "ocr_pending"]);
export const FAST_LANE_OFFICE_FORMATS: ReadonlySet<string> = new Set(["docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "xlsx", "ods"]);
const AGENT_FILE_FORMATS = new Set(["pdf", "csv"]);
const PDF_HIDDEN_FLAGS = new Set(["pdf_annotations", "pdf_attachments", "pdf_forms"]);

export type AgentFileWhy = "ocr" | "images" | "pictures_skipped" | "active_content" | "pdf_hidden_parts" | "table_truncated" | "office" | "other_format" | "no_text";

const PAGE_ANCHOR_LINES = /^[ \t]*<!--\s*page:\s*\d+\s*-->[ \t]*$/gmu;

/** Derive extraction state and source-file access from a conversion result. */
export function deriveOutcome(result: FastLaneResult, opts: { sourceFlags?: readonly string[]; sourceFormat?: string | null } = {}): FastLaneOutcome {
  const units = result.units ?? [];
  const raw = [...(result.warnings ?? []), ...units.flatMap((u) => u.warnings ?? [])];
  const has = (w: string) => raw.includes(w);
  const hasPrefix = (p: string) => raw.some((w) => w.startsWith(p));
  const ocrUnits = units.filter((u) => FAST_LANE_OCR_METHODS.has(u.method)).length;
  const common = {
    dc_status: result.status, ocr_units: ocrUnits, warning_codes: fastLaneWarningCodes(raw),
    source_format: result.source_format ?? null, converter_release: result.converter_release ?? null,
    certified: false as const, export_profile: "DRAFT_UNCERTIFIED" as const,
  };
  if (result.status === "failed") {
    const error_code = fastLaneErrorCode(result.error);
    return { ...common, extraction: "unavailable", ocr_rerun: false, text: "", pages: null, error_code, error_class: fastLaneErrorClass(error_code),
             agent_file: false, agent_file_why: ["no_text"] };
  }
  assertFastLaneText(result.markdown);

  const { text, pages } = normalizeConverterMarkdown(result.markdown);
  const readable = text.replace(PAGE_ANCHOR_LINES, "").trim();
  const ocr = ocrUnits > 0 || has("ocr_not_configured") || has("ocr_found_no_text") || hasPrefix("ocr_failed:");
  const extraction: ExtractionState = (units.length > 0 && units.every((u) => !u.chars)) || !readable ? "unavailable" : ocr ? "partial" : "ready";

  const why: AgentFileWhy[] = [];
  if (ocr) why.push("ocr");
  if ((result.images ?? []).length > 0 || result.markdown.includes("](images/") || (opts.sourceFlags ?? []).includes("pdf_images")) why.push("images");
  if (hasPrefix("picture_format_skipped:") || hasPrefix("unsupported_media_type:") || has("image_limit")) why.push("pictures_skipped");
  if (has("active_content_ignored")) why.push("active_content");
  if ((opts.sourceFlags ?? []).some((f) => PDF_HIDDEN_FLAGS.has(f))) why.push("pdf_hidden_parts");
  if (has("table_truncated")) why.push("table_truncated");
  const format = (result.source_format ?? "").toLowerCase();
  if (FAST_LANE_OFFICE_FORMATS.has(format) || FAST_LANE_OFFICE_FORMATS.has(String(opts.sourceFormat ?? "").toLowerCase())) why.push("office");
  else if (!AGENT_FILE_FORMATS.has(format)) why.push("other_format");
  if (extraction === "unavailable") why.push("no_text");

  return { ...common, extraction, ocr_rerun: hasPrefix("ocr_failed:"), text, pages, error_code: null, error_class: null,
           agent_file: why.length === 0, agent_file_why: why };
}
