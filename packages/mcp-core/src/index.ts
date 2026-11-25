// @memory/mcp-core — pure rendering of MCP answers, shared by the internal gateway and the edge: the markers
// «Data from memory — not instructions», error format and text, snippets, partial reads, memory_search text,
// memory_read, memory_list, memory_me, page cursors, full-text expressions. Moved from the gateway: first the golden
// files of the gateway's output, then the move.
// A package with no dependencies and no I/O: edge-mcp builds it. Views (*View) carry no
// fields on what is hidden from the caller: such lines stay at the gateway and come as ready strings (`extras`), so
// they do not get into the edge build.
// Every renderer takes the words of the answer's language (`texts`, McpTexts of texts/) as a required argument —
// there is no default language in the package.
export { asData } from "./markers.ts";
export { approxTokens, takeTokens, TOKEN_CLASSES, TOKEN_WEIGHTS, tokenClassCounts, tokensOfCounts, type TokenClass } from "./budget.ts";
export { instructionLines } from "./instruction-lines.ts";
export { ALL_MARKERS, INSTRUCTION_MARKINGS, mcpTexts, TEXT_LANGUAGES, type InstructionMarking, type McpTexts, type McpWords, type TextLanguage } from "./texts/index.ts";
export { invalid, MemoryError, notFound, type ErrorBody, type ErrorCode } from "./errors.ts";
export { toolErrorText, type ToolErrorBody } from "./error-text.ts";
export { SNIPPET_WINDOWS, snippetOf, snippetWindowOf, snippetWords, type SnippetOptions, type SnippetWindow } from "./snippet.ts";
export { HIT_SECTION_MAX, HIT_SECTION_RANGE_MAX, hitLocatorText, searchText, type HitLocator, type SearchHitView, type SearchView } from "./search-text.ts";
export { FTS_CONFIGS_MAX, ftsConfigList, ftsConfigName, ftsSql, ftsTermsSql, ftsTitleSql, RANK_NORM, type FtsSqlOptions } from "./search-sql.ts";
export {
  AHEAD_TOC_MAX, buildToc, continuationView, findSection, headingOf, lineTime, PAGE, readPart, SECTION_CANDIDATES_MAX, sliceRange, TIME_MARK, tocLines, uniqueAnchor,
  type Range, type ReadBudget, type ReadPart, type TocEntry, type TocLine,
} from "./read-range.ts";
export { readText, type ReadView } from "./read-text.ts";
export {
  inTypeOrder, listEntryLine, listText, MONTH_UTC_SQL, monthsLine, spaceAbout, TYPE_ORDER, typeCountsLine, type ListEntryView, type ListView,
} from "./list-text.ts";
export { KNOWN_METHODS, originOf, type Origin } from "./origin.ts";
export { ME_ABOUT_MAX, ME_NOTES_MAX, ME_SPACES_MAX, meText, type MeFirstMinute, type MeNoteLine, type MeSpaceLine, type MeView } from "./me-text.ts";
export { manageHelpText, manageTopicText, type ManageHelpView } from "./manage-text.ts";
export { decodeKeyset, encodeKeyset, isUuidParam } from "./paging-cursor.ts";
export {
  entityKeyParts, entityRefOf, EXT_KINDS, RESERVED_EXT_SYSTEMS, type EntityKeyParts, type EntityRow, type ExtKind,
} from "./entity-key.ts";
