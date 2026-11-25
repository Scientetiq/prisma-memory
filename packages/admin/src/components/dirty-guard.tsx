"use client";
import { useEffect } from "react";

export function inpageAction(scope: string | null, inpage?: string): "none" | "ask" | "leave" {
  if (scope === null) return "leave";
  return scope === "check" && inpage ? "ask" : "none";
}

export function DirtyGuard({ active, question, owner = "[data-dirty-owner]", inpage }: { active: boolean; question: string; owner?: string; inpage?: string }) {
  useEffect(() => {
    if (!active) return;
    const inOwner = (el: Element | null): boolean => Boolean(el?.closest(owner));
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const t = e.target as Element | null;
      const a = t?.closest?.("a[href]") as HTMLAnchorElement | null;
      const b = t?.closest?.("button") as HTMLButtonElement | null;
      if (b && b.type === "submit" && !inOwner(b)) {
        const how = inpageAction(b.closest("[data-inpage]")?.getAttribute("data-inpage") ?? null, inpage);
        if (how === "none") return;
        if (how === "ask") { if (!window.confirm(inpage!)) { e.preventDefault(); e.stopPropagation(); } return; }
      }
      const leaving = a ? !(a.getAttribute("href") ?? "").startsWith("#") && a.target !== "_blank" && !a.hasAttribute("download")
        : Boolean(b && b.type === "submit" && !inOwner(b));
      if (!leaving || inOwner(t)) return;
      if (!window.confirm(question)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onBeforeUnload); document.removeEventListener("click", onClick, true); };
  }, [active, question, owner, inpage]);
  return null;
}
