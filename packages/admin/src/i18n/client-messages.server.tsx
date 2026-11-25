import "server-only";
import { createElement, type ComponentType } from "react";
import { headers } from "next/headers";
import registry from "../../.i18n/client-messages.json";
import { currentLocale } from "./runtime";
import { MessageBoundary } from "./client-messages";
import type { ClientMessages } from "./client-data";

type Entry = { en: ClientMessages; ru: ClientMessages };
const entries: Record<string, Entry> = registry.entries;
const routes = Object.keys(entries).map(entry => {
  const parts = entry.split("/").filter(p => p && !/^\(.*\)$/.test(p));
  const pattern = parts.map(p => p.startsWith("[[...") ? "(?:/.*)?" : p.startsWith("[...") ? "/.+" : p.startsWith("[") ? "/[^/]+" : "/" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return { entry, match: new RegExp("^" + (pattern || "/") + "/?$"), specificity: parts.filter(p => !p.startsWith("[")).length };
}).sort((a, b) => b.specificity - a.specificity);

export function clientMessagesForEntry(entry: string): ClientMessages {
  const data = entries[entry];
  if (!data) throw new Error(`Unknown client message entry: ${entry}`);
  return data[currentLocale()];
}

export function clientEntryForPath(path: string): string {
  return routes.find(r => r.match.test(path.split("?")[0]!))?.entry ?? "_not-found";
}

/** The layout supplies initial data; page boundaries also supply it on an RSC navigation. Shared object identity lets
 * Flight send one copy on a full load. The browser merges immutable IDs so an older mounted layout can still render. */
export async function routeMessages<P extends object>(entry: string | null, component: ComponentType<P>, props: P) {
  const selected = entry ?? clientEntryForPath((await headers()).get("x-memory-client-path") ?? "/_not-found");
  return <MessageBoundary messages={clientMessagesForEntry(selected)}>{createElement(component, props)}</MessageBoundary>;
}
