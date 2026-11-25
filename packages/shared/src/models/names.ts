// The rules of a model name, shared by the connection keys (connection.ts) and the data-policy lists (policy.ts).

const MODEL_MAX = 256;

/** Problem of a model name, or null: no spaces at the ends, no control characters, at most 256 characters. */
export function modelNameProblem(name: string): string | null {
  if (name !== name.trim()) return "remove the spaces at the start and at the end of the model name";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "the model name must be one line without control characters";
  if (name.length > MODEL_MAX) return `the model name is longer than ${MODEL_MAX} characters`;
  return null;
}

/** Gemini embeds the model in a URL path; reject path syntax before saving or calling it. */
export function geminiModelNameProblem(name: string): string | null {
  return modelNameProblem(name) ?? (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..") || name === "."
    ? "the Gemini model must be a simple name of letters, digits, dots, underscores and dashes, without dot segments" : null);
}
