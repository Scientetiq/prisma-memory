import Link from "next/link";
import { anchorIndex, tabHref, type TabSpec } from "@/lib/admin-tabs";
import { AnchorTab } from "./anchor-tab";

export function AdminTabs<T extends string>({ path, tabs, active, fallback, label, keep = {}, counts = {} }: {
  path: string; tabs: ReadonlyArray<TabSpec<T>>; active: T; fallback: T; label: string;
  keep?: Record<string, string | null | undefined>;
  counts?: Partial<Record<T, { n: number; tone?: "ok" | "muted" | "danger" | "neutral" }>>;
}) {
  const anchors = anchorIndex(tabs);
  return (
    <>
      <nav className="tabs" aria-label={label}>
        {tabs.map((t) => {
          const c = counts[t.id];
          return (
            <Link key={t.id} prefetch={false} href={t.href ?? tabHref(path, t.id, fallback, keep)} className={t.id === active ? "on" : undefined} aria-current={t.id === active ? "page" : undefined}>
              {t.title}{c && c.n ? <span className={`cnt ${c.tone ?? "neutral"}`}>{c.n}</span> : null}
            </Link>
          );
        })}
      </nav>
      <AnchorTab path={path} anchors={anchors} active={active} fallback={fallback} />
    </>
  );
}
