import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function Block({ id, icon, title, hint, aside, className, children }: {
  id: string; icon?: IconName; title: ReactNode; hint?: ReactNode; aside?: ReactNode; className?: string; children?: ReactNode;
}) {
  return (
    <section className={`sp-card${className ? ` ${className}` : ""}`} id={id} aria-labelledby={`${id}-title`}>
      <div className="sp-card-head"><h2 id={`${id}-title`}>{icon ? <Icon name={icon} /> : null}{title}</h2>{aside}</div>
      {hint ? <p className="sp-line">{hint}</p> : null}
      {children}
    </section>
  );
}
