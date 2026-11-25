export type ParserFailureCode = "resource_limit" | "malformed_document" | "parser_failed";

export interface ParserInput {
  kind: string;
  file?: string;
  limits?: unknown;
}

export interface ParserJob extends ParserInput {
  bytes?: Uint8Array;
}

export interface ParserContext {
  maxResultBytes: number;
}

export type Parser = (job: ParserInput, ctx: ParserContext) => unknown;

export interface ParseRequest {
  type: "parse";
  id: number;
  job: ParserInput;
}

export type ChildPacket =
  | { type: "ready"; oomScoreAdjusted?: boolean }
  | { type: "result"; id: number; data: Buffer }
  | { type: "failure"; id: number; code: ParserFailureCode };

export function isFailureCode(value: unknown): value is ParserFailureCode {
  return value === "resource_limit" || value === "malformed_document" || value === "parser_failed";
}

export function isPacket(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
