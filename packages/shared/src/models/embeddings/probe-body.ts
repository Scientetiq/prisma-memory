// The probe request. One validator: the probe body is produced by the
// same request builder as ordinary embedding (`embeddingBuild` in wire.ts), from a profile that passed the same
// validation as any profile (`shapeProblems`), with only the input replaced by PROBE_TEXT; whatever that validation
// accepts, the probe sends — the same settings as the ordinary request. «The probe carries only the probe text» is decided
// POSITIONALLY: the builder states which fields carry input, and exactly those are compared with PROBE_TEXT. No decision
// is taken by a key name at any depth. The guard of the embeddings transport (platform.ts) gives a probe proof only to
// a request equal to `probeRequest(profile)` of the profile handed to it, whoever asks. Pure: no I/O, no state.
import type { EmbedderDraft } from "./presets.ts";
import { shapeProblems, type EmbedderProfile } from "./profile.ts";
import { embeddingBuild, valueAt, type EmbeddingRequest } from "./wire.ts";

/** The only text a probe sends: synthetic, no data of the install. */
export const PROBE_TEXT = "dimension probe";

/** A profile, or a draft whose dimension is not known yet. */
export type ProbeShape = Pick<EmbedderProfile | EmbedderDraft, "space" | "ops">;

/**
 * The probe request of a profile: validated like any profile, built by the ordinary builder for one document whose text
 * is PROBE_TEXT (the document prefix is part of the input and is not sent), and checked positionally: the one input slot
 * the builder states holds PROBE_TEXT. `problems` — why there is no request (never echoes a value).
 */
export function probeRequest(shape: unknown): { request: EmbeddingRequest; problems: [] } | { request: null; problems: string[] } {
  const problems = shapeProblems(shape);
  if (problems.length) return { request: null, problems };
  const s = shape as ProbeShape;
  const built = embeddingBuild({ ...s, space: { ...s.space, document_prefix: "" } }, [PROBE_TEXT], "document");
  if (built.inputs.length !== 1 || built.inputs.some((slot) => valueAt(built.request.body, slot) !== PROBE_TEXT))
    return { request: null, problems: ["the probe request does not carry the probe text where its input goes"] };
  return { request: built.request, problems: [] };
}

/** Is `req` exactly the probe request of `shape` — the same path and the same body, byte for byte? */
export function isProbeRequestOf(shape: unknown, req: { path: unknown; body: unknown }): boolean {
  const want = probeRequest(shape);
  if (!want.request) return false;
  let json: string | undefined;
  try { json = JSON.stringify(req.body); } catch { return false; }
  return req.path === want.request.path && json === JSON.stringify(want.request.body);
}
