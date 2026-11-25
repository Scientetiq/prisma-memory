import { createHash } from "node:crypto";

export function fingerprintOf(facts: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v instanceof Date) return v.toISOString();
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, x]) => [k, canonical(x)]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(facts))).digest("hex");
}
