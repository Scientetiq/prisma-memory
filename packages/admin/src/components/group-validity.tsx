// how long the membership of a directory-group binding holds without a new verification. Shown only when the
// gateway sends the fields (stale, valid_until): an older gateway — nothing; no term (ldap.group_stale_hours = 0 or the
// periodic sync off) — nothing either, "Readiness" warns about that.
import { LocalTime } from "@/components/local-time";
import type { SpaceGroup } from "@/lib/types";
import { GROUP_VALIDITY_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";

export function GroupValidity({ g, as: Tag = "small", className, short }: {
  g: Pick<SpaceGroup, "stale" | "valid_until">;
  /** small — rows of the workplace list; div — the cell of the panel table. */
  as?: "small" | "div";
  className?: string;
  short?: boolean;
}) {
  if (g.stale === true)
    return <Tag className={[className, "danger-text"].filter(Boolean).join(" ")}>{GROUP_VALIDITY_TEXT.stale}</Tag>;
  if (typeof g.valid_until === "string" && g.valid_until)
    return <Tag className={className}>{rich(GROUP_VALIDITY_TEXT.validUntil, null, { until: <LocalTime iso={g.valid_until} short={short} relative={false} /> })}</Tag>;
  return null;
}
