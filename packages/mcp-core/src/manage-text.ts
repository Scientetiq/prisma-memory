// The text of memory_manage `help`: which actions the key may call through the two dispatchers, and the long-form
// text of one tool. Server words only — titles and help texts come from the contract (server.help), not from records.
import type { McpTexts } from "./texts/index.ts";

/** The actions the caller may run, per dispatcher, in the contract's order: `action`, its tool and the tool's title. */
export interface ManageHelpView {
  readonly dispatchers: ReadonlyArray<{ readonly name: string; readonly actions: ReadonlyArray<{ readonly action: string; readonly tool: string; readonly title: string }> }>;
}

/**
 * The action list: the actions of memory_manage under its heading and how to call them, then the destructive ones under
 * theirs. A dispatcher without actions for this key is left out (its heading too); without actions of memory_manage only the
 * line how to ask for an action's description stays — a call of memory_manage with an action would be refused.
 */
export function manageHelpText(view: ManageHelpView, texts: McpTexts): string {
  const of = (name: string) => view.dispatchers.find((d) => d.name === name)?.actions ?? [];
  const lines = (list: ManageHelpView["dispatchers"][number]["actions"]) => list.map((a) => `- ${a.action} — ${a.title}`);
  const manage = of("memory_manage"), destructive = of("memory_manage_destructive");
  return [
    ...(manage.length ? [texts.manage.heading, ...lines(manage)] : []),
    manage.length ? texts.manage.call : texts.manage.topicOnly,
    ...(destructive.length ? [texts.manage.destructiveHeading, ...lines(destructive)] : []),
  ].join("\n");
}

/**
 * The present description of a tool, then its long-form text under a line saying which of the two is current, then its
 * input schema as one line of JSON. The description comes first: the long-form text is the earlier description,
 * kept word for word, and the description is the one that is corrected.
 */
export function manageTopicText(description: string, help: string, tool: string, inputSchema: unknown, texts: McpTexts): string {
  return `${description}\n\n${texts.manage.topicLong}\n${help}\n\n${texts.manage.topicSchema(tool)}\n${JSON.stringify(inputSchema)}`;
}
