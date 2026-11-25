export interface OutcomesSettings {
  enabled: boolean;
  read_window_min: number;
  reformulate_window_sec: number;
  session_gap_min: number;
  min_group: number;
}

export const OUTCOMES_DEFAULTS: Readonly<OutcomesSettings> = Object.freeze({
  enabled: true, read_window_min: 10, reformulate_window_sec: 120, session_gap_min: 30, min_group: 5,
});

export const OUTCOMES_LIMITS = Object.freeze({
  read_window_min: [1, 60], reformulate_window_sec: [10, 600], session_gap_min: [5, 240], min_group: [2, 50],
} as const satisfies Record<Exclude<keyof OutcomesSettings, "enabled">, readonly [number, number]>);

const clampInt = (v: unknown, [min, max]: readonly [number, number], dflt: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
};

export function outcomesSettings(raw: unknown): OutcomesSettings {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : OUTCOMES_DEFAULTS.enabled,
    read_window_min: clampInt(o.read_window_min, OUTCOMES_LIMITS.read_window_min, OUTCOMES_DEFAULTS.read_window_min),
    reformulate_window_sec: clampInt(o.reformulate_window_sec, OUTCOMES_LIMITS.reformulate_window_sec, OUTCOMES_DEFAULTS.reformulate_window_sec),
    session_gap_min: clampInt(o.session_gap_min, OUTCOMES_LIMITS.session_gap_min, OUTCOMES_DEFAULTS.session_gap_min),
    min_group: clampInt(o.min_group, OUTCOMES_LIMITS.min_group, OUTCOMES_DEFAULTS.min_group),
  };
}

export const settleMin = (s: Pick<OutcomesSettings, "read_window_min" | "reformulate_window_sec">): number =>
  s.read_window_min + Math.ceil(s.reformulate_window_sec / 60) + 3;

export const contextMin = (s: Pick<OutcomesSettings, "read_window_min" | "reformulate_window_sec">): number =>
  Math.max(s.read_window_min, Math.ceil(s.reformulate_window_sec / 60)) + 3;

export const outcomesWindows = (s: OutcomesSettings): { read_window_min: number; reformulate_window_sec: number; session_gap_min: number } =>
  ({ read_window_min: s.read_window_min, reformulate_window_sec: s.reformulate_window_sec, session_gap_min: s.session_gap_min });
