export const DRAFT_PREFIX = "memory-draft:";
const MAX_CHARS = 30_000;

export interface DraftStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface DraftField { name: string; type?: string; value: string; tagName?: string }

const SKIP_TYPES = new Set(["hidden", "password", "file", "checkbox", "radio", "submit", "button", "reset", "image"]);
export const draftable = (f: Pick<DraftField, "name" | "type">): boolean => Boolean(f.name) && !SKIP_TYPES.has((f.type ?? "").toLowerCase());

export const draftKey = (id: string): string => `${DRAFT_PREFIX}${id}`;

export function collectDraft(fields: Iterable<DraftField>): Record<string, string> | null {
  const out: Record<string, string> = Object.create(null);
  for (const f of fields) if (draftable(f) && f.value !== "") out[f.name] = f.value;
  return Object.keys(out).length ? out : null;
}

export function readDraft(store: DraftStore | null, id: string): Record<string, string> | null {
  try {
    const raw = store?.getItem(draftKey(id));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, string> = Object.create(null);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

export function writeDraft(store: DraftStore | null, id: string, data: Record<string, string> | null): void {
  try {
    if (!store) return;
    const raw = data ? JSON.stringify(data) : "";
    if (!raw || raw.length > MAX_CHARS) store.removeItem(draftKey(id));
    else store.setItem(draftKey(id), raw);
  } catch { }
}

export const clearDraft = (store: DraftStore | null, id: string): void => writeDraft(store, id, null);

export function applyDraft(fields: Iterable<DraftField>, data: Record<string, string> | null): number {
  if (!data) return 0;
  let n = 0;
  for (const f of fields) {
    if (!draftable(f) || !Object.hasOwn(data, f.name)) continue;
    if (f.value !== "" && (f.tagName ?? "").toUpperCase() !== "SELECT") continue;
    f.value = data[f.name]!;
    n++;
  }
  return n;
}

export function sessionStore(): DraftStore | null {
  try { return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null; } catch { return null; }
}
