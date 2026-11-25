// Trust anchors (two documents): checks of 2-of-3 signatures and rollback protection.
//   - edge:  trust-anchors.json, format memory-anchors/2, signing namespace memory-anchors: edge, bridge and inside;
//   - inner: trust-anchors-inner.json, format memory-anchors-inner/1, namespace memory-anchors-inner: inside only.
// Each kind has its own serial; a document of one kind never passes for the other, by format or by signing namespace.
// The root of trust is the signers' public keys from the initial setup file (anchor-signers.pub), not the document.
// The content of a signed document is checked in full: repeated keys at any depth, the schema of its kind
// (anchors-schema.gen.ts from contracts/edge/anchors*.schema.json) and what it cannot say (repeated kid, skid, client_id…).
// The function reads no files: the caller passes the document bytes, the signature texts and the stored serial.
import { createHash } from "node:crypto";
import { ANCHORS_SCHEMAS } from "./anchors-schema.gen.ts";
import { findDuplicateKey, validateSchema } from "./json-schema.ts";
import { parseTrustedKeys, SshSigError, verifySshSig, type SshEd25519Key } from "./sshsig.ts";

export type AnchorsKind = "edge" | "inner";

export const ANCHORS_KINDS = {
  edge: {
    format: "memory-anchors/2",
    namespace: "memory-anchors",
    file: "trust-anchors.json",
    required: ["format", "serial", "issued_at", "hosts", "clients", "authcheck_keys", "mfa_mode_min", "edge_bounds", "proxy_cidrs", "bridge", "signers"],
    optional: ["edge_auth_sign_keys", "skill_signing_pub", "passkey", "cimd"],
  },
  inner: {
    format: "memory-anchors-inner/1",
    namespace: "memory-anchors-inner",
    file: "trust-anchors-inner.json",
    required: ["format", "serial", "issued_at", "admin", "settings_pins", "settings_policy_sha256", "signers"],
    // the security mode floor and the "leaving document": optional, so earlier documents
    // pass as before
    optional: ["security_mode_min", "retire"],
  },
} as const satisfies Record<AnchorsKind, { format: string; namespace: string; file: string; required: readonly string[]; optional: readonly string[] }>;

/** At least this many signatures of different signers; a parameter cannot weaken it. */
export const MIN_ANCHOR_SIGNATURES = 2;
/** An anchors document is kilobytes; a larger one is not anchors. */
export const MAX_ANCHORS_BYTES = 1 << 20;

// ---------------------------------------------------------------- document types (as in the contracts/edge schemas)

export interface AnchorsHost { host: string; issuer?: string; resource?: string; roles: ("auth" | "mcp")[] }
export interface AnchorsRedirect { scheme: "http" | "https"; host: string; port: "any" | number; path?: string; path_regex?: string }
/** kind and title: the kind of the connecting program and the label on the consent. */
export interface AnchorsClient { client_id: string; enabled: boolean; redirects: AnchorsRedirect[]; dpop_required?: boolean; kind?: AnchorsClientKind; title?: string }
export type AnchorsClientKind = "claude_code" | "codex" | "cursor" | "vscode" | "local_other" | "claude_desktop";
export interface AuthcheckKey { kid: number; alg: "X25519"; pub: string; not_after: string }
/** Ed25519 public key of edge-auth for signing login check requests: pub is 32 bytes base64url. */
export interface EdgeAuthSignKey { skid: number; pub: string; not_after: string }
export interface AnchorsBridgeCert { cn: string; sha256: string; calls: string[] }

export interface EdgeAnchors {
  format: "memory-anchors/2";
  serial: number;
  issued_at: string;
  hosts: AnchorsHost[];
  clients: AnchorsClient[];
  authcheck_keys: AuthcheckKey[];
  edge_auth_sign_keys?: EdgeAuthSignKey[];
  mfa_mode_min: "off" | "optional" | "required";
  edge_bounds: Record<string, [number, number] | string[]>;
  proxy_cidrs: string[];
  bridge: { relay_cert_sha256: string[]; client_certs: AnchorsBridgeCert[]; edge_pg_cert_sha256: string };
  skill_signing_pub?: string;
  passkey?: Record<string, unknown>;
  cimd?: { clients?: string[] };
  signers: string[];
}

export interface InnerAnchors {
  format: "memory-anchors-inner/1";
  serial: number;
  issued_at: string;
  admin: { networks: string[]; ldap_ids: string[]; webauthn: { ldap_id: string; credential_id: string; public_key_sha256: string }[] };
  settings_pins: Record<string, { value: unknown } | { hmac: string }>;
  settings_policy_sha256: string;
  /** Security mode floor: the mode in force is not weaker than it; no field means no floor. */
  security_mode_min?: "basic" | "advanced";
  /** "Leaving document": the end of the inner anchors with the target basic; with it no advanced floor is set. */
  retire?: { target: "basic" };
  signers: string[];
}

export type AnchorsOf<K extends AnchorsKind> = K extends "edge" ? EdgeAnchors : InnerAnchors;

// ---------------------------------------------------------------- check

export type AnchorsErrorCode =
  | "anchors_signers_root" // the root of trust is empty, has fewer than two keys or is broken
  | "anchors_signatures" // fewer than two valid signatures of different signers from the document
  | "anchors_json" // not UTF-8, not JSON or not an object, too large
  | "anchors_kind" // format of the other document kind
  | "anchors_format" // repeated key, off the schema of its kind, repeated kid/client_id/cn/host, bounds reversed
  | "anchors_rollback" // serial below the stored one
  | "anchors_serial_reused" // the same serial, another document
  | "anchors_state"; // the stored serial file is broken or cannot be written

export class AnchorsError extends Error {
  constructor(readonly code: AnchorsErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AnchorsError";
  }
}

export interface VerifyAnchorsInput<K extends AnchorsKind> {
  kind: K;
  /** the file bytes exactly as they were signed */
  document: Uint8Array | string;
  /** texts of the signature files (<file>.sig.<n>) */
  signatures: readonly (string | Uint8Array)[];
  /** the root of trust: the text of anchor-signers.pub or keys already parsed */
  trustedSigners: string | readonly SshEd25519Key[];
  /** the last accepted serial of this kind and sha256 of its document (parseStoredSerial); null on first start */
  stored?: { serial: number; sha256: string } | null;
}

export interface VerifiedAnchors<K extends AnchorsKind> {
  kind: K;
  anchors: AnchorsOf<K>;
  serial: number;
  /** sha256 of the document bytes (hex), to be stored with the serial */
  sha256: string;
  /** fingerprints of the signers with a valid signature */
  signers: string[];
  /** rejected signatures: index in the list and code, for an alarm, not a refusal (two are enough) */
  rejected: { index: number; code: string }[];
  /**
   * Fingerprint of the root of trust that accepted the document (rootFingerprint of the very anchor-signers.pub the
   * process read), for the heartbeat (anchors_root_sha256).
   */
  rootSha256: string;
}

// ---------------------------------------------------------------- fingerprint of the root of trust

const HEX64 = /^[0-9a-f]{64}$/;

/** A signer key fingerprint in hex: sha256 of its blob (the same as «SHA256:» of ssh-keygen, only in hex). */
export function keyFingerprintHex(key: Pick<SshEd25519Key, "blob">): string {
  return createHash("sha256").update(key.blob).digest("hex");
}

/** A key fingerprint in hex: «SHA256:<base64>» (as ssh-keygen -l prints it) is decoded, hex goes to lower case. */
function fingerprintHex(f: string): string {
  const t = f.trim();
  const b64 = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(t);
  if (b64) return Buffer.from(b64[1]!, "base64").toString("hex");
  return t.toLowerCase().replace(/^sha256:/, "");
}

/**
 * Root fingerprint from key fingerprints: 64 hex characters (case, a leading «sha256:» ignored) or «SHA256:<base64>»,
 * as ssh-keygen prints it: sha256 of the lines «<hex>\n», no repeats, in order. So the root can be compared with a list
 * of fingerprints of people's keys (human_signer confirmations on the readiness page) without the keys. Else an error.
 */
export function rootFingerprintOfKeys(fingerprints: readonly string[]): string {
  const xs = [...new Set(fingerprints.map(fingerprintHex))];
  if (!xs.length || !xs.every((x) => HEX64.test(x))) throw new AnchorsError("anchors_signers_root", "the key fingerprint is 64 hexadecimal characters");
  return createHash("sha256").update(xs.sort().map((x) => `${x}\n`).join("")).digest("hex");
}

/**
 * Fingerprint of the root of trust anchor-signers.pub (anchors_root_sha256 in heartbeats of edge, bridge, authcheck,
 * exporter): rootFingerprintOfKeys of its key fingerprints. Comments, line order and spaces do not change it;
 * a changed, added or removed key gives another fingerprint. A broken or empty root is AnchorsError anchors_signers_root.
 */
export function rootFingerprint(trustedSigners: string | readonly SshEd25519Key[]): string {
  let keys: readonly SshEd25519Key[];
  try {
    keys = typeof trustedSigners === "string" ? parseTrustedKeys(trustedSigners) : trustedSigners;
  } catch (e) {
    throw new AnchorsError("anchors_signers_root", e instanceof SshSigError ? e.code : "the trust root could not be parsed");
  }
  if (!keys.length) throw new AnchorsError("anchors_signers_root", "the trust root has no keys");
  return rootFingerprintOfKeys(keys.map(keyFingerprintHex));
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export interface AnchorsProblem {
  code: "anchors_json" | "anchors_kind" | "anchors_format";
  detail: string;
}

const uniq = (xs: unknown[]) => new Set(xs).size === xs.length;

/** What the schema cannot express: repeats of key fields, the order of bounds, parsing of path_regex. */
function semanticProblems(kind: AnchorsKind, o: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (kind === "edge") {
    const a = o as unknown as EdgeAnchors;
    if (!uniq(a.authcheck_keys.map((k) => k.kid))) out.push("authcheck_keys: duplicate kid");
    if (a.edge_auth_sign_keys && !uniq(a.edge_auth_sign_keys.map((k) => k.skid))) out.push("edge_auth_sign_keys: duplicate skid");
    if (a.edge_auth_sign_keys && !uniq(a.edge_auth_sign_keys.map((k) => k.pub))) out.push("edge_auth_sign_keys: duplicate pub");
    if (!uniq(a.clients.map((c) => c.client_id))) out.push("clients: duplicate client_id");
    if (!uniq(a.hosts.map((h) => h.host))) out.push("hosts: duplicate host");
    if (!uniq(a.bridge.client_certs.map((c) => c.cn))) out.push("bridge.client_certs: duplicate cn");
    if (!uniq(a.bridge.client_certs.map((c) => c.sha256))) out.push("bridge.client_certs: duplicate sha256");
    for (const [k, b] of Object.entries(a.edge_bounds)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) out.push("edge_bounds: key name");
      if (typeof b[0] === "number" && typeof b[1] === "number" && b[0] > b[1]) out.push(`edge_bounds/${k}: minimum is greater than maximum`);
    }
    for (const c of a.clients)
      for (const r of c.redirects)
        if (r.path_regex !== undefined) {
          try {
            new RegExp(r.path_regex, "u");
          } catch {
            out.push(`clients/${c.client_id}: path_regex cannot be parsed`);
          }
        }
  } else {
    const a = o as unknown as InnerAnchors;
    if (!uniq(a.admin.webauthn.map((w) => w.credential_id))) out.push("admin.webauthn: duplicate credential_id");
  }
  return out;
}

/**
 * Check of the anchors document content without signatures (run before signing):
 * UTF-8 JSON object, no repeated keys, format of its kind, top-level fields, serial, issued_at, signers, kind schema,
 * rules outside the schema. An empty list means the document is valid.
 */
export function anchorsDocumentProblems(kind: AnchorsKind, document: Uint8Array | string): AnchorsProblem[] {
  const spec = ANCHORS_KINDS[kind];
  if (!spec) return [{ code: "anchors_kind", detail: "unknown kind of anchors" }];
  let text: string;
  let doc: unknown;
  try {
    text = typeof document === "string" ? document : new TextDecoder("utf-8", { fatal: true }).decode(document);
    doc = JSON.parse(text);
  } catch {
    return [{ code: "anchors_json", detail: "not UTF-8 JSON" }];
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [{ code: "anchors_json", detail: "not an object" }];
  const dup = findDuplicateKey(text);
  if (dup !== null) return [{ code: "anchors_format", detail: `duplicate key ${JSON.stringify(dup.slice(0, 64))}` }];
  const o = doc as Record<string, unknown>;
  if (o.format !== spec.format) return [{ code: "anchors_kind", detail: `format ${JSON.stringify(o.format)} instead of ${spec.format}` }];
  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return [{ code: "anchors_format", detail: `extra field ${k}` }];
  for (const k of spec.required) if (!(k in o)) return [{ code: "anchors_format", detail: `missing field ${k}` }];
  if (!Number.isSafeInteger(o.serial) || (o.serial as number) < 1) return [{ code: "anchors_format", detail: "serial" }];
  if (typeof o.issued_at !== "string" || !ISO_DT.test(o.issued_at) || Number.isNaN(Date.parse(o.issued_at))) return [{ code: "anchors_format", detail: "issued_at" }];
  const listed = o.signers;
  if (!Array.isArray(listed) || listed.length < 2 || listed.length > 3 || new Set(listed).size !== listed.length || !listed.every((x) => typeof x === "string" && FINGERPRINT.test(x)))
    return [{ code: "anchors_format", detail: "signers" }];
  const schema = validateSchema(ANCHORS_SCHEMAS[kind], doc);
  if (schema.length) return schema.map((p) => ({ code: "anchors_format", detail: `${p.path || "/"}: ${p.keyword}` }));
  return semanticProblems(kind, o).map((detail) => ({ code: "anchors_format", detail }));
}

function parseDocument<K extends AnchorsKind>(kind: K, bytes: Uint8Array): AnchorsOf<K> {
  const problems = anchorsDocumentProblems(kind, bytes);
  if (problems.length) throw new AnchorsError(problems[0]!.code, problems[0]!.detail);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as AnchorsOf<K>;
}

// ---------------------------------------------------------------- state: the last accepted serial

/** Stored serial: strictly «<serial> <sha256>» (sha256 is required: without it the same serial with another document
 * would pass). A broken state is the refusal anchors_state, not a "first start". */
export function parseStoredSerial(text: string): { serial: number; sha256: string } {
  const m = /^(\d{1,16}) ([0-9a-f]{64})\n?$/.exec(text);
  if (!m || !Number.isSafeInteger(Number(m[1])) || Number(m[1]) < 1) throw new AnchorsError("anchors_state", "the stored serial file is corrupted");
  return { serial: Number(m[1]), sha256: m[2]! };
}

export function formatStoredSerial(v: { serial: number; sha256: string }): string {
  return `${v.serial} ${v.sha256}\n`;
}

/** Whether to write the state after acceptance: none stored or the serial grew (same serial means same document, stored). */
export function serialNeedsStore(stored: { serial: number } | null | undefined, verified: { serial: number }): boolean {
  return !stored || verified.serial > stored.serial;
}

/** Signature files of a document of kind kind among directory names: <file>.sig.<n>, n is 0…999, in order of n. */
export function anchorsSignatureFiles(kind: AnchorsKind, names: readonly string[]): string[] {
  const prefix = `${ANCHORS_KINDS[kind].file}.sig.`;
  return names
    .filter((f) => f.startsWith(prefix) && /^\d{1,3}$/.test(f.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

/**
 * Checks the anchors: ≥ 2 valid SSHSIG ed25519 signatures of different signers, each in the root of trust and in the
 * signers list of the document; the content by anchorsDocumentProblems (repeated keys, kind schema, other rules);
 * serial not below the stored one (the same serial only with the same document).
 * A refusal is AnchorsError; the caller keeps the earlier anchors and raises an alarm; with none earlier it stops.
 */
export function verifyAnchors<K extends AnchorsKind>(input: VerifyAnchorsInput<K>): VerifiedAnchors<K> {
  const spec = ANCHORS_KINDS[input.kind];
  if (!spec) throw new AnchorsError("anchors_kind", "unknown kind of anchors");

  let trusted: readonly SshEd25519Key[];
  try {
    trusted = typeof input.trustedSigners === "string" ? parseTrustedKeys(input.trustedSigners) : input.trustedSigners;
  } catch (e) {
    throw new AnchorsError("anchors_signers_root", e instanceof SshSigError ? e.code : "the trust root could not be parsed");
  }
  if (trusted.length < MIN_ANCHOR_SIGNATURES) throw new AnchorsError("anchors_signers_root", "the trust root has fewer than two keys");

  const bytes = typeof input.document === "string" ? Buffer.from(input.document, "utf8") : Buffer.from(input.document);
  if (bytes.length === 0 || bytes.length > MAX_ANCHORS_BYTES) throw new AnchorsError("anchors_json", "document size");

  // 1. Signatures: over the raw bytes, before the content is parsed.
  const valid: SshEd25519Key[] = [];
  const rejected: { index: number; code: string }[] = [];
  input.signatures.forEach((sig, index) => {
    try {
      const signer = verifySshSig(bytes, typeof sig === "string" ? sig : Buffer.from(sig), spec.namespace, trusted);
      if (valid.some((v) => v.fingerprint === signer.fingerprint)) rejected.push({ index, code: "anchors_duplicate_signer" });
      else valid.push(signer);
    } catch (e) {
      rejected.push({ index, code: e instanceof SshSigError ? e.code : "sshsig_format" });
    }
  });

  if (valid.length < MIN_ANCHOR_SIGNATURES) throw new AnchorsError("anchors_signatures", `valid signatures of different signers: ${valid.length}`);

  // 2. Content: only of the signed document.
  const doc = parseDocument(input.kind, bytes);
  const o = doc as unknown as Record<string, unknown>;
  const listed = o.signers as string[];

  // 3. Signers: from the root of trust and from the document list, different.
  const counted = valid.filter((v) => {
    if (listed.includes(v.fingerprint)) return true;
    rejected.push({ index: -1, code: "anchors_signer_not_listed" });
    return false;
  });
  if (counted.length < MIN_ANCHOR_SIGNATURES) throw new AnchorsError("anchors_signatures", `valid signatures of different signers: ${counted.length}`);

  // 4. Rollback.
  const serial = o.serial as number;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.stored) {
    if (serial < input.stored.serial) throw new AnchorsError("anchors_rollback", `serial ${serial} < ${input.stored.serial}`);
    if (serial === input.stored.serial && input.stored.sha256 !== sha256) throw new AnchorsError("anchors_serial_reused", `serial ${serial}`);
  }

  return { kind: input.kind, anchors: doc as AnchorsOf<K>, serial, sha256, signers: counted.map((c) => c.fingerprint), rejected, rootSha256: rootFingerprint(trusted) };
}
