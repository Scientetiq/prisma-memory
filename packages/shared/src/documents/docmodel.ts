import type { ConversionUnit } from "./engine.ts";

type UnitKind = ConversionUnit["kind"];
type NonEmpty<T> = readonly [T, ...T[]];

export type DocModel = {
  containers: NonEmpty<PageContainer> | NonEmpty<SlideContainer> | NonEmpty<SheetContainer> | readonly [FileContainer];
};

// Open question: source order and increasing numbers are described without a structural assertion.
// Open question: the prose calls for hidden metadata, but the schema and examples allow omission.
export type Container = PageContainer | SlideContainer | SheetContainer | FileContainer;

type ContainerFields = {
  method: ConversionUnit["method"];
  warnings?: readonly string[];
};

type PageOrFileFields = ContainerFields & {
  hidden?: false;
  title?: never;
  blocks: readonly Exclude<Block, SpeakerNotes>[];
};

type PageContainer = PageOrFileFields & { kind: "page"; number: number };
type FileContainer = PageOrFileFields & { kind: "file"; number: null };

// Open question: the contract forbids repeating a title as a heading without defining how to identify a repeat.
type SlideContainer = ContainerFields & {
  kind: "slide";
  number: number;
  hidden?: boolean;
  title?: string | null;
  blocks: readonly Block[];
};

type SheetContainer = ContainerFields & {
  kind: "sheet";
  number: number;
  hidden?: boolean;
  title: string;
  blocks: readonly Exclude<Block, SpeakerNotes>[];
};

export type Block = Heading | Paragraph | List | Table | Figure | SpeakerNotes | Note;
export type RichText = string | NonEmpty<string | NoteRef>;
export type NoteId = string;

// Open question: note lookup and uniqueness are semantic checks outside the structural schema.
export type NoteRef = { note_ref: NoteId };

export type Heading = { type: "heading"; level: number; text: RichText };
export type Paragraph = { type: "paragraph"; text: RichText };
export type List = { type: "list"; ordered: boolean; items: NonEmpty<ListItem> };
export type ListItem = { text: RichText; items?: NonEmpty<ListItem> };

// Open question: table flags have no format or width constraints in the schema; marker placement is for the renderer.
export type Table = { type: "table"; header_row: boolean; rows: NonEmpty<Row>; hidden_columns?: readonly number[] };
export type Row = { cells: readonly RichText[]; hidden?: boolean };

// Open question: the schema limits caption length without enforcing the prose's trimming rule.
export type Figure = { type: "figure"; caption: string | null };

// Open question: speaker-note placement and cardinality are described without a structural assertion.
export type SpeakerNotes = { type: "speaker_notes"; paragraphs: NonEmpty<string> };

export type Note = { type: "note"; note_kind: "footnote" | "endnote"; id: NoteId; text: RichText };

type Code = "missing" | "type" | "enum" | "range" | "unknown";
type Position = { path: string; depth: number };
type Check = (value: unknown, at: Position) => void;
type Fields = Readonly<Record<string, Check | null>>;

const MAX_FINDINGS = 100;
const MAX_DEPTH = 64;
const UNIT_KINDS: readonly UnitKind[] = ["page", "slide", "sheet", "file"];
const METHOD = /^(?:[a-z][a-z0-9_]{0,63})?$/u;
const WARNING = /^[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9_.+/-]{1,64})?$/u;
const NOTE_ID = /^[A-Za-z0-9_-]{1,32}$/u;

function child(at: Position, key: string | number): Position {
  const depth = at.depth + 1;
  if (typeof key === "number") return { path: at.path + "[" + key + "]", depth };
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return { path: at.path === "$" ? key : at.path + "." + key, depth };
  }
  return { path: at.path + "[" + JSON.stringify(key) + "]", depth };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnitKind(value: unknown): value is UnitKind {
  return UNIT_KINDS.some((kind) => kind === value);
}

export function docModelProblems(value: unknown): string[] {
  const problems: string[] = [];

  function full(): boolean {
    return problems.length >= MAX_FINDINGS;
  }

  function report(at: Position, code: Code): void {
    if (!full()) problems.push(at.path + ": " + (at.depth > MAX_DEPTH ? "range" : code));
  }

  function visit(value: unknown, at: Position, check: Check): void {
    if (full()) return;
    if (at.depth > MAX_DEPTH) {
      report(at, "range");
      return;
    }
    try {
      check(value, at);
    } catch {
      // Reflection on a non-JSON value can throw, for example on a revoked proxy.
      report(at, "type");
    }
  }

  function member(source: object, at: Position, key: string | number, check: Check, required = true): void {
    if (full()) return;
    const location = child(at, key);
    let property: PropertyDescriptor | undefined;
    try {
      property = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      report(location, "type");
      return;
    }
    if (!property?.enumerable) {
      if (required) report(location, "missing");
      return;
    }
    if (!Object.hasOwn(property, "value")) {
      report(location, "type");
      return;
    }
    visit(property.value, location, check);
  }

  function fields(source: object, at: Position, required: Fields, optional: Fields = {}): void {
    for (const [key, check] of Object.entries(required)) {
      if (check) member(source, at, key, check);
    }
    for (const [key, check] of Object.entries(optional)) {
      if (check) member(source, at, key, check, false);
    }
    if (full()) return;
    for (const key in source) {
      if (full()) break;
      if (Object.hasOwn(source, key) && !Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) {
        report(child(at, key), "unknown");
      }
    }
  }

  function array(
    value: unknown, at: Position, item: (value: unknown, at: Position, length: number) => void, min = 0,
  ): void {
    if (!Array.isArray(value)) {
      report(at, "type");
      return;
    }
    const length = value.length;
    if (!Number.isInteger(length) || length < 0 || length > 2 ** 32 - 1) {
      report(at, "type");
      return;
    }
    if (length < min) report(at, "range");
    const check: Check = (value, at) => item(value, at, length);
    for (let index = 0; index < length && !full(); index++) {
      member(value, at, index, check);
    }
  }

  function integer(value: unknown, at: Position, min: number, max = Infinity): value is number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      report(at, "type");
      return false;
    }
    if (value < min || value > max) {
      report(at, "range");
      return false;
    }
    return true;
  }

  function boolean(value: unknown, at: Position): void {
    if (typeof value !== "boolean") report(at, "type");
  }

  function nonEmptyString(value: unknown, at: Position): void {
    if (typeof value !== "string") report(at, "type");
    else if (value.length === 0) report(at, "range");
  }

  function nullableString(value: unknown, at: Position): void {
    if (value !== null) nonEmptyString(value, at);
  }

  function pattern(value: unknown, at: Position, grammar: RegExp): void {
    if (typeof value !== "string") report(at, "type");
    else if (!grammar.test(value)) report(at, "range");
  }

  function noteId(value: unknown, at: Position): void {
    pattern(value, at, NOTE_ID);
  }

  function richText(value: unknown, at: Position): void {
    if (typeof value === "string") return;
    array(value, at, (run, location) => {
      if (typeof run === "string") return;
      if (isObject(run)) fields(run, location, { note_ref: noteId });
      else report(location, "type");
    }, 1);
  }

  function listItems(value: unknown, at: Position): void {
    array(value, at, (item, location) => {
      if (isObject(item)) fields(item, location, { text: richText }, { items: listItems });
      else report(location, "type");
    }, 1);
  }

  function rows(value: unknown, at: Position): void {
    array(value, at, (row, location) => {
      if (isObject(row)) {
        fields(row, location, { cells: (value, at) => array(value, at, richText) }, { hidden: boolean });
      } else {
        report(location, "type");
      }
    }, 1);
  }

  function columnIndexes(value: unknown, at: Position): void {
    const seen = new Set<number>();
    array(value, at, (index, location) => {
      if (!integer(index, location, 0)) return;
      if (seen.has(index)) report(location, "range");
      seen.add(index);
    });
  }

  function block(value: unknown, at: Position, kind: UnitKind | undefined): void {
    if (!isObject(value)) {
      report(at, "type");
      return;
    }
    member(value, at, "type", (type, location) => {
      switch (type) {
        case "heading":
          fields(value, at, { type: null, level: (v, p) => integer(v, p, 1, 6), text: richText });
          break;
        case "paragraph":
          fields(value, at, { type: null, text: richText });
          break;
        case "list":
          fields(value, at, { type: null, ordered: boolean, items: listItems });
          break;
        case "table":
          fields(value, at, { type: null, header_row: boolean, rows }, { hidden_columns: columnIndexes });
          break;
        case "figure":
          fields(value, at, { type: null, caption: nullableString });
          break;
        case "speaker_notes":
          if (kind !== undefined && kind !== "slide") report(location, "enum");
          fields(value, at, { type: null, paragraphs: (v, p) => array(v, p, nonEmptyString, 1) });
          break;
        case "note":
          fields(value, at, {
            type: null,
            note_kind: (v, p) => {
              if (v !== "footnote" && v !== "endnote") report(p, "enum");
            },
            id: noteId,
            text: richText,
          });
          break;
        default:
          report(location, "enum");
      }
    });
  }

  function container(value: unknown, at: Position, onKind: (kind: UnitKind, at: Position) => void): void {
    if (!isObject(value)) {
      report(at, "type");
      return;
    }
    let kind: UnitKind | undefined;
    member(value, at, "kind", (value, location) => {
      if (isUnitKind(value)) {
        kind = value;
        onKind(kind, location);
      } else {
        report(location, "enum");
      }
    });

    const canHide = kind !== "page" && kind !== "file";
    const required: Fields = {
      kind: null,
      number: (value, at) => {
        if (kind === "file") {
          if (value !== null) report(at, "type");
        } else if (kind !== undefined || value !== null) {
          integer(value, at, 1);
        }
      },
      method: (value, at) => pattern(value, at, METHOD),
      blocks: (value, at) => array(value, at, (value, at) => block(value, at, kind)),
      ...(kind === "sheet" ? { title: nonEmptyString } : {}),
    };
    const optional: Fields = {
      hidden: (value, at) => {
        if (typeof value !== "boolean") report(at, "type");
        else if (!canHide && value) report(at, "enum");
      },
      warnings: (value, at) => array(value, at, (value, at) => pattern(value, at, WARNING)),
      ...(canHide && kind !== "sheet" ? { title: nullableString } : {}),
    };
    fields(value, at, required, optional);
  }

  function containers(value: unknown, at: Position): void {
    let firstKind: UnitKind | undefined;
    array(value, at, (value, location, length) => {
      container(value, location, (kind, kindAt) => {
        if (firstKind === undefined) {
          firstKind = kind;
          if (kind === "file" && length > 1) report(at, "range");
        } else if (firstKind !== kind) {
          report(kindAt, "enum");
        }
      });
    }, 1);
  }

  visit(value, { path: "$", depth: 0 }, (value, at) => {
    if (isObject(value)) fields(value, at, { containers });
    else report(at, "type");
  });
  return problems;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function textChars(text: RichText): number {
  if (typeof text === "string") return codePoints(text);
  let count = 0;
  for (const run of text) {
    if (typeof run === "string") count += codePoints(run);
  }
  return count;
}

function listChars(items: NonEmpty<ListItem>): number {
  const pending = [items];
  let count = 0;
  while (pending.length > 0) {
    for (const item of pending.pop()!) {
      count += textChars(item.text);
      if (item.items) pending.push(item.items);
    }
  }
  return count;
}

function blockChars(block: Block): number {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "note":
      return textChars(block.text);
    case "list":
      return listChars(block.items);
    case "table":
      return block.rows.reduce((count, row) => count + row.cells.reduce((n, cell) => n + textChars(cell), 0), 0);
    case "speaker_notes":
      return textChars(block.paragraphs);
    case "figure":
      return 0;
  }
}

// Open question: the model has no provenance field for engine-generated placeholders or notes.
export function docModelChars(model: DocModel): number[] {
  return model.containers.map((container) => {
    const title = container.kind === "slide" ? container.title : undefined;
    return container.blocks.reduce((count, block) => count + blockChars(block), codePoints(title ?? ""));
  });
}
