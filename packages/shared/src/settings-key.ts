import { createDecipheriv } from "node:crypto";
import { settingsKey, type EncryptedValue } from "./crypto.ts";

export const SETTINGS_KEY_BYTES = 32;

export const deriveSettingsKey = (appSecret: string, kid: string): Buffer => settingsKey(appSecret, kid);

export function decryptSettingWithKey(key: Buffer, enc: EncryptedValue): unknown {
  if (!Buffer.isBuffer(key) || key.length !== SETTINGS_KEY_BYTES) throw new Error(`settings-key: a ${SETTINGS_KEY_BYTES}-byte key is required`);
  if (!enc || typeof enc.ct !== "string" || typeof enc.iv !== "string") throw new Error("settings-key: ciphertext must be {ct, iv}");
  const body = Buffer.from(enc.ct, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  if (body.length < 17 || iv.length !== 12) throw new Error("settings-key: ciphertext is corrupt");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(body.subarray(body.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8"));
}
