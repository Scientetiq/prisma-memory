import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { latestVersion, readCredentialSet } from "./credentials.ts";

export const ENC_KID = "app-v1";

export function derivePassword(appSecret: string, role: string): string {
  return createHmac("sha256", appSecret).update(role).digest("base64");
}

export function settingsKey(appSecret: string, kid: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "memory-settings", kid, 32));
}

export interface EncryptedValue { ct: string; iv: string }

export function encryptWithKey(key: Buffer, value: unknown): EncryptedValue {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("the settings encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { ct: body.toString("base64"), iv: iv.toString("base64") };
}

export function decryptWithKey(key: Buffer, enc: EncryptedValue): unknown {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("the settings encryption key must be 32 bytes");
  const body = Buffer.from(enc.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8"));
}

export function encryptSetting(appSecret: string, value: unknown, kid = ENC_KID): EncryptedValue {
  return encryptWithKey(settingsKey(appSecret, kid), value);
}

export function decryptSetting(appSecret: string, enc: EncryptedValue, kid = ENC_KID): unknown {
  return decryptWithKey(settingsKey(appSecret, kid), enc);
}

export function parseKey32(raw: Buffer): Buffer | null {
  if (raw.length === 32) return Buffer.from(raw);
  const s = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return b.length === 32 ? b : null;
  }
  return null;
}

export const SETTINGS_KEY_PREFIX = "settings-key-";
export const credKid = (version: string): string => `cred-${version}`;

export interface SettingsKeyring {
  current: { kid: string; key: Buffer };
  byKid(kid: string): Buffer | null;
  kids(): string[];
}

export function settingsKeyring(o: { appSecret?: string | null; files?: Map<string, Buffer> } = {}): SettingsKeyring {
  const files = o.files ?? readCredentialSet(SETTINGS_KEY_PREFIX, { minBytes: 32 });
  const keys = new Map<string, Buffer>();
  for (const [v, raw] of files) {
    if (!/^[0-9]{1,6}$/.test(v)) throw new Error(`credentials: ${SETTINGS_KEY_PREFIX}${v} has a nonnumeric version`);
    const k = parseKey32(raw);
    if (!k) throw new Error(`credentials: ${SETTINGS_KEY_PREFIX}${v} is not a 32-byte key`);
    keys.set(credKid(v), k);
  }
  if (o.appSecret) keys.set(ENC_KID, settingsKey(o.appSecret, ENC_KID));
  const latest = latestVersion(files);
  const kid = latest !== null ? credKid(latest) : o.appSecret ? ENC_KID : null;
  if (!kid) throw new Error("settings encryption key is missing: neither settings-key-<n> nor PG_APP_PASSWORD is set");
  return { current: { kid, key: keys.get(kid)! }, byKid: (k) => keys.get(k) ?? null, kids: () => [...keys.keys()].sort() };
}

export type KeyKind = "personal" | "service" | "extended" | "system";
const PREFIX: Record<KeyKind, string> = { personal: "mem_p_", service: "mem_s_", extended: "mem_x_", system: "mem_sys_" };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(buf: Buffer): string {
  let bits = 0, acc = 0, out = "";
  for (const b of buf) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function generateApiKey(kind: KeyKind): { plain: string; hash: Buffer; prefix: string } {
  const plain = PREFIX[kind] + base32(randomBytes(32));
  return { plain, hash: hashApiKey(plain), prefix: plain.slice(0, 8) };
}

export function hashApiKey(plain: string): Buffer {
  return createHash("sha256").update(plain).digest();
}

export function kindFromPrefix(plain: string): KeyKind | null {
  for (const kind of ["system", "personal", "service", "extended"] as KeyKind[]) if (plain.startsWith(PREFIX[kind])) return kind;
  return null;
}

export type CallerKind = KeyKind | "session" | "connection";
export const SESSION_PREFIX = "mem_ses_";

export function generateSessionToken(): { plain: string; hash: Buffer } {
  const plain = SESSION_PREFIX + base32(randomBytes(32));
  return { plain, hash: hashApiKey(plain) };
}

export const isSessionToken = (plain: string): boolean => plain.startsWith(SESSION_PREFIX) && /^[a-z2-7]{52}$/.test(plain.slice(SESSION_PREFIX.length));

export const ADMIN_SESSION_PREFIX = "mem_as_";

export function generateToken(prefix: string): { plain: string; hash: Buffer } {
  const plain = prefix + base32(randomBytes(32));
  return { plain, hash: hashApiKey(plain) };
}

export const isAdminSessionToken = (plain: string): boolean =>
  plain.startsWith(ADMIN_SESSION_PREFIX) && /^[a-z2-7]{52}$/.test(plain.slice(ADMIN_SESSION_PREFIX.length));

export function hashAdminPassword(plain: string): string {
  const salt = randomBytes(16), N = 16384, r = 8, p = 1;
  const hash = scryptSync(plain, salt, 32, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyAdminPassword(plain: string, stored: string): boolean {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(plain, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(want, got);
}

export function signLink(signingKey: string | Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", signingKey).update(body).digest("base64url")}`;
}

export function verifyLink<T = Record<string, unknown>>(signingKey: string | Buffer, signed: string): T | null {
  const [body, mac] = signed.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", signingKey).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: unknown };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp < Date.now() / 1000) return null;
  return payload;
}
