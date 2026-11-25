import type { Caller } from "./context.ts";

/** OAuth grants have the same personal-agent permissions, never the human-session permissions. */
export function personalAgent(caller: Caller): boolean {
  return (caller.keyKind === "personal" || caller.keyKind === "connection") && caller.principalType === "person"
    && !!caller.person && !caller.onBehalfOf && !caller.preview;
}
