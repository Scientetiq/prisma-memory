"use client";
import { useEffect } from "react";
import { tabHref } from "@/lib/admin-tabs";

export function anchorTarget(hash: string, anchors: Readonly<Record<string, string>>, path: string, active: string, fallback: string, search: string): string | null {
  const a = hash.replace(/^#/, "");
  const tab = a ? anchors[a] : undefined;
  if (!tab || tab === active) return null;
  const keep = Object.fromEntries(new URLSearchParams(search).entries());
  delete keep.tab;
  return tabHref(path, tab, fallback, keep, a);
}

export function AnchorTab({ path, anchors, active, fallback }: { path: string; anchors: Record<string, string>; active: string; fallback: string }) {
  useEffect(() => {
    const go = anchorTarget(window.location.hash, anchors, path, active, fallback, window.location.search);
    if (go) window.location.replace(go);
  }, [path, anchors, active, fallback]);
  return null;
}
