import { SETTINGS_VALUES_TEXT } from "../messages/settings-values";

export type EditorKind = "secret" | "string" | "number" | "boolean" | "json";
export type UnsetMode = "string" | "json";

export interface SettingLike { value: unknown; secret: boolean }

export function editorKind(item: SettingLike): EditorKind {
  if (item.secret) return "secret";
  const v = item.value;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v !== null && typeof v === "object") return "json";
  return "string";
}

export function toEditorText(kind: EditorKind, value: unknown): string {
  if (kind === "secret" || value === null || value === undefined) return "";
  if (kind === "json") return JSON.stringify(value, null, 2);
  return String(value);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

export function parseEditorValue(kind: Exclude<EditorKind, "secret">, raw: string, current: unknown = null): Parsed {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  switch (kind) {
    case "string":
      return { ok: true, value: text };
    case "number": {
      const n = Number(text.replace(",", "."));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: SETTINGS_VALUES_TEXT.numberRequired };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false, error: SETTINGS_VALUES_TEXT.booleanRequired };
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        return { ok: false, error: SETTINGS_VALUES_TEXT.invalidJson((e as Error).message) };
      }
      if (Array.isArray(current) && !Array.isArray(value)) return { ok: false, error: SETTINGS_VALUES_TEXT.arrayRequired };
      if (current !== null && typeof current === "object" && !Array.isArray(current) && (value === null || typeof value !== "object" || Array.isArray(value)))
        return { ok: false, error: SETTINGS_VALUES_TEXT.objectRequired };
      return { ok: true, value };
    }
  }
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export const sameValue = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

export const fieldValue = (key: string): string => `value:${key}`;
export const fieldMode = (key: string): string => `mode:${key}`;
export const fieldClear = (key: string): string => `clear:${key}`;
export const fieldConfirmClear = (key: string): string => `confirm_clear:${key}`;
export const fieldOrig = (name: string): string => `orig:${name}`;

export function secretInput(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw.replace(/\r?\n$/, "");
}
export const secretEdgeSpace = (raw: string): boolean => { const v = secretInput(raw); return v !== null && /^\s|\s$/.test(v); };
/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { SETTINGS_VALUES_TEXT } from "../messages/settings-values";



export function fieldDecision<T>(submitted: T, orig: { value: T } | null, server: T, same: (a: T, b: T) => boolean): "skip" | "send" | "conflict" {
  if (orig && same(submitted, orig.value)) return "skip";
  if (same(submitted, server)) return "skip";
  return !orig || same(orig.value, server) ? "send" : "conflict";
}

export const NON_CLEARABLE: ReadonlySet<string> = new Set(["access.link_signing_key"]);

export interface ClearableLike { secret: boolean; required: boolean; isSet: boolean }

export function clearControl(path: string, item: ClearableLike): "none" | "checkbox" | "button" {
  if (!item.secret || !item.isSet || NON_CLEARABLE.has(path)) return "none";
  return item.required ? "button" : "checkbox";
}

export function emptiedRequired(items: Array<ClearableLike & { key: string }>, raw: (key: string) => unknown): string[] {
  return items.filter((i) => !i.secret && i.required && i.isSet).filter((i) => { const v = raw(i.key); return typeof v === "string" && v.trim() === ""; }).map((i) => i.key);
}

export function clearKeyQuestion(key: string, dirty: boolean): string {
  return SETTINGS_VALUES_TEXT.clearKeyQuestion(key, dirty);
}

export function emptiedQuestion(keys: string[]): string {
  return SETTINGS_VALUES_TEXT.emptiedQuestion(keys);
}


export function isUnconfirmedClear(code: string, details: unknown): boolean {
  const problems = (details as { problems?: unknown } | null | undefined)?.problems;
  return code === "invalid_argument" && Array.isArray(problems)
    && problems.some((p) => String((p as { message?: unknown } | null)?.message ?? "").includes("confirm_clear"));
}
