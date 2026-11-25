"use client";
import { transcriptJumpText as M } from "@/messages/ws-records";
import { derived } from "@/i18n/runtime";

import { useEffect, useRef, useState } from "react";
import { nearestTimeAnchor, timeHash } from "@/lib/time-anchor";



export function TranscriptJump({ truncated }: { truncated: boolean }) {
  const [beyond, setBeyond] = useState(false);
  const note = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const go = () => {
      const n = timeHash(window.location.hash);
      if (n === null) return;
      const spans = Array.from(document.querySelectorAll<HTMLElement>('.prose span.ts[id^="t-"]'));
      const hit = nearestTimeAnchor(spans.map((s) => Number(s.id.slice(2))).filter(Number.isFinite), n, truncated);
      const el = hit ? document.getElementById(`t-${hit.sec}`) : null;
      if (!hit || !el) return;
      const box = el.closest("details");
      if (box && !box.open) box.open = true;
      document.querySelectorAll(".ts-hit").forEach((x) => x.classList.remove("ts-hit"));
      const line = el.closest("p") ?? el;
      line.classList.add("ts-hit");
      setBeyond(hit.beyond);
      if (!hit.beyond) line.scrollIntoView({ block: "center" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [truncated]);
  useEffect(() => { if (beyond) note.current?.scrollIntoView({ block: "center" }); }, [beyond]);
  return beyond ? <p ref={note} className="hint ts-beyond" role="status">{TRANSCRIPT_JUMP_COPY.beyondText}</p> : null;
}

export const TRANSCRIPT_JUMP_COPY = derived(() => ({
  beyondText: M.thisPointIsBeyondThePart,
}));
