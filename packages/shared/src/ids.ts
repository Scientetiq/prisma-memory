import { entityKeyParts } from "@memory/mcp-core";
import { v5 as uuidv5, v7 as uuidv7, validate } from "uuid";

export { entityRefOf, EXT_KINDS, type EntityRow } from "@memory/mcp-core";

export const MEMORY_NAMESPACE = uuidv5("memory.corporate", uuidv5.DNS);

export const newId = (): string => uuidv7();
export const isUuid = (s: unknown): s is string => typeof s === "string" && validate(s);

export const personId = (login: string): string => uuidv5(`person:${login.trim().toLowerCase()}`, MEMORY_NAMESPACE);
export const orgUnitId = (instance: string, code: string): string => uuidv5(`org_unit:${instance}:${code}`, MEMORY_NAMESPACE);

export type EntityKind = "person" | "company" | "deal" | "contact" | "task" | "project" | "document" | "other";

export interface EntityKey { key: string; kind: EntityKind; externalSystem: string; externalId: string }

/**
 * Entity keys of calls: `person:<login>`, `project:<slug>` and `ext:<system>:<kind>:<id>`; anything else is null
 * (invalid_argument). One grammar for the
 * gateway and the edge: `entityKeyParts` of @memory/mcp-core.
 */
export function parseEntityKey(raw: string): EntityKey | null {
  const p = entityKeyParts(raw);
  return p ? { key: p.key, kind: p.kind as EntityKind, externalSystem: p.system, externalId: p.id } : null;
}

const EXTERNAL_ID = /^[A-Za-z0-9._@-]{1,128}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * The id part of an `ext:` key for a raw id of an external system: an id of the key alphabet is kept as is (ids are
 * case-sensitive); any other id — and one that itself starts with `b64.` — becomes `b64.` + base64url of its UTF-8 bytes
 * without padding. Injective. Empty input, a string with a lone surrogate or a result longer than 128 chars → RangeError.
 */
export function encodeExternalId(raw: string): string {
  if (typeof raw !== "string" || raw === "") throw new RangeError("external id is empty");
  if (EXTERNAL_ID.test(raw) && !raw.startsWith("b64.")) return raw;
  if (LONE_SURROGATE.test(raw)) throw new RangeError("external id is not well-formed UTF-16");
  const out = `b64.${Buffer.from(raw, "utf8").toString("base64url")}`;
  if (out.length > 128) throw new RangeError("external id is too long for an entity key (more than 128 chars encoded)");
  return out;
}

export const entityId = (e: EntityKey): string => (e.kind === "person" ? personId(e.externalId) : uuidv5(e.key, MEMORY_NAMESPACE));

export const RECORD_TYPES = ["document", "transcript", "event", "summary", "profile", "note"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export function recordPath(slug: string, type: string, occurredAt: Date | string, id: string): string {
  const d = new Date(occurredAt);
  return `/spaces/${slug}/${type}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
}

export type ParsedPath =
  | { kind: "root" }
  | { kind: "spaces" }
  | { kind: "space"; slug: string; type?: string; year?: number; month?: number }
  | { kind: "record"; slug: string; type: string; id: string }
  | { kind: "entity"; key: string }
  | { kind: "person"; login: string; part?: "meetings" }
  | { kind: "folder"; name: "entities" | "people" };

export const PERSON_MEETINGS = "meetings";

export function parsePath(raw: string): ParsedPath | null {
  const parts = raw.trim().replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "root" };
  const [head, ...rest] = parts;
  if (head === "spaces") {
    if (rest.length === 0) return { kind: "spaces" };
    const [slug, type, year, month, id] = rest;
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug!)) return null;
    if (type !== undefined && !(RECORD_TYPES as readonly string[]).includes(type)) return null;
    if (id !== undefined) return rest.length === 5 && isUuid(id) ? { kind: "record", slug: slug!, type: type!, id } : null;
    if (year !== undefined && !/^\d{4}$/.test(year)) return null;
    if (month !== undefined && !/^(0[1-9]|1[0-2])$/.test(month)) return null;
    return { kind: "space", slug: slug!, type, year: year ? Number(year) : undefined, month: month ? Number(month) : undefined };
  }
  if (head === "entities") return rest.length === 0 ? { kind: "folder", name: "entities" } : { kind: "entity", key: rest.join("/") };
  if (head === "people") {
    if (rest.length === 0) return { kind: "folder", name: "people" };
    if (rest.length === 1) return { kind: "person", login: rest[0]!.toLowerCase() };
    return rest.length === 2 && rest[1] === PERSON_MEETINGS ? { kind: "person", login: rest[0]!.toLowerCase(), part: PERSON_MEETINGS } : null;
  }
  return null;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const _ of text) n++;
  return Math.max(1, Math.ceil(n / 4));
}

export function slugify(name: string, fallback = "space"): string {
  const map: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  const s = [...name.toLowerCase()].map((ch) => map[ch] ?? ch).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s.length >= 2 ? s : fallback;
}
