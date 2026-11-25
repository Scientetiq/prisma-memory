// Origin. This file is a reduced TypeScript port of the qrcodegen library (Project Nayuki, TypeScript version 1.8.0,
// MIT licence): byte mode only, no segments and no ECI. Taken from it: the block tables, the rawDataModules and
// alignmentPositions formulas, GF(2^8) multiplication, the Reed-Solomon divisor and remainder, block interleaving,
// placement of format and version information, zigzag traversal and the mask penalty score (run history for finder-like
// patterns). It is not a verbatim copy but a rework, so instead of a vendor/ directory with a sha256 the file lives here,
// and the licence condition, the notice below, is met in this header. Correctness is held by unit tests:
// the matrices are compared with reference matrices from another implementation (python-qrcode)
// for all versions, levels and masks, and the golden SVG is checked by a decoder.
//
// ---------------------------------------------------------------- qrcodegen licence notice (MIT)
// QR Code generator library (TypeScript)
//
// Copyright (c) Project Nayuki. (MIT License)
// https://www.nayuki.io/page/qr-code-generator-library
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:
// - The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
// - The Software is provided "as is", without warranty of any kind, express or
//   implied, including but not limited to the warranties of merchantability,
//   fitness for a particular purpose and noninfringement. In no event shall the
//   authors or copyright holders be liable for any claim, damages or other
//   liability, whether in an action of contract, tort or otherwise, arising from,
//   out of or in connection with the Software or the use or other dealings in the
//   Software.
// ---------------------------------------------------------------- end of notice

export type QrEcl = "L" | "M" | "Q" | "H";

const ECL_BITS: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_INDEX: Record<QrEcl, number> = { L: 0, M: 1, Q: 2, H: 3 };

const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

export function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

export function qrBlocks(ver: number, ecl: QrEcl): { blocks: number; eccPerBlock: number; dataCodewords: number } {
  const e = ECL_INDEX[ecl];
  const blocks = NUM_BLOCKS[e]![ver]!, eccPerBlock = ECC_PER_BLOCK[e]![ver]!;
  return { blocks, eccPerBlock, dataCodewords: Math.floor(rawDataModules(ver) / 8) - blocks * eccPerBlock };
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const size = ver * 4 + 17;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j]!, root);
      if (j + 1 < degree) out[j] = out[j]! ^ out[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    divisor.forEach((coef, i) => { out[i] = out[i]! ^ gfMul(coef, factor); });
  }
  return out;
}

const countBits = (ver: number): number => (ver <= 9 ? 8 : 16);

export function qrVersionFor(len: number, ecl: QrEcl, minVersion = QR_MIN_VERSION): number {
  for (let v = Math.max(QR_MIN_VERSION, minVersion); v <= QR_MAX_VERSION; v++) {
    const need = 4 + countBits(v) + 8 * len;
    if (len < 2 ** countBits(v) && need <= qrBlocks(v, ecl).dataCodewords * 8) return v;
  }
  throw new RangeError("QR: the data does not fit in version 40");
}

function dataCodewords(bytes: Uint8Array, ver: number, ecl: QrEcl): number[] {
  const cap = qrBlocks(ver, ecl).dataCodewords * 8;
  const bits: number[] = [];
  const put = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, countBits(ver));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

function interleave(data: readonly number[], ver: number, ecl: QrEcl): number[] {
  const { blocks: nb, eccPerBlock } = qrBlocks(ver, ecl);
  const raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccPerBlock);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccPerBlock + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < shortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccPerBlock || j >= shortBlocks) out.push(b[i]!); });
  }
  return out;
}

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  setFn(x: number, y: number, d: boolean): void { this.dark[y]![x] = d; this.fn[y]![x] = true; }
}

const bit = (v: number, i: number): boolean => ((v >>> i) & 1) !== 0;

function drawFinder(m: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < m.size && y >= 0 && y < m.size) m.setFn(x, y, d !== 2 && d !== 4);
    }
  }
}

function drawAlignment(m: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}

function drawFormat(m: Matrix, ecl: QrEcl, mask: number): void {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const n = m.size;
  for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(bits, i));
  m.setFn(8, 7, bit(bits, 6));
  m.setFn(8, 8, bit(bits, 7));
  m.setFn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) m.setFn(n - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) m.setFn(8, n - 15 + i, bit(bits, i));
  m.setFn(8, n - 8, true);
}

function drawVersion(m: Matrix): void {
  if (m.ver < 7) return;
  let rem = m.ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (m.ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const d = bit(bits, i), a = m.size - 11 + (i % 3), b = Math.floor(i / 3);
    m.setFn(a, b, d);
    m.setFn(b, a, d);
  }
}

function drawFunctionPatterns(m: Matrix, ecl: QrEcl): void {
  for (let i = 0; i < m.size; i++) {
    m.setFn(6, i, i % 2 === 0);
    m.setFn(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);
  const pos = alignmentPositions(m.ver), n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(m, pos[i]!, pos[j]!);
    }
  }
  drawFormat(m, ecl, 0);
  drawVersion(m);
}

function drawCodewords(m: Matrix, data: readonly number[]): void {
  let i = 0;
  const total = data.length * 8;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.fn[y]![x] && i < total) {
          m.dark[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number): void {
  const f = MASKS[mask]!;
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (!m.fn[y]![x] && f(x, y)) m.dark[y]![x] = !m.dark[y]![x];
  }
}

const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

function addHistory(run: number, history: number[], size: number): void {
  if (history[0] === 0) run += size;
  history.pop();
  history.unshift(run);
}

function countFinderLike(h: readonly number[]): number {
  const n = h[1]!;
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
  return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0);
}

function terminateAndCount(color: boolean, run: number, history: number[], size: number): number {
  if (color) { addHistory(run, history, size); run = 0; }
  run += size;
  addHistory(run, history, size);
  return countFinderLike(history);
}

export function penaltyScore(dark: readonly (readonly boolean[])[]): number {
  const size = dark.length;
  let score = 0;
  for (const axis of [0, 1]) {
    for (let a = 0; a < size; a++) {
      let color = false, run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const d = axis === 0 ? dark[a]![b]! : dark[b]![a]!;
        if (d === color) {
          run++;
          if (run === 5) score += N1;
          else if (run > 5) score++;
        } else {
          addHistory(run, history, size);
          if (!color) score += countFinderLike(history) * N3;
          color = d;
          run = 1;
        }
      }
      score += terminateAndCount(color, run, history, size) * N3;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = dark[y]![x];
      if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) score += N2;
    }
  }
  let black = 0;
  for (const row of dark) for (const d of row) if (d) black++;
  const total = size * size;
  const k = Math.ceil(Math.abs(black * 20 - total * 10) / total) - 1;
  score += k * N4;
  return score;
}

export interface QrCode {
  version: number;
  ecl: QrEcl;
  mask: number;
  size: number;
  modules: boolean[][];
}

export interface QrOptions {
  ecl?: QrEcl;
  mask?: number;
  minVersion?: number;
}

export function encodeQrBytes(bytes: Uint8Array, o: QrOptions = {}): QrCode {
  const ecl = o.ecl ?? "M";
  if (o.mask !== undefined && !(Number.isInteger(o.mask) && o.mask >= 0 && o.mask <= 7)) throw new RangeError("QR: mask 0–7");
  const ver = qrVersionFor(bytes.length, ecl, o.minVersion);
  const m = new Matrix(ver);
  drawFunctionPatterns(m, ecl);
  drawCodewords(m, interleave(dataCodewords(bytes, ver, ecl), ver, ecl));
  let mask = o.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      applyMask(m, k);
      drawFormat(m, ecl, k);
      const s = penaltyScore(m.dark);
      if (s < best) { best = s; mask = k; }
      applyMask(m, k);
    }
  }
  applyMask(m, mask);
  drawFormat(m, ecl, mask);
  return { version: ver, ecl, mask, size: m.size, modules: m.dark };
}

export function encodeQrText(text: string, o: QrOptions = {}): QrCode {
  return encodeQrBytes(new TextEncoder().encode(text), o);
}
