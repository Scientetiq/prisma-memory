"use client";
import { correctLinkText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";

import type { MouseEvent } from "react";
import { Icon } from "@/components/icons";

export function CorrectLink({ href }: { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const d = document.getElementById("correct");
    if (!(d instanceof HTMLDetailsElement)) return;
    e.preventDefault();
    d.open = true;
    d.scrollIntoView({ block: "start" });
    d.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  };
  return <a className="btn sm" href={href} onClick={onClick}>{rich(M.correct, { tag0: () => <Icon name="pencil" /> })}</a>;
}
