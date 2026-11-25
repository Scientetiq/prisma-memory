// The tool profile of tools/list and the two dispatchers. The setting access.mcp_tools_profile picks what
// tools/list shows:
//   core — the tools of server.tool_profiles.core and the dispatchers memory_manage / memory_manage_destructive that run
//          every other permitted tool by `action` (default of a new installation and the reading of an unknown value);
//   full — every permitted tool and no dispatcher (an installation that existed before this setting keeps it).
// Listing is not permission: a permitted tool that is not listed is still called by its name, and the dispatchers are
// callable in both profiles. The split of the actions between the dispatchers follows the tool annotations
// (destructiveHint), so a client that asks the person before a destructive tool asks before memory_manage_destructive.
// No I/O here: settings.ts validates the value with MCP_TOOLS_PROFILES, the gateway reads it per request.
import type { McpContract } from "./contracts.ts";

/** Values of the setting access.mcp_tools_profile. */
export const MCP_TOOLS_PROFILES = ["core", "full"] as const;
export type McpToolsProfile = (typeof MCP_TOOLS_PROFILES)[number];
export const MCP_TOOLS_PROFILE_SETTING = "access.mcp_tools_profile";
/** The profile for a setting value: a known profile as is, anything else (no row, empty, a typo, another type) — `core`. */
export const mcpToolsProfile = (value: unknown): McpToolsProfile =>
  (MCP_TOOLS_PROFILES as readonly unknown[]).includes(value) ? value as McpToolsProfile : "core";

export const MANAGE_DISPATCHER = "memory_manage";
export const MANAGE_DESTRUCTIVE_DISPATCHER = "memory_manage_destructive";
/** The action of memory_manage that describes the others; it runs no tool. */
export const MANAGE_HELP_ACTION = "help";

/** The actions of each dispatcher this caller may run, in the contract's order (help is not counted). */
export interface DispatcherActions { manage: string[]; destructive: string[] }

/** The actions of both dispatchers whose tool (`memory_<action>`) is in the caller's permitted set. */
export function dispatcherActionsFor(contract: Pick<McpContract, "server">, permitted: readonly string[]): DispatcherActions {
  const has = new Set(permitted);
  const of = (name: string): string[] =>
    ((contract.server.dispatchers ?? []).find((d) => d.name === name)?.actions ?? []).filter((a) => has.has(`memory_${a}`));
  return { manage: of(MANAGE_DISPATCHER), destructive: of(MANAGE_DESTRUCTIVE_DISPATCHER) };
}

/**
 * Whether a dispatcher is offered to and answered for the caller: memory_manage — at least one action of either dispatcher
 * (its help describes both; help alone does not count); memory_manage_destructive — at least one of its own actions.
 */
export function dispatcherAvailable(name: string, actions: DispatcherActions): boolean {
  if (name === MANAGE_DISPATCHER) return actions.manage.length + actions.destructive.length > 0;
  if (name === MANAGE_DESTRUCTIVE_DISPATCHER) return actions.destructive.length > 0;
  return false;
}
