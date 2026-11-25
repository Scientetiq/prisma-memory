// "Export this space" in the header of a space: a link to the page "what goes into the archive"
// (/export?space=<slug>), never a form — the export starts there, after the person has seen what it contains. Shown to
// the owner of the space and never in a preview session (canExportSpace); the gateway decides anyway. Server component.
import Link from "next/link";
import { Icon } from "@/components/icons";
import { canExportSpace, exportPageHref } from "@/lib/export";
import { exportText } from "@/lib/export.messages";

export function ExportSpaceButton({ slug, role, preview }: { slug: string; role: string; preview: boolean }) {
  if (!canExportSpace({ role }, preview)) return null;
  return (
    <Link href={exportPageHref(slug)} prefetch={false} className="btn" title={exportText("button.hint")}>
      <Icon name="download" />{exportText("button.label")}
    </Link>
  );
}
