import { Icon } from "./icons";
import { LocalTime } from "./local-time";
import { VisibilityBadge } from "./visibility-badge";
import type { RecordState } from "@/lib/home";

export function RecordMeta({ iso, cls, state }: { iso?: string | null; cls?: string | null; state?: RecordState | null }) {
  return (
    <span className="rec-meta">
      {iso ? <LocalTime iso={iso} short /> : null}
      <VisibilityBadge cls={cls} iconOnly />
      {state && state.state !== "done" ? <span className={`st ${state.tone}`} title={state.detail}><Icon name={state.icon} /><span className="st-l">{state.label}</span></span> : null}
    </span>
  );
}
