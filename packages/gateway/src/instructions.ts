// Connection instructions: the constant texts are the contract; the rights are those of the key in force.
import { dispatcherActionsFor, log, mcpContract, mcpLanguage, MCP_LANGUAGE_SETTING, MCP_TOOLS_PROFILE_SETTING, mcpToolsProfile, skillArchiveUrlFromBase, validSkillBase, type McpInstructions, type McpLanguage, type McpToolsProfile } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { agentBaseUrl, openWriteTargets, personalModeForKey, type PersonalMode } from "./write.ts";
import { openWriteMode } from "./extended-open.ts";

export interface InstructionParts {
  hasTools: boolean;
  project: boolean;
  write: boolean;
  personal: PersonalMode | null;
  /** An agent reading closed records without permission to write into open (`denied`): an empty list and its own phrase. */
  extended: boolean;
  /** The same agent with an administrator's permission (`marked`): the list of open targets and the phrase about the mark. */
  marked?: boolean;
  targets: string[];
  /**
   * The skill archive address (0.12.0: using MCP restores the skill): the skill archive line with that address right after the
   * skill section is the only address the agent installs rules from, with the person's consent. Only to a person, only of a safe
   * form no longer than skill_archive_max_url; otherwise there is no line and the agent points to the agent connect page.
   */
  archiveUrl?: string | null;
  /**
   * The tool profile core lists the dispatchers: the write section ends with write_outro_core, which points at
   * memory_manage, instead of write_outro. Absent or false — write_outro, as before.
   */
  manage?: boolean;
}

/** Only identifiers as data: backticks, spaces and line breaks do not pass. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Only the list is shortened. A wrong constant contract is not masked by cutting the rules. */
export function renderInstructions(config: McpInstructions, parts: InstructionParts): { text: string; targets: number; truncated: boolean } {
  if (!Number.isInteger(config.max_chars) || config.max_chars > 2000 || config.max_chars < config.core.length
      || !Number.isInteger(config.core_max_chars) || config.core_max_chars > 512 || config.core.length > config.core_max_chars
      || !Number.isInteger(config.max_targets) || config.max_targets < 1
      || !Number.isInteger(config.skill_archive_max_url) || config.skill_archive_max_url < 1)
    throw new Error("Invalid MCP instruction limits");
  if (!parts.hasTools) return { text: config.core, targets: 0, truncated: false };
  const s = config.sections;
  const archive = parts.archiveUrl && parts.archiveUrl.length <= config.skill_archive_max_url && validSkillBase(parts.archiveUrl) ? parts.archiveUrl : null;
  const skill = archive ? `${s.skill}\n${s.skill_archive}${archive}` : s.skill;
  const fixed = [config.core, skill, ...(parts.project ? [s.project] : []), s.live_systems, s.data];
  const targets = parts.write && !parts.extended ? [...new Set(parts.targets.filter((slug) => typeof slug === "string" && SAFE_SLUG.test(slug)))] : [];
  const personal = parts.extended ? s.extended : parts.marked ? s.extended_marked : parts.personal === null ? "" : s[`personal_${parts.personal}`];
  const render = (count: number): string => {
    if (!parts.write) return fixed.join("\n\n");
    const shown = targets.slice(0, count).map((slug) => `\`${slug}\``);
    const left = targets.length - count;
    const list = [...shown, ...(left ? [`${s.more_prefix}${left}${s.more_suffix}`] : [])].join("; ");
    return [...fixed, [s.write_intro, personal, list || s.no_open_targets, parts.manage ? s.write_outro_core : s.write_outro].filter(Boolean).join("\n")].join("\n\n");
  };
  let count = Math.min(targets.length, config.max_targets), text = render(count);
  while (text.length > config.max_chars && count > 0) text = render(--count);
  if (text.length > config.max_chars) throw new Error("MCP instruction sections exceed max_chars");
  return { text, targets: count, truncated: count < targets.length };
}

/**
 * A person with MCP tools (a person's key, an OAuth connection, a session) gets the project section, writing, the skill archive
 * line and the install-skill prompt (skill-mcp.ts, via mcp.ts). The service token is shared by OBO sessions; system is no person.
 */
export const personWithTools = (caller: Pick<Caller, "principalType">, tools: readonly string[]): boolean =>
  caller.principalType === "person" && tools.length > 0;

/** Language of the MCP texts (tools/list, instructions, resources, prompts): setting locale.mcp_language, English without a row or with an unknown value. */
export const mcpLanguageOf = (app: Pick<App, "settings">): McpLanguage => mcpLanguage(app.settings.get<unknown>(MCP_LANGUAGE_SETTING, "en"));

/** Tool profile of tools/list: setting access.mcp_tools_profile, core without a row or with an unknown value — the value of a new installation. */
export const toolsProfileOf = (app: Pick<App, "settings">): McpToolsProfile => mcpToolsProfile(app.settings.get<unknown>(MCP_TOOLS_PROFILE_SETTING, "core"));

/** The service token is shared by OBO sessions: no person-dependent spaces or phrases. */
export async function instructionsFor(app: App, caller: Caller, tools: readonly string[]): Promise<string> {
  const names = new Set(tools), hasTools = caller.principalType !== "system" && names.size > 0;
  const person = personWithTools(caller, tools);
  const write = person && (names.has("memory_remember") || names.has("memory_upload"));
  const targets = write ? await openWriteTargets(app, caller) : [];
  // the archive address only to a person: the service token is shared by OBO sessions and has no computer to install rules on.
  // This key's address (agentBaseUrl): a cloud agent gets the cloud agents' one, a script and an extended key the internal one
  const archiveUrl = person ? skillArchiveUrlFromBase(agentBaseUrl(app, caller)) : null;
  const contract = mcpContract(mcpLanguageOf(app));
  // the core profile names memory_manage in the write section — only for a key that may call one of the dispatchers' actions
  const acts = dispatcherActionsFor(contract, tools);
  const manage = toolsProfileOf(app) === "core" && acts.manage.length + acts.destructive.length > 0;
  const out = renderInstructions(contract.server.instructions, {
    hasTools, project: person && names.has("memory_search"), write, archiveUrl,
    personal: write ? personalModeForKey(caller) : null,
    // by capability, not by key kind: the same mode as the gate of writing into open and memory_me.key.open_write_mode
    extended: openWriteMode(caller) === "denied", marked: openWriteMode(caller) === "marked", targets: targets.map((s) => s.slug), manage,
  });
  log.info("mcp_instructions", { chars: out.text.length, targets: out.targets, truncated: out.truncated, archive: Boolean(archiveUrl) });
  return out.text;
}
