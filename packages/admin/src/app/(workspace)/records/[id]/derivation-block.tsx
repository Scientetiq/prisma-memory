import Link from "next/link";
import { Icon } from "@/components/icons";
import { BASED_ON_PLAIN, formatDay } from "@/lib/plain";
import type { Derivation, RecordDerivationSources } from "@/lib/types";

export type BasedOn = Pick<Derivation, "kind"> & { sources: Array<{ id: string; title: string | null; occurred_at: string }> };

export function basedOnOf(route: RecordDerivationSources | null, read: Derivation | null | undefined): BasedOn | null {
  if (route?.kind) return { kind: route.kind, sources: route.sources };
  return read ? { kind: read.kind, sources: read.sources } : null;
}

export function DerivationBlock({ v }: { v: BasedOn }) {
  const lead = v.kind === "echo" ? BASED_ON_PLAIN.echo : v.sources.length ? BASED_ON_PLAIN.sources : BASED_ON_PLAIN.hidden;
  return (
    <section className="based-on" id="based-on" aria-label={BASED_ON_PLAIN.title}>
      <p className="based-on-lead"><Icon name="info" /> <b>{BASED_ON_PLAIN.title}.</b> {lead}</p>
      {v.sources.length ? (
        <>
          <ul className="derived">
            {v.sources.map((s) => (
              <li key={s.id}>
                <Link href={`/records/${s.id}`} prefetch={false}>{s.title?.trim() || BASED_ON_PLAIN.untitled}</Link>
                <span className="muted small"> · {formatDay(s.occurred_at)}</span>
              </li>
            ))}
          </ul>
          <p className="hint">{BASED_ON_PLAIN.advice}</p>
        </>
      ) : null}
    </section>
  );
}
