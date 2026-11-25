import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_DIR } from "./contracts.ts";
import type { PolicyClass } from "./admin-plane-types.ts";

export type SettingAuditMode = "value" | "fingerprint" | "keys_only";

export interface PolicyKey {
  class: PolicyClass;
  weaken: string | null;
  audit: SettingAuditMode;
  where?: "inside" | "edge" | "both";
  default_off?: boolean;
  off_value?: unknown;
  always?: boolean;
  "x-stage"?: string;
}
export interface PolicyAction { second_signature: boolean; always?: boolean; "x-stage"?: string }
export interface SettingsPolicy {
  format: "memory-settings-policy/1";
  keys: Readonly<Record<string, PolicyKey>>;
  actions: Readonly<Record<string, PolicyAction>>;
  sha256: string;
}

export const SETTINGS_POLICY_FILE = join(CONTRACTS_DIR, "edge", "settings-policy.json");
const CLASSES: ReadonlySet<string> = new Set(["operational", "policy", "anchored", "immutable"]);
const AUDIT: ReadonlySet<string> = new Set(["value", "fingerprint", "keys_only"]);

export function parseSettingsPolicy(bytes: Buffer | string): SettingsPolicy {
  const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const doc = JSON.parse(raw.toString("utf8")) as { format?: unknown; keys?: unknown; actions?: unknown };
  if (doc.format !== "memory-settings-policy/1" || !doc.keys || typeof doc.keys !== "object") throw new Error("settings-policy.json: expected memory-settings-policy/1");
  const keys: Record<string, PolicyKey> = {};
  for (const [path, v] of Object.entries(doc.keys as Record<string, PolicyKey>)) {
    if (path.startsWith("$")) continue;
    if (!v || !CLASSES.has(v.class) || !AUDIT.has(v.audit) || !(v.weaken === null || typeof v.weaken === "string"))
      throw new Error(`settings-policy.json: key ${path} has an invalid class, weaken or audit value`);
    keys[path] = v;
  }
  const actions: Record<string, PolicyAction> = {};
  for (const [name, v] of Object.entries((doc.actions ?? {}) as Record<string, PolicyAction>)) if (!name.startsWith("$")) actions[name] = v;
  return { format: "memory-settings-policy/1", keys, actions, sha256: createHash("sha256").update(raw).digest("hex") };
}

let cache: SettingsPolicy | null = null;
let override: SettingsPolicy | null = null;

export function settingsPolicy(): SettingsPolicy {
  if (override) return override;
  if (!cache) cache = parseSettingsPolicy(readFileSync(SETTINGS_POLICY_FILE));
  return cache;
}

export function setSettingsPolicyForTests(p: SettingsPolicy | null): void {
  override = p;
}

export function policyOf(path: string): PolicyKey | null {
  return settingsPolicy().keys[path] ?? null;
}

export function anchoredKeys(p: SettingsPolicy = settingsPolicy()): string[] {
  return Object.entries(p.keys).filter(([, v]) => v.class === "anchored").map(([k]) => k).sort();
}

export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export function enumOrder(rule: string): string[] | null {
  const m = /^enum_order:\[([^\]]*)\]$/.exec(rule);
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : null;
}

export function isWeakening(rule: string | null, before: unknown, after: unknown): boolean {
  if (rule === null || same(before, after)) return false;
  switch (rule) {
    case "any": return true;
    case "bool_true_to_false": return before === true && after !== true;
    case "bool_false_to_true": return before !== true && after === true;
    case "num_increase": return typeof before === "number" && typeof after === "number" ? after > before : true;
    case "num_decrease": return typeof before === "number" && typeof after === "number" ? after < before : true;
    case "list_add":
    case "list_remove": {
      if (!Array.isArray(before) || !Array.isArray(after)) return true;
      const from = new Set((rule === "list_add" ? before : after).map(canonicalJson));
      return (rule === "list_add" ? after : before).some((x) => !from.has(canonicalJson(x)));
    }
    default: {
      const order = enumOrder(rule);
      if (!order) return true;
      const i = order.indexOf(String(before)), j = order.indexOf(String(after));
      return i < 0 || j < 0 ? true : j < i;
    }
  }
}

const derived = new Map<string, Buffer>();
export function derivedKey(appSecret: string, info: string): Buffer {
  const id = `${info}\u0000${createHash("sha256").update(appSecret).digest("hex")}`;
  let k = derived.get(id);
  if (!k) { k = Buffer.from(hkdfSync("sha256", appSecret, "", info, 32)); derived.set(id, k); }
  return k;
}

export function settingFingerprint(appSecret: string, value: unknown): string {
  return createHmac("sha256", derivedKey(appSecret, "memory-settings-audit")).update(canonicalJson(value)).digest("hex").slice(0, 16);
}

export function pinHmac(appSecret: string, path: string, value: unknown): string {
  return createHmac("sha256", derivedKey(appSecret, "memory-anchors-pin")).update(`${path}\n${canonicalJson(value)}`).digest("hex");
}

export function pinMatches(appSecret: string, path: string, value: unknown, hmacHex: string): boolean {
  const want = Buffer.from(pinHmac(appSecret, path, value), "hex");
  const got = /^[0-9a-f]{64}$/.test(hmacHex) ? Buffer.from(hmacHex, "hex") : Buffer.alloc(32);
  return timingSafeEqual(want, got) && /^[0-9a-f]{64}$/.test(hmacHex);
}

export function pinKindFor(path: string, secret: boolean, p: SettingsPolicy = settingsPolicy()): "value" | "hmac" {
  return secret || p.keys[path]?.audit === "fingerprint" ? "hmac" : "value";
}

export const PIN_FAIL_CLOSED: Readonly<Record<string, string>> = {
  "open_check.nda_customers": "open_check.extra_rules",
  "open_check.extra_rules": "open_check.extra_rules",
};
export const OPEN_CHECK_PIN_BROKEN_RULE = Object.freeze({
  name: "anchors_pin_broken", kind: "custom", pattern: "[\\s\\S]",
  reason: "open check is unavailable: the NDA customer list or custom rules do not match the trust anchors. Save the record to a closed space",
});
export const pinFailClosedValue = (target: string): unknown => (target === "open_check.extra_rules" ? [{ ...OPEN_CHECK_PIN_BROKEN_RULE }] : null);
