import { whoSeesText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import { derived } from "@/i18n/runtime";
import { VisibilityBadge } from "@/components/visibility-badge";
import { ACCESS_EXPLAIN } from "@/lib/plain";
import type { RecordReaders } from "@/lib/types";
import { whoSees } from "@/lib/visibility";

export const WHO_SEES_FALLBACK = derived(() => ({
  open: M.peopleWhoCanAccessTheRecord,
  closed: M.onlyPeopleWhoCanAccessThe,
} as const));

export function WhoSeesBlock({ cls, readers, me }: { cls: "open" | "closed"; readers: RecordReaders | null; me: string }) {
  const w = readers ? whoSees(readers, me) : null;
  return (
    <section className="who-sees" aria-label={M.whoCanSeeTheRecord}>
      <p className="who-line"><VisibilityBadge cls={cls} /><span><b>{rich(M.whoCanSeeIt, null)}</b> {w ? w.line : WHO_SEES_FALLBACK[cls]}</span></p>
      <details className="who-why">
        <summary>{rich(M.why, null)}</summary>
        <ul>{(w?.details ?? [ACCESS_EXPLAIN[cls]]).map((d) => <li key={d}>{d}</li>)}</ul>
      </details>
    </section>
  );
}
