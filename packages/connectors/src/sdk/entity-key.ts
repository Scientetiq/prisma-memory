// Keys of external entities. The canonical key of an entity of an external system is
// `ext:<system>:<kind>:<id>`. The entity id is the UUIDv5 of the canonical key (`entityId` of
// packages/shared/src/ids.ts).
//
// The same key grammar as `parseEntityKey` and `encodeExternalId` of packages/shared/src/ids.ts, kept as a copy;
// unit tests pin the same vectors for both copies.
// This file imports nothing: it stays usable by connector authors.
import { ENTITY_KINDS, type EntityKind } from "./types.ts";

/** System code of an external system: the pattern of the connectors contract. */
export const SYSTEM_CODE = /^[a-z][a-z0-9_]{1,31}$/;

/** Codes that are never an external system: they have native key forms (`person:`, `project:`) or are the key prefix. */
export const RESERVED_SYSTEMS: readonly string[] = ["people", "memory", "person", "project", "ext"];

/** Characters an `ext:` id carries as they are. */
const PLAIN_ID = /^[A-Za-z0-9._@-]{1,128}$/;
/** Prefix of an encoded id. A raw id that starts with it is encoded too, so the two forms never collide. */
export const ENCODED_ID_PREFIX = "b64.";
/**
 * The longest stored id, the `b64.` prefix included: the id part of the entity key grammar (`[A-Za-z0-9._@-]{1,128}`). An
 * encoded id therefore carries at most 93 UTF-8 bytes of the raw id (4 + ceil(4 × 93 / 3) = 128).
 */
export const STORED_ID_MAX = 128;
const ENCODED_ID = /^b64\.[A-Za-z0-9_-]{1,124}$/;
/** Raw ids as the contract carries them: 1–128 characters, no control, line-separator or direction characters. */
const RAW_ID_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Half of a surrogate pair without the other half: it has no UTF-8 form, so it could not round-trip. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The shape of `EntityKey` in packages/shared/src/ids.ts. */
export interface ExternalEntityKey {
  key: string;
  kind: EntityKind;
  externalSystem: string;
  externalId: string;
}

export type EntityKeyCode = "entity_system_invalid" | "entity_system_reserved" | "entity_kind_invalid" | "entity_id_invalid";

export type EntityKeyResult = { ok: true; key: ExternalEntityKey } | { ok: false; code: EntityKeyCode };

const charLength = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/** True when the raw id is one the contract allows: 1–128 characters, none of them a control character. */
export function isRawExternalId(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const n = charLength(raw);
  return n >= 1 && n <= 128 && !RAW_ID_FORBIDDEN.test(raw) && !LONE_SURROGATE.test(raw);
}

/**
 * The id as the `ext:` form stores it: unchanged when it uses only `A–Z a–z 0–9 . _ @ -`, otherwise `b64.` and the
 * base64url of its UTF-8 bytes. Null for an id the contract refuses (empty, longer than 128 characters, a control
 * character, a lone surrogate) and for an id whose encoded form is longer than 128 characters (more than 93 UTF-8
 * bytes): the key grammar could not carry it. The shared `encodeExternalId` throws a RangeError in these cases; a wrapper
 * over it catches that and returns null.
 */
export function encodeExternalId(raw: string): string | null {
  if (!isRawExternalId(raw)) return null;
  if (PLAIN_ID.test(raw) && !raw.startsWith(ENCODED_ID_PREFIX)) return raw;
  const out = ENCODED_ID_PREFIX + Buffer.from(raw, "utf8").toString("base64url");
  return out.length <= STORED_ID_MAX ? out : null;
}

/** The raw id back from its stored form; null when the stored form is neither plain nor a valid encoding. */
export function decodeExternalId(stored: string): string | null {
  if (ENCODED_ID.test(stored)) {
    const raw = Buffer.from(stored.slice(ENCODED_ID_PREFIX.length), "base64url").toString("utf8");
    return encodeExternalId(raw) === stored ? raw : null;
  }
  return PLAIN_ID.test(stored) && !stored.startsWith(ENCODED_ID_PREFIX) ? stored : null;
}

const isKind = (k: unknown): k is EntityKind => typeof k === "string" && (ENTITY_KINDS as readonly string[]).includes(k);

/**
 * The canonical key of an entity of an external system from the connector's system code, the entity kind and the raw
 * id of the source. Reserved codes, the kinds `person` and `project` and ids outside the contract are refused with a
 * code.
 */
export function externalEntityKey(system: string, kind: string, rawId: string): EntityKeyResult {
  if (typeof system !== "string" || !SYSTEM_CODE.test(system)) return { ok: false, code: "entity_system_invalid" };
  if (RESERVED_SYSTEMS.includes(system)) return { ok: false, code: "entity_system_reserved" };
  if (!isKind(kind)) return { ok: false, code: "entity_kind_invalid" };
  const id = encodeExternalId(rawId);
  if (id === null) return { ok: false, code: "entity_id_invalid" };
  return { ok: true, key: { key: `ext:${system}:${kind}:${id}`, kind, externalSystem: system, externalId: id } };
}

/**
 * Parses a key of an external entity: `ext:<system>:<kind>:<id>`. Null for anything else — people and projects have
 * their own parser in ids.ts.
 */
export function parseExternalEntityKey(raw: string): ExternalEntityKey | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  const m = /^ext:([a-z][a-z0-9_]{1,31}):([a-z]+):(.+)$/.exec(key);
  if (m) {
    const [, system, kind, id] = m as unknown as [string, string, string, string];
    if (RESERVED_SYSTEMS.includes(system) || !isKind(kind)) return null;
    if (decodeExternalId(id) === null) return null;
    return { key, kind, externalSystem: system, externalId: id };
  }
  return null;
}
