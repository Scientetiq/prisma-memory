import { PLAIN } from "@/lib/plain";
import { Icon } from "./icons";

export interface FindProps {
  label: string;
  placeholder: string;
  name?: string;
  defaultValue?: string;
  maxLength?: number;
  autoComplete?: "off";
  spellCheck?: false;
  autoFocus?: boolean;
  primary?: boolean;
  submit?: string;
  className?: string;
}

const cls = (place?: string): string => (place ? `find ${place}` : "find");

function FindInner(p: FindProps) {
  return (
    <>
      <Icon name="search" />
      <input type="search" name={p.name ?? "q"} defaultValue={p.defaultValue} maxLength={p.maxLength} placeholder={p.placeholder}
        aria-label={p.label} autoComplete={p.autoComplete} spellCheck={p.spellCheck} autoFocus={p.autoFocus} />
      <button type="submit" className={p.primary ? "btn primary" : "btn"}>{p.submit ?? PLAIN.findSubmit}</button>
    </>
  );
}

export function FindField({ action, hidden, formLabel, ...p }: FindProps & { action: string; hidden?: Record<string, string>; formLabel?: string }) {
  return (
    <form className={cls(p.className)} action={action} role="search" aria-label={formLabel}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <FindInner {...p} />
    </form>
  );
}

export function FindRow(p: FindProps) {
  return <div className={cls(p.className)}><FindInner {...p} /></div>;
}
