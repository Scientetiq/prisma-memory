#!/usr/bin/env node
// Service key by fingerprint. The service operator runs this program on the service's own host. The secret mem_s_…
// stays there (keep it in the service's secret store); the memory administrator receives only the fingerprint
// {key_sha256, key_prefix} and enters it in the panel (Services -> Key) or sends it to POST /api/v1/admin/keys. The panel
// and the gateway never see the secret, so an administrator session cannot obtain a key a service reads with.
//
// The secret has the format of generateApiKey("service") in packages/shared/src/crypto.ts: "mem_s_" and 32 random bytes
// in unpadded lowercase base32 (a-z, 2-7), 58 characters in all; the fingerprint is the hex sha256 of the secret, the
// prefix its first 8 characters. The program depends on nothing but Node.js, so it can be copied to another host as one
// file.
//
//   node tools/keys/gen-service-key.mjs          the secret on the first line of stdout, the fingerprint (JSON) on the second
//   node tools/keys/gen-service-key.mjs --json   one JSON line {secret, key_sha256, key_prefix}
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export const SERVICE_PREFIX = "mem_s_";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Unpadded lowercase base32, as base32 in packages/shared/src/crypto.ts. */
export function base32(buf) {
  let bits = 0, acc = 0, out = "";
  for (const b of buf) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** Fingerprint of a secret for the administrator: hex sha256 and the first 8 characters. */
export function fingerprintOf(secret) {
  return { key_sha256: createHash("sha256").update(secret).digest("hex"), key_prefix: secret.slice(0, 8) };
}

/** A new service secret and its fingerprint. bytes: 32 fixed bytes for tests. */
export function generateServiceKey(bytes = randomBytes(32)) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error("exactly 32 bytes are required");
  const secret = SERVICE_PREFIX + base32(bytes);
  return { secret, ...fingerprintOf(secret) };
}

export function main(argv, out = process.stdout, err = process.stderr) {
  const k = generateServiceKey();
  if (argv.includes("--json")) {
    out.write(`${JSON.stringify({ secret: k.secret, key_sha256: k.key_sha256, key_prefix: k.key_prefix })}\n`);
    return 0;
  }
  err.write("Service key secret (first line): keep it in the service's secret store; it is not shown anywhere again.\n"
          + "Give the memory administrator only the second line: the fingerprint.\n");
  out.write(`${k.secret}\n${JSON.stringify({ key_sha256: k.key_sha256, key_prefix: k.key_prefix })}\n`);
  return 0;
}

// Compare real paths so that a start through a symbolic link still runs main.
const runAsMain = () => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsMain()) process.exit(main(process.argv.slice(2)));
