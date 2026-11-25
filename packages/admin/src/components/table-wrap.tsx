"use client";
import { TABLE_WRAP_TEXT } from "../messages/components";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function scrollState(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean } {
  return { left: scrollLeft > 2, right: scrollWidth - clientWidth - scrollLeft > 2 };
}

export function scrollHint(more: { left: boolean; right: boolean }): { label: string; dir: "right" | "start" } | null {
  if (more.right) return { label: TABLE_WRAP_TEXT.moreColumns, dir: "right" };
  if (more.left) return { label: TABLE_WRAP_TEXT.start, dir: "start" };
  return null;
}

export function TableWrap({ children, cards }: { children: ReactNode; cards?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setMore((was) => {
      const now = scrollState(el.scrollLeft, el.clientWidth, el.scrollWidth);
      return now.left === was.left && now.right === was.right ? was : now;
    });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", update); ro?.disconnect(); };
  }, []);
  const hint = scrollHint(more);
  const outer = ["board-scroll", more.right ? "more-right" : "", more.left ? "more-left" : "", hint ? "with-bar" : ""].filter(Boolean).join(" ");
  const go = () => {
    const el = ref.current;
    if (!el || !hint) return;
    if (hint.dir === "start") el.scrollTo({ left: 0, behavior: "smooth" });
    else el.scrollBy({ left: Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
  };
  return (
    <div className={outer}>
      {hint ? (
        <div className="scroll-bar">
          <button type="button" className="scroll-more" onClick={go}>{hint.label}</button>
        </div>
      ) : null}
      <div ref={ref} className={cards ? "board-wrap cards" : "board-wrap"}>{children}</div>
    </div>
  );
}
