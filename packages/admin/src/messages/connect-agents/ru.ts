import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  myProgram: "Моя программа",
  byAnthropic: "от Anthropic",
  byOpenai: "от OpenAI",
  codeEditor: "редактор кода",
  anotherProgram: "Другая программа",
  anyAgentWithMcp: "любой агент с MCP",
  on: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} на ${value1}`,
};
