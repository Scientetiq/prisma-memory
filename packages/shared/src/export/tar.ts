// Streaming tar writer for the memory export (format prisma-memory-export/1, contracts/export/README.md): POSIX ustar
// headers, a pax extended header ("x") in front of an entry whose name does not fit ustar (longer than 100 bytes or not
// plain ASCII) or whose size does not fit 11 octal digits (8 GiB and more). Regular files only, no directory entries:
// GNU tar and bsdtar create the folders on extraction. No dependency: the format is small and tested against an
// independent reader and the system tar.

export const BLOCK = 512;
/** The largest size an ustar header holds in its 11 octal digits (8 GiB - 1); larger sizes go to the pax header. */
export const USTAR_SIZE_MAX = 0o77777777777;
/** Two zero blocks end the archive. */
export const TAR_END: Buffer = Buffer.alloc(2 * BLOCK);

export interface TarEntry {
  /** Path inside the archive, "/" separated, relative. Built by layout.ts only (no "..", no leading "/"). */
  name: string;
  size: number;
  mtime: Date;
  /** File mode; 0644 by default. */
  mode?: number;
}

const enc = (s: string): Buffer => Buffer.from(s, "utf8");

/** Zero bytes that complete an entry of `size` bytes to a whole number of blocks. */
export function tarPadding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

function octal(value: number, width: number): string {
  // width includes the terminating NUL: width - 1 octal digits, zero-padded
  return value.toString(8).padStart(width - 1, "0");
}

function writeField(buf: Buffer, offset: number, width: number, value: string): void {
  const bytes = enc(value);
  bytes.copy(buf, offset, 0, Math.min(bytes.length, width));
}

const mtimeSec = (d: Date): number => {
  const t = Math.floor(d.getTime() / 1000);
  return Number.isFinite(t) && t > 0 ? Math.min(t, 0o77777777777) : 0;
};

/** One ustar header block. `name` must already be ASCII and at most 100 bytes (see tarHeader). */
function ustarBlock(name: string, size: number, mtime: Date, mode: number, type: "0" | "x"): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeField(h, 0, 100, name);
  writeField(h, 100, 8, `${octal(mode & 0o7777, 8)}\0`);
  writeField(h, 108, 8, `${octal(0, 8)}\0`);                       // uid
  writeField(h, 116, 8, `${octal(0, 8)}\0`);                       // gid
  writeField(h, 124, 12, `${octal(size > USTAR_SIZE_MAX ? 0 : size, 12)}\0`);
  writeField(h, 136, 12, `${octal(mtimeSec(mtime), 12)}\0`);
  h.fill(0x20, 148, 156);                                          // checksum is computed with spaces in its field
  writeField(h, 156, 1, type);
  writeField(h, 257, 6, "ustar\0");
  writeField(h, 263, 2, "00");
  writeField(h, 265, 32, "memory");
  writeField(h, 297, 32, "memory");
  let sum = 0;
  for (const b of h) sum += b;
  writeField(h, 148, 8, `${octal(sum, 7)}\0 `);
  return h;
}

/** One pax record "<len> <key>=<value>\n", where <len> counts the whole record including its own digits. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf8");
  let len = bodyLen;
  for (;;) {
    const total = bodyLen + String(len).length;
    if (total === len) break;
    len = total;
  }
  return `${len}${body}`;
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** The ustar name for an entry that has a pax header: printable ASCII, at most 100 bytes, same folder when possible. */
function fallbackName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  if (ascii.length <= 100) return ascii;
  const slash = ascii.lastIndexOf("/");
  const base = slash >= 0 ? ascii.slice(slash + 1) : ascii;
  return base.slice(-100);
}

/**
 * Header bytes of one entry: the ustar block, preceded by a pax extended header (header block, records, padding) when
 * the name is longer than 100 bytes or not printable ASCII, or the size is larger than USTAR_SIZE_MAX.
 */
export function tarHeader(e: TarEntry): Buffer {
  if (!e.name || e.name.startsWith("/") || e.name.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new Error(`tar: unsafe entry name ${JSON.stringify(e.name)}`);
  if (!Number.isSafeInteger(e.size) || e.size < 0) throw new Error(`tar: bad size ${e.size}`);
  const mode = e.mode ?? 0o644;
  const longName = Buffer.byteLength(e.name, "utf8") > 100 || !ASCII_PRINTABLE.test(e.name);
  const bigSize = e.size > USTAR_SIZE_MAX;
  if (!longName && !bigSize) return ustarBlock(e.name, e.size, e.mtime, mode, "0");
  let pax = "";
  if (longName) pax += paxRecord("path", e.name);
  if (bigSize) pax += paxRecord("size", String(e.size));
  const data = enc(pax);
  const paxName = `PaxHeaders/${fallbackName(e.name).split("/").pop()!}`.slice(0, 100);
  return Buffer.concat([ustarBlock(paxName, data.length, e.mtime, 0o644, "x"), data, tarPadding(data.length),
                        ustarBlock(longName ? fallbackName(e.name) : e.name, e.size, e.mtime, mode, "0")]);
}

/**
 * A whole small entry held in memory: header, bytes, padding. A generator (not an array) so that an error thrown into
 * the export generator at one of these chunks (the reader went away) reaches its handler as it is.
 */
export function* tarFile(name: string, data: Buffer, mtime: Date): Generator<Buffer> {
  yield tarHeader({ name, size: data.length, mtime });
  yield data;
  yield tarPadding(data.length);
}
