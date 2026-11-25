import { Icon, type IconName } from "@/components/icons";
import { VisibilityBadge } from "@/components/visibility-badge";
import { HOME_TEXT } from "@/lib/home";

export interface TargetSpace { slug: string; name: string; defaultClass: "open" | "closed"; personal: boolean; icon: IconName; tone: string; kind?: "personal" | "team" | "project" | "org" }

export function SaveTo({ space }: { space: TargetSpace }) {
  return (
    <p className="mt-dest">
      <span className="mt-dest-k">{HOME_TEXT.saveTo}</span>
      <span className="mt-dest-s"><span className={`ichip xs tone-${space.tone}`}><Icon name={space.icon} /></span>{space.name}</span>
      <VisibilityBadge cls={space.defaultClass} />
    </p>
  );
}
