/**
 * Memory pipeline · token counters for the chunker.
 *
 * A counter is a pure sync function `str -> int`. In production it is the embedder's tokenizer, in tests and
 * evaluation `heuristicTokens`, matching the reference `heuristic_tokens` bit for bit.
 */
import { pipelineText } from "./verify.ts";
const { pyLen } = pipelineText.pytext;

/** Token counter: how many tokens a text takes in the embedder. Must be deterministic and synchronous. */
export type TokenCounter = (text: string) => number;

/**
 * ≈ 4 chars a token; the embedder's tokenizer gives 4.4–5.3 on Russian — a heuristic with a margin.
 * Characters are code points (as `len()` in Python), not UTF-16 units: an emoji counts as one char.
 */
export function heuristicTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(pyLen(text) / 4)) : 0;
}

/** Encoding text into token ids WITHOUT special tokens (`add_special_tokens=False` in the reference). */
export type EncodeIds = (text: string) => ArrayLike<number>;

/**
 * Exact counter over the embedder's tokenizer — like the reference `load_hf_counter`. No tokenizer dependency
 * is added to the package: the worker loads `tokenizer.json` with the library the image has and passes here
 * a synchronous encode function:
 *
 *     const tok = loadTokenizerSomehow("/models/embedder/tokenizer.json");
 *     const counter = tokenizerCounter((text) => tok.encode(text, { addSpecialTokens: false }).ids);
 *     chunkTranscript(segments, counter, params);
 *
 * The function is synchronous (the chunker calls it in a loop and awaits no promises), without special tokens,
 * the same `tokenizer.json` as the reference (`MEMORY_TOKENIZER_JSON`). If the library has only an async `encode`,
 * a synchronous wrapper or another tokenizer is needed — the chunker is not rewritten for promises, else it
 * would split from the reference. Empty string — 0 tokens with no tokenizer call, as in the reference.
 */
export function tokenizerCounter(encodeIds: EncodeIds): TokenCounter {
  return (text: string): number => (text ? encodeIds(text).length : 0);
}
