export interface OnceSecret { label: string; value: string; warning: string }

export interface ActionResult {
  ok: boolean;
  message: string;
  lines?: string[];
  fieldErrors?: Record<string, string>;
  steps?: Array<{ status: "ok" | "fail" | "warn" | "skip"; title: string; message: string }>;
  secret?: OnceSecret;
  keyId?: string;
  keyLabel?: string | null;
  clientKind?: string;
  record?: { id: string; path: string; class?: string | null };
  link?: { href: string; label: string };
  ask?: string;
  undo?: { label: string; fields: Record<string, string> };
  askValue?: string;
  askLabel?: string;
  askKeep?: Record<string, string>;
  /** Workplace sign-in forms only: a path of this site, already checked by safeNext, that the form opens by a full document
   *  load after a successful sign-in, so that the next page is served with its own response headers. */
  fullLoadTo?: string;
  at: number;
}
export type ActionState = ActionResult | null;

export const okState = (message: string, extra: Partial<Omit<ActionResult, "ok" | "message" | "at">> = {}): ActionResult =>
  ({ ok: true, message, ...extra, at: Date.now() });

export const failState = (message: string, extra: Partial<Omit<ActionResult, "ok" | "message" | "at">> = {}): ActionResult =>
  ({ ok: false, message, ...extra, at: Date.now() });
