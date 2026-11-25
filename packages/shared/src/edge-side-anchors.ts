import { createHash } from "node:crypto";

export const EDGE_SIDE_SERVICES = ["edge", "memory-relay"] as const;

interface Beat { fresh: boolean; detail: Record<string, unknown> }

export function edgeSideAnchorsUnconfirmed(heartbeats: Readonly<Record<string, Beat | undefined>>, applied: number | null): string[] {
  return EDGE_SIDE_SERVICES.filter((s) => {
    const h = heartbeats[s];
    const serial = h?.detail?.anchors_serial;
    return !h?.fresh || typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 1 || (applied !== null && serial < applied);
  });
}

const HEX64 = /^[0-9a-f]{64}$/;

export const ROOT_MIN_KEYS = 2;

export const ROOT_MATCH_MAX_KEYS = 12;

function fingerprintHex(f: string): string {
  const t = f.trim();
  const b64 = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(t);
  if (b64) return Buffer.from(b64[1]!, "base64").toString("hex");
  return t.toLowerCase().replace(/^sha256:/, "");
}

const rootOf = (sortedHex: readonly string[]): string => createHash("sha256").update(sortedHex.map((x) => `${x}\n`).join("")).digest("hex");

export function rootMadeOf(root: string, fingerprints: readonly string[], min: number = ROOT_MIN_KEYS): boolean {
  const target = typeof root === "string" ? root.trim().toLowerCase() : "";
  if (!HEX64.test(target)) return false;
  const xs = [...new Set(fingerprints.map((f) => fingerprintHex(String(f))))].filter((x) => HEX64.test(x)).sort();
  const need = Math.max(1, Math.floor(min));
  if (xs.length < need) return false;
  if (xs.length > ROOT_MATCH_MAX_KEYS) return rootOf(xs) === target;
  for (let mask = 1; mask < 1 << xs.length; mask++) {
    const sub = xs.filter((_, i) => (mask >> i) & 1);
    if (sub.length >= need && rootOf(sub) === target) return true;
  }
  return false;
}
