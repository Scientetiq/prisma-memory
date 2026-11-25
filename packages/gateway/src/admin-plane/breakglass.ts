import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import { scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { cidrContains, credentialsDir, currentAnchors, log, newId, raiseAlert } from "@memory/shared";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { adminDb, adminPlaneConfigured } from "./db.ts";
import { revokeAdminSessions } from "./session.ts";
import { adminNow } from "./test-clock.ts";

export interface BreakglassState { open: boolean; window?: string; reason_code?: string; expires_at?: string }

export const BREAKGLASS_REASONS = ["keys_lost", "sso_down", "directory_down", "incident", "drill"] as const;
export type BreakglassReason = (typeof BREAKGLASS_REASONS)[number];
export const BREAKGLASS_MAX_FAILURES = 3;
export const BREAKGLASS_HOURS_CAP = 2;

export interface ScryptParams { N: number; r: number; p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
export interface HalvesFile { version: 1; kdf: ScryptParams; halves: { A: { salt: Buffer; hash: Buffer }; B: { salt: Buffer; hash: Buffer } } }

export class BreakglassFileError extends Error {}

export function halvesPath(): string {
  const dir = credentialsDir();
  return dir ? join(dir, "breakglass-halves") : join(homedir(), "memory", "credentials", "memory-gateway", "breakglass-halves.json");
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export function parseHalvesFile(text: string): HalvesFile {
  let doc: { version?: unknown; kdf?: { name?: unknown; N?: unknown; r?: unknown; p?: unknown }; halves?: Array<{ holder?: unknown; salt?: unknown; scrypt?: unknown }> };
  try { doc = JSON.parse(text); } catch { throw new BreakglassFileError("the key halves file is not valid JSON"); }
  if (doc?.version !== 1 || !Array.isArray(doc.halves) || doc.halves.length !== 2) throw new BreakglassFileError("key halves file: version 1 and two halves are required");
  const kdf = { ...DEFAULT_SCRYPT };
  if (doc.kdf !== undefined) {
    const { name, N, r, p } = doc.kdf;
    if (name !== "scrypt" || typeof N !== "number" || typeof r !== "number" || typeof p !== "number" || !Number.isInteger(Math.log2(N))
        || N < 2 ** 14 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 4) throw new BreakglassFileError("key halves file: scrypt parameters are out of range");
    Object.assign(kdf, { N, r, p });
  }
  const out: Partial<HalvesFile["halves"]> = {};
  for (const h of doc.halves) {
    if ((h.holder !== "A" && h.holder !== "B") || out[h.holder]) throw new BreakglassFileError("key halves file: exactly one custodian for A and one for B");
    if (typeof h.salt !== "string" || typeof h.scrypt !== "string" || !B64.test(h.salt) || !B64.test(h.scrypt)) throw new BreakglassFileError("key halves file: salt and scrypt must be base64");
    const salt = Buffer.from(h.salt, "base64"), hash = Buffer.from(h.scrypt, "base64");
    if (salt.length < 16 || hash.length !== 32) throw new BreakglassFileError("key halves file: salt must be at least 16 bytes, hash must be 32 bytes");
    out[h.holder] = { salt, hash };
  }
  return { version: 1, kdf, halves: out as HalvesFile["halves"] };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function decodeHalf(text: unknown): Buffer | null {
  if (typeof text !== "string") return null;
  const s = text.toUpperCase().replace(/[\s-]+/g, "").replace(/=+$/, "");
  if (!/^[A-Z2-7]{26}$/.test(s)) return null;
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return out.length === 16 ? Buffer.from(out) : null;
}

const scryptOpts = (kdf: ScryptParams) => ({ N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024 });

export function scryptHalf(half: Buffer, salt: Buffer, kdf: ScryptParams): Buffer {
  return scryptSync(half, salt, 32, scryptOpts(kdf));
}

export function scryptHalfAsync(half: Buffer, salt: Buffer, kdf: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(half, salt, 32, scryptOpts(kdf), (e, key) => (e ? reject(e) : resolve(key))));
}

export async function halvesMatch(file: HalvesFile, a: unknown, b: unknown,
                                  kdf: (half: Buffer, salt: Buffer, k: ScryptParams) => Buffer | Promise<Buffer> = scryptHalfAsync): Promise<boolean> {
  const ha = decodeHalf(a), hb = decodeHalf(b);
  const [ka, kb] = await Promise.all([kdf(ha ?? Buffer.alloc(16), file.halves.A.salt, file.kdf), kdf(hb ?? Buffer.alloc(16), file.halves.B.salt, file.kdf)]);
  const okA = timingSafeEqual(ka, file.halves.A.hash);
  const okB = timingSafeEqual(kb, file.halves.B.hash);
  return okA && okB && ha !== null && hb !== null;
}

export function sshFromOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  return first.length <= 45 && !first.includes("%") && isIP(first) !== 0 ? first : null;
}

export function breakglassBlockedUntil(failures: readonly Date[], now: Date): Date | null {
  let until: number | null = null;
  for (let i = BREAKGLASS_MAX_FAILURES - 1; i < failures.length; i++) {
    const t = failures[i]!.getTime();
    if (t - failures[i - BREAKGLASS_MAX_FAILURES + 1]!.getTime() <= 3_600_000) until = Math.max(until ?? 0, t + 3_600_000);
  }
  return until !== null && until > now.getTime() ? new Date(until) : null;
}

export function bastionCheck(cidrs: readonly string[], from: string | null): "ok" | "outside" | "unchecked" {
  if (!cidrs.length) return "unchecked";
  return from && cidrs.some((c) => cidrContains(c, from)) ? "ok" : "outside";
}

async function closeExpired(app: App): Promise<void> {
  const db = adminDb(app);
  const now = adminNow();
  const r = await db.query(
    `UPDATE breakglass_windows SET closed_at = $2, closed_via = 'expired' WHERE instance_id = $1 AND closed_at IS NULL AND expires_at <= $2 RETURNING id`,
    [app.instanceId, now]);
  for (const w of r.rows as Array<{ id: string }>) {
    const n = await revokeAdminSessions(app, { windowId: w.id }, "breakglass_closed");
    await audit(app, null, { event_type: "admin", details: { op: "breakglass_close", window: w.id, closed_via: "expired", count: n } });
  }
}

export async function breakglassState(app: App): Promise<BreakglassState> {
  if (!adminPlaneConfigured(app)) return { open: false };
  await closeExpired(app);
  const r = await adminDb(app).query(
    `SELECT id, reason_code, expires_at FROM breakglass_windows WHERE instance_id = $1 AND closed_at IS NULL AND expires_at > $2
      ORDER BY opened_at DESC LIMIT 1`, [app.instanceId, adminNow()]);
  const w = r.rows[0] as { id: string; reason_code: string; expires_at: Date } | undefined;
  return w ? { open: true, window: w.id, reason_code: w.reason_code, expires_at: new Date(w.expires_at).toISOString() } : { open: false };
}

export async function breakglassWindowLive(app: App, windowId: string): Promise<boolean> {
  const r = await adminDb(app).query("SELECT closed_at, expires_at FROM breakglass_windows WHERE id = $1 AND instance_id = $2", [windowId, app.instanceId]);
  const w = r.rows[0] as { closed_at: Date | null; expires_at: Date } | undefined;
  if (w && !w.closed_at && new Date(w.expires_at).getTime() > adminNow().getTime()) return true;
  if (w && !w.closed_at) await closeExpired(app);
  await revokeAdminSessions(app, { windowId }, "breakglass_closed");
  return false;
}

export type OpenResult =
  | { ok: true; window: string; expires_at: string }
  | { ok: false; status: 400 | 403 | 409 | 429 | 503; code: string; message: string; retry_after?: number };

export interface OpenInput { half_a?: unknown; half_b?: unknown; reason_code?: unknown; ssh_connection?: unknown }

let halvesSource: (() => string) | null = null;
export function setHalvesSourceForTests(f: (() => string) | null): void { halvesSource = f; }

export async function openBreakglass(app: App, input: OpenInput): Promise<OpenResult> {
  const reason = input.reason_code;
  if (typeof reason !== "string" || !(BREAKGLASS_REASONS as readonly string[]).includes(reason))
    return { ok: false, status: 400, code: "invalid_argument", message: `reason_code must be one of: ${BREAKGLASS_REASONS.join(", ")}` };
  let file: HalvesFile;
  try {
    file = parseHalvesFile(halvesSource ? halvesSource() : readFileSync(halvesPath(), "utf8"));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    log.warn("breakglass_not_configured", { reason: missing ? "no_file" : (e instanceof BreakglassFileError ? e.message : "read_failed") });
    return { ok: false, status: 503, code: "breakglass_not_configured",
             message: missing ? "Emergency access is not configured. The key halves file is missing (tools/admin/breakglass-halves.mjs)" : "The emergency access key halves file is unreadable or corrupt" };
  }
  const db = adminDb(app);
  const from = sshFromOf(input.ssh_connection);
  const bastion = bastionCheck(app.settings.get<string[]>("admin.bastion_cidrs", []), from);
  const client = await db.connect();
  let now = adminNow();
  let verdict: { kind: "blocked"; until: Date } | { kind: "bastion" } | { kind: "checked"; ok: boolean; failures: number };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory:breakglass:${app.instanceId}`]);
    now = adminNow();
    const recent = (await client.query(
      "SELECT at FROM breakglass_attempts WHERE instance_id = $1 AND NOT ok AND at > $2::timestamptz - interval '2 hours' AND at <= $2 ORDER BY at",
      [app.instanceId, now])).rows.map((r: { at: Date }) => new Date(r.at));
    const until = breakglassBlockedUntil(recent, now);
    if (until) verdict = { kind: "blocked", until };
    else if (bastion === "outside" || (bastion === "unchecked" && currentAnchors().inForce)) verdict = { kind: "bastion" };
    else {
      let ok = false;
      try { ok = await halvesMatch(file, input.half_a, input.half_b); }
      finally {
        await client.query("INSERT INTO breakglass_attempts (id, instance_id, at, ok, ssh_from) VALUES ($1, $2, $3, $4, $5::inet)", [newId(), app.instanceId, now, ok, from]);
      }
      verdict = { kind: "checked", ok, failures: recent.filter((t) => t.getTime() > now.getTime() - 3_600_000).length + (ok ? 0 : 1) };
    }
    await commitOrThrow(client);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    await db.query("INSERT INTO breakglass_attempts (id, instance_id, at, ok, ssh_from) VALUES ($1, $2, $3, false, $4::inet)", [newId(), app.instanceId, now, from])
      .catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  if (verdict.kind === "blocked") {
    const retry = Math.max(1, Math.ceil((verdict.until.getTime() - now.getTime()) / 1000));
    return { ok: false, status: 429, code: "breakglass_blocked", message: "Emergency access is locked for one hour after three failed attempts", retry_after: retry };
  }
  if (verdict.kind === "bastion") {
    await audit(app, null, { event_type: "auth_failure", ip: from, details: { reason: "breakglass_not_bastion", via: "cli", ssh_from: from } });
    return { ok: false, status: 403, code: "breakglass_not_bastion",
             message: bastion === "outside" ? "Emergency access is available only from the bastion (admin.bastion_cidrs)" : "Emergency access is unavailable. When anchors are in effect, the bastion address list (admin.bastion_cidrs) is required" };
  }
  if (bastion === "unchecked") log.warn("breakglass_bastion_unchecked", { hint: "admin.bastion_cidrs is empty. The bastion address was not verified" });
  if (!verdict.ok) {
    const failures = verdict.failures;
    await audit(app, null, { event_type: "auth_failure", ip: from, details: { reason: "breakglass_halves_invalid", via: "cli", ssh_from: from } });
    if (failures >= BREAKGLASS_MAX_FAILURES)
      await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "breakglass_failed",
        summary: `Emergency access is locked for one hour: ${failures} failed attempts in the past hour`, details: { failures, ssh_from: from },
        dedupeKey: `breakglass_failed:${now.toISOString().slice(0, 13)}` });
    return { ok: false, status: 403, code: "breakglass_halves_invalid", message: "The emergency access key halves did not match" };
  }
  await closeExpired(app);
  const hours = Math.min(BREAKGLASS_HOURS_CAP, Math.max(1, Number(app.settings.get<number>("admin.breakglass_max_hours", 2)) || BREAKGLASS_HOURS_CAP));
  const id = newId();
  const expires = new Date(now.getTime() + hours * 3_600_000);
  const ins = await db.query(
    `INSERT INTO breakglass_windows (id, instance_id, opened_at, expires_at, reason_code, ssh_from)
     SELECT $1, $2, $3, $4, $5, $6::inet
      WHERE NOT EXISTS (SELECT 1 FROM breakglass_windows WHERE instance_id = $2 AND closed_at IS NULL AND expires_at > $3)`,
    [id, app.instanceId, now, expires, reason, from]);
  if (!ins.rowCount) return { ok: false, status: 409, code: "conflict", message: "An emergency access window is already open" };
  await audit(app, null, { event_type: "admin", ip: from, details: { op: "breakglass_open", window: id, reason_code: reason, via: "cli", ssh_from: from,
                                                                     ...(bastion === "unchecked" ? { bastion_unchecked: true } : {}) } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "breakglass_opened",
    summary: `Opened an emergency access window (${reason}) until ${expires.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    details: { window: id, reason_code: reason, ssh_from: from, hours } });
  return { ok: true, window: id, expires_at: expires.toISOString() };
}

export async function closeBreakglass(app: App, via: "cli" | "admin", from: string | null = null): Promise<{ closed: boolean; revoked: number }> {
  await closeExpired(app);
  const r = await adminDb(app).query(
    "UPDATE breakglass_windows SET closed_at = $2, closed_via = $3 WHERE instance_id = $1 AND closed_at IS NULL RETURNING id", [app.instanceId, adminNow(), via]);
  let revoked = 0;
  for (const w of r.rows as Array<{ id: string }>) {
    const n = await revokeAdminSessions(app, { windowId: w.id }, "breakglass_closed");
    revoked += n;
    await audit(app, null, { event_type: "admin", ip: from, details: { op: "breakglass_close", window: w.id, closed_via: via, count: n, ...(via === "cli" ? { via: "cli" } : {}) } });
  }
  return { closed: (r.rowCount ?? 0) > 0, revoked };
}

export function breakglassRoutes(app: App): Hono {
  const r = new Hono();
  r.get("/api/v1/admin/breakglass", async (c) => c.json(await breakglassState(app)));
  return r;
}
