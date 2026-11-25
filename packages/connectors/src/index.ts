// @memory/connectors — the connector SDK and the registry of built-in kinds. The conformance kit is a separate entry
// point: "@memory/connectors/testkit".
export * from "./sdk/types.ts";
export * from "./sdk/manifest.ts";
export * from "./sdk/items.ts";
export * from "./sdk/ctx.ts";
export * from "./sdk/entity-key.ts";
export { CONNECTORS_SCHEMA_BASE, connectorsContractDir, contractSchema } from "./sdk/contract.ts";
export * from "./registry.ts";
export { webhookConnector, webhookManifest, type WebhookConfig } from "./builtin/webhook/index.ts";
export {
  hitsOf, httpToolCaller, lookupQuery, lookupTool, lookupWith, mcpSourceConnector, mcpSourceManifest, oneLine, LOOKUP_LIMIT_MAX, LOOKUP_QUERY_MAX,
  LOOKUP_TITLE_MAX, MCP_CALL_MAX_BYTES, MCP_CALL_TIMEOUT_MS, MCP_PROTOCOL_VERSION, type McpAuth, type McpCallerCtx, type McpLookupTool,
  type McpSourceConfig, type McpToolCaller,
} from "./builtin/mcp-source/index.ts";
export * from "./net/egress.ts";
export * from "./secrets.ts";
export * from "./entities.ts";
export * from "./audit.ts";
export * from "./redact.ts";
// the diagnostic wall: only «project and write» functions, the dictionaries and the types — not the writer,
// the projection or an id minter
export {
  bindDiag, writeCoreDiag, CONNECTOR_LOG_EVENTS, CORE_DIAG_EVENTS, DIAG_ADMITTED_MAX, DIAG_BOUNDED, DIAG_COUNT_MAX, DIAG_MAX_BYTES,
  DIAG_MAX_FIELDS, DIAG_MS_MAX, DIAG_REFUSED, DIAG_REFUSED_MAX, LOG_REFUSED, MEASURES,
  type ConnectorLogEvent, type ConnectorLogFields, type CoreDiagEvent, type DiagBinding, type DiagOrigin, type Measure,
} from "./diag.ts";
export * from "./staging.ts";
export * from "./deletes.ts";
export * from "./delivery-codes.ts";
export * from "./sdk/errors.ts";
export * from "./run-codes.ts";
export * from "./sdk/signatures.ts";
// the one classification of exceptions; the marks (markCore, markDeclared) stay inside the package
export {
  DECLARABLE_CODES, DELIVERY_CODES, FAILURE_CLASSES, failureClass, RUN_CODES, runFailure, runFailureCode, testAnswerCode, type FailureClass,
} from "./failure.ts";
export * from "./oauth/index.ts";
