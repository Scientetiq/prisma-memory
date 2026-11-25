import { unzipSync } from "fflate";
import { converterConfigured } from "./converter.ts";
import { parseConverterContract } from "./converter-session.ts";
import type { Settings } from "./settings.ts";

export const CONVERTER_FORMATS = ["pdf", "docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "xlsx", "ods", "csv"] as const;
export type ConverterFormat = typeof CONVERTER_FORMATS[number];
export type ConverterFormatKind = "pdf" | "word" | "powerpoint" | "excel";
export const DEFAULT_CONVERTER_FORMATS: readonly ConverterFormat[] = ["pdf"];
export const CONVERTER_FORMATS_SETTING = "integrations.converter_formats";

export const CONVERTER_FORMAT_KIND: Readonly<Record<ConverterFormat, ConverterFormatKind>> = {
  pdf: "pdf", docx: "word", doc: "word", odt: "word", rtf: "word", pptx: "powerpoint", ppt: "powerpoint", odp: "powerpoint", xlsx: "excel", ods: "excel", csv: "excel",
};
export const CONVERTER_FORMAT_MIME: Readonly<Record<ConverterFormat, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odp: "application/vnd.oasis.opendocument.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
};
const MIME_FORMAT: Readonly<Record<string, ConverterFormat>> = Object.fromEntries(
  (Object.entries(CONVERTER_FORMAT_MIME) as Array<[ConverterFormat, string]>).map(([f, m]) => [m, f]));
const isFormat = (v: unknown): v is ConverterFormat => typeof v === "string" && (CONVERTER_FORMATS as readonly string[]).includes(v);

export function formatOfMime(mime: string | null | undefined): ConverterFormat | null {
  return MIME_FORMAT[String(mime ?? "").split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function parseConverterFormats(v: unknown): ConverterFormat[] {
  if (!Array.isArray(v)) return [...DEFAULT_CONVERTER_FORMATS];
  const want = new Set(v.map((x) => String(x).trim().toLowerCase()));
  return CONVERTER_FORMATS.filter((f) => want.has(f));
}

export function converterFormatsProblem(v: unknown): string | null {
  const allowed = CONVERTER_FORMATS.join(", ");
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return `use a list of quoted formats such as ["pdf", "docx"]. Allowed formats: ${allowed}`;
  const bad = v.filter((x) => !isFormat(x));
  if (bad.length) return `unrecognized formats ${bad.map((x) => JSON.stringify(x)).join(", ")}. Allowed formats: ${allowed} (lowercase; macros, .xls, HTML and EPUB are not accepted)`;
  if (new Set(v).size !== v.length) return "formats must be unique";
  if (!v.includes("pdf")) return "PDF is always accepted. Keep \"pdf\" in the list";
  return null;
}

export interface ConverterCaps { fast_lane: boolean; version: string | null; checked_at?: string }

export function convertibleFormats(settings: Pick<Settings, "get" | "str">, caps: Pick<ConverterCaps, "fast_lane"> | null | undefined,
                                   o: { allOffice?: boolean } = {}): ConverterFormat[] {
  if (!converterConfigured(settings)) return [];
  const fast = caps?.fast_lane === true;
  const want = new Set(parseConverterFormats(settings.get<unknown>(CONVERTER_FORMATS_SETTING, DEFAULT_CONVERTER_FORMATS)));
  return CONVERTER_FORMATS.filter((f) => f === "pdf" || (fast && (o.allOffice === true || want.has(f))));
}

export const CONVERTER_OFFICE_TEST_HOOK = "integrations.converter_office_test_hook";

export const converterFormatsNeedCaps = (settings: Pick<Settings, "get">): boolean =>
  parseConverterFormats(settings.get<unknown>(CONVERTER_FORMATS_SETTING, DEFAULT_CONVERTER_FORMATS)).some((f) => f !== "pdf");

export const convertibleMime = (formats: readonly ConverterFormat[]): string[] => formats.map((f) => CONVERTER_FORMAT_MIME[f]);

export interface UploadFormat { ext: ConverterFormat | "md" | "txt"; kind: ConverterFormatKind | "text" }
export const TEXT_UPLOAD_FORMATS: readonly UploadFormat[] = [{ ext: "md", kind: "text" }, { ext: "txt", kind: "text" }];

export const acceptedFormatsList = (formats: readonly ConverterFormat[]): UploadFormat[] =>
  [...formats.map((ext) => ({ ext, kind: CONVERTER_FORMAT_KIND[ext] })), ...TEXT_UPLOAD_FORMATS.map((f) => ({ ...f }))];

export const CONVERTER_CONTRACT_TIMEOUT_MS = 10_000;
export const CONVERTER_CONTRACT_MAX_BYTES = 1024 * 1024;

export async function fetchConverterCaps(cfg: { url: string; requestTimeoutMs?: number }, o: { fetchImpl?: typeof fetch } = {}):
  Promise<{ ok: true; caps: Omit<ConverterCaps, "checked_at"> } | { ok: false; status: number | null }> {
  const url = cfg.url.replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(CONVERTER_CONTRACT_TIMEOUT_MS, Math.max(1000, cfg.requestTimeoutMs ?? CONVERTER_CONTRACT_TIMEOUT_MS)));
  try {
    const res = await (o.fetchImpl ?? fetch)(`${url}/api/contract`, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal, redirect: "manual" });
    if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return { ok: true, caps: { fast_lane: false, version: null } }; }
    if (res.status < 200 || res.status >= 300 || !res.body) { await res.body?.cancel().catch(() => undefined); return { ok: false, status: res.status }; }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CONVERTER_CONTRACT_MAX_BYTES) { await reader.cancel().catch(() => undefined); return { ok: false, status: res.status }; }
      chunks.push(value);
    }
    let json: unknown;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { ok: false, status: res.status }; }
    const caps = parseConverterContract(json);
    return caps ? { ok: true, caps } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally { clearTimeout(timer); }
}

type Claim = ConverterFormat | "text" | "markdown" | "xls" | "macro" | "other";

const EXT_CLAIM: Readonly<Record<string, Claim>> = {
  pdf: "pdf", docx: "docx", doc: "doc", odt: "odt", rtf: "rtf", pptx: "pptx", ppt: "ppt", odp: "odp", xlsx: "xlsx", ods: "ods", csv: "csv",
  txt: "text", md: "markdown", markdown: "markdown",
  xls: "xls", xlsb: "xls",
  docm: "macro", dotm: "macro", pptm: "macro", potm: "macro", ppsm: "macro", ppam: "macro", sldm: "macro", xlsm: "macro", xltm: "macro", xlam: "macro",
};
const MIME_CLAIM: Readonly<Record<string, Claim>> = {
  ...MIME_FORMAT, "application/x-pdf": "pdf", "text/rtf": "rtf", "application/x-rtf": "rtf",
  "application/csv": "csv", "text/comma-separated-values": "csv", "text/x-csv": "csv",
  "application/vnd.ms-excel": "xls", "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xls",
  "application/vnd.ms-word.document.macroenabled.12": "macro", "application/vnd.ms-word.template.macroenabled.12": "macro",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "macro", "application/vnd.ms-powerpoint.slideshow.macroenabled.12": "macro",
  "application/vnd.ms-powerpoint.template.macroenabled.12": "macro", "application/vnd.ms-powerpoint.addin.macroenabled.12": "macro",
  "application/vnd.ms-excel.sheet.macroenabled.12": "macro", "application/vnd.ms-excel.template.macroenabled.12": "macro",
  "application/vnd.ms-excel.addin.macroenabled.12": "macro",
};
const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream", "application/zip", "application/x-zip-compressed", "application/x-zip",
                              "application/x-ole-storage", "application/cdfv2", "application/vnd.ms-office", "application/x-download", "application/force-download"]);

export type SniffRefusal = "macros" | "encrypted" | "xls" | "mismatch" | "zip_bomb" | "damaged" | "unsupported";

export type SniffResult =
  | { ok: true; kind: "document"; format: ConverterFormat; mime: string }
  | { ok: true; kind: "text"; mime: "text/plain" | "text/markdown" }
  | { ok: false; refusal: SniffRefusal; ext: string | null; named: ConverterFormatKind | "csv" | null };

export const SNIFF_ZIP_MAX_ENTRIES = 10_000;
export const SNIFF_ZIP_MAX_UNPACKED = 1024 * 1024 * 1024;
export const SNIFF_ZIP_MAX_ENTRY = 512 * 1024 * 1024;

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_STREAM = {
  encrypted: Buffer.from("EncryptedPackage", "utf16le"),
  word: Buffer.from("WordDocument", "utf16le"),
  powerpoint: Buffer.from("PowerPoint Document", "utf16le"),
  excel: Buffer.from("Workbook", "utf16le"),
} as const;
const OLE_MACRO_ENTRIES: ReadonlySet<string> = new Set(["MACROS", "_VBA_PROJECT", "_VBA_PROJECT_CUR"]);
const OLE_MACRO_NAME_BYTES: ReadonlySet<number> = new Set([...OLE_MACRO_ENTRIES].map((n) => (n.length + 1) * 2));

function oleHasEntry(buf: Buffer, names: ReadonlySet<string>, lengths: ReadonlySet<number>): boolean {
  for (let at = 512; at + 128 <= buf.length; at += 128) {
    const n = buf.readUInt16LE(at + 64);
    if (!lengths.has(n) || (buf[at + 66] !== 1 && buf[at + 66] !== 2) || buf.readUInt16LE(at + n - 2) !== 0) continue;
    if (names.has(buf.toString("utf16le", at, at + n - 2).toUpperCase())) return true;
  }
  return false;
}
const ODF_MIMETYPE: Readonly<Record<string, ConverterFormat>> = {
  "application/vnd.oasis.opendocument.text": "odt", "application/vnd.oasis.opendocument.presentation": "odp", "application/vnd.oasis.opendocument.spreadsheet": "ods",
};

const asBuffer = (b: Uint8Array): Buffer => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const extOf = (filename: string | null | undefined): string | null => /\.([A-Za-z0-9]{1,10})$/u.exec(String(filename ?? ""))?.[1]?.toLowerCase() ?? null;

class ZipBomb extends Error {}

function sniffZip(buf: Buffer): { actual: ConverterFormat | null; refusal: SniffRefusal | null; families: Set<"word" | "powerpoint" | "excel"> } {
  const families = new Set<"word" | "powerpoint" | "excel">();
  let macros = false, binaryExcel = false, entries = 0, unpacked = 0, mimetype: Uint8Array | undefined;
  try {
    const files = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
      filter: (f) => {
        entries += 1;
        const size = Math.max(0, Number(f.originalSize) || 0);
        unpacked += size;
        if (entries > SNIFF_ZIP_MAX_ENTRIES || unpacked > SNIFF_ZIP_MAX_UNPACKED || size > SNIFF_ZIP_MAX_ENTRY) throw new ZipBomb();
        const name = f.name.replace(/\\/gu, "/");
        if (/(^|\/)vbaProject\.bin$/iu.test(name) || /^xl\/macrosheets\//iu.test(name)) macros = true;
        if (/(^|\/)Basic\/[^/]+\/[^/]+$/iu.test(name) && !/\/script-lb\.xml$/iu.test(name)) macros = true;
        if (/(^|\/)Scripts\/.*[^/]$/iu.test(name)) macros = true;
        if (/\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppsm|ppam|sldm)$/iu.test(name)) macros = true;
        if (/^xl\/workbook\.bin$/iu.test(name)) binaryExcel = true;
        if (name.startsWith("word/")) families.add("word");
        else if (name.startsWith("ppt/")) families.add("powerpoint");
        else if (name.startsWith("xl/")) families.add("excel");
        return name === "mimetype" && size <= 100 && Number(f.size) <= 1000 && (f.compression === 0 || f.compression === 8);
      },
    });
    mimetype = files["mimetype"];
  } catch (e) {
    if (e instanceof ZipBomb) return { actual: null, refusal: "zip_bomb", families };
    return { actual: null, refusal: "damaged", families };
  }
  if (macros) return { actual: null, refusal: "macros", families };
  if (binaryExcel) return { actual: null, refusal: "xls", families };
  if (mimetype) {
    const odf = ODF_MIMETYPE[Buffer.from(mimetype).toString("latin1").trim()];
    if (odf) return { actual: odf, refusal: null, families };
  }
  const first = families.has("word") ? "docx" : families.has("powerpoint") ? "pptx" : families.has("excel") ? "xlsx" : null;
  return { actual: first, refusal: null, families };
}

function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return false;
  return head.includes(0);
}

export function declaredTextLooksLikeDocument(bytes: Uint8Array): boolean {
  const buf = asBuffer(bytes);
  if (looksBinary(buf)) return true;
  if (buf.subarray(0, 4).equals(ZIP_MAGIC) || buf.subarray(0, 8).equals(OLE_MAGIC)) return true;
  const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const lead = buf.subarray(start, start + 5).toString("latin1");
  if (lead === "{\\rtf" || lead === "%PDF-") return true;
  return buf.subarray(0, 1024).includes("%PDF-", 0, "latin1") && buf.subarray(Math.max(0, buf.length - 1024)).includes("%%EOF", 0, "latin1");
}

const familyOfOoxml: Readonly<Record<string, "word" | "powerpoint" | "excel">> = { docx: "word", pptx: "powerpoint", xlsx: "excel" };

export function sniffDocument(bytes: Uint8Array, filename: string | null | undefined, mime: string | null | undefined): SniffResult {
  const buf = asBuffer(bytes);
  const ext = extOf(filename);
  const type = String(mime ?? "").split(";")[0]!.trim().toLowerCase();
  const byExt: Claim | null = ext ? EXT_CLAIM[ext] ?? "other" : null;
  const byMime: Claim | null = GENERIC_MIME.has(type) ? null : MIME_CLAIM[type] ?? "other";
  const claim: Claim | null = byExt && byExt !== "other" ? byExt : byMime && byMime !== "other" ? byMime : byExt ?? byMime;
  const named = (c: Claim | null): ConverterFormatKind | "csv" | null =>
    c === "csv" ? "csv" : c && isFormat(c) ? CONVERTER_FORMAT_KIND[c] : null;
  const refuse = (refusal: SniffRefusal): SniffResult => ({ ok: false, refusal, ext, named: named(byExt !== "other" ? byExt : null) });
  const accept = (format: ConverterFormat): SniffResult => ({ ok: true, kind: "document", format, mime: CONVERTER_FORMAT_MIME[format] });

  let actual: ConverterFormat | null = null;
  const head = buf.subarray(0, 1024);
  const extClaim: Claim | null = byExt && byExt !== "other" ? byExt : null;
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    const z = sniffZip(buf);
    if (z.refusal) return refuse(z.refusal);
    const want = claim && familyOfOoxml[claim];
    actual = want && z.families.has(want) ? (claim as ConverterFormat) : z.actual;
    if (!actual) return refuse(claim === "macro" ? "macros" : extClaim && isFormat(extClaim) ? "mismatch" : "unsupported");
  } else if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) {
    if (buf.includes(OLE_STREAM.encrypted)) return refuse("encrypted");
    if (claim === "docx" || claim === "pptx" || claim === "xlsx") return refuse("encrypted");
    if (claim === "xls") return refuse("xls");
    if (claim === "macro") return refuse("macros");
    if (oleHasEntry(buf, OLE_MACRO_ENTRIES, OLE_MACRO_NAME_BYTES)) return refuse("macros");
    const has = { word: buf.includes(OLE_STREAM.word), powerpoint: buf.includes(OLE_STREAM.powerpoint), excel: buf.includes(OLE_STREAM.excel) };
    const byStreams: "doc" | "ppt" | "xls" | null = has.word ? "doc" : has.powerpoint ? "ppt" : has.excel ? "xls" : null;
    if (extClaim === "doc" || extClaim === "ppt") {
      if (byStreams && byStreams !== extClaim && !has[extClaim === "doc" ? "word" : "powerpoint"]) return refuse("mismatch");
      return accept(extClaim);
    }
    if (extClaim) return refuse(isFormat(extClaim) ? "mismatch" : "unsupported");
    if (byStreams === "xls") return refuse("xls");
    if (byStreams) return accept(byStreams);
    if (byMime === "doc" || byMime === "ppt") return accept(byMime);
    return refuse("unsupported");
  } else if (/^(\xef\xbb\xbf)?\{\\rtf/u.test(buf.subarray(0, 16).toString("latin1"))) actual = "rtf";
  else if (head.includes("%PDF-", 0, "latin1")) actual = "pdf";

  if (claim === "macro") return refuse("macros");
  if (extClaim === "xls" && actual !== "xlsx") return refuse("xls");

  if (!actual) {
    if (claim === "pdf") return accept("pdf");
    if (claim === "csv") return looksBinary(buf) ? refuse("mismatch") : accept("csv");
    if (claim === "text" || claim === "markdown")
      return looksBinary(buf) ? refuse("unsupported") : { ok: true, kind: "text", mime: claim === "markdown" ? "text/markdown" : "text/plain" };
    if (claim === "xls") return refuse("xls");
    return refuse(claim && claim !== "other" && byExt === claim ? "mismatch" : "unsupported");
  }

  const extFormat = byExt && isFormat(byExt) ? byExt : null;
  if (extFormat && CONVERTER_FORMAT_KIND[extFormat] !== CONVERTER_FORMAT_KIND[actual]) return refuse("mismatch");
  if (extFormat === "csv" && actual !== "csv") return refuse("mismatch");
  if ((byExt === "text" || byExt === "markdown") && actual) return refuse("mismatch");
  return accept(actual);
}

const KIND_GROUPS: ReadonlyArray<[ConverterFormatKind, string]> = [["pdf", "PDF"], ["word", "Word"], ["powerpoint", "PowerPoint"], ["excel", "Excel"]];

export function acceptedFormatsLine(formats: readonly ConverterFormat[]): string {
  const parts: string[] = [];
  for (const [kind, title] of KIND_GROUPS) {
    const of = CONVERTER_FORMATS.filter((f) => formats.includes(f) && CONVERTER_FORMAT_KIND[f] === kind);
    if (!of.length) continue;
    parts.push(kind === "pdf" ? title : `${title} (${of.map((f) => f.toUpperCase()).join(", ")})`);
  }
  parts.push("text and markdown");
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, ${parts.at(-1)}` : parts[0]!;
}

const NOT_A: Readonly<Record<ConverterFormatKind | "csv", string>> = {
  pdf: "not a PDF", word: "not a Word document", powerpoint: "not a PowerPoint presentation", excel: "not an Excel spreadsheet", csv: "not a CSV file",
};

export function sniffRefusalText(r: Extract<SniffResult, { ok: false }> | { refusal: "unsupported" }, formats: readonly ConverterFormat[]): string {
  const can = `Accepted formats: ${acceptedFormatsLine(formats)}.`;
  switch (r.refusal) {
    case "macros": {
      const office = (["docx", "pptx", "xlsx"] as const).filter((f) => formats.includes(f));
      return `Files with macros are not accepted because they can contain executable code. Save the document without macros (${office.length ? `for example, as ${office.map((f) => `.${f}`).join(", ").replace(/, ([^,]*)$/u, " or $1")}` : "for example, as PDF"}) and upload it again.`;
    }
    case "encrypted": return "The file appears to be password-protected. Remove the password and upload it again.";
    case "xls": return `Older Excel spreadsheets (.xls) are not accepted. Save the spreadsheet as ${formats.includes("xlsx") ? ".xlsx" : formats.includes("csv") ? ".csv" : "PDF"} and upload it again.`;
    case "mismatch": {
      const m = r as Extract<SniffResult, { ok: false }>;
      return m.ext && m.named ? `The filename ends in .${m.ext}, but its content is ${NOT_A[m.named]}. Check the file and upload it again.`
        : `The file contents do not match the filename. Check the file and upload it again. ${can}`;
    }
    case "zip_bomb": return "The document inside is too large. Split it into parts and upload them again.";
    case "damaged": return "The file is damaged. Save a new copy and upload it again.";
    default: return `This file type is not accepted. ${can}`;
  }
}
