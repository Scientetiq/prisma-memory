// Items: validation against the contract, the canonical form and its hash, and the sanitiser.
//
// Identity and idempotency (contract `connectors` 1.0.0): `(connector, type, external_id)` is the item key; the content
// hash is SHA-256 of the canonical JSON of the item without transport fields. The canonical JSON has sorted keys, strings
// in Unicode NFC and numbers in the shortest form (-0 is 0); file bytes enter by their SHA-256, so the same file sent as
// base64 through a webhook and as bytes by a pull connector has one hash.
//
// The sanitiser is for items that a pull connector builds from vendor data: one-line fields lose control, line-break
// and direction characters and are capped by length (an optional one that is or becomes empty is dropped, references
// the contract would refuse are dropped); bodies lose NUL; lone surrogates become U+FFFD everywhere; strings
// are written in NFC. Fields that identify an item are never changed — an item whose id would need a change is refused,
// and so is a body over the contract's length (bodies are never cut).
import { createHash } from "node:crypto";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { ajvProblems, contractSchema } from "./contract.ts";
import { ENTITY_KINDS, ITEM_TYPES, type Item, type Problem } from "./types.ts";

/** Characters the contract refuses in one-line fields (`not: {pattern: CTL}` of the schemas). */
const CTL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Direction overrides and isolates: removed, not replaced by a space. */
const DIRECTION = /[\u202a-\u202e\u2066-\u2069]/g;
const CTL_ALL = new RegExp(CTL.source, "g");
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Transport fields: not part of the content hash. A new source revision with the same content is `unchanged`. */
export const TRANSPORT_FIELDS = ["external_version"] as const;

/** Decoded file bytes the contract allows in `content_base64`. */
export const MAX_FILE_BYTES = 33_554_432;

const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const URL_FORM = /^https?:\/\/[A-Za-z0-9.\-[\]:]+([/?#][!-~]*)?$/;
const EMAIL = /^[^@ ]+@[^@ ]+$/;
const SYSTEM = /^[a-z][a-z0-9_]{1,31}$/;
const RESERVED_SYSTEMS = new Set(["people", "memory", "person", "project", "ext"]);
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ATTR_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED_ATTRS = new Set(["aliases", "source", "source_deleted_at"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const problem = (code: string, path: string, message: string): Problem => ({ code, path, message });

// ---------------------------------------------------------------- canonical form

function enc(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("canonical JSON: a number must be finite");
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case "string":
      return JSON.stringify(v.normalize("NFC"));
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : enc(x))).join(",")}]`;
      if (ArrayBuffer.isView(v)) throw new TypeError("canonical JSON: bytes have no JSON form (canonicalItem hashes them)");
      const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
      const named = keys.map((k) => [k.normalize("NFC"), k] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (let i = 1; i < named.length; i++) {
        if (named[i]![0] === named[i - 1]![0]) throw new TypeError("canonical JSON: two keys with one NFC form");
      }
      return `{${named.map(([n, k]) => `${JSON.stringify(n)}:${enc((v as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON: a ${typeof v} has no JSON form`);
  }
}

/** Canonical JSON text: sorted keys, NFC strings, shortest numbers, no whitespace. Throws on values JSON cannot carry. */
export function canonicalJson(value: unknown): string {
  return enc(value);
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The item as hashed: without transport fields; file bytes replaced by `content_sha256`. */
export function canonicalItem(item: Item): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(item as unknown as Record<string, unknown>) };
  for (const f of TRANSPORT_FIELDS) delete out[f];
  if (out.type === "document") {
    if (isBytes(out.content)) {
      out.content_sha256 = sha256(out.content);
      delete out.content;
    } else if (typeof out.content_base64 === "string") {
      out.content_sha256 = sha256(Buffer.from(out.content_base64, "base64"));
      delete out.content_base64;
    }
  }
  return out;
}

/** SHA-256 (hex) of the canonical item: equal hashes at one item key mean `unchanged`. */
export function itemHash(item: Item): string {
  return sha256(canonicalJson(canonicalItem(item)));
}

// ---------------------------------------------------------------- validation against the contract

const validators = new Map<string, ValidateFunction>();
function validatorFor(type: string): ValidateFunction {
  let v = validators.get(type);
  if (!v) {
    v = contractSchema(type);
    validators.set(type, v);
  }
  return v;
}

/** Code of one base64 alphabet character: A–Z, a–z, 0–9, + and /. */
const isB64Char = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;

/**
 * Standard padded base64 as a strict decoder reads it: a length that is a multiple of four, the alphabet only, and `=`
 * only as the last one or two characters. A loop over character codes, not a regular expression: a body of tens of
 * megabytes must not overflow the stack of the regular expression engine.
 */
export function isStrictBase64(s: string): boolean {
  const n = s.length;
  if (n === 0 || n % 4 !== 0) return false;
  const pad = s.charCodeAt(n - 1) === 61 ? (s.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
  for (let i = 0; i < n - pad; i++) if (!isB64Char(s.charCodeAt(i))) return false;
  return true;
}

const decodedLength = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/**
 * Problems of an item against the contract schema of its type (at most 5), plus the SDK rules of file bodies: base64
 * that a strict decoder reads, and at most `maxBytes` (default 32 MiB) of file bytes. A document may carry its bytes as
 * `content` (SDK-internal) instead of `content_base64`.
 */
export function validateItem(item: unknown, opts: { maxBytes?: number } = {}): Problem[] {
  if (!isObject(item)) return [problem("item_invalid:type", "", "an item is an object")];
  const type = item.type;
  if (typeof type !== "string" || !([...ITEM_TYPES, "delete"] as string[]).includes(type))
    return [problem("item_invalid:type", "/type", `/type must be one of ${[...ITEM_TYPES, "delete"].join(", ")}`)];
  const maxBytes = Math.min(opts.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
  const out: Problem[] = [];
  let wire: Record<string, unknown> = item;
  if (type === "document" && item.content !== undefined) {
    if (!isBytes(item.content)) return [problem("item_invalid:type", "/content", "/content must be bytes")];
    if (item.text !== undefined || item.content_base64 !== undefined)
      return [problem("item_invalid:oneof", "", "a document has exactly one body: text, content_base64 or content")];
    if (item.content.byteLength === 0) out.push(problem("item_invalid:minlength", "/content", "/content is empty"));
    if (item.content.byteLength > maxBytes) out.push(problem("too_large", "/content", `/content is larger than ${maxBytes} bytes`));
    wire = { ...item, content_base64: "AAAA" };
    delete wire.content;
  } else if (type === "document" && typeof item.content_base64 === "string") {
    const b64 = item.content_base64;
    if (!isStrictBase64(b64))
      out.push(problem("invalid_base64", "/content_base64", "/content_base64 is not standard padded base64"));
    else if (decodedLength(b64) > maxBytes) out.push(problem("too_large", "/content_base64", `/content_base64 decodes to more than ${maxBytes} bytes`));
  }
  if (type === "meeting" && Array.isArray(item.participants)) {
    // SDK rule beyond the contract: a calendar invitation is not presence. Under the `attended_emails` policy an
    // attended participant with an e-mail gets access to the meeting record, so an invitee is never attended.
    item.participants.forEach((p: unknown, i: number) => {
      if (isObject(p) && p.role === "invitee" && p.attended === true)
        out.push(problem("item_invalid:invitee_attended", `/participants/${i}`, `/participants/${i} is an invitee and cannot be attended`));
    });
  }
  const v = validatorFor(type);
  if (!v(wire)) out.push(...ajvProblems(v.errors, "item_invalid", 5));
  return out.slice(0, 5);
}

// ---------------------------------------------------------------- sanitiser

export type SanitiseResult = { ok: true; item: Item; changes: string[] } | { ok: false; problems: Problem[] };

/** Cut to at most `max` UTF-16 units on a code point boundary (JSON Schema counts code points: this is never longer). */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, "\ufffd");

/** A one-line field: NFC, no control or direction characters, single spaces, trimmed, capped. */
export function cleanLine(s: string, max: number): string {
  const t = wellFormed(s).normalize("NFC").replace(DIRECTION, "").replace(CTL_ALL, " ").replace(/ {2,}/g, " ").trim();
  return cap(t, max).trim();
}

/** A body: NFC, no NUL, no lone surrogates; line breaks and tabs kept. */
export function cleanBody(s: string): string {
  return wellFormed(s).replace(/\u0000/g, "").normalize("NFC");
}

/** A file name capped with its extension kept. */
function cleanFilename(s: string, max: number): string {
  const t = cleanLine(s, Number.MAX_SAFE_INTEGER);
  if (t.length <= max) return t;
  const dot = t.lastIndexOf(".");
  const ext = dot > 0 && t.length - dot <= 16 ? t.slice(dot) : "";
  return `${cap(t.slice(0, ext ? dot : t.length), max - ext.length).trim()}${ext}`;
}

/** Why an identity field cannot be used as it is; null — it can. */
function identityProblem(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0) return "is empty";
  if ([...v].length > max) return `is longer than ${max} characters`;
  if (CTL.test(v)) return "holds a control, line-break or direction character";
  if (v !== wellFormed(v)) return "holds a lone surrogate";
  if (v === "." || v === "..") return "is a dot path segment";
  return null;
}

/**
 * The item with its fields cleaned (a new object; the given item is not changed) and the JSON pointers of the fields
 * that changed, or the problems that refuse it. Run validateItem() on the result before using it.
 */
export function sanitiseItem(input: Item): SanitiseResult {
  if (!isObject(input) || typeof input.type !== "string")
    return { ok: false, problems: [problem("item_invalid:type", "/type", "an item needs a type")] };
  const item = structuredClone(input) as unknown as Record<string, unknown>;
  const changes: string[] = [];
  const problems: Problem[] = [];

  const idWhy = identityProblem(item.external_id, 200);
  if (idWhy) problems.push(problem("item_invalid:external_id", "/external_id", `/external_id ${idWhy}`));

  const line = (obj: Record<string, unknown>, key: string, max: number, path: string, required = false): void => {
    const v = obj[key];
    if (typeof v !== "string") return;
    const c = cleanLine(v, max);
    // an empty string is checked first: vendors send "" for a missing value, and the contract wants one character
    if (c === v && c !== "") return;
    if (c === "") {
      if (required) {
        problems.push(problem("item_invalid:minlength", path, `${path} is empty once control characters are removed`));
        return;
      }
      delete obj[key];
    } else obj[key] = c;
    changes.push(path);
  };
  const body = (obj: Record<string, unknown>, key: string, max: number, path: string): void => {
    const v = obj[key];
    if (typeof v !== "string") return;
    const c = cleanBody(v);
    if (c.length > max && [...c].length > max) {
      problems.push(problem("too_large", path, `${path} is longer than ${max} characters`));
      return;
    }
    if (c !== v) {
      obj[key] = c;
      changes.push(path);
    }
  };
  const drop = (obj: Record<string, unknown>, key: string, path: string, keep: (v: unknown) => boolean): void => {
    if (obj[key] !== undefined && !keep(obj[key])) {
      delete obj[key];
      changes.push(path);
    }
  };
  /** A list: elements the callback answers null for are dropped, the rest capped at `max`; the path is a change only
   * when the list got shorter (the callback records changes inside an element itself). */
  const list = <T>(obj: Record<string, unknown>, key: string, path: string, max: number, each: (v: unknown, i: number) => T | null): void => {
    const v = obj[key];
    if (!Array.isArray(v)) return;
    const out: T[] = [];
    v.forEach((x, i) => {
      const c = each(x, i);
      if (c !== null && out.length < max) out.push(c);
    });
    obj[key] = out;
    if (out.length !== v.length) changes.push(path);
  };

  // common fields
  if (typeof item.external_version === "string") line(item, "external_version", 200, "/external_version");
  drop(item, "url", "/url", (v) => typeof v === "string" && v.length >= 8 && v.length <= 2048 && URL_FORM.test(v));
  drop(item, "occurred_at", "/occurred_at", (v) => typeof v === "string" && TIMESTAMP.test(v));
  if (item.type !== "entity" && item.type !== "delete") {
    line(item, "title", 300, "/title");
    list(item, "entities", "/entities", 20, (r) => {
      if (!isObject(r)) return null;
      if ("email" in r) return typeof r.email === "string" && r.email.length >= 3 && r.email.length <= 200 && EMAIL.test(r.email) && !CTL.test(r.email) ? r : null;
      return typeof r.system === "string" && SYSTEM.test(r.system) && !RESERVED_SYSTEMS.has(r.system) &&
        (ENTITY_KINDS as readonly unknown[]).includes(r.kind) && identityProblem(r.id, 128) === null ? r : null;
    });
  }

  switch (item.type) {
    case "document": {
      if (typeof item.filename === "string") {
        const f = cleanFilename(item.filename, 255);
        if (f === "" || f === "." || f === ".." || /[/\\]/.test(f)) problems.push(problem("item_invalid:filename", "/filename", "/filename is not a usable file name"));
        else if (f !== item.filename) {
          item.filename = f;
          changes.push("/filename");
        }
      }
      line(item, "path", 1024, "/path");
      drop(item, "mime", "/mime", (v) => typeof v === "string" && v.length <= 255 && MIME.test(v));
      body(item, "text", 2_000_000, "/text");
      break;
    }
    case "meeting": {
      drop(item, "language", "/language", (v) => typeof v === "string" && LANGUAGE.test(v));
      if (typeof item.started_at === "string" && !TIMESTAMP.test(item.started_at))
        problems.push(problem("item_invalid:pattern", "/started_at", "/started_at is not an RFC 3339 date-time with an offset"));
      list(item, "participants", "/participants", 200, (p, i) => {
        if (!isObject(p)) return null;
        const q = { ...p };
        line(q, "name", 200, `/participants/${i}/name`);
        if (q.email !== undefined && !(typeof q.email === "string" && q.email.length >= 3 && q.email.length <= 200 && EMAIL.test(q.email) && !CTL.test(q.email))) {
          delete q.email;
          changes.push(`/participants/${i}/email`);
        }
        return q.name === undefined && q.email === undefined ? null : q;
      });
      const t = item.transcript;
      if (isObject(t)) {
        body(t, "text", 2_000_000, "/transcript/text");
        if (Array.isArray(t.segments)) {
          t.segments.forEach((s: unknown, i: number) => {
            if (!isObject(s)) return;
            body(s, "text", 2_000_000, `/transcript/segments/${i}/text`);
            line(s, "speaker", 200, `/transcript/segments/${i}/speaker`);
          });
        }
      }
      break;
    }
    case "note":
      body(item, "text", 20_000, "/text");
      break;
    case "entity": {
      const why = identityProblem(item.id, 128);
      if (why) problems.push(problem("item_invalid:id", "/id", `/id ${why}`));
      line(item, "name", 300, "/name", true);
      list(item, "aliases", "/aliases", 20, (a, i) => {
        if (typeof a !== "string") return null;
        const c = cleanLine(a, 300);
        if (c !== "" && c !== a) changes.push(`/aliases/${i}`);
        return c === "" ? null : c;
      });
      if (isObject(item.attrs)) {
        const attrs: Record<string, unknown> = {};
        let changed = false;
        for (const [k, v] of Object.entries(item.attrs)) {
          if (!ATTR_NAME.test(k) || RESERVED_ATTRS.has(k) || Object.keys(attrs).length >= 20) { changed = true; continue; }
          if (typeof v === "string") {
            const c = cleanLine(v, 200);
            if (c !== v) changed = true;
            attrs[k] = c;
          } else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER)) {
            attrs[k] = v;
          } else changed = true;
        }
        if (changed) {
          item.attrs = attrs;
          changes.push("/attrs");
        }
      }
      break;
    }
    default:
      break;
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, item: item as unknown as Item, changes: [...new Set(changes)] };
}
