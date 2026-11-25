import { agentAuthProviders } from "./oauth.ts";
import { agentAuthMode } from "@memory/shared";
import { planTool, applyTool } from "./plans.ts";
import { correctTool } from "./corrections.ts";
// MCP Streamable HTTP at /mcp: the main revision 2026-07-28 without sessions; clients of older revisions — by the same
// SDK handler in legacy: 'stateless' mode. The key and Origin are checked BEFORE JSON-RPC: a wrong key is HTTP 401.
// The tool set is fixed by the key kind and built from contracts/mcp-tools.json, not by hand.
import { createMcpHandler, ProtocolError, Server } from "@modelcontextprotocol/server";
import { clientFromInfo, dispatcherActionsFor, dispatcherAvailable, leanCall, leanEntries, log, MANAGE_DISPATCHER, MANAGE_HELP_ACTION, MCP_OUTPUT_SCHEMAS_SETTING, MCP_RESPONSE_DETAIL_SETTING, mcpContract, mcpOutputSchemaMode, mcpResponseDetail, MemoryError, notFound, opOfTool, servedOutputSchema, SKILL_URI_PREFIX, skillFileByUri, validateToolInput, type ClaimedClient, type LeanEntry, type McpContract, type McpLanguage, type McpOutputSchemaMode, type McpResponseDetail, type McpToolsProfile, type ToolContract } from "@memory/shared";
import { mcpTexts, searchText as coreSearchText, toolErrorText as coreToolErrorText, type McpTexts } from "@memory/mcp-core";
import type { App, Caller } from "./context.ts";
import { authenticate, HttpReject, originAllowed } from "./auth.ts";
import { isExternal } from "./channel.ts";
import { readableSpaces } from "./access.ts";
import { audit } from "./audit.ts";
import { search } from "./search.ts";
import { readRecord } from "./read.ts";
import { list } from "./list.ts";
import { agentBaseUrl, me, processNow, rememberTool, upload } from "./write.ts";
import { byWordForbidden, close, deleteRecord, openByWord, openByWordCaller, promote, spaceAddMember, spaceCreate, spaceRemoveMember } from "./owner.ts";
import { meetingUploadTool } from "./uploads.ts";
import { healthState } from "./health.ts";
import { claimEligible, InitSeen, initializeReadable, pickClient, requestClaim } from "./claimed-client.ts";
import { instructionsFor, mcpLanguageOf, personWithTools, toolsProfileOf } from "./instructions.ts";
import { InstructionsServer } from "./instructions-server.ts";
import { registerSkillMcp } from "./skill-mcp.ts";
import { poolBusy } from "./control-lock.ts";
import { derivationHitMark } from "./derivation.ts";
import { instructionMarkingOf } from "./mcp-texts.ts";
import { shapeResult } from "./mcp-shape.ts";
import { manageCall } from "./mcp-manage.ts";
import { withToolHint } from "./mcp-hints.ts";

// RATE_LIMITED is a code of the JSON-RPC server range, "retry after retry_after": resources and the handshake have no result with
// isError, as tools do. data.code is rate_limited (the bucket limit) or in_progress (memory overloaded)
const INVALID_PARAMS = -32602, INTERNAL_ERROR = -32603, RESOURCE_NOT_FOUND = -32002, RATE_LIMITED = -32029;

/**
 * The control pool gave no connection in time (poolBusy) where there is no tool result (resources, the handshake):
 * JSON-RPC -32029 with data = the in_progress body (retry_after, details.reason overloaded), not "Internal error". Others as before.
 */
function busyRpc(e: unknown): never {
  const busy = poolBusy(e);
  if (busy) throw new ProtocolError(RATE_LIMITED, `in_progress: ${busy.message}`, busy.body());
  throw e;
}

/**
 * Hidden synonyms: the old tool name is still accepted, is not shown in tools/list and
 * is available exactly to those who may use the tool. Fields of the old schema that the new one lacks are removed before the
 * argument check and passed to the handler separately (immediately — "delete for good", only for a person in the workplace).
 */
const ALIASES: Record<string, { tool: string; legacy: string[] }> = { memory_forget: { tool: "memory_delete", legacy: ["immediately"] } };
/** Person-only tools: a service does not see them even with the operation in its allow-list (agent meetings ride a person key). */
const PERSON_ONLY = new Set(["memory_meeting_upload"]);
/**
 * Open on a person's word: only a cloud agent with a personal key (openByWordCaller). Workplace
 * sessions, the extended key, the script key and services are not shown the tool; a call is forbidden with a link, not
 * "unknown tool": so the agent learns that the person opens it. To the external agent address it is not
 * shown either, and a call is not_found without a link: there nothing is said about closed records.
 */
const BY_WORD_TOOL = "memory_open";

/**
 * The tool error text (contracts/mcp-tools.json, errors.format) — @memory/mcp-core toolErrorText over the error body
 * (err.body()): the first line `<code>: <message>`, then the hint, retry_after, the reason, a link to the workplace and
 * the same-named memory_read sections between data markers. The structured part of the answer is the same body (toolErrorResult).
 * Labels and markers — in the language of the answer (`texts`).
 */
export const toolErrorText = (err: MemoryError, texts: McpTexts): string => coreToolErrorText(err.body(), texts);

/**
 * The answer of a refused tools/call. With `tool` (the real tool, also for a dispatcher action) a refusal without a hint of its
 * own gets the hint of the table mcp-hints.ts in the language of `texts`, in the text and in structuredContent (for the
 * refusal rules that left the descriptions); the error object itself, REST and the workplace are not changed.
 */
export const toolErrorResult = (err: MemoryError, texts: McpTexts, tool?: string): { isError: true; content: { type: "text"; text: string }[]; structuredContent: ReturnType<MemoryError["body"]> } => {
  const body = withToolHint(tool, err.body(), texts.language);
  return { isError: true, content: [{ type: "text", text: coreToolErrorText(body, texts) }], structuredContent: body };
};

/** Tools of the key; `language` picks only the texts (titles, descriptions): names, schemas and groups are the same in every language. */
export function toolsFor(caller: Caller, language: McpLanguage = "en"): ToolContract[] {
  if (caller.principalType === "system") return [];            // the system key is admin API only: it has no MCP tools
  const all = mcpContract(language).tools.filter((t) => t.name !== BY_WORD_TOOL || openByWordCaller(caller));
  if (caller.principalType === "service") return all.filter((t) => t.group !== "owner" && !PERSON_ONLY.has(t.name) && caller.allowedOps!.has(opOfTool(t.name)));   // no owner tools for services
  return caller.allowedOps ? all.filter((t) => caller.allowedOps!.has(opOfTool(t.name)) || caller.allowedOps!.has(t.group)) : all;
}

/** access.mcp_output_schemas: open without a row or with an unknown value — the value of a new installation. */
export const outputSchemasOf = (app: Pick<App, "settings">): McpOutputSchemaMode =>
  mcpOutputSchemaMode(app.settings.get<unknown>(MCP_OUTPUT_SCHEMAS_SETTING, "open"));

/** access.mcp_response_detail: lean without a row or with an unknown value — the value of a new installation. */
export const responseDetailOf = (app: Pick<App, "settings">): McpResponseDetail =>
  mcpResponseDetail(app.settings.get<unknown>(MCP_RESPONSE_DETAIL_SETTING, "lean"));

/** The lean fields of a tool for the detail of this request: the contract's list in lean, none in full. */
export const leanOf = (contract: McpContract, tool: string, detail: McpResponseDetail): readonly LeanEntry[] =>
  detail === "lean" ? leanEntries(contract, tool) : [];

/**
 * A tool as tools/list serves it: the output schema in the mode of the setting — strict: the contract's schema
 * itself (the listing byte for byte as before), open: its tolerant view, none: no outputSchema. Answers are not changed:
 * structuredContent is sent in every mode, and server tests validate it against the contract's strict schemas. `lean`
 * — the fields a lean answer leaves out are no longer required in the served schema (empty: as before).
 */
export function listedTool(t: ToolContract, schemas: McpOutputSchemaMode, lean: readonly LeanEntry[] = []): Record<string, unknown> {
  const outputSchema = servedOutputSchema(t.outputSchema, schemas, lean);
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations: t.annotations };
}

export { toolsProfileOf };

/**
 * What tools/list shows of the permitted tools in a profile: full — all of them (the listing as before); core — the
 * tools of server.tool_profiles.core. Listing is not permission: toolsFor stays the permitted set (memory_me, instructions,
 * resources, the skill, tools/call), and a permitted tool that is not listed is still called by its name.
 */
export function listedTools(permitted: ToolContract[], profile: McpToolsProfile, contract: McpContract): ToolContract[] {
  if (profile === "full") return permitted;
  const core = new Set(contract.server.tool_profiles.core);
  return permitted.filter((t) => core.has(t.name));
}

/**
 * The dispatchers tools/list shows: none in the profile full; in core each dispatcher this caller may use
 * (dispatcherAvailable), as name, title, description, inputSchema, annotations — no outputSchema (the result is the real
 * tool's). The listed enum of `action` names only the caller's actions (memory_manage: help first); the contract keeps the
 * full enum, the input check reads it.
 */
export function listedDispatchers(contract: McpContract, names: readonly string[], profile: McpToolsProfile): Record<string, unknown>[] {
  if (profile === "full") return [];
  const acts = dispatcherActionsFor(contract, names);
  return contract.server.dispatchers.filter((d) => dispatcherAvailable(d.name, acts)).map((d) => {
    const inputSchema = structuredClone(d.inputSchema) as { properties: { action: { enum: string[] } } };
    inputSchema.properties.action.enum = d.name === MANAGE_DISPATCHER ? [MANAGE_HELP_ACTION, ...acts.manage] : [...acts.destructive];
    return { name: d.name, title: d.title, description: d.description, inputSchema, annotations: d.annotations };
  });
}

/** Numeric bounds are clamped to the allowed range: the contract and the tests disagree (max_tokens: 200). */
function clampArgs(tool: ToolContract, args: Record<string, unknown>): void {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; minimum?: number; maximum?: number }>;
  for (const [k, s] of Object.entries(props)) {
    const v = args[k];
    if (s.type !== "integer" || typeof v !== "number" || !Number.isFinite(v)) continue;
    args[k] = Math.round(Math.min(s.maximum ?? v, Math.max(s.minimum ?? v, v)));
  }
}

/**
 * The memory_search answer text — @memory/mcp-core searchText; a hit line's tail is the agent's retelling (see
 * derivationHitMark: source paths without titles).
 */
export function searchText(result: Awaited<ReturnType<typeof search>>, texts: McpTexts, canRead = true): string {
  return coreSearchText(result, { texts, hitTail: (h) => derivationHitMark(h.derivation), canRead });
}

// `texts` — the catalogue makeServer took with the tool texts: the handlers that render with mcp-core get it, so an answer and
// its error labels are in one language even when locale.mcp_language changes during the call
async function dispatch(app: App, caller: Caller, name: string, a: any, toolNames: string[], texts: McpTexts): Promise<{ result: unknown; text: string; lean?: Record<string, unknown> }> {
  switch (name) {
    case "memory_plan": return planTool(app, caller, a);
    case "memory_apply": return applyTool(app, caller, a);
    case "memory_search": {
      const result = await search(app, caller, a);
      // the line on how to read a hit only for a key that has memory_read
      return { result, text: searchText(result, texts, toolNames.includes("memory_read")) };
    }
    case "memory_read": return readRecord(app, caller, a, texts);
    case "memory_list": return list(app, caller, a, texts);
    case "memory_me": return me(app, caller, toolNames, { mcp: { texts } });      // the first-minute text and notes
    case "memory_remember": return rememberTool(app, caller, a);
    case "memory_upload": {
      let bytes: Buffer;
      try { bytes = Buffer.from(a.content_base64, "base64"); } catch { throw new MemoryError("invalid_argument", "Could not decode content_base64"); }
      return upload(app, caller, { ...a, bytes });
    }
    case "memory_process_now": { const r = await processNow(app, caller, a.id); return { result: r.result, text: r.text }; }
    case "memory_meeting_upload": return meetingUploadTool(app, caller, a);
    case "memory_space_create": return spaceCreate(app, caller, a);
    case "memory_space_add_member": return spaceAddMember(app, caller, a);
    case "memory_space_remove_member": return spaceRemoveMember(app, caller, a);
    case "memory_promote": return promote(app, caller, a);
    case "memory_close": return close(app, caller, a);
    case "memory_open": return openByWord(app, caller, a);
    case "memory_delete": return deleteRecord(app, caller, a, a.__alias ?? name);
    // not PERSON_ONLY — a service gets the tool only with the correct operation in its allow-list
    case "memory_correct": return correctTool(app, caller, a);
    default: throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
  }
}

/**
 * The request's program — at the start of each handler: clientInfo from the message's _meta wins over the fallback (from
 * initialize of an older revision or User-Agent, set by the buildMcp entry). Each message gets ITS OWN caller (a copy with its
 * program): the SDK parses an older revision's JSON-RPC batch (an array in one HTTP request) with handlers that do not wait for
 * each other, and a shared object would overwrite the first message's program with the second's before its event is written.
 * The tool event, rate_limited and resources all carry the copy. SDK 2.0.0 moves the reserved _meta keys
 * (protocolVersion, clientInfo, clientCapabilities) from req.params to ctx.mcpReq.envelope — req.params._meta lacks them now
 * (as measured).
 */
type Claim = { fallback: ClaimedClient | undefined; ua?: string; rev?: string } | null;

function makeServer(app: App, caller: Caller, claim: Claim): Server {
  // texts in the language of the setting locale.mcp_language (en by default): read per request, a change needs no restart
  const language = mcpLanguageOf(app), contract = mcpContract(language), tools = toolsFor(caller, language), names = tools.map((t) => t.name);
  // words of the answers of this request, of the same reading of the setting as the tool texts: the error labels and
  // the handlers dispatch gives it to (search, read, list) — one answer, one language
  const texts = mcpTexts(language, instructionMarkingOf(app));
  // output schemas of tools/list, read with the texts: the server is built per request, so a change needs no restart
  const schemas = outputSchemasOf(app);
  // tool profile of tools/list, read with them: core — the core tools and the dispatchers, full — every permitted tool
  const profile = toolsProfileOf(app);
  // detail of the structured answers, read with them: lean — the fields of server.response_detail.lean are left out
  // of structuredContent and are not required in the served output schemas; full — every field, as REST returns it
  const detail = responseDetailOf(app);
  const own = (req: any, ctx: any): Caller =>
    claim ? { ...caller, claimedClient: pickClient(ctx?.mcpReq?.envelope ?? req?.params?._meta, claim.fallback, claim) } : caller;
  const server = new InstructionsServer(
    { name: contract.server.name, title: contract.server.title, version: contract.server.version },
    {
      // prompts: the install-skill prompt; extensions: Skills (SEP-2640): skills/list and skills/get (0.12.0, skill-mcp.ts)
      capabilities: { tools: {}, resources: {}, prompts: {}, extensions: { [contract.server.skills.extension]: contract.server.skills.settings } },
      instructions: contract.server.instructions.core,
      cacheHints: {
        "server/discover": { ttlMs: 60_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" }, "resources/list": { ttlMs: 60_000, cacheScope: "private" },
        "prompts/list": { ttlMs: 300_000, cacheScope: "private" },
        "resources/templates/list": { ttlMs: 300_000, cacheScope: "private" }, "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    }, () => instructionsFor(app, caller, names).catch(busyRpc));

  server.setRequestHandler("tools/list", async () => ({
    tools: [...listedTools(tools, profile, contract).map((t) => listedTool(t, schemas, leanOf(contract, t.name, detail))), ...listedDispatchers(contract, names, profile)],
  }) as any);

  /**
   * One tools/call: the direct call of a tool by name and an action of a dispatcher (`via: "manage"`) go through this
   * body — the same permitted set, the memory_open rule, argument checks, limiter bucket, dispatch, log and audit under the
   * real tool name. `via` goes into the process log only; the audit rows of both paths are the same.
   */
  const callTool = async (who: Caller, asked: string, rawArgs: unknown, via?: "manage"): Promise<any> => {
    const alias = ALIASES[asked], name = alias?.tool ?? asked, tool = tools.find((t) => t.name === name);
    const tag = via ? { via } : {};
    if (!tool && asked === BY_WORD_TOOL && who.principalType !== "system") {
      // memory_open for the wrong key: refused as forbidden with a link to the record — the person opens it in the workplace;
      // for the external agent address — not_found, as for a missing record
      const id = rawArgs !== null && typeof rawArgs === "object" ? (rawArgs as { id?: unknown }).id : undefined;
      const err = isExternal(who) ? notFound()
        : byWordForbidden(app, typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null, "key");
      log.info("tool_call", { tool: asked, ms: 0, ok: false, code: err.code, ...tag });
      return toolErrorResult(err, texts, asked) as any;
    }
    if (!tool) throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${asked}`);   // incl. a tool outside the key's group
    const started = Date.now();
    try {
      const args = structuredClone(rawArgs ?? {}) as Record<string, unknown>;
      const legacy: Record<string, unknown> = {};
      for (const k of alias?.legacy ?? []) if (k in args) { legacy[k] = args[k]; delete args[k]; }
      clampArgs(tool, args);
      const v = validateToolInput(name, args);
      if (!v.ok) throw new MemoryError("invalid_argument", v.message);
      if (name !== "memory_process_now" && name !== "memory_apply") app.limiter.check(who, name);          // process_now checks its limit after the rights check
      const out = await dispatch(app, who, name, alias ? { ...args, ...legacy, __alias: asked } : args, names, texts);
      log.info("tool_call", { tool: name, ms: Date.now() - started, ok: true, ...tag });
      // the structured answer for agents (data notice and instruction-like flags; lean fields left out unless
      // the call keeps them — include, range, a cut answer; plus the fields only a lean answer carries, out.lean) — REST
      // and the workplace keep out.result
      const lean = leanOf(contract, name, detail);
      return { content: [{ type: "text", text: out.text }],
               structuredContent: shapeResult(name, out.result, texts, lean.length ? { entries: lean, call: leanCall(args, out.result), ...(out.lean ? { extra: out.lean } : {}) } : undefined) } as any;
    } catch (e0) {
      if (e0 instanceof ProtocolError) throw e0;
      const e = poolBusy(e0) ?? e0;             // the control pool gave no connection in time — "retry"
      if (!(e instanceof MemoryError)) {
        // an unexpected failure is not the caller's "argument error": an honest internal protocol error, no details outside
        log.error("tool_internal_error", { tool: name, error: ((e as Error)?.message ?? "").slice(0, 300), ...tag });
        throw new ProtocolError(INTERNAL_ERROR, "Internal error");
      }
      const err = e;
      log.info("tool_call", { tool: name, ms: Date.now() - started, ok: false, code: err.code, ...tag });
      if (err.code === "rate_limited") void audit(app, who, { event_type: "rate_limited", details: { tool: name } });   // audited too
      return toolErrorResult(err, texts, name) as any;
    }
  };

  // the dispatchers of the tool profile core: answered in every profile, but only for a key that may call one of
  // their actions — for any other key the name stays unknown, as before (the profile is not read on the call path)
  const actions = dispatcherActionsFor(contract, names);
  server.setRequestHandler("tools/call", async (req: any, ctx: any) => {
    const who = own(req, ctx), asked = req.params?.name;
    const d = contract.server.dispatchers.find((x) => x.name === asked);
    if (d && dispatcherAvailable(d.name, actions))
      return manageCall({ app, texts, contract, names, callTool, errorResult: (e) => toolErrorResult(e, texts) }, who, d, req.params?.arguments);
    return callTool(who, asked, req.params?.arguments);
  });

  // Resources are the same operations as memory_list / memory_read: the same key allow-list and the same limit buckets.
  // Before, they looked at neither: a service "on behalf" with only ingest_transcripts read the closed records
  // of a person.
  const resourceLimit = (who: Caller, tool: "memory_list" | "memory_read" | "memory_me") => {
    try { app.limiter.check(who, tool); }
    catch (e) {
      if (!(e instanceof MemoryError) || e.code !== "rate_limited") throw e;
      void audit(app, who, { event_type: "rate_limited", details: { tool, via: "resources" } });
      throw new ProtocolError(RATE_LIMITED, `rate_limited: ${e.message}`, e.body());
    }
  };
  const resourceGate = (who: Caller, tool: "memory_list" | "memory_read") => {
    if (!names.includes(tool)) throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found");   // as a missing object, no hint about rights
    resourceLimit(who, tool);
  };
  server.setRequestHandler("resources/list", async (req: any, ctx: any) => {
    const who = own(req, ctx);
    if (!names.includes("memory_list")) return { resources: [] } as any;
    resourceGate(who, "memory_list");
    const spaces = [...(await readableSpaces(app, who).catch(busyRpc)).values()];
    return { resources: [
      contract.server.resources.root,
      ...spaces.map((s) => ({ uri: `memory://spaces/${s.slug}`, name: s.slug, title: s.name, mimeType: "text/markdown" })),
      ...contract.server.resources.static,
    ] } as any;
  });
  // The skill over MCP (0.12.0): the same right and bucket as the skill's resources/read above; the prompt only for a person
  registerSkillMcp(server, {
    language, allowed: names.length > 0, person: personWithTools(caller, names), clientKind: caller.clientKind,
    limit: (req, ctx) => resourceLimit(own(req, ctx), "memory_me"),
    publicBase: () => agentBaseUrl(app, caller),
  });
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: contract.server.resources.templates }) as any);
  server.setRequestHandler("resources/read", async (req: any, ctx: any) => {
    const who = own(req, ctx);
    const uri: string = req.params?.uri ?? "";
    if (uri.startsWith(SKILL_URI_PREFIX)) {
      // The skill holds no records: the right is any non-empty tool set, regardless of memory_me in the allow-list.
      // The existing small memory_me bucket keeps the administrator's setting and the standard error -32029. Besides the core —
      // the reference files references/*: a file is looked up only in the skill folder's list, the address is not glued together.
      if (!names.length) throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found");
      const file = skillFileByUri(uri);
      if (!file) throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found");
      resourceLimit(who, "memory_me");
      return { contents: [{ uri, mimeType: "text/markdown", text: Buffer.from(file.bytes).toString("utf8") }] };
    }
    if (!uri.startsWith("memory://")) throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found");
    const path = "/" + uri.slice("memory://".length).replace(/^\/+/, "");
    // a thin wrapper over the same functions: the same rights checks and data markers
    const isRecord = /^\/spaces\/[^/]+\/[^/]+\/\d{4}\/\d{2}\/[0-9a-fA-F-]{36}$/.test(path);
    resourceGate(who, isRecord ? "memory_read" : "memory_list");
    try {
      // the catalogue of this request (language and marking read once, with the tool texts)
      const out = isRecord ? await readRecord(app, who, { path }, texts) : await list(app, who, { path }, texts);
      return { contents: [{ uri, mimeType: "text/markdown", text: out.text }] } as any;
    } catch (e) {
      if (e instanceof MemoryError) throw new ProtocolError(RESOURCE_NOT_FOUND, "Resource not found");
      return busyRpc(e);
    }
  });
  return server;
}


/** clientInfo from initialize of older revisions: per gateway process, by the pair (key, User-Agent token). */
export const initSeen = new InitSeen();

/**
 * initialize of an older revision: after the key check — a wrong key does not fill the cache; the body is read
 * from a copy only if it is small (initializeReadable) — a big and chunked body (memory_upload) is not cloned.
 */
async function rememberInitialize(req: Request, caller: Caller, uaName: string): Promise<void> {
  if (!initializeReadable(req.headers)) return;
  let body: any;
  try { body = await req.clone().json(); } catch { return; }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.method !== "initialize") return;
  const c = clientFromInfo(body.params?.clientInfo, "initialize", {});
  if (c) initSeen.remember(caller.keyId, uaName, { name: c.name, ...(c.version ? { version: c.version } : {}) });
}

/**
 * Body bound of the SDK handler (its default is 4 MiB). The /mcp body is limited before it by the upload body limit
 * (http.ts, rest.ts uploadBodyLimit), which follows limits.upload_max_bytes; this bound is that limit at the setting's
 * largest allowed value (20 MiB), so memory_upload with content_base64 is never cut by the SDK below the gateway limit.
 */
export const MCP_SDK_BODY_MAX = Math.ceil(20 * 1024 * 1024 * 1.4) + 1_048_576;

export function buildMcp(app: App): (req: Request, remoteAddress?: string | null) => Promise<Response> {
  const handler = createMcpHandler((ctx) => {
    const extra = ctx.authInfo!.extra as { caller: Caller; claim: Claim };
    return makeServer(app, extra.caller, extra.claim);
  }, {
    legacy: "stateless", responseMode: "json", maxRequestBodySize: MCP_SDK_BODY_MAX,
    onerror: (e) => log.warn("mcp_error", { error: e.message.slice(0, 200) }),
  });
  // WWW-Authenticate on 401 by the agent sign-in mode (mcpChallenge, oauth.ts): external — the identity provider one as before
  const json = (status: number, body: unknown, challenge: string | null = null) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(challenge ? { "WWW-Authenticate": challenge } : {}) } });
  const serve = async (req: Request, remoteAddress: string | null): Promise<Response> => {
    if (!originAllowed(app, req)) return json(403, { code: "forbidden", message: "Origin is outside the allowlist" });
    let caller: Caller;
    try { caller = { ...(await authenticate(app, req, remoteAddress)), transport: "mcp" }; }   // details.via of the write event
    catch (e) {
      if (e instanceof HttpReject) return json(e.status, { code: e.code, message: e.message }, e.status === 401 ? await agentAuthProviders.agent(agentAuthMode(app.settings)).challenge(app, { tokenPresented: e.tokenPresented }) : null);
      throw e;
    }
    const health = await healthState(app);
    if (health.status === "fail_closed") return json(503, { code: "forbidden", message: "The installation is not serving requests: required settings are missing or checks failed (fail-closed)" });
    // the client program: the fallback is clientInfo from this key's initialize and User-Agent, else the first token
    // of User-Agent (auth.ts); the handler sets clientInfo from the request's _meta. Sessions, system key, preview get nothing
    let claim: Claim = null;
    if (claimEligible(caller)) {
      const r = requestClaim(req.headers);
      await rememberInitialize(req, caller, r.uaName);
      const init = initSeen.recall(caller.keyId, r.uaName);
      claim = { fallback: init ? { ...init, source: "initialize", ...(r.ua ? { ua: r.ua } : {}), ...(r.rev ? { rev: r.rev } : {}) } : caller.claimedClient, ua: r.ua, rev: r.rev };
      caller.claimedClient = claim.fallback;
    } else caller.claimedClient = undefined;
    return handler.fetch(req, { authInfo: { token: "", clientId: caller.keyId, scopes: [], extra: { caller, claim } } });
  };
  // The entry before JSON-RPC (key — auth.ts, fail-closed check — health.ts) goes to control on each request. The pool gave no
  // connection in time — 409 in_progress with Retry-After, as in REST, not a bare 500 from Hono; the rest as before
  return async (req, remoteAddress = null) => {
    try { return await serve(req, remoteAddress); }
    catch (e) {
      const busy = poolBusy(e);
      if (!busy) throw e;
      return new Response(JSON.stringify(busy.body()), { status: busy.status, headers: { "content-type": "application/json", "Retry-After": String(busy.extra.retry_after ?? 5) } });
    }
  };
}
