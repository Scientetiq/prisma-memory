// Dimension probe of an embedding connection. One fixed synthetic text, open class, through
// the transport of the connection: the answer tells the dimension of a model without a preset, whether its vectors come
// normalised, and whether the address, key and model work at all. Used by the registration of embedders (worker,
// reconcileEmbedders) and by the "test connection" action for the embeddings role. It sends through the facade's guarded
// send (embedder.ts `probeConnection`): the data policy, the stage PROBE_STAGE (the budget never stops a probe)
// and the usage report are the facade's; this module only builds the request and reads the answer.
import { PlatformError } from "../../platform-error.ts";
import type { ModelConnection, ModelReply } from "../types.ts";
import { PROBE_STAGE } from "../usage.ts";
import type { GuardedSend } from "./embedder.ts";
import { draftProfile, expectedLength, type EmbedderDraft } from "./presets.ts";
import { PROBE_TEXT, probeRequest } from "./probe-body.ts";
import type { EmbedderProfile } from "./profile.ts";
import { embeddingVectors, EmbeddingShapeError, l2norm } from "./wire.ts";

/** The only text a probe sends: synthetic, no data of the install (defined with the check of a probe body). */
export { PROBE_TEXT };
export const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  ok: boolean;
  /** Length of the vector the model answered (null — no vector). */
  dims: number | null;
  /** The vector came with L2 norm 1 (± 0.001). */
  normalized: boolean | null;
  latency_ms: number;
  /** What failed, in plain English; never a key, an address or the provider's answer text. */
  error?: string;
}

const failed = (error: string, started: number): ProbeResult => ({ ok: false, dims: null, normalized: null, latency_ms: Date.now() - started, error });

/** Probe the connection with its profile (or the draft profile of the connection when none is given). */
export async function probeEmbeddings(connection: ModelConnection, o: { send: GuardedSend; profile?: EmbedderProfile | EmbedderDraft; timeoutMs?: number; signal?: AbortSignal }): Promise<ProbeResult> {
  const started = Date.now();
  let shape: EmbedderProfile | EmbedderDraft;
  if (o.profile) shape = o.profile;
  else {
    const d = draftProfile(connection);
    if (!d.draft) return failed(`the profile of the connection is not valid: ${d.problems.join("; ")}`, started);
    shape = d.draft;
  }
  // one validator: the profile is validated like any profile (a reserved input type parameter would
  // replace the probe text or the model on the wire — no request then), and the request is the ordinary builder's
  // with only the input replaced by PROBE_TEXT, checked positionally; its input type setting is sent as validated
  const built = probeRequest(shape);
  if (!built.request) return failed(`the probe profile is not valid: ${built.problems.join("; ")}`, started);
  const req = built.request;
  let answer: ModelReply;
  try {
    answer = await o.send(req, { dataClass: "open", stage: PROBE_STAGE, timeoutMs: o.timeoutMs ?? PROBE_TIMEOUT_MS, signal: o.signal, profile: shape });
  } catch (e) {
    if (e instanceof PlatformError && e.kind === "policy_denied") return failed("the data policy does not allow this model", started);
    return failed(e instanceof PlatformError ? e.message : "the embedding model is not reachable", started);
  }
  if (answer.status === 401 || answer.status === 403) return failed(`the embedding model refused the key (HTTP ${answer.status})`, started);
  if (answer.status === 404) return failed("the embedding model or its address is not found (HTTP 404)", started);
  if (answer.status === 429) return failed("the embedding model is busy (HTTP 429); the probe is repeated later", started);
  if (answer.status >= 400) return failed(`the embedding model answered HTTP ${answer.status}`, started);
  const want = "v" in shape ? (shape.space.truncate ? shape.space.native_dims : shape.space.dims) : expectedLength(shape);
  try {
    const [v] = embeddingVectors(shape.ops.provider, answer.json, 1, want);
    const norm = l2norm(v!);
    return { ok: true, dims: v!.length, normalized: Math.abs(norm - 1) <= 1e-3, latency_ms: Date.now() - started };
  } catch (e) {
    if (!(e instanceof EmbeddingShapeError)) return failed("the answer is not usable", started);
    // one good vector of another length: say what the model answers and how a profile reaches the wanted dimension
    let got: number | null = null;
    try { got = want === null ? null : embeddingVectors(shape.ops.provider, answer.json, 1, null)[0]!.length; } catch { got = null; }
    if (got !== null && got !== want)
      return failed(`the answer is not usable: ${e.message} — the model answered ${got} numbers per vector; set dims_param (the provider reduces the dimension) `
        + `or truncate (the client does) in params, or dims to ${got}`, started);
    return failed(`the answer is not usable: ${e.message}`, started);
  }
}
