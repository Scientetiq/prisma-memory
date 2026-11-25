// Vector transforms of the embeddings facade. What a profile's space
// says the client does to the numbers a provider answers: client-side Matryoshka (keep the first `dims` numbers, then
// L2-renormalise), L2 normalisation, and the final check — exactly `dims` finite numbers. A space that asks for neither
// (every legacy row) passes the provider's numbers through untouched, so the stored halfvecs stay bit-identical.
// Refusals are EmbeddingShapeError (the facade turns them into PlatformError("bad_response")).
import type { EmbedderSpace } from "./profile.ts";
import { EmbeddingShapeError, l2norm } from "./wire.ts";

/** The vector scaled to L2 norm 1; a vector without a direction (norm 0) or with a value that is not finite is refused. */
export function l2normalize(v: readonly number[]): number[] {
  const n = l2norm(v);
  if (!(n > 0) || !Number.isFinite(n)) throw new EmbeddingShapeError("a vector cannot be normalised (norm 0 or not finite)");
  return v.map((x) => x / n);
}

/** The first `dims` numbers of a longer vector, renormalised (Matryoshka truncation on the client). */
export function truncateVector(v: readonly number[], dims: number): number[] {
  if (v.length < dims) throw new EmbeddingShapeError(`a vector of ${v.length} numbers cannot be cut to ${dims}`);
  return l2normalize(v.slice(0, dims));
}

/** Exactly `dims` finite numbers, or EmbeddingShapeError. */
export function checkVector(v: readonly unknown[], dims: number): void {
  if (!Array.isArray(v) || v.length !== dims) throw new EmbeddingShapeError(`a vector of another length than ${dims}`);
  if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new EmbeddingShapeError("a vector value is not a finite number");
}

/** How many numbers the provider answers per input for this space (null — not known: any, all equal). */
export const rawVectorLength = (space: Pick<EmbedderSpace, "truncate" | "native_dims" | "dims">): number | null =>
  (space.truncate ? space.native_dims : space.dims);

/** The stored vectors of a space from the provider's numbers: truncate (and renormalise) or normalise, then check each. */
export function spaceVectors(space: Pick<EmbedderSpace, "truncate" | "normalize" | "dims">, raw: readonly (readonly number[])[]): number[][] {
  return raw.map((v) => {
    const out = space.truncate ? truncateVector(v, space.dims) : space.normalize ? l2normalize(v) : (v as number[]);
    checkVector(out, space.dims);
    return out;
  });
}
