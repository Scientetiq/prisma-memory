import { Icon } from "./icons";
import { ACCESS_PAST_PLAIN, ACCESS_PLAIN, CLASS_PLAIN, visibilityOf } from "@/lib/plain";

export function VisibilityBadge({ cls, iconOnly, tech, prefix, past }: {
  cls: string | null | undefined;
  iconOnly?: boolean;
  tech?: boolean;
  prefix?: string;
  past?: boolean;
}) {
  const v = visibilityOf(cls);
  if (v === "unknown") return null;
  const words = past ? ACCESS_PAST_PLAIN[v] : tech ? CLASS_PLAIN[v] : ACCESS_PLAIN[v];
  const text = prefix ? `${prefix}: ${words}` : words;
  const icon = <Icon name={v === "closed" ? "lock" : "unlock"} />;
  return iconOnly
    ? <span className={`acc ${v}`} title={text}>{icon}<span className="vis-hidden">{text}</span></span>
    : <span className={`acc ${v}`}>{icon}{text}</span>;
}
