import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnchorsKind, VerifiedAnchors } from "@memory/wire/common";
import type { AnchorsState } from "./admin-plane-types.ts";
import { raiseAlert } from "./alerts.ts";
import { ROLES_NOT_SPLIT, rolesSplitRefusal, setSecurityModeFloor, securityModeFloor } from "./security-mode.ts";
import { newId } from "./ids.ts";
import { log } from "./log.ts";
import type { PinProblem, Settings } from "./settings.ts";
import { anchoredKeys, pinKindFor, settingsPolicy } from "./settings-policy.ts";

export * from "./settings-policy.ts";

interface Queryable { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }

export const ANCHOR_SIGNERS_FILE = "anchor-signers.pub";
export const ANCHORS_DISABLED_FILE = "anchors-disabled";
export const ANCHOR_DOC_FILES: Readonly<Record<AnchorsKind, string>> = { inner: "trust-anchors-inner.json", edge: "trust-anchors.json" };

type Wire = typeof import("@memory/wire/common");
let wireMod: Promise<Wire> | null = null;
const wire = (): Promise<Wire> => (wireMod ??= import("@memory/wire/common"));

export interface LoadAnchorsOptions {
  dir?: string;
  via?: "start" | "sighup" | "cli";
  db?: Queryable;
  audit?: Queryable;
  instanceId?: string;
  appSecret?: string;
  settings?: Settings;
  record?: boolean;
  confirm?: boolean;
}

export interface InitAnchorsOptions extends Omit<LoadAnchorsOptions, "via"> {
  process: "gateway" | "workers";
  edgeDir?: string;
}

export const EDGE_ANCHORS_DIR = "/etc/memory/edge-anchors";

export class AnchorsError extends Error {
  /**
   * reason — what the refusal is about, for the alarm anchors_rejected, the journal and details.reason of the command line: the
   * code itself, or a narrower reason under it (roles_not_split under anchors_state).
   */
  constructor(readonly code: "anchors_invalid" | "anchors_rollback" | "anchors_state", message: string, readonly reason: string = code) { super(message); }
}

export function anchorsDir(dir?: string): string {
  if (dir) return dir;
  const env = process.env.MEMORY_ANCHORS_DIR;
  return env && env.trim() ? env : join(homedir(), "memory", "anchors");
}

export async function signerFingerprints(text: string): Promise<string[]> {
  const w = await wire();
  try { return w.parseTrustedKeys(text).map((k) => k.fingerprint); } catch { return []; }
}

export interface AnchorFiles { read(name: string): Buffer | null; names(): string[] }

export function dirAnchorFiles(dir: string): AnchorFiles {
  return {
    read: (name) => {
      try { return readFileSync(join(dir, name)); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new AnchorsError("anchors_invalid", `cannot read the anchors file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
    },
    names: () => { try { return readdirSync(dir); } catch { return []; } },
  };
}

const SIG_OF = /^(trust-anchors(?:-inner)?\.json)\.sig\.\d{1,3}$/;

export function mapAnchorFiles(files: Readonly<Record<string, string>>, fallback?: AnchorFiles, o: { root?: "installed" | "files" } = {}): AnchorFiles {
  const rootFromFiles = o.root === "files" || !fallback;
  const own = (name: string): boolean => Object.hasOwn(files, name) && (name !== ANCHOR_SIGNERS_FILE || rootFromFiles);
  const docOwn = (name: string): boolean => { const m = SIG_OF.exec(name); return !!m && own(m[1]!); };
  return {
    read: (name) => {
      if (own(name)) return Buffer.from(files[name]!, "utf8");
      if (name === ANCHOR_SIGNERS_FILE && rootFromFiles) return null;
      if (docOwn(name)) return null;
      return fallback?.read(name) ?? null;
    },
    names: () => {
      const mine = Object.keys(files).filter(own);
      const theirs = fallback ? fallback.names().filter((n) => (n === ANCHOR_SIGNERS_FILE ? !rootFromFiles : (() => { const m = SIG_OF.exec(n); return !!m && !own(m[1]!); })())) : [];
      return [...new Set([...mine, ...theirs])];
    },
  };
}

function mapWireError(w: Wire, kind: AnchorsKind, e: unknown): AnchorsError {
  if (e instanceof w.AnchorsError) {
    const code = e.code === "anchors_rollback" || e.code === "anchors_serial_reused" ? "anchors_rollback" : e.code === "anchors_state" ? "anchors_state" : "anchors_invalid";
    return new AnchorsError(code, `${ANCHOR_DOC_FILES[kind]}: ${e.message}`.slice(0, 300));
  }
  if (e instanceof AnchorsError) return e;
  return new AnchorsError("anchors_invalid", `${ANCHOR_DOC_FILES[kind]}: ${(e as Error)?.message ?? "validation error"}`.slice(0, 300));
}

async function storedSerial(db: Queryable | undefined, instanceId: string | undefined, kind: AnchorsKind): Promise<{ serial: number; sha256: string; retire: boolean } | null> {
  if (!db || !instanceId) return null;
  try {
    const r = await db.query(
      `SELECT a.serial, encode(a.sha256, 'hex') AS sha256, to_jsonb(a) ->> 'retire_target' AS retire FROM anchors_applied a
        WHERE a.instance_id = $1 AND a.kind = $2 ORDER BY a.serial DESC LIMIT 1`, [instanceId, kind]);
    return r.rows[0] ? { serial: Number(r.rows[0].serial), sha256: String(r.rows[0].sha256), retire: typeof r.rows[0].retire === "string" } : null;
  } catch (e) {
    throw new AnchorsError("anchors_state", `cannot read the applied anchors from the database: ${((e as Error)?.message ?? "").slice(0, 200)}`);
  }
}

async function retireConfirmed(db: Queryable | undefined, instanceId: string | undefined, serial: number): Promise<boolean> {
  if (!db || !instanceId) return true;
  try {
    const has = (await db.query("SELECT to_regclass('anchors_inner_confirmations') IS NOT NULL AS ok")).rows[0]?.ok === true;
    if (!has) return true;
    const r = await db.query(
      `SELECT 1 FROM anchors_inner_confirmations k JOIN anchors_applied a ON a.instance_id = k.instance_id AND a.kind = 'inner' AND a.serial = k.serial
                AND a.sha256 = k.sha256 AND a.applied_at = k.row_applied_at
        WHERE k.instance_id = $1 AND k.serial = $2 AND k.retire_target = 'basic'`, [instanceId, serial]);
    return (r.rowCount ?? r.rows.length) > 0;
  } catch (e) {
    throw new AnchorsError("anchors_state", `cannot read the retirement document confirmation from the database: ${((e as Error)?.message ?? "").slice(0, 200)}`);
  }
}

export type CheckedAnchors =
  | { inForce: false; reason: "no_signers" }
  | { inForce: false; reason: "disabled"; serial: number }
  | { inForce: false; reason: "retired"; serial: number }
  | { inForce: true; inner: VerifiedAnchors<"inner">; edge: VerifiedAnchors<"edge"> | null; problems: string[]; policySha256: string };

export async function checkAnchors(files: AnchorFiles, o: { db?: Queryable; instanceId?: string; settings?: Settings; edge?: boolean } = {}): Promise<CheckedAnchors> {
  const signers = files.read(ANCHOR_SIGNERS_FILE);
  if (!signers) {
    const prev = await storedSerial(o.db, o.instanceId, "inner");
    if (!prev) return { inForce: false, reason: "no_signers" };
    if (prev.retire && await retireConfirmed(o.db, o.instanceId, prev.serial)) return { inForce: false, reason: "retired", serial: prev.serial };
    if (files.read(ANCHORS_DISABLED_FILE) !== null) return { inForce: false, reason: "disabled", serial: prev.serial };
    throw new AnchorsError("anchors_rollback",
      `signers file ${ANCHOR_SIGNERS_FILE} is missing, but anchors with serial ${prev.serial} have already been applied. Restore the anchor files or add the ${ANCHORS_DISABLED_FILE} marker`);
  }
  const w = await wire();
  const one = async <K extends AnchorsKind>(kind: K): Promise<VerifiedAnchors<K> | null> => {
    const doc = files.read(ANCHOR_DOC_FILES[kind]);
    if (!doc) return null;
    const stored = await storedSerial(o.db, o.instanceId, kind);
    const sigs = w.anchorsSignatureFiles(kind, files.names()).map((n) => files.read(n)).filter((x): x is Buffer => x !== null).map((b) => b.toString("utf8"));
    try { return w.verifyAnchors({ kind, document: doc, signatures: sigs, trustedSigners: signers.toString("utf8"), stored: stored ? { serial: stored.serial, sha256: stored.sha256 } : null }); }
    catch (e) { throw mapWireError(w, kind, e); }
  };
  const inner = await one("inner");
  if (!inner) throw new AnchorsError("anchors_invalid", `${ANCHOR_DOC_FILES.inner}: the document is missing, but the signers file is present`);
  // The floor advanced is refused until the role split is ported (security-mode.ts, rolesSplitRefusal) —
  // here, so that anchors verify, the start and every reload of the gateway and of the workers refuse it before any row is written
  if (innerFloor(inner.anchors as { security_mode_min?: string; retire?: unknown }).floor === "advanced") {
    const why = rolesSplitRefusal();
    if (why) throw new AnchorsError("anchors_state", `${ANCHOR_DOC_FILES.inner}: security_mode_min advanced is refused — ${why}. Nothing is written, the `
      + "anchors in force stay; a process with this document on disk does not start. Put back the previous document with its signatures, or "
      + "sign 2 of 3 a new one without the floor (memory-admin-cli anchors draft --floor basic, a larger serial)", ROLES_NOT_SPLIT);
  }
  let edge: VerifiedAnchors<"edge"> | null = null;
  if (o.edge === false) {
    if (files.read(ANCHOR_DOC_FILES.edge)) log.warn("anchors_edge_doc_ignored", { reason: "edge_rows_by_edge_dir" });
  } else edge = await one("edge");
  const policy = settingsPolicy();
  const problems: string[] = [];
  const anchored = new Set(anchoredKeys(policy));
  for (const [path, pin] of Object.entries(inner.anchors.settings_pins)) {
    if (!policy.keys[path]) problems.push(`pin_unknown:${path}`);
    else if (!anchored.has(path)) problems.push(`pin_not_anchored:${path}`);
    const secret = o.settings?.meta(path).secret ?? false;
    if ("value" in pin && pinKindFor(path, secret, policy) === "hmac")
      throw new AnchorsError("anchors_invalid", `${ANCHOR_DOC_FILES.inner}: pin ${path} — a secret or a key with a fingerprint log can only be pinned with hmac`);
  }
  if (inner.anchors.settings_policy_sha256 !== policy.sha256) problems.push("policy_mismatch");
  return { inForce: true, inner, edge, problems, policySha256: policy.sha256 };
}

const NOT_LOADED: AnchorsState = Object.freeze({ inForce: false, reason: "not_loaded" }) as AnchorsState;
let state: AnchorsState = NOT_LOADED;
let loaderProblems: string[] = [];
let pinProblems: string[] = [];
const listeners = new Set<(s: AnchorsState) => void>();
let last: Omit<LoadAnchorsOptions, "via"> | null = null;
let lastWho: InitAnchorsOptions["process"] | null = null;
let lastEdgeDir: string | undefined;
let hupInstalled = false;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
export const INNER_CONFIRM_RETRY_MS = 30_000;

const day = (): string => new Date().toISOString().slice(0, 10);

function publish(next: AnchorsState): void {
  state = next;
  for (const cb of listeners) {
    try { cb(state); } catch (e) { log.warn("anchors_listener_failed", { error: (e as Error).message.slice(0, 200) }); }
  }
}

async function alert(o: LoadAnchorsOptions, level: "high" | "medium", code: string, summary: string, details: Record<string, unknown>, dedupeKey?: string): Promise<void> {
  if (!o.db || !o.instanceId) return;
  await raiseAlert({ control: o.db, audit: o.audit }, { instanceId: o.instanceId, level, code, summary, details, dedupeKey: dedupeKey ?? null });
}

async function auditEvent(o: LoadAnchorsOptions, op: "anchors_apply" | "anchors_reject", details: Record<string, unknown>): Promise<void> {
  if (!o.audit || !o.instanceId) return;
  await o.audit.query(
    "INSERT INTO audit_events (id, instance_id, event_type, principal_type, details) VALUES ($1, $2, 'admin', 'system', $3::jsonb)",
    [newId(), o.instanceId, JSON.stringify({ op, ...details })],
  ).catch((e: unknown) => log.error("audit_write_failed", { event_type: "admin", op, error: ((e as Error)?.message ?? String(e)).slice(0, 300) }));
}

function onPinProblems(o: LoadAnchorsOptions): (problems: PinProblem[]) => void {
  return (problems) => {
    pinProblems = problems.map((p) => `${p.code}:${p.key}`);
    if (state.inForce) state = { ...state, problems: [...loaderProblems, ...pinProblems] };
    const bad = problems.filter((p) => p.code !== "pin_not_anchored");
    if (!bad.length) return;
    const keys = bad.map((p) => p.key).sort();
    log.warn("anchors_pin_problems", { keys: keys.slice(0, 20), codes: [...new Set(bad.map((p) => p.code))] });
    void alert(o, "high", "pin_mismatch", `Anchor pins do not match the database settings. Treating ${keys.length} keys as unset`,
      { keys: keys.slice(0, 50), codes: Object.fromEntries(bad.map((p) => [p.key, p.code])) }, `pin_mismatch:${keys.join(",").slice(0, 150)}:${day()}`);
  };
}

function innerFloor(inner: { security_mode_min?: string; retire?: unknown }): { floor: "advanced" | null; min: "basic" | "advanced" | null; retire: boolean } {
  const retire = !!inner.retire;
  const min = inner.security_mode_min === "advanced" || inner.security_mode_min === "basic" ? inner.security_mode_min : null;
  return { floor: !retire && min === "advanced" ? "advanced" : null, min, retire };
}

function innerColumns(inner: { security_mode_min?: string; retire?: unknown }): { min: "basic" | "advanced" | null; retire: "basic" | null } {
  const fl = innerFloor(inner);
  return { min: fl.retire ? "basic" : fl.min, retire: fl.retire ? "basic" : null };
}

class AppliedRowMismatch extends AnchorsError {
  constructor(readonly kind: AnchorsKind, readonly serial: number, readonly what: string[], readonly otherDoc = false) {
    super("anchors_state", otherDoc
      ? `${ANCHOR_DOC_FILES[kind]}: serial ${serial} was already applied with a different sha256. The anchors_applied row holds a different document with the same serial. It was written outside the loader, or another signed document with this serial was applied concurrently. Check who wrote to the database (admin-incident.md), then use a new 2-of-3 document with a higher serial`
      : `${ANCHOR_DOC_FILES[kind]}: the anchors_applied row with serial ${serial} differs from the document in substance (${what.join(", ")}) — it was written outside the loader, or after a security mode rollback a repeated schema left it without a floor: a new 2-of-3 document with a higher serial or the ${ANCHORS_DISABLED_FILE} marker is needed`);
  }
}

async function insertApplied(db: Queryable, instanceId: string, d: VerifiedAnchors<AnchorsKind>, via: string): Promise<boolean> {
  const mfa = d.kind === "edge" ? (d.anchors as { mfa_mode_min: string }).mfa_mode_min : null;
  const fl = d.kind === "inner" ? innerFloor(d.anchors as { security_mode_min?: string; retire?: unknown }) : null;
  const base = [instanceId, d.kind, d.serial, d.sha256, d.signers, via, mfa];
  const r = fl && (fl.min || fl.retire)
    ? await db.query(
      `INSERT INTO anchors_applied (instance_id, kind, serial, sha256, signers, applied_via, mfa_mode_min, security_mode_min, retire_target)
       VALUES ($1, $2, $3, decode($4, 'hex'), $5::text[], $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [...base, fl.retire ? "basic" : fl.min, fl.retire ? "basic" : null])
    : await db.query(
      `INSERT INTO anchors_applied (instance_id, kind, serial, sha256, signers, applied_via, mfa_mode_min)
       VALUES ($1, $2, $3, decode($4, 'hex'), $5::text[], $6, $7) ON CONFLICT DO NOTHING`, base);
  if ((r.rowCount ?? 0) > 0) return true;
  const row = (await db.query(
    `SELECT encode(a.sha256, 'hex') AS sha256, a.signers, a.mfa_mode_min AS mfa, to_jsonb(a) ->> 'security_mode_min' AS smm, to_jsonb(a) ->> 'retire_target' AS retire
       FROM anchors_applied a WHERE a.instance_id = $1 AND a.kind = $2 AND a.serial = $3`, [instanceId, d.kind, d.serial])).rows[0] as
    { sha256?: unknown; signers?: unknown; mfa?: string | null; smm?: string | null; retire?: string | null } | undefined;
  if (!row) throw new AnchorsError("anchors_state", `${ANCHOR_DOC_FILES[d.kind]}: anchors_applied row with serial ${d.serial} was not written and cannot be read after a conflict`);
  if (String(row.sha256 ?? "").toLowerCase() !== d.sha256.toLowerCase()) throw new AppliedRowMismatch(d.kind, d.serial, ["document: this serial was already applied with a different sha256"], true);
  const what: string[] = [];
  if (fl) {
    const rowRetire = typeof row.retire === "string";
    const rowAdvanced = !rowRetire && typeof row.smm === "string" && row.smm !== "basic";
    if (rowAdvanced !== (fl.floor === "advanced")) what.push(`security floor: row ${rowAdvanced ? "advanced" : "no"}, document ${fl.floor ?? "no"}`);
    if (rowRetire !== fl.retire) what.push(`retirement: row ${rowRetire ? "yes" : "no"}, document ${fl.retire ? "yes" : "no"}`);
  } else if ((row.mfa ?? null) !== mfa) what.push(`minimum MFA mode: row ${row.mfa ?? "no"}, document ${mfa}`);
  if (what.length) throw new AppliedRowMismatch(d.kind, d.serial, what);
  const rowSigners = Array.isArray(row.signers) ? [...new Set(row.signers.map(String))].sort() : [];
  if (JSON.stringify(rowSigners) !== JSON.stringify([...new Set(d.signers)].sort()))
    log.warn("anchors_row_signers_differ", { kind: d.kind, serial: d.serial, row_signers: rowSigners.length, file_signers: d.signers.length });
  return false;
}

export const FLOOR_BUTTON_TEXT = "Only “Enable advanced” under “Readiness” changes the mode in the database. It revokes the agents’ system key and active sessions";

async function floorMismatch(o: LoadAnchorsOptions): Promise<void> {
  if (!o.settings || securityModeFloor() !== "advanced") return;
  await o.settings.load(true).catch(() => undefined);
  const setting = o.settings.securityModeSetting();
  if (setting === "advanced") return;
  log.warn("security_mode_floor_mismatch", { setting, floor: "advanced" });
  await alert(o, "high", "security_mode_floor_mismatch", `The database is in basic mode and the signed internal anchors require advanced, so advanced is in effect. ${FLOOR_BUTTON_TEXT} — add the advanced security floor to the anchors after using the button`,
    { setting, floor: "advanced" }, `security_mode_floor_mismatch:${day()}`).catch(() => undefined);
}

async function confirmInner(o: LoadAnchorsOptions, inner: VerifiedAnchors<"inner">): Promise<void> {
  if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  if (!o.db || !o.instanceId) return;
  const cols = innerColumns(inner.anchors as { security_mode_min?: string; retire?: unknown });
  const retry = () => {
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      if (state.serial !== inner.serial) return;
      void confirmInner(o, inner);
    }, INNER_CONFIRM_RETRY_MS);
    confirmTimer.unref?.();
  };
  let res: string;
  try {
    res = String((await o.db.query("SELECT anchors_inner_confirm($1, $2, $3, $4, $5) AS r", [o.instanceId, inner.serial, inner.sha256, cols.min, cols.retire])).rows[0]?.r ?? "");
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "42883" || code === "42P01") { log.info("anchors_confirm_unavailable", { serial: inner.serial }); return; }
    log.warn("anchors_confirm_failed", { serial: inner.serial, error: ((e as Error)?.message ?? "").slice(0, 200) });
    retry();
    return;
  }
  if (res === "confirmed") log.info("anchors_confirmed", { kind: "inner", serial: inner.serial });
  else if (res === "missing") { log.info("anchors_confirm_waiting", { serial: inner.serial }); retry(); }
  else if (res === "mismatch") {
    log.error("anchors_row_mismatch", { kind: "inner", serial: inner.serial, by: "workers" });
    await alert(o, "high", "anchors_rejected", `Internal anchor row ${inner.serial} differs from the signed document. The workers did not confirm it, so it cannot remove the security floor. It was written outside the gateway loader. Check who wrote to the database`,
      { reason: "anchors_row_mismatch", kind: "inner", serial: inner.serial, process: "workers" }, `anchors_row_mismatch:inner:${inner.serial}:workers:${day()}`).catch(() => undefined);
  }
}

export type EdgeFloorResult = { status: "none" } | { status: "applied" | "same"; serial: number; mfaModeMin: string } | { status: "failed"; code: string };

export async function applyEdgeFloor(o: { dir?: string; db?: Queryable; audit?: Queryable; instanceId?: string; via?: "start" | "sighup" | "cli" }): Promise<EdgeFloorResult> {
  if (!o.db || !o.instanceId) return { status: "none" };
  const dir = o.dir ?? EDGE_ANCHORS_DIR;
  const via = o.via ?? "start";
  const fail = async (code: string, message: string): Promise<EdgeFloorResult> => {
    log.error("anchors_edge_floor_failed", { code, via, error: message.slice(0, 300) });
    await alert(o, "high", "anchors_rejected", `The gateway rejected the edge anchors in its directory (${code}). Their MFA minimum was not applied, so the previous row is still in effect`,
      { code, via, process: "gateway", kind: "edge" }, `anchors_rejected:edge:${code}:${new Date().toISOString().slice(0, 13)}`).catch(() => undefined);
    await auditEvent(o, "anchors_reject", { kind: "edge", reason: code, applied_via: via });
    return { status: "failed", code };
  };
  let root: Buffer | null, doc: Buffer | null, docs: AnchorFiles;
  try {
    root = dirAnchorFiles(dir).read(ANCHOR_SIGNERS_FILE);
    docs = dirAnchorFiles(join(dir, "anchors"));
    doc = docs.read(ANCHOR_DOC_FILES.edge);
  } catch (e) { return fail("anchors_invalid", (e as Error)?.message ?? "cannot read the edge anchors file"); }
  if (!root || !doc) return { status: "none" };
  const w = await wire();
  let v: VerifiedAnchors<"edge">;
  try {
    const stored = await storedSerial(o.db, o.instanceId, "edge");
    const sigs = w.anchorsSignatureFiles("edge", docs.names()).map((n) => docs.read(n)).filter((x): x is Buffer => x !== null).map((b) => b.toString("utf8"));
    v = w.verifyAnchors({ kind: "edge", document: doc, signatures: sigs, trustedSigners: root.toString("utf8"), stored: stored ? { serial: stored.serial, sha256: stored.sha256 } : null });
  } catch (e) {
    const err = mapWireError(w, "edge", e);
    return fail(err.code, err.message);
  }
  const has = await o.db.query("SELECT to_regprocedure('mfa_anchor_floor_applied(text,bigint,bytea,text[],text,text)') IS NOT NULL AS ok")
    .then((r) => r.rows[0]?.ok === true, () => null);
  if (has === null) return fail("anchors_state", "the database did not respond to the MFA minimum function check");
  if (!has) { log.info("anchors_edge_floor_unavailable", { serial: v.serial }); return { status: "none" }; }
  let applied: boolean;
  try {
    applied = (await o.db.query("SELECT mfa_anchor_floor_applied($1, $2, decode($3, 'hex'), $4::text[], $5, $6) AS ok",
      [o.instanceId, v.serial, v.sha256, v.signers, v.anchors.mfa_mode_min, via])).rows[0]?.ok === true;
  } catch (e) {
    const m = ((e as Error)?.message ?? "").slice(0, 300);
    const code = /^anchors_(rollback|serial_reused)/.test(m) ? "anchors_rollback" : "anchors_state";
    return fail(code, m);
  }
  if (!applied) return { status: "same", serial: v.serial, mfaModeMin: v.anchors.mfa_mode_min };
  log.info("anchors_applied", { kind: "edge", serial: v.serial, via, mfa_mode_min: v.anchors.mfa_mode_min });
  await alert(o, "high", "anchors_changed", `Edge trust anchors applied, serial ${v.serial} (minimum second-factor mode: ${v.anchors.mfa_mode_min})`,
    { kind: "edge", serial: v.serial, via }, `anchors_changed:edge:${v.serial}`).catch(() => undefined);
  await auditEvent(o, "anchors_apply", { kind: "edge", serial: v.serial, applied_via: via });
  return { status: "applied", serial: v.serial, mfaModeMin: v.anchors.mfa_mode_min };
}

export function loaderSecurityFloor(): "advanced" | null {
  return state.inForce && state.securityModeMin === "advanced" ? "advanced" : null;
}

async function commit(c: Extract<CheckedAnchors, { inForce: true }>, o: LoadAnchorsOptions): Promise<AnchorsState> {
  const via = o.via ?? "start";
  const docs = [c.inner, ...(c.edge ? [c.edge] : [])] as VerifiedAnchors<AnchorsKind>[];
  const inserted: Array<{ kind: AnchorsKind; serial: number }> = [];
  if (o.db && o.instanceId && o.record !== false) {
    for (const d of docs) {
      try {
        if (await insertApplied(o.db, o.instanceId, d, via)) inserted.push({ kind: d.kind, serial: d.serial });
      } catch (e) {
        if (e instanceof AppliedRowMismatch) {
          log.error("anchors_row_mismatch", { kind: e.kind, serial: e.serial, what: e.what.map((x) => x.split(":")[0]) });
          await alert(o, "high", "anchors_rejected", e.otherDoc
            ? `Serial ${e.serial} for the ${e.kind === "inner" ? "inner" : "edge"} anchors already belongs to a different document in the database with a different sha256. The document was not applied and the previous anchors remain in effect. Check who wrote to the database, then use a new 2-of-3 document with a higher serial`
            : `The ${e.kind === "inner" ? "inner" : "edge"} anchor row with serial ${e.serial} in the database differs from the signed document: after a security mode rollback, a new 2-of-3 document or the anchors-disabled marker is needed`,
            { reason: "anchors_row_mismatch", kind: e.kind, serial: e.serial, via }, `anchors_row_mismatch:${e.kind}:${e.serial}:${day()}`).catch(() => undefined);
          throw e;
        }
        throw new AnchorsError("anchors_state", `the applied anchors could not be written to the database: ${((e as Error)?.message ?? "").slice(0, 200)}`);
      }
    }
  }
  const fl = innerFloor(c.inner.anchors as { security_mode_min?: string; retire?: unknown });
  setSecurityModeFloor(fl.floor, c.inner.serial);
  if (o.confirm) await confirmInner(o, c.inner);
  if (fl.retire) return retiredCommit(c, o, inserted, via);
  loaderProblems = c.problems;
  pinProblems = [];
  const inner = c.inner.anchors;
  const next: AnchorsState = {
    inForce: true,
    serial: c.inner.serial,
    sha256: c.inner.sha256,
    signers: c.inner.signers,
    admin: { networks: [...inner.admin.networks], ldap_ids: [...inner.admin.ldap_ids], webauthn: inner.admin.webauthn.map((w) => ({ ...w })) },
    settingsPins: inner.settings_pins,
    settingsPolicySha256: inner.settings_policy_sha256,
    ...(c.edge ? { mfaModeMin: c.edge.anchors.mfa_mode_min } : {}),
    ...(fl.min ? { securityModeMin: fl.min } : {}),
    problems: [...c.problems],
  };
  state = next;
  o.settings?.applyPins({ pins: inner.settings_pins, anchored: anchoredKeys(), onProblems: onPinProblems(o) });
  publish(state);
  for (const x of inserted) {
    log.info("anchors_applied", { kind: x.kind, serial: x.serial, via });
    await alert(o, "high", "anchors_changed", `Trust anchors applied: ${x.kind === "inner" ? "inner" : "edge"}, serial ${x.serial}`,
      { kind: x.kind, serial: x.serial, via }, `anchors_changed:${x.kind}:${x.serial}`);
    await auditEvent(o, "anchors_apply", { kind: x.kind, serial: x.serial, applied_via: via });
  }
  if (c.problems.includes("policy_mismatch"))
    await alert(o, "high", "policy_mismatch", "The settings policy file does not match the anchors. Settings changes are blocked until the anchors are signed again",
      { serial: c.inner.serial }, `policy_mismatch:${c.inner.serial}:${day()}`);
  await floorMismatch(o);
  return state;
}

async function retiredCommit(c: Extract<CheckedAnchors, { inForce: true }>, o: LoadAnchorsOptions, inserted: ReadonlyArray<{ kind: AnchorsKind; serial: number }>,
                             via: string): Promise<AnchorsState> {
  loaderProblems = [];
  pinProblems = [];
  o.settings?.applyPins(null);
  publish({ inForce: false, reason: "retired", retired: true, serial: c.inner.serial, sha256: c.inner.sha256, signers: c.inner.signers,
            ...(c.edge ? { mfaModeMin: c.edge.anchors.mfa_mode_min } : {}) });
  for (const x of inserted) {
    log.info("anchors_applied", { kind: x.kind, serial: x.serial, via, ...(x.kind === "inner" ? { retire: true } : {}) });
    await alert(o, "high", "anchors_changed", x.kind === "inner"
      ? `The internal anchor retirement document was applied, serial ${x.serial}. The internal anchors are retired. Legacy behavior applies with no security floor`
      : `Edge trust anchors applied, serial ${x.serial}`, { kind: x.kind, serial: x.serial, via, ...(x.kind === "inner" ? { retire: true } : {}) },
      `anchors_changed:${x.kind}:${x.serial}`);
    await auditEvent(o, "anchors_apply", { kind: x.kind, serial: x.serial, applied_via: via, ...(x.kind === "inner" ? { retire: true } : {}) });
  }
  return state;
}

export async function loadAnchors(opts: LoadAnchorsOptions = {}): Promise<AnchorsState> {
  const files = dirAnchorFiles(anchorsDir(opts.dir));
  const checked = await checkAnchors(files, { db: opts.db, instanceId: opts.instanceId, settings: opts.settings, edge: false });
  if (!checked.inForce) {
    if (state.inForce && (opts.via === "sighup" || opts.via === "cli"))
      throw new AnchorsError("anchors_invalid", "signers file is missing. Current anchors remain in effect until restart");
    loaderProblems = [];
    pinProblems = [];
    opts.settings?.applyPins(null);
    setSecurityModeFloor(null, checked.reason === "no_signers" ? null : checked.serial);
    if (checked.reason === "retired") {
      publish({ inForce: false, reason: "retired", retired: true, serial: checked.serial });
      return state;
    }
    publish({ inForce: false, reason: checked.reason });
    if (checked.reason === "disabled") {
      log.warn("anchors_disabled", { serial: checked.serial, via: opts.via ?? "start" });
      await alert(opts, "high", "anchors_rejected", `Trust anchors disabled by the ${ANCHORS_DISABLED_FILE} marker (last serial ${checked.serial}). Legacy behavior applies and pins are inactive`,
        { reason: "anchors_disabled", serial: checked.serial }, `anchors_disabled:${checked.serial}:${day()}`);
      await auditEvent(opts, "anchors_reject", { kind: "inner", serial: checked.serial, reason: "anchors_disabled", applied_via: opts.via ?? "start" });
    }
    return state;
  }
  return commit(checked, opts);
}

let loadChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = loadChain.then(fn, fn);
  loadChain = run.catch(() => undefined);
  return run;
}

export function initAnchors(opts: InitAnchorsOptions): Promise<AnchorsState> {
  return oneAtATime(async () => {
    const { process: who, edgeDir, ...load } = opts;
    if (who === "workers") { load.record = false; load.confirm = true; }
    last = load;
    lastWho = who;
    lastEdgeDir = edgeDir;
    let s: AnchorsState;
    try {
      s = await loadAnchors({ ...load, via: "start" });
    } catch (e) {
      if (e instanceof AnchorsError) {
        // the reason (roles_not_split under anchors_state) — in the alarm and the journal, not only in the text
        await alert({ ...load, via: "start" }, "high", "anchors_rejected", `Trust anchors rejected at startup (${e.reason}). Process ${who} will not start`,
          { code: e.code, reason: e.reason, via: "start", process: who }, `anchors_rejected:start:${e.reason}:${new Date().toISOString().slice(0, 13)}`).catch(() => undefined);
        await auditEvent({ ...load, via: "start" }, "anchors_reject", { reason: e.reason, applied_via: "start" });
      }
      throw e;
    }
    if (who === "gateway") await applyEdgeFloor({ dir: edgeDir, db: load.db, audit: load.audit, instanceId: load.instanceId, via: "start" });
    if (!hupInstalled) {
      hupInstalled = true;
      process.on("SIGHUP", () => {
        log.info("anchors_reload_signal", { process: who });
        void reloadAnchors("sighup");
      });
    }
    return s;
  });
}

export type ReloadResult =
  | { applied: true; kind: "inner"; serial: number | null; inForce: boolean; edge: EdgeFloorResult | null }
  | { applied: false; error: AnchorsError; edge: EdgeFloorResult | null };

export function reloadAnchors(via: "sighup" | "cli", extra: Partial<Omit<LoadAnchorsOptions, "via">> = {}): Promise<ReloadResult> {
  return oneAtATime(async (): Promise<ReloadResult> => {
    const o: LoadAnchorsOptions = { ...(last ?? {}), ...extra, via };
    const edge = (): Promise<EdgeFloorResult | null> =>
      (lastWho === "gateway" ? applyEdgeFloor({ dir: lastEdgeDir, db: o.db, audit: o.audit, instanceId: o.instanceId, via }) : Promise.resolve(null));
    try {
      const s = await loadAnchors(o);
      return { applied: true, kind: "inner", serial: s.serial ?? null, inForce: s.inForce, edge: await edge() };
    } catch (e) {
      const edgeRes = await edge();
      const err = e instanceof AnchorsError ? e : new AnchorsError("anchors_invalid", ((e as Error)?.message ?? "error").slice(0, 300));
      log.error("anchors_rejected", { code: err.code, reason: err.reason, via, error: err.message.slice(0, 300) });
      await alert(o, "high", "anchors_rejected", `The new trust anchors were rejected (${err.reason}). The previous anchors remain in effect`, { code: err.code, reason: err.reason, via });
      await auditEvent(o, "anchors_reject", { reason: err.reason, applied_via: via });
      return { applied: false, error: err, edge: edgeRes };
    }
  });
}

export function currentAnchors(): AnchorsState {
  return state;
}

export function onAnchorsReload(cb: (s: AnchorsState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function setAnchorsStateForTests(s: AnchorsState): void {
  state = s;
}

export function resetAnchorsForTests(): void {
  state = NOT_LOADED;
  loaderProblems = [];
  pinProblems = [];
  last = null;
  lastWho = null;
  lastEdgeDir = undefined;
  if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  listeners.clear();
  loadChain = Promise.resolve();
}
