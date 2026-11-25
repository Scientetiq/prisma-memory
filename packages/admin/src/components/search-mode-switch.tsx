"use client";
import type { ChangeEvent } from "react";

export interface ModeOption { value: string; title: string; hint?: string }

export function submitIfAsked(input: Pick<HTMLInputElement, "form" | "type">): boolean {
  const form = input.form;
  const q = form?.elements.namedItem("q") as { value?: unknown } | null | undefined;
  if (input.type !== "radio" || !form || typeof q?.value !== "string" || !q.value.trim()) return false;
  form.requestSubmit();
  return true;
}

export function SearchModeSwitch({ modes, current, labelledBy }: { modes: ModeOption[]; current: string; labelledBy?: string }) {
  const onChange = (e: ChangeEvent<HTMLDivElement>) => { submitIfAsked(e.target as unknown as HTMLInputElement); };
  return (
    <div className="seg" role="radiogroup" aria-labelledby={labelledBy} onChange={onChange}>
      {modes.map((m) => (
        <label key={m.value} title={m.hint}>
          <input type="radio" name="mode" value={m.value} defaultChecked={m.value === current} />{m.title}
        </label>
      ))}
    </div>
  );
}
