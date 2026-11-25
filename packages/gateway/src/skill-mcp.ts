// The skill over MCP: the Skills extension (SEP-2640) — `skills/list`, `skills/get` — and the prompt
// `install-skill` (`prompts/list`, `prompts/get`). The skill files are still read by `resources/read` (mcp.ts); here —
// only the skill entry with sums and the install phrase. Rights for skills/* — as for reading the skill: a key with at least one
// MCP tool, the limit is the memory_me bucket. The prompt — only to a person, like the "Skill archive" row in the instructions: a
// service (the shared OBO session token) has no computer to put rules on. MCP cannot write to the client's disk: the local copy
// is set up by the agent from the phrase, with the person's consent (skill references/install.md); the archive address only from
// the server settings, not from the request.
import { ProtocolError, type Server, type StandardSchemaV1 } from "@modelcontextprotocol/server";
import { mcpContract, skillArchiveUrlFromBase, skillEntry, skillManifest, skillPhrase, skillProgramOf, type McpLanguage } from "@memory/shared";

const INVALID_PARAMS = -32602;

export interface SkillMcpDeps {
  /** The key has MCP tools — the same right as resources/read of the skill. Without them — empty lists and -32602. */
  allowed: boolean;
  /**
   * The caller is a person (a person's key, OAuth connection, session): the install-skill prompt only for them — the same rule as
   * for the "Skill archive" row of the instructions (personWithTools, instructions.ts). To a service, even "on behalf of" one —
   * an empty prompts/list and -32602 on prompts/get, as for an unknown prompt; skills/* — by `allowed`, as before.
   */
  person: boolean;
  /**
   * The memory_me bucket limit for this message; over it — ProtocolError -32029 (as for resources). `req` — `{ params }`:
   * the caller is taken from the message (the program from _meta), as in the other mcp.ts handlers.
   */
  limit: (req: { params?: unknown }, ctx: unknown) => void;
  /**
   * This key's memory address (agentBaseUrl, write.ts): a cloud agent — access.cloud_agent_base_url, a script and others —
   * access.public_base_url. Read per request: a setting change works without a gateway restart.
   */
  publicBase: () => string | null | undefined;
  /** client_kind of the key or OAuth link: the skills folder in the phrase (claude_code, codex, cursor; else all three). */
  clientKind: string | null;
  /** Language of the prompt texts (setting locale.mcp_language, read by mcp.ts per request); English when absent. */
  language?: McpLanguage;
}

/**
 * A minimal Standard Schema for the 3-argument registration of SDK 2.0 (own methods check params with it): no dependencies,
 * only the shape; extra keys (`_meta` and future fields) pass — the extension and revision may add them.
 */
function params<T>(check: (v: Record<string, unknown>) => string | null): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1, vendor: "memory",
      validate: (value: unknown) => {
        const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
        const problem = v ? check(v) : "params must be an object";
        return problem ? { issues: [{ message: problem }] } : { value: v as T };
      },
    },
  };
}
const ListParams = params<{ cursor?: string }>((v) => v.cursor === undefined || typeof v.cursor === "string" ? null : "cursor must be a string");
const GetParams = params<{ uri: string }>((v) => typeof v.uri === "string" ? null : "uri must be a string with the address of the skill’s SKILL.md");

/** The `install-skill` prompt text: the same phrase build as the "Connect an agent" page; no address — refusal, no download. */
export function installSkillText(base: string | null | undefined, clientKind: string | null, unavailable: string): string {
  const url = skillArchiveUrlFromBase(base);
  if (!url) return unavailable;
  const sha = /^sha256:([0-9a-f]{64})$/.exec(skillManifest().archive.digest)?.[1];
  return skillPhrase(url, sha, skillProgramOf(clientKind));
}

export function registerSkillMcp(server: Server, deps: SkillMcpDeps): void {
  const { skills, prompts } = mcpContract(deps.language ?? "en").server;

  const offered = deps.allowed && deps.person;
  server.setRequestHandler("prompts/list", async () => ({
    prompts: offered ? prompts.items.map(({ name, title, description }) => ({ name, title, description })) : [],
  }) as any);
  server.setRequestHandler("prompts/get", async (req: any, ctx: any) => {
    const prompt = offered ? prompts.items.find((p) => p.name === req.params?.name) : undefined;
    if (!prompt) throw new ProtocolError(INVALID_PARAMS, "Prompt not found");   // like a missing object, no hint about rights
    deps.limit(req, ctx);
    return {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text: installSkillText(deps.publicBase(), deps.clientKind, prompt.unavailable) } }],
    } as any;
  });

  // SEP-2640: one entry — the memory skill. No paging: we give no nextCursor, a sent cursor is foreign, -32602 as in
  // the base list methods. The SDK sets ttlMs/cacheScope only for its own methods — for skills/list they come from the contract.
  server.setRequestHandler("skills/list", { params: ListParams }, async (p, ctx) => {
    if (p.cursor !== undefined) throw new ProtocolError(INVALID_PARAMS, "Invalid cursor");
    const cache = { ttlMs: skills.list_ttl_ms, cacheScope: skills.list_cache_scope };
    if (!deps.allowed) return { skills: [], ...cache };
    deps.limit({ params: p }, ctx);
    return { skills: [skillEntry()], ...cache };
  });
  server.setRequestHandler("skills/get", { params: GetParams }, async (p, ctx) => {
    const entry = skillEntry();
    // the address is compared whole, with no normalizing: only the core of this skill (SEP: params.uri — the SKILL.md address)
    if (!deps.allowed || p.uri !== entry.uri) throw new ProtocolError(INVALID_PARAMS, "Skill not found");
    deps.limit({ params: p }, ctx);
    return { skill: entry };
  });
}
