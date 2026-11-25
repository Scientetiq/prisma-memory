import {
  ConverterError, DEFAULT_CONVERTER_MAX_RESPONSE_BYTES, DEFAULT_CONVERTER_RESULT_MAX_BYTES,
  fastLaneErrorClass, fastLaneOutcome, normalizeConverterMarkdown,
} from "../converter.ts";
import type { ConverterConfig, FastLaneOutcome, FastLaneResult } from "../converter.ts";
import { converterHealth } from "../converter-session.ts";
import { CONVERTER_FORMATS } from "../document-formats.ts";
import type { ConversionEngine, ConversionUnit, EngineCaps, EngineClassifiedError, EngineId, NormalizedConversion } from "./engine.ts";
import { assertEngineId } from "./registry.ts";

type ResultPath = "json" | "bundle";
type NormalizationContext = { id: EngineId; path?: ResultPath };

export function toNormalizedConversion(result: FastLaneResult, context: NormalizationContext): NormalizedConversion {
  const { status, markdown } = result;
  // Reuse the existing failure codes and missing-text exceptions.
  const error = status === "failed" || !markdown?.trim() ? fastLaneOutcome(result).error_code : null;
  const content = status !== "failed" && markdown !== null ? normalizeConverterMarkdown(markdown) : null;
  const units = result.units.map((unit): ConversionUnit => {
    const { kind, number, method, chars, images, warnings } = unit;
    const normalizedKind = kind === "page" || kind === "slide" || kind === "sheet" ? kind : "file";
    return {
      kind: normalizedKind,
      number: normalizedKind !== "file" && number !== null && number > 0 ? number : null,
      method, chars, images, warnings: [...warnings],
    };
  });
  return {
    status,
    error,
    markdown: content?.text ?? null,
    pages: content?.pages ?? null,
    units,
    warnings: [...result.warnings],
    engine: { id: context.id, release: result.converter_release },
    details: {
      result_path: context.path ?? "json",
      source_format: result.source_format,
      images_found: result.images.length || (markdown?.match(/\]\(images\//gu)?.length ?? 0),
    },
  };
}

export interface ConverterServiceConverted {
  text: string;
  pages: number | null;
  extraction: FastLaneOutcome["extraction"];
  certified: FastLaneOutcome["certified"];
  exportProfile: FastLaneOutcome["export_profile"];
  exportId: null;
  fields: {
    result_path: ResultPath;
    warning_codes: FastLaneOutcome["warning_codes"];
    agent_file: FastLaneOutcome["agent_file"];
    agent_file_why: FastLaneOutcome["agent_file_why"];
    source_format: FastLaneOutcome["source_format"];
    converter_release: FastLaneOutcome["converter_release"];
    ocr_units: FastLaneOutcome["ocr_units"];
    dc_status: FastLaneOutcome["dc_status"];
  };
}

export function toConverted(normalized: NormalizedConversion, outcome: FastLaneOutcome): ConverterServiceConverted {
  return {
    text: outcome.text,
    pages: outcome.pages,
    extraction: outcome.extraction,
    certified: outcome.certified,
    exportProfile: outcome.export_profile,
    exportId: null,
    fields: {
      result_path: normalized.details?.result_path === "bundle" ? "bundle" : "json",
      warning_codes: outcome.warning_codes,
      agent_file: outcome.agent_file,
      agent_file_why: outcome.agent_file_why,
      source_format: outcome.source_format,
      converter_release: normalized.engine.release,
      ocr_units: outcome.ocr_units,
      dc_status: outcome.dc_status,
    },
  };
}

export function classifyConverterServiceError(error: unknown): EngineClassifiedError {
  if (typeof error === "string") return { cls: fastLaneErrorClass(error), code: error };
  if (!(error instanceof ConverterError)) return { cls: "job_error", code: "error" };
  return {
    cls: error.terminal ? "terminal" : "job_error",
    code: error.code ?? (error.status ? `http_${error.status}` : error.kind),
    kind: error.kind,
    status: error.status,
    retryAfterSec: error.retryAfterSec,
  };
}

// The service does not publish an open contract version or an idempotency retention period.
export type ConverterServiceCaps = Pick<EngineCaps, "release" | "formats" | "ocr"> & {
  async: true;
  limits: EngineCaps["limits"] & {
    max_response_bytes: number;
    max_result_bytes: number;
    max_text_bytes: number;
  };
};

type ServiceLimitConfig = Partial<Pick<ConverterConfig, "maxResponseBytes" | "resultMaxBytes" | "textMaxBytes">>;

export function converterServiceCaps(config: ServiceLimitConfig): ConverterServiceCaps {
  const responseBytes = Math.max(1, config.maxResponseBytes ?? DEFAULT_CONVERTER_MAX_RESPONSE_BYTES);
  return {
    release: null,
    formats: CONVERTER_FORMATS,
    ocr: { mode: "model", languages: [] },
    async: true,
    limits: {
      max_bytes: Math.max(1, Math.floor(responseBytes / 2)),
      max_pages: null,
      max_deadline_sec: null,
      max_response_bytes: responseBytes,
      max_result_bytes: Math.max(1, config.resultMaxBytes ?? DEFAULT_CONVERTER_RESULT_MAX_BYTES),
      max_text_bytes: Math.max(1, config.textMaxBytes || responseBytes),
    },
  };
}

type ConverterServiceParts = Omit<ConversionEngine, "caps" | "convert"> & { readonly caps: ConverterServiceCaps };

export function converterServiceParts(
  { id, config, health = converterHealth }: { id: EngineId; config: ConverterConfig; health?: typeof converterHealth },
): ConverterServiceParts {
  assertEngineId(id);
  return {
    id,
    caps: converterServiceCaps(config),
    health: async () => ({ status: (await health(config)).ok ? "ok" : "unavailable" }),
    classifyError: (code) => classifyConverterServiceError(code).cls,
  };
}
