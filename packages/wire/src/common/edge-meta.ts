// Settings the edge receives from inside (edge_meta.settings, contracts/edge/edge-meta.schema.json) and their clamp to
// the anchor bounds (anchors edge_bounds): the edge replaces a value out of bounds with the bound and raises the
// event meta_out_of_bounds; a missing key gets its default. The keys and their defaults match the rows of
// contracts/schema/04-seed.sql, kept so by a unit test. Leaf: no input or output.

/**
 * Edge database schema version this code understands (edge_meta.schema_version): 1 — e01; 2 — e01, quota
 * code of edge-mcp (one version for edge code 1e and 1d); 3 — e01, second-factor steps in login.tx (e02);
 * 4 — e01, edge liveness signal: request kind ping = 7 in login.checks (e02).
 */
export const EDGE_SCHEMA_VERSION = 4;

/** A bound: numbers — [min, max], an enumeration — the allowed values (the first is the strictest). */
export type EdgeBound = readonly [number, number] | readonly string[];
export type EdgeBounds = Readonly<Record<string, EdgeBound>>;

/** Defaults of the keys (as in the seed): the edge lives on them until the exporter has sent settings. */
export const EDGE_META_DEFAULTS: Readonly<Record<string, number | string>> = {
  deadman_theta_sec: 120,
  originals_max_mib: 20,
  max_concurrent_per_connection: 4,
  connection_expiry_warn_days: 3,
  original_link_ttl_sec: 600,
};

/** Own key limits when the anchors hold no bound: the same bound as theta in the edge database (edge_theta_sec). */
export const EDGE_META_FALLBACK_BOUNDS: EdgeBounds = {
  deadman_theta_sec: [60, 600],
  originals_max_mib: [1, 20],
  max_concurrent_per_connection: [1, 8],
  connection_expiry_warn_days: [1, 14],
  original_link_ttl_sec: [60, 900],
};

export interface OutOfBounds { key: string; bound: EdgeBound; reason: "below" | "above" | "not_integer" | "not_allowed" }
export interface ClampedMeta { settings: Record<string, unknown>; outOfBounds: OutOfBounds[] }

const isIntBound = (b: EdgeBound): b is readonly [number, number] => b.length === 2 && typeof b[0] === "number" && typeof b[1] === "number";

/** One value within a bound: [value, reason of the replacement or null]. */
export function clampValue(value: unknown, bound: EdgeBound): [unknown, OutOfBounds["reason"] | null] {
  if (isIntBound(bound)) {
    const [lo, hi] = bound;
    if (typeof value !== "number" || !Number.isInteger(value)) return [lo, "not_integer"];
    if (value < lo) return [lo, "below"];
    if (value > hi) return [hi, "above"];
    return [value, null];
  }
  const allowed = bound as readonly string[];
  if (typeof value === "string" && allowed.includes(value)) return [value, null];
  return [allowed[0] ?? null, "not_allowed"];
}

/**
 * Edge settings from the sent values and the anchor bounds. A key with a bound: no value — the default (in bound);
 * out of bound — the bound and an entry in outOfBounds (the edge raises meta_out_of_bounds, value not logged). Keys
 * without a bound pass as they are. An anchor bound wins over the own limit.
 */
export function clampEdgeMeta(settings: Readonly<Record<string, unknown>> | null | undefined, anchorBounds: EdgeBounds = {}): ClampedMeta {
  const src = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const out: Record<string, unknown> = { ...src };
  const outOfBounds: OutOfBounds[] = [];
  const keys = new Set([...Object.keys(EDGE_META_DEFAULTS), ...Object.keys(anchorBounds)]);
  for (const key of keys) {
    const bound = anchorBounds[key] ?? EDGE_META_FALLBACK_BOUNDS[key];
    const has = Object.hasOwn(src, key) && src[key] !== null && src[key] !== undefined;
    if (!has) {
      if (key in EDGE_META_DEFAULTS) out[key] = bound ? clampValue(EDGE_META_DEFAULTS[key], bound)[0] : EDGE_META_DEFAULTS[key];
      continue;
    }
    if (!bound) continue;
    const [v, reason] = clampValue(src[key], bound);
    out[key] = v;
    if (reason) outOfBounds.push({ key, bound, reason });
  }
  return { settings: out, outOfBounds };
}
