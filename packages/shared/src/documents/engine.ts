import type { AgentFileWhy } from "../converter.ts";
import type { ConverterFormat } from "../document-formats.ts";

/** The registry validates the format of an id. The contract reserves `builtin` and `http`. */
export type EngineId = string;

type EngineErrorClass = "terminal" | "rerun" | "job_error";
type RunStatus = "ready" | "partial" | "failed";
type RecognitionMode = "local" | "model";
type IdempotencyCaps = { retention_sec: number };

export type EngineCaps = {
  contract_version: string;
  release: string | null;
  formats: readonly ConverterFormat[];
  office_formats?: readonly ("doc" | "ppt" | "rtf" | "odt" | "ods" | "odp")[];
  ocr: { mode: "none" | RecognitionMode; languages: readonly string[] };
  limits: {
    max_bytes: number;
    max_pages: number | null;
    max_deadline_sec: number | null;
  };
} & (
  | { async: false; idempotency?: IdempotencyCaps }
  | { async: true; idempotency: IdempotencyCaps }
);

export interface ConversionInput {
  file: { bytes: Uint8Array; name: string };
  format: ConverterFormat;
  locale: "en" | "ru";
  ocr: "off" | RecognitionMode;
  ocr_languages?: string;
  idempotency_key: string;
  sha256?: string;
  text_max_bytes?: number;
  max_pages?: number;
  deadline_sec?: number;
}

export interface ConversionUnit {
  kind: "page" | "slide" | "sheet" | "file";
  number: number | null;
  method: string;
  chars: number;
  images: number;
  hidden?: boolean;
  warnings: string[];
}

export interface NormalizedConversion {
  status: RunStatus;
  error?: string | null;
  markdown: string | null;
  pages: number | null;
  units: ConversionUnit[];
  warnings: string[];
  engine: { id: EngineId; release: string | null };
  details?: Record<string, unknown>;
}

export interface ConversionEngine {
  readonly id: EngineId;
  readonly caps: EngineCaps;
  health(): Promise<{ status: "ok" | "unavailable" }>;
  convert(input: ConversionInput): Promise<NormalizedConversion>;
  classifyError(code: string): EngineErrorClass;
}

export interface DeriveOutcomeInput {
  status: RunStatus;
  error: string | null;
  text: string | null;
  units: readonly ConversionUnit[];
  warnings: readonly string[];
  images_found: number;
  engine_format: string | null;
  detected_format: string | null;
  source_flags: readonly string[];
  engine: NormalizedConversion["engine"];
}

export interface ConversionOutcome {
  status: RunStatus;
  text: string;
  pages: number | null;
  extraction: "ready" | "partial" | "unavailable";
  agent_file: boolean;
  agent_file_why: AgentFileWhy[];
  warning_codes: string[];
  ocr_units: number;
  ocr_rerun: boolean;
  error_code: string | null;
  error_class: EngineErrorClass | null;
  engine_format: string | null;
  engine: NormalizedConversion["engine"];
}

export type EngineClassifiedError = {
  cls: EngineErrorClass;
  code: string;
  kind?: string;
  status?: number;
  retryAfterSec?: number;
};
