import { isUtf8 } from "node:buffer";

type Delimiter = "," | ";";

export type CsvParsed = {
  delimiter: Delimiter;
  rows: string[][];
  truncated: boolean;
  bom: boolean;
  invalidUtf8: boolean;
};

type Cursor = { field: "start" | "unquoted" | "quoted" | "afterQuote" };
type Token = "text" | "omitQuote" | "separator" | "record";

function advance(cursor: Cursor, character: string, separator: boolean): Token {
  if (cursor.field === "quoted") {
    if (character !== '"') return "text";
    cursor.field = "afterQuote";
    return "omitQuote";
  }
  if (cursor.field === "afterQuote" && character === '"') {
    cursor.field = "quoted";
    return "text";
  }
  if (separator) {
    cursor.field = "start";
    return "separator";
  }
  if (character === "\r" || character === "\n") {
    cursor.field = "start";
    return "record";
  }
  if (cursor.field === "start" && character === '"') {
    cursor.field = "quoted";
    return "omitQuote";
  }
  cursor.field = "unquoted";
  return "text";
}

type Reader = Cursor & {
  delimiter: Delimiter;
  maxRows: number;
  maxColumns: number;
  rows: string[][];
  row: string[];
  parts: string[];
  from: number;
  truncated: boolean;
  columnsTruncated: boolean;
};

function createReader(delimiter: Delimiter, maxRows: number, maxColumns: number, from: number): Reader {
  return {
    delimiter, maxRows, maxColumns, field: "start", rows: [], row: [], parts: [], from,
    truncated: false, columnsTruncated: false,
  };
}

function keepSpan(reader: Reader, text: string, to: number): void {
  if (reader.from < to && reader.row.length < reader.maxColumns) reader.parts.push(text.slice(reader.from, to));
}

function finishField(reader: Reader): void {
  if (reader.row.length < reader.maxColumns) reader.row.push(reader.parts.join(""));
  else reader.columnsTruncated = true;
  reader.parts.length = 0;
}

function readCharacter(reader: Reader, text: string, index: number, character: string, followsCr: boolean): void {
  if (reader.truncated) return;
  if (followsCr && reader.field !== "quoted") {
    reader.from = index + 1;
    return;
  }
  if (reader.rows.length === reader.maxRows) {
    reader.truncated = true;
    return;
  }

  const token = advance(reader, character, character === reader.delimiter);
  if (token === "text") return;
  keepSpan(reader, text, index);
  reader.from = index + 1;
  if (token === "omitQuote") return;

  finishField(reader);
  if (token === "record") {
    reader.rows.push(reader.row);
    reader.row = [];
  }
}

// Open question: where the engine supplies the CSV row limit.
// The column limit is supplied by the engine beside the row limit; fields beyond it are read past, not stored.
export function parseCsv(bytes: Uint8Array, { maxRows, maxColumns }: { maxRows: number; maxColumns: number }): CsvParsed {
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new RangeError();
  if (!Number.isInteger(maxColumns) || maxColumns < 1) throw new RangeError();

  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const invalidUtf8 = !isUtf8(bytes);
  const text = new TextDecoder().decode(bytes);

  // Defer leading empty records so a file consisting entirely of line endings yields no rows.
  let index = 0;
  let leadingRows = 0;
  while (text[index] === "\r" || text[index] === "\n") {
    const end = text[index++];
    if (end === "\r" && text[index] === "\n") index++;
    leadingRows++;
  }
  if (index === text.length) {
    return { delimiter: ",", rows: [], truncated: false, bom, invalidUtf8 };
  }

  let reader = createReader(",", maxRows, maxColumns, index);
  for (let row = 0; row < Math.min(leadingRows, maxRows); row++) reader.rows.push([""]);

  // During the first record, count both separators at unquoted boundaries and track both readings.
  // Each reader uses its own separator, so a quote after the other separator can remain literal.
  let probe: (Cursor & { semicolon: Reader; commas: number; semicolons: number }) | undefined;
  if (leadingRows === 0) {
    probe = { field: "start", semicolon: createReader(";", maxRows, maxColumns, index), commas: 0, semicolons: 0 };
  }
  for (; index < text.length; index++) {
    const character = text[index];
    const followsCr = character === "\n" && text[index - 1] === "\r";
    readCharacter(reader, text, index, character, followsCr);
    if (probe) {
      readCharacter(probe.semicolon, text, index, character, followsCr);
      const token = advance(probe, character, character === "," || character === ";");
      if (token === "separator") {
        if (character === ",") probe.commas++;
        else probe.semicolons++;
      } else if (token === "record") {
        if (probe.semicolons > probe.commas) reader = probe.semicolon;
        probe = undefined;
      }
    }
    if (!probe && reader.truncated) break;
  }
  if (probe && probe.semicolons > probe.commas) reader = probe.semicolon;

  if (!reader.truncated && (reader.field !== "start" || reader.row.length > 0)) {
    keepSpan(reader, text, text.length);
    finishField(reader);
    reader.rows.push(reader.row);
  }
  const truncated = reader.truncated || reader.columnsTruncated;
  return { delimiter: reader.delimiter, rows: reader.rows, truncated, bom, invalidUtf8 };
}

export function csvTable(parsed: CsvParsed): { markdown: string; chars: number; warnings: string[] } {
  const { rows, truncated } = parsed;
  const warnings = truncated ? ["table_truncated"] : [];
  if (rows.length === 0) return { markdown: "", chars: 0, warnings };

  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);

  let chars = 0;
  const lines: string[] = [];
  for (const [index, row] of rows.entries()) {
    const cells: string[] = [];
    for (let column = 0; column < width; column++) {
      const cell = row[column] ?? "";
      // Section 2.2 counts the source Unicode code points before formatting.
      for (const _ of cell) chars++;

      // Open question: escaping and whitespace normalization for CSV cells in pipe tables.
      const value = cell.replace(/[\r\n]+/g, " ").trim().replaceAll("|", "\\|");
      cells.push(` ${value} `);
    }
    lines.push(`|${cells.join("|")}|`);

    // Open question: how a CSV without an explicit header should be rendered.
    if (index === 0) lines.push(`|${"---|".repeat(width)}`);
  }
  return { markdown: lines.join("\n") + "\n", chars, warnings };
}
