import { ADMIN_FORM_TEXT, ADMIN_FORM_GROUPS, TEXT } from "../messages/admin-form";
import { okState, type ActionResult } from "./action-state";
import { formatDateTime, zoneLabel } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";

export interface ApprovalPending { id: string; state: "pending"; summary: string; expires_at: string }

export function approvalPendingOf(data: unknown): ApprovalPending | null {
  const a = (data as { approval?: unknown } | null)?.approval as Partial<ApprovalPending> | undefined;
  return a && typeof a === "object" && typeof a.id === "string" && a.state === "pending" && typeof a.summary === "string" && typeof a.expires_at === "string"
    ? { id: a.id, state: "pending", summary: a.summary, expires_at: a.expires_at } : null;
}

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { ADMIN_FORM_TEXT } from "../messages/admin-form";

export function approvalPendingState(a: ApprovalPending, tz: string = instanceTz()): ActionResult {
  return okState(ADMIN_FORM_TEXT.approvalPendingText, {
    lines: [TEXT.request(a.summary), TEXT.signBy(formatDateTime(a.expires_at, tz), zoneLabel(tz))],
    link: { href: `/admin/approvals?id=${encodeURIComponent(a.id)}`, label: TEXT.openRequest },
  });
}

export type AdminFieldKind = "bool" | "number" | "text" | "secret" | "enum" | "lines" | "json";
export interface AdminField { category: "admin" | "access" | "observability" | "security"; key: string; kind: AdminFieldKind; hint?: string; placeholder?: string }
export interface AdminFormGroup { title: string; hint?: string; fields: AdminField[] }

const A = (key: string, kind: AdminFieldKind, hint?: string, placeholder?: string): AdminField => ({ category: "admin", key, kind, hint, placeholder });

export { ADMIN_FORM_GROUPS } from "../messages/admin-form";
