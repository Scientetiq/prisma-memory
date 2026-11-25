import { FINGERPRINT_TEXT } from "../messages/key-fingerprint";

export interface KeyFingerprint { key_sha256: string; key_prefix: string }

export const GEN_SERVICE_KEY_COMMAND = "node tools/keys/gen-service-key.mjs";

const SHA_RE = /^[0-9a-f]{64}$/, PREFIX_RE = /^mem_s_[a-z2-7]{2}$/;

export function parseKeyFingerprint(raw: string): KeyFingerprint | { error: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const plainParts = s.startsWith("{") ? null : s.split(/[\s,;]+/).filter(Boolean);
  const invalidFormat = FINGERPRINT_TEXT.invalidJson;
  let sha = "", prefix = "";
  if (plainParts === null) {
    try {
      const j = JSON.parse(s) as { key_sha256?: unknown; key_prefix?: unknown };
      sha = typeof j.key_sha256 === "string" ? j.key_sha256.trim().toLowerCase() : "";
      prefix = typeof j.key_prefix === "string" ? j.key_prefix.trim() : "";
    } catch { return { error: invalidFormat }; }
  } else {
    for (const part of plainParts) {
      if (SHA_RE.test(part.toLowerCase())) sha = part.toLowerCase();
      else if (PREFIX_RE.test(part)) prefix = part;
    }
  }
  if (/mem_s_[a-z2-7]{3,}/.test(s)) return { error: FINGERPRINT_TEXT.secretEntered };
  if (!SHA_RE.test(sha)) return { error: FINGERPRINT_TEXT.shaRequired };
  if (!PREFIX_RE.test(prefix)) return { error: FINGERPRINT_TEXT.prefixRequired };
  if (plainParts !== null && plainParts.length > 2) return { error: invalidFormat };
  return { key_sha256: sha, key_prefix: prefix };
}
