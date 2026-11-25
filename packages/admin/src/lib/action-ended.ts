import { failState, type ActionState } from "./action-state";
import { ERROR_PLAIN } from "./mcp-parse";
import { sessionEndedState } from "./user-session";

export function endedState(r: { code: string }): Promise<ActionState> | ActionState | null {
  return r.code === "unauthorized" ? sessionEndedState() : r.code === "response_lost" ? failState(ERROR_PLAIN.responseLost) : null;
}
