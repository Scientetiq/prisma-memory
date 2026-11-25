"use client";
import { ROW_MENU_TEXT } from "../messages/components";

import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

export function RowMenu({ label = ROW_MENU_TEXT.more, cancel, children }: { label?: string; cancel?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const close = (focus: boolean) => {
      if (!el.open) return;
      el.open = false;
      if (focus) el.querySelector<HTMLElement>("summary")?.focus();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
    const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node)) close(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, []);
  return (
    <details ref={ref} className="row-menu">
      <summary aria-label={label} title={label}><Icon name="more" /></summary>
      <div className="row-menu-pop">
        {children}
        {cancel ? <button type="button" className="btn sm row-menu-cancel" onClick={() => { if (ref.current) ref.current.open = false; ref.current?.querySelector<HTMLElement>("summary")?.focus(); }}>{cancel}</button> : null}
      </div>
    </details>
  );
}
