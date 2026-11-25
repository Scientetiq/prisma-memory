import { APPROVAL_PENDING_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import Link from "next/link";
import { Notice } from "@/components/ui";
import { ADMIN_FORM_TEXT, type ApprovalPending } from "@/lib/admin-form";

export function ApprovalPendingNotice({ approval }: { approval: ApprovalPending }) {
  return (
    <Notice tone="info" role="status">
      <p>{ADMIN_FORM_TEXT.approvalPendingText}.</p>
      <p>{rich(APPROVAL_PENDING_TEXT.request, null, { value1: approval.summary })}</p>
      <p><Link href={`/admin/approvals?id=${encodeURIComponent(approval.id)}`} prefetch={false}>{APPROVAL_PENDING_TEXT.openRequest}</Link></p>
    </Notice>
  );
}
