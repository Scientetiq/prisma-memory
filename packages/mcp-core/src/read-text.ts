import { asData } from "./markers.ts";
import { continuationView, type ReadPart } from "./read-range.ts";
import type { McpTexts } from "./texts/index.ts";

export interface ReadView {
  path: string; type: string; event_kind?: string | null; occurred_at: string; origin: string; confirmed: boolean; class: string; title: string;
  extended_write?: boolean;
  part: ReadPart;
  call: { id: string; search_id?: string; max_tokens?: number };
}

export function readText(view: ReadView, extras: readonly string[], texts: McpTexts): string {
  const t = texts.read, cont = continuationView(view.part, view.call, texts);
  const head = `${view.path}\n${view.type}${view.event_kind ? ` · ${view.event_kind}` : ""} · ${view.occurred_at} · origin: ${view.origin} · confirmed: ${view.confirmed} · class: ${view.class}${view.extended_write ? ` · ${t.extended}` : ""}${cont ? ` · ${cont.head}` : ""}`;
  const lines = [cont?.next ?? "", ...extras].filter(Boolean).map((l) => `\n${l}`).join("");
  const toc = cont?.toc.length
    ? `\n${t.tocHeading}\n${asData(cont.toc.join("\n"), { texts })}${cont.more ? `\n${t.tocMore(cont.more)}` : ""}`
    : "";
  return `${head}${lines}\n${asData(`# ${view.title}\n\n${view.part.content}`, { texts })}${toc}`;
}
