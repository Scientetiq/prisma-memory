import { fmtNumber } from "@memory/i18n";
import { currentLocale } from "@memory/i18n/context";
import { windowEndOf, windowStartOf, type NightWindow } from "./night-window.ts";

export const NIGHT_CAP_SETTING = "processing.nighttime_token_cap";
export const NIGHT_CAP_DEFAULT = 6_000_000;
export const NIGHT_CAP_MIN = 10_000;
export const NIGHT_CAP_MAX = 200_000_000;
export const NIGHT_TOKENS_KEY = "night_tokens";

interface SettingsLike { get<T>(path: string, fallback: T): T }

export function nightCapSettingProblems(path: string, value: unknown): string[] {
  if (path !== NIGHT_CAP_SETTING) return [];
  const range = `a whole number of tokens from ${fmtNumber(currentLocale(), NIGHT_CAP_MIN)} to ${fmtNumber(currentLocale(), NIGHT_CAP_MAX)}`;
  if (value === null || value === undefined) return [`the nighttime token cap cannot be empty: enter ${range}`];
  if (typeof value !== "number" || !Number.isInteger(value) || value < NIGHT_CAP_MIN || value > NIGHT_CAP_MAX) return [range];
  return [];
}

export function nightCapOf(settings: SettingsLike): number {
  const v = settings.get<unknown>(NIGHT_CAP_SETTING, NIGHT_CAP_DEFAULT);
  return typeof v === "number" && Number.isInteger(v) && v >= NIGHT_CAP_MIN && v <= NIGHT_CAP_MAX ? v : NIGHT_CAP_DEFAULT;
}

export interface NightTokensPrev { window_start: string; tokens: number; capped_at: string | null; cap: number | null; window_config?: string; window_end?: string }
export interface NightTokensState extends NightTokensPrev { prev: NightTokensPrev | null }

const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const count = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const capOrNull = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.floor(Number(v)));

// Additive internal metadata; old counters remain readable. Not yet in the contract documentation.
function periodFields(o: Record<string, unknown>): Pick<NightTokensPrev, "window_config" | "window_end"> {
  const end = isoOrNull(o.window_end);
  return { ...(typeof o.window_config === "string" ? { window_config: o.window_config } : {}), ...(end ? { window_end: end } : {}) };
}

function prevOf(v: unknown): NightTokensPrev | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ws = isoOrNull(o.window_start);
  return ws ? { window_start: ws, tokens: count(o.tokens), capped_at: isoOrNull(o.capped_at), cap: capOrNull(o.cap), ...periodFields(o) } : null;
}

export function parseNightTokens(v: unknown): NightTokensState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ws = isoOrNull(o.window_start);
  if (!ws) return null;
  return { window_start: ws, tokens: count(o.tokens), capped_at: isoOrNull(o.capped_at), cap: capOrNull(o.cap), prev: prevOf(o.prev),
    ...periodFields(o) };
}

/** The current cap view includes overlapping usage when the window configuration changes. */
export interface NightCapView { window_start: string; tokens: number; cap: number; capped: boolean; capped_at: string | null; prev: NightTokensPrev | null }

/** Configuration identity separates a real rollover from a settings change. Absent mode means window. */
export const nightWindowConfig = (w: NightWindow): string => JSON.stringify([w.mode ?? "window", w.tz, w.weekdays, w.weekends]);

/** Legacy counters have no configuration/end: recognise the overlapping starts of the other mode. */
export function legacyNightStarts(w: NightWindow, now: Date): string[] {
  const start = windowStartOf(w, now), end = windowEndOf(w, start);
  const other: NightWindow = { ...w, mode: w.mode === "off" ? "window" : "off" };
  const out: string[] = [];
  let candidate = windowStartOf(other, new Date(end.getTime() - 1));
  while (windowEndOf(other, candidate) > start) {
    out.push(candidate.toISOString());
    const previous = windowStartOf(other, new Date(candidate.getTime() - 1));
    if (previous >= candidate || out.length > 4) throw new Error("invalid night accounting period");
    candidate = previous;
  }
  return out;
}

export function nightCapView(state: NightTokensState | null, cap: number, w: NightWindow, now: Date): NightCapView {
  const start = windowStartOf(w, now), ws = start.toISOString();
  if (state) {
    const legacy = state.window_config && state.window_end && (!state.prev || state.prev.window_end) ? [] : legacyNightStarts(w, now);
    const end = windowEndOf(w, start).toISOString();
    const overlaps = (v: NightTokensPrev) => v.window_end ? v.window_start < end && v.window_end > ws : legacy.includes(v.window_start);
    const changed = state.window_config ? state.window_config !== nightWindowConfig(w) : legacy.includes(state.window_start);
    const mergePrev = changed && state.prev && overlaps(state.prev) ? state.prev : null;
    // Keep the stored identity until the atomic writer rebases it, so markCapped can mark this very counter too.
    if (state.window_start === ws || (changed && overlaps(state))) {
      const tokens = state.tokens + (mergePrev?.tokens ?? 0);
      return { window_start: state.window_start, tokens, cap, capped: tokens >= cap, capped_at: state.capped_at, prev: mergePrev ? null : state.prev };
    }
  }
  const prev = state ? { window_start: state.window_start, tokens: state.tokens, capped_at: state.capped_at, cap: state.cap } : null;
  return { window_start: ws, tokens: 0, cap, capped: false, capped_at: null, prev };
}
