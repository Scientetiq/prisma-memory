export type MemoryRoot = "spaces" | "entities" | "people" | "me" | "org";

export const MEMORY_LINK_FALLBACK = "/browse";

const MAX_PATH = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function segment(raw: string): string | null {
  let seg: string;
  try {
    seg = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!seg || seg === "." || seg === ".." || /[\s/\\]/.test(seg) || /[\u0000-\u001f\u007f]/.test(seg)) return null;
  return seg;
}

export function memoryLinkTarget(root: MemoryRoot, segments: readonly string[] | undefined): string {
  const segs: string[] = [];
  for (const raw of segments ?? []) {
    if (raw.length > MAX_PATH) return MEMORY_LINK_FALLBACK;
    const seg = segment(raw);
    if (seg === null) return MEMORY_LINK_FALLBACK;
    segs.push(seg);
  }
  const path = `/${[root, ...segs].join("/")}`;
  if (path.length > MAX_PATH) return MEMORY_LINK_FALLBACK;
  const last = segs.at(-1);
  if (last && segs.length >= 2 && UUID.test(last)) return `/records/${last.toLowerCase()}`;
  return `${MEMORY_LINK_FALLBACK}?path=${encodeURIComponent(path)}`;
}

export function backHref(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_PATH || !raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}
