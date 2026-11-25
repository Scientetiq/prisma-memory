import { isOverloaded } from "./mcp-parse";

export const isMoving = (f: { code?: string; details?: unknown } | null | undefined): boolean =>
  f?.code === "in_progress" && !isOverloaded(f.details);

export const MOVE_WAIT = { budgetMs: 6_000, pollMs: 500 };

type Probe = () => Promise<{ ok: boolean; code?: string; details?: unknown }>;

export async function waitMoved(probe: Probe, o: { budgetMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<boolean> {
  const budget = o.budgetMs ?? MOVE_WAIT.budgetMs, poll = Math.max(0, o.pollMs ?? MOVE_WAIT.pollMs);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  if (budget <= 0) return false;
  const until = now() + budget;
  for (;;) {
    if (now() + poll > until) return false;
    await sleep(poll);
    if (now() > until) return false;
    const r = await probe();
    if (r.ok) return true;
    if (!isMoving(r)) return false;
  }
}

type ClassProbe = () => Promise<{ ok: boolean; code?: string; details?: unknown; data?: unknown }>;

export async function waitMovedClass(probe: ClassProbe, o: Parameters<typeof waitMoved>[1] = {}): Promise<"open" | "closed" | null> {
  let cls: "open" | "closed" | null = null;
  const done = await waitMoved(async () => {
    const r = await probe();
    if (r.ok) { const c = (r.data as { class?: unknown } | null | undefined)?.class; cls = c === "open" || c === "closed" ? c : null; }
    return r;
  }, o);
  return done ? cls : null;
}

export const MOVING_POLL_S = 3;
export const MOVING_TRIES = 5;
export const MOVING_REFRESH_GIVE_UP_MS = 10_000;

export interface MovingState { phase: "waiting" | "refreshing" | "manual" | "clicked"; tries: number }
export type MovingEvent = { type: "due" } | { type: "refreshed" } | { type: "click" };

export const movingStart = (): MovingState => ({ phase: "waiting", tries: 0 });

export function movingStep(s: MovingState, e: MovingEvent): MovingState {
  switch (e.type) {
    case "due": return s.phase === "waiting" ? { phase: "refreshing", tries: s.tries + 1 } : s;
    case "refreshed":
      if (s.phase === "clicked") return { ...s, phase: "manual" };
      return s.phase === "refreshing" ? { ...s, phase: s.tries < MOVING_TRIES ? "waiting" : "manual" } : s;
    case "click": return s.phase === "manual" ? { ...s, phase: "clicked" } : s;
  }
}

export const movingManual = (s: MovingState): boolean => s.phase === "manual" || s.phase === "clicked";
