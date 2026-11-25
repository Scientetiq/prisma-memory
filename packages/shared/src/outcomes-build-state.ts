export interface BuildState { at: string; lag_sec: number; caught_up: boolean; skipped: number; rules_changed_at: string | null }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

export function buildState(lastPass: any, now = Date.now()): BuildState | null {
  if (!lastPass || typeof lastPass !== "object" || typeof lastPass.at !== "string") return null;
  let lag = Math.max(0, Math.round(num(lastPass.lag_sec)));
  const okAt = typeof lastPass.ok_at === "string" ? Date.parse(lastPass.ok_at) : NaN;
  if (typeof lastPass.error === "string" && lastPass.error && Number.isFinite(okAt)) lag = Math.max(lag, Math.round((now - okAt) / 1000));
  const failedAt = lastPass.week_failures && typeof lastPass.week_failures === "object"
    ? Object.values(lastPass.week_failures as Record<string, unknown>).map((t) => (typeof t === "string" ? Date.parse(t) : NaN)).filter(Number.isFinite)
    : [];
  if (failedAt.length) lag = Math.max(lag, Math.round((now - Math.min(...failedAt)) / 1000));
  return { at: lastPass.at, lag_sec: lag, caught_up: lastPass.caught_up === true, skipped: Math.max(0, Math.round(num(lastPass.skipped))),
           rules_changed_at: typeof lastPass.rules_changed_at === "string" ? lastPass.rules_changed_at : null };
}
