import { asData } from "./markers.ts";
import type { McpTexts } from "./texts/index.ts";

export interface ToolErrorBody { code: string; message: string; hint?: string; retry_after?: number; reason?: string; details?: Record<string, unknown> }

export function toolErrorText(b: ToolErrorBody, texts: McpTexts): string {
  const t = texts.error, lines = [`${b.code}: ${b.message}`];
  const said = (s: string) => b.message.includes(s);
  const hint = b.hint && !said(b.hint) ? b.hint : undefined;
  if (hint) lines.push(`${t.hint}: ${hint}`);
  if (typeof b.retry_after === "number") lines.push(`retry_after: ${b.retry_after}`);
  if (b.reason && !said(b.reason)) lines.push(`${t.reason}: ${b.reason}`);
  const url = b.details?.workplace_url;
  if (typeof url === "string" && url) {
    const forms = [url, `<${url}>`, `(${url})`, `"${url}"`, `'${url}'`, `«${url}»`];
    const hasUrl = (text: string): boolean => {
      const words = text.trim().split(/\s+/u);
      // In prose a period or comma can follow the address.
      return words.some((word) => forms.includes(word) || (words.length > 1 && forms.includes(word.replace(/[.,]$/u, ""))));
    };
    if (!hasUrl(b.message) && !hasUrl(hint ?? "")) lines.push(`${t.link}: ${url}`);
  }
  const sections = sectionCandidates(b.details?.candidates, texts);
  if (sections.length) lines.push(t.sections, asData(sections.join("\n"), { texts }));
  return lines.join("\n");
}

function sectionCandidates(raw: unknown, texts: McpTexts): string[] {
  if (!Array.isArray(raw) || !raw.length || !raw.every((c) => c && typeof c === "object" && typeof (c as { anchor?: unknown }).anchor === "string")) return [];
  return (raw as Array<{ anchor: string; path?: unknown; page?: unknown }>).map((c) =>
    `${c.anchor}${typeof c.path === "string" ? ` — ${c.path}` : ""}${typeof c.page === "number" ? ` (${texts.read.page(c.page)})` : ""}`);
}
