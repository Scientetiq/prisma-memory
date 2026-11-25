"use client";
import { rich } from "@/i18n/rich";
import { addFold as M } from "@/messages/ws-materials";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";

export type AddPart = "upload" | "note";
export const partOfHash = (hash: string): AddPart | null => (hash === "#upload" ? "upload" : hash === "#note" ? "note" : null);

export function AddFold({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<AddPart | null>(null);
  const [js, setJs] = useState(false);
  useEffect(() => {
    setJs(true);
    const read = () => { const p = partOfHash(window.location.hash); if (p) setOpen(p); };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const toggle = (p: AddPart) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const next = open === p ? null : p;
    setOpen(next);
    window.history.replaceState(window.history.state, "", next ? `#${next}` : window.location.pathname + window.location.search);
  };
  return (
    <div className="mt-add" data-open={open ?? undefined} data-js={js ? "" : undefined}>
      <div className="mt-add-btns">{rich(M.uploadAFileWriteANoteLine, { tag2: () => <Icon name="upload" />, tag1: (children) => <a href="#upload" className="btn" aria-controls="upload" aria-expanded={open === "upload"} onClick={toggle("upload")}>{children}</a>, tag4: () => <Icon name="pencil" />, tag3: (children) => <a href="#note" className="btn" aria-controls="note" aria-expanded={open === "note"} onClick={toggle("note")}>{children}</a> })}</div>
      {children}
    </div>
  );
}
