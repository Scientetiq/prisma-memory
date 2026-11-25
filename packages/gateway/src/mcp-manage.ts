// The dispatchers of the tool profile core: memory_manage runs the tools outside the core that are annotated
// destructiveHint false, and describes the actions (help); memory_manage_destructive runs the five destructive tools. Neither
// is a permission path of its own: an action is the direct tools/call of `memory_<action>` — the same callTool of mcp.ts
// (permitted set, the memory_open rule, argument checks, limiter bucket, dispatch, log and audit of the real tool). This file
// only checks the dispatcher's own input and keeps the split: nothing destructive runs through memory_manage.
// It does not import mcp.ts: makeServer passes in what it needs.
import {
  dispatcherActionsFor, log, MANAGE_DESTRUCTIVE_DISPATCHER, MANAGE_DISPATCHER, MANAGE_HELP_ACTION, MemoryError, validateDispatcherInput,
  type McpContract, type McpDispatcherContract,
} from "@memory/shared";
import { manageHelpText, manageTopicText, type ManageHelpView, type McpTexts } from "@memory/mcp-core";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";

export interface ManageDeps {
  app: App;
  texts: McpTexts;
  /** The contract in the language of the request. */
  contract: McpContract;
  /** The caller's permitted tools (toolsFor). */
  names: readonly string[];
  /** The direct call path of mcp.ts. */
  callTool: (who: Caller, name: string, args: unknown, via: "manage") => Promise<any>;
  /** A MemoryError as a tool error result (isError) in the language of the request. */
  errorResult: (e: MemoryError) => any;
}

/** An asked action is repeated in a refusal only when it looks like an action name; anything else is not echoed. */
const ECHO = /^[a-z_]{1,40}$/;
const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A call of a dispatcher the caller may use (dispatcherAvailable); `rawArgs` — the arguments of tools/call as they came. */
export async function manageCall(deps: ManageDeps, who: Caller, d: McpDispatcherContract, rawArgs: unknown): Promise<any> {
  const { contract, names } = deps, started = Date.now();
  const refuse = (message: string) => {
    const err = new MemoryError("invalid_argument", message);
    log.info("tool_call", { tool: d.name, ms: Date.now() - started, ok: false, code: err.code, via: "manage" });
    return deps.errorResult(err);
  };
  // (1) the arguments are an object {action, args?, topic?}
  if (!plainObject(rawArgs)) return refuse(`${d.name}: the arguments are an object {"action": …, "args": {…}}`);
  const acts = dispatcherActionsFor(contract, names);
  const own = d.name === MANAGE_DISPATCHER ? acts.manage : acts.destructive;
  const action: unknown = rawArgs.action;
  const help = d.name === MANAGE_DISPATCHER && action === MANAGE_HELP_ACTION;
  // (2) the action is one of this caller's actions of this dispatcher — looked up in the list, never as a property name
  if (!help && !(typeof action === "string" && own.includes(action))) {
    if (d.name === MANAGE_DISPATCHER && typeof action === "string" && acts.destructive.includes(action))
      return refuse(`${action} is destructive: call ${MANAGE_DESTRUCTIVE_DISPATCHER}`);
    // memory_open not permitted to this key: the refusal of the direct call (forbidden with the link, not_found on the
    // external address) — the same answer by both paths
    if (d.name === MANAGE_DESTRUCTIVE_DISPATCHER && action === "open" && who.principalType !== "system")
      return deps.callTool(who, "memory_open", rawArgs.args, "manage");
    const available = d.name === MANAGE_DISPATCHER ? [MANAGE_HELP_ACTION, ...acts.manage] : acts.destructive;
    const asked = typeof action === "string" && ECHO.test(action) ? ` ${action}` : "";
    return refuse(`${d.name}: unknown action${asked} — available: ${available.join(", ")}`);
  }
  // (3) the dispatcher's own schema: no other property, args an object, topic a short string
  const v = validateDispatcherInput(d.name, rawArgs);
  if (!v.ok) return refuse(v.message);
  if (help) return helpAnswer(deps, who, rawArgs.topic, started);
  // (4) defence in depth: memory_manage never runs a tool that is not annotated destructiveHint false, whatever
  // the dispatcher's action list says
  const name = `memory_${action as string}`;
  const tool = contract.tools.find((t) => t.name === name);
  if (d.name === MANAGE_DISPATCHER && tool?.annotations?.destructiveHint !== false)
    return refuse(`${action as string} is destructive: call ${MANAGE_DESTRUCTIVE_DISPATCHER}`);
  // (5) the direct call path of the real tool; no limiter charge here (callTool charges the tool's bucket)
  return deps.callTool(who, name, rawArgs.args ?? {}, "manage");
}

/**
 * memory_manage help: the caller's actions, or one permitted tool — its present description, its long-form text and its
 * input schema. Bucket memory_me.
 */
async function helpAnswer(deps: ManageDeps, who: Caller, topic: unknown, started: number): Promise<any> {
  const { app, contract, names, texts } = deps;
  const done = (ok: boolean, code?: string) =>
    log.info("tool_call", { tool: MANAGE_DISPATCHER, ms: Date.now() - started, ok, ...(code ? { code } : {}), via: "manage" });
  try { app.limiter.check(who, "memory_me"); }
  catch (e) {
    if (!(e instanceof MemoryError) || e.code !== "rate_limited") throw e;
    void audit(app, who, { event_type: "rate_limited", details: { tool: "memory_me", via: "manage" } });
    done(false, e.code);
    return deps.errorResult(e);
  }
  const titleOf = (tool: string) => contract.tools.find((t) => t.name === tool)?.title ?? tool;
  if (topic === undefined) {
    const acts = dispatcherActionsFor(contract, names);
    const view: ManageHelpView = {
      dispatchers: [[MANAGE_DISPATCHER, acts.manage], [MANAGE_DESTRUCTIVE_DISPATCHER, acts.destructive]]
        .filter(([, list]) => (list as string[]).length > 0)
        .map(([name, list]) => ({ name: name as string, actions: (list as string[]).map((a) => ({ action: a, tool: `memory_${a}`, title: titleOf(`memory_${a}`) })) })),
    };
    done(true);
    return { content: [{ type: "text", text: manageHelpText(view, texts) }], structuredContent: view };
  }
  // an action or a full tool name of a tool this key may call (the core ones too); anything else — one refusal, no echo
  const asked = String(topic), tool = asked.startsWith("memory_") ? asked : `memory_${asked}`;
  const t = contract.tools.find((x) => x.name === tool);
  if (!t || !names.includes(tool) || !Object.hasOwn(contract.server.help ?? {}, tool)) {
    const err = new MemoryError("invalid_argument", `${MANAGE_DISPATCHER}: unknown topic — an action or a tool name this key may call (${MANAGE_DISPATCHER} {"action": "help"} lists them)`);
    done(false, err.code);
    return deps.errorResult(err);
  }
  const help = contract.server.help[tool]!;
  done(true);
  return {
    content: [{ type: "text", text: manageTopicText(t.description, help, tool, t.inputSchema, texts) }],
    structuredContent: { tool, title: t.title, description: t.description, help, inputSchema: t.inputSchema },
  };
}
