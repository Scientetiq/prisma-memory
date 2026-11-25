// Chat adapters by provider. A provider without an adapter is not usable: the facade refuses the call
// before any request. and add the native adapters, one line each.
import type { ChatAdapter } from "../types.ts";
import { openAiCompatibleChat } from "./openai-compatible.ts";
import { anthropicChat } from "./anthropic.ts";
import { geminiChat } from "./gemini.ts";

const CHAT_ADAPTERS: Readonly<Record<string, ChatAdapter>> = { "openai-compatible": openAiCompatibleChat, anthropic: anthropicChat, gemini: geminiChat };

/** The chat adapter of a provider, or null when there is none yet. */
export function chatAdapter(provider: string): ChatAdapter | null {
  return Object.hasOwn(CHAT_ADAPTERS, provider) ? CHAT_ADAPTERS[provider]! : null;
}
