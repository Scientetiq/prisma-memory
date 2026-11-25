import { ADMIN_PLANE_STUB_TEXT } from "../messages/components";
export { ADMIN_PLANE_STUB_TEXT } from "../messages/components";
import { PageFrame } from "@/components/page-frame";
import { Notice } from "@/components/ui";

export function AdminPlaneStub({ title, lead, allowAuditor = true }: { title: string; lead: string; allowAuditor?: boolean }) {
  return (
    <PageFrame title={title} lead={lead} allowAuditor={allowAuditor}>
      <Notice tone="info" role="status">{ADMIN_PLANE_STUB_TEXT.stubText}</Notice>
    </PageFrame>
  );
}
