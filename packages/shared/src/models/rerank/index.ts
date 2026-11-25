// Rerank adapters by provider. A provider without an adapter is refused by the facade before any request.
import type { RerankAdapter } from "../types.ts";
import { cohereFormatRerank } from "./cohere-format.ts";
import { voyageRerank } from "./voyage.ts";
import { teiRerank } from "./tei.ts";

const RERANK_ADAPTERS: Readonly<Record<string, RerankAdapter>> = {
  cohere: cohereFormatRerank, jina: cohereFormatRerank, openrouter: cohereFormatRerank, voyage: voyageRerank, tei: teiRerank,
};

/** The rerank adapter of a provider, or null when there is none yet. */
export function rerankAdapter(provider: string): RerankAdapter | null {
  return Object.hasOwn(RERANK_ADAPTERS, provider) ? RERANK_ADAPTERS[provider]! : null;
}
