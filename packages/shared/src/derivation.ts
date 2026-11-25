import { invalid } from "./errors.ts";
import { visibleRow, type RowFacts, type VisibilitySpec } from "./visibility.ts";

export const DERIVATIONS = ["retelling", "synthesis", "original"] as const;
export type Derivation = typeof DERIVATIONS[number];
export type DerivedKind = Exclude<Derivation, "original">;
export const DERIVED_MAX = 20;
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function defaultDerivation(n: number): Derivation {
  return n <= 0 ? "original" : n <= 2 ? "retelling" : "synthesis";
}

export function checkDerivation(ids: readonly string[] | undefined | null, kind: Derivation | undefined | null): { ids: string[]; kind: DerivedKind } | null {
  const list = ids ? ids.map((x) => (typeof x === "string" ? x.toLowerCase() : x)) : [];
  if (kind === "original" && list.length) throw invalid("derivation: original is for new content with no derived_from value. Use retelling or synthesis for a retelling of existing records", { field: "derivation", reason: "derivation_conflict" });
  if ((kind === "retelling" || kind === "synthesis") && !list.length) throw invalid(`derivation: ${kind} requires derived_from with the IDs of the records used to make the note`, { field: "derivation", reason: "derivation_conflict" });
  if (!list.length) return null;
  if (list.length > DERIVED_MAX) throw invalid(`derived_from accepts at most ${DERIVED_MAX} records`, { field: "derived_from", reason: "too_many" });
  if (new Set(list).size !== list.length) throw invalid("derived_from: IDs must be unique", { field: "derived_from", reason: "duplicate" });
  const k = kind ?? defaultDerivation(list.length);
  return { ids: list, kind: k === "original" ? "retelling" : k };
}

export function spaceSeesRow(readers: readonly string[], src: RowFacts, spacesOf: (p: string) => readonly string[]): boolean {
  for (const p of readers) {
    const spec: VisibilitySpec = { principals: [{ id: p, spaces: spacesOf(p) }], asker: p, gate: { open: "all", closed: "all" }, owner: "always" };
    if (!visibleRow(spec, src)) return false;
  }
  return true;
}

export interface OrgUnitFacts { state: string; held_at?: Date | string | null; disputed_at?: Date | string | null }

export function orgStableForAll(unit: OrgUnitFacts | null | undefined): boolean {
  if (!unit) return true;
  return ["confirmed", "community", "exempt"].includes(unit.state) && !unit.held_at && !unit.disputed_at;
}

export const DERIVATION_SOURCES_MAX = 5;
export const DERIVATION_PAGE_MAX = 20;
export const DERIVATION_ORDER_SETTING = "search.derivation_order_enabled";
export const DERIVATION_FACTOR_SETTING = "search.derivation_factor";
export const DERIVATION_FACTOR_DEFAULT = 0.5;

export function derivationFactor(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0.1 && v <= 1 ? v : DERIVATION_FACTOR_DEFAULT;
}

export function derivedDeclaredOf(attrs: Record<string, unknown> | null | undefined): number {
  const v = attrs?.derived_declared;
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : 0;
  return typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : 0;
}

export function declaredRetelling(attrs: Record<string, unknown> | null | undefined): boolean {
  return attrs?.derivation === "retelling" || attrs?.derivation === "synthesis" || derivedDeclaredOf(attrs) > 0 || attrs?.derived_lost === true;
}

export function derivationSettingProblems(path: string, value: unknown): string[] {
  if (value === null) return [];
  if (path === DERIVATION_ORDER_SETTING) return typeof value === "boolean" ? [] : ["true or false"];
  if (path === DERIVATION_FACTOR_SETTING)
    return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 1 ? [] : ["a number from 0.1 to 1 (1 means no downweighting)"];
  return [];
}
