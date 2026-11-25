#!/usr/bin/env node
// Halves of the emergency access key. Run it on a machine without network access or as root on the server.
// Generates two halves (base32, 128 bits each), shows each ONCE to its holder (the screen is cleared before the next)
// and writes the hash file for the gateway: {version: 1, kdf: {name: "scrypt", N, r, p}, halves: [{holder, salt, scrypt}]}.
// The halves themselves are written nowhere. The hash file goes to the gateway's credentials directory (`secrets/gateway`
// on the Compose install) with mode 0600; an existing file is never overwritten.
//
//   node tools/admin/breakglass-halves.mjs --out <hash file>
//   node tools/admin/breakglass-halves.mjs --out <hash file> --test-dir <dir> [--n 16384]
//        TESTS ONLY: the halves are written to <dir>/half-a.txt and half-b.txt (0600) and not shown;
//        --n is the scrypt cost (default 2^17, allowed 2^14 to 2^20).
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 };
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A half as the holder reads it: groups of 4 characters joined by hyphens (the gateway ignores hyphens and spaces). */
export const groups = (half) => half.match(/.{1,4}/g).join("-");

/** Two new halves and their hash file. */
export function makeHalves(kdf = DEFAULT_KDF) {
  const holders = ["A", "B"].map((holder) => {
    const raw = randomBytes(16), salt = randomBytes(16);
    const hash = scryptSync(raw, salt, 32, { ...kdf, maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024 });
    return { holder, half: base32(raw), salt: salt.toString("base64"), scrypt: hash.toString("base64") };
  });
  const file = { version: 1, kdf: { name: "scrypt", ...kdf }, halves: holders.map(({ holder, salt, scrypt }) => ({ holder, salt, scrypt })) };
  return { file, halves: Object.fromEntries(holders.map((h) => [h.holder, h.half])) };
}

async function waitEnter(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  await new Promise((resolve) => rl.question(question, () => resolve()));
  rl.close();
}

export async function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = opt("--out"), testDir = opt("--test-dir");
  const n = opt("--n") === undefined ? DEFAULT_KDF.N : Number(opt("--n"));
  if (!out || !Number.isInteger(Math.log2(n)) || n < 2 ** 14 || n > 2 ** 20) {
    process.stderr.write("usage: breakglass-halves.mjs --out <hash file> [--test-dir <dir> [--n 16384]]\n");
    return 2;
  }
  if (opt("--n") !== undefined && !testDir) { process.stderr.write("--n is allowed only with --test-dir (tests)\n"); return 2; }
  const { file, halves } = makeHalves({ ...DEFAULT_KDF, N: n });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (testDir) {
    mkdirSync(testDir, { recursive: true, mode: 0o700 });
    for (const h of ["A", "B"]) writeFileSync(join(testDir, `half-${h.toLowerCase()}.txt`), `${halves[h]}\n`, { mode: 0o600 });
    process.stderr.write(`TESTS ONLY: halves in ${testDir}, hash file ${out}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) { process.stderr.write("the halves are shown only on a terminal screen: run this in a terminal\n"); return 2; }
  for (const h of ["A", "B"]) {
    await waitEnter(`\nCall holder ${h}; nobody else may look at the screen. Press Enter to show half ${h}.`);
    process.stderr.write(`\n  Half ${h}:  ${groups(halves[h])}\n\n  Holder ${h} writes it down and takes it away; make no copies.\n`);
    await waitEnter("Press Enter to clear the screen.");
    process.stderr.write("\x1b[2J\x1b[3J\x1b[H");
  }
  process.stderr.write(`Hash file: ${out} (0600). Put it into the gateway's credentials directory as root. It holds no halves.\n`);
  return 0;
}

// Compare real paths so that a start through a symbolic link still runs main.
const runAsMain = () => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.code === "EEXIST" ? "the file already exists; not overwriting it" : e?.message ?? e}\n`); process.exitCode = 1; });
}
