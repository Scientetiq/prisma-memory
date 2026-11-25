// Messages in the language of the current request. One export per dictionary.
export const FINGERPRINT_TEXT = {
  invalidJson: "Fingerprint: paste the complete second line of the command output — {\"key_sha256\": …, \"key_prefix\": …}",
  secretEntered: "This looks like the key secret. Paste only its fingerprint into the admin panel (the second line of the command output)",
  shaRequired: "Fingerprint: provide the SHA-256 hash of the secret — 64 hexadecimal characters",
  prefixRequired: "Fingerprint: provide the key prefix — the first 8 characters of the secret (mem_s_ and two characters)",
};
