// Titles and hints of alert codes from contracts/edge/audit-codes.json. A file of its own so that the mail templates
// (mail-render.ts) and the alert core (alerts.ts) read one table without importing each other.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_DIR } from "./contracts.ts";
import { log } from "./log.ts";

/**
 * Title and hint of an alert code. title / hint are the English texts (the default); title_ru / hint_ru are the Russian
 * interface texts where the contract has them. A missing or empty value is absent (the code itself stands in for a title).
 */
export interface AlertCodeInfo { title?: string; hint?: string; title_ru?: string; hint_ru?: string }

let codeInfo: Map<string, AlertCodeInfo> | undefined;
let fileForTests: string | null = null;

/** Tests only: read the codes from another file (null — from the contract again) and forget what was read before. */
export function setAlertCodesFileForTests(path: string | null): void {
  fileForTests = path;
  codeInfo = undefined;
}

/** Title and hint of an alert code; null when the file or the code is missing. */
export function alertCodeInfo(code: string): AlertCodeInfo | null {
  if (!codeInfo) {
    codeInfo = new Map();
    try {
      const doc = JSON.parse(readFileSync(fileForTests ?? join(CONTRACTS_DIR, "edge", "audit-codes.json"), "utf8")) as { sections?: Array<{ codes?: Array<Record<string, unknown>> }> };
      for (const s of doc.sections ?? []) for (const c of s.codes ?? [])
        if (typeof c.code === "string") {
          const info: AlertCodeInfo = {};
          for (const k of ["title", "hint", "title_ru", "hint_ru"] as const) {
            const v = c[k];
            if (typeof v === "string" && v) info[k] = v;
          }
          codeInfo.set(c.code, info);
        }
    } catch (e) {
      log.warn("audit_codes_unreadable", { error: ((e as Error)?.message ?? String(e)).slice(0, 200) });
    }
  }
  return codeInfo.get(code) ?? null;
}
