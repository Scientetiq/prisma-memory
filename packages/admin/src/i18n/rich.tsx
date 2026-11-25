// Catalog strings with markup: "<b>…</b>", "<link>…</link>", "<br/>" and "{name}" become React nodes, built only from the
// tag callbacks named in code and the parameters passed in; nothing is parsed as HTML. Kept apart from index.ts so that
// pure modules do not pull in React.
//
// Rule for catalogs: an entry used with rich() is a string with {x} placeholders (or a function that only chooses
// between such strings). Values go through params, never into the text: a value inside the text could use the tags of
// the call site.
import { createElement, Fragment, type ReactNode } from "react";

/** Callbacks by tag name: <x>…</x> calls tags.x(children), <x/> calls tags.x(null). */
export type RichTags = Readonly<Record<string, (children: ReactNode) => ReactNode>>;
/** Values by placeholder name: {x} becomes params.x as a child (text stays text). */
export type RichParams = Readonly<Record<string, ReactNode>>;

const TOKEN = /<(\/?)([a-z][a-z0-9]*)(\/?)>|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface Frame {
  readonly tag: string;
  readonly marker: string;
  readonly children: ReactNode[];
}

function add(list: ReactNode[], node: ReactNode): void {
  const last = list.length - 1;
  if (typeof node === "string" && last >= 0 && typeof list[last] === "string") list[last] = (list[last] as string) + node;
  else list.push(node);
}

/** The children as one node: nothing, the only child, or a fragment over the list (its elements carry keys). */
function group(list: ReactNode[]): ReactNode {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  return createElement(Fragment, null, list);
}

/**
 * Turns a catalog string into React nodes. Tags nest; an unknown tag, a close without its open and an open without its
 * close stay as literal text (React escapes it); a placeholder without a value stays as written. A string with nothing
 * to replace is returned as it is. One linear scan with an explicit stack: no recursion, whatever the input.
 */
export function rich(text: string, tags?: RichTags | null, params?: RichParams | null): ReactNode {
  const t: RichTags = tags ?? {};
  const p: RichParams = params ?? {};
  const root: ReactNode[] = [];
  const stack: Frame[] = [];
  const top = (): ReactNode[] => (stack.length > 0 ? stack[stack.length - 1]!.children : root);
  let last = 0;
  let hit = false;
  let key = 0;
  /** A produced node inside a keyed fragment, so that a list of children never needs keys of its own. */
  const keyed = (node: ReactNode): ReactNode => (typeof node === "object" && node !== null ? createElement(Fragment, { key: key++ }, node) : node);
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) add(top(), text.slice(last, at));
    last = at + m[0].length;
    const [whole, close, name, self, param] = m;
    if (param !== undefined) {
      if (Object.hasOwn(p, param)) {
        top().push(keyed(p[param]));
        hit = true;
      } else add(top(), whole);
      continue;
    }
    const fn = name !== undefined && Object.hasOwn(t, name) ? t[name] : undefined;
    if (typeof fn !== "function" || (close && self)) {
      add(top(), whole);
      continue;
    }
    if (self) {
      top().push(keyed(fn(null)));
      hit = true;
    } else if (!close) {
      stack.push({ tag: name!, marker: whole, children: [] });
    } else if (stack.length > 0 && stack[stack.length - 1]!.tag === name) {
      const frame = stack.pop()!;
      top().push(keyed(fn(group(frame.children))));
      hit = true;
    } else {
      add(top(), whole);
    }
  }
  if (last < text.length) add(top(), text.slice(last));
  // Opens without a close: their markers become text, their content stays in place (in order, without moving twice).
  for (const frame of stack) {
    add(root, frame.marker);
    for (const c of frame.children) add(root, c);
  }
  if (!hit) return text;
  return group(root);
}
