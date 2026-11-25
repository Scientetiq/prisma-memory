import Link from "next/link";
import type { AttentionItem } from "@/lib/attention";
import { Icon } from "./icons";

export function AttentionList({ items }: { items: readonly AttentionItem[] }) {
  return (
    <ul className="attention">
      {items.map((a) => (
        <li key={a.key}>
          <Icon name={a.level === "urgent" ? "alert" : "info"} />
          <span>{a.text}{a.links.length ? <> — {a.links.map((l, i) => <span key={l.href}>{i ? ", " : ""}<Link href={l.href} prefetch={false}>{l.label}</Link></span>)}</> : null}</span>
        </li>
      ))}
    </ul>
  );
}
