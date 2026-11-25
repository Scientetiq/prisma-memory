import { parseParams, type Params } from "@memory/shared/oauth-as";

// Match the strict parser's control check for values that folding could remove.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The built-in authorize and token routes accept equivalent resource indicators (RFC 8707 §2).
 * The edge server and the revocation route both apply the shared parser's strict repeat rule.
 */
export function parseResourceParams(
  text: string,
  limit: number,
  normalize: (value: string) => string | null,
): { params: Params; resourceConflict: boolean } {
  if (typeof text !== "string" || text.length > limit) {
    return { params: parseParams(text, limit), resourceConflict: false };
  }

  const fields = new URLSearchParams(text);
  // The strict parser treats empty values as absent.
  const resources = fields.getAll("resource").filter((value) => value !== "");
  const [first, ...rest] = resources;
  if (first === undefined || rest.length === 0 || resources.some((value) => CONTROL.test(value))) {
    return { params: parseParams(text, limit), resourceConflict: false };
  }

  const normalized = normalize(first);
  const resourceConflict = rest.some((value) => normalize(value) !== normalized);
  // Let the strict parser check every other field before the route acts on the conflict.
  if (resourceConflict) fields.delete("resource");
  else fields.set("resource", first);

  // The limit applies to the received text. Re-encoding can change the length.
  const rewritten = fields.toString();
  return { params: parseParams(rewritten, rewritten.length), resourceConflict };
}
