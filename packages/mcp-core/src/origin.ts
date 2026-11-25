// Record origin in MCP answers (field origin of memory_search, memory_read, memory_list): not the records.origin column
// (the database holds only human and agent) but derived from the acquisition method, as the internal gateway does. A
// single function for gateway and edge: the edge showed the column as is, and a document from outside
// looked «said by a person».

export type Origin = "document" | "human" | "model" | "agent";

/** Acquisition method (acquisition_method, 02-records.sql) → origin in the answer. */
const BY_METHOD: ReadonlyMap<string, Origin> = new Map<string, Origin>([
  ["source_document", "document"],
  ["stated_by_human", "human"],
  ["extracted_by_model", "model"],
  ["inferred_by_agent", "agent"],
]);

/** Acquisition methods the renderer knows (a test checks them against the acquisition_method enum). */
export const KNOWN_METHODS: readonly string[] = [...BY_METHOD.keys()];

/** Record origin by acquisition method; an unknown or empty method — agent (the careful side: not «said by a person»). */
export const originOf = (method: string | null | undefined): Origin => BY_METHOD.get(method ?? "") ?? "agent";
