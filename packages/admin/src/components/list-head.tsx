import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function ListHead({ id, icon, title, aside }: { id: string; icon?: IconName; title: ReactNode; aside?: ReactNode }) {
  return <div className="hm-head"><h2 id={id}>{icon ? <Icon name={icon} /> : null}{title}</h2>{aside}</div>;
}
