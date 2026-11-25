// Entity keys of tool calls — one grammar for the gateway and the edge.
//   person:<login>                 a person of the instance (login with "@", case-insensitive);
//   project:<slug>                 a project of this memory;
//   ext:<system>:<kind>:<id>       an object of an external system (CRM, tracker, document store).
// Pure functions, no dependencies: the edge builds this package. All patterns are linear (no nested quantifiers).

/**
 * Kinds an external system may name; `person` and `project` have native forms of their own. This list and the reserved
 * systems below are frozen: another module of the process cannot change the grammar through them.
 */
export const EXT_KINDS = Object.freeze(["company", "deal", "contact", "task", "document", "other"] as const);
export type ExtKind = (typeof EXT_KINDS)[number];

/** System names refused in the `ext:` form: they would mint a second id beside a native form. */
export const RESERVED_EXT_SYSTEMS = Object.freeze(["people", "memory", "person", "project", "ext"] as const);

/** Parsed key: canonical string, kind, system (`people` for a person, `memory` for a project) and id within the system. */
export interface EntityKeyParts { key: string; kind: string; system: string; id: string }

const PERSON_PREFIX = /^person:/i;
// `.` of the former pattern `^person:(.+@.+)$`: any code unit except line terminators
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const PROJECT = /^project:([a-z0-9][a-z0-9-]{1,62})$/;
const EXT = /^ext:([a-z][a-z0-9_]{1,31}):(company|deal|contact|task|document|other):([A-Za-z0-9._@-]{1,128})$/;

/**
 * Parses an entity key of a call; anything else is null (the caller answers invalid_argument or not_found).
 * Order: person, project, `ext:`. No case folding and no Unicode normalisation except the person
 * login, which is lower-cased as before.
 */
export function entityKeyParts(raw: string): EntityKeyParts | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  // person: the same set as `^person:(.+@.+)$`/i, checked without backtracking
  if (PERSON_PREFIX.test(key)) {
    const login = key.slice("person:".length);
    const at = login.indexOf("@", 1);
    if (LINE_TERMINATOR.test(login) || at < 0 || at > login.length - 2) return null;
    const lower = login.toLowerCase();
    return { key: `person:${lower}`, kind: "person", system: "people", id: lower };
  }
  let m = PROJECT.exec(key);
  if (m) return { key, kind: "project", system: "memory", id: m[1]! };
  m = EXT.exec(key);
  if (!m) return null;
  const [, system, kind, id] = m as unknown as [string, string, string, string];
  if ((RESERVED_EXT_SYSTEMS as readonly string[]).includes(system)) return null;
  return { key: `ext:${system}:${kind}:${id}`, kind, system, id };
}

/** A row of the entity registry as the database stores it. */
export interface EntityRow { kind: string; external_system: string | null; external_id: string | null }

/**
 * The key of a registry row in the form calls accept: `person:<login>`,
 * `<kind>:<id>` for entities of this memory (`project:<slug>`), `ext:<system>:<kind>:<id>` for any other system.
 * Total: never throws, also on empty fields.
 */
export function entityRefOf(e: EntityRow): string {
  const id = e.external_id ?? "", system = e.external_system ?? "";
  if (e.kind === "person") return `person:${id}`;
  if (system === "" || system === "memory" || system === "people") return `${e.kind}:${id}`;
  return `ext:${system}:${e.kind}:${id}`;
}
