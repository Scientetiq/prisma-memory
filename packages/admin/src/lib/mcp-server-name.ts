import SKILL_BUNDLE from "./skill-bundle.json";

/** The MCP server name in generated agent configurations: the product name, read from the skill bundle description. */
export const MCP_SERVER_NAME: string = SKILL_BUNDLE.name;

/** Catalogue parameters that name the MCP server: messages write it as {server}. */
export const SERVER_PARAM: Readonly<{ server: string }> = { server: MCP_SERVER_NAME };

/** The skill installation prompt as Claude Code lists it: short and fully qualified forms. */
export const INSTALL_SKILL_COMMAND = `/${MCP_SERVER_NAME}:install-skill`;
export const INSTALL_SKILL_COMMAND_FULL = `/mcp__${MCP_SERVER_NAME}__install-skill`;
