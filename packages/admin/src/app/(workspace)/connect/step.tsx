import { stepText as M } from "@/messages/ws-connect";
import { rich } from "@/i18n/rich";
import type { ReactNode } from "react";
import { Icon } from "@/components/icons";

export function Step({ n, id, title, lead, done = false, later = false, aside, extra, children }: {
  n: number; id: string; title: ReactNode; lead?: ReactNode; done?: boolean; later?: boolean;
  aside?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`cn-step${done ? " done" : ""}${later ? " later" : ""}${aside ? " has-aside" : ""}`} id={id} aria-labelledby={`${id}-t`}>
      <span className="cn-n" aria-hidden="true">{done ? <Icon name="check" /> : n}</span>
      <div className="cn-text">
        <h2 id={`${id}-t`}><span className="vis-hidden">{rich(M.step, null, { value0: n })}</span>{title}</h2>
        {lead ? <p className="cn-lead">{lead}</p> : null}
        {children}
      </div>
      {aside ? <div className="cn-aside">{aside}</div> : null}
      {extra ? <div className="cn-extra">{extra}</div> : null}
    </section>
  );
}
