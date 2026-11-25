"use client";
import { useEffect, useRef, useState } from "react";
import { projectSlugPreview } from "@/lib/slug";

export { SLUG_PREVIEW } from "../messages/components";
import { SLUG_PREVIEW } from "../messages/components";

export function SlugPreview() {
  const ref = useRef<HTMLParagraphElement>(null);
  const [live, setLive] = useState(false);
  const [fields, setFields] = useState({ name: "", slug: "" });

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const value = (n: string): string => { const el = form.elements.namedItem(n); return el instanceof HTMLInputElement ? el.value : ""; };
    const read = () => setFields({ name: value("name"), slug: value("slug") });
    read();
    setLive(true);
    form.addEventListener("input", read);
    return () => form.removeEventListener("input", read);
  }, []);

  function edit() {
    const form = ref.current?.closest("form");
    const more = form?.querySelector<HTMLDetailsElement>("details.np-extra");
    if (more) more.open = true;
    const el = form?.elements.namedItem("slug");
    if (el instanceof HTMLInputElement) el.focus();
  }

  const slug = projectSlugPreview(fields.name, fields.slug);
  return (
    <p ref={ref} className="np-slug" hidden={!live} aria-live="polite">
      {slug ? <>{SLUG_PREVIEW.label}: <code className="code">{slug}</code> <span className="muted">{SLUG_PREVIEW.note}</span></> : SLUG_PREVIEW.empty}{" "}
      <button type="button" className="link-btn" onClick={edit}>{SLUG_PREVIEW.edit}</button>
    </p>
  );
}
