const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i] as const));

export function base32Encode(data: Uint8Array): string {
  let out = "", acc = 0, bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  // ASCII-only upper-casing: Unicode rules would turn "ſ" into "S" and "ﬁ" into "FI" (RFC 4648 §3.3: reject them).
  const s = text.replace(/[a-z]/g, (ch) => ch.toUpperCase()).replace(/=+$/, "");
  if (!/^[A-Z2-7]*$/.test(s)) throw new TypeError("base32: use only A–Z and 2–7");
  if ([1, 3, 6].includes(s.length % 8)) throw new TypeError("base32: incomplete value");
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const c of s) {
    acc = (acc << 5) | VALUE.get(c)!;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new TypeError("base32: extra trailing bits");
  return Buffer.from(out);
}

export function normalizeHumanCode(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, "").replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
}
