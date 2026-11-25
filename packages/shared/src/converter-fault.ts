import { testHooksEnabled } from "./llm-state.ts";

export const CONVERSION_FAULT_POINTS = ["after_session", "after_complete", "before_submitted_patch", "after_fetch", "before_final", "poll"] as const;
export type ConversionFaultPoint = (typeof CONVERSION_FAULT_POINTS)[number];
export const CONVERSION_FAULT_ACTIONS = ["crash", "unavailable", "http500", "abort"] as const;
export type ConversionFaultAction = (typeof CONVERSION_FAULT_ACTIONS)[number];
export type ConverterStepPoint = Extract<ConversionFaultPoint, "after_session" | "after_complete">;

export interface ConversionFault { point: ConversionFaultPoint; action: ConversionFaultAction; times: number; title_contains: string | null }

const FAULT_KEYS = new Set(["point", "action", "times", "title_contains"]);
export const CONVERSION_FAULT_MAX_TIMES = 50;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function conversionFaultProblems(value: unknown, hooks = testHooksEnabled()): string[] {
  if (!isObj(value)) return ["expected a set of values"];
  if (!Object.keys(value).length) return [];
  const p: string[] = [];
  if (!hooks) p.push("conversion faults can be requested only on a test installation");
  if (Object.keys(value).some((k) => !FAULT_KEYS.has(k))) p.push("the setting contains unexpected fields. Remove them");
  if (!(CONVERSION_FAULT_POINTS as readonly unknown[]).includes(value.point))
    p.push("fault location: after upload starts, after upload finishes, before submission is recorded, after text is received, before the result is saved or while polling the converter");
  if (!(CONVERSION_FAULT_ACTIONS as readonly unknown[]).includes(value.action))
    p.push("fault type: worker shutdown, converter unavailable, converter error or interrupted request");
  if (value.times !== undefined && !(typeof value.times === "number" && Number.isInteger(value.times) && value.times >= 1 && value.times <= CONVERSION_FAULT_MAX_TIMES))
    p.push(`repeat count: from 1 to ${CONVERSION_FAULT_MAX_TIMES}`);
  if (value.title_contains !== undefined && value.title_contains !== null
      && !(typeof value.title_contains === "string" && [...value.title_contains].length >= 4 && [...value.title_contains].length <= 200))
    p.push("record title substring: 4 to 200 characters, or empty to match any record");
  return p;
}

export function parseConversionFault(value: unknown): ConversionFault | null {
  if (!isObj(value) || !Object.keys(value).length || conversionFaultProblems(value, true).length) return null;
  const title = typeof value.title_contains === "string" && value.title_contains ? value.title_contains : null;
  return { point: value.point as ConversionFaultPoint, action: value.action as ConversionFaultAction, times: typeof value.times === "number" ? value.times : 1, title_contains: title };
}

export const conversionFaultFingerprint = (f: ConversionFault): string => `${f.point}|${f.action}|${f.times}|${f.title_contains ?? ""}`;

export function conversionFaultMatches(f: ConversionFault, texts: ReadonlyArray<string | null | undefined>): boolean {
  if (!f.title_contains) return true;
  return texts.some((t) => typeof t === "string" && t.includes(f.title_contains!));
}

export const CONVERTER_DEDUP_VALUES = ["document", "off"] as const;
export type ConverterDedup = (typeof CONVERTER_DEDUP_VALUES)[number];

export function converterDedup(settings: { get<T>(key: string, fallback: T): T }): ConverterDedup {
  const v = settings.get<unknown>("integrations.converter_dedup", "off");
  return v === "document" ? "document" : "off";
}
